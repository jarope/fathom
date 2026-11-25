//! Copy / move when a server is involved (Mac → server, server → Mac, and
//! within one server). The local-only engine in jobs.rs is untouched; this
//! one speaks to both sides through `Fs`, emits the same job progress, and
//! honours the same clash policies:
//! - Keep both: "name copy.ext", "name copy 2.ext"…
//! - Skip.
//! - Merge (folders): contents go in, clashes inside are kept both.
//! - Replace: on the Mac the old item goes to the Bin (as ever); on a server
//!   there's no Bin, so the new copy is uploaded first and the old one is
//!   deleted only once that has worked.
//! Uploads land under a hidden ".name.fathom-part" name and are renamed when
//! complete, so a failed or cancelled upload never leaves a half file under
//! the real name. Moves between machines are copy, then delete the original.

use super::sftp::{self, Attrs, Sftp, O_CREAT, O_EXCL, O_READ, O_WRITE};
use super::ssh::Channel;
use crate::jobs::{cancelled_err, is_cancel, Conflict, Ctl, OpReport, Policy};
use std::collections::{HashMap, VecDeque};
use std::io::{self, Read, Write};
use std::sync::Arc;

const CHUNK: usize = 32 * 1024; // safe for every SFTP server
const WINDOW: usize = 32; // requests in flight per file

// ---------------------------------------------------------------- the two sides

#[derive(Clone)]
pub enum Fs {
    Local,
    Remote { conn: String, s: Arc<Channel> },
}

#[derive(Clone, Copy, Debug)]
pub struct Meta {
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: Option<u64>,
    pub perms: u32,
}

fn io_err(e: sftp::Error) -> io::Error {
    if e.not_found() { io::Error::new(io::ErrorKind::NotFound, e.to_string()) } else { io::Error::other(e.to_string()) }
}

impl From<&Attrs> for Meta {
    fn from(a: &Attrs) -> Meta {
        Meta { is_dir: a.is_dir(), is_symlink: a.is_symlink(), size: a.size.unwrap_or(0), mtime: a.mtime.map(u64::from), perms: a.perms.unwrap_or(0o644) & 0o7777 }
    }
}

pub fn join(dir: &str, name: &str) -> String { super::join(dir, name) }
fn name_of(p: &str) -> &str { p.trim_end_matches('/').rsplit('/').next().unwrap_or(p) }
fn parent_of(p: &str) -> String { super::parent_of(p).unwrap_or_else(|| "/".into()) }

impl Fs {
    fn sftp(&self) -> Option<&Sftp> { if let Fs::Remote { s, .. } = self { Some(s) } else { None } }
    fn conn(&self) -> Option<&str> { if let Fs::Remote { conn, .. } = self { Some(conn) } else { None } }
    /// The same file system (both the Mac, or the same server)?
    fn same(&self, o: &Fs) -> bool { self.conn() == o.conn() }
    /// How a path here is written for the page.
    pub fn loc(&self, p: &str) -> String { match self.conn() { Some(c) => super::url(c, p), None => p.to_string() } }

    /// Metadata without following links; None if it doesn't exist.
    pub fn lstat(&self, p: &str) -> io::Result<Option<Meta>> {
        match self.sftp() {
            Some(s) => match s.lstat(p) { Ok(a) => Ok(Some((&a).into())), Err(e) if e.not_found() => Ok(None), Err(e) => Err(io_err(e)) },
            None => match std::fs::symlink_metadata(p) {
                Ok(m) => {
                    use std::os::unix::fs::{MetadataExt, PermissionsExt};
                    Ok(Some(Meta { is_dir: m.is_dir(), is_symlink: m.file_type().is_symlink(), size: m.len(), mtime: Some(m.mtime().max(0) as u64), perms: m.permissions().mode() & 0o7777 }))
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e),
            },
        }
    }
    fn exists(&self, p: &str) -> bool { matches!(self.lstat(p), Ok(Some(_))) }
    fn names(&self, p: &str) -> io::Result<Vec<String>> {
        match self.sftp() {
            Some(s) => Ok(s.read_dir(p).map_err(io_err)?.into_iter().map(|e| e.name).collect()),
            None => std::fs::read_dir(p)?.map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned())).collect(),
        }
    }
    fn mkdir(&self, p: &str) -> io::Result<()> {
        match self.sftp() { Some(s) => s.mkdir(p).map_err(io_err), None => std::fs::create_dir(p) }
    }
    fn remove_file(&self, p: &str) -> io::Result<()> {
        match self.sftp() { Some(s) => s.remove(p).map_err(io_err), None => std::fs::remove_file(p) }
    }
    fn rmdir(&self, p: &str) -> io::Result<()> {
        match self.sftp() { Some(s) => s.rmdir(p).map_err(io_err), None => std::fs::remove_dir(p) }
    }
    /// Rename that refuses to replace (both sides).
    fn rename(&self, from: &str, to: &str) -> io::Result<()> {
        if self.exists(to) { return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} already exists", name_of(to)))); }
        match self.sftp() { Some(s) => s.rename(from, to).map_err(io_err), None => std::fs::rename(from, to) }
    }
    fn read_link(&self, p: &str) -> io::Result<String> {
        match self.sftp() { Some(s) => s.readlink(p).map_err(io_err), None => Ok(std::fs::read_link(p)?.to_string_lossy().into_owned()) }
    }
    fn symlink(&self, target: &str, link: &str) -> io::Result<()> {
        match self.sftp() { Some(s) => s.symlink(target, link).map_err(io_err), None => std::os::unix::fs::symlink(target, link) }
    }
    fn set_mtime(&self, p: &str, mtime: u64) {
        match self.sftp() {
            Some(s) => { let t = mtime as u32; let _ = s.setstat(p, &Attrs { atime: Some(t), mtime: Some(t), ..Default::default() }); }
            None => { if let Ok(f) = std::fs::File::options().write(true).open(p) { let _ = f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime)); } }
        }
    }

    /// Delete a file, link or whole folder (no Bin).
    pub fn remove_tree(&self, p: &str, ctl: Option<&Ctl>) -> io::Result<()> {
        let Some(m) = self.lstat(p)? else { return Ok(()) };
        if m.is_dir && !m.is_symlink {
            for n in self.names(p)? {
                if ctl.is_some_and(|c| c.cancelled()) { return Err(cancelled_err()); }
                self.remove_tree(&join(p, &n), ctl)?;
            }
            self.rmdir(p)
        } else {
            self.remove_file(p)
        }
    }

    /// (bytes, items) under p.
    fn tree_size(&self, p: &str, ctl: &Ctl) -> (u64, u64) {
        let Ok(Some(m)) = self.lstat(p) else { return (0, 0) };
        if !m.is_dir || m.is_symlink { return (m.size, 1); }
        let (mut b, mut n) = (0, 1);
        for c in self.names(p).unwrap_or_default() {
            if ctl.cancelled() { break; }
            let (cb, cn) = self.tree_size(&join(p, &c), ctl);
            b += cb; n += cn;
        }
        (b, n)
    }

    /// "name copy.ext" / "name copy 2.ext" that doesn't exist in dir.
    fn unique(&self, dir: &str, name: &str) -> String {
        let first = join(dir, name);
        if !self.exists(&first) { return first; }
        let (stem, ext) = match name.rfind('.') { Some(i) if i > 0 => (&name[..i], &name[i..]), _ => (name, "") };
        (1..).map(|n| join(dir, &if n == 1 { format!("{stem} copy{ext}") } else { format!("{stem} copy {n}{ext}") })).find(|c| !self.exists(c)).unwrap()
    }
}

// ---------------------------------------------------------------- moving bytes

/// Read a file from the start, handing each piece over in order.
fn read_file(fs: &Fs, p: &str, ctl: &mut Ctl, sink: &mut dyn FnMut(&[u8], &mut Ctl) -> io::Result<()>) -> io::Result<()> {
    match fs.sftp() {
        None => {
            let mut f = std::fs::File::open(p)?;
            let mut buf = vec![0u8; 256 * 1024];
            loop {
                if ctl.cancelled() { return Err(cancelled_err()); }
                let n = f.read(&mut buf)?;
                if n == 0 { return Ok(()); }
                sink(&buf[..n], ctl)?;
            }
        }
        Some(s) => {
            let h = s.open(p, O_READ, None).map_err(io_err)?;
            let mut q: VecDeque<(u64, sftp::Pending)> = VecDeque::new();
            let res = (|| {
                let mut next = 0u64;
                let fill = |q: &mut VecDeque<(u64, sftp::Pending)>, next: &mut u64| -> io::Result<()> {
                    while q.len() < WINDOW { q.push_back((*next, s.read_at(&h, *next, CHUNK as u32).map_err(io_err)?)); *next += CHUNK as u64; }
                    Ok(())
                };
                fill(&mut q, &mut next)?;
                while let Some((off, p)) = q.pop_front() {
                    if ctl.cancelled() { return Err(cancelled_err()); }
                    let data = Sftp::finish_read(p).map_err(io_err)?;
                    if data.is_empty() { break; } // end of file
                    sink(&data, ctl)?;
                    if data.len() < CHUNK {
                        // A short read: drop the reads already in flight and carry on from here.
                        for (_, p) in q.drain(..) { let _ = Sftp::finish_read(p); }
                        next = off + data.len() as u64;
                    }
                    fill(&mut q, &mut next)?;
                }
                Ok(())
            })();
            for (_, p) in q.drain(..) { let _ = Sftp::finish_read(p); }
            let _ = s.close(&h);
            res
        }
    }
}

/// Copy one file's contents to a new file `dst` (which mustn't exist).
fn copy_file(sfs: &Fs, src: &str, dfs: &Fs, dst: &str, m: &Meta, ctl: &mut Ctl) -> io::Result<()> {
    let res = match dfs.sftp() {
        None => {
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(m.perms.max(0o600)).open(dst)?;
            read_file(sfs, src, ctl, &mut |b, ctl| { f.write_all(b)?; ctl.add_bytes(b.len() as u64); Ok(()) })
                .and_then(|_| f.flush())
        }
        Some(s) => {
            let h = s.open(dst, O_WRITE | O_CREAT | O_EXCL, Some(m.perms.max(0o600))).map_err(io_err)?;
            let mut off = 0u64;
            let mut q: VecDeque<sftp::Pending> = VecDeque::new();
            let mut r = read_file(sfs, src, ctl, &mut |b, ctl| {
                for piece in b.chunks(CHUNK) {
                    q.push_back(s.write_at(&h, off, piece).map_err(io_err)?);
                    off += piece.len() as u64;
                    ctl.add_bytes(piece.len() as u64);
                    if q.len() >= WINDOW { Sftp::finish_write(q.pop_front().unwrap()).map_err(io_err)?; }
                }
                Ok(())
            });
            for p in q.drain(..) { let w = Sftp::finish_write(p).map_err(io_err); if r.is_ok() { r = w; } }
            let c = s.close(&h).map_err(io_err);
            r.and(c)
        }
    };
    match res {
        Ok(()) => { if let Some(t) = m.mtime { dfs.set_mtime(dst, t); } ctl.done_items += 1; Ok(()) }
        Err(e) => { let _ = dfs.remove_file(dst); Err(e) }
    }
}

/// Copy a file, link or folder to `dst` (which mustn't exist).
fn copy_any(sfs: &Fs, src: &str, dfs: &Fs, dst: &str, ctl: &mut Ctl) -> io::Result<()> {
    if ctl.cancelled() { return Err(cancelled_err()); }
    let m = sfs.lstat(src)?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no longer exists"))?;
    ctl.current = name_of(src).to_string();
    if m.is_symlink {
        let t = sfs.read_link(src)?;
        dfs.symlink(&t, dst)?;
        ctl.done_items += 1;
    } else if m.is_dir {
        dfs.mkdir(dst)?;
        ctl.done_items += 1;
        for n in sfs.names(src)? {
            copy_any(sfs, &join(src, &n), dfs, &join(dst, &n), ctl)?;
        }
        if let Some(t) = m.mtime { dfs.set_mtime(dst, t); }
    } else {
        copy_file(sfs, src, dfs, dst, &m, ctl)?;
    }
    ctl.tick(false);
    Ok(())
}

/// Copy to `dst`; on a server, via a hidden ".name.fathom-part" next to it,
/// renamed into place only when complete. Cleans up after a failure.
fn copy_safely(sfs: &Fs, src: &str, dfs: &Fs, dst: &str, ctl: &mut Ctl) -> io::Result<()> {
    let tmp = match dfs { Fs::Remote { .. } => join(&parent_of(dst), &format!(".{}.fathom-part", name_of(dst))), Fs::Local => dst.to_string() };
    if tmp != dst { let _ = dfs.remove_tree(&tmp, None); } // a leftover from an earlier failure
    match copy_any(sfs, src, dfs, &tmp, ctl) {
        Ok(()) => if tmp != dst { dfs.rename(&tmp, dst) } else { Ok(()) },
        Err(e) => { let _ = dfs.remove_tree(&tmp, None); Err(e) }
    }
}

/// Move (same server: rename; otherwise copy, then delete the original).
fn move_any(sfs: &Fs, src: &str, dfs: &Fs, dst: &str, ctl: &mut Ctl) -> io::Result<()> {
    if sfs.same(dfs) {
        dfs.rename(src, dst)?;
        ctl.done_items += 1;
        return Ok(());
    }
    copy_safely(sfs, src, dfs, dst, ctl)?;
    sfs.remove_tree(src, None).map_err(|e| io::Error::other(format!("copied, but couldn't remove the original: {e}")))
}

fn merge_into(sfs: &Fs, src: &str, dfs: &Fs, dst: &str, do_move: bool, ctl: &mut Ctl, rep: &mut OpReport) -> io::Result<()> {
    for n in sfs.names(src)? {
        if ctl.cancelled() { return Err(cancelled_err()); }
        let (s, d) = (join(src, &n), join(dst, &n));
        if let (Some(sm), Some(dm)) = (sfs.lstat(&s)?, dfs.lstat(&d)?) {
            if sm.is_dir && !sm.is_symlink && dm.is_dir && !dm.is_symlink { merge_into(sfs, &s, dfs, &d, do_move, ctl, rep)?; continue; }
            if n == ".DS_Store" { if do_move { let _ = sfs.remove_file(&s); } continue; }
        }
        let target = if dfs.exists(&d) { rep.renamed += 1; dfs.unique(dst, &n) } else { d };
        if do_move { move_any(sfs, &s, dfs, &target, ctl)?; } else { copy_safely(sfs, &s, dfs, &target, ctl)?; }
        rep.pairs.push([sfs.loc(&s), dfs.loc(&target)]);
    }
    if do_move { let _ = sfs.rmdir(src); }
    Ok(())
}

// ---------------------------------------------------------------- locations

/// Locations (paths or sftp:// URLs) → their side and the path there. Each
/// server gets one transfer channel for the whole job.
struct Sides { chans: HashMap<String, Fs> }

impl Sides {
    fn new() -> Self { Sides { chans: HashMap::new() } }
    fn resolve(&mut self, loc: &str) -> Result<(Fs, String), String> {
        let Some((conn, path)) = super::parse(loc) else { return Ok((Fs::Local, loc.to_string())) };
        if !self.chans.contains_key(&conn) {
            let c = super::get(&conn, false)?;
            let ch = c.open_channel()?;
            self.chans.insert(conn.clone(), Fs::Remote { conn: conn.clone(), s: Arc::new(ch) });
        }
        let fs = self.chans[&conn].clone();
        let path = match path { Some(p) => p, None => super::get(&conn, true)?.home.clone() };
        Ok((fs, path))
    }
}

/// Download one server file to `local`, replacing it (open & save back).
pub fn download(fs: &Fs, remote: &str, local: &std::path::Path) -> io::Result<()> {
    let tmp = local.with_file_name(format!(".{}.fathom-part", name_of(&local.to_string_lossy())));
    let tmp_s = tmp.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&tmp);
    let mut ctl = Ctl::detached();
    let m = fs.lstat(remote)?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no longer exists"))?;
    copy_file(fs, remote, &Fs::Local, &tmp_s, &m, &mut ctl)?;
    std::fs::rename(&tmp, local)
}

/// Upload `local` over the server file `remote` (or to a new name): via a
/// hidden part file that replaces it only once complete.
pub fn upload_over(local: &std::path::Path, fs: &Fs, remote: &str) -> io::Result<()> {
    let Fs::Remote { s, .. } = fs else { return Err(io::Error::other("not a server")) };
    let tmp = join(&parent_of(remote), &format!(".{}.fathom-part", name_of(remote)));
    let _ = fs.remove_tree(&tmp, None);
    let l = local.to_string_lossy().into_owned();
    let mut m = Fs::Local.lstat(&l)?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the edited copy is gone"))?;
    // Keep the server file's own permissions.
    if let Ok(Some(old)) = fs.lstat(remote) { m.perms = old.perms; }
    copy_file(&Fs::Local, &l, fs, &tmp, &m, &mut Ctl::detached())?;
    s.rename_over(&tmp, remote).map_err(|e| { let _ = fs.remove_file(&tmp); io_err(e) })
}

/// Does a transfer involve a server?
pub fn involves_server(sources: &[String], dest: &str) -> bool {
    super::is_remote(dest) || sources.iter().any(|s| super::is_remote(s))
}

/// The engine (start_transfer, when a server is involved).
pub fn run(items: Vec<(String, Policy)>, dest_dir: &str, do_move: bool, ctl: &mut Ctl) -> OpReport {
    run_sides(&mut Sides::new(), items, dest_dir, do_move, ctl)
}

fn run_sides(sides: &mut Sides, items: Vec<(String, Policy)>, dest_dir: &str, do_move: bool, ctl: &mut Ctl) -> OpReport {
    let mut rep = OpReport::default();
    ctl.phase = "scan";
    ctl.tick(true);
    let (dfs, dest) = match sides.resolve(dest_dir) {
        Ok(x) => x,
        Err(e) => { rep.errors.push(e); return rep; }
    };
    match dfs.lstat(&dest) {
        Ok(Some(m)) if m.is_dir => {}
        _ => { rep.errors.push(format!("Destination is not a folder: {dest_dir}")); return rep; }
    }

    struct Prep { sfs: Fs, src: String, name: String, policy: Policy, fast: bool }
    let mut preps = Vec::new();
    for (loc, policy) in items {
        if ctl.cancelled() { return rep; }
        let (sfs, src) = match sides.resolve(&loc) { Ok(x) => x, Err(e) => { rep.errors.push(e); continue; } };
        let name = name_of(&src).to_string();
        let Ok(Some(m)) = sfs.lstat(&src) else { rep.errors.push(format!("{name}: no longer exists")); continue };
        if sfs.same(&dfs) {
            if m.is_dir && (dest == src || dest.starts_with(&format!("{}/", src.trim_end_matches('/')))) { rep.errors.push(format!("{name}: can't put a folder inside itself")); continue; }
            if do_move && parent_of(&src) == dest { rep.skipped += 1; continue; }
        }
        let fast = do_move && sfs.same(&dfs);
        if fast { ctl.total_items += 1; } else { let (b, n) = sfs.tree_size(&src, ctl); ctl.total_bytes += b; ctl.total_items += n; }
        preps.push(Prep { sfs, src, name, policy, fast });
    }

    ctl.phase = if do_move { "move" } else { "copy" };
    ctl.tick(true);
    for p in preps {
        if ctl.cancelled() { break; }
        let first = join(&dest, &p.name);
        let clash = dfs.exists(&first);
        let is_self = clash && p.sfs.same(&dfs) && first == p.src;
        let mut replace_old = false;
        let target = if !clash { first.clone() } else {
            match p.policy {
                Policy::Skip => { rep.skipped += 1; continue; }
                Policy::Replace if !is_self => {
                    if p.sfs.same(&dfs) && p.src.starts_with(&format!("{first}/")) { rep.errors.push(format!("{}: can't replace a folder that contains it", p.name)); continue; }
                    match &dfs {
                        Fs::Local => {
                            let binned = crate::bin_ops::trash_paths(&[first.clone()]);
                            if let Some(e) = binned.errors.first() { rep.errors.push(format!("{}: couldn't move the existing item to the Bin: {e}", p.name)); continue; }
                            rep.replaced += 1;
                            first.clone()
                        }
                        // On a server: put the new one beside it, swap once it's all there.
                        Fs::Remote { .. } => { replace_old = true; join(&dest, &format!(".{}.fathom-new", p.name)) }
                    }
                }
                Policy::Merge if !is_self => {
                    let (sm, dm) = (p.sfs.lstat(&p.src).ok().flatten(), dfs.lstat(&first).ok().flatten());
                    if sm.is_some_and(|m| m.is_dir && !m.is_symlink) && dm.is_some_and(|m| m.is_dir && !m.is_symlink) {
                        ctl.current = p.name.clone();
                        match merge_into(&p.sfs, &p.src, &dfs, &first, do_move, ctl, &mut rep) {
                            Ok(()) => { rep.merged += 1; rep.done += 1; }
                            Err(e) if is_cancel(&e) => break,
                            Err(e) => rep.errors.push(format!("{}: {e}", p.name)),
                        }
                        continue;
                    }
                    rep.renamed += 1;
                    dfs.unique(&dest, &p.name)
                }
                _ => { rep.renamed += 1; dfs.unique(&dest, &p.name) }
            }
        };
        ctl.current = p.name.clone();
        let mut res = if do_move { move_any(&p.sfs, &p.src, &dfs, &target, ctl) } else { copy_safely(&p.sfs, &p.src, &dfs, &target, ctl) };
        if replace_old {
            res = match res {
                // The new copy is complete: now delete the old one and put the new one in its place.
                Ok(()) => dfs.remove_tree(&first, None)
                    .map_err(|e| io::Error::other(format!("the new copy is there as “.{}.fathom-new”, but the old one couldn't be deleted: {e}", p.name)))
                    .and_then(|_| dfs.rename(&target, &first))
                    .map(|_| rep.replaced += 1),
                Err(e) => { let _ = dfs.remove_tree(&target, None); Err(e) }
            };
        }
        let landed = if replace_old { first.clone() } else { target.clone() };
        match res {
            Ok(()) => {
                rep.done += 1;
                if p.fast { ctl.tick(false); }
                rep.pairs.push([p.sfs.loc(&p.src), dfs.loc(&landed)]);
            }
            Err(e) if is_cancel(&e) => break,
            Err(e) => rep.errors.push(format!("{}: {e}", p.name)),
        }
    }
    ctl.tick(true);
    rep
}

/// plan_transfer when a server is involved: which top-level names clash.
pub fn plan(sources: &[String], dest_dir: &str) -> Result<Vec<Conflict>, String> {
    let mut sides = Sides::new();
    let (dfs, dest) = sides.resolve(dest_dir)?;
    let mut out = Vec::new();
    for loc in sources {
        let (sfs, src) = sides.resolve(loc)?;
        let name = name_of(&src).to_string();
        let dst = join(&dest, &name);
        if sfs.same(&dfs) && dst == src { continue; }
        let (Ok(Some(sm)), Ok(Some(dm))) = (sfs.lstat(&src), dfs.lstat(&dst)) else { continue };
        out.push(Conflict {
            name, src: loc.clone(), dst: dfs.loc(&dst),
            src_is_dir: sm.is_dir, dst_is_dir: dm.is_dir,
            src_size: if sm.is_dir { 0 } else { sm.size }, dst_size: if dm.is_dir { 0 } else { dm.size },
            src_modified: sm.mtime, dst_modified: dm.mtime,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::sftp::tests::local_server;

    /// The "server" is the local sftp-server, so both sides share one disk:
    /// that's fine — what's tested is everything on one side going through SFTP.
    fn remote() -> Option<Fs> {
        let (s, c) = local_server()?;
        Some(Fs::Remote { conn: "test".into(), s: Arc::new(Channel::from_parts(s, c)) })
    }

    fn tmp(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("fathom-xfer-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap().to_string_lossy().into_owned()
    }

    fn tree(root: &str) {
        std::fs::create_dir_all(format!("{root}/src/sub/empty")).unwrap();
        std::fs::write(format!("{root}/src/a.txt"), b"hello").unwrap();
        std::fs::write(format!("{root}/src/zero"), b"").unwrap();
        let big: Vec<u8> = (0..(3 << 20) + 777).map(|i| (i % 253) as u8).collect();
        std::fs::write(format!("{root}/src/sub/big.bin"), &big).unwrap();
        std::os::unix::fs::symlink("a.txt", format!("{root}/src/link")).unwrap();
    }

    fn same_tree(a: &str, b: &str) {
        for rel in ["a.txt", "zero", "sub/big.bin"] {
            assert_eq!(std::fs::read(format!("{a}/{rel}")).unwrap(), std::fs::read(format!("{b}/{rel}")).unwrap(), "{rel}");
        }
        assert!(std::path::Path::new(&format!("{b}/sub/empty")).is_dir());
        assert_eq!(std::fs::read_link(format!("{b}/link")).unwrap().to_string_lossy(), "a.txt");
    }

    fn exists(p: String) -> bool { std::fs::symlink_metadata(p).is_ok() }

    #[test]
    fn upload_and_download_trees() {
        let Some(r) = remote() else { return };
        let d = tmp("updown");
        tree(&d);
        let mut ctl = Ctl::detached();
        // Mac → "server"
        copy_safely(&Fs::Local, &format!("{d}/src"), &r, &format!("{d}/up"), &mut ctl).unwrap();
        same_tree(&format!("{d}/src"), &format!("{d}/up"));
        assert!(!exists(format!("{d}/.up.fathom-part")));
        assert!(ctl.done_bytes >= (3 << 20));
        // "server" → Mac
        copy_safely(&r, &format!("{d}/up"), &Fs::Local, &format!("{d}/down"), &mut Ctl::detached()).unwrap();
        same_tree(&format!("{d}/src"), &format!("{d}/down"));
        // Modified dates come across.
        let m = |p: String| std::fs::metadata(p).unwrap().modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        assert_eq!(m(format!("{d}/src/a.txt")), m(format!("{d}/down/a.txt")));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn cancelled_upload_leaves_nothing() {
        let Some(r) = remote() else { return };
        let d = tmp("cancel");
        tree(&d);
        let ctl = &mut Ctl::detached();
        ctl.cancel_now();
        let e = copy_safely(&Fs::Local, &format!("{d}/src"), &r, &format!("{d}/up"), ctl).unwrap_err();
        assert!(is_cancel(&e));
        assert!(!exists(format!("{d}/up")) && !exists(format!("{d}/.up.fathom-part")));
        std::fs::remove_dir_all(&d).unwrap();
    }

    /// `run` with the destination folder <d>/srv on the "server".
    fn run_to_server(r: &Fs, items: Vec<(String, Policy)>, d: &str, do_move: bool) -> OpReport {
        let mut sides = Sides::new();
        sides.chans.insert("test".into(), r.clone());
        run_sides(&mut sides, items, &format!("sftp://test{d}/srv"), do_move, &mut Ctl::detached())
    }

    #[test]
    fn policies_and_moves() {
        let Some(r) = remote() else { return };
        let d = tmp("pol");
        std::fs::create_dir_all(format!("{d}/mac/folder")).unwrap();
        std::fs::write(format!("{d}/mac/f.txt"), b"new").unwrap();
        std::fs::write(format!("{d}/mac/folder/in.txt"), b"in").unwrap();
        std::fs::create_dir_all(format!("{d}/srv/folder")).unwrap();
        std::fs::write(format!("{d}/srv/f.txt"), b"old").unwrap();
        std::fs::write(format!("{d}/srv/folder/keep.txt"), b"keep").unwrap();
        let items = |p: Policy| vec![(format!("{d}/mac/f.txt"), p)];

        // Keep both.
        let rep = run_to_server(&r, items(Policy::KeepBoth), &d, false);
        assert_eq!((rep.done, rep.renamed), (1, 1), "{:?}", rep.errors);
        assert_eq!(std::fs::read(format!("{d}/srv/f copy.txt")).unwrap(), b"new");
        assert_eq!(rep.pairs[0][1], format!("sftp://test{d}/srv/f copy.txt"));
        // Skip.
        assert_eq!(run_to_server(&r, items(Policy::Skip), &d, false).skipped, 1);
        // Replace: new content under the old name, nothing left over.
        let rep = run_to_server(&r, items(Policy::Replace), &d, false);
        assert_eq!((rep.done, rep.replaced), (1, 1), "{:?}", rep.errors);
        assert_eq!(std::fs::read(format!("{d}/srv/f.txt")).unwrap(), b"new");
        assert!(!exists(format!("{d}/srv/.f.txt.fathom-new")) && !exists(format!("{d}/srv/.f.txt.fathom-part")));
        // Merge folders while moving: both files inside, the source gone.
        let rep = run_to_server(&r, vec![(format!("{d}/mac/folder"), Policy::Merge)], &d, true);
        assert_eq!(rep.merged, 1, "{:?}", rep.errors);
        assert!(exists(format!("{d}/srv/folder/in.txt")) && exists(format!("{d}/srv/folder/keep.txt")));
        assert!(!exists(format!("{d}/mac/folder")));
        // Move within the "server": a rename.
        let rep = run_sides(&mut { let mut s = Sides::new(); s.chans.insert("test".into(), r.clone()); s },
            vec![(format!("sftp://test{d}/srv/f copy.txt"), Policy::KeepBoth)], &format!("sftp://test{d}/mac"), true, &mut Ctl::detached());
        assert_eq!(rep.done, 1, "{:?}", rep.errors);
        assert!(exists(format!("{d}/mac/f copy.txt")) && !exists(format!("{d}/srv/f copy.txt")));
        // Clashes are reported for the dialog.
        let mut sides = Sides::new();
        sides.chans.insert("test".into(), r.clone());
        std::fs::write(format!("{d}/mac/f.txt"), b"again").unwrap();
        let (dfs, dest) = sides.resolve(&format!("sftp://test{d}/srv")).unwrap();
        assert!(dfs.exists(&join(&dest, "f.txt")));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
