//! Runs on the existing Shell STA. HBITMAP/DC resources are released on all paths.
use base64::Engine;
use std::{mem::size_of, path::Path};
use windows::{
    core::HSTRING,
    Win32::{
        Foundation::SIZE,
        Graphics::Gdi::{
            DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
            BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
        },
        UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_ICONONLY},
    },
};

struct Bitmap(HBITMAP);
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(HGDIOBJ(self.0 .0));
        }
    }
}
pub fn read(path: &Path) -> Result<String, String> {
    let raw = path.to_string_lossy();
    let shell_path = if let Some(unc) = raw.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        raw.strip_prefix("\\\\?\\").unwrap_or(&raw).to_string()
    };
    unsafe {
        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(shell_path), None)
                .map_err(|e| e.to_string())?;
        from_factory(&factory, 48)
    }
}

pub unsafe fn from_factory(factory: &IShellItemImageFactory, size: i32) -> Result<String, String> {
    factory_image(factory, size, SIIGBF_ICONONLY)
}

unsafe fn factory_image(
    factory: &IShellItemImageFactory,
    size: i32,
    flags: SIIGBF,
) -> Result<String, String> {
    let bitmap = Bitmap(
        factory
            .GetImage(SIZE { cx: size, cy: size }, flags)
            .map_err(|e| e.to_string())?,
    );
    let mut info = BITMAP::default();
    if GetObjectW(
        HGDIOBJ(bitmap.0 .0),
        size_of::<BITMAP>() as i32,
        Some((&mut info as *mut BITMAP).cast()),
    ) == 0
    {
        return Err("无法读取文件图标".into());
    }
    let (width, height) = (info.bmWidth, info.bmHeight.abs());
    if !(1..=256).contains(&width) || !(1..=256).contains(&height) {
        return Err("文件图标尺寸无效".into());
    }
    let mut rgba = vec![0u8; width as usize * height as usize * 4];
    let mut dib = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let dc = GetDC(None);
    let rows = GetDIBits(
        dc,
        bitmap.0,
        0,
        height as u32,
        Some(rgba.as_mut_ptr().cast()),
        &mut dib,
        DIB_RGB_COLORS,
    );
    ReleaseDC(None, dc);
    if rows != height {
        return Err("无法提取文件图标像素".into());
    }
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    // Shell bitmaps are premultiplied; PNG stores straight alpha.
    for pixel in rgba.chunks_exact_mut(4) {
        if pixel[3] > 0 && pixel[3] < 255 {
            for n in 0..3 {
                pixel[n] = ((pixel[n] as u32 * 255) / pixel[3] as u32).min(255) as u8;
            }
        }
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
