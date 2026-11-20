//! Fathom — native backend.
//!
//! A lean file manager: it browses directories, searches under them, and does
//! the handful of daily file operations Finder makes awkward. The heavy walk
//! (search) runs on a blocking thread so the UI stays live. "Move to Bin" uses
//! the real OS trash — recoverable, never a hard delete.

use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use globset::GlobBuilder;
use serde::{Deserialize, Serialize};
use walkdir::{DirEntry, WalkDir};

mod actions;
mod appearance;
mod archive;
mod bin_ops;
mod dnd;
mod git;
mod query;
mod spotlight;
mod system;
mod tags;
mod thumbs;
mod icons;
mod info;
mod batch;
mod jobs;
mod pasteboard;

use jobs::OpReport;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/// One filesystem entry, with the directory and file name split for display.
#[derive(Serialize, Clone)]
pub(crate) struct Entry {
    /// Full absolute path.
    path: String,
    /// File (or directory) name.
    name: String,
    /// Parent directory (used by search results; redundant while browsing).
    parent: String,
    is_dir: bool,
    is_symlink: bool,
    /// Size in bytes (0 for directories).
    size: u64,
    /// Last-modified time, seconds since the Unix epoch (None if unavailable).
    modified: Option<u64>,
    /// Creation (birth) time, seconds since the epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    created: Option<u64>,
    /// When it was put in its folder (Finder's "Date Added"), seconds since the epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<u64>,
    /// Unix permission bits (e.g. 0o755); 0 when unknown.
    mode: u32,
    /// Finder tags (omitted when untagged, which is almost always).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    tags: Vec<tags::Tag>,
}

/// Finder's "Date Added" (ATTR_CMN_ADDEDTIME), without following symlinks.
#[cfg(target_os = "macos")]
pub(crate) fn added_secs(path: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut req: libc::attrlist = unsafe { std::mem::zeroed() };
    req.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    req.commonattr = libc::ATTR_CMN_ADDEDTIME;
    #[repr(C, packed(4))]
    struct Buf { len: u32, ts: libc::timespec }
    let mut buf: Buf = unsafe { std::mem::zeroed() };
    let r = unsafe {
        libc::getattrlist(c.as_ptr(), &mut req as *mut _ as *mut libc::c_void, &mut buf as *mut _ as *mut libc::c_void,
            std::mem::size_of::<Buf>(), libc::FSOPT_NOFOLLOW as u32)
    };
    // Volumes without the attribute return a short buffer.
    if r != 0 || (buf.len as usize) < std::mem::size_of::<Buf>() { return None; }
    let secs = buf.ts.tv_sec;
    (secs > 0).then_some(secs as u64)
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn added_secs(_: &std::path::Path) -> Option<u64> { None }

pub(crate) fn modified_secs(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Build an `Entry` from a path plus its (already-fetched) metadata.
pub(crate) fn entry_from(
    path: &std::path::Path,
    follow_meta: Option<&std::fs::Metadata>,
    is_symlink: bool,
) -> Entry {
    let is_dir = follow_meta.map(|m| m.is_dir()).unwrap_or(false);
    Entry {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        parent: path
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        is_dir,
        is_symlink,
        size: follow_meta.filter(|m| m.is_file()).map(|m| m.len()).unwrap_or(0),
        modified: follow_meta.and_then(modified_secs),
        created: follow_meta
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs()),
        added: added_secs(path),
        mode: follow_meta.map(|m| { use std::os::unix::fs::PermissionsExt; m.permissions().mode() & 0o7777 }).unwrap_or(0),
        tags: tags::read_tags(path, is_symlink),
    }
}

/// Dirs first, then case-insensitive by name.
fn sort_entries(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct Listing {
    /// Canonical current directory.
    dir: String,
    /// Parent directory, if any (for the "up" action).
    parent: Option<String>,
    entries: Vec<Entry>,
}

/// List the immediate contents of a directory.
#[tauri::command]
fn list_dir(path: String, show_hidden: bool) -> Result<Listing, String> {
    let dir = std::fs::canonicalize(&path).map_err(|e| format!("Can't open {path}: {e}"))?;
    if !dir.is_dir() {
        return Err(format!("Not a folder: {}", dir.display()));
    }

    let read = std::fs::read_dir(&dir).map_err(|e| format!("Can't read {}: {e}", dir.display()))?;
    let mut entries = Vec::new();
    for de in read {
        let de = match de {
            Ok(d) => d,
            Err(_) => continue,
        };
        let name = de.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let p = de.path();
        // `metadata()` follows symlinks (so a linked folder navigates like a
        // folder); `symlink_metadata` tells us whether it *is* a link.
        let follow = p.metadata().ok();
        let is_symlink = p
            .symlink_metadata()
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        entries.push(entry_from(&p, follow.as_ref(), is_symlink));
    }
    sort_entries(&mut entries);

    Ok(Listing {
        dir: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// Entries for a list of paths (tag / Spotlight results), skipping vanished ones.
#[tauri::command]
fn entries_for(paths: Vec<String>, show_hidden: bool) -> Vec<Entry> {
    paths
        .iter()
        .map(std::path::Path::new)
        .filter(|p| show_hidden || !p.file_name().map(|n| n.to_string_lossy().starts_with('.')).unwrap_or(false))
        .filter_map(|p| {
            let link = p.symlink_metadata().ok()?.file_type().is_symlink();
            Some(entry_from(p, p.metadata().ok().as_ref(), link))
        })
        .collect()
}

/// The user's home directory — Fathom's starting location.
#[tauri::command]
fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "Could not find your home folder.".to_string())
}

// ---------------------------------------------------------------------------
// Search (recursive, under a root)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct SearchReq {
    root: String,
    query: String,
    #[serde(default = "default_true")]
    case_insensitive: bool,
    #[serde(default)]
    match_full_path: bool,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    include_dirs: bool,
    #[serde(default)]
    max_results: Option<usize>,
}

fn default_true() -> bool {
    true
}

#[derive(Serialize)]
struct SearchResult {
    hits: Vec<Entry>,
    scanned: usize,
    truncated: bool,
    elapsed_ms: u128,
}

fn is_hidden(entry: &DirEntry) -> bool {
    entry
        .file_name()
        .to_str()
        .map(|s| s.starts_with('.') && s != ".")
        .unwrap_or(false)
}

fn run_search(req: &SearchReq) -> Result<SearchResult, String> {
    let root = std::path::Path::new(&req.root);
    if !root.is_dir() {
        return Err(format!("Not a folder: {}", req.root));
    }

    // Words match names; filters (kind:, size:, modified:, tag:) narrow further.
    let parsed = query::parse(&req.query);
    let words = parsed.words.join(" ");
    let raw = words.trim();
    let has_meta = raw.chars().any(|c| matches!(c, '*' | '?' | '[' | ']'));
    let pattern = if raw.is_empty() {
        "*".to_string()
    } else if has_meta {
        raw.to_string()
    } else {
        format!("*{raw}*")
    };

    let glob = GlobBuilder::new(&pattern)
        .case_insensitive(req.case_insensitive)
        .literal_separator(false)
        .build()
        .map_err(|e| format!("Bad pattern “{pattern}”: {e}"))?
        .compile_matcher();

    let cap = req.max_results.unwrap_or(5000);
    let mut hits: Vec<Entry> = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;

    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| req.include_hidden || !is_hidden(e));

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.depth() == 0 {
            continue;
        }
        scanned += 1;

        let is_dir = entry.file_type().is_dir();
        if is_dir && !req.include_dirs {
            continue;
        }
        let path = entry.path();
        let name = match entry.file_name().to_str() {
            Some(n) => n,
            None => continue,
        };
        let hay = if req.match_full_path {
            path.strip_prefix(root)
                .unwrap_or(path)
                .to_string_lossy()
                .into_owned()
        } else {
            name.to_string()
        };
        if !glob.is_match(&hay) {
            continue;
        }

        let follow = entry.metadata().ok();
        let is_symlink = entry.path_is_symlink();
        let e = entry_from(path, follow.as_ref(), is_symlink);
        if parsed.has_filters() && !query::passes(&parsed, path, e.is_dir, e.size, e.modified, &e.tags) {
            continue;
        }
        hits.push(e);

        if hits.len() >= cap {
            truncated = true;
            break;
        }
    }

    sort_entries(&mut hits);
    Ok(SearchResult {
        hits,
        scanned,
        truncated,
        elapsed_ms: 0,
    })
}

/// Recursive search under `root`. Runs on a blocking thread so the UI stays live.
#[tauri::command]
async fn search(req: SearchReq) -> Result<SearchResult, String> {
    let started = Instant::now();
    let mut result = tauri::async_runtime::spawn_blocking(move || run_search(&req))
        .await
        .map_err(|e| format!("search task panicked: {e}"))??;
    result.elapsed_ms = started.elapsed().as_millis();
    Ok(result)
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

// --- Move / Copy (twin-pane and "…to" pickers) -----------------------------

/// A non-colliding destination inside `dir` for an item named `name`.
/// Returns `(path, renamed)` — `renamed` is true when we had to append a
/// " copy" suffix (Finder-style) to avoid overwriting an existing item.
/// We NEVER overwrite: collisions are resolved by renaming, so no data is lost.
pub(crate) fn unique_dest(dir: &Path, name: &str) -> (PathBuf, bool) {
    let first = dir.join(name);
    if !first.exists() {
        return (first, false);
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut n = 1u32;
    loop {
        let cand = if n == 1 {
            format!("{stem} copy{ext}")
        } else {
            format!("{stem} copy {n}{ext}")
        };
        let cp = dir.join(&cand);
        if !cp.exists() {
            return (cp, true);
        }
        n += 1;
    }
}

/// Recursively copy a file, directory, or symlink from `src` to `dst`.
/// Symlinks are recreated as links (their targets are not followed/duplicated).
pub(crate) fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let md = std::fs::symlink_metadata(src)?;
    let ft = md.file_type();
    if ft.is_symlink() {
        let target = std::fs::read_link(src)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, dst)?;
        #[cfg(not(unix))]
        {
            std::fs::copy(src, dst)?;
        }
    } else if ft.is_dir() {
        std::fs::create_dir(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

pub(crate) fn remove_path(p: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(p)?.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// True if `dest` is the source itself or lives inside it — moving/copying a
/// folder into its own subtree would loop or destroy it, so we refuse.
pub(crate) fn dest_inside_source(src: &Path, dest: &Path) -> bool {
    let s = std::fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    let d = std::fs::canonicalize(dest).unwrap_or_else(|_| dest.to_path_buf());
    d == s || d.starts_with(&s)
}

/// Move each `[from, to]` pair to exactly `to` — used to undo a move. Refuses
/// (per item) if `to` is already occupied, so an undo can never overwrite.
fn move_exact(pairs: Vec<[String; 2]>) -> OpReport {
    let mut rep = OpReport::default();
    for [from, to] in pairs {
        let (src, dst) = (Path::new(&from), Path::new(&to));
        if !src.exists() {
            rep.errors.push(format!("{from}: no longer exists"));
            continue;
        }
        if std::fs::symlink_metadata(dst).is_ok() {
            rep.errors.push(format!("{to}: something is already there"));
            continue;
        }
        if let Some(parent) = dst.parent() {
            let _ = std::fs::create_dir_all(parent); // a merged move may have removed it
        }
        let res = match std::fs::rename(src, dst) {
            Ok(()) => Ok(()),
            Err(_) => copy_recursive(src, dst).and_then(|_| remove_path(src)),
        };
        match res {
            Ok(()) => {
                rep.done += 1;
                rep.pairs.push([from, to]);
            }
            Err(e) => rep.errors.push(format!("{from}: {e}")),
        }
    }
    rep
}

#[tauri::command]
async fn move_exact_paths(pairs: Vec<[String; 2]>) -> Result<OpReport, String> {
    tauri::async_runtime::spawn_blocking(move || move_exact(pairs))
        .await
        .map_err(|e| format!("move task panicked: {e}"))
}

// --- Create / rename ---------------------------------------------------------

/// Reject names that can't be a single path component.
pub(crate) fn check_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("A name can't be empty.".into());
    }
    if n == "." || n == ".." {
        return Err(format!("“{n}” is reserved."));
    }
    if n.contains('/') || n.contains('\0') {
        return Err("Names can't contain “/”.".into());
    }
    Ok(n)
}

/// `dir/base`, or `dir/base 2`, `dir/base 3`… — the first free one.
pub(crate) fn unique_new(dir: &Path, base: &str) -> PathBuf {
    let first = dir.join(base);
    if !first.exists() {
        return first;
    }
    let p = Path::new(base);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| base.into());
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2u32..)
        .map(|n| dir.join(format!("{stem} {n}{ext}")))
        .find(|c| !c.exists())
        .expect("unbounded range")
}

/// Create a new folder (or empty file) inside `parent`, picking a free name
/// based on `name`. Returns the created path.
#[tauri::command]
fn create_item(parent: String, name: String, is_dir: bool) -> Result<String, String> {
    let name = check_name(&name)?;
    let dir = Path::new(&parent);
    if !dir.is_dir() {
        return Err(format!("Not a folder: {parent}"));
    }
    let target = unique_new(dir, name);
    if is_dir {
        std::fs::create_dir(&target)
    } else {
        std::fs::OpenOptions::new().write(true).create_new(true).open(&target).map(|_| ())
    }
    .map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Rename `path` to `new_name` in place. Never overwrites an existing item —
/// except a case-only rename of the item itself (APFS is case-insensitive).
#[tauri::command]
fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let new_name = check_name(&new_name)?;
    let src = Path::new(&path);
    let parent = src.parent().ok_or("Can't rename the root.")?;
    let target = parent.join(new_name);
    if target == src {
        return Ok(path);
    }
    if target.exists() {
        let same = match (std::fs::canonicalize(src), std::fs::canonicalize(&target)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if !same {
            return Err(format!("“{new_name}” already exists here."));
        }
    }
    std::fs::rename(src, &target).map_err(|e| format!("Couldn't rename: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

// --- Volume info / Terminal --------------------------------------------------

#[derive(Serialize)]
struct Space {
    free: u64,
    total: u64,
}

/// Free / total bytes on the volume holding `path`.
#[tauri::command]
fn free_space(path: String) -> Result<Space, String> {
    #[cfg(unix)]
    {
        use std::ffi::CString;
        let c = CString::new(path.as_bytes()).map_err(|_| "bad path".to_string())?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let frag = st.f_frsize as u64;
        Ok(Space {
            free: st.f_bavail as u64 * frag,
            total: st.f_blocks as u64 * frag,
        })
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err("Free space is only available on Unix.".into())
    }
}

// --- Image thumbnails / previews -------------------------------------------

/// A downscaled preview of an image, plus the original pixel dimensions.
#[derive(Serialize)]
struct Thumb {
    /// PNG data URI of the downscaled image.
    data: String,
    /// Original width/height, so the UI can show "1920 × 1080".
    w: u32,
    h: u32,
}

/// Decode `path`, downscale so its longest edge is `max_edge`, and return it as
/// a PNG data URI. Used both for small inline row thumbnails and the larger
/// Space-to-preview. Runs on a blocking thread — decoding is CPU-bound.
#[tauri::command]
async fn thumbnail(path: String, max_edge: u32) -> Result<Thumb, String> {
    use base64::Engine as _;
    tauri::async_runtime::spawn_blocking(move || {
        let img = image::open(&path).map_err(|e| format!("Can't preview {path}: {e}"))?;
        let (w, h) = (img.width(), img.height());
        let edge = max_edge.clamp(16, 4096);
        let thumb = img.thumbnail(edge, edge); // fast, preserves aspect ratio
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("encode failed: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(buf.get_ref());
        Ok(Thumb {
            data: format!("data:image/png;base64,{b64}"),
            w,
            h,
        })
    })
    .await
    .map_err(|e| format!("thumbnail task panicked: {e}"))?
}

/// Generate a thumbnail via macOS Quick Look — for file types the `image` crate
/// can't decode (video, and in future PDF etc.). Shells out to `qlmanage -t`,
/// which renders into a temp dir; we read the PNG back as a data URI. Runs on a
/// blocking thread (Quick Look can take a beat). `w`/`h` are 0 (the frame's own
/// size isn't the source's resolution, so the UI just shows the file size).
#[cfg(target_os = "macos")]
#[tauri::command]
async fn ql_thumbnail(path: String, max_edge: u32) -> Result<Thumb, String> {
    use base64::Engine as _;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);

    tauri::async_runtime::spawn_blocking(move || {
        let size = max_edge.clamp(32, 2048);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let mut outdir = std::env::temp_dir();
        outdir.push(format!("fathom-ql-{}-{}", std::process::id(), seq));
        std::fs::create_dir_all(&outdir).map_err(|e| format!("temp dir: {e}"))?;

        // Best-effort cleanup guard: remove the temp dir whatever happens.
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = Cleanup(outdir.clone());

        let status = std::process::Command::new("qlmanage")
            .args(["-t", "-s", &size.to_string(), "-o"])
            .arg(&outdir)
            .arg(&path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|e| format!("qlmanage failed to run: {e}"))?;
        let _ = status; // qlmanage can exit 0 yet produce nothing — trust the output file, not the code.

        // Quick Look writes "<name>.png" into outdir; grab whatever PNG appeared.
        let png = std::fs::read_dir(&outdir)
            .map_err(|e| format!("read temp: {e}"))?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .find(|p| p.extension().map(|x| x.eq_ignore_ascii_case("png")).unwrap_or(false));
        let bytes = match png {
            Some(p) => std::fs::read(&p).map_err(|e| format!("read thumb: {e}"))?,
            None => return Err("no Quick Look preview for this file".into()),
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(Thumb {
            data: format!("data:image/png;base64,{b64}"),
            w: 0,
            h: 0,
        })
    })
    .await
    .map_err(|e| format!("quick look task panicked: {e}"))?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn ql_thumbnail(_path: String, _max_edge: u32) -> Result<Thumb, String> {
    Err("Quick Look thumbnails are only available on macOS.".into())
}

/// Read an SVG file and return it as a data URI. SVG is vector XML the `image`
/// crate can't rasterize, but the webview renders it natively and crisply — so
/// we hand it the source directly rather than making a thumbnail.
#[tauri::command]
fn svg_data_uri(path: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = std::fs::read(&path).map_err(|e| format!("Can't read {path}: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:image/svg+xml;base64,{b64}"))
}

/// Reveal a path in Finder (selects the item in its enclosing folder).
#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("could not reveal {path}: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Reveal in Finder is only available on macOS.".into())
    }
}

/// Open a path with the OS default handler (double-click behaviour).
#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");

    cmd.arg(&path)
        .spawn()
        .map_err(|e| format!("could not open {path}: {e}"))?;
    Ok(())
}

// --- Places (sidebar) ---------------------------------------------------------

#[derive(Serialize)]
struct Place {
    name: String,
    path: String,
    kind: &'static str,
}

#[derive(Serialize)]
struct Volume {
    name: String,
    path: String,
    is_root: bool,
}

#[derive(Serialize)]
struct Places {
    home: String,
    standard: Vec<Place>,
    icloud: Option<String>,
    volumes: Vec<Volume>,
}

fn canon(p: &Path) -> String {
    std::fs::canonicalize(p)
        .unwrap_or_else(|_| p.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// Everything the Places sidebar shows: standard folders that exist, iCloud
/// Drive (if set up), and mounted volumes. Paths are canonical so they match
/// the pane's `cwd` for highlighting.
#[tauri::command]
fn places() -> Result<Places, String> {
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "No HOME".to_string())?);
    let mut standard = vec![Place { name: "Home".into(), path: canon(&home), kind: "home" }];
    for (name, kind) in [
        ("Desktop", "desktop"),
        ("Documents", "documents"),
        ("Downloads", "downloads"),
        ("Pictures", "pictures"),
    ] {
        let p = home.join(name);
        if p.is_dir() {
            standard.push(Place { name: name.into(), path: canon(&p), kind });
        }
    }
    if Path::new("/Applications").is_dir() {
        standard.push(Place { name: "Applications".into(), path: "/Applications".into(), kind: "applications" });
    }
    let icloud = home.join("Library/Mobile Documents/com~apple~CloudDocs");
    let icloud = icloud.is_dir().then(|| canon(&icloud));

    let mut volumes = Vec::new();
    if let Ok(rd) = std::fs::read_dir("/Volumes") {
        for de in rd.flatten() {
            let name = de.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with("com.apple.") {
                continue;
            }
            let p = de.path();
            if !p.is_dir() {
                continue;
            }
            let c = canon(&p);
            let is_root = c == "/";
            volumes.push(Volume { name, path: if is_root { "/".into() } else { p.to_string_lossy().into_owned() }, is_root });
        }
    }
    volumes.sort_by(|a, b| b.is_root.cmp(&a.is_root).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(Places { home: canon(&home), standard, icloud, volumes })
}

/// Eject / unmount a volume (`diskutil eject`). Blocking — disks can take a moment.
#[tauri::command]
async fn eject_volume(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            let out = std::process::Command::new("diskutil")
                .args(["eject", &path])
                .output()
                .map_err(|e| format!("diskutil failed to run: {e}"))?;
            if out.status.success() {
                Ok(())
            } else {
                let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let msg = if msg.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { msg };
                Err(if msg.is_empty() { "Couldn't eject — is something using it?".into() } else { msg })
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = path;
            Err("Eject is only available on macOS.".to_string())
        }
    })
    .await
    .map_err(|e| format!("eject task panicked: {e}"))?
}

// --- Folder watching (auto-refresh) ------------------------------------------

/// One FSEvents-backed watcher for the folders currently on screen. When
/// anything inside a watched folder changes we emit `fs-changed` with that
/// folder's path; the UI debounces and refreshes the matching panes.
struct WatchState {
    watcher: std::sync::Mutex<Option<notify::RecommendedWatcher>>,
    dirs: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<PathBuf>>>,
}

#[tauri::command]
fn watch_dirs(
    app: tauri::AppHandle,
    state: tauri::State<WatchState>,
    paths: Vec<String>,
) -> Result<(), String> {
    use notify::{EventKind, RecursiveMode, Watcher};
    use std::collections::HashSet;
    use tauri::Emitter;

    let mut guard = state.watcher.lock().map_err(|_| "watcher poisoned")?;
    if guard.is_none() {
        let dirs = state.dirs.clone();
        let w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if matches!(ev.kind, EventKind::Access(_)) {
                return;
            }
            let hit: HashSet<PathBuf> = {
                let Ok(dirs) = dirs.lock() else { return };
                ev.paths
                    .iter()
                    .filter_map(|p| {
                        if dirs.contains(p) {
                            Some(p.clone())
                        } else {
                            p.parent().filter(|par| dirs.contains(*par)).map(Path::to_path_buf)
                        }
                    })
                    .collect()
            };
            for d in hit {
                let _ = app.emit("fs-changed", d.to_string_lossy().into_owned());
            }
        })
        .map_err(|e| format!("can't start watcher: {e}"))?;
        *guard = Some(w);
    }
    let watcher = guard.as_mut().expect("just set");

    let new: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
    // Swap the set first and release its lock before touching the watcher —
    // the event callback takes the same lock on another thread.
    let old = {
        let mut dirs = state.dirs.lock().map_err(|_| "watch set poisoned")?;
        std::mem::replace(&mut *dirs, new.clone())
    };
    for gone in old.difference(&new) {
        let _ = watcher.unwatch(gone);
    }
    for added in new.difference(&old) {
        let _ = watcher.watch(added, RecursiveMode::NonRecursive);
    }
    Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(std::sync::Arc::new(jobs::Jobs::default()))
        .manage(std::sync::Arc::new(spotlight::Spotlight::default()))
        .manage(std::sync::Arc::new(actions::Actions::default()))
        .manage(WatchState {
            watcher: std::sync::Mutex::new(None),
            dirs: Default::default(),
        })
        .invoke_handler(tauri::generate_handler![
            appearance::appearance,
            thumbs::file_thumb,
            icons::file_icons,
            info::file_info,
            info::dir_size,
            info::dir_size_cancel,
            info::set_mode,
            places,
            eject_volume,
            watch_dirs,
            list_dir,
            home_dir,
            search,
            bin_ops::move_to_trash,
            dnd::start_drag,
            dnd::drop_action,
            dnd::classify_paths,
            tags::set_tags,
            tags::tag_list,
            tags::tag_search,
            entries_for,
            spotlight::spotlight_search,
            spotlight::spotlight_cancel,
            git::git_status,
            git::git_changes,
            git::git_commit,
            git::git_push,
            system::open_with_apps,
            system::open_with,
            system::file_icon,
            system::share,
            system::quick_look,
            system::quick_look_close,
            jobs::plan_transfer,
            jobs::start_transfer,
            jobs::start_duplicate,
            jobs::cancel_job,
            archive::start_compress,
            archive::start_extract,
            pasteboard::pasteboard_write,
            pasteboard::pasteboard_read,
            batch::batch_rename_cmd,
            move_exact_paths,
            create_item,
            rename_path,
            free_space,
            actions::open_terminal,
            actions::config_read,
            actions::config_write,
            actions::run_action,
            actions::cancel_action,
            thumbnail,
            ql_thumbnail,
            svg_data_uri,
            reveal_in_finder,
            open_path
        ])
        // Remember mouse-downs: a drag that leaves the window starts from one.
        .setup(|_| {
            dnd::install_mouse_monitor();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Fathom");
}

#[cfg(test)]
mod tests {
    #[test]
    fn entries_carry_created_added_and_mode() {
        let d = std::env::temp_dir().join(format!("fathom-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("x.sh");
        std::fs::write(&f, "echo").unwrap();
        { use std::os::unix::fs::PermissionsExt; std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o750)).unwrap(); }
        let e = super::entry_from(&f, f.metadata().ok().as_ref(), false);
        assert_eq!(e.mode, 0o750);
        assert!(e.created.is_some());
        assert!(e.added.is_some(), "APFS records a date added");
        let _ = std::fs::remove_dir_all(&d);
    }

    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fathom-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn create_picks_free_names() {
        let d = tmp("create");
        let a = create_item(s(&d), "New Folder".into(), true).unwrap();
        let b = create_item(s(&d), "New Folder".into(), true).unwrap();
        let f = create_item(s(&d), "New File.txt".into(), false).unwrap();
        let g = create_item(s(&d), "New File.txt".into(), false).unwrap();
        assert!(a.ends_with("/New Folder") && b.ends_with("/New Folder 2"));
        assert!(f.ends_with("/New File.txt") && g.ends_with("/New File 2.txt"));
        assert!(create_item(s(&d), "a/b".into(), true).is_err());
        assert!(create_item(s(&d), "  ".into(), true).is_err());
    }

    #[test]
    fn rename_never_overwrites_but_allows_case_change() {
        let d = tmp("rename");
        std::fs::write(d.join("a.txt"), "A").unwrap();
        std::fs::write(d.join("b.txt"), "B").unwrap();
        assert!(rename_path(s(&d.join("a.txt")), "b.txt".into()).is_err());
        assert_eq!(std::fs::read_to_string(d.join("b.txt")).unwrap(), "B");
        let np = rename_path(s(&d.join("a.txt")), "A.txt".into()).unwrap();
        assert!(np.ends_with("/A.txt"));
        let names: Vec<_> = std::fs::read_dir(&d).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert!(names.iter().any(|n| n == "A.txt"));
    }

    #[test]
    fn move_exact_refuses_occupied_target_and_undo_roundtrips() {
        let d = tmp("mvx");
        let (src, dst) = (d.join("src"), d.join("dst"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::write(src.join("f"), "1").unwrap();
        let rep = xfer(vec![src.join("f")], &dst, true, jobs::Policy::KeepBoth);
        assert_eq!(rep.pairs.len(), 1);
        // Undo: move back to the exact original spot.
        let back = move_exact(rep.pairs.iter().map(|[a, b]| [b.clone(), a.clone()]).collect());
        assert_eq!(back.done, 1);
        assert!(src.join("f").exists());
        // Occupied target is refused, nothing clobbered.
        std::fs::write(dst.join("f"), "2").unwrap();
        let r = move_exact(vec![[s(&src.join("f")), s(&dst.join("f"))]]);
        assert_eq!(r.done, 0);
        assert_eq!(std::fs::read_to_string(dst.join("f")).unwrap(), "2");
    }

    fn xfer(srcs: Vec<PathBuf>, dest: &Path, do_move: bool, policy: jobs::Policy) -> OpReport {
        let items = srcs.into_iter().map(|src| jobs::Item { src, dest_dir: dest.to_path_buf(), policy }).collect();
        jobs::run(items, do_move, &mut jobs::Ctl::detached())
    }

    #[test]
    fn duplicate_lands_next_to_source() {
        let d = tmp("dup");
        std::fs::write(d.join("x.png"), "x").unwrap();
        let rep = xfer(vec![d.join("x.png")], &d, false, jobs::Policy::KeepBoth);
        assert!(rep.pairs[0][1].ends_with("/x copy.png"));
    }

    #[test]
    fn skip_leaves_both_untouched() {
        let d = tmp("skip");
        let (a, b) = (d.join("a"), d.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("f"), "new").unwrap();
        std::fs::write(b.join("f"), "old").unwrap();
        let rep = xfer(vec![a.join("f")], &b, true, jobs::Policy::Skip);
        assert_eq!((rep.done, rep.skipped), (0, 1));
        assert_eq!(std::fs::read_to_string(b.join("f")).unwrap(), "old");
        assert!(a.join("f").exists());
    }

    #[test]
    fn merge_folders_keeps_both_on_file_clash_and_undoes() {
        let d = tmp("merge");
        let (src, dst) = (d.join("src/Photos"), d.join("dst/Photos"));
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::create_dir_all(dst.join("sub")).unwrap();
        std::fs::write(src.join("a.jpg"), "A").unwrap();
        std::fs::write(src.join("same.jpg"), "new").unwrap();
        std::fs::write(src.join("sub/x"), "x").unwrap();
        std::fs::write(dst.join("same.jpg"), "old").unwrap();
        let rep = xfer(vec![src.clone()], &d.join("dst"), true, jobs::Policy::Merge);
        assert_eq!(rep.merged, 1, "{rep:?}");
        assert!(dst.join("a.jpg").exists() && dst.join("sub/x").exists());
        assert_eq!(std::fs::read_to_string(dst.join("same.jpg")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(dst.join("same copy.jpg")).unwrap(), "new");
        assert!(!src.exists(), "emptied source folder is removed");
        // Undo puts every piece back, recreating the removed folder.
        let back = move_exact(rep.pairs.iter().map(|[a, b]| [b.clone(), a.clone()]).collect());
        assert!(back.errors.is_empty(), "{:?}", back.errors);
        assert_eq!(std::fs::read_to_string(src.join("same.jpg")).unwrap(), "new");
        assert!(src.join("sub/x").exists());
    }

    #[test]
    fn cancelled_job_does_nothing() {
        let d = tmp("cancel");
        std::fs::write(d.join("f"), "x").unwrap();
        std::fs::create_dir_all(d.join("out")).unwrap();
        let mut ctl = jobs::Ctl::detached();
        ctl.cancel_now();
        let rep = jobs::run(vec![jobs::Item { src: d.join("f"), dest_dir: d.join("out"), policy: jobs::Policy::KeepBoth }], false, &mut ctl);
        assert_eq!(rep.done, 0);
        assert!(!d.join("out/f").exists());
    }

    #[test]
    fn batch_rename_swaps_and_refuses_clashes() {
        let d = tmp("batch");
        std::fs::write(d.join("a"), "A").unwrap();
        std::fs::write(d.join("b"), "B").unwrap();
        std::fs::write(d.join("c"), "C").unwrap();
        let r = batch::batch_rename(vec![[s(&d.join("a")), "b".into()], [s(&d.join("b")), "a".into()]]).unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(std::fs::read_to_string(d.join("a")).unwrap(), "B");
        assert_eq!(std::fs::read_to_string(d.join("b")).unwrap(), "A");
        // "c" exists and isn't being renamed away → refused, nothing touched.
        assert!(batch::batch_rename(vec![[s(&d.join("a")), "c".into()]]).is_err());
        assert!(batch::batch_rename(vec![[s(&d.join("a")), "x".into()], [s(&d.join("b")), "X".into()]]).is_err());
        assert_eq!(std::fs::read_to_string(d.join("c")).unwrap(), "C");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn zip_roundtrip() {
        let d = tmp("zip");
        std::fs::create_dir_all(d.join("proj/src")).unwrap();
        std::fs::write(d.join("proj/src/main.rs"), "fn main(){}").unwrap();
        let rep = archive::compress(vec![d.join("proj")], &mut jobs::Ctl::detached());
        assert!(rep.errors.is_empty(), "{:?}", rep.errors);
        assert!(d.join("proj.zip").exists());
        let rep = archive::extract(d.join("proj.zip"), &mut jobs::Ctl::detached());
        assert!(rep.errors.is_empty(), "{:?}", rep.errors);
        // Single top-level folder comes out as itself, renamed to avoid the original.
        assert!(rep.pairs[0][1].ends_with("/proj copy"), "{:?}", rep.pairs);
        assert_eq!(std::fs::read_to_string(d.join("proj copy/src/main.rs")).unwrap(), "fn main(){}");
    }
}
