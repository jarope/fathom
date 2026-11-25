//! Long-running file jobs: copy, move, duplicate (and archive work from
//! `archive.rs`). Each job runs on its own thread, streams `job-progress`
//! events, can be cancelled, and finishes with a `job-done` event carrying an
//! `OpReport` the UI uses for its message and for undo.
//!
//! Safety rules, same as before: never overwrite in place. A "Replace" sends
//! the existing item to the Bin first (recoverable); everything else either
//! skips, auto-renames ("name copy") or merges folders.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::{dest_inside_source, modified_secs, remove_path, unique_dest};

// ---------------------------------------------------------------------------
// Reports, policies, job registry
// ---------------------------------------------------------------------------

/// Outcome summary for a batch operation.
#[derive(Serialize, Default, Clone, Debug)]
pub struct OpReport {
    pub done: usize,
    /// Items auto-renamed to avoid a clash ("keep both").
    pub renamed: usize,
    pub skipped: usize,
    /// Existing items sent to the Bin to make way ("replace").
    pub replaced: usize,
    /// Folders merged into an existing folder of the same name.
    pub merged: usize,
    pub errors: Vec<String>,
    /// `[source, final_destination]` for everything that landed — for undo.
    pub pairs: Vec<[String; 2]>,
}

/// What to do when the destination already has an item of the same name.
#[derive(Deserialize, Clone, Copy, PartialEq, Debug, Default)]
pub enum Policy {
    #[default]
    #[serde(rename = "keep")]
    KeepBoth,
    #[serde(rename = "replace")]
    Replace,
    #[serde(rename = "skip")]
    Skip,
    #[serde(rename = "merge")]
    Merge,
}

pub struct Item {
    pub src: PathBuf,
    pub dest_dir: PathBuf,
    pub policy: Policy,
}

/// Registry of running jobs → their cancel flags.
#[derive(Default)]
pub struct Jobs {
    next: AtomicU64,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl Jobs {
    fn begin(&self) -> (u64, Arc<AtomicBool>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(id, flag.clone());
        (id, flag)
    }
    fn end(&self, id: u64) {
        self.cancels.lock().unwrap().remove(&id);
    }
}

#[derive(Serialize, Clone)]
struct Progress {
    id: u64,
    /// "scan" | "copy" | "move" | "zip" | "unzip"
    phase: &'static str,
    done_bytes: u64,
    /// 0 = unknown (indeterminate)
    total_bytes: u64,
    done_items: u64,
    total_items: u64,
    current: String,
}

#[derive(Serialize, Clone)]
struct JobDone {
    id: u64,
    report: OpReport,
    cancelled: bool,
}

/// Progress + cancellation handle passed through the copy machinery.
pub struct Ctl {
    id: u64,
    app: Option<AppHandle>,
    cancel: Arc<AtomicBool>,
    pub phase: &'static str,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub done_items: u64,
    pub total_items: u64,
    pub current: String,
    last: Instant,
}

impl Ctl {
    /// A handle with no UI attached (tests, or synchronous use).
    pub fn detached() -> Self {
        Ctl {
            id: 0,
            app: None,
            cancel: Arc::new(AtomicBool::new(false)),
            phase: "copy",
            done_bytes: 0,
            total_bytes: 0,
            done_items: 0,
            total_items: 0,
            current: String::new(),
            last: Instant::now(),
        }
    }
    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
    #[cfg(test)]
    pub fn cancel_now(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
    /// Emit progress, throttled to ~8/s unless forced.
    pub fn tick(&mut self, force: bool) {
        let Some(app) = &self.app else { return };
        if !force && self.last.elapsed() < Duration::from_millis(120) {
            return;
        }
        self.last = Instant::now();
        let _ = app.emit(
            "job-progress",
            Progress {
                id: self.id,
                phase: self.phase,
                done_bytes: self.done_bytes,
                total_bytes: self.total_bytes,
                done_items: self.done_items,
                total_items: self.total_items,
                current: self.current.clone(),
            },
        );
    }
    pub(crate) fn add_bytes(&mut self, n: u64) {
        self.done_bytes += n;
        self.tick(false);
    }
}

pub fn cancelled_err() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled")
}
pub fn is_cancel(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::Interrupted && e.to_string() == "cancelled"
}

/// Run `work` on a new thread as job `id`; emits `job-done` when it ends.
pub fn spawn_job<F>(app: AppHandle, jobs: Arc<Jobs>, work: F) -> u64
where
    F: FnOnce(&mut Ctl) -> OpReport + Send + 'static,
{
    let (id, cancel) = jobs.begin();
    std::thread::spawn(move || {
        let mut ctl = Ctl { id, app: Some(app.clone()), cancel, ..Ctl::detached() };
        let report = work(&mut ctl);
        let cancelled = ctl.cancelled();
        jobs.end(id);
        let _ = app.emit("job-done", JobDone { id, report, cancelled });
    });
    id
}

// ---------------------------------------------------------------------------
// Copy / move engine
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn dev_of(p: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(p).ok().map(|m| m.dev())
}
#[cfg(not(unix))]
fn dev_of(_p: &Path) -> Option<u64> {
    None
}

/// Bytes and entry count under `p` (not following links).
fn tree_size(p: &Path, ctl: &Ctl) -> (u64, u64) {
    let (mut bytes, mut n) = (0u64, 0u64);
    for e in walkdir::WalkDir::new(p).follow_links(false).into_iter().flatten() {
        if n % 512 == 0 && ctl.cancelled() {
            break;
        }
        n += 1;
        if e.file_type().is_file() {
            bytes += e.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    (bytes, n)
}

/// Files at least this big are copied in chunks (progress + cancel) when the
/// copy crosses volumes. Same-volume copies use `fs::copy`, which on APFS is
/// an instant clone.
const CHUNKED_MIN: u64 = 32 * 1024 * 1024;

fn copy_file(src: &Path, dst: &Path, md: &std::fs::Metadata, ctl: &mut Ctl, same_dev: bool) -> std::io::Result<()> {
    let len = md.len();
    if same_dev || len < CHUNKED_MIN {
        std::fs::copy(src, dst)?;
        ctl.add_bytes(len);
        return Ok(());
    }
    let mut from = std::fs::File::open(src)?;
    let mut to = std::fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
    let mut buf = vec![0u8; 1 << 20];
    let res = (|| {
        loop {
            if ctl.cancelled() {
                return Err(cancelled_err());
            }
            let n = from.read(&mut buf)?;
            if n == 0 {
                break;
            }
            to.write_all(&buf[..n])?;
            ctl.add_bytes(n as u64);
        }
        to.flush()?;
        let _ = std::fs::set_permissions(dst, md.permissions());
        if let Ok(t) = md.modified() {
            let _ = to.set_modified(t);
        }
        Ok(())
    })();
    if res.is_err() {
        drop(to);
        let _ = std::fs::remove_file(dst);
    }
    res
}

/// Recursively copy `src` to the (new) path `dst`, with progress.
fn copy_tree(src: &Path, dst: &Path, ctl: &mut Ctl, same_dev: bool) -> std::io::Result<()> {
    if ctl.cancelled() {
        return Err(cancelled_err());
    }
    let md = std::fs::symlink_metadata(src)?;
    let ft = md.file_type();
    if ft.is_symlink() {
        let target = std::fs::read_link(src)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, dst)?;
        #[cfg(not(unix))]
        std::fs::copy(src, dst).map(|_| ())?;
    } else if ft.is_dir() {
        std::fs::create_dir(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_tree(&entry.path(), &dst.join(entry.file_name()), ctl, same_dev)?;
        }
        let _ = std::fs::set_permissions(dst, md.permissions());
    } else {
        ctl.current = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        copy_file(src, dst, &md, ctl, same_dev)?;
    }
    ctl.done_items += 1;
    ctl.tick(false);
    Ok(())
}

/// Copy to a brand-new `dst`; if anything fails (or is cancelled) the partial
/// copy is removed — it's ours, nothing pre-existing is touched.
fn copy_new(src: &Path, dst: &Path, ctl: &mut Ctl, same_dev: bool) -> std::io::Result<()> {
    let r = copy_tree(src, dst, ctl, same_dev);
    if r.is_err() && std::fs::symlink_metadata(dst).is_ok() {
        let _ = remove_path(dst);
    }
    r
}

/// Move `src` to the (new) path `dst`: a rename on the same volume, else
/// copy-then-remove. If the copy fails the source is untouched; if only the
/// removal fails, the copy is kept and the error says so.
fn move_item(src: &Path, dst: &Path, ctl: &mut Ctl, same_dev: bool) -> std::io::Result<()> {
    if same_dev {
        match std::fs::rename(src, dst) {
            Ok(()) => return Ok(()),
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {}
            Err(e) => return Err(e),
        }
    }
    copy_new(src, dst, ctl, false)?;
    remove_path(src).map_err(|e| std::io::Error::other(format!("copied, but couldn't remove the original: {e}")))
}

/// Merge folder `src` into existing folder `dst`. Clashing sub-folders merge
/// recursively; clashing files are kept both ("name copy"). Records a pair
/// per item that landed so the merge can be undone.
fn merge_into(src: &Path, dst: &Path, do_move: bool, ctl: &mut Ctl, same_dev: bool, rep: &mut OpReport) -> std::io::Result<()> {
    for entry in std::fs::read_dir(src)? {
        if ctl.cancelled() {
            return Err(cancelled_err());
        }
        let entry = entry?;
        let name = entry.file_name();
        let s = entry.path();
        let d = dst.join(&name);
        let s_dir = std::fs::symlink_metadata(&s).map(|m| m.is_dir()).unwrap_or(false);
        let d_md = std::fs::symlink_metadata(&d).ok();
        if let Some(dm) = &d_md {
            if s_dir && dm.is_dir() {
                merge_into(&s, &d, do_move, ctl, same_dev, rep)?;
                continue;
            }
            if name == ".DS_Store" {
                if do_move {
                    let _ = std::fs::remove_file(&s);
                }
                continue;
            }
        }
        let target = if d_md.is_some() {
            rep.renamed += 1;
            unique_dest(dst, &name.to_string_lossy()).0
        } else {
            d
        };
        if do_move {
            move_item(&s, &target, ctl, same_dev)?;
            ctl.done_items += 1;
        } else {
            copy_new(&s, &target, ctl, same_dev)?;
        }
        rep.pairs.push([s.to_string_lossy().into_owned(), target.to_string_lossy().into_owned()]);
    }
    if do_move {
        let _ = std::fs::remove_dir(src); // only succeeds once emptied
    }
    Ok(())
}

fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The engine: transfer every item into its `dest_dir` honouring its policy.
pub fn run(items: Vec<Item>, do_move: bool, ctl: &mut Ctl) -> OpReport {
    let mut rep = OpReport::default();
    ctl.phase = "scan";
    ctl.tick(true);

    struct Prep {
        src: PathBuf,
        dest: PathBuf,
        name: String,
        policy: Policy,
        same_dev: bool,
        fast: bool,
    }
    let mut preps = Vec::new();
    for it in items {
        if ctl.cancelled() {
            return rep;
        }
        let s = it.src.to_string_lossy().into_owned();
        if std::fs::symlink_metadata(&it.src).is_err() {
            rep.errors.push(format!("{s}: no longer exists"));
            continue;
        }
        let Some(name) = it.src.file_name().and_then(|n| n.to_str()).map(str::to_string) else {
            rep.errors.push(format!("{s}: unreadable name"));
            continue;
        };
        let dest = canon(&it.dest_dir);
        if !dest.is_dir() {
            rep.errors.push(format!("Destination is not a folder: {}", dest.display()));
            continue;
        }
        if it.src.is_dir() && dest_inside_source(&it.src, &dest) {
            rep.errors.push(format!("{name}: can't put a folder inside itself"));
            continue;
        }
        if do_move && it.src.parent().map(|p| canon(p) == dest).unwrap_or(false) {
            rep.skipped += 1; // already there
            continue;
        }
        let same_dev = dev_of(&it.src).is_some() && dev_of(&it.src) == dev_of(&dest);
        let fast = do_move && same_dev;
        if fast {
            ctl.total_items += 1;
        } else {
            let (b, n) = tree_size(&it.src, ctl);
            ctl.total_bytes += b;
            ctl.total_items += n;
        }
        preps.push(Prep { src: it.src, dest, name, policy: it.policy, same_dev, fast });
    }

    ctl.phase = if do_move { "move" } else { "copy" };
    ctl.tick(true);

    for p in preps {
        if ctl.cancelled() {
            break;
        }
        let first = p.dest.join(&p.name);
        let clash = std::fs::symlink_metadata(&first).is_ok();
        let is_self = clash && canon(&first) == canon(&p.src);
        let target = if !clash {
            first
        } else {
            match p.policy {
                Policy::Skip => {
                    rep.skipped += 1;
                    continue;
                }
                Policy::Replace if !is_self => {
                    if canon(&p.src).starts_with(canon(&first)) {
                        rep.errors.push(format!("{}: can't replace a folder that contains it", p.name));
                        continue;
                    }
                    let binned = crate::bin_ops::trash_paths(&[first.to_string_lossy().into_owned()]);
                    if let Some(e) = binned.errors.first() {
                        rep.errors.push(format!("{}: couldn't move the existing item to the Bin: {e}", p.name));
                        continue;
                    }
                    rep.replaced += 1;
                    first
                }
                Policy::Merge if !is_self && p.src.is_dir() && first.is_dir() => {
                    ctl.current = p.name.clone();
                    match merge_into(&p.src, &first, do_move, ctl, p.same_dev, &mut rep) {
                        Ok(()) => {
                            rep.merged += 1;
                            rep.done += 1;
                        }
                        Err(e) if is_cancel(&e) => break,
                        Err(e) => rep.errors.push(format!("{}: {e}", p.name)),
                    }
                    continue;
                }
                _ => {
                    // Keep both (also the fallback for a copy onto itself,
                    // or merge/replace that doesn't apply).
                    rep.renamed += 1;
                    unique_dest(&p.dest, &p.name).0
                }
            }
        };
        ctl.current = p.name.clone();
        let res = if do_move {
            move_item(&p.src, &target, ctl, p.same_dev)
        } else {
            copy_new(&p.src, &target, ctl, p.same_dev)
        };
        match res {
            Ok(()) => {
                rep.done += 1;
                if p.fast {
                    ctl.done_items += 1;
                    ctl.tick(false);
                }
                rep.pairs.push([p.src.to_string_lossy().into_owned(), target.to_string_lossy().into_owned()]);
            }
            Err(e) if is_cancel(&e) => break,
            Err(e) => rep.errors.push(format!("{}: {e}", p.name)),
        }
    }
    ctl.tick(true);
    rep
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// A name clash the user should decide about before a transfer starts.
#[derive(Serialize)]
pub struct Conflict {
    pub(crate) name: String,
    pub(crate) src: String,
    pub(crate) dst: String,
    pub(crate) src_is_dir: bool,
    pub(crate) dst_is_dir: bool,
    pub(crate) src_size: u64,
    pub(crate) dst_size: u64,
    pub(crate) src_modified: Option<u64>,
    pub(crate) dst_modified: Option<u64>,
}

/// Which top-level items would collide in `dest_dir`. (An item landing on
/// itself — a copy into its own folder — isn't a clash: it becomes "copy".)
#[tauri::command]
pub async fn plan_transfer(sources: Vec<String>, dest_dir: String) -> Result<Vec<Conflict>, String> {
    // A server on either side: ask it (off the main thread — it may log in).
    if crate::remote::xfer::involves_server(&sources, &dest_dir) {
        return tauri::async_runtime::spawn_blocking(move || crate::remote::xfer::plan(&sources, &dest_dir))
            .await
            .map_err(|e| e.to_string())?;
    }
    let dest = canon(Path::new(&dest_dir));
    let mut out = Vec::new();
    for s in sources {
        let src = Path::new(&s);
        let Some(name) = src.file_name() else { continue };
        let dst = dest.join(name);
        let (Ok(sm), Ok(dm)) = (std::fs::metadata(src), std::fs::metadata(&dst)) else { continue };
        if canon(src) == canon(&dst) {
            continue;
        }
        out.push(Conflict {
            name: name.to_string_lossy().into_owned(),
            src: s.clone(),
            dst: dst.to_string_lossy().into_owned(),
            src_is_dir: sm.is_dir(),
            dst_is_dir: dm.is_dir(),
            src_size: if sm.is_file() { sm.len() } else { 0 },
            dst_size: if dm.is_file() { dm.len() } else { 0 },
            src_modified: modified_secs(&sm),
            dst_modified: modified_secs(&dm),
        });
    }
    Ok(out)
}

/// Start a copy or move of `sources` into `dest_dir`. `policies` maps a
/// source path to its clash policy (default: keep both). Returns the job id.
#[tauri::command]
pub fn start_transfer(
    app: AppHandle,
    jobs: State<'_, Arc<Jobs>>,
    sources: Vec<String>,
    dest_dir: String,
    copy: bool,
    policies: Option<HashMap<String, Policy>>,
) -> Result<u64, String> {
    let policies = policies.unwrap_or_default();
    // A server on either side: the remote engine (remote/xfer.rs), same job events.
    if crate::remote::xfer::involves_server(&sources, &dest_dir) {
        let items: Vec<(String, Policy)> = sources
            .into_iter()
            .map(|s| {
                let p = policies.get(&s).copied().unwrap_or_default();
                (s, p)
            })
            .collect();
        return Ok(spawn_job(app, jobs.inner().clone(), move |ctl| crate::remote::xfer::run(items, &dest_dir, !copy, ctl)));
    }
    let items = sources
        .into_iter()
        .map(|s| Item {
            policy: policies.get(&s).copied().unwrap_or_default(),
            src: PathBuf::from(s),
            dest_dir: PathBuf::from(&dest_dir),
        })
        .collect();
    Ok(spawn_job(app, jobs.inner().clone(), move |ctl| run(items, !copy, ctl)))
}

/// Duplicate each item next to itself ("name copy.ext"), like Finder's ⌘D.
#[tauri::command]
pub fn start_duplicate(app: AppHandle, jobs: State<'_, Arc<Jobs>>, sources: Vec<String>) -> Result<u64, String> {
    let items = sources
        .into_iter()
        .filter_map(|s| {
            let src = PathBuf::from(s);
            let parent = src.parent()?.to_path_buf();
            Some(Item { src, dest_dir: parent, policy: Policy::KeepBoth })
        })
        .collect();
    Ok(spawn_job(app, jobs.inner().clone(), move |ctl| run(items, false, ctl)))
}

#[tauri::command]
pub fn cancel_job(jobs: State<'_, Arc<Jobs>>, id: u64) {
    if let Some(f) = jobs.cancels.lock().unwrap().get(&id) {
        f.store(true, Ordering::Relaxed);
    }
}
