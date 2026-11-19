//! Grid view pictures: a real Quick Look thumbnail (images, PDFs, video,
//! documents…) or, when a file has none, its Finder icon — custom folder
//! icons and app icons included. Uses QLThumbnailGenerator, the same engine
//! Finder uses, so there's no process per file.

use serde::Serialize;

#[derive(Serialize)]
pub struct FileThumb {
    /// PNG data URI.
    pub data: String,
    /// "thumb" (a picture of the contents) or "icon".
    pub kind: &'static str,
}

/// `size` is the edge in points; `scale` the screen's backing scale (2 on Retina).
#[tauri::command]
pub async fn file_thumb(path: String, size: f64, scale: f64) -> Result<FileThumb, String> {
    tauri::async_runtime::spawn_blocking(move || imp::generate(&path, size.clamp(16.0, 1024.0), scale.clamp(1.0, 3.0)))
        .await
        .map_err(|e| format!("thumbnail task panicked: {e}"))?
}

#[cfg(target_os = "macos")]
mod imp {
    use super::FileThumb;
    use base64::Engine as _;
    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSDictionary, NSError, NSString, NSURL};
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes, QLThumbnailGenerator,
        QLThumbnailRepresentation, QLThumbnailRepresentationType,
    };
    use std::sync::mpsc;
    use std::time::Duration;

    pub fn generate(path: &str, size: f64, scale: f64) -> Result<FileThumb, String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        let req = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                CGSize { width: size, height: size },
                scale,
                QLThumbnailGenerationRequestRepresentationTypes::All,
            )
        };
        let (tx, rx) = mpsc::channel::<Result<FileThumb, String>>();
        let block = RcBlock::new(move |rep: *mut QLThumbnailRepresentation, err: *mut NSError| {
            let out = if let Some(rep) = unsafe { rep.as_ref() } {
                encode(rep)
            } else if let Some(e) = unsafe { err.as_ref() } {
                Err(e.localizedDescription().to_string())
            } else {
                Err("no thumbnail".into())
            };
            let _ = tx.send(out);
        });
        let gen = unsafe { QLThumbnailGenerator::sharedGenerator() };
        unsafe { gen.generateBestRepresentationForRequest_completionHandler(&req, &block) };
        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(r) => r,
            Err(_) => {
                unsafe { gen.cancelRequest(&req) };
                Err("thumbnail timed out".into())
            }
        }
    }

    fn encode(rep: &QLThumbnailRepresentation) -> Result<FileThumb, String> {
        let kind = if unsafe { rep.r#type() } == QLThumbnailRepresentationType::Icon { "icon" } else { "thumb" };
        let cg = unsafe { rep.CGImage() };
        let bmp = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
        let data = unsafe { bmp.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
            .ok_or("couldn't encode the thumbnail")?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(data.to_vec());
        Ok(FileThumb { data: format!("data:image/png;base64,{b64}"), kind })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn generate(_: &str, _: f64, _: f64) -> Result<super::FileThumb, String> {
        Err("Thumbnails are only available on macOS.".into())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn folder_gets_an_icon_and_png_gets_a_thumbnail() {
        let dir = std::env::temp_dir().join(format!("fathom-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = super::imp::generate(dir.to_str().unwrap(), 64.0, 2.0).expect("folder icon");
        assert_eq!(f.kind, "icon");
        assert!(f.data.starts_with("data:image/png;base64,"));
        let png = dir.join("p.png");
        image::RgbImage::from_pixel(40, 30, image::Rgb([200, 40, 40])).save(&png).unwrap();
        let t = super::imp::generate(png.to_str().unwrap(), 64.0, 2.0).expect("png thumb");
        assert_eq!(t.kind, "thumb");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
