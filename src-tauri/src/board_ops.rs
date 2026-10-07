use crate::board_store::{atomic_write, default_document, validate, BoardStore};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{mpsc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

struct Pending {
    token: String,
    labels: HashSet<String>,
    tx: mpsc::Sender<Result<(), String>>,
}
pub struct BoardOperations(Mutex<Option<Pending>>);
impl Default for BoardOperations {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}
pub fn label(id: &str) -> String {
    if id == "main" {
        id.into()
    } else {
        format!("board-{id}")
    }
}
fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn empty_child_board(parent: Option<&Value>, id: &str) -> Value {
    let mut board = default_document()["boards"][0].clone();
    board["id"] = json!(id);
    if let Some(parent) = parent {
        for key in [
            "theme",
            "grid",
            "level",
            "collision",
            "autoFade",
            "edgeHide",
            "bookmarkStyle",
            "bookmarkGutter",
            "display",
            "bounds",
        ] {
            if let Some(value) = parent.get(key) {
                board[key] = value.clone();
            }
        }
        let scale = parent["display"]["scaleFactor"].as_f64().unwrap_or(1.0);
        for axis in ["x", "y"] {
            if let Some(position) = parent["bounds"][axis].as_f64() {
                board["bounds"][axis] = json!(position + 36.0 * scale);
            }
        }
    }
    // Appearance and window preferences follow the mother; content, history,
    // split metadata, lock and collapsed state belong to the individual board.
    board
}

#[tauri::command]
pub fn board_operation_flushed(
    app: AppHandle,
    token: String,
    label: String,
    error: Option<String>,
) -> Result<(), String> {
    let state = app.state::<BoardOperations>();
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(p) = guard.as_mut().filter(|p| p.token == token) {
        if p.labels.remove(&label) {
            if let Some(e) = error {
                let _ = p.tx.send(Err(e));
            } else if p.labels.is_empty() {
                let _ = p.tx.send(Ok(()));
            }
        }
    }
    Ok(())
}

// Freeze and flush every live board before changing topology. A source window
// may contain a draft that has not reached its autosave yet.
#[tauri::command]
pub async fn board_operation(
    app: AppHandle,
    label: String,
    action: String,
    source_id: Option<String>,
) -> Result<(), String> {
    if crate::cut::is_active(&app) {
        return Err("请先右键取消裁剪模式。".into());
    }
    let token = stamp().to_string();
    let (tx, rx) = mpsc::channel();
    let labels: HashSet<String> = {
        let store = app.state::<BoardStore>();
        let d = store.document.lock().map_err(|e| e.to_string())?;
        d["boards"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|b| {
                let l = self::label(b["id"].as_str()?);
                app.get_webview_window(&l).map(|_| l)
            })
            .collect()
    };
    {
        let ready = app.state::<crate::commands::ReadyWindows>();
        let ready = ready.0.lock().map_err(|e| e.to_string())?;
        if !labels.iter().all(|l| ready.contains(l)) {
            return Err("板子仍在加载，请稍后重试。".into());
        }
    }
    {
        let state = app.state::<BoardOperations>();
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        if guard.is_some() {
            return Err("另一项板子操作正在进行。".into());
        }
        *guard = Some(Pending {
            token: token.clone(),
            labels: labels.clone(),
            tx,
        });
    }
    let result = async {
        for l in &labels {
            app.emit_to(l, "board-operation-flush", json!({"token":token}))
                .map_err(|e| e.to_string())?;
        }
        if !labels.is_empty() {
            tauri::async_runtime::spawn_blocking(move || {
                rx.recv_timeout(Duration::from_secs(8))
                    .map_err(|_| "保存板子超时，操作已取消。".to_string())?
            })
            .await
            .map_err(|e| e.to_string())??;
        }
        perform(&app, &label, &action, source_id.as_deref())
    }
    .await;
    *app.state::<BoardOperations>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = None;
    let _ = app.emit(
        "board-operation-end",
        json!({"token":token,"success":result.is_ok()}),
    );
    result
}

fn perform(
    app: &AppHandle,
    window_label: &str,
    action: &str,
    source: Option<&str>,
) -> Result<(), String> {
    let id = window_label.strip_prefix("board-").unwrap_or(window_label);
    // Window queries dispatch to the main thread. Never hold the document lock
    // while waiting: another WebView's load/save IPC can be waiting for that lock.
    let merge_area = if action == "merge" {
        app.get_webview_window(window_label)
            .and_then(|win| win.current_monitor().ok().flatten())
            .map(|m| m.work_area().clone())
    } else {
        None
    };
    let store = app.state::<BoardStore>();
    let mut guard = store.document.lock().map_err(|e| e.to_string())?;
    let mut next = guard.clone();
    let mut removed = None;
    let mut created = None;
    let mut resized = None;
    if matches!(action, "delete" | "merge") {
        let board = next["boards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == id)
            .ok_or("板子不存在")?;
        if board["locked"] == true {
            return Err("请先解锁板子。".into());
        }
    }
    match action {
        "new" => {
            if next["boards"].as_array().unwrap().len() >= 20 {
                return Err("最多 20 块板子".into());
            }
            let boards = next["boards"].as_array().unwrap();
            let parent = boards.iter().find(|b| b["id"] == id).or_else(|| {
                if id == "tray" {
                    boards.first()
                } else {
                    None
                }
            });
            let b = empty_child_board(parent, &format!("b-{}", stamp()));
            next["boards"].as_array_mut().unwrap().push(b.clone());
            created = Some(b);
        }
        "delete" => {
            archive_board(&mut next, id)?;
            removed = Some(self::label(id));
        }
        "restore" => {
            let source = source.ok_or("请选择要恢复的板子")?;
            if next["boards"].as_array().unwrap().len() >= 20 {
                return Err("最多 20 块板子".into());
            }
            let records = next["deletedBoards"]
                .as_array_mut()
                .ok_or("没有可恢复的板子")?;
            let index = records
                .iter()
                .position(|r| r["board"]["id"] == source)
                .ok_or("板子已恢复")?;
            let mut b = records.remove(index)["board"].clone();
            b["locked"] = json!(false);
            b["collision"] = json!(false);
            b["collapsed"] = json!(false);
            if next["boards"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v["id"] == source)
            {
                return Err("板子 ID 已存在".into());
            }
            let archive = next["archive"].as_array_mut().ok_or("存档格式无效")?;
            let recovered: Vec<Value> = archive
                .iter()
                .filter(|i| i["boardId"] == source)
                .cloned()
                .collect();
            archive.retain(|i| i["boardId"] != source);
            next["items"].as_array_mut().unwrap().extend(recovered);
            next["boards"].as_array_mut().unwrap().push(b.clone());
            created = Some(b);
        }
        "merge" => {
            let source = source.ok_or("请选择另一个板子")?;
            merge_document(&mut next, id, source)?;
            if let Some(area) = &merge_area {
                let b = next["boards"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|b| b["id"] == id)
                    .unwrap();
                let w = b["bounds"]["w"]
                    .as_f64()
                    .unwrap()
                    .min(area.size.width as f64);
                let h = b["bounds"]["h"]
                    .as_f64()
                    .unwrap()
                    .min(area.size.height as f64);
                b["bounds"]["w"] = json!(w);
                b["bounds"]["h"] = json!(h);
                for (key, min, max) in [
                    (
                        "x",
                        area.position.x as f64,
                        area.position.x as f64 + area.size.width as f64 - w,
                    ),
                    (
                        "y",
                        area.position.y as f64,
                        area.position.y as f64 + area.size.height as f64 - h,
                    ),
                ] {
                    if let Some(p) = b["bounds"][key].as_f64() {
                        b["bounds"][key] = json!(p.clamp(min, max));
                    }
                }
            }
            removed = Some(self::label(source));
            resized = next["boards"]
                .as_array()
                .unwrap()
                .iter()
                .find(|b| b["id"] == id)
                .cloned();
        }
        _ => return Err("板子操作无效".into()),
    }
    validate(&next)?;
    let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("板子数据过大，请先导出内容。".into());
    }
    // Stage new hidden windows first; persistence failure leaves the old state intact.
    if let Some(b) = &created {
        crate::window::create_board_window(app, b)?;
    }
    if let Err(e) = atomic_write(&store.root.join("board.json"), &bytes) {
        if let Some(b) = &created {
            if let Some(w) = app.get_webview_window(&self::label(b["id"].as_str().unwrap())) {
                let _ = w.destroy();
            }
        }
        return Err(e);
    }
    *guard = next;
    drop(guard);
    if let Some(l) = removed {
        if let Some(w) = app.get_webview_window(&l) {
            let _ = w.hide();
            let _ = w.destroy();
        }
        if let Ok(mut ready) = app.state::<crate::commands::ReadyWindows>().0.lock() {
            ready.remove(&l);
        }
    }
    if let Some(b) = resized {
        if let Some(w) = app.get_webview_window(window_label) {
            let _ = w.set_size(PhysicalSize::new(
                b["bounds"]["w"].as_f64().unwrap() as u32,
                b["bounds"]["h"].as_f64().unwrap() as u32,
            ));
            if let (Some(x), Some(y)) = (b["bounds"]["x"].as_f64(), b["bounds"]["y"].as_f64()) {
                let _ = w.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
            }
        }
    }
    app.emit("board-changed", json!({"origin":"structure"}))
        .map_err(|e| e.to_string())
}

fn archive_board(d: &mut Value, id: &str) -> Result<(), String> {
    let boards = d["boards"].as_array_mut().unwrap();
    let index = boards
        .iter()
        .position(|b| b["id"] == id)
        .ok_or("板子不存在")?;
    let b = boards.remove(index);
    if !d["deletedBoards"].is_array() {
        d["deletedBoards"] = json!([]);
    }
    d["deletedBoards"]
        .as_array_mut()
        .unwrap()
        .push(json!({"board":b,"deletedAt":stamp().to_string()}));
    let removed: Vec<Value> = d["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["boardId"] == id)
        .cloned()
        .collect();
    d["items"]
        .as_array_mut()
        .unwrap()
        .retain(|i| i["boardId"] != id);
    if !d["archive"].is_array() {
        d["archive"] = json!([]);
    }
    d["archive"].as_array_mut().unwrap().extend(removed);
    Ok(())
}

fn merge_document(d: &mut Value, target: &str, source: &str) -> Result<(), String> {
    if target == source {
        return Err("不能与自身合并".into());
    }
    let boards = d["boards"].as_array().unwrap();
    let ti = boards
        .iter()
        .position(|b| b["id"] == target)
        .ok_or("目标板子不存在")?;
    let si = boards
        .iter()
        .position(|b| b["id"] == source)
        .ok_or("来源板子不存在")?;
    let t = boards[ti].clone();
    let s = boards[si].clone();
    if t["locked"] == true || s["locked"] == true {
        return Err("请先解锁两个板子。".into());
    }
    let spacing = t["grid"]["spacing"].as_f64().unwrap_or(24.0);
    let source_spacing = s["grid"]["spacing"].as_f64().unwrap_or(24.0);
    let ts = t["display"]["scaleFactor"].as_f64().unwrap_or(1.0).max(0.5);
    let ss = s["display"]["scaleFactor"].as_f64().unwrap_or(1.0).max(0.5);
    let tw = t["bounds"]["w"].as_f64().unwrap() / ts;
    let th = t["bounds"]["h"].as_f64().unwrap() / ts;
    let sw = s["bounds"]["w"].as_f64().unwrap() / ss;
    let sh = s["bounds"]["h"].as_f64().unwrap() / ss;
    let positions = match (
        t["bounds"]["x"].as_f64(),
        t["bounds"]["y"].as_f64(),
        s["bounds"]["x"].as_f64(),
        s["bounds"]["y"].as_f64(),
    ) {
        (Some(tx), Some(ty), Some(sx), Some(sy)) => Some((tx, ty, sx, sy)),
        _ => None,
    };
    let split = if s["splitOrigin"]["boardId"] == target {
        Some((&s["splitOrigin"], false))
    } else if t["splitOrigin"]["boardId"] == source {
        Some((&t["splitOrigin"], true))
    } else {
        None
    };
    let (horizontal, source_first) = if let Some((tx, ty, sx, sy)) = positions {
        let dx = sx + sw * ss / 2.0 - tx - tw * ts / 2.0;
        let dy = sy + sh * ss / 2.0 - ty - th * ts / 2.0;
        let horizontal = dx.abs() / (tw * ts + sw * ss) > dy.abs() / (th * ts + sh * ss);
        (horizontal, if horizontal { dx < 0.0 } else { dy < 0.0 })
    } else if let Some((meta, first)) = split {
        (meta["direction"] == "vertical", first)
    } else {
        (false, false)
    };
    // A split seam remains exact only while the halves still have the same axis,
    // order and adjacent placement. Moved halves follow their current geometry.
    let seam = split
        .filter(|(meta, first)| {
            if (meta["direction"] == "vertical") != horizontal || *first != source_first {
                return false;
            }
            positions
                .map(|(tx, ty, sx, sy)| {
                    let gap = if horizontal {
                        if source_first {
                            tx - sx - sw * ss
                        } else {
                            sx - tx - tw * ts
                        }
                    } else if source_first {
                        ty - sy - sh * ss
                    } else {
                        sy - ty - th * ts
                    };
                    gap.abs() <= 40.0 * ts
                })
                .unwrap_or(true)
        })
        .map(|(meta, _)| {
            meta["coordinate"].as_f64().unwrap_or(0.0)
                * if horizontal {
                    1.0
                } else {
                    spacing / meta["spacing"].as_f64().unwrap_or(spacing)
                }
        });
    let ratio = spacing / source_spacing;
    let layout = |b: &Value, w: f64, h: f64| {
        (
            b["paperLayout"]["w"]
                .as_f64()
                .unwrap_or((w - 34.0).max(1.0)),
            b["paperLayout"]["h"]
                .as_f64()
                .unwrap_or((h - 89.0).max(spacing)),
        )
    };
    let (tpw, tph) = layout(&t, tw, th);
    let (spw, sph) = layout(&s, sw, sh);
    let content_height = |id: &str, paper_height: f64, line_spacing: f64| {
        d["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|i| i["boardId"] == id)
            .fold(paper_height, |height, i| {
                let lines = i["text"]
                    .as_str()
                    .map(|text| text.split('\n').count())
                    .unwrap_or(1) as f64;
                height.max(i["position"]["y"].as_f64().unwrap_or(0.0) + lines * line_spacing)
            })
    };
    let target_height = content_height(target, tph, spacing);
    let source_height = content_height(source, sph, source_spacing) * ratio;
    let first_extent = if horizontal {
        if source_first {
            spw * ratio
        } else {
            tpw
        }
    } else {
        if source_first {
            source_height
        } else {
            target_height
        }
    };
    let offset = seam.unwrap_or(if horizontal {
        first_extent
    } else {
        (first_extent / spacing).ceil() * spacing
    });
    for item in d["items"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|i| i["boardId"] == target || i["boardId"] == source)
    {
        let from_source = item["boardId"] == source;
        let scale = if from_source { ratio } else { 1.0 };
        let shifted = from_source != source_first;
        let x = item["position"]["x"].as_f64().unwrap_or(24.0);
        let y = item["position"]["y"].as_f64().unwrap_or(0.0);
        item["position"] = json!({"x":24.0+(x-24.0)*scale+if horizontal&&shifted {offset}else{0.0},"y":y*scale+if !horizontal&&shifted {offset}else{0.0}});
        item["boardId"] = json!(target);
    }
    let mut ink = Vec::new();
    for (board, from_source) in [(&t, false), (&s, true)] {
        let scale = if from_source { ratio } else { 1.0 };
        let shifted = from_source != source_first;
        for stroke in board["ink"].as_array().into_iter().flatten() {
            let mut stroke = stroke.clone();
            for p in stroke["points"].as_array_mut().into_iter().flatten() {
                let x = p["x"].as_f64().unwrap_or(0.0);
                let y = p["y"].as_f64().unwrap_or(0.0);
                p["x"] = json!(
                    24.0 + (x - 24.0) * scale + if horizontal && shifted { offset } else { 0.0 }
                );
                p["y"] = json!(y * scale + if !horizontal && shifted { offset } else { 0.0 });
            }
            ink.push(stroke);
        }
    }
    let mut merged = t;
    merged["ink"] = json!(ink);
    crate::paper_state::rebuild_rows(&mut merged);
    let second_width = if source_first { tpw } else { spw * ratio };
    let second_height = if source_first {
        target_height
    } else {
        source_height
    };
    merged["bounds"]["w"] = json!(
        (if horizontal {
            offset + second_width
        } else {
            tpw.max(spw * ratio)
        } + tw
            - tpw)
            * ts
    );
    merged["bounds"]["h"] = json!(
        (if horizontal {
            target_height.max(source_height)
        } else {
            offset + second_height
        } + th
            - tph)
            .min(2000.0)
            * ts
    );
    if let Some((tx, ty, sx, sy)) = positions {
        merged["bounds"]["x"] = json!(tx.min(sx));
        merged["bounds"]["y"] = json!(ty.min(sy));
    }
    merged.as_object_mut().unwrap().remove("paperLayout");

    merged["collapsed"] = json!(false);
    merged.as_object_mut().unwrap().remove("splitOrigin");
    let boards = d["boards"].as_array_mut().unwrap();
    boards[ti] = merged;
    boards.remove(si);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn new_board_inherits_preferences_without_copying_content_or_state() {
        let mut parent = default_document()["boards"][0].clone();
        parent["theme"] = json!({"accent":"#7199aa","paper":"#e8f2ff","opacity":0.8});
        parent["grid"]["spacing"] = json!(40);
        parent["grid"]["lineOpacity"] = json!(0.7);
        parent["collision"] = json!(false);
        parent["bookmarkStyle"] = json!("knot");
        parent["bookmarkGutter"] = json!(50);
        parent["bounds"] = json!({"x":100,"y":200,"w":800,"h":700});
        parent["display"] = json!({"id":"screen","scaleFactor":1.5});
        parent["locked"] = json!(true);
        parent["collapsed"] = json!(true);
        parent["paperRows"] = json!([{"id":"note","parts":[{"text":"note"}],"height":1}]);
        parent["ink"] = json!([{"id":"ink","points":[{"x":30,"y":30}]}]);
        parent["splitOrigin"] = json!({"boardId":"other"});
        let child = empty_child_board(Some(&parent), "child");
        for key in [
            "theme",
            "grid",
            "display",
            "collision",
            "level",
            "autoFade",
            "edgeHide",
            "bookmarkStyle",
            "bookmarkGutter",
        ] {
            assert_eq!(child[key], parent[key]);
        }
        assert_eq!(child["bounds"]["w"], 800);
        assert_eq!(child["bounds"]["x"], 154.0);
        assert_eq!(child["bounds"]["y"], 254.0);
        assert_ne!(child["locked"], true);
        assert_eq!(child["collapsed"], false);
        for key in ["paperRows", "ink", "splitOrigin", "paperLayout"] {
            assert!(child.get(key).is_none());
        }
        let mut doc = default_document();
        doc["boards"] = json!([child]);
        validate(&doc).unwrap();
    }
    #[test]
    fn new_board_without_parent_still_uses_defaults() {
        let child = empty_child_board(None, "child");
        let mut expected = default_document()["boards"][0].clone();
        expected["id"] = json!("child");
        assert_eq!(child, expected);
    }
    #[test]
    fn delete_last_board_archives_files_without_changing_paths() {
        let mut d = default_document();
        d["items"] = json!([{"id":"f","boardId":"main","type":"file","path":"C:/original.pdf"}]);
        archive_board(&mut d, "main").unwrap();
        validate(&d).unwrap();
        assert!(d["boards"].as_array().unwrap().is_empty());
        assert!(d["items"].as_array().unwrap().is_empty());
        assert_eq!(d["archive"][0]["path"], "C:/original.pdf");
        assert_eq!(d["deletedBoards"][0]["board"]["id"], "main");
    }
    #[test]
    fn merge_restores_split_positions_and_keeps_ids() {
        let mut d = default_document();
        let mut b = d["boards"][0].clone();
        b["id"] = json!("child");
        b["splitOrigin"] = json!({"boardId":"main","direction":"horizontal","coordinate":192});
        d["boards"].as_array_mut().unwrap().push(b);
        d["items"] = json!([{"id":"a","boardId":"main","type":"text","position":{"x":24,"y":48}},{"id":"b","boardId":"child","type":"text","position":{"x":80,"y":48}}]);
        merge_document(&mut d, "main", "child").unwrap();
        validate(&d).unwrap();
        assert_eq!(d["items"][1]["position"]["y"], 240.0);
        assert_eq!(d["items"][1]["id"], "b");
        assert_eq!(d["boards"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn merge_rejects_locked_source_before_mutating() {
        let mut d = default_document();
        let mut b = d["boards"][0].clone();
        b["id"] = json!("child");
        b["locked"] = json!(true);
        d["boards"].as_array_mut().unwrap().push(b);
        let before = d.clone();
        assert!(merge_document(&mut d, "main", "child").is_err());
        assert_eq!(d, before);
    }
    #[test]
    fn either_split_half_can_be_destination_and_spacing_is_preserved() {
        let mut d = default_document();
        let mut b = d["boards"][0].clone();
        b["id"] = json!("child");
        b["grid"]["spacing"] = json!(48);
        b["splitOrigin"] =
            json!({"boardId":"main","direction":"horizontal","coordinate":192,"spacing":24});
        d["boards"].as_array_mut().unwrap().push(b);
        d["items"] = json!([{"id":"a","boardId":"main","type":"text","position":{"x":24,"y":48}},{"id":"b","boardId":"child","type":"text","position":{"x":80,"y":96}}]);
        merge_document(&mut d, "child", "main").unwrap();
        validate(&d).unwrap();
        assert_eq!(d["boards"][0]["id"], "child");
        assert_eq!(d["boards"][0]["grid"]["spacing"], 48);
        assert_eq!(d["items"][0]["position"]["y"], 96.0);
        assert_eq!(d["items"][1]["position"]["y"], 480.0);
    }
    #[test]
    fn position_based_merge_preserves_left_right_order_in_both_directions() {
        for source_left in [false, true] {
            let mut d = default_document();
            d["boards"][0]["bounds"] =
                json!({"x":if source_left {600}else{0},"y":50,"w":560,"h":400});
            let mut s = d["boards"][0].clone();
            s["id"] = json!("source");
            s["bounds"]["x"] = json!(if source_left { 0 } else { 600 });
            d["boards"].as_array_mut().unwrap().push(s);
            d["items"] = json!([{"id":"t","boardId":"main","type":"text","position":{"x":24,"y":48}},{"id":"s","boardId":"source","type":"text","position":{"x":24,"y":48}}]);
            d["boards"][1]["ink"] =
                json!([{"id":"ink","points":[{"x":24,"y":48},{"x":60,"y":48}]}]);
            merge_document(&mut d, "main", "source").unwrap();
            validate(&d).unwrap();
            let shifted = if source_left { 0 } else { 1 };
            assert_eq!(d["items"][shifted]["position"]["x"], 550.0);
            assert_eq!(d["items"][1 - shifted]["position"]["x"], 24.0);
            assert_eq!(d["items"][0]["position"]["y"], 48.0);
            assert_eq!(d["boards"][0]["bounds"]["x"], 0.0);
            assert_eq!(d["boards"][0]["bounds"]["w"], 1086.0);
            assert_eq!(
                d["boards"][0]["ink"][0]["points"][0]["x"],
                if source_left { 24.0 } else { 550.0 }
            );
        }
    }
    #[test]
    fn position_based_merge_preserves_upper_lower_order_and_moved_split_halves() {
        for source_above in [false, true] {
            let mut d = default_document();
            d["boards"][0]["bounds"] =
                json!({"x":20,"y":if source_above {500}else{0},"w":560,"h":400});
            let mut s = d["boards"][0].clone();
            s["id"] = json!("source");
            s["bounds"]["y"] = json!(if source_above { 0 } else { 500 });
            s["splitOrigin"] =
                json!({"boardId":"main","direction":"vertical","coordinate":200,"spacing":24});
            d["boards"].as_array_mut().unwrap().push(s);
            d["items"] = json!([{"id":"t","boardId":"main","type":"text","position":{"x":24,"y":48}},{"id":"s","boardId":"source","type":"text","position":{"x":24,"y":48}}]);
            merge_document(&mut d, "main", "source").unwrap();
            validate(&d).unwrap();
            let shifted = if source_above { 0 } else { 1 };
            assert_eq!(d["items"][shifted]["position"]["y"], 360.0);
            assert_eq!(d["items"][1 - shifted]["position"]["y"], 48.0);
            assert_eq!(d["items"][0]["position"]["x"], 24.0);
        }
    }
}
