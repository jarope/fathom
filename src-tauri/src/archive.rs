//! Compress / extract, run as cancellable jobs. Uses the tools macOS ships:
//! `ditto` for zip (keeps Mac metadata, like Finder's "Compress") and
//! `bsdtar` (`tar`) for everything else it can read — tar, gz, bz2, xz, 7z…

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, State};

use crate::jobs::{cancelled_err, is_cancel, spawn_job, Ctl, Jobs, OpReport};
use crate::{remove_path, unique_dest, unique_new};

/// Run `cmd`, polling for cancel; `watch` is a file whose growing size is
/// reported as progress (the archive being written). Returns stderr on failure.
fn run_child(mut cmd: Command, ctl: &mut Ctl, watch: Option<&Path>) -> std::io::Result<()> {
    let mut child = cmd.stdout(Stdio::null()).stderr(Stdio::piped()).spawn()?;
    loop {
        if let Some(status) = child.try_wait()? {
            if status.success() {
                return Ok(());
            }
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                use std::io::Read;
                let _ = e.read_to_string(&mut err);
            }
            let err = err.trim();
            return Err(std::io::Error::other(if err.is_empty() { format!("failed ({status})") } else { err.lines().last().unwrap_or(err).to_string() }));
        }
        if ctl.cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(cancelled_err());
        }
        if let Some(w) = watch {
            ctl.done_bytes = std::fs::metadata(w).map(|m| m.len()).unwrap_or(0);
        }
        ctl.tick(false);
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub fn compress(sources: Vec<PathBuf>, ctl: &mut Ctl) -> OpReport {
    let mut rep = OpReport::default();
    ctl.phase = "zip";
    let Some(parent) = sources.first().and_then(|s| s.parent()).map(Path::to_path_buf) else {
        rep.errors.push("Nothing to compress".into());
        return rep;
    };
    if sources.iter().any(|s| s.parent() != Some(parent.as_path())) {
        rep.errors.push("Compress items from one folder at a time".into());
        return rep;
    }
    let names: Vec<String> = sources.iter().filter_map(|s| s.file_name().map(|n| n.to_string_lossy().into_owned())).collect();
    let out = unique_new(&parent, &if names.len() == 1 { format!("{}.zip", names[0]) } else { "Archive.zip".into() });
    ctl.current = out.file_name().unwrap().to_string_lossy().into_owned();
    ctl.total_items = names.len() as u64;
    ctl.tick(true);

    let mut cmd;
    if sources.len() == 1 {
        cmd = Command::new("ditto");
        cmd.args(["-c", "-k", "--sequesterRsrc", "--keepParent"]).arg(&sources[0]).arg(&out);
    } else {
        cmd = Command::new("zip");
        cmd.current_dir(&parent).args(["-r", "-y", "-q"]).arg(&out).args(&names).args(["-x", "*.DS_Store"]);
    }
    match run_child(cmd, ctl, Some(&out)) {
        Ok(()) => {
            rep.done = 1;
            rep.pairs.push([sources[0].to_string_lossy().into_owned(), out.to_string_lossy().into_owned()]);
        }
        Err(e) => {
            let _ = std::fs::remove_file(&out);
            if !is_cancel(&e) {
                rep.errors.push(format!("Compress failed: {e}"));
            }
        }
    }
    rep
}

const ARCHIVE_EXTS: [&str; 14] = [
    ".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tbz", ".tbz2", ".txz", ".tar", ".zip", ".7z", ".rar", ".xar", ".cpio",
];

/// "photos.tar.gz" → "photos"
fn archive_stem(name: &str) -> String {
    let lower = name.to_lowercase();
    for ext in ARCHIVE_EXTS {
        if lower.ends_with(ext) && lower.len() > ext.len() {
            return name[..name.len() - ext.len()].to_string();
        }
    }
    Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.into())
}

/// Extract next to the archive. One top-level item comes out as itself;
/// several land in a folder named after the archive (Finder's behaviour).
pub fn extract(archive: PathBuf, ctl: &mut Ctl) -> OpReport {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let mut rep = OpReport::default();
    ctl.phase = "unzip";
    let (Some(parent), Some(name)) = (archive.parent().map(Path::to_path_buf), archive.file_name().map(|n| n.to_string_lossy().into_owned())) else {
        rep.errors.push("Bad archive path".into());
        return rep;
    };
    ctl.current = name.clone();
    ctl.tick(true);
    let tmp = parent.join(format!(".fathom-extract-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    if let Err(e) = std::fs::create_dir(&tmp) {
        rep.errors.push(format!("Can't extract here: {e}"));
        return rep;
    }
    let mut cmd;
    if name.to_lowercase().ends_with(".zip") {
        cmd = Command::new("ditto");
        cmd.args(["-x", "-k"]).arg(&archive).arg(&tmp);
    } else {
        cmd = Command::new("tar");
        cmd.arg("-xf").arg(&archive).arg("-C").arg(&tmp);
    }
    if let Err(e) = run_child(cmd, ctl, None) {
        let _ = remove_path(&tmp);
        if !is_cancel(&e) {
            rep.errors.push(format!("Extract failed: {e}"));
        }
        return rep;
    }
    let _ = remove_path(&tmp.join("__MACOSX"));
    let entries: Vec<PathBuf> = std::fs::read_dir(&tmp).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    let landed = if entries.len() == 1 {
        let only = &entries[0];
        let target = unique_dest(&parent, &only.file_name().unwrap().to_string_lossy()).0;
        let r = std::fs::rename(only, &target);
        let _ = std::fs::remove_dir(&tmp);
        r.map(|_| target)
    } else {
        let target = unique_new(&parent, &archive_stem(&name));
        std::fs::rename(&tmp, &target).map(|_| target)
    };
    match landed {
        Ok(t) => {
            rep.done = 1;
            rep.pairs.push([archive.to_string_lossy().into_owned(), t.to_string_lossy().into_owned()]);
        }
        Err(e) => {
            rep.errors.push(format!("Extracted, but couldn't place it: {e}"));
        }
    }
    rep
}

#[tauri::command]
pub fn start_compress(app: AppHandle, jobs: State<'_, Arc<Jobs>>, sources: Vec<String>) -> Result<u64, String> {
    let sources = sources.into_iter().map(PathBuf::from).collect();
    Ok(spawn_job(app, jobs.inner().clone(), move |ctl| compress(sources, ctl)))
}

#[tauri::command]
pub fn start_extract(app: AppHandle, jobs: State<'_, Arc<Jobs>>, archives: Vec<String>) -> Result<u64, String> {
    Ok(spawn_job(app, jobs.inner().clone(), move |ctl| {
        let mut all = OpReport::default();
        for a in archives {
            if ctl.cancelled() {
                break;
            }
            let r = extract(PathBuf::from(a), ctl);
            all.done += r.done;
            all.errors.extend(r.errors);
            all.pairs.extend(r.pairs);
        }
        all
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems() {
        assert_eq!(archive_stem("photos.tar.gz"), "photos");
        assert_eq!(archive_stem("a.b.zip"), "a.b");
        assert_eq!(archive_stem("x.TGZ"), "x");
    }
}
