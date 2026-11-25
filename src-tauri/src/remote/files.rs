//! Changing things on a server: new folder / file, rename, delete, and
//! opening a file in its app with saves going back up (SFTP Phase C).
//!
//! Open & save back: the file is downloaded into Fathom's cache (keeping its
//! real name, so the right app opens it) and opened. A watcher on the cache
//! notices saves — including apps that save by writing a new file and
//! renaming it — and uploads each one through a hidden ".fathom-part" file
//! that replaces the original only once complete. If the server's copy
//! changed since it was downloaded, the page is asked first (Upload anyway /
//! Save as a copy / Don't upload).

use super::xfer::{self, Fs};
use crate::jobs::{spawn_job, Ctl, Jobs, OpReport};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, State};

fn split(loc: &str) -> Result<(String, String), String> {
    let (conn, p) = super::parse(loc).ok_or_else(|| format!("Not a server location: {loc}"))?;
    Ok((conn, p.ok_or("Open the folder first")?))
}

/// The browsing side of a server, as an Fs (logs in again if it had dropped).
fn side(conn: &str) -> Result<Fs, String> {
    let c = super::get(conn, false)?;
    let s = c.sftp().ok_or("The connection to the server was lost")?;
    Ok(Fs::Remote { conn: conn.to_string(), s })
}

/// "name", or "name 2", "name 3"… — the first free one (matches the Mac's).
fn unique_new(fs: &Fs, dir: &str, base: &str) -> String {
    let first = xfer::join(dir, base);
    if !matches!(fs.lstat(&first), Ok(Some(_))) { return first; }
    let (stem, ext) = match base.rfind('.') { Some(i) if i > 0 => (&base[..i], &base[i..]), _ => (base, "") };
    (2..).map(|n| xfer::join(dir, &format!("{stem} {n}{ext}"))).find(|c| !matches!(fs.lstat(c), Ok(Some(_)))).unwrap()
}

/// create_item for sftp:// folders.
pub fn create(parent: &str, name: &str, is_dir: bool) -> Result<String, String> {
    let name = crate::check_name(name)?;
    let (conn, dir) = split(parent)?;
    let fs = side(&conn)?;
    let Fs::Remote { s, .. } = &fs else { unreachable!() };
    let target = unique_new(&fs, &dir, name);
    let r = if is_dir { s.mkdir(&target) } else {
        s.open(&target, super::sftp::O_WRITE | super::sftp::O_CREAT | super::sftp::O_EXCL, Some(0o644)).and_then(|h| s.close(&h))
    };
    r.map_err(|e| format!("Couldn't create {name}: {e}"))?;
    Ok(super::url(&conn, &target))
}

/// rename_path for sftp:// items. Never replaces an existing item.
pub fn rename(path: &str, new_name: &str) -> Result<String, String> {
    let new_name = crate::check_name(new_name)?;
    let (conn, src) = split(path)?;
    let parent = super::parent_of(&src).ok_or("Can't rename the top of the server.")?;
    let target = xfer::join(&parent, new_name);
    if target == src { return Ok(path.to_string()); }
    let fs = side(&conn)?;
    let Fs::Remote { s, .. } = &fs else { unreachable!() };
    // Servers are usually case-sensitive, so "a" → "A" is just another name;
    // anything that exists already is refused.
    if matches!(fs.lstat(&target), Ok(Some(_))) { return Err(format!("“{new_name}” already exists here.")); }
    s.rename(&src, &target).map_err(|e| format!("Couldn't rename: {e}"))?;
    Ok(super::url(&conn, &target))
}

/// Delete server items for good (there's no Bin) — a job with progress.
#[tauri::command]
pub fn sftp_delete(app: AppHandle, jobs: State<'_, Arc<Jobs>>, paths: Vec<String>) -> Result<u64, String> {
    Ok(spawn_job(app, jobs.inner().clone(), move |ctl| delete(paths, ctl)))
}

fn delete(paths: Vec<String>, ctl: &mut Ctl) -> OpReport {
    let mut rep = OpReport::default();
    ctl.phase = "delete";
    ctl.total_items = paths.len() as u64;
    ctl.tick(true);
    let mut sides: HashMap<String, Fs> = HashMap::new();
    for loc in paths {
        if ctl.cancelled() { break; }
        let (conn, p) = match split(&loc) { Ok(x) => x, Err(e) => { rep.errors.push(e); continue } };
        if p == "/" { rep.errors.push("Fathom won't delete the top of a server.".into()); continue; }
        if !sides.contains_key(&conn) {
            match side(&conn) { Ok(f) => { sides.insert(conn.clone(), f); } Err(e) => { rep.errors.push(e); continue } }
        }
        ctl.current = p.rsplit('/').next().unwrap_or(&p).to_string();
        ctl.tick(false);
        match sides[&conn].remove_tree(&p, Some(ctl)) {
            Ok(()) => { rep.done += 1; rep.pairs.push([loc.clone(), String::new()]); }
            Err(e) if crate::jobs::is_cancel(&e) => break,
            Err(e) => rep.errors.push(format!("{}: {e}", ctl.current)),
        }
        ctl.done_items += 1;
        ctl.tick(false);
    }
    ctl.tick(true);
    rep
}

// ---------------------------------------------------------------- open & save back

/// One server file open in an app.
struct Open {
    url: String,
    local: PathBuf,
    /// The server copy's mtime / size when we last downloaded or uploaded it.
    remote_mtime: Option<u64>,
    remote_size: u64,
    /// The cached copy's mtime after that — a different one means a save.
    local_mtime: Option<SystemTime>,
    busy: bool,
}

#[derive(Serialize, Clone)]
struct Synced {
    url: String,
    name: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct SyncConflict {
    url: String,
    name: String,
}

static OPEN: Mutex<Vec<Open>> = Mutex::new(Vec::new());
static WATCHER: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Fathom's cache folder for server files (cleared of week-old files at launch).
pub fn cache_root() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| "/tmp".into());
    home.join("Library/Caches/uk.jrpc.fathom/sftp")
}

fn short_hash(s: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    format!("{:012x}", h.finish() & 0xffff_ffff_ffff)
}

fn mtime(p: &Path) -> Option<SystemTime> { std::fs::metadata(p).and_then(|m| m.modified()).ok() }

/// At launch: drop cached files not touched for a week.
pub fn init(app: AppHandle) {
    let _ = APP.set(app);
    let root = cache_root();
    let week = Duration::from_secs(7 * 24 * 3600);
    for e in walkdir::WalkDir::new(&root).min_depth(1).contents_first(true).into_iter().flatten() {
        let old = e.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|a| a > week);
        if e.file_type().is_dir() { let _ = std::fs::remove_dir(e.path()); } else if old { let _ = std::fs::remove_file(e.path()); }
    }
}

fn watch() -> Result<(), String> {
    let cell = WATCHER.get_or_init(|| Mutex::new(None));
    let mut w = cell.lock().unwrap();
    if w.is_some() { return Ok(()); }
    use notify::{RecursiveMode, Watcher};
    let root = cache_root();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut watcher = notify::recommended_watcher(|res: notify::Result<notify::Event>| {
        let Ok(ev) = res else { return };
        for p in ev.paths { changed(&p); }
    }).map_err(|e| e.to_string())?;
    watcher.watch(&root, RecursiveMode::Recursive).map_err(|e| e.to_string())?;
    *w = Some(watcher);
    Ok(())
}

/// Download a server file and open it in its app; saves go back up.
#[tauri::command]
pub async fn sftp_open(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open(&path)).await.map_err(|e| e.to_string())?
}

fn open(url: &str) -> Result<(), String> {
    let (conn, p) = split(url)?;
    let name = p.rsplit('/').next().unwrap_or("file").to_string();
    let dir = cache_root().join(short_hash(&conn)).join(short_hash(&super::parent_of(&p).unwrap_or_default()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't prepare the cache: {e}"))?;
    let local = dir.join(&name);
    let fs = side(&conn)?;
    let m = fs.lstat(&p).map_err(|e| e.to_string())?.ok_or("It's no longer on the server")?;
    if m.is_dir { return Err("That's a folder".into()); }
    // Still open from before and not saved since? Reuse the cached copy only
    // if the server's copy hasn't moved on.
    let fresh = OPEN.lock().unwrap().iter().any(|o| o.url == url && o.remote_mtime == m.mtime && o.remote_size == m.size && o.local_mtime == mtime(&o.local));
    if !fresh {
        xfer::download(&fs, &p, &local).map_err(|e| format!("Couldn't download {name}: {e}"))?;
        let mut open = OPEN.lock().unwrap();
        open.retain(|o| o.url != url);
        open.push(Open { url: url.to_string(), local: local.clone(), remote_mtime: m.mtime, remote_size: m.size, local_mtime: mtime(&local), busy: false });
    }
    watch()?;
    std::process::Command::new("open").arg(&local).status().map_err(|e| e.to_string())
        .and_then(|s| if s.success() { Ok(()) } else { Err("No app could open it".into()) })
}

/// A file in the cache changed: if it's one we opened and it was saved, upload it.
fn changed(p: &Path) {
    let url = {
        let open = OPEN.lock().unwrap();
        match open.iter().find(|o| o.local == p) { Some(o) if !o.busy => o.url.clone(), _ => return }
    };
    // Let the app finish writing (and a save-by-rename settle).
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(900));
        sync(&url, None);
    });
}

/// Upload the cached copy of `url` if it was saved. `force`: the page's answer
/// to a clash ("upload" = replace anyway, "copy" = save beside it, "skip").
fn sync(url: &str, force: Option<&str>) {
    let (local, remote_mtime, remote_size) = {
        let mut open = OPEN.lock().unwrap();
        let Some(o) = open.iter_mut().find(|o| o.url == url) else { return };
        if o.busy { return; }
        if force.is_none() && mtime(&o.local) == o.local_mtime { return; } // not a save (e.g. our own download)
        o.busy = true;
        (o.local.clone(), o.remote_mtime, o.remote_size)
    };
    let done = |ok: bool, error: Option<String>, new_remote: Option<(Option<u64>, u64)>, mark_local: bool| {
        let mut open = OPEN.lock().unwrap();
        if let Some(o) = open.iter_mut().find(|o| o.url == url) {
            o.busy = false;
            if let Some((m, s)) = new_remote { o.remote_mtime = m; o.remote_size = s; }
            if mark_local { o.local_mtime = mtime(&o.local); }
        }
        drop(open);
        let name = url.rsplit('/').next().unwrap_or(url).to_string();
        if let Some(a) = APP.get() { let _ = a.emit("sftp-synced", Synced { url: url.to_string(), name, ok, error }); }
    };
    let res = (|| -> Result<Option<(Option<u64>, u64)>, String> {
        let (conn, p) = split(url)?;
        let fs = side(&conn)?;
        let now = fs.lstat(&p).map_err(|e| e.to_string())?;
        let moved_on = now.is_some_and(|m| m.mtime != remote_mtime || m.size != remote_size);
        let target = match force {
            None if moved_on => {
                // Someone else changed it: ask.
                let name = p.rsplit('/').next().unwrap_or(&p).to_string();
                if let Some(a) = APP.get() { let _ = a.emit("sftp-sync-conflict", SyncConflict { url: url.to_string(), name }); }
                return Err(String::new());
            }
            Some("skip") => return Ok(None),
            Some("copy") => {
                let parent = super::parent_of(&p).unwrap_or_else(|| "/".into());
                let name = p.rsplit('/').next().unwrap_or("file");
                let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 => (&name[..i], &name[i..]), _ => (name, "") };
                unique_new(&fs, &parent, &format!("{stem} (from this Mac){ext}"))
            }
            _ => p.clone(),
        };
        xfer::upload_over(&local, &fs, &target).map_err(|e| e.to_string())?;
        if target != p { return Ok(None); } // saved beside it: the open copy still tracks the original
        let m = fs.lstat(&p).ok().flatten();
        Ok(Some((m.and_then(|m| m.mtime), m.map(|m| m.size).unwrap_or(0))))
    })();
    match res {
        Ok(new_remote) => done(true, None, new_remote, true),
        Err(e) if e.is_empty() => { // waiting for the page's answer
            let mut open = OPEN.lock().unwrap();
            if let Some(o) = open.iter_mut().find(|o| o.url == url) { o.busy = false; }
        }
        Err(e) => done(false, Some(e), None, false),
    }
}

/// The page's answer to sftp-sync-conflict: "upload" | "copy" | "skip".
#[tauri::command]
pub fn sftp_sync_resolve(url: String, choice: String) {
    std::thread::spawn(move || {
        if choice == "skip" {
            // Keep the edit local; don't ask again until the next save.
            let mut open = OPEN.lock().unwrap();
            if let Some(o) = open.iter_mut().find(|o| o.url == url) { o.local_mtime = mtime(&o.local); }
            return;
        }
        sync(&url, Some(if choice == "copy" { "copy" } else { "upload" }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Through a real ssh (see remote::tests::e2e_real_ssh for the setup):
    /// new folder / file, rename, delete, and saving an opened file back.
    #[test]
    #[ignore]
    fn e2e_change_and_save_back() {
        let conn = std::env::var("FATHOM_E2E_CONN").expect("FATHOM_E2E_CONN");
        let d = std::env::temp_dir().join(format!("fathom-e2e-c-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let d = d.canonicalize().unwrap();
        let url = |rel: &str| super::super::url(&conn, &format!("{}/{rel}", d.display()));
        let dir = super::super::url(&conn, &d.to_string_lossy());

        // New folder twice → "New Folder", "New Folder 2"; a new file.
        assert_eq!(create(&dir, "New Folder", true).unwrap(), url("New Folder"));
        assert_eq!(create(&dir, "New Folder", true).unwrap(), url("New Folder 2"));
        assert_eq!(create(&dir, "notes.txt", false).unwrap(), url("notes.txt"));
        // Rename; refuses to land on an existing name.
        assert_eq!(rename(&url("New Folder 2"), "Docs").unwrap(), url("Docs"));
        assert!(rename(&url("Docs"), "New Folder").unwrap_err().contains("already exists"));
        // Delete a folder with things in it.
        std::fs::write(d.join("Docs/a"), b"x").unwrap();
        let rep = delete(vec![url("Docs")], &mut Ctl::detached());
        assert_eq!(rep.done, 1, "{:?}", rep.errors);
        assert!(!d.join("Docs").exists());

        // Open & save back (without launching an app).
        std::fs::write(d.join("notes.txt"), b"v1").unwrap();
        let fs = side(&conn).unwrap();
        let p = format!("{}/notes.txt", d.display());
        let m = fs.lstat(&p).unwrap().unwrap();
        let local = d.join("cache-notes.txt");
        xfer::download(&fs, &p, &local).unwrap();
        assert_eq!(std::fs::read(&local).unwrap(), b"v1");
        OPEN.lock().unwrap().push(Open { url: url("notes.txt"), local: local.clone(), remote_mtime: m.mtime, remote_size: m.size, local_mtime: mtime(&local), busy: false });
        std::thread::sleep(Duration::from_millis(1100));
        std::fs::write(&local, b"v2 edited").unwrap();
        sync(&url("notes.txt"), None);
        assert_eq!(std::fs::read(d.join("notes.txt")).unwrap(), b"v2 edited", "a save goes up");
        // Someone else changes the server copy: no silent overwrite…
        std::thread::sleep(Duration::from_millis(1100));
        std::fs::write(d.join("notes.txt"), b"theirs!").unwrap();
        std::fs::write(&local, b"v3 mine").unwrap();
        sync(&url("notes.txt"), None);
        assert_eq!(std::fs::read(d.join("notes.txt")).unwrap(), b"theirs!", "asks instead of overwriting");
        // …and "save as a copy" keeps both.
        sync(&url("notes.txt"), Some("copy"));
        assert_eq!(std::fs::read(d.join("notes (from this Mac).txt")).unwrap(), b"v3 mine");
        assert_eq!(std::fs::read(d.join("notes.txt")).unwrap(), b"theirs!");
        assert!(!d.join(".notes.txt.fathom-part").exists());
        OPEN.lock().unwrap().clear();
        std::fs::remove_dir_all(&d).unwrap();
        super::super::shutdown();
    }

    #[test]
    fn hashes_are_short_and_stable() {
        assert_eq!(short_hash("box"), short_hash("box"));
        assert_ne!(short_hash("box"), short_hash("box2"));
        assert_eq!(short_hash("x").len(), 12);
    }
}
