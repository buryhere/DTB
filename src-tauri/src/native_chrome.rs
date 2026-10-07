//! Keep Win32's non-client painting out of the transparent WebView surface.
//! Tao retains caption/size styles for OS operations on undecorated windows;
//! DefWindowProc can otherwise paint those styles when focus changes.
use tauri::WebviewWindow;
use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            IsIconic, HTCLIENT, WM_NCACTIVATE, WM_NCDESTROY, WM_NCHITTEST, WM_NCPAINT,
        },
    },
};

const SUBCLASS_ID: usize = 0x4442_4348;

pub fn install(win: &WebviewWindow, hwnd: usize) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    // Comctl32 requires installing the subclass on the window's own thread.
    // Called from edge configuration after the frontend has loaded its document,
    // never while window creation holds the document transaction.
    win.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            if unsafe { SetWindowSubclass(HWND(hwnd as *mut _), Some(window_proc), SUBCLASS_ID, 0) }
                .as_bool()
            {
                Ok(())
            } else {
                Err("无法关闭板子的系统边框绘制".to_string())
            }
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    match msg {
        WM_NCPAINT => LRESULT(0),
        // Preserve Tao's focus notifications, while -1 prevents the downstream
        // DefWindowProc from drawing an active/inactive caption and border.
        WM_NCACTIVATE if !IsIconic(hwnd).as_bool() => {
            DefSubclassProc(hwnd, msg, wparam, LPARAM(-1))
        }
        // CSS paper-edge handles explicitly start OS resizing. Transparent
        // bookmark corners must not inherit Tao's outer HWND resize hits.
        WM_NCHITTEST => LRESULT(HTCLIENT as isize),
        WM_NCDESTROY => {
            let _ = RemoveWindowSubclass(hwnd, Some(window_proc), id);
            DefSubclassProc(hwnd, msg, wparam, lparam)
        }
        _ => DefSubclassProc(hwnd, msg, wparam, lparam),
    }
}
