//! The terminal panel (F4): a real pseudo-terminal running your login shell,
//! drawn by xterm.js in the window. Output streams to the page as
//! "term-data" events (base64, so multi-byte characters split across reads
//! survive); keystrokes come back through term_write.
//!
//! Following the folder both ways (Dolphin's Konsole panel does the same):
//! - Fathom → shell: term_cd types `cd -- '<folder>'` but only while the shell
//!   is waiting at its prompt (no program running in the foreground).
//! - shell → Fathom: term_cwd reads the shell's current folder from the
//!   kernel, so the page can follow a `cd` typed in the terminal.

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    pid: u32,
}

#[derive(Default)]
pub struct Terms {
    map: Mutex<HashMap<u32, Term>>,
    next: AtomicU32,
}

#[derive(Serialize, Clone)]
struct Data {
    id: u32,
    data: String,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// Start a login shell in `cwd`; returns the terminal's id.
#[tauri::command]
pub fn term_open(app: AppHandle, terms: State<Terms>, cwd: String, cols: u16, rows: u16) -> Result<u32, String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| format!("Couldn't open a terminal: {e}"))?;
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-l"); // a login shell, like Terminal.app: reads your profile
    if std::path::Path::new(&cwd).is_dir() {
        cmd.cwd(&cwd);
    } else if let Ok(h) = std::env::var("HOME") {
        cmd.cwd(h);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Fathom");
    // Apps started from the Dock have no locale; without one, shells mangle UTF-8.
    if std::env::var_os("LANG").is_none() {
        cmd.env("LANG", "en_US.UTF-8");
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("Couldn't start {shell}: {e}"))?;
    drop(pair.slave);
    let pid = child.process_id().unwrap_or(0);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = terms.next.fetch_add(1, Ordering::Relaxed) + 1;
    terms.map.lock().unwrap().insert(id, Term { master: pair.master, writer, child, pid });

    std::thread::spawn(move || {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut buf = vec![0u8; 32 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit("term-data", Data { id, data: b64.encode(&buf[..n]) });
                }
            }
        }
        let _ = app.emit("term-exit", id);
    });
    Ok(id)
}

/// Keystrokes / pasted text from the page.
#[tauri::command]
pub fn term_write(terms: State<Terms>, id: u32, data: String) -> Result<(), String> {
    let mut map = terms.map.lock().unwrap();
    let t = map.get_mut(&id).ok_or("No such terminal")?;
    t.writer.write_all(data.as_bytes()).and_then(|_| t.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(terms: State<Terms>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = terms.map.lock().unwrap();
    let t = map.get(&id).ok_or("No such terminal")?;
    t.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_close(terms: State<Terms>, id: u32) {
    if let Some(mut t) = terms.map.lock().unwrap().remove(&id) {
        let _ = t.child.kill();
    }
}

/// Is the shell itself in the foreground (waiting at its prompt)?
fn idle(t: &Term) -> bool {
    match t.master.process_group_leader() {
        Some(pg) => pg as u32 == t.pid,
        None => false,
    }
}

fn quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// Follow Fathom: `cd` the shell to `path` if it's idle. Returns whether it did.
#[tauri::command]
pub fn term_cd(terms: State<Terms>, id: u32, path: String) -> Result<bool, String> {
    let mut map = terms.map.lock().unwrap();
    let t = map.get_mut(&id).ok_or("No such terminal")?;
    if !idle(t) || !std::path::Path::new(&path).is_dir() {
        return Ok(false);
    }
    if shell_cwd(t.pid).as_deref() == Some(path.as_str()) {
        return Ok(true);
    }
    // ⌃E ⌃U clears anything half-typed at the prompt first (zsh and bash);
    // the leading space keeps it out of history where the shell allows.
    let line = format!("\x05\x15 cd -- {}\r", quote(&path));
    t.writer.write_all(line.as_bytes()).and_then(|_| t.writer.flush()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// The shell's current folder (None while a program runs in the foreground).
#[tauri::command]
pub fn term_cwd(terms: State<Terms>, id: u32) -> Option<String> {
    let map = terms.map.lock().unwrap();
    let t = map.get(&id)?;
    if !idle(t) {
        return None;
    }
    shell_cwd(t.pid)
}

#[cfg(target_os = "macos")]
fn shell_cwd(pid: u32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let n = unsafe {
        libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDVNODEPATHINFO, 0, &mut info as *mut _ as *mut libc::c_void, size)
    };
    if n != size {
        return None;
    }
    let raw = &info.pvi_cdir.vip_path;
    let bytes: Vec<u8> = raw.iter().flatten().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(not(target_os = "macos"))]
fn shell_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(quote("/Users/me/My Files"), "'/Users/me/My Files'");
        assert_eq!(quote("/tmp/it's"), "'/tmp/it'\\''s'");
    }

    /// A real shell in a real pty: idle at the prompt, busy while `sleep`
    /// runs, and its folder follows `cd`.
    #[test]
    fn pty_idle_and_cwd() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.cwd("/");
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let pid = child.process_id().unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || { let mut b = [0u8; 4096]; while matches!(reader.read(&mut b), Ok(n) if n > 0) {} });
        let writer = pair.master.take_writer().unwrap();
        let mut t = Term { master: pair.master, writer, child, pid };
        let wait = |ms| std::thread::sleep(std::time::Duration::from_millis(ms));
        wait(300);
        assert!(idle(&t), "shell at its prompt is idle");
        t.writer.write_all(b"cd /usr\n").unwrap(); t.writer.flush().unwrap();
        wait(300);
        assert_eq!(shell_cwd(pid).as_deref(), Some("/usr"));
        t.writer.write_all(b"sleep 2\n").unwrap(); t.writer.flush().unwrap();
        wait(400);
        assert!(!idle(&t), "busy while sleep runs");
        let _ = t.child.kill();
    }

    #[test]
    fn own_cwd() {
        let here = std::env::current_dir().unwrap().canonicalize().unwrap();
        let got = shell_cwd(std::process::id()).expect("reads our own cwd");
        assert_eq!(std::path::PathBuf::from(got).canonicalize().unwrap(), here);
    }
}
