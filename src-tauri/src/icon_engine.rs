//! Shell diagnostics and file icons run on their own STA. Collision and recovery
//! use separate apartments; no COM interface pointer crosses a thread boundary.
use serde_json::Value;
use std::{sync::mpsc, time::Duration};
use tauri::{AppHandle, Manager};

enum Request {
    Read(bool, mpsc::Sender<Result<Value, String>>),
    FileIcon(std::path::PathBuf, mpsc::Sender<Result<String, String>>),
}
pub struct IconEngine {
    tx: mpsc::Sender<Request>,
}
impl IconEngine {
    pub fn start() -> Self {
        let (tx, rx) = mpsc::channel::<Request>();
        std::thread::spawn(move || {
            #[cfg(windows)]
            unsafe {
                use windows::Win32::{
                    System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
                    UI::WindowsAndMessaging::{
                        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
                    },
                };
                let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                    .ok()
                    .map_err(|e| e.to_string());
                loop {
                    match rx.recv_timeout(Duration::from_millis(10)) {
                        Ok(Request::Read(images, reply)) => {
                            let _ = reply.send(initialized.clone().and_then(|_| {
                                if images {
                                    desktop::snapshot(Some(&mut std::collections::HashMap::new()))
                                } else {
                                    desktop::read()
                                }
                            }));
                        }
                        Ok(Request::FileIcon(path, reply)) => {
                            let _ = reply.send(
                                initialized
                                    .clone()
                                    .and_then(|_| crate::file_icon::read(&path)),
                            );
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    let mut message = MSG::default();
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                if initialized.is_ok() {
                    CoUninitialize();
                }
            }
            #[cfg(not(windows))]
            while let Ok(request) = rx.recv() {
                match request {
                    Request::Read(_, reply) => {
                        let _ = reply.send(Err("桌面图标引擎仅支持 Windows".into()));
                    }
                    Request::FileIcon(_, reply) => {
                        let _ = reply.send(Err("文件图标仅支持 Windows".into()));
                    }
                }
            }
        });
        Self { tx }
    }
    pub fn read(&self, images: bool) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Request::Read(images, tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(if images { 60 } else { 10 }))
            .map_err(|e| e.to_string())?
    }
    pub fn file_icon(&self, path: std::path::PathBuf) -> Result<String, String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(Request::FileIcon(path, tx))
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(30))
            .map_err(|e| e.to_string())?
    }
}

#[tauri::command]
pub async fn read_icons(app: AppHandle, images: Option<bool>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<IconEngine>().read(images.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn restore(app: &AppHandle) -> Result<(), String> {
    app.state::<crate::collision::CollisionEngine>().restore()
}

#[cfg(windows)]
pub mod desktop {
    use serde_json::{json, Value};
    use windows::{
        core::{w, Interface, BOOL},
        Win32::{
            Foundation::{HWND, LPARAM, POINT},
            Graphics::Gdi::ClientToScreen,
            System::{
                Com::{CoCreateInstance, CoTaskMemFree, IServiceProvider, CLSCTX_ALL},
                Variant::VARIANT,
            },
            UI::{
                HiDpi::GetDpiForWindow,
                Shell::{
                    Common::ITEMIDLIST, IFolderView, IFolderView2, IShellBrowser, IShellFolder,
                    IShellItem, IShellView, IShellWindows, SHCreateItemWithParent,
                    SHGetIDListFromObject, SID_STopLevelBrowser, ShellExecuteExW, ShellWindows,
                    FOLDERVIEWMODE, SEE_MASK_IDLIST, SHELLEXECUTEINFOW,
                    SIGDN_DESKTOPABSOLUTEPARSING, SIGDN_NORMALDISPLAY, SVGIO_ALLVIEW,
                    SVSI_POSITIONITEM, SWC_DESKTOP, SWFO_NEEDDISPATCH,
                },
                WindowsAndMessaging::{
                    EnumWindows, FindWindowExW, GetClassNameW, IsWindowVisible, SW_SHOWNORMAL,
                },
            },
        },
    };
    unsafe extern "system" fn find_def(hwnd: HWND, data: LPARAM) -> BOOL {
        let mut class = [0u16; 128];
        let len = GetClassNameW(hwnd, &mut class);
        let name = String::from_utf16_lossy(&class[..len.max(0) as usize]);
        if name != "Progman" && name != "WorkerW" {
            return BOOL(1);
        }
        if let Ok(child) = FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), None) {
            *(data.0 as *mut HWND) = child;
            return BOOL(0);
        }
        BOOL(1)
    }
    pub unsafe fn def_view() -> HWND {
        if let Ok(fv) = folder_view() {
            if let Ok(view) = fv.cast::<IShellView>() {
                if let Ok(hwnd) = view.GetWindow() {
                    return hwnd;
                }
            }
        }
        let mut found = HWND::default();
        let _ = EnumWindows(Some(find_def), LPARAM(&mut found as *mut HWND as isize));
        found
    }
    pub unsafe fn folder_view() -> windows::core::Result<IFolderView> {
        let shell: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL)?;
        let location = VARIANT::from(0i32);
        let root = VARIANT::default();
        let mut hwnd = 0;
        let dispatch =
            shell.FindWindowSW(&location, &root, SWC_DESKTOP, &mut hwnd, SWFO_NEEDDISPATCH)?;
        let services: IServiceProvider = dispatch.cast()?;
        let browser: IShellBrowser = services.QueryService(&SID_STopLevelBrowser)?;
        browser.QueryActiveShellView()?.cast()
    }
    pub unsafe fn read() -> Result<Value, String> {
        snapshot(None)
    }
    pub unsafe fn snapshot(
        mut cache: Option<&mut std::collections::HashMap<String, String>>,
    ) -> Result<Value, String> {
        let fv = folder_view().map_err(|e| e.to_string())?;
        // The generated wrapper treats S_FALSE as success, losing the on/off
        // distinction. Inspect the original HRESULT for this specific method.
        let arrange = (fv.vtable().GetAutoArrange)(fv.as_raw());
        arrange.ok().map_err(|e| e.to_string())?;
        let mut spacing = POINT::default();
        fv.GetSpacing(&mut spacing).map_err(|e| e.to_string())?;
        let def = def_view();
        let mut origin = POINT::default();
        if let Ok(list) = FindWindowExW(Some(def), None, w!("SysListView32"), None) {
            if !ClientToScreen(list, &mut origin).as_bool() {
                return Err("无法换算桌面图标坐标".into());
            }
        }
        let mut icon_size = 32;
        let fv2 = fv.cast::<IFolderView2>().map_err(|e| e.to_string())?;
        let mut mode = FOLDERVIEWMODE::default();
        fv2.GetViewModeAndIconSize(&mut mode, &mut icon_size)
            .map_err(|e| e.to_string())?;
        let logical_icon_size = icon_size;
        // Shell size is in DIPs; item positions and spacing are native pixels.
        icon_size = (icon_size as f64 * GetDpiForWindow(def) as f64 / 96.0).round() as i32;
        let count = fv.ItemCount(SVGIO_ALLVIEW).map_err(|e| e.to_string())?;
        let folder = fv.GetFolder::<IShellFolder>().map_err(|e| e.to_string())?;
        let mut icons = Vec::new();
        for index in 0..count {
            let pidl = match fv.Item(index) {
                Ok(p) if !p.is_null() => p,
                _ => continue,
            };
            let item = (|| {
                let point = fv.GetItemPosition(pidl).map_err(|e| e.to_string())?;
                let shell_item: IShellItem =
                    SHCreateItemWithParent(None, &folder, pidl).map_err(|e| e.to_string())?;
                let name = match shell_item.GetDisplayName(SIGDN_NORMALDISPLAY) {
                    Ok(p) => {
                        let s = p.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(p.0.cast()));
                        s
                    }
                    Err(_) => String::new(),
                };
                let id = item_identity(&shell_item)?;
                let mut image_error = None;
                let (image, reference) = if let Some(ref mut cache) = cache {
                    let key = format!("{id}:{icon_size}");
                    let reference_key = format!("{key}:reference");
                    if !cache.contains_key(&key) || !cache.contains_key(&reference_key) {
                        match crate::desktop_image::read_pair(&id, icon_size) {
                            Ok((image, reference)) => {
                                cache.insert(key.clone(), image);
                                cache.insert(reference_key.clone(), reference);
                            }
                            Err(error) => image_error = Some(error),
                        }
                    }
                    (
                        cache.get(&key).cloned().unwrap_or_default(),
                        cache.get(&reference_key).cloned().unwrap_or_default(),
                    )
                } else {
                    (String::new(), String::new())
                };
                Ok::<_, String>(
                    json!({"id":id,"name":name,"image":image,"referenceImage":reference,"imageError":image_error,"x":point.x+origin.x,"y":point.y+origin.y}),
                )
            })();
            CoTaskMemFree(Some(pidl.cast()));
            icons.push(item.map_err(|e| format!("读取桌面图标 #{index}：{e}"))?);
        }
        Ok(
            json!({"pid":std::process::id(),"autoArrange":arrange.0==0,"visible":IsWindowVisible(def).as_bool(),"defView":def.0 as usize,"grid":{"x":spacing.x,"y":spacing.y},"iconSize":icon_size,"logicalIconSize":logical_icon_size,"iconInsetX":((spacing.x-icon_size).max(0)/2),"viewOrigin":{"x":origin.x,"y":origin.y},"icons":icons}),
        )
    }

    #[cfg(test)]
    mod diagnostics {
        #[test]
        #[ignore = "reads the real desktop Shell; writes only isolated diagnostic data"]
        fn desktop_images() {
            unsafe {
                use windows::Win32::System::Com::{
                    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
                };
                CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
                let plain = super::snapshot(None).unwrap();
                let root = std::path::PathBuf::from(
                    std::env::var_os("DESKTOP_BOARD_DIAGNOSTIC_DIR").unwrap(),
                );
                assert!(root
                    .components()
                    .any(|c| c.as_os_str() == ".native-interaction-test-data"));
                std::fs::create_dir_all(&root).unwrap();
                let mut results = Vec::new();
                for icon in plain["icons"].as_array().unwrap() {
                    let id = icon["id"].as_str().unwrap();
                    let size = plain["iconSize"].as_i64().unwrap() as i32;
                    let pair = crate::desktop_image::read_pair(id, size);
                    let high = pair.as_ref().map(|p| p.0.clone()).map_err(|e| e.clone());
                    let reference = pair.as_ref().map(|p| p.1.clone()).map_err(|e| e.clone());
                    if high.is_err() || reference.is_err() {
                        eprintln!(
                            "{}: high={:?} reference={:?}",
                            icon["name"],
                            high.as_ref().err(),
                            reference.as_ref().err()
                        );
                    }
                    results.push(serde_json::json!({"icon":icon,"image":high.ok(),"reference":reference.ok()}));
                }
                std::fs::write(
                    root.join("images.json"),
                    serde_json::to_vec(&results).unwrap(),
                )
                .unwrap();
                CoUninitialize();
            }
        }
    }

    unsafe fn item_identity(item: &IShellItem) -> Result<String, String> {
        let name = item
            .GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING)
            .map_err(|e| e.to_string())?;
        let id = name.to_string().map_err(|e| e.to_string());
        CoTaskMemFree(Some(name.0.cast()));
        id
    }

    // Resolve a live desktop item, including virtual folders such as Recycle Bin.
    // No path supplied by the canvas is executed without matching enumeration.
    pub unsafe fn open(id: &str) -> Result<(), String> {
        let fv = folder_view().map_err(|e| e.to_string())?;
        let folder = fv.GetFolder::<IShellFolder>().map_err(|e| e.to_string())?;
        for n in 0..fv.ItemCount(SVGIO_ALLVIEW).map_err(|e| e.to_string())? {
            let pidl = fv.Item(n).map_err(|e| e.to_string())?;
            let item = SHCreateItemWithParent::<_, IShellItem>(None, &folder, pidl);
            CoTaskMemFree(Some(pidl.cast()));
            let item = item.map_err(|e| e.to_string())?;
            if item_identity(&item)? != id {
                continue;
            }
            let absolute = SHGetIDListFromObject(&item).map_err(|e| e.to_string())?;
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_IDLIST,
                lpVerb: w!("open"),
                lpIDList: absolute.cast(),
                nShow: SW_SHOWNORMAL.0,
                ..Default::default()
            };
            let result = ShellExecuteExW(&mut info).map_err(|e| e.to_string());
            CoTaskMemFree(Some(absolute.cast()));
            return result;
        }
        Err("该桌面图标已不存在".into())
    }

    // Never rebuild a PIDL from persisted bytes. Match stable parsing paths against a fresh
    // enumeration, keeping every live allocation on this apartment.
    pub unsafe fn position(
        targets: &std::collections::BTreeMap<String, crate::icon_recovery::Point>,
    ) -> Result<(), String> {
        let fv = folder_view().map_err(|e| e.to_string())?;
        let arrange = (fv.vtable().GetAutoArrange)(fv.as_raw());
        arrange.ok().map_err(|e| e.to_string())?;
        if arrange.0 == 0 {
            return Err("请先关闭桌面的“自动排列图标”。".into());
        }
        let snapshot = read()?;
        let ox = snapshot["viewOrigin"]["x"].as_i64().unwrap_or(0) as i32;
        let oy = snapshot["viewOrigin"]["y"].as_i64().unwrap_or(0) as i32;
        let folder = fv.GetFolder::<IShellFolder>().map_err(|e| e.to_string())?;
        let count = fv.ItemCount(SVGIO_ALLVIEW).map_err(|e| e.to_string())?;
        let mut allocations = Vec::new();
        let mut selected = Vec::new();
        let mut points = Vec::new();
        for n in 0..count {
            if let Ok(pidl) = fv.Item(n) {
                if pidl.is_null() {
                    continue;
                }
                let id = SHCreateItemWithParent::<_, IShellItem>(None, &folder, pidl)
                    .map_err(|e| e.to_string())
                    .and_then(|item| item_identity(&item));
                if let Some(p) = id.ok().and_then(|id| targets.get(&id)) {
                    selected.push(pidl as *const ITEMIDLIST);
                    points.push(POINT {
                        x: p.x - ox,
                        y: p.y - oy,
                    });
                }
                allocations.push(pidl);
            }
        }
        let result = if selected.is_empty() {
            Ok(())
        } else {
            fv.SelectAndPositionItems(
                selected.len() as u32,
                selected.as_ptr(),
                Some(points.as_ptr()),
                SVSI_POSITIONITEM.0 as u32,
            )
            .map_err(|e| e.to_string())
        };
        for pidl in allocations {
            CoTaskMemFree(Some(pidl.cast()));
        }
        result
    }
}
