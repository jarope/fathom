//! macOS system integration: Open With, real app/file icons, the Share menu
//! and Quick Look (the real QLPreviewPanel, as Finder's Space bar).
//!
//! Commands that touch AppKit UI are sync on purpose: Tauri runs sync
//! commands on the main thread, which AppKit requires.

use serde::Serialize;

#[derive(Serialize)]
pub struct App {
    name: String,
    path: String,
    is_default: bool,
}

#[tauri::command]
pub fn open_with_apps(paths: Vec<String>) -> Vec<App> {
    #[cfg(target_os = "macos")]
    {
        imp::open_with_apps(&paths)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = paths;
        vec![]
    }
}

/// Open `paths` with the app bundle at `app`.
#[tauri::command]
pub fn open_with(paths: Vec<String>, app: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-a")
        .arg(&app)
        .args(&paths)
        .spawn()
        .map_err(|e| format!("Couldn't open with {app}: {e}"))?;
    Ok(())
}

/// The icon Finder shows for `path` (file, folder or app) as a PNG data URI.
#[tauri::command]
pub fn file_icon(path: String, size: u32) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use base64::Engine;
        let png = imp::icon_png(&path, size.clamp(16, 512))?;
        Ok(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, size);
        Err("Icons need macOS".into())
    }
}

/// Show the macOS share menu for `paths` at window point (x, y) in points.
#[tauri::command]
pub fn share(window: tauri::WebviewWindow, paths: Vec<String>, x: f64, y: f64) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        imp::share(&window, &paths, x, y)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, paths, x, y);
        Err("Sharing needs macOS".into())
    }
}

/// Open (or update) Quick Look on `paths`, showing item `index`.
/// Emits `ql-nav` {dir} for ↑/↓ pressed in the panel and `ql-closed`.
#[tauri::command]
pub fn quick_look(window: tauri::WebviewWindow, paths: Vec<String>, index: usize, open: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        imp::quick_look(&window, paths, index, open)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, paths, index, open);
        Err("Quick Look needs macOS".into())
    }
}

#[tauri::command]
pub fn quick_look_close() {
    #[cfg(target_os = "macos")]
    imp::quick_look_close();
}

#[cfg(target_os = "macos")]
mod imp {
    use super::App;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
    use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace, NSEvent, NSEventType,
        NSGraphicsContext, NSSharingServicePicker, NSView, NSWindowDelegate, NSWorkspace,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSInteger, NSPoint, NSRect, NSRectEdge, NSSize, NSString, NSURL};
    use objc2_quick_look_ui::{QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource, QLPreviewPanelDelegate};
    use std::cell::RefCell;
    use tauri::Emitter;

    fn url(p: &str) -> Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(p))
    }

    fn app_name(path: &str) -> String {
        std::path::Path::new(path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    }

    pub fn open_with_apps(paths: &[String]) -> Vec<App> {
        let ws = NSWorkspace::sharedWorkspace();
        let mut common: Option<Vec<String>> = None;
        for p in paths.iter().take(20) {
            let list: Vec<String> = ws
                .URLsForApplicationsToOpenURL(&url(p))
                .iter()
                .filter_map(|u| u.path().map(|s| s.to_string()))
                .collect();
            common = Some(match common {
                None => list,
                Some(c) => c.into_iter().filter(|a| list.contains(a)).collect(),
            });
        }
        let default = paths
            .first()
            .and_then(|p| ws.URLForApplicationToOpenURL(&url(p)))
            .and_then(|u| u.path())
            .map(|s| s.to_string());
        let mut apps: Vec<App> = Vec::new();
        for path in common.unwrap_or_default() {
            if apps.iter().any(|a| a.path == path) {
                continue;
            }
            let is_default = default.as_deref() == Some(path.as_str());
            apps.push(App { name: app_name(&path), path, is_default });
        }
        // Default first, then A–Z; drop duplicate names (old copies of an app)
        // unless they're the default.
        apps.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        let mut seen = std::collections::HashSet::new();
        apps.retain(|a| seen.insert(a.name.to_lowercase()) || a.is_default);
        apps
    }

    pub fn icon_png(path: &str, px: u32) -> Result<Vec<u8>, String> {
        let _mtm = MainThreadMarker::new().ok_or("icons are drawn on the main thread")?;
        let img = NSWorkspace::sharedWorkspace().iconForFile(&NSString::from_str(path));
        let n = px as NSInteger;
        let rep = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(),
                std::ptr::null_mut(),
                n,
                n,
                8,
                4,
                true,
                false,
                NSDeviceRGBColorSpace,
                0,
                0,
            )
        }
        .ok_or("couldn't make a bitmap")?;
        let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).ok_or("no graphics context")?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&ctx));
        let r = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(px as f64, px as f64));
        img.drawInRect_fromRect_operation_fraction(r, NSRect::ZERO, NSCompositingOperation::Copy, 1.0);
        ctx.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
            .ok_or("couldn't encode the icon")?;
        Ok(data.to_vec())
    }

    // ---- Share ----
    thread_local! {
        static PICKER: RefCell<Option<Retained<NSSharingServicePicker>>> = const { RefCell::new(None) };
    }

    pub fn share(window: &tauri::WebviewWindow, paths: &[String], x: f64, y: f64) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("share must run on the main thread")?;
        let ptr = window.ns_view().map_err(|e| e.to_string())?;
        let view: &NSView = unsafe { &*(ptr as *const NSView) };
        let _ = mtm;
        let urls: Vec<Retained<AnyObject>> = paths.iter().map(|p| Retained::into_super(Retained::into_super(url(p)))).collect();
        let items = NSArray::from_retained_slice(&urls);
        let picker = unsafe { NSSharingServicePicker::initWithItems(NSSharingServicePicker::alloc(), &items) };
        let b = view.bounds();
        let vy = if view.isFlipped() { y } else { b.size.height - y };
        let rect = NSRect::new(NSPoint::new(x, vy), NSSize::new(1.0, 1.0));
        picker.showRelativeToRect_ofView_preferredEdge(rect, view, NSRectEdge::MinY);
        PICKER.with(|c| *c.borrow_mut() = Some(picker));
        Ok(())
    }

    // ---- Quick Look ----
    pub struct QlIvars {
        app: tauri::AppHandle,
        paths: RefCell<Vec<String>>,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "FathomQuickLook"]
        #[ivars = QlIvars]
        pub struct QlSource;

        unsafe impl NSObjectProtocol for QlSource {}
        unsafe impl NSWindowDelegate for QlSource {
            #[unsafe(method(windowWillClose:))]
            fn window_will_close(&self, _n: &objc2_foundation::NSNotification) {
                let _ = self.ivars().app.emit("ql-closed", ());
            }
        }

        unsafe impl QLPreviewPanelDataSource for QlSource {
            #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
            unsafe fn count(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
                self.ivars().paths.borrow().len() as NSInteger
            }

            #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
            unsafe fn item(&self, _panel: Option<&QLPreviewPanel>, index: NSInteger) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
                let paths = self.ivars().paths.borrow();
                paths.get(index.max(0) as usize).map(|p| ProtocolObject::from_retained(url(p)))
            }
        }

        unsafe impl QLPreviewPanelDelegate for QlSource {
            #[unsafe(method(previewPanel:handleEvent:))]
            unsafe fn handle_event(&self, panel: Option<&QLPreviewPanel>, event: Option<&NSEvent>) -> Bool {
                let Some(ev) = event else { return Bool::NO };
                if ev.r#type() != NSEventType::KeyDown {
                    return Bool::NO;
                }
                match ev.keyCode() {
                    49 => {
                        // Space closes, like Finder.
                        if let Some(p) = panel {
                            p.orderOut(None);
                        }
                        Bool::YES
                    }
                    125 | 126 => {
                        // ↓ / ↑ move the selection in Fathom's list.
                        let dir = if ev.keyCode() == 125 { 1 } else { -1 };
                        let _ = self.ivars().app.emit("ql-nav", serde_json::json!({ "dir": dir }));
                        Bool::YES
                    }
                    _ => Bool::NO,
                }
            }
        }
    );

    thread_local! {
        static QL: RefCell<Option<Retained<QlSource>>> = const { RefCell::new(None) };
    }

    fn source() -> Option<Retained<QlSource>> {
        QL.with(|q| q.borrow().clone())
    }

    fn attach(panel: &QLPreviewPanel, s: &QlSource) {
        unsafe {
            panel.setDataSource(Some(ProtocolObject::from_ref(s)));
            panel.setDelegate(Some(s));
            panel.reloadData();
        }
    }

    // Responder-chain hooks added to Fathom's NSWindow class, so the panel
    // finds us as its controller (the supported way to drive QLPreviewPanel).
    unsafe extern "C-unwind" fn accepts(_this: &AnyObject, _sel: Sel, _panel: &AnyObject) -> Bool {
        Bool::new(source().is_some())
    }
    unsafe extern "C-unwind" fn begin(_this: &AnyObject, _sel: Sel, panel: &QLPreviewPanel) {
        if let Some(s) = source() {
            attach(panel, &s);
        }
    }
    unsafe extern "C-unwind" fn end(_this: &AnyObject, _sel: Sel, panel: &QLPreviewPanel) {
        // Also called when control merely moves (e.g. the panel becomes key);
        // the real close is reported by windowWillClose.
        unsafe {
            panel.setDataSource(None);
            panel.setDelegate(None);
        }
    }

    fn install_hooks(window_obj: &AnyObject) {
        use std::ffi::CStr;
        thread_local! { static DONE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }
        if DONE.with(|d| d.replace(true)) {
            return;
        }
        let cls = window_obj.class() as *const _ as *mut objc2::runtime::AnyClass;
        let bool_ty: &CStr = if cfg!(target_arch = "aarch64") { c"B@:@" } else { c"c@:@" };
        unsafe {
            objc2::ffi::class_addMethod(cls, sel!(acceptsPreviewPanelControl:), std::mem::transmute::<*const (), objc2::runtime::Imp>(accepts as *const ()), bool_ty.as_ptr());
            objc2::ffi::class_addMethod(cls, sel!(beginPreviewPanelControl:), std::mem::transmute::<*const (), objc2::runtime::Imp>(begin as *const ()), c"v@:@".as_ptr());
            objc2::ffi::class_addMethod(cls, sel!(endPreviewPanelControl:), std::mem::transmute::<*const (), objc2::runtime::Imp>(end as *const ()), c"v@:@".as_ptr());
        }
    }

    pub fn quick_look(window: &tauri::WebviewWindow, paths: Vec<String>, index: usize, open: bool) -> Result<bool, String> {
        let mtm = MainThreadMarker::new().ok_or("Quick Look must run on the main thread")?;
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        let win: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
        install_hooks(win);

        let src = match source() {
            Some(s) => s,
            None => {
                let s: Retained<QlSource> = {
                    let this = QlSource::alloc(mtm).set_ivars(QlIvars { app: tauri::Manager::app_handle(window).clone(), paths: RefCell::new(vec![]) });
                    unsafe { msg_send![super(this), init] }
                };
                QL.with(|q| *q.borrow_mut() = Some(s.clone()));
                s
            }
        };
        *src.ivars().paths.borrow_mut() = paths;

        let visible = unsafe { QLPreviewPanel::sharedPreviewPanelExists(mtm) }
            && unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }.map(|p| p.isVisible()).unwrap_or(false);
        if !visible && !open {
            return Ok(false);
        }
        let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }.ok_or("Quick Look isn't available")?;
        unsafe { panel.updateController() };
        if unsafe { panel.currentController() }.is_none() {
            // The responder chain didn't hand us control — drive it directly.
            attach(&panel, &src);
        }
        unsafe {
            panel.reloadData();
            panel.setCurrentPreviewItemIndex(index as NSInteger);
        }
        if !visible {
            panel.makeKeyAndOrderFront(None);
            // Control may have been re-negotiated as the panel became key.
            if unsafe { panel.dataSource() }.is_none() {
                attach(&panel, &src);
            }
            unsafe {
                panel.reloadData();
                panel.setCurrentPreviewItemIndex(index as NSInteger);
            }
        }
        Ok(true)
    }

    pub fn quick_look_close() {
        let Some(mtm) = MainThreadMarker::new() else { return };
        if unsafe { QLPreviewPanel::sharedPreviewPanelExists(mtm) } {
            if let Some(p) = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) } {
                if p.isVisible() {
                    p.orderOut(None);
                }
            }
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn open_with_lists_apps_for_text() {
        let f = std::env::temp_dir().join(format!("fathom-ow-{}.txt", std::process::id()));
        std::fs::write(&f, "x").unwrap();
        let apps = super::imp::open_with_apps(&[f.to_string_lossy().into_owned()]);
        std::fs::remove_file(&f).unwrap();
        println!("{:?}", apps.iter().map(|a| (&a.name, a.is_default)).collect::<Vec<_>>());
        assert!(apps.iter().any(|a| a.name == "TextEdit"));
        assert!(apps[0].is_default);
    }
}
