//! Host names from ~/.ssh/config (and the files it Includes), for "Add from
//! ssh config…". Only concrete names: wildcard / negated patterns are
//! templates, not servers. ssh itself resolves everything else at connect.

use std::path::{Path, PathBuf};

pub fn hosts() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return Vec::new() };
    let mut out = Vec::new();
    read(&home.join(".ssh/config"), &home, &mut out, 0);
    let mut seen = std::collections::HashSet::new();
    out.retain(|h| seen.insert(h.clone()));
    out
}

fn read(file: &Path, home: &Path, out: &mut Vec<String>, depth: u32) {
    if depth > 8 { return; }
    let Ok(text) = std::fs::read_to_string(file) else { return };
    parse(&text, home, out, depth);
}

fn parse(text: &str, home: &Path, out: &mut Vec<String>, depth: u32) {
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        let (key, rest) = match line.split_once(|c: char| c.is_whitespace() || c == '=') { Some((k, r)) => (k, r.trim_start_matches(|c: char| c.is_whitespace() || c == '=')), None => continue };
        match key.to_ascii_lowercase().as_str() {
            "host" => out.extend(rest.split_whitespace().map(|h| h.trim_matches('"')).filter(|h| !h.is_empty() && !h.contains(['*', '?', '!'])).map(String::from)),
            "include" => for pat in rest.split_whitespace() { for f in expand(pat, home) { read(&f, home, out, depth + 1); } },
            _ => {}
        }
    }
}

/// An Include pattern → files (relative ones are under ~/.ssh; `*` matches within a name).
fn expand(pat: &str, home: &Path) -> Vec<PathBuf> {
    let p = if let Some(r) = pat.strip_prefix("~/") { home.join(r) } else if pat.starts_with('/') { PathBuf::from(pat) } else { home.join(".ssh").join(pat) };
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.contains('*') { return vec![p]; }
    let (pre, post) = name.split_once('*').unwrap();
    let Some(dir) = p.parent() else { return Vec::new() };
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir).into_iter().flatten().flatten()
        .filter(|e| { let n = e.file_name().to_string_lossy().into_owned(); n.len() >= pre.len() + post.len() && n.starts_with(pre) && n.ends_with(post) })
        .map(|e| e.path()).collect();
    v.sort();
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hosts_and_includes() {
        let home = std::env::temp_dir().join(format!("fathom-sshcfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".ssh/conf.d")).unwrap();
        std::fs::write(home.join(".ssh/conf.d/a.conf"), "Host nas\n  HostName 10.0.0.2\n").unwrap();
        let mut out = Vec::new();
        parse("# hi\nHost web db *.lan !bad\n  User me\nHost=\"pi\"\nInclude conf.d/*.conf\nMatch host x\nHost *\n", &home, &mut out, 0);
        assert_eq!(out, ["web", "db", "pi", "nas"]);
        std::fs::remove_dir_all(&home).unwrap();
    }
}
