//! The system pasteboard as file URLs — so ⌘C in Fathom pastes files in
//! Finder (and Mail, Slack…), and files copied in Finder paste into Fathom.

use serde::Serialize;

#[derive(Serialize)]
pub struct Clip {
    /// Changes every time anything is copied, anywhere. The UI compares it
    /// with what it wrote to tell "our" clipboard from someone else's.
    change_count: i64,
    paths: Vec<String>,
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    pub fn write(paths: &[String]) -> Result<i64, String> {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        let objs: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> = paths
            .iter()
            .map(|p| ProtocolObject::from_retained(NSURL::fileURLWithPath(&NSString::from_str(p))))
            .collect();
        let arr = NSArray::from_retained_slice(&objs);
        if !pb.writeObjects(&arr) {
            return Err("Couldn't write to the clipboard".into());
        }
        Ok(pb.changeCount() as i64)
    }

    pub fn read() -> (i64, Vec<String>) {
        let pb = NSPasteboard::generalPasteboard();
        let cc = pb.changeCount() as i64;
        let mut out = Vec::new();
        if let Some(items) = pb.pasteboardItems() {
            for item in items.iter() {
                let Some(s) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) else { continue };
                if let Some(path) = NSURL::URLWithString(&s).and_then(|u| u.path()) {
                    out.push(path.to_string());
                }
            }
        }
        (cc, out)
    }
}

#[tauri::command]
pub fn pasteboard_write(paths: Vec<String>) -> Result<i64, String> {
    #[cfg(target_os = "macos")]
    {
        imp::write(&paths)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = paths;
        Err("Not supported on this platform".into())
    }
}

#[tauri::command]
pub fn pasteboard_read() -> Result<Clip, String> {
    #[cfg(target_os = "macos")]
    {
        let (change_count, paths) = imp::read();
        Ok(Clip { change_count, paths })
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Not supported on this platform".into())
    }
}
