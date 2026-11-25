//! A small, blocking SFTP v3 client (draft-ietf-secsh-filexfer-02, which is
//! what OpenSSH speaks) over any byte stream — in Fathom, the stdin/stdout of
//! `ssh -s <host> sftp`; in tests, `/usr/libexec/sftp-server` directly.
//!
//! Many requests can be in flight at once from any thread: a reader thread
//! hands each reply to whoever is waiting on its request id, so a big
//! transfer's pipelined reads don't hold up browsing on the same channel.

#![allow(dead_code)] // the write side is used by transfers (Phase B)

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex};

// Packet types
const INIT: u8 = 1;
const VERSION: u8 = 2;
const OPEN: u8 = 3;
const CLOSE: u8 = 4;
const READ: u8 = 5;
const WRITE: u8 = 6;
const LSTAT: u8 = 7;
const SETSTAT: u8 = 9;
const OPENDIR: u8 = 11;
const READDIR: u8 = 12;
const REMOVE: u8 = 13;
const MKDIR: u8 = 14;
const RMDIR: u8 = 15;
const REALPATH: u8 = 16;
const STAT: u8 = 17;
const RENAME: u8 = 18;
const READLINK: u8 = 19;
const SYMLINK: u8 = 20;
const STATUS: u8 = 101;
const HANDLE: u8 = 102;
const DATA: u8 = 103;
const NAME: u8 = 104;
const ATTRS: u8 = 105;
const EXTENDED: u8 = 200;
const EXTENDED_REPLY: u8 = 201;

// Status codes
pub const FX_EOF: u32 = 1;
pub const FX_NO_SUCH_FILE: u32 = 2;
pub const FX_PERMISSION_DENIED: u32 = 3;
pub const FX_FAILURE: u32 = 4;
pub const FX_OP_UNSUPPORTED: u32 = 8;

// Attribute flags
const A_SIZE: u32 = 0x1;
const A_UIDGID: u32 = 0x2;
const A_PERMS: u32 = 0x4;
const A_TIMES: u32 = 0x8;
const A_EXT: u32 = 0x8000_0000;

// Open flags
pub const O_READ: u32 = 0x1;
pub const O_WRITE: u32 = 0x2;
pub const O_CREAT: u32 = 0x8;
pub const O_TRUNC: u32 = 0x10;
pub const O_EXCL: u32 = 0x20;

/// Largest packet we accept (OpenSSH's own limit is 256 KiB).
const MAX_PACKET: usize = 1 << 20;

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// The server answered with a status code (and its message).
    Status(u32, String),
    /// The connection is gone (ssh exited, pipe broke).
    Lost,
    /// The server sent something we can't make sense of.
    Protocol(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Status(FX_NO_SUCH_FILE, _) => write!(f, "No such file or folder"),
            Error::Status(FX_PERMISSION_DENIED, _) => write!(f, "Permission denied"),
            Error::Status(FX_OP_UNSUPPORTED, _) => write!(f, "The server doesn't support that"),
            Error::Status(_, m) if !m.is_empty() => write!(f, "{m}"),
            Error::Status(c, _) => write!(f, "The server refused (error {c})"),
            Error::Lost => write!(f, "The connection to the server was lost"),
            Error::Protocol(m) => write!(f, "Unexpected reply from the server: {m}"),
        }
    }
}

impl Error {
    pub fn code(&self) -> Option<u32> {
        if let Error::Status(c, _) = self { Some(*c) } else { None }
    }
    pub fn not_found(&self) -> bool { self.code() == Some(FX_NO_SUCH_FILE) }
}

pub type Result<T> = std::result::Result<T, Error>;

/// File attributes; absent fields are None.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Attrs {
    pub size: Option<u64>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub perms: Option<u32>,
    pub atime: Option<u32>,
    pub mtime: Option<u32>,
}

impl Attrs {
    const IFMT: u32 = 0o170000;
    pub fn is_dir(&self) -> bool { self.perms.is_some_and(|p| p & Self::IFMT == 0o040000) }
    pub fn is_symlink(&self) -> bool { self.perms.is_some_and(|p| p & Self::IFMT == 0o120000) }
    pub fn is_file(&self) -> bool { self.perms.is_some_and(|p| p & Self::IFMT == 0o100000) }
}

/// One READDIR entry.
#[derive(Debug, Clone)]
pub struct DirEntry {
    pub name: String,
    /// `ls -l` style line (owner and group names live only here).
    pub longname: String,
    pub attrs: Attrs,
}

/// statvfs@openssh.com
#[derive(Debug, Clone, Copy)]
pub struct Space {
    pub total: u64,
    pub free: u64,
    pub avail: u64,
}

// ---------------------------------------------------------------- encoding

struct Buf(Vec<u8>);
impl Buf {
    fn new() -> Self { Buf(Vec::with_capacity(64)) }
    fn u32(mut self, v: u32) -> Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    fn u64(mut self, v: u64) -> Self { self.0.extend_from_slice(&v.to_be_bytes()); self }
    fn bytes(mut self, b: &[u8]) -> Self { self = self.u32(b.len() as u32); self.0.extend_from_slice(b); self }
    fn str(self, s: &str) -> Self { self.bytes(s.as_bytes()) }
    fn attrs(self, a: &Attrs) -> Self {
        let mut flags = 0;
        if a.size.is_some() { flags |= A_SIZE; }
        if a.uid.is_some() && a.gid.is_some() { flags |= A_UIDGID; }
        if a.perms.is_some() { flags |= A_PERMS; }
        if a.atime.is_some() && a.mtime.is_some() { flags |= A_TIMES; }
        let mut b = self.u32(flags);
        if let Some(s) = a.size { b = b.u64(s); }
        if flags & A_UIDGID != 0 { b = b.u32(a.uid.unwrap()).u32(a.gid.unwrap()); }
        if let Some(p) = a.perms { b = b.u32(p); }
        if flags & A_TIMES != 0 { b = b.u32(a.atime.unwrap()).u32(a.mtime.unwrap()); }
        b
    }
}

struct Rd<'a> { b: &'a [u8], at: usize }
impl<'a> Rd<'a> {
    fn new(b: &'a [u8]) -> Self { Rd { b, at: 0 } }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.at + n > self.b.len() { return Err(Error::Protocol("short packet".into())); }
        let s = &self.b[self.at..self.at + n]; self.at += n; Ok(s)
    }
    fn u32(&mut self) -> Result<u32> { Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap())) }
    fn u64(&mut self) -> Result<u64> { Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap())) }
    fn bytes(&mut self) -> Result<&'a [u8]> { let n = self.u32()? as usize; self.take(n) }
    fn string(&mut self) -> Result<String> { Ok(String::from_utf8_lossy(self.bytes()?).into_owned()) }
    fn done(&self) -> bool { self.at >= self.b.len() }
    fn attrs(&mut self) -> Result<Attrs> {
        let f = self.u32()?;
        let mut a = Attrs::default();
        if f & A_SIZE != 0 { a.size = Some(self.u64()?); }
        if f & A_UIDGID != 0 { a.uid = Some(self.u32()?); a.gid = Some(self.u32()?); }
        if f & A_PERMS != 0 { a.perms = Some(self.u32()?); }
        if f & A_TIMES != 0 { a.atime = Some(self.u32()?); a.mtime = Some(self.u32()?); }
        if f & A_EXT != 0 { for _ in 0..self.u32()? { self.bytes()?; self.bytes()?; } }
        Ok(a)
    }
}

fn read_packet(r: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let n = u32::from_be_bytes(len) as usize;
    if n == 0 || n > MAX_PACKET { return Err(std::io::Error::other("bad packet length")); }
    let mut p = vec![0u8; n];
    r.read_exact(&mut p)?;
    Ok(p)
}

// ---------------------------------------------------------------- client

type Reply = (u8, Vec<u8>); // type, body after the request id
type Waiters = Arc<Mutex<HashMap<u32, SyncSender<Option<Reply>>>>>;

pub struct Sftp {
    w: Mutex<Box<dyn Write + Send>>,
    waiters: Waiters,
    next: AtomicU32,
    dead: Arc<AtomicBool>,
    exts: HashMap<String, String>,
}

/// A reply that hasn't been waited for yet (for pipelining).
pub struct Pending(Receiver<Option<Reply>>);

impl Pending {
    fn wait(self) -> Result<Reply> { self.0.recv().ok().flatten().ok_or(Error::Lost) }
}

impl Sftp {
    /// Say hello on `r` / `w` and start the reader thread.
    pub fn start(mut r: impl Read + Send + 'static, mut w: impl Write + Send + 'static) -> Result<Sftp> {
        let lost = |_| Error::Lost;
        let mut init = Buf::new().u32(5).0; // length 5: type + version
        init.push(INIT);
        init.extend_from_slice(&3u32.to_be_bytes());
        w.write_all(&init).and_then(|_| w.flush()).map_err(lost)?;
        let p = read_packet(&mut r).map_err(lost)?;
        if p[0] != VERSION { return Err(Error::Protocol(format!("expected VERSION, got {}", p[0]))); }
        let mut rd = Rd::new(&p[1..]);
        let ver = rd.u32()?;
        if ver < 3 { return Err(Error::Protocol(format!("SFTP version {ver} is too old"))); }
        let mut exts = HashMap::new();
        while !rd.done() { let k = rd.string()?; let v = rd.string()?; exts.insert(k, v); }

        let waiters: Waiters = Arc::default();
        let dead = Arc::new(AtomicBool::new(false));
        let (wt, dd) = (waiters.clone(), dead.clone());
        std::thread::spawn(move || {
            while let Ok(p) = read_packet(&mut r) {
                if p.len() < 5 { break; }
                let id = u32::from_be_bytes(p[1..5].try_into().unwrap());
                if let Some(tx) = wt.lock().unwrap().remove(&id) { let _ = tx.send(Some((p[0], p[5..].to_vec()))); }
            }
            dd.store(true, Ordering::SeqCst);
            for (_, tx) in wt.lock().unwrap().drain() { let _ = tx.send(None); }
        });
        Ok(Sftp { w: Mutex::new(Box::new(w)), waiters, next: AtomicU32::new(1), dead, exts })
    }

    pub fn alive(&self) -> bool { !self.dead.load(Ordering::SeqCst) }
    pub fn has_ext(&self, name: &str) -> bool { self.exts.contains_key(name) }

    /// Send a request; the reply comes back through the returned Pending.
    fn send(&self, ty: u8, body: Buf) -> Result<Pending> {
        if !self.alive() { return Err(Error::Lost); }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = sync_channel(1);
        self.waiters.lock().unwrap().insert(id, tx);
        let mut pkt = Vec::with_capacity(9 + body.0.len());
        pkt.extend_from_slice(&((5 + body.0.len()) as u32).to_be_bytes());
        pkt.push(ty);
        pkt.extend_from_slice(&id.to_be_bytes());
        pkt.extend_from_slice(&body.0);
        let ok = { let mut w = self.w.lock().unwrap(); w.write_all(&pkt).and_then(|_| w.flush()) };
        if ok.is_err() {
            self.waiters.lock().unwrap().remove(&id);
            return Err(Error::Lost);
        }
        // The reader may have died between the alive check and the insert.
        if !self.alive() { if let Some(tx) = self.waiters.lock().unwrap().remove(&id) { let _ = tx.send(None); } }
        Ok(Pending(rx))
    }

    fn call(&self, ty: u8, body: Buf) -> Result<Reply> { self.send(ty, body)?.wait() }

    fn status(reply: Reply) -> Result<()> {
        match reply {
            (STATUS, b) => {
                let mut r = Rd::new(&b);
                let code = r.u32()?;
                if code == 0 { Ok(()) } else { Err(Error::Status(code, r.string().unwrap_or_default())) }
            }
            (t, _) => Err(Error::Protocol(format!("expected STATUS, got {t}"))),
        }
    }
    fn expect(reply: Reply, want: u8) -> Result<Vec<u8>> {
        if reply.0 == want { return Ok(reply.1); }
        Self::status(reply)?;
        Err(Error::Protocol(format!("expected {want}, got STATUS OK")))
    }
    fn attrs_reply(reply: Reply) -> Result<Attrs> { Rd::new(&Self::expect(reply, ATTRS)?).attrs() }
    fn handle_reply(reply: Reply) -> Result<Vec<u8>> { Ok(Rd::new(&Self::expect(reply, HANDLE)?).bytes()?.to_vec()) }
    fn first_name(reply: Reply) -> Result<String> {
        let b = Self::expect(reply, NAME)?;
        let mut r = Rd::new(&b);
        if r.u32()? == 0 { return Err(Error::Protocol("empty NAME".into())); }
        r.string()
    }

    // ---- paths & metadata

    pub fn realpath(&self, path: &str) -> Result<String> { Self::first_name(self.call(REALPATH, Buf::new().str(path))?) }
    pub fn stat(&self, path: &str) -> Result<Attrs> { Self::attrs_reply(self.call(STAT, Buf::new().str(path))?) }
    pub fn lstat(&self, path: &str) -> Result<Attrs> { Self::attrs_reply(self.call(LSTAT, Buf::new().str(path))?) }
    pub fn setstat(&self, path: &str, a: &Attrs) -> Result<()> { Self::status(self.call(SETSTAT, Buf::new().str(path).attrs(a))?) }
    pub fn readlink(&self, path: &str) -> Result<String> { Self::first_name(self.call(READLINK, Buf::new().str(path))?) }

    /// Every entry of a folder (without "." and "..").
    pub fn read_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let h = Self::handle_reply(self.call(OPENDIR, Buf::new().str(path))?)?;
        let mut out = Vec::new();
        let res = loop {
            let reply = match self.call(READDIR, Buf::new().bytes(&h)) { Ok(r) => r, Err(e) => break Err(e) };
            if reply.0 == STATUS {
                match Self::status(reply) { Err(Error::Status(FX_EOF, _)) => break Ok(()), Err(e) => break Err(e), Ok(()) => break Ok(()) }
            }
            let b = match Self::expect(reply, NAME) { Ok(b) => b, Err(e) => break Err(e) };
            let mut r = Rd::new(&b);
            let parsed = (|| -> Result<()> {
                for _ in 0..r.u32()? {
                    let name = r.string()?; let longname = r.string()?; let attrs = r.attrs()?;
                    if name != "." && name != ".." { out.push(DirEntry { name, longname, attrs }); }
                }
                Ok(())
            })();
            if let Err(e) = parsed { break Err(e); }
        };
        let _ = self.close(&h);
        res.map(|_| out)
    }

    // ---- changes

    /// Make `link` point at `target`. (OpenSSH takes the two the other way
    /// round from the draft; every server you'll meet is OpenSSH's.)
    pub fn symlink(&self, target: &str, link: &str) -> Result<()> { Self::status(self.call(SYMLINK, Buf::new().str(target).str(link))?) }

    pub fn mkdir(&self, path: &str) -> Result<()> { Self::status(self.call(MKDIR, Buf::new().str(path).attrs(&Attrs::default()))?) }
    pub fn rmdir(&self, path: &str) -> Result<()> { Self::status(self.call(RMDIR, Buf::new().str(path))?) }
    pub fn remove(&self, path: &str) -> Result<()> { Self::status(self.call(REMOVE, Buf::new().str(path))?) }
    /// Plain SFTP rename: fails if `to` exists.
    pub fn rename(&self, from: &str, to: &str) -> Result<()> { Self::status(self.call(RENAME, Buf::new().str(from).str(to))?) }
    /// Rename that replaces `to` (posix-rename@openssh.com); falls back to remove + rename.
    pub fn rename_over(&self, from: &str, to: &str) -> Result<()> {
        if self.has_ext("posix-rename@openssh.com") {
            return Self::status(self.call(EXTENDED, Buf::new().str("posix-rename@openssh.com").str(from).str(to))?);
        }
        match self.remove(to) { Ok(()) => {} Err(e) if e.not_found() => {} Err(e) => return Err(e) }
        self.rename(from, to)
    }

    pub fn statvfs(&self, path: &str) -> Result<Space> {
        if !self.has_ext("statvfs@openssh.com") { return Err(Error::Status(FX_OP_UNSUPPORTED, String::new())); }
        let b = Self::expect(self.call(EXTENDED, Buf::new().str("statvfs@openssh.com").str(path))?, EXTENDED_REPLY)?;
        let mut r = Rd::new(&b);
        let bsize = r.u64()?; let frsize = r.u64()?; let blocks = r.u64()?; let bfree = r.u64()?; let bavail = r.u64()?;
        let unit = if frsize > 0 { frsize } else { bsize };
        Ok(Space { total: blocks * unit, free: bfree * unit, avail: bavail * unit })
    }

    // ---- file contents

    pub fn open(&self, path: &str, flags: u32, perms: Option<u32>) -> Result<Vec<u8>> {
        let a = Attrs { perms, ..Default::default() };
        Self::handle_reply(self.call(OPEN, Buf::new().str(path).u32(flags).attrs(&a))?)
    }
    pub fn close(&self, h: &[u8]) -> Result<()> { Self::status(self.call(CLOSE, Buf::new().bytes(h))?) }

    /// Start a read (pipelining: issue several, then `finish_read` each in order).
    pub fn read_at(&self, h: &[u8], off: u64, len: u32) -> Result<Pending> { self.send(READ, Buf::new().bytes(h).u64(off).u32(len)) }
    /// The data of a read; empty at end of file.
    pub fn finish_read(p: Pending) -> Result<Vec<u8>> {
        let reply = p.wait()?;
        if reply.0 == DATA { return Ok(Rd::new(&reply.1).bytes()?.to_vec()); }
        match Self::status(reply) { Err(Error::Status(FX_EOF, _)) => Ok(Vec::new()), Err(e) => Err(e), Ok(()) => Ok(Vec::new()) }
    }
    pub fn write_at(&self, h: &[u8], off: u64, data: &[u8]) -> Result<Pending> { self.send(WRITE, Buf::new().bytes(h).u64(off).bytes(data)) }
    pub fn finish_write(p: Pending) -> Result<()> { Self::status(p.wait()?) }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    /// A client talking straight to the system's sftp-server (no ssh), rooted
    /// at the current folder. None when sftp-server isn't installed.
    pub(crate) fn local_server() -> Option<(Sftp, std::process::Child)> {
        let bin = "/usr/libexec/sftp-server";
        if !std::path::Path::new(bin).exists() { return None; }
        let mut c = Command::new(bin).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
        let (w, r) = (c.stdin.take()?, c.stdout.take()?);
        Some((Sftp::start(r, w).expect("handshake"), c))
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("fathom-sftp-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    #[test]
    fn browse_and_metadata() {
        let Some((s, mut child)) = local_server() else { return };
        let d = tmp("browse");
        std::fs::create_dir(d.join("sub")).unwrap();
        std::fs::write(d.join("a.txt"), b"hello").unwrap();
        std::os::unix::fs::symlink("a.txt", d.join("link")).unwrap();
        for i in 0..1500 { std::fs::write(d.join("sub").join(format!("f{i}")), b"").unwrap(); }
        let p = d.to_str().unwrap();

        assert_eq!(s.realpath(&format!("{p}/sub/..")).unwrap(), p);
        let mut names: Vec<_> = s.read_dir(p).unwrap().into_iter().map(|e| e.name).collect();
        names.sort();
        assert_eq!(names, ["a.txt", "link", "sub"]);
        assert_eq!(s.read_dir(&format!("{p}/sub")).unwrap().len(), 1500, "several READDIR batches");

        let a = s.stat(&format!("{p}/a.txt")).unwrap();
        assert!(a.is_file() && a.size == Some(5) && a.mtime.is_some());
        assert!(s.lstat(&format!("{p}/link")).unwrap().is_symlink());
        assert!(s.stat(&format!("{p}/link")).unwrap().is_file());
        assert_eq!(s.readlink(&format!("{p}/link")).unwrap(), "a.txt");
        assert!(s.stat(&format!("{p}/sub")).unwrap().is_dir());
        assert!(s.stat(&format!("{p}/nope")).unwrap_err().not_found());
        if s.has_ext("statvfs@openssh.com") { assert!(s.statvfs(p).unwrap().total > 0); }

        let _ = child.kill();
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn write_read_rename_remove() {
        let Some((s, mut child)) = local_server() else { return };
        let d = tmp("rw");
        let p = |n: &str| format!("{}/{n}", d.display());

        s.mkdir(&p("dir")).unwrap();
        assert!(s.mkdir(&p("dir")).is_err(), "mkdir on an existing folder fails");
        // Pipelined write of 1 MiB in 32 KiB chunks, then read it back the same way.
        let data: Vec<u8> = (0..1u32 << 20).map(|i| (i % 251) as u8).collect();
        let h = s.open(&p("dir/big"), O_WRITE | O_CREAT | O_EXCL, Some(0o644)).unwrap();
        let pend: Vec<_> = data.chunks(32 << 10).enumerate().map(|(i, c)| s.write_at(&h, (i * (32 << 10)) as u64, c).unwrap()).collect();
        for w in pend { Sftp::finish_write(w).unwrap(); }
        s.close(&h).unwrap();
        assert!(s.open(&p("dir/big"), O_WRITE | O_CREAT | O_EXCL, None).is_err(), "EXCL refuses an existing file");

        let h = s.open(&p("dir/big"), O_READ, None).unwrap();
        let pend: Vec<_> = (0..40u64).map(|i| s.read_at(&h, i * (32 << 10), 32 << 10).unwrap()).collect();
        let mut back = Vec::new();
        for r in pend { back.extend(Sftp::finish_read(r).unwrap()); }
        s.close(&h).unwrap();
        assert_eq!(back, data, "reads past the end come back empty");

        std::fs::write(d.join("other"), b"x").unwrap();
        assert!(s.rename(&p("other"), &p("dir/big")).is_err(), "plain rename won't replace");
        s.rename_over(&p("other"), &p("dir/big")).unwrap();
        assert_eq!(std::fs::read(d.join("dir/big")).unwrap(), b"x");
        s.setstat(&p("dir/big"), &Attrs { atime: Some(1_000_000_000), mtime: Some(1_000_000_000), ..Default::default() }).unwrap();
        assert_eq!(s.stat(&p("dir/big")).unwrap().mtime, Some(1_000_000_000));

        assert!(s.rmdir(&p("dir")).is_err(), "rmdir of a non-empty folder fails");
        s.remove(&p("dir/big")).unwrap();
        s.rmdir(&p("dir")).unwrap();
        assert!(s.stat(&p("dir")).unwrap_err().not_found());

        let _ = child.kill();
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn concurrent_callers_and_lost_connection() {
        let Some((s, mut child)) = local_server() else { return };
        let s = Arc::new(s);
        let tmpd = std::env::temp_dir();
        let t = tmpd.to_str().unwrap().to_string();
        let hs: Vec<_> = (0..8).map(|_| { let (s, t) = (s.clone(), t.clone()); std::thread::spawn(move || (0..50).all(|_| s.stat(&t).is_ok())) }).collect();
        assert!(hs.into_iter().all(|h| h.join().unwrap()));
        let _ = child.kill();
        let _ = child.wait();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(s.stat(&t).unwrap_err(), Error::Lost);
        assert!(!s.alive());
    }
}
