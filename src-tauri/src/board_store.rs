use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

pub struct BoardStore {
    pub root: PathBuf,
    pub document: Mutex<Value>,
}

pub fn default_document() -> Value {
    json!({"version":2,"boards":[{"id":"main","bounds":{"x":null,"y":null,"w":560,"h":660},"display":{"id":"","scaleFactor":1},"theme":{"accent":"#a67585","paper":"#fff0f5","opacity":0.94},"grid":{"lineOpacity":0.45,"mode":"underline"},"level":"desktop","collision":true,"autoFade":{"enabled":true,"idleOpacity":0.30},"collapsed":false,"edgeHide":false}],"items":[],"archive":[],"settings":{"fileMode":null,"autostart":false,"onboardingDone":false}})
}

pub fn validate(value: &Value) -> Result<(), String> {
    if value["version"] != 2
        || !value["boards"].is_array()
        || !value["items"].is_array()
        || !value["settings"].is_object()
    {
        return Err("状态文件格式不受支持，请先备份 board.json。".into());
    }
    let boards = value["boards"].as_array().unwrap();
    if boards.len() > 20 {
        return Err("最多 20 块板子。".into());
    }
    let mut ids = std::collections::HashSet::new();
    for board in boards {
        if let Some(spacing) = board["grid"].get("spacing") {
            let value = spacing.as_u64().ok_or("横线间距无效")?;
            if !(16..=64).contains(&value) {
                return Err("横线间距需要在 16 到 64 像素之间。".into());
            }
        }
        if board.get("locked").is_some_and(|v| !v.is_boolean()) {
            return Err("锁定状态无效".into());
        }
        let id = board["id"].as_str().ok_or("板子缺少 ID")?;
        if !ids.insert(id) || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("板子 ID 无效或重复".into());
        }
        for axis in ["w", "h"] {
            let n = board["bounds"][axis].as_f64().ok_or("板子尺寸无效")?;
            if !n.is_finite() || !(60.0..=16000.0).contains(&n) {
                return Err("板子尺寸超出范围".into());
            }
        }
    }
    let mut item_ids = std::collections::HashSet::new();
    for item in value["items"].as_array().unwrap() {
        let id = item["id"].as_str().ok_or("条目缺少 ID")?;
        if !item_ids.insert(id) || !ids.contains(item["boardId"].as_str().unwrap_or("")) {
            return Err("条目归属无效".into());
        }
        if !matches!(
            item["type"].as_str(),
            Some("text" | "file" | "folder" | "link")
        ) {
            return Err("条目类型无效".into());
        }
        if let Some(position) = item.get("position") {
            for axis in ["x", "y"] {
                let n = position[axis].as_f64().ok_or("条目位置无效")?;
                if !n.is_finite() || !(0.0..=1_000_000.0).contains(&n) {
                    return Err("条目位置无效".into());
                }
            }
        }
    }
    for board in boards {
        if let Some(rows) = board.get("paperRows") {
            let rows = rows.as_array().ok_or("整板文字格式无效")?;
            if rows.len() > 10000 {
                return Err("整板文字行数过多".into());
            }
            let mut row_ids = std::collections::HashSet::new();
            let mut atoms = std::collections::HashSet::new();
            for row in rows {
                if row.get("wrapWidth").is_some_and(|width| {
                    !width
                        .as_f64()
                        .is_some_and(|w| w.is_finite() && (1.0..=1_000_000.0).contains(&w))
                }) {
                    return Err("文字换行宽度无效".into());
                }
                let id = row["id"].as_str().ok_or("文字行缺少 ID")?;
                if !row_ids.insert(id)
                    || !row["height"]
                        .as_u64()
                        .is_some_and(|h| (1..=10000).contains(&h))
                {
                    return Err("文字行 ID 或高度无效".into());
                }
                for part in row["parts"].as_array().ok_or("文字行内容无效")? {
                    if part.get("text").is_some() {
                        if !part["text"].is_string() || part.get("itemId").is_some() {
                            return Err("文字片段无效".into());
                        }
                        if let Some(width) = part.get("width") {
                            if !width
                                .as_f64()
                                .is_some_and(|w| w.is_finite() && (0.0..=1_000_000.0).contains(&w))
                                || !part["text"].as_str().unwrap().chars().all(|c| c == ' ')
                            {
                                return Err("行内留白宽度无效".into());
                            }
                        }
                    } else {
                        let id = part["itemId"].as_str().ok_or("文件图标引用无效")?;
                        if !atoms.insert(id)
                            || !value["items"].as_array().unwrap().iter().any(|item| {
                                item["id"] == id
                                    && item["boardId"] == board["id"]
                                    && item["type"] != "text"
                            })
                        {
                            return Err("文件图标引用无效或重复".into());
                        }
                    }
                }
            }
        }
        if let Some(ink) = board.get("ink") {
            let strokes = ink.as_array().ok_or("铅笔画迹格式无效")?;
            let mut stroke_ids = std::collections::HashSet::new();
            for stroke in strokes {
                if !stroke_ids.insert(stroke["id"].as_str().ok_or("画迹缺少 ID")?)
                    || stroke.get("straight").is_some_and(|v| !v.is_boolean())
                {
                    return Err("画迹格式无效".into());
                }
                for point in stroke["points"].as_array().ok_or("画迹坐标无效")? {
                    for axis in ["x", "y"] {
                        if !point[axis].as_f64().is_some_and(|n| {
                            n.is_finite() && (-1_000_000.0..=1_000_000.0).contains(&n)
                        }) {
                            return Err("画迹坐标无效".into());
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

// MoveFileExW replaces an existing destination on Windows; std::fs::rename does not
// supply the same replace/write-through guarantees across platforms.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("pending");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            },
        };
        let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(destination.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    Ok(())
}

impl BoardStore {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let path = root.join("board.json");
        let document = if path.exists() {
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|e| format!("board.json 无法解析，已保留原文件：{e}"))?;
            validate(&value)?;
            let backups = root.join("backups");
            fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
            let timestamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            fs::copy(&path, backups.join(format!("board-{timestamp}.json")))
                .map_err(|e| e.to_string())?;
            let mut entries: Vec<_> = fs::read_dir(&backups)
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with("board-"))
                .collect();
            entries.sort_by_key(|e| e.file_name());
            let excess = entries.len().saturating_sub(10);
            for entry in entries.into_iter().take(excess) {
                fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
            value
        } else {
            default_document()
        };
        Ok(Self {
            root,
            document: Mutex::new(document),
        })
    }

    pub fn registered_path(&self, id: &str) -> Result<PathBuf, String> {
        let guard = self.document.lock().map_err(|e| e.to_string())?;
        let item = guard["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["id"].as_str() == Some(id))
            .ok_or("条目不存在")?;
        let path = item["path"].as_str().ok_or("条目没有文件路径")?;
        Ok(PathBuf::from(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_orphan_items() {
        let mut value = default_document();
        value["items"] = json!([{"id":"one","boardId":"missing","type":"text"}]);
        assert!(validate(&value).is_err());
    }
    #[test]
    fn validates_unified_rows_and_owned_file_atoms() {
        let mut value = default_document();
        value["items"] = json!([{"id":"pdf","boardId":"main","type":"file"}]);
        value["boards"][0]["paperRows"] =
            json!([{"id":"row","height":1,"parts":[{"text":"笔记"},{"itemId":"pdf"}]}]);
        value["boards"][0]["ink"] =
            json!([{"id":"stroke","points":[{"x":2,"y":12},{"x":50,"y":12}],"straight":true}]);
        assert!(validate(&value).is_ok());
        value["boards"][0]["paperRows"][0]["parts"][1]["itemId"] = json!("missing");
        assert!(validate(&value).is_err());
        value["boards"][0]["paperRows"][0]["parts"][1]["itemId"] = json!("pdf");
        value["boards"][0]["ink"][0]["points"][0]["x"] = json!("bad");
        assert!(validate(&value).is_err());
    }
    #[test]
    fn validates_precise_inline_whitespace() {
        let mut value = default_document();
        value["boards"][0]["paperRows"] =
            json!([{"id":"row","height":1,"parts":[{"text":"   ","width":19.5},{"text":"note"}]}]);
        assert!(validate(&value).is_ok());
        value["boards"][0]["paperRows"][0]["parts"][0]["width"] = json!(-1);
        assert!(validate(&value).is_err());
        value["boards"][0]["paperRows"][0]["parts"][0]["width"] = json!(19.5);
        value["boards"][0]["paperRows"][0]["parts"][0]["text"] = json!("letter");
        assert!(validate(&value).is_err());
    }
    #[test]
    fn validates_optional_frozen_wrap_width_and_accepts_old_rows() {
        let mut value = default_document();
        value["boards"][0]["paperRows"] =
            json!([{"id":"row","height":1,"parts":[{"text":"note"}]}]);
        assert!(validate(&value).is_ok());
        for width in [json!(480.5), json!(1), json!(1_000_000)] {
            value["boards"][0]["paperRows"][0]["wrapWidth"] = width;
            assert!(validate(&value).is_ok());
        }
        for width in [
            json!(0),
            json!(-1),
            json!(1_000_001),
            json!("480"),
            json!(null),
        ] {
            value["boards"][0]["paperRows"][0]["wrapWidth"] = width;
            assert!(validate(&value).is_err());
        }
    }
    #[test]
    fn replaces_existing_state_and_preserves_unicode() {
        let root =
            std::env::temp_dir().join(format!("desktop-board-store-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("state.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, "待办内容".as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "待办内容");
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
