//! Small Finder icons for list rows (Details and Columns views).
//!
//! Keys say what to look up:
//!   "ext:png"   the icon for a file type (cached by the frontend per type)
//!   "ext:"      a plain document (no extension)
//!   "path:/x"   one item's own icon — folders (Downloads, Applications and
//!               custom folder icons differ), apps, packages, symlinks.
//! NSWorkspace is thread-safe, so a batch is drawn off the main thread.

/// Returns one PNG data URI per key (None when macOS had no icon).
#[tauri::command]
pub async fn file_icons(keys: Vec<String>, size: f64, scale: f64) -> Result<Vec<Option<String>>, String> {
    let size = size.clamp(12.0, 128.0);
    let scale = scale.clamp(1.0, 3.0);
    tauri::async_runtime::spawn_blocking(move || keys.iter().map(|k| imp::icon(k, size, scale)).collect())
        .await
        .map_err(|e| format!("icon task panicked: {e}"))
}

#[cfg(target_os = "macos")]
mod imp {
    use base64::Engine as _;
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    #[allow(deprecated)]
    pub fn icon(key: &str, size: f64, scale: f64) -> Option<String> {
        let ws = NSWorkspace::sharedWorkspace();
        let img = if let Some(p) = key.strip_prefix("path:") {
            ws.iconForFile(&NSString::from_str(p))
        } else {
            let ext = key.strip_prefix("ext:").unwrap_or("");
            // "" (no extension) → the generic document icon.
            ws.iconForFileType(&NSString::from_str(if ext.is_empty() { "public.data" } else { ext }))
        };
        let px = (size * scale).round();
        let mut rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(px, px));
        let cg = unsafe { img.CGImageForProposedRect_context_hints(&mut rect, None, None) }?;
        let bmp = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
        let data = unsafe { bmp.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(data.to_vec())))
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn icon(_: &str, _: f64, _: f64) -> Option<String> {
        None
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn type_and_path_icons() {
        let png = super::imp::icon("ext:png", 16.0, 2.0).expect("png icon");
        assert!(png.starts_with("data:image/png;base64,"));
        assert!(super::imp::icon("ext:", 16.0, 2.0).is_some());
        assert!(super::imp::icon("path:/Applications", 16.0, 2.0).is_some());
    }
}
