//! Alpha-contour physics in a desktop-child overlay for participating icons. Native positions
//! remain untouched during collisions; the durable journal also recovers older
//! committed layouts, with an independent guard protecting layer visibility.
use crate::{
    board_store::{atomic_write, BoardStore},
    icon_engine::desktop,
    icon_recovery::{self, Entry, Guard, Journal, Point},
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::mpsc,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::{
    core::w,
    Win32::{
        Foundation::{
            CloseHandle, COLORREF, HANDLE, HWND, POINT, RECT, WAIT_ABANDONED, WAIT_OBJECT_0,
        },
        Graphics::{Dwm::DwmFlush, Gdi::ScreenToClient},
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject},
        },
        UI::HiDpi::{AreDpiAwarenessContextsEqual, GetWindowDpiAwarenessContext},
        UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetDoubleClickTime, VK_LBUTTON},
        UI::WindowsAndMessaging::{
            DispatchMessageW, GetAncestor, GetClassNameW, GetCursorPos, GetLayeredWindowAttributes,
            GetParent, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, PeekMessageW,
            SetLayeredWindowAttributes, SetParent, SetWindowLongPtrW, SetWindowPos,
            ShowWindowAsync, TranslateMessage, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GWL_STYLE,
            HWND_TOP, LAYERED_WINDOW_ATTRIBUTES_FLAGS, LWA_ALPHA, MSG, PM_REMOVE, SWP_FRAMECHANGED,
            SWP_NOACTIVATE, SW_HIDE, SW_SHOWNA, WS_CHILD, WS_EX_LAYERED, WS_EX_TRANSPARENT,
            WS_POPUP,
        },
    },
};

enum Request {
    Prepare(mpsc::Sender<Result<(), String>>),
    Ready,
    Painted(u64),
    Regions(u64, Vec<HitRegion>),
    Settled(u64, BTreeMap<String, Point>),
    Failed(u64, String),
    Restore(bool, mpsc::Sender<Result<(), String>>),
}
pub struct CollisionEngine {
    tx: mpsc::Sender<Request>,
}
impl CollisionEngine {
    pub fn start(app: AppHandle) -> Self {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || unsafe {
            if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
                return;
            }
            let mut state = Runtime::new(app);
            if let Ok(Some(j)) = Journal::load(&state.root) {
                if !icon_recovery::alive(j.pid) {
                    let _ = icon_recovery::recover(&state.root, None);
                }
            }
            loop {
                match rx.recv_timeout(Duration::from_millis(16)) {
                    Ok(Request::Prepare(reply)) => {
                        let result = state.prepare();
                        if let Err(ref error) = result {
                            state.record_error(error);
                            state.suspended = true;
                            // A failed snapshot must not leave the global owner
                            // mutex acquired, blocking a later retry/session.
                            if state.guard.is_none() {
                                state.lease = None;
                            }
                        }
                        let _ = reply.send(result);
                    }
                    Ok(Request::Ready) => state.ready = true,
                    Ok(Request::Regions(t, regions)) => {
                        if t == state.token && state.active {
                            if let Err(e) = state.update_regions(regions) {
                                state.fail(e);
                            }
                        }
                    }
                    Ok(Request::Painted(t)) => {
                        if let Err(e) = state.painted(t) {
                            state.fail(e);
                        }
                    }
                    Ok(Request::Settled(t, targets)) => {
                        if let Err(e) = state.commit(t, targets) {
                            state.fail(e);
                        }
                    }
                    Ok(Request::Failed(t, e)) => {
                        if t == state.token {
                            state.fail(e);
                        }
                    }
                    Ok(Request::Restore(disable, reply)) => {
                        state.suspended = true;
                        let result = state.restore();
                        if disable {
                            let _ = state.disable();
                        }
                        let _ = reply.send(result);
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        let _ = state.restore();
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if let Err(e) = state.tick() {
                    state.fail(e);
                }
                let mut msg = MSG::default();
                while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            CoUninitialize();
        });
        Self { tx }
    }
    fn request(&self, restore: Option<bool>) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        self.tx
            .send(if let Some(disable) = restore {
                Request::Restore(disable, tx)
            } else {
                Request::Prepare(tx)
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(30))
            .map_err(|e| e.to_string())?
    }
    pub fn restore(&self) -> Result<(), String> {
        self.request(Some(false))
    }
}
struct DesktopLease(HANDLE);
impl DesktopLease {
    unsafe fn acquire() -> Result<Self, String> {
        let h = CreateMutexW(None, false, w!("Local\\DesktopBoard.IconCollision.Owner"))
            .map_err(|e| format!("取得桌面图标动画管理权：{e}"))?;
        let status = WaitForSingleObject(h, 0);
        if status != WAIT_OBJECT_0 && status != WAIT_ABANDONED {
            let _ = CloseHandle(h);
            return Err("另一个板子进程正在管理桌面图标，请先退出它。".into());
        }
        Ok(Self(h))
    }
}
impl Drop for DesktopLease {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.0);
            let _ = CloseHandle(self.0);
        }
    }
}
struct Runtime {
    app: AppHandle,
    root: std::path::PathBuf,
    ready: bool,
    suspended: bool,
    lease: Option<DesktopLease>,
    guard: Option<Guard>,
    journal: Journal,
    cache: HashMap<String, String>,
    pinned: HashSet<String>,
    snapshot: Value,
    boards: Vec<Value>,
    areas: Vec<Value>,
    token: u64,
    active: bool,
    painted: bool,
    changed: Instant,
    last_poll: Instant,
    last_pulse: Instant,
    started: Instant,
    overlay: HWND,
    overlay_origin: Point,
    regions: Vec<HitRegion>,
    clipped_ids: HashSet<String>,
    mouse_down: bool,
    click: Option<(String, Instant, POINT)>,
}
impl Runtime {
    fn new(app: AppHandle) -> Self {
        let root = app.state::<BoardStore>().root.clone();
        let t = Instant::now();
        Self {
            app,
            root,
            ready: false,
            suspended: false,
            lease: None,
            guard: None,
            journal: Journal::new(),
            cache: HashMap::new(),
            pinned: HashSet::new(),
            snapshot: Value::Null,
            boards: vec![],
            areas: vec![],
            token: 0,
            active: false,
            painted: false,
            changed: t,
            last_poll: t,
            last_pulse: t,
            started: t,
            overlay: HWND::default(),
            overlay_origin: Point { x: 0, y: 0 },
            regions: vec![],
            clipped_ids: HashSet::new(),
            mouse_down: false,
            click: None,
        }
    }
    unsafe fn prepare(&mut self) -> Result<(), String> {
        self.suspended = false;
        if self.guard.is_some() {
            self.check_guard()?;
            return Ok(());
        }
        self.lease = Some(DesktopLease::acquire()?);
        // A stale journal must recover successfully before a new session replaces it.
        if let Some(old) = Journal::load(&self.root)? {
            if !old.entries.is_empty() || old.hidden || old.clip.is_some() {
                if icon_recovery::alive(old.pid) && old.pid != std::process::id() {
                    self.lease = None;
                    return Err("上一次图标管理仍在运行".into());
                }
                icon_recovery::recover(&self.root, None)?;
            }
        }
        let snapshot = desktop::snapshot(Some(&mut self.cache))
            .map_err(|e| format!("准备桌面图标图像：{e}"))?;
        if snapshot["autoArrange"] == true {
            self.lease = None;
            return Err("请先右键桌面 → 查看，关闭“自动排列图标”，再启用让位动画。".into());
        }
        if snapshot["icons"].as_array().is_none_or(|a| a.is_empty()) {
            self.lease = None;
            return Err("桌面没有可读取的图标".into());
        }
        if !icon_recovery::desktop_visible() {
            self.lease = None;
            return Err("请先在桌面“查看”菜单中显示桌面图标。".into());
        }
        self.journal = Journal::new();
        self.pinned.clear();
        self.guard = Some(Guard::launch(&self.root, &self.journal)?);
        self.snapshot = snapshot;
        self.boards.clear();
        Ok(())
    }
    fn check_guard(&self) -> Result<(), String> {
        if let Some(g) = &self.guard {
            if !icon_recovery::alive(g.pid) {
                return Err("图标恢复进程已停止，已暂停动画并恢复图标。".into());
            }
            if std::fs::read_to_string(self.root.join("icon-guard.revoked"))
                .ok()
                .as_deref()
                == Some(&g.token)
            {
                return Err("图标恢复进程已接管，本次动画已停止。".into());
            }
        }
        Ok(())
    }
    fn geometry(&self) -> Result<(Vec<Value>, Vec<Value>), String> {
        let store = self.app.state::<BoardStore>();
        let doc = store.document.lock().map_err(|e| e.to_string())?.clone();
        let mut boards = vec![];
        for b in doc["boards"].as_array().unwrap() {
            if b["collision"] != true {
                continue;
            }
            let id = b["id"].as_str().unwrap();
            let label = if id == "main" {
                id.to_owned()
            } else {
                format!("board-{id}")
            };
            if let Some(win) = self.app.get_webview_window(&label) {
                if self
                    .app
                    .state::<crate::edge_hide::EdgeHide>()
                    .paper_hidden(&label)
                {
                    continue;
                }
                if win.is_visible().map_err(|e| e.to_string())? {
                    let p = win.outer_position().map_err(|e| e.to_string())?;
                    let s = win.outer_size().map_err(|e| e.to_string())?;
                    let scale = win.scale_factor().map_err(|e| e.to_string())?;
                    let inset = (8.0 * scale).round() as i32;
                    let mut visible = crate::edge_hide::Rect {
                        x: p.x + inset + (28.0 * scale).round() as i32,
                        y: p.y + inset,
                        w: s.width
                            .saturating_sub(2 * inset as u32 + (28.0 * scale).round() as u32)
                            as i32,
                        h: s.height.saturating_sub(2 * inset as u32) as i32,
                    };
                    if let Some(area) = self
                        .app
                        .state::<crate::edge_hide::EdgeHide>()
                        .clip_area(&label)
                    {
                        visible = visible.intersection(area);
                    }
                    if visible.w > 0 && visible.h > 0 {
                        boards.push(json!({"x":visible.x,"y":visible.y,"w":visible.w,"h":visible.h,"radius":(12.0*scale).min(visible.w.min(visible.h) as f64/2.0)}));
                    }
                }
            }
        }
        let areas = self
            .app
            .available_monitors()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| {
                let a = m.work_area();
                json!({"x":a.position.x,"y":a.position.y,"w":a.size.width,"h":a.size.height})
            })
            .collect();
        Ok((boards, areas))
    }
    unsafe fn tick(&mut self) -> Result<(), String> {
        if !self.ready || self.suspended {
            return Ok(());
        }
        let (boards, areas) = self.geometry()?;
        if self.guard.is_some() {
            self.check_guard()?;
            if self.last_pulse.elapsed() > Duration::from_millis(500) {
                self.guard.as_ref().unwrap().pulse()?;
                self.last_pulse = Instant::now();
            }
        }
        if self.painted {
            self.desktop_click();
        }
        if boards.is_empty() {
            if self.active || !self.journal.entries.is_empty() || self.journal.clip.is_some() {
                self.restore()?;
            }
            self.boards = boards;
            self.areas = areas;
            return Ok(());
        }
        if self.guard.is_none() {
            self.prepare()?;
        }
        let changed = boards != self.boards || areas != self.areas;
        if changed {
            let beginning = !self.active;
            if beginning {
                self.begin()?;
            }
            self.boards = boards;
            self.areas = areas;
            self.changed = Instant::now();
            if beginning {
                self.send_scene()?;
            } else {
                self.app
                    .emit_to(
                        "icons-overlay",
                        "collision-move",
                        json!({"token":self.token,"boards":self.boards,"areas":self.areas}),
                    )
                    .map_err(|e| e.to_string())?;
            }
        } else if self.last_poll.elapsed() > Duration::from_secs(2) {
            self.last_poll = Instant::now();
            let old = icon_recovery::points(&self.snapshot);
            self.refresh()?;
            if icon_recovery::points(&self.snapshot) != old {
                if !self.active {
                    self.begin()?;
                }
                self.send_scene()?;
            }
        }
        if self.active && !self.painted && self.started.elapsed() > Duration::from_secs(8) {
            return Err("动画层未能就绪，已恢复桌面图标。".into());
        }
        if self.active && self.painted && self.started.elapsed() > Duration::from_secs(3) {
            return Err("动画层停止响应，已恢复桌面图标。".into());
        }
        Ok(())
    }
    unsafe fn refresh(&mut self) -> Result<(), String> {
        let previous = icon_recovery::points(&self.snapshot);
        self.snapshot = desktop::snapshot(Some(&mut self.cache))
            .map_err(|e| format!("刷新桌面图标图像：{e}"))?;
        if self.snapshot["autoArrange"] == true {
            return Err("桌面已开启自动排列，让位动画已暂停。".into());
        }
        let current = icon_recovery::points(&self.snapshot);
        if self.active {
            for (id, point) in &current {
                if previous.get(id).is_some_and(|old| old != point) {
                    self.pinned.insert(id.clone());
                }
            }
        }
        for (id, e) in &self.journal.entries {
            if current.get(id).is_some_and(|p| !e.owns(*p)) {
                self.pinned.insert(id.clone());
            }
        }
        self.journal
            .entries
            .retain(|id, e| current.get(id).is_some_and(|p| e.owns(*p)));
        self.journal.write(&self.root)?;
        Ok(())
    }
    unsafe fn begin(&mut self) -> Result<(), String> {
        self.refresh()?;
        self.attach()?;
        self.token += 1;
        self.active = true;
        self.painted = false;
        self.regions.clear();
        self.clipped_ids.clear();
        self.click = None;
        self.started = Instant::now();
        Ok(())
    }
    unsafe fn attach(&mut self) -> Result<(), String> {
        let win = self
            .app
            .get_webview_window("icons-overlay")
            .ok_or("动画窗口不存在")?;
        self.overlay = win.hwnd().map_err(|e| e.to_string())?;
        let def = desktop::def_view();
        let parent = GetParent(def).map_err(|e| e.to_string())?;
        if !AreDpiAwarenessContextsEqual(
            GetWindowDpiAwarenessContext(self.overlay),
            GetWindowDpiAwarenessContext(parent),
        )
        .as_bool()
        {
            return Err("桌面与动画窗口的 DPI 模式不同，本机暂不能挂载动画层。".into());
        }
        let mut r = RECT::default();
        GetWindowRect(def, &mut r).map_err(|e| e.to_string())?;
        self.overlay_origin = Point {
            x: r.left,
            y: r.top,
        };
        let mut p = POINT {
            x: r.left,
            y: r.top,
        };
        if !ScreenToClient(parent, &mut p).as_bool() {
            return Err("无法定位桌面动画层".into());
        }
        let style = GetWindowLongPtrW(self.overlay, GWL_STYLE);
        SetWindowLongPtrW(
            self.overlay,
            GWL_STYLE,
            (style & !(WS_POPUP.0 as isize)) | WS_CHILD.0 as isize,
        );
        if GetParent(self.overlay).ok() != Some(parent) {
            SetParent(self.overlay, Some(parent))
                .map_err(|e| format!("无法挂载桌面动画层：{e}"))?;
        }
        // Tao enables WS_EX_LAYERED for cursor pass-through but does not call
        // either layered-window presentation API. Such an HWND can be visible
        // and have a populated WebView/CDP screenshot while presenting nothing
        // on the actual desktop. Initialize it after parenting, before the ack.
        let extended = GetWindowLongPtrW(self.overlay, GWL_EXSTYLE);
        SetWindowLongPtrW(
            self.overlay,
            GWL_EXSTYLE,
            extended | WS_EX_LAYERED.0 as isize | WS_EX_TRANSPARENT.0 as isize,
        );
        SetLayeredWindowAttributes(self.overlay, COLORREF(0), 255, LWA_ALPHA)
            .map_err(|e| format!("无法显示桌面动画层：{e}"))?;
        SetWindowPos(
            self.overlay,
            Some(HWND_TOP),
            p.x,
            p.y,
            r.right - r.left,
            r.bottom - r.top,
            SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
        .map_err(|e| format!("定位桌面动画窗口：{e}"))?;
        // A visible HWND is insufficient: WebView2 has an independent content
        // visibility flag. Keep Explorer visible until the canvas ack; RAFs
        // alone do not prove that Windows has presented this layered window.
        let webview: &tauri::Webview = win.as_ref();
        webview.show().map_err(|e| e.to_string())?;
        let _ = ShowWindowAsync(self.overlay, SW_SHOWNA);
        let _ = DwmFlush();
        Ok(())
    }
    fn send_scene(&self) -> Result<(), String> {
        let mut icons = self.snapshot["icons"]
            .as_array()
            .ok_or("桌面图标信息无效")?
            .clone();
        for icon in &mut icons {
            let id = icon["id"].as_str().unwrap().to_owned();
            let p = Point {
                x: icon["x"].as_i64().unwrap() as i32,
                y: icon["y"].as_i64().unwrap() as i32,
            };
            let home = self.journal.entries.get(&id).map(|e| e.home).unwrap_or(p);
            icon["home"] = json!(home);
            // A protected/unavailable item's native icon remains visible. It
            // must never enter the clipping set or abort other icons' animation.
            icon["pinned"] = json!(
                self.pinned.contains(&id) || icon["image"].as_str().is_none_or(str::is_empty)
            );
        }
        self.app.emit_to("icons-overlay","collision-scene",json!({"token":self.token,"icons":icons,"grid":self.snapshot["grid"],"iconSize":self.snapshot["iconSize"],"iconInsetX":self.snapshot["iconInsetX"],"iconOffsetY":(2.0*self.snapshot["iconSize"].as_f64().unwrap_or(55.0)/self.snapshot["logicalIconSize"].as_f64().unwrap_or(44.0)).round(),"origin":self.overlay_origin,"areas":self.areas,"boards":self.boards})).map_err(|e|e.to_string())
    }
    unsafe fn painted(&mut self, token: u64) -> Result<(), String> {
        if token != self.token || !self.active {
            return Ok(());
        }
        self.started = Instant::now();
        self.check_guard()?;
        let mut alpha = 0;
        let mut flags = LAYERED_WINDOW_ATTRIBUTES_FLAGS::default();
        GetLayeredWindowAttributes(self.overlay, None, Some(&mut alpha), Some(&mut flags))
            .map_err(|e| format!("动画层尚未初始化显示：{e}"))?;
        if alpha != 255 || flags.0 & LWA_ALPHA.0 == 0 || !IsWindowVisible(self.overlay).as_bool() {
            return Err("动画层无法显示，已保留原生桌面图标。".into());
        }
        if self.painted {
            if !icon_recovery::desktop_visible() {
                return Err("桌面图标已被用户隐藏，停止让位动画。".into());
            }
            return Ok(());
        }
        self.journal.was_visible = icon_recovery::desktop_visible();
        if !self.journal.was_visible {
            return Err("桌面图标已被隐藏，停止让位动画。".into());
        }
        // Persist the owner before any region change. Explorer keeps drawing all
        // unaffected icons and labels; only active original cells are clipped.
        let clip = crate::desktop_clip::ClipLease::prepare(
            desktop::def_view(),
            icon_recovery::now() as u64,
        )?;
        self.journal.clip = Some(clip.clone());
        self.journal.write(&self.root)?;
        clip.activate()?;
        let _ = ShowWindowAsync(self.overlay, SW_SHOWNA);
        self.painted = true;
        Ok(())
    }
    unsafe fn update_regions(&mut self, regions: Vec<HitRegion>) -> Result<(), String> {
        if !self.painted {
            return Ok(());
        }
        let icons = self.snapshot["icons"]
            .as_array()
            .ok_or("桌面图标快照不存在")?;
        let valid: HashSet<_> = icons.iter().filter_map(|i| i["id"].as_str()).collect();
        let regions: Vec<_> = regions
            .into_iter()
            .filter(|r| {
                r.active
                    && r.x.is_finite()
                    && r.y.is_finite()
                    && r.angle.is_finite()
                    && valid.contains(r.id.as_str())
            })
            .collect();
        let ids: HashSet<_> = regions.iter().map(|r| r.id.clone()).collect();
        if ids != self.clipped_ids {
            self.check_guard()?;
            let gx = self.snapshot["grid"]["x"].as_i64().unwrap_or(95) as i32;
            let gy = self.snapshot["grid"]["y"].as_i64().unwrap_or(122) as i32;
            let inset = self.snapshot["iconInsetX"].as_i64().unwrap_or(20) as i32;
            let cells: Vec<_> = icons
                .iter()
                .filter(|i| ids.contains(i["id"].as_str().unwrap_or("")))
                .map(|i| {
                    let x = i["x"].as_i64().unwrap_or(0) as i32 - inset;
                    let y = i["y"].as_i64().unwrap_or(0) as i32;
                    RECT {
                        left: x,
                        top: y,
                        right: x + gx,
                        bottom: y + gy,
                    }
                })
                .collect();
            self.journal
                .clip
                .as_ref()
                .ok_or("桌面局部绘制未就绪")?
                .apply(&cells)?;
            self.clipped_ids = ids;
        }
        self.regions = regions;
        Ok(())
    }
    unsafe fn commit(
        &mut self,
        token: u64,
        targets: BTreeMap<String, Point>,
    ) -> Result<(), String> {
        if token != self.token
            || !self.active
            || !self.painted
            || self.changed.elapsed() < Duration::from_millis(180)
        {
            return Ok(());
        }
        self.check_guard()?;
        let current = icon_recovery::points(&desktop::read()?);
        let base = icon_recovery::points(&self.snapshot);
        // A desktop edit during animation invalidates the entire pending frame.
        if current != base {
            return Err("桌面图标在动画期间发生变化，已停止本次让位。".into());
        }
        if current.len() != targets.len() || current.keys().any(|id| !targets.contains_key(id)) {
            return Err("动画帧与桌面图标不匹配".into());
        }
        let mut writes = BTreeMap::new();
        for (id, target) in targets {
            let p = current[&id];
            if target == p {
                continue;
            }
            let entry = self.journal.entries.entry(id.clone()).or_insert(Entry {
                home: p,
                last: p,
                pending: None,
            });
            entry.pending = Some(target);
            writes.insert(id, target);
        }
        self.journal.write(&self.root)?;
        self.check_guard()?;
        desktop::position(&writes)?;
        let actual = icon_recovery::points(&desktop::read()?);
        for (id, p) in &writes {
            if actual.get(id) != Some(p) {
                return Err("Explorer 未接受图标位置，已回退并保留恢复记录。".into());
            }
            if let Some(e) = self.journal.entries.get_mut(id) {
                e.last = *p;
                e.pending = None;
            }
        }
        self.journal.entries.retain(|_, e| e.last != e.home);
        if let Some(clip) = &self.journal.clip {
            clip.clear()?;
        }
        self.journal.clip = None;
        self.clipped_ids.clear();
        self.show_real();
        self.journal.hidden = false;
        self.journal.write(&self.root)?;
        self.snapshot = desktop::snapshot(Some(&mut self.cache))
            .map_err(|e| format!("回位后刷新桌面图标：{e}"))?;
        self.active = false;
        self.painted = false;
        self.last_poll = Instant::now();
        self.app
            .emit_to("icons-overlay", "collision-ended", json!({"token":token}))
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    unsafe fn show_real(&self) {
        if let Some(clip) = &self.journal.clip {
            let _ = clip.clear();
        }
        if self.journal.hidden && self.journal.was_visible {
            let def = desktop::def_view();
            let _ = ShowWindowAsync(def, SW_SHOWNA);
            for _ in 0..20 {
                if IsWindowVisible(def).as_bool() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = DwmFlush();
        }
        if !self.overlay.0.is_null() {
            let _ = ShowWindowAsync(self.overlay, SW_HIDE);
        }
    }
    unsafe fn desktop_click(&mut self) {
        let down = GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0;
        let pressed = down && !self.mouse_down;
        self.mouse_down = down;
        if !pressed {
            return;
        }
        let mut p = POINT::default();
        if GetCursorPos(&mut p).is_err() {
            return;
        }
        let root = GetAncestor(WindowFromPoint(p), GA_ROOT);
        let mut class = [0u16; 128];
        let len = GetClassNameW(root, &mut class);
        let name = String::from_utf16_lossy(&class[..len.max(0) as usize]);
        if name != "Progman" && name != "WorkerW" {
            self.click = None;
            return;
        }
        let size = self.snapshot["iconSize"].as_f64().unwrap_or(55.0);
        let grid = self.snapshot["grid"]["x"].as_f64().unwrap_or(95.0);
        let Some(region) = self
            .regions
            .iter()
            .rev()
            .find(|r| r.contains(p.x as f64, p.y as f64, size, grid))
        else {
            self.click = None;
            return;
        };
        let id = region.id.clone();
        if !self.snapshot["icons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["id"] == id)
        {
            return;
        }
        let double = self.click.as_ref().is_some_and(|(old, time, point)| {
            old == &id
                && time.elapsed().as_millis() <= GetDoubleClickTime() as u128
                && (point.x - p.x).abs() < 6
                && (point.y - p.y).abs() < 6
        });
        if double {
            self.click = None;
            if let Err(e) = desktop::open(&id) {
                let _ = self.app.emit("collision-error", e);
            }
        } else {
            self.click = Some((id, Instant::now(), p));
        }
    }
    unsafe fn restore(&mut self) -> Result<(), String> {
        self.show_real();
        self.active = false;
        self.painted = false;
        self.regions.clear();
        self.clipped_ids.clear();
        self.click = None;
        let _ = self.app.emit_to(
            "icons-overlay",
            "collision-ended",
            json!({"token":self.token}),
        );
        let result = icon_recovery::recover(&self.root, Some(&self.journal.token));
        self.journal = Journal::load(&self.root)?.unwrap_or_else(Journal::new);
        self.boards.clear();
        self.snapshot = Value::Null;
        if result.is_ok() {
            self.guard = None;
            self.lease = None;
        }
        result.map(|_| ())
    }
    fn disable(&mut self) -> Result<(), String> {
        let store = self.app.state::<BoardStore>();
        let mut doc = store.document.lock().map_err(|e| e.to_string())?;
        let mut next = doc.clone();
        for b in next["boards"].as_array_mut().unwrap() {
            b["collision"] = json!(false);
        }
        atomic_write(
            &store.root.join("board.json"),
            &serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?,
        )?;
        *doc = next;
        drop(doc);
        self.app
            .emit("collision-disabled", ())
            .map_err(|e| e.to_string())
    }
    fn record_error(&self, error: &str) {
        let _ = std::fs::write(
            self.root.join("collision-last-error.json"),
            serde_json::to_vec_pretty(
                &json!({"time":icon_recovery::now(),"error":error,"token":self.token}),
            )
            .unwrap_or_default(),
        );
    }
    unsafe fn fail(&mut self, error: String) {
        self.record_error(&error);
        self.suspended = true;
        let _ = self.restore();
        let _ = self.disable();
        let _ = self.app.emit("collision-error", error);
        self.boards.clear();
    }
}

#[derive(Clone, serde::Deserialize)]
pub struct HitRegion {
    id: String,
    x: f64,
    y: f64,
    angle: f64,
    active: bool,
}
impl HitRegion {
    fn contains(&self, x: f64, y: f64, size: f64, grid: f64) -> bool {
        if !self.x.is_finite() || !self.y.is_finite() || !self.angle.is_finite() {
            return false;
        }
        let dx = x - self.x - size / 2.0;
        let dy = y - self.y - size / 2.0;
        let local_x = dx * self.angle.cos() + dy * self.angle.sin();
        let local_y = -dx * self.angle.sin() + dy * self.angle.cos();
        (local_x.abs() <= size / 2.0 + 3.0 && local_y.abs() <= size / 2.0 + 3.0)
            || (!self.active
                && dx.abs() <= grid / 2.0
                && dy >= size / 2.0
                && dy < size / 2.0 + 50.0)
    }
}

pub async fn create_overlay(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("icons-overlay").is_some() {
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(
        &app,
        "icons-overlay",
        WebviewUrl::App("index.html?overlay=icons".into()),
    )
    .title("桌面图标动画")
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .inner_size(1.0, 1.0)
    .build()
    .map_err(|e| e.to_string())?;
    win.set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    let webview: &tauri::Webview = win.as_ref();
    webview.show().map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn collision_overlay_ready(app: AppHandle) -> Result<(), String> {
    app.state::<CollisionEngine>()
        .tx
        .send(Request::Ready)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn collision_painted(app: AppHandle, token: u64) -> Result<(), String> {
    app.state::<CollisionEngine>()
        .tx
        .send(Request::Painted(token))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn collision_hit_regions(
    app: AppHandle,
    token: u64,
    icons: Vec<HitRegion>,
) -> Result<(), String> {
    if icons.len() > 4096 {
        return Err("图标数量超限".into());
    }
    app.state::<CollisionEngine>()
        .tx
        .send(Request::Regions(token, icons))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn collision_settled(
    app: AppHandle,
    token: u64,
    targets: BTreeMap<String, Point>,
) -> Result<(), String> {
    app.state::<CollisionEngine>()
        .tx
        .send(Request::Settled(token, targets))
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn collision_failed(app: AppHandle, token: u64, message: String) -> Result<(), String> {
    app.state::<CollisionEngine>()
        .tx
        .send(Request::Failed(token, message))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::HitRegion;
    #[test]
    fn active_icon_hit_region_follows_rotation_and_excludes_its_label() {
        let r = HitRegion {
            id: "test".into(),
            x: 100.0,
            y: 100.0,
            angle: std::f64::consts::FRAC_PI_4,
            active: true,
        };
        assert!(r.contains(120.0, 120.0, 40.0, 95.0));
        assert!(r.contains(145.0, 120.0, 40.0, 95.0));
        assert!(!r.contains(120.0, 155.0, 40.0, 95.0));
        assert!(!r.contains(100.0, 100.0, 40.0, 95.0));
    }
    #[test]
    fn unaffected_icon_accepts_its_label_and_rejects_invalid_coordinates() {
        let mut r = HitRegion {
            id: "test".into(),
            x: 100.0,
            y: 100.0,
            angle: 0.0,
            active: false,
        };
        assert!(r.contains(120.0, 155.0, 40.0, 95.0));
        r.x = f64::NAN;
        assert!(!r.contains(120.0, 120.0, 40.0, 95.0));
    }
}
#[tauri::command]
pub async fn set_collision(app: AppHandle, label: String, enabled: bool) -> Result<(), String> {
    if enabled {
        let a = app.clone();
        tauri::async_runtime::spawn_blocking(move || a.state::<CollisionEngine>().request(None))
            .await
            .map_err(|e| e.to_string())??;
    }
    let id = label.strip_prefix("board-").unwrap_or(&label);
    let store = app.state::<BoardStore>();
    let mut doc = store.document.lock().map_err(|e| e.to_string())?;
    let mut next = doc.clone();
    let board = next["boards"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|b| b["id"] == id)
        .ok_or("板子不存在")?;
    board["collision"] = json!(enabled);
    atomic_write(
        &store.root.join("board.json"),
        &serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?,
    )?;
    *doc = next;
    Ok(())
}
#[tauri::command]
pub async fn restore_icons(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<CollisionEngine>().request(Some(true)))
        .await
        .map_err(|e| e.to_string())?
}
