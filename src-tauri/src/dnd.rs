//! Native drag & drop.
//!
//! Every drag of files out of a Fathom list is a real macOS drag session, so
//! the files can land in Finder, Mail, Slack, the Desktop… and drops coming
//! back into Fathom (from itself or any other app) arrive through Tauri's
//! drop events. The source offers copy *and* move, so the receiver applies
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
                NSDragOperation::Copy | NSDragOperation::Move | NSDragOperation::Generic
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

    pub fn start(window: &tauri::WebviewWindow, paths: &[String]) -> Result<(), String> {
        let mtm = MainThreadMarker::new().ok_or("drag must start on the main thread")?;
        let ptr = window.ns_view().map_err(|e| e.to_string())?;
        let view: &NSView = unsafe { &*(ptr as *const NSView) };
        let win = view.window().ok_or("no window")?;
        let content = win.contentView().ok_or("no content view")?;
        let at = win.mouseLocationOutsideOfEventStream();

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

        let ts = NSApp(mtm).currentEvent().map(|e| e.timestamp()).unwrap_or(0.0);
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            at,
            NSEventModifierFlags::empty(),
            ts,
            win.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
        .ok_or("couldn't create the drag event")?;

        let source = DragSource::new(window.app_handle().clone(), mtm);
        let session = content.beginDraggingSessionWithItems_event_source(&items, &event, ProtocolObject::from_ref(&*source));
        session.setAnimatesToStartingPositionsOnCancelOrFail(true);
        // Keep the source alive for the whole drag (replaced by the next one).
        CURRENT.with(|c| *c.borrow_mut() = Some(source));
        Ok(())
    }
}
