use crate::{
    board_store::{atomic_write, validate, BoardStore},
    icon_engine::IconEngine,
};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindowBuilder,
};

// Moving coordinates directly bypasses the OS caption-drag loop and Aero Snap.
// Read physical screen coordinates natively to avoid CSS/DPI jumps across monitors.
#[tauri::command]
pub async fn drag_board(app: AppHandle, label: String) -> Result<(), String> {
    require_unlocked(&app, &label)?;
    app.state::<crate::edge_hide::EdgeHide>()
        .reveal(&app, &label)?;
    let win = app.get_webview_window(&label).ok_or("窗口不存在")?;
    let origin = win.outer_position().map_err(|e| e.to_string())?;
    use windows::Win32::{
        Foundation::POINT,
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON},
            WindowsAndMessaging::GetCursorPos,
        },
    };
    let mut start = POINT::default();
    unsafe { GetCursorPos(&mut start) }.map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut last = start;
        while unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0 {
            if unsafe { GetAsyncKeyState(VK_ESCAPE.0 as i32) } < 0 {
                break;
            }
            let mut cursor = POINT::default();
            unsafe { GetCursorPos(&mut cursor) }.map_err(|e| e.to_string())?;
            if cursor != last {
                win.set_position(PhysicalPosition::new(
                    origin.x + cursor.x - start.x,
                    origin.y + cursor.y - start.y,
                ))
                .map_err(|e| e.to_string())?;
                last = cursor;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn require_unlocked(app: &AppHandle, label: &str) -> Result<(), String> {
    let id = label.strip_prefix("board-").unwrap_or(label);
    let store = app.state::<BoardStore>();
    let document = store.document.lock().map_err(|e| e.to_string())?;
    let board = document["boards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["id"] == id)
        .ok_or("板子不存在")?;
    if board["locked"].as_bool().unwrap_or(false) {
        Err("板子已锁定，请先点击锁图标解锁。".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn set_board_lock(
    app: AppHandle,
    store: State<BoardStore>,
    label: String,
    enabled: bool,
) -> Result<(), String> {
    let id = label.strip_prefix("board-").unwrap_or(&label);
    let win = app.get_webview_window(&label).ok_or("窗口不存在")?;
    let mut guard = store.document.lock().map_err(|e| e.to_string())?;
    let mut next = guard.clone();
    let board = next["boards"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|b| b["id"] == id)
        .ok_or("板子不存在")?;
    let old = board["locked"].as_bool().unwrap_or(false);
    board["locked"] = json!(enabled);
    win.set_resizable(!enabled).map_err(|e| e.to_string())?;
    if let Err(err) = atomic_write(
        &store.root.join("board.json"),
        &serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?,
    ) {
        let _ = win.set_resizable(!old);
        return Err(err);
    }
    *guard = next;
    drop(guard);
    app.emit("board-changed", json!({"origin":label}))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_collapsed(
    app: AppHandle,
    label: String,
    collapsed: bool,
    expanded_height: u32,
) -> Result<(), String> {
    let win = app.get_webview_window(&label).ok_or("窗口不存在")?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    win.set_min_size(Some(tauri::LogicalSize::new(
        240.0,
        if collapsed { 61.0 } else { 180.0 },
    )))
    .map_err(|e| e.to_string())?;
    win.set_size(PhysicalSize::new(
        size.width,
        if collapsed {
            (61.0 * scale) as u32
        } else {
            expanded_height.max((180.0 * scale) as u32)
        },
    ))
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_level(app: AppHandle, label: String, level: String) -> Result<(), String> {
    let win = app.get_webview_window(&label).ok_or("窗口不存在")?;
    if level == "wallpaper" {
        return Err("壁纸层需验证 Explorer 重启后的挂载恢复，当前版本暂未开放。".into());
    }
    if !matches!(level.as_str(), "desktop" | "bottom" | "top") {
        return Err("窗口层级无效".into());
    }
    win.set_always_on_bottom(false).map_err(|e| e.to_string())?;
    win.set_always_on_top(level == "top")
        .map_err(|e| e.to_string())?;
    if level != "top" {
        win.set_always_on_bottom(true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn fit_board(app: AppHandle, label: String, center_only: bool) -> Result<(), String> {
    require_unlocked(&app, &label)?;
    let win = app.get_webview_window(&label).ok_or("窗口不存在")?;
    let monitor = win
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("显示器不存在")?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let app2 = app.clone();
    let snapshot =
        tauri::async_runtime::spawn_blocking(move || app2.state::<IconEngine>().read(false))
            .await
            .map_err(|e| e.to_string())??;
    let grid = Some(snapshot.clone());
    let (w, h) = if !center_only {
        let grid = &snapshot;
        let gx = grid["grid"]["x"]
            .as_f64()
            .filter(|v| *v > 0.0)
            .ok_or("桌面网格不可用")?;
        let gy = grid["grid"]["y"]
            .as_f64()
            .filter(|v| *v > 0.0)
            .ok_or("桌面网格不可用")?;
        (
            ((size.width as f64 / gx).round() * gx) as u32,
            ((size.height as f64 / gy).round() * gy) as u32,
        )
    } else {
        (size.width, size.height)
    };
    let area = monitor.work_area();
    let w = w.min(area.size.width).max(1);
    let h = h.min(area.size.height).max(1);
    let mut x = area.position.x + ((area.size.width - w) / 2) as i32;
    let mut y = area.position.y + ((area.size.height - h) / 2) as i32;
    if center_only {
        let position = win.outer_position().map_err(|e| e.to_string())?;
        let gx = snapshot["grid"]["x"]
            .as_f64()
            .filter(|v| *v > 0.0)
            .ok_or("Invalid desktop spacing")?;
        let gy = snapshot["grid"]["y"]
            .as_f64()
            .filter(|v| *v > 0.0)
            .ok_or("Invalid desktop spacing")?;
        let ox = snapshot["viewOrigin"]["x"]
            .as_f64()
            .unwrap_or(area.position.x as f64);
        let oy = snapshot["icons"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| i["y"].as_f64())
            .min_by(|a, b| a.total_cmp(b))
            .unwrap_or(area.position.y as f64);
        let point = center_in_grid(
            position.x as f64,
            position.y as f64,
            w as f64,
            h as f64,
            ox,
            oy,
            gx,
            gy,
        );
        x = (point.0.round() as i32).clamp(
            area.position.x,
            area.position.x + area.size.width as i32 - w as i32,
        );
        y = (point.1.round() as i32).clamp(
            area.position.y,
            area.position.y + area.size.height as i32 - h as i32,
        );
        crate::collision::set_collision(app.clone(), label.clone(), true).await?;
    } else if let Some(grid) = &grid {
        let gx = grid["grid"]["x"].as_i64().unwrap() as i32;
        let gy = grid["grid"]["y"].as_i64().unwrap() as i32;
        let icons = grid["icons"].as_array().unwrap();
        let origin_x = icons
            .iter()
            .filter_map(|i| i["x"].as_i64())
            .min()
            .unwrap_or(area.position.x as i64) as i32;
        let origin_y = icons
            .iter()
            .filter_map(|i| i["y"].as_i64())
            .min()
            .unwrap_or(area.position.y as i64) as i32;
        let mut best = None;
        for row in 0..=area.size.height as i32 / gy {
            for col in 0..=area.size.width as i32 / gx {
                let px = origin_x + col * gx;
                let py = origin_y + row * gy;
                if px < area.position.x
                    || py < area.position.y
                    || px + w as i32 > area.position.x + area.size.width as i32
                    || py + h as i32 > area.position.y + area.size.height as i32
                {
                    continue;
                }
                let occupied = icons.iter().any(|i| {
                    let ix = i["x"].as_i64().unwrap_or(0) as i32;
                    let iy = i["y"].as_i64().unwrap_or(0) as i32;
                    ix < px + w as i32 && ix + gx > px && iy < py + h as i32 && iy + gy > py
                });
                if !occupied {
                    let distance = (px as i64 - x as i64).pow(2) + (py as i64 - y as i64).pow(2);
                    if best.map(|(d, _, _)| distance < d).unwrap_or(true) {
                        best = Some((distance, px, py));
                    }
                }
            }
        }
        if let Some((_, px, py)) = best {
            x = px;
            y = py;
        } else {
            return Err(
                "该尺寸找不到可用空隙；请缩小板子，或在设置中开启桌面图标让位动画。".into(),
            );
        }
    }
    win.set_size(PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

// Center the unchanged board inside the nearest whole-cell footprint.
fn center_in_grid(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    ox: f64,
    oy: f64,
    gx: f64,
    gy: f64,
) -> (f64, f64) {
    let columns = (w / gx).ceil();
    let rows = (h / gy).ceil();
    let col = ((x + w / 2.0 - ox) / gx - columns / 2.0).round();
    let row = ((y + h / 2.0 - oy) / gy - rows / 2.0).round();
    (
        ox + col * gx + (columns * gx - w) / 2.0,
        oy + row * gy + (rows * gy - h) / 2.0,
    )
}

#[tauri::command]
pub async fn set_edge_hide(app: AppHandle, label: String, enabled: bool) -> Result<(), String> {
    require_unlocked(&app, &label)?;
    // Settings are saved by the existing board flush; keep the window open until
    // the UI's activity update closes the settings modal.
    app.state::<crate::edge_hide::EdgeHide>()
        .configure(&app, &label, enabled, true, None)
}

#[tauri::command]
pub async fn set_bookmark_style(
    app: AppHandle,
    label: String,
    style: String,
) -> Result<crate::edge_hide::Rect, String> {
    require_unlocked(&app, &label)?;
    if !matches!(
        style.as_str(),
        "heart" | "geometric" | "pixel" | "whale" | "knot"
    ) {
        return Err("书签样式无效".into());
    }
    let win = app.get_webview_window(&label).ok_or("窗口不存在")?;
    let layout = crate::edge_hide::BookmarkLayout::for_style(Some(&style));
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    win.set_min_size(Some(PhysicalSize::new(
        ((240 + layout.gutter - 28) as f64 * scale).round() as u32,
        (180.0 * scale).round() as u32,
    )))
    .map_err(|e| e.to_string())?;
    app.state::<crate::edge_hide::EdgeHide>()
        .resize_for_style(&app, &label, &style)
}

pub fn create_board_window(app: &AppHandle, board: &Value) -> Result<(), String> {
    let id = board["id"].as_str().ok_or("板子缺少 ID")?;
    let scale = board["display"]["scaleFactor"]
        .as_f64()
        .unwrap_or(1.0)
        .max(0.5);
    let label = if id == "main" {
        "main".to_string()
    } else {
        format!("board-{id}")
    };
    WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("桌面待办板")
        .decorations(false)
        .maximizable(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .visible(false)
        .inner_size(
            board["bounds"]["w"].as_f64().unwrap_or(560.0) / scale,
            board["bounds"]["h"].as_f64().unwrap_or(660.0) / scale,
        )
        .min_inner_size(240.0, 180.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn split_board(
    app: AppHandle,
    store: State<'_, BoardStore>,
    label: String,
    direction: String,
    ratio: f64,
    paper_offset: Value,
    scroll_top: f64,
) -> Result<(), String> {
    require_unlocked(&app, &label)?;
    if !matches!(direction.as_str(), "horizontal" | "vertical")
        || !ratio.is_finite()
        || !(0.2..=0.8).contains(&ratio)
    {
        return Err("拆板参数无效".into());
    }
    let paper_x = paper_offset["x"].as_f64().ok_or("纸面位置无效")?;
    let paper_y = paper_offset["y"].as_f64().ok_or("纸面位置无效")?;
    if !paper_x.is_finite()
        || !paper_y.is_finite()
        || !(0.0..=200.0).contains(&paper_x)
        || !(0.0..=200.0).contains(&paper_y)
        || !scroll_top.is_finite()
        || !(0.0..=1_000_000.0).contains(&scroll_top)
    {
        return Err("纸面位置无效".into());
    }
    let id = label.strip_prefix("board-").unwrap_or(&label);
    let win = app.get_webview_window(&label).ok_or("窗口不存在")?;
    let position = win.outer_position().map_err(|e| e.to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let scale = win.scale_factor().map_err(|e| e.to_string())?;
    let mut guard = store.document.lock().map_err(|e| e.to_string())?;
    let mut next = guard.clone();
    if next["boards"].as_array().unwrap().len() >= 20 {
        return Err("最多 20 块板子".into());
    }
    let index = next["boards"]
        .as_array()
        .unwrap()
        .iter()
        .position(|b| b["id"] == id)
        .ok_or("板子不存在")?;
    let mut child = next["boards"][index].clone();
    let line_height = next["boards"][index]["grid"]["spacing"]
        .as_f64()
        .unwrap_or(24.0);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let child_id = format!("b-{stamp}");
    child["id"] = json!(child_id);
    let (w1, h1, w2, h2, x2, y2) = if direction == "horizontal" {
        let h1 = (size.height as f64 * ratio) as u32;
        (
            size.width,
            h1,
            size.width,
            size.height - h1,
            position.x,
            position.y + h1 as i32,
        )
    } else {
        let w1 = (size.width as f64 * ratio) as u32;
        (
            w1,
            size.height,
            size.width - w1,
            size.height,
            position.x + w1 as i32,
            position.y,
        )
    };
    if w1 < 240.0_f64.mul_add(scale, 0.0) as u32
        || w2 < (240.0 * scale) as u32
        || h1 < (180.0 * scale) as u32
        || h2 < (180.0 * scale) as u32
    {
        return Err("拆开后板子太小，请先把板子拉大。".into());
    }
    next["boards"][index]["bounds"] = json!({"x":position.x,"y":position.y,"w":w1,"h":h1});
    child["bounds"] = json!({"x":x2,"y":y2,"w":w2,"h":h2});
    let cut_coordinate = if direction == "horizontal" {
        ((h1 as f64 / scale - paper_y) / line_height).round() * line_height + scroll_top
    } else {
        w1 as f64 / scale - paper_x
    };
    partition_items(
        next["items"].as_array_mut().unwrap(),
        id,
        &child_id,
        &direction,
        cut_coordinate,
    );
    let (first_ink, second_ink) = crate::paper_state::split_ink(&child, &direction, cut_coordinate);
    next["boards"][index]["ink"] = first_ink;
    child["ink"] = second_ink;
    crate::paper_state::rebuild_rows(&mut next["boards"][index]);
    crate::paper_state::rebuild_rows(&mut child);
    child["splitOrigin"] = json!({"boardId":id,"direction":direction,"coordinate":cut_coordinate,"spacing":line_height});
    next["boards"].as_array_mut().unwrap().push(child.clone());
    validate(&next)?;
    if let Err(e) = atomic_write(
        &store.root.join("board.json"),
        &serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?,
    ) {
        if let Some(w) = app.get_webview_window(&format!("board-{child_id}")) {
            let _ = w.destroy();
        }
        return Err(e);
    }
    *guard = next;
    drop(guard);
    create_board_window(&app, &child)?;
    win.set_size(PhysicalSize::new(w1, h1))
        .map_err(|e| e.to_string())?;
    app.emit("board-changed", json!({"origin":"split"}))
        .map_err(|e| e.to_string())
}

fn partition_items(
    items: &mut [Value],
    parent: &str,
    child: &str,
    direction: &str,
    coordinate: f64,
) {
    let mut fallback_y = 0.0;
    for item in items {
        if item["boardId"] != parent {
            continue;
        }
        let x = item["position"]["x"].as_f64().unwrap_or(24.0);
        let y = item["position"]["y"].as_f64().unwrap_or(fallback_y);
        fallback_y = y + 24.0;
        let moved = if direction == "horizontal" {
            y >= coordinate
        } else {
            x >= coordinate
        };
        let (new_x, new_y) = if moved {
            item["boardId"] = json!(child);
            if direction == "horizontal" {
                (x, (y - coordinate).max(0.0))
            } else {
                ((x - coordinate).max(24.0), y)
            }
        } else {
            (x, y)
        };
        item["position"] = json!({"x":new_x,"y":new_y});
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unchanged_size_is_centered_in_nearest_grid_footprint() {
        // A 180x250 board uses 2x3 cells, with equal margins on both sides.
        assert_eq!(
            center_in_grid(121.0, 239.0, 180.0, 250.0, 0.0, 0.0, 100.0, 100.0),
            (110.0, 225.0)
        );
        // The calculation is independent of occupied cells and supports offset monitors.
        assert_eq!(
            center_in_grid(-879.0, 259.0, 180.0, 250.0, -1000.0, 20.0, 100.0, 100.0),
            (-890.0, 245.0)
        );
    }
    #[test]
    fn split_assigns_by_paper_position_and_keeps_every_item() {
        let mut items = vec![
            json!({"id":"a","boardId":"main","position":{"x":24,"y":48}}),
            json!({"id":"b","boardId":"main","position":{"x":280,"y":240}}),
            json!({"id":"c","boardId":"other","position":{"x":24,"y":480}}),
        ];
        partition_items(&mut items, "main", "child", "horizontal", 192.0);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["boardId"], "main");
        assert_eq!(items[1]["boardId"], "child");
        assert_eq!(items[1]["position"], json!({"x":280.0,"y":48.0}));
        assert_eq!(items[2]["boardId"], "other");
        partition_items(&mut items, "child", "right", "vertical", 200.0);
        assert_eq!(items[1]["position"], json!({"x":80.0,"y":48.0}));
    }
}
