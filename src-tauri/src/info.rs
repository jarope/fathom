//! Get Info: everything about one item (owner, group, dates, link target,
//! Spotlight metadata such as image size, duration, camera, where it was
//! downloaded from), folder sizes worked out in the background, and
//! changing permissions.

use serde::Serialize;
use std::collections::HashSet;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

#[derive(Serialize)]
pub struct Info {
    path: String,
    name: String,
    is_dir: bool,
    is_symlink: bool,
    link_target: Option<String>,
    size: u64,
    on_disk: u64,
    owner: String,
    group: String,
    mode: u32,
    created: Option<i64>,
    modified: Option<i64>,
    accessed: Option<i64>,
    /// Spotlight's own description of the kind ("PNG image", "Folder"…).
    kind: Option<String>,
    /// Extra facts from Spotlight, ready to show: [label, value].
    meta: Vec<[String; 2]>,
    last_opened: Option<f64>,
}

fn user_name(uid: u32) -> String {
    unsafe {
        let p = libc::getpwuid(uid);
        if p.is_null() || (*p).pw_name.is_null() {
            return uid.to_string();
        }
        std::ffi::CStr::from_ptr((*p).pw_name).to_string_lossy().into_owned()
    }
}
fn group_name(gid: u32) -> String {
    unsafe {
        let g = libc::getgrgid(gid);
        if g.is_null() || (*g).gr_name.is_null() {
            return gid.to_string();
        }
        std::ffi::CStr::from_ptr((*g).gr_name).to_string_lossy().into_owned()
    }
}

#[tauri::command]
pub async fn file_info(path: String) -> Result<Info, String> {
    tauri::async_runtime::spawn_blocking(move || info_for(&path)).await.map_err(|e| e.to_string())?
}

fn secs(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64)
}

fn info_for(path: &str) -> Result<Info, String> {
    let p = Path::new(path);
    let lmd = p.symlink_metadata().map_err(|e| format!("Can't read {path}: {e}"))?;
    let is_symlink = lmd.file_type().is_symlink();
    let md = if is_symlink { p.metadata().unwrap_or(lmd.clone()) } else { lmd.clone() };
    let link_target = if is_symlink { std::fs::read_link(p).ok().map(|t| t.to_string_lossy().into_owned()) } else { None };
    let (kind, meta, last_opened) = spotlight(path);
    Ok(Info {
        path: path.to_string(),
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string()),
        is_dir: md.is_dir(),
        is_symlink,
        link_target,
        size: if md.is_dir() { 0 } else { md.len() },
        on_disk: if md.is_dir() { 0 } else { md.blocks() * 512 },
        owner: user_name(lmd.uid()),
        group: group_name(lmd.gid()),
        mode: lmd.mode() & 0o7777,
        created: secs(md.created()),
        modified: secs(md.modified()),
        accessed: secs(md.accessed()),
        kind,
        meta,
        last_opened,
    })
}

/// Spotlight metadata via `mdls -plist -` (one quick process for one item).
fn spotlight(path: &str) -> (Option<String>, Vec<[String; 2]>, Option<f64>) {
    let out = match std::process::Command::new("mdls").args(["-plist", "-"]).arg(path).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => return (None, vec![], None),
    };
    let Ok(plist::Value::Dictionary(d)) = plist::Value::from_reader(std::io::Cursor::new(out)) else { return (None, vec![], None) };
    let s = |k: &str| d.get(k).and_then(|v| v.as_string()).map(|x| x.to_string());
    let n = |k: &str| d.get(k).and_then(|v| v.as_real().or_else(|| v.as_signed_integer().map(|i| i as f64)));
    let list = |k: &str| {
        d.get(k).and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_string().map(|s| s.to_string())).collect::<Vec<_>>()).filter(|v| !v.is_empty())
    };
    let date = |k: &str| d.get(k).and_then(|v| v.as_date()).map(|t| {
        let st: std::time::SystemTime = t.into();
        st.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
    });
    let mut meta: Vec<[String; 2]> = Vec::new();
    let mut add = |label: &str, v: Option<String>| {
        if let Some(v) = v.filter(|v| !v.is_empty()) {
            meta.push([label.to_string(), v]);
        }
    };
    if let (Some(w), Some(h)) = (n("kMDItemPixelWidth"), n("kMDItemPixelHeight")) {
        add("Dimensions", Some(format!("{} × {}", w as i64, h as i64)));
    }
    if let Some(sec) = n("kMDItemDurationSeconds") {
        let t = sec.round() as i64;
        add("Duration", Some(if t >= 3600 { format!("{}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60) } else { format!("{}:{:02}", t / 60, t % 60) }));
    }
    add("Codecs", list("kMDItemCodecs").map(|v| v.join(", ")));
    add("Bit rate", n("kMDItemAudioBitRate").or(n("kMDItemTotalBitRate")).map(|b| format!("{} kbit/s", (b / 1000.0).round() as i64)));
    add("Sample rate", n("kMDItemAudioSampleRate").map(|r| format!("{:.1} kHz", r / 1000.0)));
    add("Pages", n("kMDItemNumberOfPages").map(|p| (p as i64).to_string()));
    add("Title", s("kMDItemTitle"));
    add("Authors", list("kMDItemAuthors").map(|v| v.join(", ")));
    add("Album", s("kMDItemAlbum"));
    add("Version", s("kMDItemVersion"));
    let camera = [s("kMDItemAcquisitionMake"), s("kMDItemAcquisitionModel")].into_iter().flatten().collect::<Vec<_>>().join(" ");
    add("Camera", Some(camera));
    let mut exposure = Vec::new();
    if let Some(f) = n("kMDItemFocalLength") { exposure.push(format!("{} mm", f.round() as i64)); }
    if let Some(f) = n("kMDItemFNumber") { exposure.push(format!("ƒ/{f:.1}")); }
    if let Some(t) = n("kMDItemExposureTimeSeconds") { exposure.push(if t < 1.0 && t > 0.0 { format!("1/{} s", (1.0 / t).round() as i64) } else { format!("{t} s") }); }
    if let Some(i) = n("kMDItemISOSpeed") { exposure.push(format!("ISO {}", i as i64)); }
    add("Exposure", Some(exposure.join(" · ")));
    if let (Some(la), Some(lo)) = (n("kMDItemLatitude"), n("kMDItemLongitude")) {
        add("Location", Some(format!("{la:.5}, {lo:.5}")));
    }
    add("Colour space", s("kMDItemColorSpace"));
    add("Where from", list("kMDItemWhereFroms").map(|v| v.join("\n")));
    add("Content type", s("kMDItemContentType"));
    (s("kMDItemKind"), meta, date("kMDItemLastUsedDate"))
}

// ---- Folder sizes (background, cancellable, with progress) ----

static CANCELLED: Mutex<Option<HashSet<u64>>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize, Clone)]
pub struct SizeReport {
    id: u64,
    bytes: u64,
    on_disk: u64,
    files: u64,
    dirs: u64,
    done: bool,
}

/// Start adding up `paths` (files and whole folders). Returns an id;
/// `dir-size` events carry progress (every ~200 ms) and the final total.
#[tauri::command]
pub fn dir_size(app: tauri::AppHandle, paths: Vec<String>) -> u64 {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    std::thread::spawn(move || {
        let mut r = SizeReport { id, bytes: 0, on_disk: 0, files: 0, dirs: 0, done: false };
        let mut seen_inodes: HashSet<(u64, u64)> = HashSet::new(); // hard links count once
        let mut last = std::time::Instant::now();
        let cancelled = || CANCELLED.lock().unwrap().as_ref().is_some_and(|s| s.contains(&id));
        'outer: for p in &paths {
            for e in walkdir::WalkDir::new(p).follow_links(false).into_iter().filter_map(|e| e.ok()) {
                let Ok(md) = e.metadata() else { continue };
                if md.is_dir() {
                    if e.depth() > 0 || paths.len() > 1 { r.dirs += 1; }
                } else {
                    if md.nlink() > 1 && !seen_inodes.insert((md.dev(), md.ino())) { continue; }
                    r.files += 1;
                    r.bytes += md.len();
                    r.on_disk += md.blocks() * 512;
                }
                if last.elapsed().as_millis() > 200 {
                    last = std::time::Instant::now();
                    if cancelled() { break 'outer; }
                    let _ = app.emit("dir-size", r.clone());
                }
            }
        }
        r.done = true;
        if let Some(s) = CANCELLED.lock().unwrap().as_mut() { s.remove(&id); }
        let _ = app.emit("dir-size", r);
    });
    id
}

#[tauri::command]
pub fn dir_size_cancel(id: u64) {
    CANCELLED.lock().unwrap().get_or_insert_with(HashSet::new).insert(id);
}

/// chmod (permission bits only).
#[tauri::command]
pub fn set_mode(path: String, mode: u32) -> Result<(), String> {
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode & 0o7777)).map_err(|e| format!("Can't change permissions: {e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn info_and_size_of_a_folder() {
        let d = std::env::temp_dir().join(format!("fathom-info-{}", std::process::id()));
        std::fs::create_dir_all(d.join("sub")).unwrap();
        std::fs::write(d.join("a.txt"), b"hello").unwrap();
        std::fs::write(d.join("sub/b.txt"), b"world!!").unwrap();
        let i = super::info_for(d.join("a.txt").to_str().unwrap()).unwrap();
        assert_eq!(i.size, 5);
        assert!(!i.owner.is_empty() && !i.group.is_empty());
        assert_eq!(i.mode & 0o600, 0o600);
        super::set_mode(d.join("a.txt").to_string_lossy().into_owned(), 0o640).unwrap();
        assert_eq!(super::info_for(d.join("a.txt").to_str().unwrap()).unwrap().mode, 0o640);
        let _ = std::fs::remove_dir_all(&d);
    }
}

