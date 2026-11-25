//! Servers over SFTP (see ROADMAP.md › SFTP): `/usr/bin/ssh` makes the
//! connection and Fathom speaks SFTP over it.
//!
//! A remote location is written `sftp://<conn>/<absolute path>`, where
//! <conn> is an ~/.ssh/config alias or `user@host[:port]`; `sftp://<conn>`
//! alone means your login folder there. The frontend's loc.js mirrors this.

pub mod askpass;
pub mod config;
pub mod sftp;
pub mod ssh;

use serde::Serialize;
use ssh::Conn;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

pub const SCHEME: &str = "sftp://";

pub fn is_remote(p: &str) -> bool { p.starts_with(SCHEME) }

/// `sftp://conn/path` → (conn, Some("/path")); `sftp://conn` → (conn, None).
pub fn parse(p: &str) -> Option<(String, Option<String>)> {
    let rest = p.strip_prefix(SCHEME)?;
    let (conn, path) = match rest.find('/') { Some(i) => (&rest[..i], Some(rest[i..].to_string())), None => (rest, None) };
    if conn.is_empty() { return None; }
    Some((conn.to_string(), path))
}

pub fn url(conn: &str, path: &str) -> String { format!("{SCHEME}{conn}{path}") }

/// Parent of a remote absolute path (None at "/").
pub fn parent_of(path: &str) -> Option<String> {
    if path == "/" { return None; }
    let t = path.trim_end_matches('/');
    Some(match t.rfind('/') { Some(0) | None => "/".into(), Some(i) => t[..i].into() })
}

pub fn join(dir: &str, name: &str) -> String { if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") } }

// ---------------------------------------------------------------- connections

static APP: OnceLock<AppHandle> = OnceLock::new();
static CONNS: Mutex<Option<HashMap<String, Arc<Conn>>>> = Mutex::new(None);
static LOCKS: Mutex<Option<HashMap<String, Arc<Mutex<()>>>>> = Mutex::new(None);
static CANCEL: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct State<'a> {
    conn: &'a str,
    /// "connecting" | "ready" | "failed" | "closed"
    state: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn emit_state(conn: &str, state: &str, error: Option<String>) {
    if let Some(a) = APP.get() { let _ = a.emit("sftp-state", State { conn, state, error }); }
}

/// At launch.
pub fn init(app: AppHandle) {
    let _ = APP.set(app.clone());
    askpass::start(app);
}

/// At exit: log out of everything.
pub fn shutdown() {
    if let Some(m) = CONNS.lock().unwrap().as_mut() { for (_, c) in m.drain() { c.close(); } }
    askpass::stop();
    if let Ok(d) = ssh::control_dir() { let _ = std::fs::remove_dir_all(d); }
}

/// The live connection to `conn`, logging in if needed. `quiet`: don't ask
/// anything (keys / agent / saved password only) — for restoring tabs.
pub fn get(conn: &str, quiet: bool) -> Result<Arc<Conn>, String> {
    let live = |c: &str| CONNS.lock().unwrap().get_or_insert_with(HashMap::new).get(c).filter(|x| x.alive()).cloned();
    if let Some(c) = live(conn) { return Ok(c); }
    // One login at a time per server, so two panes don't both prompt.
    let lock = LOCKS.lock().unwrap().get_or_insert_with(HashMap::new).entry(conn.to_string()).or_default().clone();
    let _g = lock.lock().unwrap();
    if let Some(c) = live(conn) { return Ok(c); }
    CANCEL.lock().unwrap().get_or_insert_with(HashSet::new).remove(conn);
    emit_state(conn, "connecting", None);
    let cancelled = || CANCEL.lock().unwrap().as_ref().is_some_and(|s| s.contains(conn));
    let r = Conn::connect(conn, quiet, &cancelled);
    askpass::finished(conn, r.is_ok());
    match r {
        Ok(c) => {
            let c = Arc::new(c);
            if let Some(old) = CONNS.lock().unwrap().get_or_insert_with(HashMap::new).insert(conn.to_string(), c.clone()) { old.close(); }
            emit_state(conn, "ready", None);
            Ok(c)
        }
        Err(e) => { emit_state(conn, "failed", Some(e.clone())); Err(e) }
    }
}

/// Run `f` with the browsing channel; if the connection had dropped, log in
/// again (quietly first) and retry once.
fn with_sftp<T>(conn: &str, quiet: bool, f: impl Fn(&Conn, &sftp::Sftp) -> Result<T, sftp::Error>) -> Result<T, String> {
    for attempt in 0..2 {
        let c = get(conn, quiet)?;
        let Some(s) = c.sftp() else { drop_conn(conn); continue };
        match f(&c, &s) {
            Err(sftp::Error::Lost) if attempt == 0 => { drop_conn(conn); continue; }
            r => return r.map_err(|e| e.to_string()),
        }
    }
    Err(sftp::Error::Lost.to_string())
}

fn drop_conn(conn: &str) {
    if let Some(c) = CONNS.lock().unwrap().get_or_insert_with(HashMap::new).remove(conn) { c.close(); }
}

// ---------------------------------------------------------------- listing

pub struct RemoteListing {
    pub dir: String,
    pub parent: Option<String>,
    pub entries: Vec<crate::Entry>,
}

fn entry(conn: &str, dir: &str, name: &str, a: &sftp::Attrs, target: Option<&sftp::Attrs>) -> crate::Entry {
    let t = target.unwrap_or(a);
    let is_dir = t.is_dir();
    crate::Entry::remote(
        url(conn, &join(dir, name)),
        name.to_string(),
        url(conn, dir),
        is_dir,
        a.is_symlink(),
        if is_dir { 0 } else { t.size.unwrap_or(0) },
        t.mtime.map(|m| m as u64),
        t.perms.unwrap_or(0) & 0o7777,
    )
}

/// list_dir for `sftp://…` paths.
pub fn list(path: &str, show_hidden: bool, quiet: bool) -> Result<RemoteListing, String> {
    let (conn, p) = parse(path).ok_or_else(|| format!("Not a server location: {path}"))?;
    with_sftp(&conn, quiet, |c, s| {
        let dir = s.realpath(p.as_deref().unwrap_or(&c.home))?;
        if !s.stat(&dir)?.is_dir() { return Err(sftp::Error::Status(sftp::FX_FAILURE, format!("Not a folder: {dir}"))); }
        let mut out = Vec::new();
        for e in s.read_dir(&dir)? {
            if !show_hidden && e.name.starts_with('.') { continue; }
            // A link shows what it points to (a linked folder opens like one).
            let target = if e.attrs.is_symlink() { s.stat(&join(&dir, &e.name)).ok() } else { None };
            out.push(entry(&conn, &dir, &e.name, &e.attrs, target.as_ref()));
        }
        Ok(RemoteListing { parent: parent_of(&dir).map(|p| url(&conn, &p)), dir: url(&conn, &dir), entries: out })
    })
}

/// free_space for `sftp://…` paths: (free, total).
pub fn space(path: &str) -> Result<(u64, u64), String> {
    let (conn, p) = parse(path).ok_or("Not a server location")?;
    // Never log in just for the status bar.
    let c = CONNS.lock().unwrap().get_or_insert_with(HashMap::new).get(&conn).cloned().ok_or("Not connected")?;
    let s = c.sftp().ok_or("Not connected")?;
    let v = s.statvfs(p.as_deref().unwrap_or(&c.home)).map_err(|e| e.to_string())?;
    Ok((v.avail, v.total))
}

// ---------------------------------------------------------------- commands

/// Log in to `conn` now (sidebar click, ⌘K). Returns its login folder as a location.
#[tauri::command]
pub async fn sftp_connect(conn: String, quiet: Option<bool>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || get(&conn, quiet.unwrap_or(false)).map(|c| url(&conn, &c.home)))
        .await.map_err(|e| e.to_string())?
}

/// Stop a login in progress.
#[tauri::command]
pub fn sftp_cancel(conn: String) {
    CANCEL.lock().unwrap().get_or_insert_with(HashSet::new).insert(conn);
}

#[tauri::command]
pub fn sftp_disconnect(conn: String) {
    drop_conn(&conn);
    emit_state(&conn, "closed", None);
}

/// Which servers are connected right now.
#[tauri::command]
pub fn sftp_connected() -> Vec<String> {
    CONNS.lock().unwrap().get_or_insert_with(HashMap::new).iter().filter(|(_, c)| c.alive()).map(|(k, _)| k.clone()).collect()
}

/// Forget a server: log out and drop any saved password.
#[tauri::command]
pub fn sftp_forget(conn: String) {
    drop_conn(&conn);
    askpass::keychain_forget(&conn);
}

/// Hosts named in ~/.ssh/config (for "Add from ssh config…").
#[tauri::command]
pub fn sftp_config_hosts() -> Vec<String> {
    config::hosts()
}

/// Has anything changed in these folders since `since` (their mtimes)?
/// Returns each folder's current mtime (None if unreadable / not connected).
#[tauri::command]
pub async fn sftp_mtimes(dirs: Vec<String>) -> Vec<Option<u64>> {
    tauri::async_runtime::spawn_blocking(move || {
        dirs.iter().map(|d| {
            let (conn, p) = parse(d)?;
            let c = CONNS.lock().unwrap().get_or_insert_with(HashMap::new).get(&conn).cloned()?;
            let s = c.sftp()?;
            s.stat(p.as_deref().unwrap_or(&c.home)).ok()?.mtime.map(|m| m as u64)
        }).collect()
    }).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End to end through a real ssh + sshd. Opt-in: set FATHOM_SSH to an ssh
    /// wrapper (e.g. one adding `-F <config>`) and FATHOM_E2E_CONN to a host it
    /// can reach with keys, then `cargo test e2e -- --ignored`.
    #[test]
    #[ignore]
    fn e2e_real_ssh() {
        let conn = std::env::var("FATHOM_E2E_CONN").expect("FATHOM_E2E_CONN");
        let home = list(&format!("{SCHEME}{conn}"), true, true).expect("lists the login folder");
        assert!(home.dir.starts_with(&format!("{SCHEME}{conn}/")), "{}", home.dir);
        let root = list(&format!("{SCHEME}{conn}/"), false, true).expect("lists /");
        assert!(root.parent.is_none() && root.entries.iter().any(|e| e.name == "Users" || e.name == "usr"));
        let c = get(&conn, true).unwrap();
        assert!(c.alive());
        // A second channel shares the same login (ControlMaster).
        let ch = c.open_channel().expect("second channel");
        assert_eq!(ch.realpath(".").unwrap(), c.home);
        // Drop the connection: the next listing logs in again by itself.
        c.close();
        drop(c);
        assert!(list(&format!("{SCHEME}{conn}/tmp"), false, true).is_ok(), "reconnects");
        shutdown();
    }
    #[test]
    fn locations() {
        assert_eq!(parse("sftp://box/home/me"), Some(("box".into(), Some("/home/me".into()))));
        assert_eq!(parse("sftp://me@box:2222"), Some(("me@box:2222".into(), None)));
        assert_eq!(parse("sftp://me@box:2222/"), Some(("me@box:2222".into(), Some("/".into()))));
        assert_eq!(parse("sftp:///x"), None);
        assert_eq!(parse("/Users/me"), None);
        assert_eq!(parent_of("/home/me"), Some("/home".into()));
        assert_eq!(parent_of("/home"), Some("/".into()));
        assert_eq!(parent_of("/"), None);
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/home/me", "a b#%"), "/home/me/a b#%");
        assert_eq!(url("box", "/a"), "sftp://box/a");
    }
}
