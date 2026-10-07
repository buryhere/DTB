mod board_ops;
mod board_store;
mod collision;
mod commands;
mod cut;
mod desktop_clip;
mod desktop_image;
mod edge_hide;
mod file_icon;
mod icon_engine;
mod icon_recovery;
mod native_chrome;
mod paper_state;
mod window;
use board_store::BoardStore;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_opener::OpenerExt;

pub fn handle_icon_cli() -> bool {
    icon_recovery::cli()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                for win in app
                    .webview_windows()
                    .values()
                    .filter(|w| w.label() == "main" || w.label().starts_with("board-"))
                {
                    let _ = app.state::<edge_hide::EdgeHide>().reveal(&app, win.label());
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            });
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::load_document,
            commands::save_board,
            commands::import_paths,
            commands::open_item,
            commands::read_preview,
            commands::read_item_icon,
            commands::set_autostart,
            commands::export_markdown,
            commands::quit_app,
            commands::quit_flushed,
            commands::frontend_ready,
            board_ops::board_operation,
            board_ops::board_operation_flushed,
            cut::start_cut,
            cut::cut_scene,
            cut::finish_cut,
            window::set_level,
            window::set_board_lock,
            window::drag_board,
            window::set_collapsed,
            window::fit_board,
            window::split_board,
            window::set_edge_hide,
            window::set_bookmark_style,
            edge_hide::edge_hide_activity,
            edge_hide::reveal_edge_board,
            edge_hide::expanded_board_position,
            icon_engine::read_icons,
            collision::restore_icons,
            collision::set_collision,
            collision::collision_overlay_ready,
            collision::collision_painted,
            collision::collision_hit_regions,
            collision::collision_settled,
            collision::collision_failed
        ])
        .setup(|app| {
            let root = std::env::var_os("DESKTOP_BOARD_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var_os("APPDATA")
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(std::env::temp_dir)
                        .join("DesktopBoard")
                });
            let store = BoardStore::open(root).map_err(std::io::Error::other)?;
            let document = store
                .document
                .lock()
                .map_err(|e| std::io::Error::other(e.to_string()))?
                .clone();
            app.manage(store);
            app.manage(edge_hide::EdgeHide::start(app.handle().clone()));
            app.manage(board_ops::BoardOperations::default());
            app.manage(cut::CutState::default());
            app.manage(commands::ReadyWindows(std::sync::Mutex::new(
                std::collections::HashSet::new(),
            )));
            app.manage(commands::QuitBarrier(std::sync::Mutex::new(
                std::collections::HashSet::new(),
            )));
            app.manage(icon_engine::IconEngine::start());
            app.manage(collision::CollisionEngine::start(app.handle().clone()));
            let overlay_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = collision::create_overlay(overlay_app).await {
                    eprintln!("{e}");
                }
            });
            for board in document["boards"].as_array().unwrap() {
                if board["id"] != "main" {
                    window::create_board_window(app.handle(), board)
                        .map_err(std::io::Error::other)?;
                }
            }
            if !document["boards"]
                .as_array()
                .unwrap()
                .iter()
                .any(|b| b["id"] == "main")
            {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.destroy();
                }
            }
            let new_board = MenuItem::with_id(app, "new", "新建板子", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "显示所有板子", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "隐藏所有板子", true, None::<&str>)?;
            let data = MenuItem::with_id(app, "data", "打开资料目录", true, None::<&str>)?;
            let restore =
                MenuItem::with_id(app, "restore", "恢复桌面图标位置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&new_board, &show, &hide, &restore, &data, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("桌面待办板")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "new" => {
                        let a = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) =
                                board_ops::board_operation(a, "tray".into(), "new".into(), None)
                                    .await
                            {
                                eprintln!("{e}");
                            }
                        });
                    }
                    "show" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            for win in app
                                .webview_windows()
                                .values()
                                .filter(|w| w.label() == "main" || w.label().starts_with("board-"))
                            {
                                let _ =
                                    app.state::<edge_hide::EdgeHide>().reveal(&app, win.label());
                                let _ = win.show();
                            }
                            if let Some(win) = app.get_webview_window("main") {
                                let _ = win.set_focus();
                            }
                        });
                    }
                    "hide" => {
                        for win in app
                            .webview_windows()
                            .values()
                            .filter(|w| w.label() == "main" || w.label().starts_with("board-"))
                        {
                            let _ = win.hide();
                        }
                    }
                    "data" => {
                        let _ = app.opener().open_path(
                            app.state::<BoardStore>().root.to_string_lossy(),
                            None::<&str>,
                        );
                    }
                    "quit" => {
                        let _ = commands::request_quit(app);
                    }
                    "restore" => {
                        let a = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = collision::restore_icons(a).await;
                        });
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法启动待办板")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                let _ = icon_engine::restore(app);
            }
        });
}
