//! Native clipboard read for terminal paste.
//!
//! WKWebView gates `navigator.clipboard.readText()` behind a native "Paste" consent
//! affordance (visible on macOS 26+) and a canvas-rendered xterm has no editable
//! target for it anyway, so browser-side paste silently fails. We instead read the OS
//! clipboard here on the Rust side — no WebKit gate — and hand the result to
//! `term.paste()`. An image on the clipboard is encoded to a temp PNG whose path is
//! returned; Claude Code's TUI attaches that path as an image (the cross-platform
//! "file path in prompt" method, which works where Cmd+V into the TUI does not since
//! xterm captures Cmd+V before the child process sees it).

use serde::Serialize;
use std::path::PathBuf;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// What the frontend should feed to `term.paste()`. Serialized as a tagged union:
/// `{"kind":"text","text":…}`, `{"kind":"image","path":…}`, or `{"kind":"empty"}`.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ClipboardPaste {
    /// Plain text, pasted verbatim.
    Text { text: String },
    /// A temp PNG written from a clipboard image; paste its path.
    Image { path: String },
    /// Nothing pasteable on the clipboard.
    Empty,
}

/// Encode raw RGBA8 pixels as PNG bytes. Pure — unit-tested below.
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    // Guard the buffer length so a truncated/oversized image can't panic the encoder.
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
        .ok_or_else(|| "image dimensions overflow".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "rgba buffer is {} bytes, expected {expected} for {width}x{height}",
            rgba.len()
        ));
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Read the OS clipboard for a terminal paste: text first (the common case), falling
/// back to an image written as a temp PNG. Returns `Empty` when neither is available.
#[tauri::command]
pub fn clipboard_read_for_paste(app: tauri::AppHandle) -> Result<ClipboardPaste, String> {
    // Text wins when present. An image-only clipboard makes `read_text` error or return
    // empty on macOS, so this cleanly falls through to the image branch.
    if let Ok(text) = app.clipboard().read_text() {
        if !text.is_empty() {
            return Ok(ClipboardPaste::Text { text });
        }
    }
    if let Ok(img) = app.clipboard().read_image() {
        let png = encode_png(img.rgba(), img.width(), img.height())?;
        let mut path: PathBuf = std::env::temp_dir();
        path.push(format!("conduit-paste-{}.png", uuid::Uuid::new_v4()));
        std::fs::write(&path, &png).map_err(|e| e.to_string())?;
        return Ok(ClipboardPaste::Image {
            path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(ClipboardPaste::Empty)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_png_roundtrips_dimensions_and_pixels() {
        // 2x2 solid red RGBA.
        let rgba = [255u8, 0, 0, 255].repeat(4);
        let bytes = encode_png(&rgba, 2, 2).expect("encode should succeed");

        // PNG magic bytes.
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);

        // Decode back: dimensions and pixels must survive the round-trip.
        let decoder = png::Decoder::new(&bytes[..]);
        let mut reader = decoder.read_info().expect("read_info");
        let (w, h) = {
            let info = reader.info();
            (info.width, info.height)
        };
        assert_eq!((w, h), (2, 2));
        let mut buf = vec![0; reader.output_buffer_size()];
        let frame = reader.next_frame(&mut buf).expect("next_frame");
        assert_eq!(&buf[..frame.buffer_size()], &rgba[..]);
    }

    #[test]
    fn encode_png_rejects_wrong_buffer_size() {
        // 3 bytes cannot be a 1x1 RGBA pixel (needs 4).
        assert!(encode_png(&[1, 2, 3], 1, 1).is_err());
    }
}
