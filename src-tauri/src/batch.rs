//! Batch rename: many items at once, validated up front, applied in two
//! phases (everything to a temporary name, then to its final name) so swaps
//! like a↔b work and nothing is ever overwritten.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::check_name;

/// `items`: `[path, new_name]`. Returns `[old_path, new_path]` for each
/// renamed item. All-or-nothing validation; best-effort rollback on failure.
pub fn batch_rename(items: Vec<[String; 2]>) -> Result<Vec<[String; 2]>, String> {
    let key = |p: &Path| p.to_string_lossy().to_lowercase(); // APFS default is case-insensitive
    let mut plan: Vec<(PathBuf, PathBuf)> = Vec::new();
    for [path, new_name] in &items {
        let name = check_name(new_name)?;
        let src = PathBuf::from(path);
        let parent = src.parent().ok_or("Can't rename the root.")?;
        if std::fs::symlink_metadata(&src).is_err() {
            return Err(format!("{path} no longer exists"));
        }
        let dst = parent.join(name);
        if dst != src {
            plan.push((src, dst));
        }
    }
    let sources: HashSet<String> = plan.iter().map(|(s, _)| key(s)).collect();
    let mut seen = HashSet::new();
    for (s, d) in &plan {
        if !seen.insert(key(d)) {
            return Err(format!("Two items would both be named “{}”", d.file_name().unwrap().to_string_lossy()));
        }
        // A case-only change of the same item is fine; otherwise the target
        // must be free or itself be one of the items being renamed away.
        if std::fs::symlink_metadata(d).is_ok() && key(d) != key(s) && !sources.contains(&key(d)) {
            return Err(format!("“{}” already exists", d.file_name().unwrap().to_string_lossy()));
        }
    }

    // Phase 1: everything to a unique temporary name.
    let pid = std::process::id();
    let mut temps: Vec<PathBuf> = Vec::new();
    for (i, (s, _)) in plan.iter().enumerate() {
        let t = s.parent().unwrap().join(format!(".fathom-rn-{pid}-{i}"));
        if let Err(e) = std::fs::rename(s, &t) {
            for (j, t) in temps.iter().enumerate() {
                let _ = std::fs::rename(t, &plan[j].0);
            }
            return Err(format!("Couldn't rename {}: {e}", s.display()));
        }
        temps.push(t);
    }
    // Phase 2: temporary → final.
    for (i, t) in temps.iter().enumerate() {
        if let Err(e) = std::fs::rename(t, &plan[i].1) {
            // Roll back: finished ones to their old names where free, the rest from temp.
            for j in 0..i {
                let _ = std::fs::rename(&plan[j].1, &temps[j]);
            }
            for j in 0..temps.len() {
                let _ = std::fs::rename(&temps[j], &plan[j].0);
            }
            return Err(format!("Couldn't rename to {}: {e}", plan[i].1.display()));
        }
    }
    Ok(plan
        .into_iter()
        .map(|(s, d)| [s.to_string_lossy().into_owned(), d.to_string_lossy().into_owned()])
        .collect())
}

#[tauri::command]
pub async fn batch_rename_cmd(items: Vec<[String; 2]>) -> Result<Vec<[String; 2]>, String> {
    tauri::async_runtime::spawn_blocking(move || batch_rename(items))
        .await
        .map_err(|e| format!("rename task panicked: {e}"))?
}
