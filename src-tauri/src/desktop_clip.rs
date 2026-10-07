//! Keep Explorer drawing untouched items. Only active items' original cells are
//! excluded from its drawing region. A durable lease lets the guard clear it.
use serde::{Deserialize, Serialize};
use windows::{
    core::w,
    Win32::{
        Foundation::{HANDLE, HWND, RECT},
        Graphics::Gdi::{
            CombineRgn, CreateRectRgn, DeleteObject, GetWindowRgn, SetWindowRgn, HGDIOBJ, HRGN,
            RGN_DIFF, RGN_ERROR,
        },
        UI::WindowsAndMessaging::{
            GetClassNameW, GetPropW, GetWindowRect, IsWindow, RemovePropW, SetPropW,
        },
    },
};

const PROPERTY: windows::core::PCWSTR = w!("DesktopBoard.IconClip.Owner");
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClipLease {
    pub hwnd: u64,
    pub owner: u64,
}
struct Region(HRGN);
impl Drop for Region {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0 .0));
        }
    }
}
impl Region {
    unsafe fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Result<Self, String> {
        let region = CreateRectRgn(left, top, right, bottom);
        if region.0.is_null() {
            Err("无法创建桌面绘制区域".into())
        } else {
            Ok(Self(region))
        }
    }
}
impl ClipLease {
    pub unsafe fn prepare(hwnd: HWND, owner: u64) -> Result<Self, String> {
        let region = Region::rect(0, 0, 0, 0)?;
        if !GetPropW(hwnd, PROPERTY).0.is_null() || GetWindowRgn(hwnd, region.0) != RGN_ERROR {
            return Err("桌面已有自定义绘制区域，暂不能启用局部让位。".into());
        }
        Ok(Self {
            hwnd: hwnd.0 as u64,
            owner,
        })
    }
    fn window(&self) -> HWND {
        HWND(self.hwnd as usize as *mut std::ffi::c_void)
    }
    pub unsafe fn activate(&self) -> Result<(), String> {
        SetPropW(
            self.window(),
            PROPERTY,
            Some(HANDLE(self.owner as usize as *mut std::ffi::c_void)),
        )
        .map_err(|e| format!("登记桌面局部绘制管理权：{e}"))
    }
    pub unsafe fn apply(&self, cells: &[RECT]) -> Result<(), String> {
        let hwnd = self.window();
        if GetPropW(hwnd, PROPERTY).0 as u64 != self.owner {
            return Err("桌面局部绘制的管理权已改变".into());
        }
        if cells.is_empty() {
            if SetWindowRgn(hwnd, None, true) == 0 {
                return Err("无法恢复桌面绘制区域".into());
            }
            return Ok(());
        }
        let mut rect = RECT::default();
        GetWindowRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
        let region = Region::rect(0, 0, rect.right - rect.left, rect.bottom - rect.top)?;
        for cell in cells {
            let hole = Region::rect(
                cell.left - rect.left,
                cell.top - rect.top,
                cell.right - rect.left,
                cell.bottom - rect.top,
            )?;
            if CombineRgn(Some(region.0), Some(region.0), Some(hole.0), RGN_DIFF) == RGN_ERROR {
                return Err("无法裁剪图标原位区域".into());
            }
        }
        if SetWindowRgn(hwnd, Some(region.0), true) == 0 {
            return Err("无法应用桌面局部绘制区域".into());
        }
        // Successful SetWindowRgn transfers ownership to Windows.
        std::mem::forget(region);
        Ok(())
    }
    pub unsafe fn clear(&self) -> Result<(), String> {
        let hwnd = self.window();
        if !IsWindow(Some(hwnd)).as_bool() {
            return Ok(());
        }
        let mut class = [0u16; 128];
        let length = GetClassNameW(hwnd, &mut class);
        if String::from_utf16_lossy(&class[..length.max(0) as usize]) != "SHELLDLL_DefView" {
            return Ok(());
        }
        // Explorer may have restarted or another session now owns its region.
        if GetPropW(hwnd, PROPERTY).0 as u64 != self.owner {
            return Ok(());
        }
        if SetWindowRgn(hwnd, None, true) == 0 {
            return Err("无法撤销桌面局部绘制区域".into());
        }
        RemovePropW(hwnd, PROPERTY).map_err(|e| format!("释放桌面局部绘制管理权：{e}"))?;
        Ok(())
    }
}
