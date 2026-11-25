//! Native drag & drop.
//!
//! Drags inside the window are handled by the page (dnd.js). When one leaves
//! the window it becomes a real macOS drag session, started from the
//! mouse-down that began it, so the files can land in Finder, Mail, Slack,
//! the Desktop… Drops from other apps arrive through Tauri's drop events. The source offers copy *and* move, so the receiver applies
//! Finder's rules: same disk = move, another disk = copy, ⌥ = copy.

use serde::Serialize;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

#[derive(Serialize)]
pub struct DropInfo {
    /// Copy (true) or move (false), by Finder's rules and the keys held now.
    copy: bool,
}

/// Decide copy vs move for a drop of `sources` into `dest_dir`, like Finder:
/// ⌥ forces copy, ⌘ forces move, otherwise move within a disk, copy across.
#[tauri::command]
pub fn drop_action(sources: Vec<String>, dest_dir: String) -> DropInfo {
    let (alt, cmd) = modifiers();
    if alt {
        return DropInfo { copy: true };
    }
    if cmd {
        return DropInfo { copy: false };
    }
    // Servers: moving within one server is a rename; anything crossing machines copies.
    if crate::remote::xfer::involves_server(&sources, &dest_dir) {
        let conn = |p: &str| crate::remote::parse(p).map(|(c, _)| c);
        let d = conn(&dest_dir);
        return DropInfo { copy: d.is_none() || sources.iter().any(|s| conn(s) != d) };
    }
    let dev = |p: &str| Path::new(p).symlink_metadata().ok().map(|m| m.dev());
    let dest = Path::new(&dest_dir).metadata().ok().map(|m| m.dev());
    let copy = sources.iter().any(|s| dev(s).is_none() || dev(s) != dest);
    DropInfo { copy }
}

/// Which of `paths` are folders (follows links, like Finder's sidebar).
#[tauri::command]
pub fn classify_paths(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).is_dir()).collect()
}

#[cfg(target_os = "macos")]
fn modifiers() -> (bool, bool) {
    use objc2_app_kit::{NSEvent, NSEventModifierFlags};
    let f = NSEvent::modifierFlags_class();
    (f.contains(NSEventModifierFlags::Option), f.contains(NSEventModifierFlags::Command))
}
#[cfg(not(target_os = "macos"))]
fn modifiers() -> (bool, bool) {
    (false, false)
}

/// Start a native drag of `paths` from the mouse position. Sync on purpose:
/// Tauri runs sync commands on the main thread, which AppKit requires.
/// Emits `native-drag-end` with `{ dropped }` when the drag finishes.
#[tauri::command]
pub fn start_drag(window: tauri::WebviewWindow, paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("Nothing to drag".into());
    }
    #[cfg(target_os = "macos")]
    {
        imp::start(&window, &paths)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("Dragging to other apps isn't supported on this platform".into())
    }
}

/// Remember every left mouse-down (call once, on the main thread). A drag
/// out of the window is started from the mouse-down that began it — the only
/// event recent macOS accepts for a drag session that destinations will see.
pub fn install_mouse_monitor() {
    #[cfg(target_os = "macos")]
    imp::install_monitor();
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApp, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSEvent,
        NSEventModifierFlags, NSEventType, NSView, NSWorkspace,
    };
    use objc2_foundation::{NSMutableArray, NSPoint, NSRect, NSSize, NSString, NSURL};
    use tauri::{Emitter, Manager};

    thread_local! {
        static CURRENT: std::cell::RefCell<Option<Retained<DragSource>>> = const { std::cell::RefCell::new(None) };
        static LAST_DOWN: std::cell::RefCell<Option<Retained<NSEvent>>> = const { std::cell::RefCell::new(None) };
        static MONITOR: std::cell::RefCell<Option<Retained<objc2::runtime::AnyObject>>> = const { std::cell::RefCell::new(None) };
    }

    pub fn install_monitor() {
        use objc2_app_kit::NSEventMask;
        let block = block2::RcBlock::new(|e: std::ptr::NonNull<NSEvent>| -> *mut NSEvent {
            let ev: &NSEvent = unsafe { e.as_ref() };
            LAST_DOWN.with(|d| *d.borrow_mut() = unsafe { Retained::retain(ev as *const NSEvent as *mut NSEvent) });
            e.as_ptr()
        });
        let m = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::LeftMouseDown, &block) };
        MONITOR.with(|x| *x.borrow_mut() = m);
    }

    pub struct SourceIvars {
        app: tauri::AppHandle,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "FathomDragSource"]
        #[ivars = SourceIvars]
        pub struct DragSource;

        unsafe impl NSObjectProtocol for DragSource {}

        unsafe impl NSDraggingSource for DragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn mask(&self, _session: &NSDraggingSession, _context: NSDraggingContext) -> NSDragOperation {
                // Let the receiver choose (Finder: move on the same disk,
                // copy across disks, ⌥ copy).
                let m = NSDragOperation::Copy | NSDragOperation::Move | NSDragOperation::Generic;
                m
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(&self, _session: &NSDraggingSession, _at: NSPoint, operation: NSDragOperation) {
                let dropped = operation != NSDragOperation::None;
                let _ = self.ivars().app.emit("native-drag-end", serde_json::json!({ "dropped": dropped }));
            }
        }
    );

    impl DragSource {
        fn new(app: tauri::AppHandle, mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(SourceIvars { app });
            unsafe { msg_send![super(this), init] }
        }
    }

    /// The WKWebView inside Tauri's container view.
    fn find_webview(v: &NSView) -> Option<Retained<NSView>> {
        for sub in v.subviews().iter() {
            let n = sub.class().name().to_str().unwrap_or("");
            if n.contains("WryWebView") && !n.contains("Parent") { return Some(sub.clone()); }
            if let Some(f) = find_webview(&sub) { return Some(f); }
        }
        None
    }

    pub fn start(window: &tauri::WebviewWindow, paths: &[String]) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("drag must start on the main thread")?;
        let ptr = window.ns_view().map_err(|e| e.to_string())?;
        let view: &NSView = unsafe { &*(ptr as *const NSView) };
        let win = view.window().ok_or("no window")?;
        let content = win.contentView().ok_or("no content view")?;
        // Start the drag on the web view itself, from the mouse-down that began
        // it. A synthetic event (the old way) gets tracked and drawn but is
        // never offered to any destination on recent macOS (seen on 27.2).
        let dview = find_webview(&content).unwrap_or_else(|| content.clone());
        let cur = LAST_DOWN.with(|d| d.borrow().clone()).filter(|e| e.windowNumber() == win.windowNumber());
        let at_win = cur.as_ref().map(|e| e.locationInWindow()).unwrap_or_else(|| win.mouseLocationOutsideOfEventStream());
        let at = dview.convertPoint_fromView(at_win, None);

        let ws = NSWorkspace::sharedWorkspace();
        let items = NSMutableArray::<NSDraggingItem>::new();
        const S: f64 = 56.0;
        for (i, p) in paths.iter().enumerate() {
            let ns = NSString::from_str(p);
            let url = NSURL::fileURLWithPath(&ns);
            let item = NSDraggingItem::initWithPasteboardWriter(NSDraggingItem::alloc(), &ProtocolObject::from_retained(url));
            let icon = ws.iconForFile(&ns);
            icon.setSize(NSSize::new(S, S));
            // A small fanned stack under the cursor.
            let off = (i.min(4) as f64) * 5.0;
            let frame = NSRect::new(NSPoint::new(at.x - S / 2.0 + off, at.y - S / 2.0 - off), NSSize::new(S, S));
            unsafe { item.setDraggingFrame_contents(frame, Some(&icon)) };
            items.addObject(&item);
        }

        let event = match cur {
            Some(e) => e,
            None => NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            at_win,
            NSEventModifierFlags::empty(),
            NSApp(mtm).currentEvent().map(|e| e.timestamp()).unwrap_or(0.0),
            win.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
        .ok_or("couldn't create the drag event")?,
        };

        let source = DragSource::new(window.app_handle().clone(), mtm);
        let session = dview.beginDraggingSessionWithItems_event_source(&items, &event, ProtocolObject::from_ref(&*source));
        session.setAnimatesToStartingPositionsOnCancelOrFail(true);
        // Keep the source alive for the whole drag (replaced by the next one).
        CURRENT.with(|c| *c.borrow_mut() = Some(source));
        Ok(())
    }
}
