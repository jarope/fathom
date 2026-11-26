//! User settings files and user actions.
//!
//! - `~/.config/fathom/settings.json` (preferences + shortcuts) and
//!   `~/.config/fathom/actions.json` (right-click actions) are plain JSON the
//!   UI reads and writes whole; hand edits are welcome.
//! - User actions run a shell command (`%f` `%F` `%d` `%n` expanded and
//!   shell-quoted) either in the background — output captured, cancellable —
//!   or in the user's terminal app.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Emitter;

const FILES: [&str; 2] = ["settings.json", "actions.json"];

fn config_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("No home folder")?;
    Ok(PathBuf::from(home).join(".config").join("fathom"))
}

fn config_path(name: &str) -> Result<PathBuf, String> {
    if !FILES.contains(&name) {
        return Err(format!("Not a Fathom settings file: {name}"));
    }
    Ok(config_dir()?.join(name))
}

/// The file's text, or None if it doesn't exist yet.
#[tauri::command]
pub fn config_read(name: String) -> Result<Option<String>, String> {
    let p = config_path(&name)?;
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Can't read {}: {e}", p.display())),
    }
}

/// Replace the file atomically (write a temp file, then rename over it).
#[tauri::command]
pub fn config_write(name: String, text: String) -> Result<String, String> {
    let p = config_path(&name)?;
    let dir = p.parent().unwrap();
    std::fs::create_dir_all(dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, text).map_err(|e| format!("Can't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("Can't save {}: {e}", p.display()))?;
    Ok(p.to_string_lossy().into_owned())
}

/// Single-quote for zsh: 'it'\''s'.
pub(crate) fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Expand %f (first item), %F (all items), %d (folder), %n (first item's
/// name) and %% (a literal %), each shell-quoted.
pub(crate) fn expand(cmd: &str, dir: &str, paths: &[String]) -> String {
    let first = paths.first().map(String::as_str).unwrap_or("");
    let name = first.rsplit('/').next().unwrap_or("");
    let mut out = String::new();
    let mut it = cmd.chars().peekable();
    while let Some(c) = it.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match it.peek().copied() {
            Some('f') => out.push_str(&quote(first)),
            Some('F') => out.push_str(&paths.iter().map(|p| quote(p)).collect::<Vec<_>>().join(" ")),
            Some('d') => out.push_str(&quote(dir)),
            Some('n') => out.push_str(&quote(name)),
            Some('%') => out.push('%'),
            _ => {
                out.push('%');
                continue;
            }
        }
        it.next();
    }
    out
}

// ---- Terminal apps ----

/// Open `app` (Terminal / iTerm / Ghostty / Warp) at a folder, or running a script.
fn open_terminal_app(app: &str, dir: &str, script: Option<&str>) -> Result<(), String> {
    let mut c = Command::new("open");
    match (app, script) {
        ("Ghostty", None) => c.args(["-na", "Ghostty", "--args", &format!("--working-directory={dir}")]),
        ("Ghostty", Some(s)) => c.args(["-na", "Ghostty", "--args", &format!("--working-directory={dir}"), "-e", s]),
        (a, target) => c.args(["-a", a, target.unwrap_or(dir)]),
    };
    let out = c.output().map_err(|e| format!("Couldn't open {app}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("Couldn't open {app}: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// "Open Terminal Here" in the chosen terminal app.
#[tauri::command]
pub fn open_terminal(path: String, app: Option<String>) -> Result<(), String> {
    open_terminal_app(app.as_deref().unwrap_or("Terminal"), &path, None)
}

// ---- Running actions ----

#[derive(Default)]
pub struct Actions {
    next: AtomicU64,
    running: Mutex<HashMap<u64, i32>>, // id -> process group
}

#[derive(Serialize, Clone)]
struct Done {
    id: u64,
    code: Option<i32>,
    output: String,
    cancelled: bool,
}

const MAX_OUT: usize = 64 * 1024;

/// Run a user action. Background: returns an id now, then emits
/// `action-done` {id, code, output, cancelled}. Terminal: opens the
/// terminal app and returns 0.
#[tauri::command]
pub fn run_action(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<Actions>>,
    command: String,
    dir: String,
    paths: Vec<String>,
    terminal: Option<String>,
) -> Result<u64, String> {
    let cmd = expand(&command, &dir, &paths);
    if let Some(term) = terminal {
        let path = std::env::temp_dir().join(format!("fathom-action-{}-{}.command", std::process::id(), state.next.fetch_add(1, Ordering::Relaxed)));
        let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
        writeln!(f, "#!/bin/zsh -l\ncd {} || exit 1\n{cmd}\ns=$?\necho\necho \"— finished (exit $s)\"\nrm -f {}\nexec zsh -l", quote(&dir), quote(&path.to_string_lossy()))
            .map_err(|e| e.to_string())?;
        drop(f);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        open_terminal_app(&term, &dir, Some(&path.to_string_lossy()))?;
        return Ok(0);
    }

    use std::os::unix::process::CommandExt;
    let child = Command::new("/bin/zsh")
        .args(["-l", "-c", &cmd])
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0) // so Cancel stops everything the command started
        .spawn()
        .map_err(|e| format!("Couldn't start the action: {e}"))?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.running.lock().unwrap().insert(id, child.id() as i32);
    let st = state.inner().clone();
    std::thread::spawn(move || {
        let out = child.wait_with_output();
        let cancelled = st.running.lock().unwrap().remove(&id).is_none();
        let (code, mut output) = match out {
            Ok(o) => {
                let mut s = String::from_utf8_lossy(&o.stdout).into_owned();
                let e = String::from_utf8_lossy(&o.stderr);
                if !e.trim().is_empty() {
                    if !s.is_empty() && !s.ends_with('\n') {
                        s.push('\n');
                    }
                    s.push_str(&e);
                }
                (o.status.code(), s)
            }
            Err(e) => (None, e.to_string()),
        };
        if output.len() > MAX_OUT {
            let mut cut = output.len() - MAX_OUT;
            while !output.is_char_boundary(cut) {
                cut += 1;
            }
            output = format!("…\n{}", &output[cut..]);
        }
        let _ = app.emit("action-done", Done { id, code, output: output.trim_end().to_string(), cancelled });
    });
    Ok(id)
}

#[tauri::command]
pub fn cancel_action(state: tauri::State<'_, std::sync::Arc<Actions>>, id: u64) {
    if let Some(pg) = state.running.lock().unwrap().remove(&id) {
        unsafe {
            libc::kill(-pg, libc::SIGTERM);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_file_round_trip() {
        let dir = std::env::temp_dir().join(format!("fathom-wtf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("My Theme.json");
        let path = f.to_string_lossy().to_string();
        write_text_file(path.clone(), "{\"a\":1}\n".into()).unwrap();
        write_text_file(path.clone(), "{\"b\":2}\n".into()).unwrap(); // replaces
        assert_eq!(read_text_file(path).unwrap(), "{\"b\":2}\n");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1); // no leftover part file
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn expands_and_quotes() {
        let p = vec!["/a/it's here.txt".to_string(), "/a/b.png".to_string()];
        assert_eq!(expand("cat %f", "/a", &p), r"cat '/a/it'\''s here.txt'");
        assert_eq!(expand("x %F", "/a", &p), r"x '/a/it'\''s here.txt' '/a/b.png'");
        assert_eq!(expand("cd %d && echo %n 100%% %z", "/my dir", &p), r"cd '/my dir' && echo 'it'\''s here.txt' 100% %z");
        assert_eq!(expand("echo %", "/", &[]), "echo %");
    }

    #[test]
    fn quoted_paths_survive_the_shell() {
        let p = vec!["/tmp/a b'c$HOME\"*".to_string()];
        let out = Command::new("/bin/zsh").args(["-c", &expand("print -r -- %f", "/", &p)]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end(), p[0]);
    }

    #[test]
    fn rejects_other_config_files() {
        assert!(config_path("../../.zshrc").is_err());
        assert!(config_path("settings.json").unwrap().ends_with(".config/fathom/settings.json"));
    }
}

/// Read a small text file the user picked (e.g. a theme to import). Capped at 1 MB.
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let md = std::fs::metadata(&path).map_err(|e| format!("Can't read {path}: {e}"))?;
    if md.len() > 1_000_000 {
        return Err("That file is too big to be a theme (over 1 MB).".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Can't read {path}: {e}"))
}

/// Save a small text file to a path the user chose in a save dialog (e.g. an
/// exported theme). Written beside it first, then renamed over, so a failed
/// write never leaves half a file.
#[tauri::command]
pub fn write_text_file(path: String, text: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let tmp = p.with_file_name(format!(".{}.fathom-part", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| format!("Can't save {path}: {e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Can't save {path}: {e}")
    })
}
