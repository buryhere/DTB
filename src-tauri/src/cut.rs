use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

#[derive(Default)]
pub struct CutState(Mutex<Option<Value>>);

pub fn is_active(app: &AppHandle) -> bool {
    app.state::<CutState>()
        .0
        .lock()
        .map(|v| v.is_some())
        .unwrap_or(true)
}
fn overlay_destroyed(app: &AppHandle, token: &str) {
    if let Ok(mut scene) = app.state::<CutState>().0.lock() {
        if scene.as_ref().and_then(|s| s["token"].as_str()) != Some(token) {
            return;
        }
        if let Some(s) = scene.take() {
            if let Some(label) = s["label"].as_str() {
                let _ = app.emit_to(label, "cut-armed", false);
            }
        }
    }
}

#[tauri::command]
pub async fn start_cut(
    app: AppHandle,
    label: String,
    paper: Value,
    scroll_top: f64,
) -> Result<(), String> {
    let id = label.strip_prefix("board-").unwrap_or(&label);
    let store = app.state::<crate::board_store::BoardStore>();
    let doc = store.document.lock().map_err(|e| e.to_string())?;
    let board = doc["boards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["id"] == id)
        .ok_or("板子不存在")?;
    if board["locked"] == true || board["collapsed"] == true {
        return Err("请先解锁并展开板子。".into());
    }
    let spacing = board["grid"]["spacing"].as_f64().unwrap_or(24.0);
    drop(doc);
    for key in ["x", "y", "w", "h"] {
        let n = paper[key].as_f64().ok_or("纸面范围无效")?;
        if !n.is_finite() || !(0.0..=16000.0).contains(&n) {
            return Err("纸面范围无效".into());
        }
    }
    if !scroll_top.is_finite() || !(0.0..=1_000_000.0).contains(&scroll_top) {
        return Err("纸面滚动位置无效".into());
    }
    let state = app.state::<CutState>();
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    if current.is_some() {
        return Err("已有板子进入裁剪模式，请先右键取消。".into());
    }
    let target = app.get_webview_window(&label).ok_or("板子窗口不存在")?;
    let position = target.outer_position().map_err(|e| e.to_string())?;
    let size = target.outer_size().map_err(|e| e.to_string())?;
    let board_scale = target.scale_factor().map_err(|e| e.to_string())?;
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let left = monitors
        .iter()
        .map(|m| m.position().x)
        .min()
        .ok_or("没有可用屏幕")?;
    let top = monitors.iter().map(|m| m.position().y).min().unwrap();
    let right = monitors
        .iter()
        .map(|m| m.position().x + m.size().width as i32)
        .max()
        .unwrap();
    let bottom = monitors
        .iter()
        .map(|m| m.position().y + m.size().height as i32)
        .max()
        .unwrap();
    let token = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .to_string();
    let overlay = WebviewWindowBuilder::new(
        &app,
        "cut-overlay",
        WebviewUrl::App("index.html?overlay=cut".into()),
    )
    .title("裁剪板子 · 右键取消")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .always_on_top(true)
    .visible(false)
    .inner_size(1.0, 1.0)
    .build()
    .map_err(|e| e.to_string())?;
    let cleanup_app = app.clone();
    let cleanup_token = token.clone();
    overlay.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let a = cleanup_app.clone();
            let t = cleanup_token.clone();
            tauri::async_runtime::spawn_blocking(move || overlay_destroyed(&a, &t));
        }
    });
    let prepare = (|| -> Result<Value, String> {
        overlay
            .set_position(PhysicalPosition::new(left, top))
            .map_err(|e| e.to_string())?;
        overlay
            .set_size(PhysicalSize::new(
                (right - left) as u32,
                (bottom - top) as u32,
            ))
            .map_err(|e| e.to_string())?;
        let scale = overlay.scale_factor().map_err(|e| e.to_string())?;
        Ok(
            json!({"token":token,"label":label,"origin":{"x":left,"y":top},"scale":scale,"boardScale":board_scale,"board":{"x":position.x,"y":position.y,"w":size.width,"h":size.height},"paper":{"x":position.x as f64+paper["x"].as_f64().unwrap()*board_scale,"y":position.y as f64+paper["y"].as_f64().unwrap()*board_scale,"w":paper["w"].as_f64().unwrap()*board_scale,"h":paper["h"].as_f64().unwrap()*board_scale},"paperOffset":paper,"scrollTop":scroll_top,"lineHeight":spacing*board_scale}),
        )
    })();
    match prepare {
        Ok(scene) => {
            *current = Some(scene);
        }
        Err(e) => {
            let _ = overlay.destroy();
            return Err(e);
        }
    }
    // The frontend shows the window after it has received geometry. Showing an
    // empty transparent top-level window first can make clicks pass through.
    app.emit_to(&label, "cut-armed", true)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn cut_scene(app: AppHandle) -> Result<Option<Value>, String> {
    let scene = app
        .state::<CutState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    if scene.is_some() {
        if let Some(w) = app.get_webview_window("cut-overlay") {
            w.show().map_err(|e| e.to_string())?;
            w.set_focus().map_err(|e| e.to_string())?;
        }
    }
    Ok(scene)
}

#[tauri::command]
pub async fn finish_cut(
    app: AppHandle,
    token: String,
    gesture: Option<Value>,
) -> Result<(), String> {
    if gesture.is_none() {
        // Never uncover Explorer while the right button is still held. Otherwise
        // its mouse-up opens the desktop menu even though WebView cancelled down.
        tauri::async_runtime::spawn_blocking(|| {
            use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_RBUTTON};
            while unsafe { GetAsyncKeyState(VK_RBUTTON.0 as i32) } < 0 {
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
            std::thread::sleep(std::time::Duration::from_millis(32));
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let scene = {
        let state = app.state::<CutState>();
        let mut current = state.0.lock().map_err(|e| e.to_string())?;
        if current.as_ref().and_then(|s| s["token"].as_str()) != Some(&token) {
            return Ok(());
        }
        current.take().unwrap()
    };
    if let Some(w) = app.get_webview_window("cut-overlay") {
        let _ = w.hide();
        let _ = w.destroy();
    }
    let label = scene["label"].as_str().unwrap().to_string();
    let _ = app.emit_to(&label, "cut-armed", false);
    if let Some(g) = gesture {
        let direction = g["direction"].as_str().ok_or("裁剪方向无效")?.to_string();
        let coordinate = g["coordinate"]
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or("裁剪位置无效")?;
        let axis = if direction == "horizontal" { "y" } else { "x" };
        let length = if direction == "horizontal" { "h" } else { "w" };
        let ratio = (scene["paper"][axis].as_f64().unwrap() + coordinate
            - scene["board"][axis].as_f64().unwrap())
            / scene["board"][length].as_f64().unwrap();
        let result = crate::window::split_board(
            app.clone(),
            app.state::<crate::board_store::BoardStore>(),
            label.clone(),
            direction,
            ratio,
            json!({"x":scene["paperOffset"]["x"],"y":scene["paperOffset"]["y"]}),
            scene["scrollTop"].as_f64().unwrap(),
        )
        .await;
        if let Err(e) = result {
            let _ = app.emit_to(&label, "cut-error", e);
        }
    }
    Ok(())
}
