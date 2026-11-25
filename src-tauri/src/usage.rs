// Disk usage view: measure every item of a folder (a folder's whole tree, a
// file itself) and stream the sizes back as they're found — Aloft's measure,
// inside Fathom. A few worker threads share the items so one huge folder
// doesn't hold up the rest; `usage` events carry interim and final sizes.
//
// Sizes are on-disk (allocated blocks), hard links count once, and each walk
// stays on the disk its item lives on: mounted volumes under /Volumes and the
// boot disk's /System/Volumes/Data aren't counted twice when measuring "/".

use serde::Serialize;
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

static NEXT: AtomicU64 = AtomicU64::new(1);
static CANCELLED: Mutex<Option<HashSet<u64>>> = Mutex::new(None);

fn cancelled(id: u64) -> bool {
    CANCELLED.lock().unwrap().as_ref().is_some_and(|s| s.contains(&id))
}

#[derive(Serialize, Clone)]
pub struct UsageItem {
    id: u64,
    path: String,
    /// Bytes on disk so far (final when `done`).
    bytes: u64,
    /// Some entries couldn't be read (macOS privacy protection, permissions).
    partial: bool,
    done: bool,
}

#[derive(Serialize, Clone)]
pub struct UsageDone {
    id: u64,
    cancelled: bool,
}

/// Walk one item, calling `tick` with the running total about every 250 ms.
fn measure(path: &str, links: &Mutex<HashSet<(u64, u64)>>, mut tick: impl FnMut(u64) -> bool) -> (u64, bool) {
    let mut bytes = 0u64;
    let mut partial = false;
    let mut last = Instant::now();
    for e in walkdir::WalkDir::new(path).follow_links(false).same_file_system(true) {
        let e = match e {
            Ok(e) => e,
            Err(_) => { partial = true; continue; }
        };
        let Ok(md) = e.metadata() else { partial = true; continue };
        if md.nlink() > 1 && !md.is_dir() && !links.lock().unwrap().insert((md.dev(), md.ino())) { continue; }
        bytes += md.blocks() * 512;
        if last.elapsed() > Duration::from_millis(250) {
            last = Instant::now();
            if !tick(bytes) { break; }
        }
    }
    (bytes, partial)
}

/// Start measuring `paths`. Returns an id; `usage-item` events carry each
/// item's size (interim, then done) and `usage-done` ends the run.
#[tauri::command]
pub fn usage_scan(app: tauri::AppHandle, paths: Vec<String>) -> u64 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    std::thread::spawn(move || {
        let paths = Arc::new(paths);
        let next = AtomicUsize::new(0);
        let links: Mutex<HashSet<(u64, u64)>> = Mutex::new(HashSet::new());
        let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
        std::thread::scope(|s| {
            for _ in 0..workers {
                s.spawn(|| loop {
                    if cancelled(id) { break; }
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(p) = paths.get(i) else { break };
                    let (bytes, partial) = measure(p, &links, |b| {
                        let _ = app.emit("usage-item", UsageItem { id, path: p.clone(), bytes: b, partial: false, done: false });
                        !cancelled(id)
                    });
                    if cancelled(id) { break; }
                    let _ = app.emit("usage-item", UsageItem { id, path: p.clone(), bytes, partial, done: true });
                });
            }
        });
        let was = cancelled(id);
        if let Some(s) = CANCELLED.lock().unwrap().as_mut() { s.remove(&id); }
        let _ = app.emit("usage-done", UsageDone { id, cancelled: was });
    });
    id
}

#[tauri::command]
pub fn usage_cancel(id: u64) {
    CANCELLED.lock().unwrap().get_or_insert_with(HashSet::new).insert(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_a_tree_and_counts_hard_links_once() {
        let d = std::env::temp_dir().join(format!("fathom-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("sub/a"), vec![1u8; 10_000]).unwrap();
        std::fs::hard_link(d.join("sub/a"), d.join("sub/b")).unwrap();
        let links = Mutex::new(HashSet::new());
        let (bytes, partial) = measure(d.to_str().unwrap(), &links, |_| true);
        assert!(!partial);
        let one = std::fs::metadata(d.join("sub/a")).unwrap().blocks() * 512;
        let dirs = std::fs::metadata(&d).unwrap().blocks() * 512 + std::fs::metadata(d.join("sub")).unwrap().blocks() * 512;
        assert_eq!(bytes, one + dirs); // the link isn't counted again
        std::fs::remove_dir_all(&d).unwrap();
    }
}
