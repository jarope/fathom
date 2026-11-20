//! Move to Bin, remembering where each item landed so it can be put back
//! (⌘Z after Move to Bin, and Redo after undoing a copy).
//!
//! Regular items go through Finder, exactly like Finder's own ⌫: the Bin
//! sound plays and Finder's "Put Back" works too. Finder can't trash a
//! symlink by path (it errors without touching anything), and may be refused
//! Automation access, so anything Finder declines falls back to
//! NSFileManager, which never follows links and also reports the location.

use serde::Serialize;

#[derive(Serialize, Default, Debug)]
pub struct Binned {
    /// (original path, where it now is in the Bin). Items that were binned
    /// but whose new location is unknown are left out (they can't be put back).
    pub pairs: Vec<(String, String)>,
    pub count: usize,
    pub errors: Vec<String>,
}

#[cfg(target_os = "macos")]
const FINDER_SCRIPT: &str = r#"on run argv
	set sep to character id 30
	set out to ""
	repeat with p in argv
		try
			set f to POSIX file (contents of p)
			tell application "Finder" to set r to delete f
			set out to out & POSIX path of (r as alias) & sep
		on error errMsg
			set out to out & "!" & errMsg & sep
		end try
	end repeat
	return out
end run"#;

/// Trash every path. Never hard-deletes.
pub fn trash_paths(paths: &[String]) -> Binned {
    let mut out = Binned::default();
    #[cfg(target_os = "macos")]
    {
        use std::path::Path;
        // Symlinks (and missing paths, for a proper error) skip Finder.
        let (via_finder, mut rest): (Vec<&String>, Vec<&String>) = paths.iter().partition(|p| {
            Path::new(p).symlink_metadata().map(|m| !m.file_type().is_symlink()).unwrap_or(false)
        });
        if !via_finder.is_empty() {
            let res = std::process::Command::new("osascript")
                .arg("-e")
                .arg(FINDER_SCRIPT)
                .args(via_finder.iter().map(|s| s.as_str()))
                .output();
            match res {
                Ok(o) if o.status.success() => {
                    let text = String::from_utf8_lossy(&o.stdout);
                    let lines: Vec<&str> = text.trim_end_matches('\n').split('\u{1e}').collect();
                    for (i, src) in via_finder.iter().enumerate() {
                        let line = lines.get(i).copied().unwrap_or("!no answer from Finder");
                        if line.starts_with('!') || line.is_empty() {
                            rest.push(src); // let NSFileManager try (and report the error)
                        } else {
                            let dst = line.trim_end_matches('/').to_string();
                            out.count += 1;
                            if Path::new(&dst).symlink_metadata().is_ok() {
                                out.pairs.push(((*src).clone(), dst));
                            }
                        }
                    }
                }
                _ => rest.extend(via_finder.iter().copied()),
            }
        }
        for src in rest {
            if Path::new(src).symlink_metadata().is_err() {
                out.errors.push(format!("{src}: no longer exists"));
                continue;
            }
            match ns_trash(src) {
                Ok(Some(dst)) => {
                    out.count += 1;
                    out.pairs.push((src.clone(), dst));
                }
                Ok(None) => out.count += 1,
                Err(e) => out.errors.push(format!("{src}: {e}")),
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    for p in paths {
        match trash::delete(p) {
            Ok(()) => out.count += 1,
            Err(e) => out.errors.push(format!("{p}: {e}")),
        }
    }
    if !out.pairs.is_empty() {
        crate::bin_view::remember(&out.pairs); // so Put Back works from the Bin later
    }
    out
}

#[cfg(target_os = "macos")]
fn ns_trash(path: &str) -> Result<Option<String>, String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let fm = NSFileManager::defaultManager();
    let mut result = None;
    fm.trashItemAtURL_resultingItemURL_error(&url, Some(&mut result))
        .map_err(|e| e.localizedDescription().to_string())?;
    Ok(result.and_then(|u| u.path()).map(|p| p.to_string()))
}

/// ⌫ / Move to Bin. Returns where everything went so the UI can offer ⌘Z.
#[tauri::command]
pub async fn move_to_trash(paths: Vec<String>) -> Result<Binned, String> {
    tauri::async_runtime::spawn_blocking(move || trash_paths(&paths))
        .await
        .map_err(|e| format!("trash task panicked: {e}"))
}

#[cfg(test)]
mod tests {
    /// Touches the real Bin (and asks Finder), so run by hand:
    /// FATHOM_BIN_TEST=/some/scratch/dir cargo test bin_roundtrip -- --ignored
    #[test]
    #[ignore]
    fn bin_roundtrip() {
        let dir = std::path::PathBuf::from(std::env::var("FATHOM_BIN_TEST").expect("set FATHOM_BIN_TEST"));
        std::fs::create_dir_all(dir.join("folder")).unwrap();
        std::fs::write(dir.join("file \"q\".txt"), "x").unwrap();
        std::fs::write(dir.join("target.txt"), "t").unwrap();
        let _ = std::fs::remove_file(dir.join("link"));
        std::os::unix::fs::symlink(dir.join("target.txt"), dir.join("link")).unwrap();
        let paths: Vec<String> = ["file \"q\".txt", "folder", "link", "missing"].iter().map(|n| dir.join(n).to_string_lossy().into_owned()).collect();
        let b = super::trash_paths(&paths);
        println!("{b:#?}");
        assert_eq!(b.count, 3);
        assert_eq!(b.pairs.len(), 3);
        assert_eq!(b.errors.len(), 1);
        assert!(dir.join("target.txt").exists(), "link target must survive");
        for (orig, binned) in &b.pairs {
            assert!(std::path::Path::new(binned).symlink_metadata().is_ok());
            std::fs::rename(binned, orig).unwrap(); // put back
        }
        assert!(dir.join("link").symlink_metadata().unwrap().file_type().is_symlink());
    }
}
