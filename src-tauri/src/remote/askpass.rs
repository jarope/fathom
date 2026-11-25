//! ssh's questions (password, "are you sure you want to connect", key
//! passphrase, touch your security key) shown as Fathom dialogs.
//!
//! ssh runs SSH_ASKPASS with the question as its only argument and reads the
//! answer from its stdout. We point SSH_ASKPASS at Fathom's own binary; with
//! FATHOM_ASKPASS_SOCK set, main.rs runs `client()` instead of the app, which
//! hands the question to the running app over a private Unix socket (with a
//! per-launch secret). The app asks the page ("sftp-prompt") and replies.
//! Because ssh asks its own questions, the host key we show is exactly the
//! one ssh is checking.

use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

const KEYCHAIN_SERVICE: &str = "Fathom SSH";

struct Server {
    sock: PathBuf,
    token: String,
    app: AppHandle,
}

static SERVER: OnceLock<Server> = OnceLock::new();
static WAITING: Mutex<Option<HashMap<u64, SyncSender<Option<(String, bool)>>>>> = Mutex::new(None);
/// Per server: how many password prompts this login attempt has seen, and a
/// password to save in the Keychain once the login works.
static ATTEMPTS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);
static TO_SAVE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

#[derive(Serialize, Clone)]
struct Prompt {
    id: u64,
    conn: String,
    /// "password" | "passphrase" | "host" (new host key: yes/no) | "notice" (no answer) | "text"
    kind: &'static str,
    prompt: String,
}

fn random_token() -> String {
    let mut b = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") { let _ = f.read_exact(&mut b); }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Start listening (once, at launch).
pub fn start(app: AppHandle) {
    let Ok(dir) = super::ssh::control_dir() else { return };
    let sock = dir.join("ask");
    let _ = std::fs::remove_file(&sock);
    let Ok(listener) = UnixListener::bind(&sock) else { return };
    let token = random_token();
    if SERVER.set(Server { sock, token, app }).is_err() { return; }
    std::thread::spawn(move || {
        for s in listener.incoming().flatten() {
            std::thread::spawn(move || serve(s));
        }
    });
}

/// Remove the socket (app exit).
pub fn stop() {
    if let Some(s) = SERVER.get() { let _ = std::fs::remove_file(&s.sock); }
}

/// Make `cmd` (an ssh) ask its questions through Fathom.
pub fn configure(cmd: &mut std::process::Command, conn: &str) {
    let Some(s) = SERVER.get() else { return };
    let Ok(exe) = std::env::current_exe() else { return };
    cmd.env("SSH_ASKPASS", exe)
        .env("SSH_ASKPASS_REQUIRE", "force")
        .env("FATHOM_ASKPASS_SOCK", &s.sock)
        .env("FATHOM_ASKPASS_TOKEN", &s.token)
        .env("FATHOM_ASKPASS_CONN", conn);
    if std::env::var_os("DISPLAY").is_none() { cmd.env("DISPLAY", ":0"); } // older ssh only uses askpass with DISPLAY set
}

fn kind_of(prompt: &str, notice: bool) -> &'static str {
    let p = prompt.to_lowercase();
    if notice { "notice" }
    else if p.contains("(yes/no") { "host" }
    else if p.contains("passphrase") { "passphrase" }
    else if p.contains("password") { "password" }
    else { "text" }
}

fn serve(mut s: UnixStream) {
    let Some(srv) = SERVER.get() else { return };
    let mut buf = String::new();
    if s.read_to_string(&mut buf).is_err() { return; }
    let mut parts = buf.splitn(4, '\n');
    let (Some(token), Some(conn), Some(flag), Some(prompt)) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return };
    if token != srv.token { return; }
    let kind = kind_of(prompt, flag == "none");
    let answer = answer(srv, conn, kind, prompt);
    let _ = match answer { Some(a) => s.write_all(format!("1{a}").as_bytes()), None => s.write_all(b"0") };
}

fn answer(srv: &Server, conn: &str, kind: &'static str, prompt: &str) -> Option<String> {
    if kind == "password" {
        let n = { let mut m = ATTEMPTS.lock().unwrap(); let c = m.get_or_insert_with(HashMap::new).entry(conn.to_string()).or_insert(0); *c += 1; *c };
        if n == 1 { if let Some(p) = keychain_get(conn) { return Some(p); } }
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (tx, rx) = sync_channel(1);
    if kind != "notice" { WAITING.lock().unwrap().get_or_insert_with(HashMap::new).insert(id, tx); }
    let _ = srv.app.emit("sftp-prompt", Prompt { id, conn: conn.to_string(), kind, prompt: prompt.trim().to_string() });
    if kind == "notice" { return Some(String::new()); }
    let (text, remember) = rx.recv().ok().flatten()?;
    if kind == "password" && remember { TO_SAVE.lock().unwrap().get_or_insert_with(HashMap::new).insert(conn.to_string(), text.clone()); }
    Some(text)
}

/// The page's answer to prompt `id` (None = Cancel).
#[tauri::command]
pub fn sftp_prompt_reply(id: u64, answer: Option<String>, remember: Option<bool>) {
    if let Some(tx) = WAITING.lock().unwrap().get_or_insert_with(HashMap::new).remove(&id) {
        let _ = tx.send(answer.map(|a| (a, remember.unwrap_or(false))));
    }
}

/// A login attempt for `conn` ended: save a password asked to be remembered
/// (only if it worked) and reset the attempt count.
pub fn finished(conn: &str, ok: bool) {
    ATTEMPTS.lock().unwrap().get_or_insert_with(HashMap::new).remove(conn);
    let pw = TO_SAVE.lock().unwrap().get_or_insert_with(HashMap::new).remove(conn);
    if let (true, Some(pw)) = (ok, pw) {
        let _ = security_framework::passwords::set_generic_password(KEYCHAIN_SERVICE, conn, pw.as_bytes());
    }
}

fn keychain_get(conn: &str) -> Option<String> {
    security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, conn).ok().and_then(|b| String::from_utf8(b).ok())
}

/// Forget a saved password (Forget Server).
pub fn keychain_forget(conn: &str) {
    let _ = security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, conn);
}

/// main.rs: are we being run by ssh as its askpass helper?
pub fn is_client() -> bool { std::env::var_os("FATHOM_ASKPASS_SOCK").is_some() }

/// The askpass helper: pass ssh's question to the app, print the answer.
pub fn client() -> i32 {
    let sock = std::env::var("FATHOM_ASKPASS_SOCK").unwrap_or_default();
    let token = std::env::var("FATHOM_ASKPASS_TOKEN").unwrap_or_default();
    let conn = std::env::var("FATHOM_ASKPASS_CONN").unwrap_or_default();
    let flag = std::env::var("SSH_ASKPASS_PROMPT").unwrap_or_default();
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let Ok(mut s) = UnixStream::connect(&sock) else { return 1 };
    if s.write_all(format!("{token}\n{conn}\n{flag}\n{prompt}").as_bytes()).is_err() { return 1; }
    let _ = s.shutdown(std::net::Shutdown::Write);
    let mut reply = String::new();
    if s.read_to_string(&mut reply).is_err() { return 1; }
    match reply.strip_prefix('1') {
        Some(a) => { println!("{a}"); 0 }
        None => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kinds() {
        assert_eq!(kind_of("me@box's password: ", false), "password");
        assert_eq!(kind_of("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ", false), "passphrase");
        assert_eq!(kind_of("The authenticity of host 'box' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?", false), "host");
        assert_eq!(kind_of("Confirm user presence for key ED25519-SK", true), "notice");
        assert_eq!(kind_of("Verification code: ", false), "text");
    }
}
