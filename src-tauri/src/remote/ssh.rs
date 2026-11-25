//! Connections: `/usr/bin/ssh` does all the SSH (your ~/.ssh/config, agent,
//! keys, ProxyJump, known_hosts — exactly as in Terminal). One ControlMaster
//! per server holds the login; SFTP channels are `ssh -s … sftp` over it.
//!
//! Prompts (passwords, unknown host keys, key passphrases) reach Fathom
//! through SSH_ASKPASS — see askpass.rs.

use super::sftp::Sftp;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Where ssh lives (tests point this at a stand-in).
pub fn ssh_program() -> PathBuf {
    std::env::var_os("FATHOM_SSH").map(PathBuf::from).unwrap_or_else(|| "/usr/bin/ssh".into())
}

/// A short, private folder for control sockets (a socket path must stay
/// under ~104 bytes, which rules out $TMPDIR and ~/Library/Caches for some):
/// /tmp/fathom-ssh-<uid>/<pid>. One per launch, so a socket left behind by a
/// crash can never be mistaken for a live one; folders of dead launches are
/// cleared the first time.
pub fn control_dir() -> std::io::Result<PathBuf> {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(d) = DIR.get() { return Ok(d.clone()); }
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let uid = unsafe { libc::getuid() };
    let top = PathBuf::from(format!("/tmp/fathom-ssh-{uid}"));
    match std::fs::DirBuilder::new().mode(0o700).create(&top) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let md = std::fs::symlink_metadata(&top)?;
    if !md.is_dir() || md.uid() != uid || md.mode() & 0o077 != 0 {
        return Err(std::io::Error::other("the ssh control folder isn't private to you"));
    }
    for e in std::fs::read_dir(&top)?.flatten() {
        let gone = e.file_name().to_str().and_then(|n| n.parse::<i32>().ok()).is_some_and(|pid| unsafe { libc::kill(pid, 0) } != 0);
        if gone { let _ = std::fs::remove_dir_all(e.path()); }
    }
    let d = top.join(std::process::id().to_string());
    match std::fs::DirBuilder::new().mode(0o700).create(&d) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    Ok(DIR.get_or_init(|| d).clone())
}

/// `alias`, `host`, `user@host` or `user@host:port` → (destination, port).
pub fn split_target(conn: &str) -> (String, Option<u16>) {
    if let Some((h, p)) = conn.rsplit_once(':') {
        if let Ok(p) = p.parse::<u16>() {
            if !h.contains(':') { return (h.to_string(), Some(p)); }
        }
    }
    (conn.to_string(), None)
}

/// Options that keep the user's config from doing anything odd to our
/// connection (command-line -o wins over ~/.ssh/config).
fn base_args(ctl: &std::path::Path, conn: &str) -> Vec<String> {
    let (dest, port) = split_target(conn);
    let mut a: Vec<String> = [
        "-o", "LogLevel=ERROR",
        "-o", "ClearAllForwardings=yes",
        "-o", "ForwardAgent=no",
        "-o", "ForwardX11=no",
        "-o", "PermitLocalCommand=no",
        "-o", "RequestTTY=no",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "ConnectTimeout=20",
        "-e", "none",
        "-T",
    ].iter().map(|s| s.to_string()).collect();
    a.push("-o".into());
    a.push(format!("ControlPath={}/%C", ctl.display()));
    if let Some(p) = port { a.push("-p".into()); a.push(p.to_string()); }
    a.push("--".into());
    a.push(dest);
    a
}

/// The master: logs in once and stays up for the channels.
pub fn master_args(ctl: &std::path::Path, conn: &str, batch: bool) -> Vec<String> {
    let mut a: Vec<String> = vec!["-M".into(), "-N".into(), "-o".into(), "ControlPersist=no".into(), "-o".into(), "RemoteCommand=none".into()];
    if batch { a.push("-o".into()); a.push("BatchMode=yes".into()); }
    a.extend(base_args(ctl, conn));
    a
}

/// An SFTP channel over the master.
pub fn channel_args(ctl: &std::path::Path, conn: &str) -> Vec<String> {
    let mut a: Vec<String> = vec!["-o".into(), "ControlMaster=no".into(), "-o".into(), "BatchMode=yes".into(), "-s".into()];
    a.extend(base_args(ctl, conn));
    a.push("sftp".into());
    a
}

/// Turn ssh's stderr into something a person can act on.
pub fn classify(stderr: &str, conn: &str) -> String {
    let s = stderr.trim();
    let (host, _) = split_target(conn);
    let has = |t: &str| s.contains(t);
    if has("REMOTE HOST IDENTIFICATION HAS CHANGED") || has("Host key verification failed") && has("Offending") {
        return format!("{host}'s host key has changed, so Fathom won't connect — this can mean someone is intercepting the connection. If the server was reinstalled, remove its old key in Terminal (ssh-keygen -R {host}) and try again.");
    }
    if has("Host key verification failed") { return format!("Couldn't verify {host}'s identity, so Fathom didn't connect."); }
    if has("Permission denied") { return format!("{host} refused the login (wrong password, or no key it accepts)."); }
    if has("Could not resolve hostname") || has("nodename nor servname") { return format!("Couldn't find a server called {host}."); }
    if has("Connection refused") { return format!("{host} refused the connection (is SSH / Remote Login turned on there?)."); }
    if has("timed out") || has("Operation timed out") { return format!("{host} didn't answer in time."); }
    if has("No route to host") || has("Network is unreachable") { return format!("Can't reach {host} from this network."); }
    if has("subsystem request failed") { return format!("{host} doesn't offer SFTP."); }
    match s.lines().filter(|l| !l.trim().is_empty()).last() {
        Some(l) => format!("Couldn't connect to {host}: {}", l.trim()),
        None => format!("Couldn't connect to {host}."),
    }
}

fn base_command(args: &[String], conn: &str) -> Command {
    let mut c = Command::new(ssh_program());
    c.args(args);
    super::askpass::configure(&mut c, conn);
    // No controlling terminal, so ssh asks through SSH_ASKPASS even on
    // OpenSSH versions without SSH_ASKPASS_REQUIRE (macOS 11's 8.1).
    unsafe { c.pre_exec(|| { libc::setsid(); Ok(()) }); }
    c
}

/// A logged-in server: its master process and the browsing channel.
pub struct Conn {
    pub key: String,
    ctl: PathBuf,
    master: Mutex<Option<Child>>,
    browse: Mutex<Option<Arc<Sftp>>>,
    channels: Mutex<Vec<Child>>,
    /// The login folder (REALPATH ".") — where `sftp://conn` opens.
    pub home: String,
}

impl Conn {
    /// Log in. `batch`: never prompt (fail instead), for silent reconnects.
    pub fn connect(key: &str, batch: bool, cancel: &dyn Fn() -> bool) -> Result<Conn, String> {
        // A fresh folder per login: a socket left by a killed master can't
        // block the next one (ssh would quietly stop sharing the connection).
        static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let ctl = control_dir().map(|d| d.join(N.fetch_add(1, std::sync::atomic::Ordering::Relaxed).to_string()))
            .and_then(|d| { use std::os::unix::fs::DirBuilderExt; std::fs::DirBuilder::new().mode(0o700).create(&d).map(|_| d) })
            .map_err(|e| format!("Couldn't prepare the connection: {e}"))?;
        let mut m = base_command(&master_args(&ctl, key, batch), key)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped())
            .spawn().map_err(|e| format!("Couldn't run ssh: {e}"))?;
        let mut err = m.stderr.take();
        // Ready when the control socket answers; failed when ssh exits.
        let t0 = Instant::now();
        loop {
            if cancel() { let _ = m.kill(); let _ = m.wait(); let _ = std::fs::remove_dir_all(&ctl); return Err("Cancelled".into()); }
            if let Ok(Some(_)) = m.try_wait() {
                let mut s = String::new();
                if let Some(e) = err.as_mut() { let _ = e.read_to_string(&mut s); }
                let _ = std::fs::remove_dir_all(&ctl);
                return Err(classify(&s, key));
            }
            if check(&ctl, key) { break; }
            // Prompts can take as long as the person needs; only an unanswered,
            // prompt-less hang times out (ssh's own ConnectTimeout covers TCP).
            if t0.elapsed() > Duration::from_secs(600) { let _ = m.kill(); return Err(classify("timed out", key)); }
            std::thread::sleep(Duration::from_millis(80));
        }
        // Keep draining the master's stderr so it never blocks on a full pipe.
        if let Some(mut e) = err { std::thread::spawn(move || { let mut b = [0u8; 1024]; while matches!(e.read(&mut b), Ok(n) if n > 0) {} }); }
        let mut c = Conn { key: key.to_string(), ctl, master: Mutex::new(Some(m)), browse: Mutex::new(None), channels: Mutex::new(Vec::new()), home: String::new() };
        let s = c.open_channel()?;
        c.home = s.realpath(".").map_err(|e| format!("Connected, but couldn't find your folder on the server: {e}"))?;
        *c.browse.lock().unwrap() = Some(Arc::new(s));
        Ok(c)
    }

    /// A new SFTP channel over the master (transfers get their own).
    pub fn open_channel(&self) -> Result<Sftp, String> {
        let mut ch = base_command(&channel_args(&self.ctl, &self.key), &self.key)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
            .spawn().map_err(|e| format!("Couldn't run ssh: {e}"))?;
        let (w, r) = (ch.stdin.take().unwrap(), ch.stdout.take().unwrap());
        let mut err = ch.stderr.take().unwrap();
        match Sftp::start(r, w) {
            Ok(s) => {
                std::thread::spawn(move || { let mut b = [0u8; 1024]; while matches!(err.read(&mut b), Ok(n) if n > 0) {} });
                self.channels.lock().unwrap().push(ch);
                Ok(s)
            }
            Err(_) => {
                let _ = ch.kill(); let _ = ch.wait();
                let mut s = String::new(); let _ = err.read_to_string(&mut s);
                Err(classify(&s, &self.key))
            }
        }
    }

    /// The browsing channel (None once the connection has dropped).
    pub fn sftp(&self) -> Option<Arc<Sftp>> {
        self.browse.lock().unwrap().as_ref().filter(|s| s.alive()).cloned()
    }

    pub fn alive(&self) -> bool {
        self.sftp().is_some() && self.master.lock().unwrap().as_mut().is_some_and(|m| matches!(m.try_wait(), Ok(None)))
    }

    /// Log out: close the channels and the master.
    pub fn close(&self) {
        for mut c in self.channels.lock().unwrap().drain(..) { let _ = c.kill(); let _ = c.wait(); }
        *self.browse.lock().unwrap() = None;
        if let Some(mut m) = self.master.lock().unwrap().take() { let _ = m.kill(); let _ = m.wait(); }
        let _ = std::fs::remove_dir_all(&self.ctl);
    }
}

impl Drop for Conn {
    fn drop(&mut self) { self.close(); }
}

/// Is the master for `conn` up and answering?
fn check(ctl: &std::path::Path, conn: &str) -> bool {
    let mut a = vec!["-O".to_string(), "check".to_string()];
    a.extend(base_args(ctl, conn));
    Command::new(ssh_program()).args(&a).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets() {
        assert_eq!(split_target("box"), ("box".into(), None));
        assert_eq!(split_target("me@box:2222"), ("me@box".into(), Some(2222)));
        assert_eq!(split_target("me@box"), ("me@box".into(), None));
        assert_eq!(split_target("fe80::1"), ("fe80::1".into(), None), "IPv6 isn't a port");
    }

    #[test]
    fn args_override_risky_config() {
        let ctl = std::path::Path::new("/tmp/x");
        let m = master_args(ctl, "me@box:2222", true).join(" ");
        for want in ["-M -N", "BatchMode=yes", "RemoteCommand=none", "ForwardAgent=no", "PermitLocalCommand=no", "ClearAllForwardings=yes", "ControlPath=/tmp/x/%C", "-p 2222 -- me@box"] {
            assert!(m.contains(want), "{want} in {m}");
        }
        let c = channel_args(ctl, "box").join(" ");
        assert!(c.starts_with("-o ControlMaster=no -o BatchMode=yes -s") && c.ends_with("-- box sftp"), "{c}");
    }

    #[test]
    fn friendly_errors() {
        assert!(classify("@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\n...", "box").contains("won't connect"));
        assert!(classify("me@box: Permission denied (publickey,password).", "me@box").starts_with("me@box refused"));
        assert!(classify("ssh: Could not resolve hostname nope: nodename nor servname provided", "nope").contains("Couldn't find"));
        assert!(classify("ssh: connect to host box port 22: Connection refused", "box").contains("Remote Login"));
        assert_eq!(classify("", "box"), "Couldn't connect to box.");
    }

    /// The whole connect path against a stand-in `ssh` that runs the local
    /// sftp-server (no network, no login).
    #[test]
    fn connect_with_stand_in_ssh() {
        if !std::path::Path::new("/usr/libexec/sftp-server").exists() { return; }
        let d = std::env::temp_dir().join(format!("fathom-fakessh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let fake = d.join("ssh");
        std::fs::write(&fake, "#!/bin/sh\ncase \" $* \" in\n  *' -O check '*) exit 0 ;;\n  *' -M '*) exec sleep 30 ;;\n  *) exec /usr/libexec/sftp-server ;;\nesac\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("FATHOM_SSH", &fake);
        let c = Conn::connect("me@box", true, &|| false).expect("connects");
        std::env::remove_var("FATHOM_SSH");
        assert!(!c.home.is_empty() && c.alive());
        assert!(c.sftp().unwrap().read_dir(&c.home).is_ok());
        c.close();
        assert!(!c.alive());
        std::fs::remove_dir_all(&d).unwrap();
    }
}
