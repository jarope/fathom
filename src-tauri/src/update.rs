//! Updates from GitHub Releases (tauri-plugin-updater). The release's
//! latest.json lists the new version and a signed .app.tar.gz; the signature
//! is checked against the public key in tauri.conf.json before anything is
//! replaced, so only builds signed with Fathom's private key can install.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
pub struct Available {
    version: String,
    current: String,
    notes: Option<String>,
    date: Option<String>,
}

/// Is there a newer Fathom? None when up to date.
#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<Available>, String> {
    if cfg!(debug_assertions) {
        return Err("Updates are off in development builds (./scripts/dev.sh).".into());
    }
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| format!("Couldn't check for updates: {e}"))?;
    let out = found.as_ref().map(|u| Available {
        version: u.version.clone(),
        current: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    });
    *app.state::<Pending>().0.lock().unwrap() = found;
    Ok(out)
}

#[derive(Serialize, Clone)]
struct Progress {
    done: u64,
    total: Option<u64>,
}

/// Download, verify and install the update found by update_check, then relaunch.
/// Emits "update-progress" while downloading.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let update = app.state::<Pending>().0.lock().unwrap().take().ok_or("No update to install — check again.")?;
    let mut done = 0u64;
    let a = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = a.emit("update-progress", Progress { done, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("The update didn't install: {e}"))?;
    app.restart();
}
