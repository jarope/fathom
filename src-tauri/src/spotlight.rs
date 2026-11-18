//! Spotlight search (`mdfind`), streamed: results arrive in batches as
//! `spotlight-batch` events so the list fills while Spotlight is still
//! answering. A new search (or Esc) cancels the old one.

use crate::query;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

const CAP: usize = 10_000;

#[derive(Default)]
pub struct Spotlight {
    next: AtomicU64,
    cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

#[derive(Serialize, Clone)]
struct Batch {
    id: u64,
    entries: Vec<crate::Entry>,
    done: bool,
    truncated: bool,
    error: Option<String>,
    elapsed_ms: u128,
}

fn hidden(path: &str) -> bool {
    path.split('/').any(|c| c.starts_with('.') && c.len() > 1)
}

/// Start a Spotlight search; returns its id. `root` = search inside this
/// folder only (None = the whole Mac). `contents` = match text in files.
#[tauri::command]
pub fn spotlight_search(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Spotlight>>,
    query: String,
    root: Option<String>,
    contents: bool,
    show_hidden: bool,
) -> Result<u64, String> {
    let q = query::parse(&query);
    if q.is_empty() {
        return Err("Type something to search for".into());
    }
    let mdq = query::to_mdquery(&q, contents);
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().unwrap().insert(id, cancel.clone());
    let st = state.inner().clone();

    std::thread::spawn(move || {
        let started = Instant::now();
        let emit = |entries: Vec<crate::Entry>, done: bool, truncated: bool, error: Option<String>| {
            let _ = app.emit("spotlight-batch", Batch { id, entries, done, truncated, error, elapsed_ms: started.elapsed().as_millis() });
        };
        let mut cmd = std::process::Command::new("mdfind");
        cmd.arg("-0");
        if let Some(r) = &root {
            cmd.arg("-onlyin").arg(r);
        }
        cmd.arg(&mdq).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                emit(vec![], true, false, Some(format!("Spotlight isn't available: {e}")));
                st.cancels.lock().unwrap().remove(&id);
                return;
            }
        };

        // Reader thread → chunks; this thread batches by time so the UI
        // gets a steady trickle rather than one event per file.
        let mut out = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 16384];
            while let Ok(n) = out.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });

        let mut pending: Vec<u8> = Vec::new();
        let mut batch: Vec<crate::Entry> = Vec::new();
        let mut total = 0usize;
        let mut truncated = false;
        let mut last = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                let _ = child.kill();
                break;
            }
            let chunk = rx.recv_timeout(Duration::from_millis(80));
            let finished = matches!(chunk, Err(mpsc::RecvTimeoutError::Disconnected));
            if let Ok(c) = chunk {
                pending.extend_from_slice(&c);
                while let Some(i) = pending.iter().position(|&b| b == 0) {
                    let raw: Vec<u8> = pending.drain(..=i).collect();
                    let p = String::from_utf8_lossy(&raw[..raw.len() - 1]).into_owned();
                    if p.is_empty() || (!show_hidden && hidden(&p)) || root.as_deref() == Some(p.as_str()) {
                        continue;
                    }
                    let path = Path::new(&p);
                    let Ok(lm) = path.symlink_metadata() else { continue };
                    batch.push(crate::entry_from(path, path.metadata().ok().as_ref(), lm.file_type().is_symlink()));
                    total += 1;
                    if total >= CAP {
                        truncated = true;
                        break;
                    }
                }
            }
            if truncated {
                let _ = child.kill();
            }
            let flush = !batch.is_empty() && (last.elapsed() >= Duration::from_millis(150) || batch.len() >= 500);
            if flush && !finished && !truncated {
                emit(std::mem::take(&mut batch), false, false, None);
                last = Instant::now();
            }
            if finished || truncated {
                break;
            }
        }
        let _ = child.wait();
        if !cancel.load(Ordering::Relaxed) {
            emit(batch, true, truncated, None);
        }
        st.cancels.lock().unwrap().remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub fn spotlight_cancel(state: tauri::State<'_, Arc<Spotlight>>, id: u64) {
    if let Some(c) = state.cancels.lock().unwrap().get(&id) {
        c.store(true, Ordering::Relaxed);
    }
}
