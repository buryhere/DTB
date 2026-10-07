use crate::board_store::{atomic_write, validate, BoardStore};
use base64::Engine;
use serde_json::{json, Value};
use std::{fs, io::Read, path::Path};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn load_document(store: State<'_, BoardStore>) -> Result<Value, String> {
    // Window creation holds this transaction while waiting on the UI thread.
    // A synchronous IPC read on that same thread would deadlock the creation.
    Ok(store.document.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub async fn read_item_icon(
    app: AppHandle,
    store: State<'_, BoardStore>,
    id: String,
) -> Result<String, String> {
    let path = store.registered_path(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::icon_engine::IconEngine>()
            .file_icon(path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_board(
    app: AppHandle,
    store: State<'_, BoardStore>,
    mut board: Value,
    items: Vec<Value>,
    settings: Value,
    origin: String,
) -> Result<(), String> {
    let id = board["id"].as_str().ok_or("板子缺少 ID")?.to_string();
    let label = if id == "main" {
        id.clone()
    } else {
        format!("board-{id}")
    };
    if let Some(rect) = app.state::<crate::edge_hide::EdgeHide>().expanded(&label) {
        board["bounds"]["x"] = json!(rect.x);
        board["bounds"]["y"] = json!(rect.y);
    }
    if items
        .iter()
        .any(|i| i["boardId"].as_str() != Some(id.as_str()))
    {
        return Err("不能覆盖其他板子的条目".into());
    }
    let mut guard = store.document.lock().map_err(|e| e.to_string())?;
    let mut next = guard.clone();
    let boards = next["boards"].as_array_mut().unwrap();
    let index = boards
        .iter()
        .position(|b| b["id"].as_str() == Some(id.as_str()))
        .ok_or("板子不存在")?;
    boards[index] = board;
    let all = next["items"].as_array_mut().unwrap();
    all.retain(|i| i["boardId"].as_str() != Some(id.as_str()));
    all.extend(items);
    next["settings"] = settings;
    validate(&next)?;
    let bytes = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("板子数据过大".into());
    }
    atomic_write(&store.root.join("board.json"), &bytes)?;
    *guard = next;
    drop(guard);
    app.emit("board-changed", json!({"origin":origin}))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_paths(
    store: State<BoardStore>,
    paths: Vec<String>,
    mode: String,
) -> Result<Vec<Value>, String> {
    if paths.len() > 100 {
        return Err("一次最多拖入 100 项".into());
    }
    if mode != "ref" && mode != "managed" {
        return Err("文件模式无效".into());
    }
    let stash = store.root.join("stash");
    let mut items = Vec::new();
    for path in paths {
        let source = Path::new(&path);
        let metadata = fs::metadata(source).map_err(|e| format!("无法读取 {path}：{e}"))?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err("不支持该文件类型".into());
        }
        let ext = source
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let managed = mode == "managed"
            && metadata.is_file()
            && !matches!(ext.as_str(), "lnk" | "exe" | "bat" | "cmd" | "ps1");
        let target = if managed {
            if metadata.len() > 512 * 1024 * 1024 {
                return Err("超过 512MB 的文件请使用引用模式".into());
            }
            fs::create_dir_all(&stash).map_err(|e| e.to_string())?;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let name = source.file_name().unwrap_or_default().to_string_lossy();
            let target = stash.join(format!("{stamp}-{}-{name}", items.len()));
            fs::copy(source, &target).map_err(|e| e.to_string())?;
            target
        } else {
            fs::canonicalize(source).map_err(|e| e.to_string())?
        };
        items.push(json!({"type":if metadata.is_dir(){"folder"}else{"file"},"path":target.to_string_lossy(),"title":source.file_name().unwrap_or_default().to_string_lossy(),"ext":ext,"mode":if managed{"managed"}else{"ref"}}));
    }
    Ok(items)
}

#[tauri::command]
pub fn open_item(app: AppHandle, store: State<BoardStore>, id: String) -> Result<(), String> {
    let guard = store.document.lock().map_err(|e| e.to_string())?;
    let item = guard["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"].as_str() == Some(&id))
        .ok_or("条目不存在")?;
    if item["type"] == "link" {
        let url = item["url"].as_str().ok_or("链接为空")?;
        if !url.starts_with("https://") && !url.starts_with("http://") {
            return Err("仅支持 http 和 https 网址".into());
        }
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| e.to_string())
    } else {
        let path = item["path"].as_str().ok_or("文件路径为空")?;
        if !Path::new(path).exists() {
            return Err("文件已移动或删除，请重新拖入。".into());
        }
        let shell_path = if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{unc}")
        } else {
            path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
        };
        app.opener()
            .open_path(shell_path, None::<&str>)
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn read_preview(store: State<BoardStore>, id: String) -> Result<Value, String> {
    let path = store.registered_path(&id)?;
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase();
    if !matches!(
        ext.as_str(),
        "txt"
            | "md"
            | "csv"
            | "log"
            | "json"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "webp"
            | "gif"
            | "bmp"
    ) {
        return Err("此类型请双击用默认程序打开。".into());
    }
    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 16 * 1024 * 1024 {
        return Err("预览最多支持 16MB，请用默认程序打开。".into());
    }
    let mut bytes = Vec::new();
    file.take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("文件在读取中变大，请用默认程序打开。".into());
    }
    Ok(json!({"base64":base64::engine::general_purpose::STANDARD.encode(bytes),"ext":ext}))
}

#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_markdown(store: State<BoardStore>, contents: String) -> Result<String, String> {
    let dir = store.root.join("exports");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let path = dir.join(format!("待办-{timestamp}.md"));
    atomic_write(&path, contents.as_bytes())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) -> Result<(), String> {
    request_quit(&app)?;
    Ok(())
}

pub struct QuitBarrier(pub std::sync::Mutex<std::collections::HashSet<String>>);
pub struct ReadyWindows(pub std::sync::Mutex<std::collections::HashSet<String>>);
#[tauri::command]
pub fn frontend_ready(app: AppHandle, label: String) -> Result<(), String> {
    if app.get_webview_window(&label).is_none() {
        return Err("窗口不存在".into());
    }
    app.state::<ReadyWindows>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(label);
    Ok(())
}
pub fn request_quit(app: &AppHandle) -> Result<(), String> {
    let ready = app.state::<ReadyWindows>();
    let ready = ready.0.lock().map_err(|e| e.to_string())?;
    let labels: std::collections::HashSet<String> = app
        .webview_windows()
        .keys()
        .filter(|label| ready.contains(*label))
        .cloned()
        .collect();
    if labels.is_empty() {
        app.exit(0);
        return Ok(());
    }
    *app.state::<QuitBarrier>()
        .0
        .lock()
        .map_err(|e| e.to_string())? = labels;
    app.emit("flush-before-quit", ()).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn quit_flushed(app: AppHandle, label: String) -> Result<(), String> {
    let finished = {
        let barrier = app.state::<QuitBarrier>();
        let mut pending = barrier.0.lock().map_err(|e| e.to_string())?;
        pending.remove(&label);
        pending.is_empty()
    };
    if finished {
        let a = app.clone();
        tauri::async_runtime::spawn_blocking(move || crate::icon_engine::restore(&a))
            .await
            .map_err(|e| e.to_string())??;
        app.exit(0);
    }
    Ok(())
}
