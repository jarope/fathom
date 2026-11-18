//! Finder tags — the same tags Finder shows, so they round-trip both ways.
//!
//! Read: the `com.apple.metadata:_kMDItemUserTags` xattr (a binary plist of
//! "Name\nColour" strings) — one cheap syscall per file, ENOATTR when untagged.
//! Write: NSURL's tagNames resource value, the supported API, so Spotlight
//! and Finder pick the change up immediately.
//! Colours: 0 none, 1 grey, 2 green, 3 purple, 4 blue, 5 yellow, 6 red, 7 orange.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Tag {
    pub name: String,
    pub color: u8,
}

const XATTR: &str = "com.apple.metadata:_kMDItemUserTags";

/// Colour for a tag name with no colour stored (Finder's standard tags).
fn standard_color(name: &str) -> u8 {
    match name.to_lowercase().as_str() {
        "grey" | "gray" => 1,
        "green" => 2,
        "purple" => 3,
        "blue" => 4,
        "yellow" => 5,
        "red" => 6,
        "orange" => 7,
        _ => 0,
    }
}

fn parse(raw: &str) -> Tag {
    match raw.rsplit_once('\n') {
        Some((n, c)) if c.len() <= 2 && c.chars().all(|ch| ch.is_ascii_digit()) => {
            let color = c.parse().unwrap_or(0);
            Tag { name: n.to_string(), color: if color == 0 { standard_color(n) } else { color } }
        }
        _ => Tag { name: raw.to_string(), color: standard_color(raw) },
    }
}

/// Tags on `path` (the link itself for symlinks). Empty when untagged.
pub fn read_tags(path: &Path, is_symlink: bool) -> Vec<Tag> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let Ok(cpath) = CString::new(path.as_os_str().as_bytes()) else { return vec![] };
        let name = CString::new(XATTR).unwrap();
        let opts = if is_symlink { libc::XATTR_NOFOLLOW } else { 0 };
        let mut buf = vec![0u8; 512];
        loop {
            let n = unsafe { libc::getxattr(cpath.as_ptr(), name.as_ptr(), buf.as_mut_ptr().cast(), buf.len(), 0, opts) };
            if n < 0 {
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::ERANGE) && buf.len() < 1 << 20 {
                    buf.resize(buf.len() * 4, 0);
                    continue;
                }
                return vec![];
            }
            buf.truncate(n as usize);
            break;
        }
        match plist::Value::from_reader(std::io::Cursor::new(buf)) {
            Ok(plist::Value::Array(items)) => items.iter().filter_map(|v| v.as_string()).map(parse).collect(),
            _ => vec![],
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (path, is_symlink);
        vec![]
    }
}

#[cfg(target_os = "macos")]
fn write_names(path: &str, names: &[String]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2_foundation::{NSArray, NSString, NSURLTagNamesKey, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let list: Vec<Retained<NSString>> = names.iter().map(|n| NSString::from_str(n)).collect();
    let arr = NSArray::from_retained_slice(&list);
    unsafe { url.setResourceValue_forKey_error(Some(&arr), NSURLTagNamesKey) }.map_err(|e| e.localizedDescription().to_string())
}

/// Add and/or remove tags (by name) on every path; `clear` removes all first.
#[tauri::command]
pub fn set_tags(paths: Vec<String>, add: Vec<String>, remove: Vec<String>, clear: bool) -> Result<usize, String> {
    #[cfg(target_os = "macos")]
    {
        let mut errors = Vec::new();
        let mut changed = 0;
        for p in &paths {
            let link = Path::new(p).symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false);
            let mut names: Vec<String> = if clear { vec![] } else { read_tags(Path::new(p), link).into_iter().map(|t| t.name).collect() };
            names.retain(|n| !remove.iter().any(|r| r.eq_ignore_ascii_case(n)));
            for a in &add {
                if !names.iter().any(|n| n.eq_ignore_ascii_case(a)) {
                    names.push(a.clone());
                }
            }
            match write_names(p, &names) {
                Ok(()) => changed += 1,
                Err(e) => errors.push(format!("{p}: {e}")),
            }
        }
        if errors.is_empty() || changed > 0 { Ok(changed) } else { Err(errors.join("; ")) }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (paths, add, remove, clear);
        Err("Tags need macOS".into())
    }
}

/// The tags Finder shows in its sidebar (your favourites), in Finder's order.
#[tauri::command]
pub fn tag_list() -> Vec<Tag> {
    let defaults = || ["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Grey"].iter().map(|n| parse(n)).collect();
    let Ok(home) = std::env::var("HOME") else { return defaults() };
    let prefs = Path::new(&home).join("Library/Preferences/com.apple.finder.plist");
    let Ok(v) = plist::Value::from_file(prefs) else { return defaults() };
    let names: Vec<Tag> = v
        .as_dictionary()
        .and_then(|d| d.get("FavoriteTagNames"))
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_string()).filter(|s| !s.is_empty()).map(parse).collect())
        .unwrap_or_default();
    if names.is_empty() { defaults() } else { names }
}

/// Every file with tag `name`, via Spotlight.
#[tauri::command]
pub async fn tag_search(name: String) -> Result<Vec<String>, String> {
    let q = format!("kMDItemUserTags == \"{}\"", name.replace('\\', "\\\\").replace('"', "\\\""));
    let out = tauri::async_runtime::spawn_blocking(move || std::process::Command::new("mdfind").arg("-0").arg(q).output())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Spotlight isn't available: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.split('\0').filter(|s| !s.is_empty()).take(5000).map(String::from).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_tag_strings() {
        assert_eq!(parse("Red\n6"), Tag { name: "Red".into(), color: 6 });
        assert_eq!(parse("Work\n4"), Tag { name: "Work".into(), color: 4 });
        assert_eq!(parse("Grey"), Tag { name: "Grey".into(), color: 1 });
        assert_eq!(parse("Project X"), Tag { name: "Project X".into(), color: 0 });
        assert_eq!(parse("Line\nbreak name"), Tag { name: "Line\nbreak name".into(), color: 0 });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn tags_roundtrip_on_a_real_file() {
        let dir = std::env::temp_dir().join(format!("fathom-tags-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("t.txt");
        std::fs::write(&f, "x").unwrap();
        let p = f.to_string_lossy().into_owned();
        assert!(read_tags(&f, false).is_empty());
        set_tags(vec![p.clone()], vec!["Red".into(), "Work".into()], vec![], false).unwrap();
        let t = read_tags(&f, false);
        println!("{t:?}");
        assert_eq!(t.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["Red", "Work"]);
        assert_eq!(t[0].color, 6);
        set_tags(vec![p.clone()], vec!["Blue".into()], vec!["red".into()], false).unwrap();
        assert_eq!(read_tags(&f, false).iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["Work", "Blue"]);
        set_tags(vec![p.clone()], vec![], vec![], true).unwrap();
        assert!(read_tags(&f, false).is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
