//! The Bin as a place: where each item came from (for Put Back), Empty Bin
//! and Delete Immediately.
//!
//! Where an item came from is known two ways:
//! - Fathom's own record (`~/.config/fathom/bin-origins.json`), written every
//!   time Fathom moves something to the Bin;
//! - Finder's record, kept in the Bin's `.DS_Store` as `ptbL` (folder, relative
//!   to the volume) + `ptbN` (original name) — so things binned in Finder can
//!   be put back too.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------- records

fn record_path() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config/fathom/bin-origins.json"))
}

fn read_record() -> HashMap<String, String> {
    record_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Remember (original, in-Bin) pairs; forget entries whose item has left the Bin.
pub fn remember(pairs: &[(String, String)]) {
    let Some(path) = record_path() else { return };
    let mut rec = read_record();
    rec.retain(|in_bin, _| Path::new(in_bin).symlink_metadata().is_ok());
    for (orig, in_bin) in pairs {
        rec.insert(in_bin.clone(), orig.clone());
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec_pretty(&rec) {
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(tmp, path);
        }
    }
}

// ---------------------------------------------------------------- .DS_Store

/// Finder's put-back records in a Bin folder's .DS_Store: item name → original path.
fn finder_origins(bin: &Path) -> HashMap<String, String> {
    let Ok(data) = std::fs::read(bin.join(".DS_Store")) else { return HashMap::new() };
    let mut loc: HashMap<String, String> = HashMap::new();
    let mut name: HashMap<String, String> = HashMap::new();
    for (file, code, val) in ds_store_strings(&data).unwrap_or_default() {
        match &code {
            b"ptbL" => { loc.insert(file, val); }
            b"ptbN" => { name.insert(file, val); }
            _ => {}
        }
    }
    let root = volume_root(bin);
    loc.into_iter()
        .map(|(file, dir)| {
            let n = name.get(&file).cloned().unwrap_or_else(|| file.clone());
            let full = root.join(dir.trim_start_matches('/')).join(&n);
            (file, full.to_string_lossy().into_owned())
        })
        .collect()
}

/// "/" for the home Bin; "/Volumes/X" for /Volumes/X/.Trashes/<uid>.
fn volume_root(bin: &Path) -> PathBuf {
    let s = bin.to_string_lossy();
    if let Some(rest) = s.strip_prefix("/Volumes/") {
        if let Some(name) = rest.split('/').next() {
            return PathBuf::from("/Volumes").join(name);
        }
    }
    PathBuf::from("/")
}

struct Rd<'a> { b: &'a [u8], at: usize }
impl<'a> Rd<'a> {
    fn new(b: &'a [u8], at: usize) -> Self { Rd { b, at } }
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.b.get(self.at..self.at.checked_add(n)?)?;
        self.at += n;
        Some(s)
    }
    fn u32(&mut self) -> Option<u32> { self.bytes(4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]])) }
    fn u8(&mut self) -> Option<u8> { self.bytes(1).map(|s| s[0]) }
    fn utf16(&mut self, chars: usize) -> Option<String> {
        let raw = self.bytes(chars.checked_mul(2)?)?;
        let units: Vec<u16> = raw.chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        Some(String::from_utf16_lossy(&units))
    }
}

/// Every string-valued ('ustr') record in a .DS_Store: (file name, code, value).
/// Format: a "buddy allocator" file holding a B-tree (see Mark Mentovai's and
/// Wim Lewis's write-ups). Offsets inside the file are relative to byte 4.
fn ds_store_strings(d: &[u8]) -> Option<Vec<(String, [u8; 4], String)>> {
    let mut r = Rd::new(d, 0);
    if r.u32()? != 1 || r.bytes(4)? != b"Bud1" { return None; }
    let (root_off, root_len) = (r.u32()? as usize, r.u32()? as usize);
    let mut r = Rd::new(d.get(..(4 + root_off).checked_add(root_len)?)?, 4 + root_off);
    let count = r.u32()? as usize;
    r.u32()?;
    let mut addrs = Vec::with_capacity(count);
    for _ in 0..count { addrs.push(r.u32()?); }
    r.bytes((count.div_ceil(256) * 256 - count) * 4)?; // padding to 256 entries
    let dirs = r.u32()?;
    let mut dsdb = None;
    for _ in 0..dirs {
        let n = r.u8()? as usize;
        let name = r.bytes(n)?;
        let block = r.u32()?;
        if name == b"DSDB" { dsdb = Some(block); }
    }
    let block = |id: u32| -> Option<Rd> {
        let a = *addrs.get(id as usize)?;
        let off = (a & !0x1f) as usize + 4;
        let len = 1usize << (a & 0x1f);
        Some(Rd::new(d.get(..off.checked_add(len)?.min(d.len()))?, off))
    };
    let mut h = block(dsdb?)?;
    let root = h.u32()?;
    let mut out = Vec::new();
    let mut stack = vec![root];
    let mut seen = 0;
    while let Some(id) = stack.pop() {
        seen += 1;
        if seen > 100_000 { break; } // corrupt / cyclic file
        let mut n = block(id)?;
        let right = n.u32()?;
        let cnt = n.u32()?;
        for _ in 0..cnt {
            if right != 0 { stack.push(n.u32()?); }
            if let Some(rec) = record(&mut n)? { out.push(rec); }
        }
        if right != 0 { stack.push(right); }
    }
    Some(out)
}

/// One record; Some(None) for records that aren't strings.
fn record(r: &mut Rd) -> Option<Option<(String, [u8; 4], String)>> {
    let n = r.u32()? as usize;
    let file = r.utf16(n)?;
    let code: [u8; 4] = r.bytes(4)?.try_into().ok()?;
    let ty = r.bytes(4)?;
    Some(match ty {
        b"ustr" => { let l = r.u32()? as usize; Some((file, code, r.utf16(l)?)) }
        b"long" | b"shor" | b"type" => { r.bytes(4)?; None }
        b"bool" => { r.bytes(1)?; None }
        b"comp" | b"dutc" => { r.bytes(8)?; None }
        b"blob" => { let l = r.u32()? as usize; r.bytes(l)?; None }
        _ => return None, // unknown type: can't step past it safely
    })
}

// ---------------------------------------------------------------- commands

fn home_bin() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".Trash"))
}

/// Is `p` inside a Bin folder (home Bin or a volume's .Trashes)?
pub fn in_bin(p: &Path) -> bool {
    let s = p.to_string_lossy();
    if let Some(b) = home_bin() {
        let b = b.to_string_lossy().into_owned();
        if s.starts_with(&(b.clone() + "/")) { return true; }
    }
    s.starts_with("/Volumes/") && s.contains("/.Trashes/")
}

/// Where each item in Bin folder `dir` came from (item path → original path).
#[tauri::command]
pub fn bin_origins(dir: String) -> HashMap<String, String> {
    let bin = Path::new(&dir);
    let mut out: HashMap<String, String> = finder_origins(bin)
        .into_iter()
        .map(|(name, orig)| (bin.join(name).to_string_lossy().into_owned(), orig))
        .collect();
    let prefix = format!("{}/", dir.trim_end_matches('/'));
    for (in_bin, orig) in read_record() {
        if in_bin.starts_with(&prefix) { out.insert(in_bin, orig); }
    }
    out.retain(|k, _| Path::new(k).symlink_metadata().is_ok());
    out
}

#[derive(Serialize, Default)]
pub struct Deleted { count: usize, errors: Vec<String> }

/// Delete items in the Bin for good. Refuses anything outside a Bin.
#[tauri::command]
pub async fn bin_delete(paths: Vec<String>) -> Result<Deleted, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Deleted::default();
        for p in paths {
            let path = Path::new(&p);
            if !in_bin(path) {
                out.errors.push(format!("{p}: not in the Bin, so not deleted"));
                continue;
            }
            let res = match path.symlink_metadata() {
                Ok(m) if m.is_dir() => std::fs::remove_dir_all(path),
                Ok(_) => std::fs::remove_file(path),
                Err(e) => Err(e),
            };
            match res { Ok(()) => out.count += 1, Err(e) => out.errors.push(format!("{p}: {e}")) }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

/// Empty the Bin the way Finder does (every volume's Bin too).
#[tauri::command]
pub async fn bin_empty() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        #[cfg(target_os = "macos")]
        {
            let o = std::process::Command::new("osascript")
                .args(["-e", "tell application \"Finder\" to empty trash"])
                .output()
                .map_err(|e| format!("Couldn't ask Finder: {e}"))?;
            if !o.status.success() {
                let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
                return Err(if msg.contains("-1743") || msg.contains("Not authorized") {
                    "Fathom isn't allowed to ask Finder. Turn it on in System Settings › Privacy & Security › Automation.".into()
                } else {
                    format!("Finder couldn't empty the Bin: {msg}")
                });
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny .DS_Store built by hand: one leaf node with ptbL + ptbN + an Iloc blob.
    fn sample() -> Vec<u8> {
        fn utf16(s: &str) -> Vec<u8> { s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect() }
        fn rec(file: &str, code: &[u8; 4], ty: &[u8; 4], val: &[u8]) -> Vec<u8> {
            let mut v = (file.encode_utf16().count() as u32).to_be_bytes().to_vec();
            v.extend(utf16(file)); v.extend(code); v.extend(ty); v.extend(val); v
        }
        fn ustr(s: &str) -> Vec<u8> { let mut v = (s.encode_utf16().count() as u32).to_be_bytes().to_vec(); v.extend(utf16(s)); v }
        let mut leaf = 0u32.to_be_bytes().to_vec();
        leaf.extend(3u32.to_be_bytes());
        leaf.extend(rec("Report 10.31.07.pdf", b"Iloc", b"blob", &[0, 0, 0, 2, 9, 9]));
        leaf.extend(rec("Report 10.31.07.pdf", b"ptbL", b"ustr", &ustr("Users/me/Documents/")));
        leaf.extend(rec("Report 10.31.07.pdf", b"ptbN", b"ustr", &ustr("Report.pdf")));
        let mut dsdb = 2u32.to_be_bytes().to_vec(); // root node = block 2
        dsdb.extend([0u8; 16]);
        // Layout (offsets relative to byte 4): root block @0x20 (len 0x800), dsdb @0x1000, leaf @0x1100.
        let addr = |off: u32, log2: u32| off | log2;
        let mut root = 3u32.to_be_bytes().to_vec();
        root.extend(0u32.to_be_bytes());
        root.extend(addr(0x20, 11).to_be_bytes()); // block 0: the root block itself
        root.extend(addr(0x1000, 5).to_be_bytes()); // block 1: DSDB header
        root.extend(addr(0x1100, 8).to_be_bytes()); // block 2: leaf
        root.extend(vec![0u8; (256 - 3) * 4]);
        root.extend(1u32.to_be_bytes());
        root.push(4); root.extend(b"DSDB"); root.extend(1u32.to_be_bytes());
        let mut f = vec![0u8; 4 + 0x1200];
        f[0..4].copy_from_slice(&1u32.to_be_bytes());
        f[4..8].copy_from_slice(b"Bud1");
        f[8..12].copy_from_slice(&0x20u32.to_be_bytes());
        f[12..16].copy_from_slice(&0x800u32.to_be_bytes());
        f[4 + 0x20..4 + 0x20 + root.len()].copy_from_slice(&root);
        f[4 + 0x1000..4 + 0x1000 + dsdb.len()].copy_from_slice(&dsdb);
        f[4 + 0x1100..4 + 0x1100 + leaf.len()].copy_from_slice(&leaf);
        f
    }

    #[test]
    fn reads_put_back_records() {
        let recs = ds_store_strings(&sample()).expect("parses");
        assert_eq!(recs.len(), 2);
        let dir = std::env::temp_dir().join(format!("fathom-bin-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(".DS_Store"), sample()).unwrap();
        let o = finder_origins(&dir);
        assert_eq!(o.get("Report 10.31.07.pdf").map(String::as_str), Some("/Users/me/Documents/Report.pdf"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_garbage() {
        assert!(ds_store_strings(b"nope").is_none());
        assert!(ds_store_strings(&[0, 0, 0, 1, b'B', b'u', b'd', b'1', 0xff, 0xff, 0xff, 0xff]).is_none());
    }

    /// Parse a real .DS_Store: FATHOM_DSSTORE=path cargo test real_ds_store -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_ds_store() {
        let p = std::env::var("FATHOM_DSSTORE").expect("set FATHOM_DSSTORE");
        let d = std::fs::read(&p).unwrap();
        let recs = ds_store_strings(&d).expect("parses");
        let n = |c: &[u8; 4]| recs.iter().filter(|r| &r.1 == c).count();
        println!("ustr records: {} · ptbL: {} · ptbN: {}", recs.len(), n(b"ptbL"), n(b"ptbN"));
        let dir = Path::new(&p).parent().unwrap();
        let o = finder_origins(dir);
        let present = o.keys().filter(|k| dir.join(k).symlink_metadata().is_ok()).count();
        println!("origins: {} · still in the folder: {}", o.len(), present);
        if let Some((k, v)) = o.iter().find(|(k, _)| dir.join(k).symlink_metadata().is_ok()) {
            println!("e.g. {} ← {}", k.chars().count(), v.split('/').count());
        }
    }

    #[test]
    fn bin_paths() {
        assert!(in_bin(Path::new("/Volumes/USB/.Trashes/501/x")));
        assert!(!in_bin(Path::new("/Volumes/USB/x")));
        assert!(!in_bin(Path::new("/Users/x/Documents/a")));
        assert_eq!(volume_root(Path::new("/Volumes/USB/.Trashes/501")), PathBuf::from("/Volumes/USB"));
    }
}
