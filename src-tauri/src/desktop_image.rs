//! Copy base icons from read-only Shell image lists. Never request or configure
//! overlays, thumbnails, shortcut targets, or Explorer's image-list contents.
use base64::Engine;
use std::mem::size_of;
use windows::{
    core::{HSTRING, PCWSTR},
    Win32::{
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, HGDIOBJ,
        },
        Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
        System::Com::CoTaskMemFree,
        UI::{
            Controls::IImageList,
            Shell::{
                SHGetFileInfoW, SHGetImageList, SHParseDisplayName, SHFILEINFOW, SHGFI_PIDL,
                SHGFI_SYSICONINDEX, SHIL_EXTRALARGE, SHIL_JUMBO, SHIL_LARGE, SHIL_SMALL,
            },
            WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON},
        },
    },
};

struct Icon(HICON);
impl Drop for Icon {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyIcon(self.0);
        }
    }
}
struct Surface {
    dc: HDC,
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    old: HGDIOBJ,
    bits: *mut u8,
    len: usize,
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.dc, self.old);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}
impl Surface {
    unsafe fn new(size: i32) -> Result<Self, String> {
        let dc = CreateCompatibleDC(None);
        if dc.0.is_null() {
            return Err("无法创建图标绘制上下文".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: size,
                biHeight: -size,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(e) => {
                let _ = DeleteDC(dc);
                return Err(e.to_string());
            }
        };
        let old = SelectObject(dc, HGDIOBJ(bitmap.0));
        Ok(Self {
            dc,
            bitmap,
            old,
            bits: bits.cast(),
            len: size as usize * size as usize * 4,
        })
    }
    unsafe fn draw(&self, icon: HICON, size: i32, background: u8) -> Result<Vec<u8>, String> {
        std::ptr::write_bytes(self.bits, background, self.len);
        DrawIconEx(self.dc, 0, 0, icon, size, size, 0, None, DI_NORMAL)
            .map_err(|e| e.to_string())?;
        // GDI drawing may be batched before direct DIB access.
        let _ = windows::Win32::Graphics::Gdi::GdiFlush();
        Ok(std::slice::from_raw_parts(self.bits, self.len).to_vec())
    }
}

pub unsafe fn read_pair(id: &str, size: i32) -> Result<(String, String), String> {
    let mut pidl = std::ptr::null_mut();
    SHParseDisplayName(&HSTRING::from(id), None, &mut pidl, 0, None).map_err(|e| e.to_string())?;
    let mut info = SHFILEINFOW::default();
    let found = SHGetFileInfoW(
        PCWSTR(pidl.cast()),
        FILE_FLAGS_AND_ATTRIBUTES(0),
        Some(&mut info),
        size_of::<SHFILEINFOW>() as u32,
        SHGFI_PIDL | SHGFI_SYSICONINDEX,
    );
    CoTaskMemFree(Some(pidl.cast()));
    if found == 0 || info.iIcon < 0 {
        return Err("无法读取桌面项目的系统图标索引".into());
    }
    // No overlay-index bits are accepted as part of a base icon index.
    let index = info.iIcon & 0x00ff_ffff;
    let reference = list_image(index, size.clamp(16, 256), false)?;
    let high =
        list_image(index, (size * 2).clamp(48, 256), true).unwrap_or_else(|_| reference.clone());
    Ok((high, reference))
}
unsafe fn list_image(index: i32, size: i32, high: bool) -> Result<String, String> {
    let kind = if high || size > 96 {
        SHIL_JUMBO
    } else if size > 32 {
        SHIL_EXTRALARGE
    } else if size > 16 {
        SHIL_LARGE
    } else {
        SHIL_SMALL
    };
    let list: IImageList = SHGetImageList(kind as i32).map_err(|e| e.to_string())?;
    // ILD_TRANSPARENT only: overlay masks would be encoded in bits 8..11.
    let icon = Icon(list.GetIcon(index, 1).map_err(|e| e.to_string())?);
    let mut width = 0;
    let mut height = 0;
    list.GetIconSize(&mut width, &mut height)
        .map_err(|e| e.to_string())?;
    let output = if high {
        width.max(height).clamp(16, 256)
    } else {
        size
    };
    let surface = Surface::new(output)?;
    let black = surface.draw(icon.0, output, 0)?;
    let white = surface.draw(icon.0, output, 255)?;
    let rgba = straight_alpha(&black, &white);
    let mut bytes = Vec::new();
    let mut encoder = png::Encoder::new(&mut bytes, output as u32, output as u32);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    {
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
// Reconstruct alpha from two backgrounds, including legacy mask-only icons.
fn straight_alpha(black: &[u8], white: &[u8]) -> Vec<u8> {
    black
        .chunks_exact(4)
        .zip(white.chunks_exact(4))
        .flat_map(|(b, w)| {
            let alpha = 255
                - (0..3)
                    .map(|n| w[n].saturating_sub(b[n]))
                    .max()
                    .unwrap_or(255);
            let channel = |n: usize| {
                if alpha == 0 {
                    0
                } else {
                    (b[n] as u32 * 255 / alpha as u32).min(255) as u8
                }
            };
            [channel(2), channel(1), channel(0), alpha]
        })
        .collect()
}
#[cfg(test)]
mod tests {
    #[test]
    fn legacy_and_translucent_icons_keep_alpha_and_colour() {
        assert_eq!(
            super::straight_alpha(
                &[0, 0, 0, 0, 10, 20, 30, 0, 50, 25, 0, 128],
                &[255, 255, 255, 0, 10, 20, 30, 0, 177, 152, 127, 255]
            ),
            [0, 0, 0, 0, 30, 20, 10, 255, 0, 49, 99, 128]
        );
    }
}
