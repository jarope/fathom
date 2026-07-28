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

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/// One filesystem entry, with the directory and file name split for display.
#[derive(Serialize)]
struct Entry {
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
}

fn modified_secs(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Build an `Entry` from a path plus its (already-fetched) metadata.
fn entry_from(
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

    let raw = req.query.trim();
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
        hits.push(entry_from(path, follow.as_ref(), is_symlink));

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

/// Move one or more paths to the OS Bin. Recoverable — this is NOT a delete.
/// Reports how many were binned, and surfaces any that failed.
#[tauri::command]
fn move_to_trash(paths: Vec<String>) -> Result<usize, String> {
    let mut binned = 0usize;
    let mut errors = Vec::new();
    for p in &paths {
        match trash::delete(p) {
            Ok(()) => binned += 1,
            Err(e) => errors.push(format!("{p}: {e}")),
        }
    }
    if errors.is_empty() {
        Ok(binned)
    } else {
        Err(errors.join("; "))
    }
}

// --- Move / Copy (twin-pane and "…to" pickers) -----------------------------

/// A non-colliding destination inside `dir` for an item named `name`.
/// Returns `(path, renamed)` — `renamed` is true when we had to append a
/// " copy" suffix (Finder-style) to avoid overwriting an existing item.
/// We NEVER overwrite: collisions are resolved by renaming, so no data is lost.
fn unique_dest(dir: &Path, name: &str) -> (PathBuf, bool) {
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
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
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

fn remove_path(p: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(p)?.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// True if `dest` is the source itself or lives inside it — moving/copying a
/// folder into its own subtree would loop or destroy it, so we refuse.
fn dest_inside_source(src: &Path, dest: &Path) -> bool {
    let s = std::fs::canonicalize(src).unwrap_or_else(|_| src.to_path_buf());
    let d = std::fs::canonicalize(dest).unwrap_or_else(|_| dest.to_path_buf());
    d == s || d.starts_with(&s)
}

/// Outcome summary for a batch move/copy.
#[derive(Serialize, Default)]
struct OpReport {
    done: usize,
    renamed: usize,
    skipped: usize,
    errors: Vec<String>,
}

/// Shared move/copy engine. `do_move` picks move (rename, with copy+remove
/// fallback across volumes) vs copy. Never overwrites; never follows a folder
/// into itself.
fn transfer(sources: Vec<String>, dest_dir: String, do_move: bool) -> Result<OpReport, String> {
    let dest = std::fs::canonicalize(&dest_dir)
        .map_err(|e| format!("Bad destination {dest_dir}: {e}"))?;
    if !dest.is_dir() {
        return Err(format!("Destination is not a folder: {}", dest.display()));
    }

    let mut rep = OpReport::default();
    for s in &sources {
        let src = Path::new(s);
        if !src.exists() {
            rep.errors.push(format!("{s}: no longer exists"));
            continue;
        }
        let name = match src.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => {
                rep.errors.push(format!("{s}: unreadable name"));
                continue;
            }
        };
        if src.is_dir() && dest_inside_source(src, &dest) {
            rep.errors.push(format!("{name}: can't put a folder inside itself"));
            continue;
        }
        // Moving an item into the folder it already lives in is a no-op.
        if do_move {
            if let Some(parent) = src.parent() {
                let pc = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
                if pc == dest {
                    rep.skipped += 1;
                    continue;
                }
            }
        }

        let (target, renamed) = unique_dest(&dest, &name);
        let res = if do_move {
            match std::fs::rename(src, &target) {
                Ok(()) => Ok(()),
                // Cross-device rename (EXDEV) or similar — fall back to copy+remove.
                Err(_) => copy_recursive(src, &target).and_then(|_| remove_path(src)),
            }
        } else {
            copy_recursive(src, &target)
        };

        match res {
            Ok(()) => {
                rep.done += 1;
                if renamed {
                    rep.renamed += 1;
                }
            }
            Err(e) => rep.errors.push(format!("{name}: {e}")),
        }
    }
    Ok(rep)
}

/// Move items into `dest_dir`. Runs on a blocking thread (big trees).
#[tauri::command]
async fn move_paths(sources: Vec<String>, dest_dir: String) -> Result<OpReport, String> {
    tauri::async_runtime::spawn_blocking(move || transfer(sources, dest_dir, true))
        .await
        .map_err(|e| format!("move task panicked: {e}"))?
}

/// Copy items into `dest_dir`. Runs on a blocking thread (big trees).
#[tauri::command]
async fn copy_paths(sources: Vec<String>, dest_dir: String) -> Result<OpReport, String> {
    tauri::async_runtime::spawn_blocking(move || transfer(sources, dest_dir, false))
        .await
        .map_err(|e| format!("copy task panicked: {e}"))?
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_dir,
            home_dir,
            search,
            move_to_trash,
            move_paths,
            copy_paths,
            thumbnail,
            ql_thumbnail,
            svg_data_uri,
            reveal_in_finder,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running Fathom");
}
