//! Native edge docking. Expanded coordinates are authoritative; transient slide
//! coordinates never become document bounds. Regions keep adjacent monitors clear.
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::{
    Foundation::{HWND, POINT, RECT},
    Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, GetMonitorInfoW, MonitorFromRect, SetWindowRgn,
        HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST, RGN_ERROR, RGN_OR,
    },
    UI::{
        HiDpi::GetDpiForWindow,
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON},
        WindowsAndMessaging::{
            GetAncestor, GetCursorPos, GetWindowRect, IsWindow, IsWindowVisible, SetWindowPos,
            WindowFromPoint, GA_ROOT, SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER,
        },
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}
impl Rect {
    fn contains(self, p: POINT) -> bool {
        p.x >= self.x && p.x < self.x + self.w && p.y >= self.y && p.y < self.y + self.h
    }
    pub fn intersection(self, other: Self) -> Self {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        Self {
            x,
            y,
            w: (self.x + self.w)
                .min(other.x + other.w)
                .saturating_sub(x)
                .max(0),
            h: (self.y + self.h)
                .min(other.y + other.h)
                .saturating_sub(y)
                .max(0),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Dock {
    edge: Edge,
    area: Rect,
    open: Rect,
    closed: Rect,
    layout: BookmarkLayout,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BookmarkLayout {
    pub w: i32,
    pub h: i32,
    pub gutter: i32,
}
impl Default for BookmarkLayout {
    fn default() -> Self {
        Self::for_style(None)
    }
}
impl BookmarkLayout {
    pub fn for_style(style: Option<&str>) -> Self {
        if matches!(style, Some("whale" | "knot")) {
            Self {
                w: 66,
                h: 90,
                gutter: 50,
            }
        } else {
            Self {
                w: 44,
                h: 60,
                gutter: 28,
            }
        }
    }
}
fn resized_layout(r: Rect, scale: f64, old: BookmarkLayout, new: BookmarkLayout) -> Rect {
    let delta = (((8 + new.gutter) as f64 * scale).round()
        - ((8 + old.gutter) as f64 * scale).round()) as i32;
    Rect {
        x: r.x - delta,
        w: r.w + delta,
        ..r
    }
}
#[cfg(test)]
fn dock(r: Rect, area: Rect, scale: f64) -> Option<Dock> {
    dock_with_layout(r, area, scale, BookmarkLayout::default())
}
fn dock_with_layout(r: Rect, area: Rect, scale: f64, layout: BookmarkLayout) -> Option<Dock> {
    // Crossing an edge must always dock, even far beyond the proximity range.
    // At corners prefer the side with the greatest overflow. Near-edge snapping
    // inside the work area remains available on axes that can fit the window.
    let threshold = (16.0 * scale).round() as i32;
    let (bookmark_w, bookmark_h, _) = bookmark_size(scale, layout);
    let mut candidates = Vec::new();
    if r.w <= area.w {
        candidates.push(((r.x - area.x).abs(), Edge::Left));
        candidates.push(((r.x + r.w - area.x - area.w).abs(), Edge::Right));
    }
    if r.h <= area.h {
        candidates.push(((r.y - area.y).abs(), Edge::Top));
        candidates.push(((r.y + r.h - area.y - area.h).abs(), Edge::Bottom));
    }
    let crossed = [
        (area.x - r.x, Edge::Left),
        (r.x + r.w - area.x - area.w, Edge::Right),
        (area.y - r.y, Edge::Top),
        (r.y + r.h - area.y - area.h, Edge::Bottom),
    ]
    .into_iter()
    .filter(|c| c.0 > 0)
    .max_by_key(|c| c.0);
    let edge = if let Some((_, edge)) = crossed {
        edge
    } else {
        let (distance, edge) = candidates.into_iter().min_by_key(|c| c.0)?;
        if distance > threshold {
            return None;
        }
        edge
    };
    let mut open = r;
    match edge {
        Edge::Left | Edge::Right => {
            open.x = if edge == Edge::Left {
                area.x
            } else {
                area.x + area.w - r.w
            };
            open.y = open.y.clamp(area.y, area.y + (area.h - r.h).max(0));
        }
        Edge::Top | Edge::Bottom => {
            open.y = if edge == Edge::Top {
                area.y
            } else {
                area.y + area.h - r.h
            };
            open.x = open.x.clamp(area.x, area.x + (area.w - r.w).max(0));
        }
    }
    // Only clamp the perpendicular coordinate; an oversized window must keep its
    // selected edge aligned instead of being moved back to the opposite edge.
    let mut closed = open;
    match edge {
        Edge::Left => closed.x = area.x - r.w + bookmark_w,
        Edge::Right => closed.x = area.x + area.w - bookmark_w,
        Edge::Top => closed.y = area.y - r.h + bookmark_h,
        Edge::Bottom => closed.y = area.y + area.h - bookmark_h,
    }
    Some(Dock {
        edge,
        area,
        open,
        closed,
        layout,
    })
}
// Shared with bookmarkMetrics, CSS variables and the 12px inset in App.css.
fn bookmark_size(scale: f64, layout: BookmarkLayout) -> (i32, i32, i32) {
    (
        (layout.w as f64 * scale).round() as i32,
        (layout.h as f64 * scale).round() as i32,
        (12.0 * scale).round() as i32,
    )
}
fn bookmark_rect(d: Dock, r: Rect, scale: f64) -> Rect {
    let (w, h, inset) = bookmark_size(scale, d.layout);
    let (x, y) = match d.edge {
        Edge::Left => (r.w - w, inset),
        Edge::Right => (0, inset),
        Edge::Top => (inset, r.h - h),
        Edge::Bottom => (inset, 0),
    };
    Rect {
        x: r.x + x,
        y: r.y + y,
        w,
        h,
    }
    .intersection(d.area)
}
fn slide(d: Dock, amount: f64) -> Rect {
    Rect {
        x: (d.open.x as f64 + (d.closed.x - d.open.x) as f64 * amount).round() as i32,
        y: (d.open.y as f64 + (d.closed.y - d.open.y) as f64 * amount).round() as i32,
        ..d.open
    }
}

struct Entry {
    hwnd: usize,
    layout: BookmarkLayout,
    // The controller retains ownership of clipping for this native window even
    // after a completed slide; a WebView reload must clear a stale region too.
    used_region: bool,
    full_region_size: Option<(i32, i32, u32)>,
    enabled: bool,
    blocked: bool,
    dock: Option<Dock>,
    last: Option<Rect>,
    amount: f64,
    hidden: bool,
    outside: Option<Instant>,
    hold_until: Instant,
}
#[derive(Default, Clone)]
pub struct EdgeHide(Arc<Mutex<HashMap<String, Entry>>>);
impl EdgeHide {
    pub fn start(app: AppHandle) -> Self {
        let engine = Self::default();
        let state = engine.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(16));
            let mut entries = match state.0.lock() {
                Ok(e) => e,
                Err(_) => break,
            };
            let mut cursor = POINT::default();
            if unsafe { GetCursorPos(&mut cursor) }.is_err() {
                continue;
            }
            let pressed = unsafe {
                GetAsyncKeyState(VK_LBUTTON.0 as i32) < 0
                    || GetAsyncKeyState(VK_RBUTTON.0 as i32) < 0
            };
            entries.retain(|label, e| {
                let hwnd = HWND(e.hwnd as *mut _);
                if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
                    return false;
                }
                if let Err(err) = unsafe { e.tick(&app, label, cursor, pressed) } {
                    let _ = unsafe { e.restore(&app, label) };
                    e.enabled = false;
                    let _ = app.emit_to(label, "edge-hide-error", err);
                }
                true
            });
        });
        engine
    }
    pub fn configure(
        &self,
        app: &AppHandle,
        label: &str,
        enabled: bool,
        blocked: bool,
        style: Option<&str>,
    ) -> Result<(), String> {
        let win = app.get_webview_window(label).ok_or("窗口不存在")?;
        let hwnd = win.hwnd().map_err(|e| e.to_string())?.0 as usize;
        let mut entries = self.0.lock().map_err(|e| e.to_string())?;
        let e = entries.entry(label.into()).or_insert_with(|| Entry {
            hwnd,
            layout: BookmarkLayout::for_style(style),
            used_region: false,
            full_region_size: None,
            enabled,
            blocked,
            dock: None,
            last: None,
            amount: 0.0,
            hidden: false,
            outside: None,
            hold_until: Instant::now(),
        });
        // Recreated windows with the same label must not inherit a previous slide.
        if e.hwnd != hwnd {
            e.used_region = false;
            e.full_region_size = None;
            e.dock = None;
            e.last = None;
            e.amount = 0.0;
            e.hidden = false;
            e.outside = None;
            e.hold_until = Instant::now();
        }
        e.hwnd = hwnd;
        e.enabled = enabled;
        e.blocked = blocked;
        if let Some(style) = style {
            let next = BookmarkLayout::for_style(Some(style));
            if next != e.layout {
                unsafe {
                    e.restore(app, label)?;
                }
                e.layout = next;
                unsafe {
                    e.full_region()?;
                }
            }
        }
        // Transparent CSS margins are still native resize targets unless they
        // are excluded from the HWND region, even before docking is enabled.
        if !e.used_region {
            crate::native_chrome::install(&win, hwnd)?;
            unsafe {
                e.full_region()?;
            }
        }
        if !enabled || blocked {
            unsafe {
                e.restore(app, label)?;
            }
        }
        Ok(())
    }
    pub fn resize_for_style(
        &self,
        app: &AppHandle,
        label: &str,
        style: &str,
    ) -> Result<Rect, String> {
        let mut entries = self.0.lock().map_err(|e| e.to_string())?;
        let e = entries.get_mut(label).ok_or("书签窗口尚未就绪")?;
        unsafe {
            e.restore(app, label)?;
            let hwnd = HWND(e.hwnd as *mut _);
            let scale = GetDpiForWindow(hwnd).max(96) as f64 / 96.0;
            let next = BookmarkLayout::for_style(Some(style));
            let r = resized_layout(e.rect()?, scale, e.layout, next);
            SetWindowPos(
                hwnd,
                None,
                r.x,
                r.y,
                r.w,
                r.h,
                SWP_NOACTIVATE | SWP_NOZORDER,
            )
            .map_err(|err| err.to_string())?;
            e.layout = next;
            e.blocked = true;
            e.full_region()?;
            let actual = e.rect()?;
            e.last = Some(actual);
            Ok(actual)
        }
    }
    pub fn reveal(&self, app: &AppHandle, label: &str) -> Result<(), String> {
        if let Some(e) = self.0.lock().map_err(|e| e.to_string())?.get_mut(label) {
            unsafe {
                e.restore(app, label)?;
            }
            e.hold_until = Instant::now();
        }
        Ok(())
    }
    pub fn expanded(&self, label: &str) -> Option<Rect> {
        let entries = self.0.lock().ok()?;
        let e = entries.get(label)?;
        // External moves/resizes may precede the next polling tick.
        if unsafe { e.rect().ok() } != e.last {
            return None;
        }
        e.dock.map(|d| d.open)
    }
    pub fn clip_area(&self, label: &str) -> Option<Rect> {
        let entries = self.0.lock().ok()?;
        let e = entries.get(label)?;
        if e.amount > 0.0 {
            e.dock.map(|d| d.area)
        } else {
            None
        }
    }
    pub fn paper_hidden(&self, label: &str) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|entries| entries.get(label).map(|e| e.hidden))
            .unwrap_or(false)
    }
}
impl Entry {
    unsafe fn full_region(&mut self) -> Result<(), String> {
        let r = self.rect()?;
        let dpi = GetDpiForWindow(HWND(self.hwnd as *mut _)).max(96);
        let scale = dpi as f64 / 96.0;
        let px = |n: f64| (n * scale).round() as i32;
        // App.css: body padding 8px, board-shell left padding 28px;
        // the bookmark is fixed at (0,12), 44x60 CSS pixels. Only the
        // actual paper and bookmark receive native input, not their gutter.
        let region = CreateRectRgn(
            px((8 + self.layout.gutter) as f64),
            px(8.0),
            r.w - px(8.0),
            r.h - px(8.0),
        );
        if region.0.is_null() {
            return Err("无法创建板子可见区域".into());
        }
        let bookmark = CreateRectRgn(
            0,
            px(12.0),
            px(self.layout.w as f64),
            px((12 + self.layout.h) as f64),
        );
        if bookmark.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return Err("无法创建书签可见区域".into());
        }
        let combined = CombineRgn(Some(region), Some(region), Some(bookmark), RGN_OR);
        let _ = DeleteObject(HGDIOBJ(bookmark.0));
        if combined == RGN_ERROR {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return Err("无法合并板子与书签区域".into());
        }
        if SetWindowRgn(HWND(self.hwnd as *mut _), Some(region), true) == 0 {
            let _ = DeleteObject(HGDIOBJ(region.0));
            return Err("无法恢复板子可见区域".into());
        }
        self.used_region = true;
        self.full_region_size = Some((r.w, r.h, dpi));
        Ok(())
    }
    unsafe fn rect(&self) -> Result<Rect, String> {
        let mut r = RECT::default();
        GetWindowRect(HWND(self.hwnd as *mut _), &mut r).map_err(|e| e.to_string())?;
        Ok(Rect {
            x: r.left,
            y: r.top,
            w: r.right - r.left,
            h: r.bottom - r.top,
        })
    }
    unsafe fn move_to(&mut self, r: Rect, area: Option<Rect>) -> Result<(), String> {
        let hwnd = HWND(self.hwnd as *mut _);
        if let Some(area) = area {
            self.used_region = true;
            let c = r.intersection(area);
            let region = CreateRectRgn(c.x - r.x, c.y - r.y, c.x - r.x + c.w, c.y - r.y + c.h);
            if region.0.is_null() {
                return Err("无法创建贴边可见区域".into());
            }
            if SetWindowRgn(hwnd, Some(region), true) == 0 {
                let _ = DeleteObject(HGDIOBJ(region.0));
                return Err("无法设置贴边可见区域".into());
            }
        }
        SetWindowPos(
            hwnd,
            None,
            r.x,
            r.y,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
        )
        .map_err(|e| e.to_string())?;
        // Explicitly restore the paper/bookmark shape after moving. On this Windows
        // desktop SetWindowRgn(NULL) can report success yet retain the strip.
        if area.is_none() {
            self.full_region()?;
        }
        self.last = Some(r);
        Ok(())
    }
    unsafe fn restore(&mut self, app: &AppHandle, label: &str) -> Result<(), String> {
        if let Some(d) = self.dock {
            let current = self.rect()?;
            // An external drag/resize owns its new geometry; don't jump it back.
            if self.last == Some(current) {
                self.move_to(d.open, None)?;
            } else {
                self.full_region()?;
            }
        }
        // Restore also runs when the frontend reconnects with docking disabled.
        // Its native resize/reposition sequence can outlive an earlier slide.
        if self.used_region {
            self.full_region()?;
        }
        self.dock = None;
        self.amount = 0.0;
        self.outside = None;
        if self.hidden {
            self.hidden = false;
            let _ = app.emit_to(
                label,
                "edge-hide-state",
                serde_json::json!({"hidden":false,"edge":null}),
            );
        }
        Ok(())
    }
    unsafe fn tick(
        &mut self,
        app: &AppHandle,
        label: &str,
        cursor: POINT,
        pressed: bool,
    ) -> Result<(), String> {
        // An explicit full region also needs to follow subsequent manual sizing
        // when auto hiding is switched off.
        if self.used_region && self.amount == 0.0 {
            let r = self.rect()?;
            let dpi = GetDpiForWindow(HWND(self.hwnd as *mut _)).max(96);
            if self.full_region_size != Some((r.w, r.h, dpi)) {
                self.full_region()?;
            }
        }
        if !self.enabled || self.blocked {
            return Ok(());
        }
        let hwnd = HWND(self.hwnd as *mut _);
        if !IsWindowVisible(hwnd).as_bool() {
            if self.dock.is_some() || self.hidden {
                self.restore(app, label)?;
            }
            return Ok(());
        }
        let current = self.rect()?;
        if self.dock.is_some() && self.last != Some(current) {
            self.restore(app, label)?;
            self.hold_until = Instant::now();
            return Ok(());
        }
        let scale = GetDpiForWindow(hwnd).max(96) as f64 / 96.0;
        let anchor = self.dock.map(|d| d.open).unwrap_or(current);
        let r = RECT {
            left: anchor.x,
            top: anchor.y,
            right: anchor.x + anchor.w,
            bottom: anchor.y + anchor.h,
        };
        let monitor = MonitorFromRect(&r, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("无法读取显示器工作区域".into());
        }
        let a = info.rcWork;
        let area = Rect {
            x: a.left,
            y: a.top,
            w: a.right - a.left,
            h: a.bottom - a.top,
        };
        if self.dock.is_some_and(|d| d.area != area) {
            self.restore(app, label)?;
            return Ok(());
        }
        let d = match self
            .dock
            .or_else(|| dock_with_layout(current, area, scale, self.layout))
        {
            Some(d) => d,
            None => {
                self.outside = None;
                return Ok(());
            }
        };
        // Geometry plus native hit testing prevents opening through another app.
        let visible = current.intersection(area);
        let under_cursor = GetAncestor(WindowFromPoint(cursor), GA_ROOT);
        let hovered = visible.contains(cursor) && under_cursor == hwnd;
        let now = Instant::now();
        // A hidden bookmark is click-only. Merely hovering must not unfold it.
        let should_open = (!self.hidden && (hovered || pressed)) || now < self.hold_until;
        if should_open {
            self.outside = None;
        } else {
            self.outside.get_or_insert(now);
        }
        let hide = !should_open
            && self
                .outside
                .is_some_and(|t| now.duration_since(t) >= Duration::from_millis(1000));
        // During the leave delay keep the currently expanded/hidden state.
        let target = if should_open {
            0.0
        } else if hide {
            1.0
        } else {
            self.amount
        };
        if target > 0.0 && !self.hidden {
            self.hidden = true;
            let _ = app.emit_to(
                label,
                "edge-hide-state",
                serde_json::json!({"hidden":true,"edge":d.edge}),
            );
        }
        // Snap to the work-area boundary after the mouse is released, even
        // during the one-second leave delay. Native dragging avoids Aero Snap.
        if self.amount == 0.0 && !pressed && current != d.open {
            self.dock = Some(d);
            self.move_to(d.open, None)?;
        }
        if target == self.amount {
            return Ok(());
        }
        self.dock = Some(d);
        self.amount = if target > self.amount {
            (self.amount + 16.0 / 180.0).min(1.0)
        } else {
            (self.amount - 16.0 / 180.0).max(0.0)
        };
        let eased = self.amount * self.amount * (3.0 - 2.0 * self.amount);
        let r = slide(d, eased);
        self.move_to(
            r,
            if self.amount == 1.0 {
                Some(bookmark_rect(d, r, scale))
            } else if self.amount > 0.0 {
                Some(area)
            } else {
                None
            },
        )?;
        if self.amount == 0.0 {
            self.restore(app, label)?;
        }
        Ok(())
    }
}

#[tauri::command]
pub async fn edge_hide_activity(
    app: AppHandle,
    label: String,
    enabled: bool,
    blocked: bool,
    style: Option<String>,
) -> Result<(), String> {
    app.state::<EdgeHide>()
        .configure(&app, &label, enabled, blocked, style.as_deref())
}
#[tauri::command]
pub async fn reveal_edge_board(app: AppHandle, label: String) -> Result<(), String> {
    app.state::<EdgeHide>().reveal(&app, &label)
}
#[tauri::command]
pub async fn expanded_board_position(
    app: AppHandle,
    label: String,
) -> Result<serde_json::Value, String> {
    let engine = app.state::<EdgeHide>();
    if let Some(r) = engine.expanded(&label) {
        return Ok(serde_json::json!({"x":r.x,"y":r.y}));
    }
    let win = app.get_webview_window(&label).ok_or("窗口不存在")?;
    let p = win.outer_position().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({"x":p.x,"y":p.y}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_bookmark_layout_preserves_paper_and_docks_all_sides() {
        let small = BookmarkLayout::default();
        let large = BookmarkLayout::for_style(Some("whale"));
        assert_eq!(large, BookmarkLayout::for_style(Some("knot")));
        let r = Rect {
            x: 300,
            y: 200,
            w: 560,
            h: 660,
        };
        for scale in [1.0, 1.2, 1.25, 1.5, 1.75, 2.0] {
            let grown = resized_layout(r, scale, small, large);
            let inset = |l: BookmarkLayout| ((8 + l.gutter) as f64 * scale).round() as i32;
            assert_eq!(grown.x + inset(large), r.x + inset(small));
            assert_eq!(grown.w - inset(large), r.w - inset(small));
            assert_eq!(resized_layout(grown, scale, large, small), r);
            let area = Rect {
                x: 0,
                y: 0,
                w: 1920,
                h: 1080,
            };
            for edge in [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom] {
                let mut at = grown;
                match edge {
                    Edge::Left => at.x = -1,
                    Edge::Right => at.x = 1921 - at.w,
                    Edge::Top => at.y = -1,
                    Edge::Bottom => at.y = 1081 - at.h,
                }
                let d = dock_with_layout(at, area, scale, large).unwrap();
                assert_eq!(d.edge, edge);
                let bookmark = bookmark_rect(d, d.closed, scale);
                assert_eq!(
                    (bookmark.w, bookmark.h),
                    ((66.0 * scale).round() as i32, (90.0 * scale).round() as i32)
                );
                assert_eq!(bookmark.intersection(area), bookmark);
            }
        }
    }
    #[test]
    fn docks_four_sides_and_keeps_only_a_scaled_bookmark() {
        let area = Rect {
            x: 0,
            y: 40,
            w: 1920,
            h: 1000,
        };
        for (r, edge) in [
            (
                Rect {
                    x: 8,
                    y: 200,
                    w: 560,
                    h: 660,
                },
                Edge::Left,
            ),
            (
                Rect {
                    x: 1352,
                    y: 200,
                    w: 560,
                    h: 660,
                },
                Edge::Right,
            ),
            (
                Rect {
                    x: 300,
                    y: 44,
                    w: 560,
                    h: 660,
                },
                Edge::Top,
            ),
            (
                Rect {
                    x: 300,
                    y: 374,
                    w: 560,
                    h: 660,
                },
                Edge::Bottom,
            ),
        ] {
            let d = dock(r, area, 1.25).unwrap();
            assert_eq!(d.edge, edge);
            let shown = d.closed.intersection(area);
            assert_eq!(
                if matches!(edge, Edge::Left | Edge::Right) {
                    shown.w
                } else {
                    shown.h
                },
                if matches!(edge, Edge::Left | Edge::Right) {
                    55
                } else {
                    75
                }
            );
            let bookmark = bookmark_rect(d, d.closed, 1.25);
            assert_eq!((bookmark.w, bookmark.h), (55, 75));
            assert_eq!(bookmark.intersection(area), bookmark);
            assert_eq!(slide(d, 0.0), d.open);
            assert_eq!(slide(d, 1.0), d.closed);
        }
    }
    #[test]
    fn negative_origins_and_inside_corners() {
        let area = Rect {
            x: -1920,
            y: -100,
            w: 1920,
            h: 1040,
        };
        let d = dock(
            Rect {
                x: -1918,
                y: -98,
                w: 500,
                h: 600,
            },
            area,
            1.0,
        )
        .unwrap();
        assert_eq!(d.edge, Edge::Left);
        assert_eq!(d.open.x, -1920);
        assert_eq!(d.closed.intersection(area).w, 44);
        assert!(dock(
            Rect {
                x: -1500,
                y: 80,
                w: 500,
                h: 600
            },
            area,
            1.0
        )
        .is_none());
    }
    #[test]
    fn every_crossed_side_docks_without_distance_limit() {
        let area = Rect {
            x: 0,
            y: 40,
            w: 1920,
            h: 1000,
        };
        for depth in [1, 21, 424, 1000] {
            for edge in [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom] {
                let mut r = Rect {
                    x: 300,
                    y: 200,
                    w: 560,
                    h: 660,
                };
                match edge {
                    Edge::Left => r.x = area.x - depth,
                    Edge::Right => r.x = area.x + area.w - r.w + depth,
                    Edge::Top => r.y = area.y - depth,
                    Edge::Bottom => r.y = area.y + area.h - r.h + depth,
                }
                let d = dock(r, area, 1.25).unwrap();
                assert_eq!(d.edge, edge);
                match edge {
                    Edge::Left => assert_eq!(d.open.x, area.x),
                    Edge::Right => assert_eq!(d.open.x + r.w, area.x + area.w),
                    Edge::Top => assert_eq!(d.open.y, area.y),
                    Edge::Bottom => assert_eq!(d.open.y + r.h, area.y + area.h),
                }
                let bookmark = bookmark_rect(d, d.closed, 1.25);
                assert_eq!((bookmark.w, bookmark.h), (55, 75));
                assert_eq!(bookmark.intersection(area), bookmark);
            }
        }
    }
    #[test]
    fn crossed_corners_prefer_overflow_over_proximity_and_choose_deepest_side() {
        let area = Rect {
            x: -1920,
            y: -100,
            w: 1920,
            h: 1040,
        };
        for (r, edge) in [
            (
                Rect {
                    x: -2120,
                    y: -99,
                    w: 560,
                    h: 660,
                },
                Edge::Left,
            ),
            (
                Rect {
                    x: -136,
                    y: -101,
                    w: 560,
                    h: 660,
                },
                Edge::Right,
            ),
            (
                Rect {
                    x: -1970,
                    y: -200,
                    w: 560,
                    h: 660,
                },
                Edge::Top,
            ),
            (
                Rect {
                    x: -1460,
                    y: 430,
                    w: 560,
                    h: 660,
                },
                Edge::Bottom,
            ),
        ] {
            assert_eq!(dock(r, area, 1.25).unwrap().edge, edge);
        }
    }
    #[test]
    fn oversized_windows_keep_selected_edge_aligned_and_bookmark_accessible() {
        let area = Rect {
            x: -1920,
            y: -100,
            w: 1920,
            h: 1040,
        };
        for (r, edge) in [
            (
                Rect {
                    x: -1918,
                    y: 80,
                    w: 2200,
                    h: 600,
                },
                Edge::Right,
            ),
            (
                Rect {
                    x: -2100,
                    y: 80,
                    w: 2000,
                    h: 600,
                },
                Edge::Left,
            ),
            (
                Rect {
                    x: -1800,
                    y: -400,
                    w: 500,
                    h: 1200,
                },
                Edge::Top,
            ),
            (
                Rect {
                    x: -1800,
                    y: 80,
                    w: 500,
                    h: 1200,
                },
                Edge::Bottom,
            ),
        ] {
            let d = dock(r, area, 1.25).unwrap();
            assert_eq!(d.edge, edge);
            let bookmark = bookmark_rect(d, d.closed, 1.25);
            assert_eq!((bookmark.w, bookmark.h), (55, 75));
            match edge {
                Edge::Left => assert_eq!(d.open.x, area.x),
                Edge::Right => assert_eq!(d.open.x + r.w, area.x + area.w),
                Edge::Top => assert_eq!(d.open.y, area.y),
                Edge::Bottom => assert_eq!(d.open.y + r.h, area.y + area.h),
            }
        }
    }
}
