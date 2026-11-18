//! Search query helpers, shared by the name search (folder walk) and
//! Spotlight. A query is free words plus optional filters:
//!
//!   kind:pdf  kind:image  kind:movie  kind:audio  kind:text  kind:code
//!   kind:doc  kind:archive  kind:folder  kind:app  kind:<extension>
//!   modified:<7d  (within the last 7 days)   modified:>1y  (older than a year)
//!   modified:today   modified:>2024-01-31   modified:<2024-01-31
//!   size:>100MB   size:<10k
//!   tag:Red   (quote names with spaces: tag:"Project X")
//!
//! Units: h d w mo y for times; b k kb m mb g gb (×1000) for sizes.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Cmp {
    Lt,
    Gt,
}

#[derive(Debug, Clone, PartialEq)]
pub enum When {
    /// Within / older than this many seconds ago.
    Ago(Cmp, i64),
    /// Before / after this date (unix seconds, midnight UTC).
    Date(Cmp, i64),
    Today,
}

#[derive(Debug, Default, Clone, PartialEq)]
pub struct Query {
    pub words: Vec<String>,
    pub kinds: Vec<String>,
    pub modified: Option<When>,
    pub size: Option<(Cmp, u64)>,
    pub tags: Vec<String>,
}

impl Query {
    pub fn has_filters(&self) -> bool {
        !self.kinds.is_empty() || self.modified.is_some() || self.size.is_some() || !self.tags.is_empty()
    }
    pub fn is_empty(&self) -> bool {
        self.words.is_empty() && !self.has_filters()
    }
}

/// Split on whitespace, keeping "quoted phrases" (and key:"quoted values") together.
fn tokens(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for ch in s.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn split_cmp(v: &str) -> (Cmp, &str) {
    if let Some(r) = v.strip_prefix('>') {
        (Cmp::Gt, r)
    } else if let Some(r) = v.strip_prefix('<') {
        (Cmp::Lt, r)
    } else {
        (Cmp::Lt, v) // "modified:7d" = within 7 days; "size:10mb" = up to 10 MB
    }
}

fn num_unit(s: &str) -> Option<(f64, String)> {
    let i = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let n: f64 = s[..i].parse().ok()?;
    Some((n, s[i..].to_lowercase()))
}

fn parse_size(v: &str) -> Option<(Cmp, u64)> {
    let (cmp, rest) = split_cmp(v);
    let (n, unit) = num_unit(rest)?;
    let mult = match unit.as_str() {
        "" | "b" => 1.0,
        "k" | "kb" => 1e3,
        "m" | "mb" => 1e6,
        "g" | "gb" => 1e9,
        "t" | "tb" => 1e12,
        _ => return None,
    };
    Some((cmp, (n * mult) as u64))
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_when(v: &str) -> Option<When> {
    if v.eq_ignore_ascii_case("today") {
        return Some(When::Today);
    }
    let (cmp, rest) = split_cmp(v);
    let parts: Vec<&str> = rest.split('-').collect();
    if parts.len() == 3 && parts[0].len() == 4 {
        let (y, m, d) = (parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?);
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return None;
        }
        // For dates, ">" means after and "<" before; bare = before.
        return Some(When::Date(cmp, days_from_civil(y, m, d) * 86400));
    }
    let (n, unit) = num_unit(rest)?;
    let secs = match unit.as_str() {
        "h" => 3600.0,
        "d" | "" => 86400.0,
        "w" => 7.0 * 86400.0,
        "mo" => 30.0 * 86400.0,
        "y" => 365.0 * 86400.0,
        _ => return None,
    };
    Some(When::Ago(cmp, (n * secs) as i64))
}

pub fn parse(q: &str) -> Query {
    let mut out = Query::default();
    for t in tokens(q) {
        let filter = t.split_once(':').and_then(|(k, v)| {
            if v.is_empty() {
                return None;
            }
            match k.to_lowercase().as_str() {
                "kind" | "type" => {
                    out.kinds.push(v.to_lowercase());
                    Some(())
                }
                "modified" | "date" => parse_when(v).map(|w| out.modified = Some(w)),
                "size" => parse_size(v).map(|s| out.size = Some(s)),
                "tag" => {
                    out.tags.push(v.to_string());
                    Some(())
                }
                _ => None,
            }
        });
        if filter.is_none() {
            out.words.push(t);
        }
    }
    out
}

// ---- Kinds ----

/// (UTI for Spotlight, extensions for the folder walk). `None` UTI = match by extension.
fn kind_info(kind: &str) -> (Option<&'static str>, &'static [&'static str]) {
    match kind {
        "pdf" => (Some("com.adobe.pdf"), &["pdf"]),
        "image" | "images" | "photo" | "picture" => (
            Some("public.image"),
            &["jpg", "jpeg", "png", "gif", "heic", "heif", "tif", "tiff", "webp", "bmp", "raw", "cr2", "cr3", "nef", "arw", "dng", "svg", "psd", "avif"],
        ),
        "movie" | "video" => (Some("public.movie"), &["mp4", "mov", "m4v", "avi", "mkv", "webm", "wmv", "mpg", "mpeg"]),
        "audio" | "music" | "sound" => (Some("public.audio"), &["mp3", "m4a", "aac", "wav", "flac", "aiff", "aif", "ogg", "opus", "alac"]),
        "text" => (Some("public.plain-text"), &["txt", "md", "log", "csv", "json", "yaml", "yml", "xml", "ini", "toml"]),
        "code" | "source" => (
            Some("public.source-code"),
            &["rs", "js", "mjs", "ts", "tsx", "jsx", "py", "go", "c", "h", "cpp", "hpp", "m", "swift", "java", "kt", "rb", "php", "sh", "zsh", "css", "html", "lua", "sql"],
        ),
        "doc" | "docs" | "document" => (None, &["doc", "docx", "pages", "rtf", "odt", "txt", "md", "pdf"]),
        "sheet" | "spreadsheet" => (None, &["xls", "xlsx", "numbers", "ods", "csv"]),
        "slides" | "presentation" => (None, &["ppt", "pptx", "key", "odp"]),
        "archive" | "zip" => (Some("public.archive"), &["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg"]),
        "folder" | "dir" => (Some("public.folder"), &[]),
        "app" | "application" => (Some("com.apple.application-bundle"), &["app"]),
        _ => (None, &[]),
    }
}

fn ext_of(path: &Path) -> String {
    path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn kind_matches(kind: &str, path: &Path, is_dir: bool) -> bool {
    let ext = ext_of(path);
    match kind {
        "folder" | "dir" => is_dir && ext != "app",
        "app" | "application" => ext == "app",
        _ if is_dir => false,
        _ => {
            let (_, exts) = kind_info(kind);
            if exts.is_empty() { ext == kind } else { exts.contains(&ext.as_str()) }
        }
    }
}

pub fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Does an item pass the filters (not the words)? Used by the folder walk.
pub fn passes(q: &Query, path: &Path, is_dir: bool, size: u64, modified: Option<u64>, tags: &[crate::tags::Tag]) -> bool {
    if !q.kinds.is_empty() && !q.kinds.iter().any(|k| kind_matches(k, path, is_dir)) {
        return false;
    }
    if let Some((cmp, n)) = q.size {
        if is_dir {
            return false;
        }
        let ok = match cmp {
            Cmp::Gt => size > n,
            Cmp::Lt => size < n,
        };
        if !ok {
            return false;
        }
    }
    if let Some(w) = &q.modified {
        let Some(m) = modified.map(|m| m as i64) else { return false };
        let now = now_secs();
        let ok = match w {
            When::Today => m >= now - now.rem_euclid(86400),
            When::Ago(Cmp::Lt, s) => m >= now - s,
            When::Ago(Cmp::Gt, s) => m < now - s,
            When::Date(Cmp::Gt, t) => m >= *t,
            When::Date(Cmp::Lt, t) => m < *t,
        };
        if !ok {
            return false;
        }
    }
    q.tags.iter().all(|t| tags.iter().any(|x| x.name.eq_ignore_ascii_case(t)))
}

// ---- Spotlight ----

fn quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Build an `mdfind` query. `contents`: words match text inside files (and
/// any metadata); otherwise words match file names only.
pub fn to_mdquery(q: &Query, contents: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    for w in &q.words {
        let w = quote(w);
        parts.push(if contents {
            format!("(** == \"{w}*\"cdw)")
        } else {
            format!("(kMDItemFSName == \"*{w}*\"cd)")
        });
    }
    if !q.kinds.is_empty() {
        let alts: Vec<String> = q
            .kinds
            .iter()
            .map(|k| {
                let (uti, exts) = kind_info(k);
                match uti {
                    Some(u) => format!("kMDItemContentTypeTree == \"{u}\""),
                    None => {
                        let list: &[&str] = if exts.is_empty() { &[] } else { exts };
                        if list.is_empty() {
                            format!("kMDItemFSName == \"*.{}\"c", quote(k))
                        } else {
                            list.iter().map(|e| format!("kMDItemFSName == \"*.{e}\"c")).collect::<Vec<_>>().join(" || ")
                        }
                    }
                }
            })
            .collect();
        parts.push(format!("({})", alts.join(" || ")));
    }
    if let Some((cmp, n)) = q.size {
        parts.push(format!("(kMDItemFSSize {} {n})", if cmp == Cmp::Gt { ">" } else { "<" }));
    }
    if let Some(w) = &q.modified {
        let a = "kMDItemFSContentChangeDate";
        parts.push(match w {
            When::Today => format!("({a} >= $time.today)"),
            When::Ago(Cmp::Lt, s) => format!("({a} >= $time.now(-{s}))"),
            When::Ago(Cmp::Gt, s) => format!("({a} < $time.now(-{s}))"),
            When::Date(cmp, t) => {
                let day = t / 86400;
                // back to y-m-d for $time.iso
                let (y, m, d) = civil_from_days(day);
                format!("({a} {} $time.iso({y:04}-{m:02}-{d:02}T00:00:00Z))", if *cmp == Cmp::Gt { ">=" } else { "<" })
            }
        });
    }
    for t in &q.tags {
        parts.push(format!("(kMDItemUserTags == \"{}\"c)", quote(t)));
    }
    parts.join(" && ")
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_words_and_filters() {
        let q = parse(r#"invoice 2024 kind:pdf size:>2MB modified:<30d tag:"Project X" note:x"#);
        assert_eq!(q.words, ["invoice", "2024", "note:x"]);
        assert_eq!(q.kinds, ["pdf"]);
        assert_eq!(q.size, Some((Cmp::Gt, 2_000_000)));
        assert_eq!(q.modified, Some(When::Ago(Cmp::Lt, 30 * 86400)));
        assert_eq!(q.tags, ["Project X"]);
        assert_eq!(parse("modified:>2024-02-29").modified, Some(When::Date(Cmp::Gt, days_from_civil(2024, 2, 29) * 86400)));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        assert_eq!(parse("size:big").words, ["size:big"]); // not a valid size → a plain word
    }

    #[test]
    fn builds_spotlight_queries() {
        let q = parse(r#"tax kind:image tag:Red"#);
        assert_eq!(to_mdquery(&q, true), r#"(** == "tax*"cdw) && (kMDItemContentTypeTree == "public.image") && (kMDItemUserTags == "Red"c)"#);
        assert_eq!(to_mdquery(&parse(r#""tax return" 2024"#), false), r#"(kMDItemFSName == "*tax return*"cd) && (kMDItemFSName == "*2024*"cd)"#);
        assert_eq!(quote(r#"a"b\c"#), r#"a\"b\\c"#);
        assert!(to_mdquery(&parse("kind:psd"), false).contains(r#"kMDItemFSName == "*.psd"c"#));
        assert!(to_mdquery(&parse("modified:<2024-01-31"), false).contains("$time.iso(2024-01-31T00:00:00Z)"));
    }

    #[test]
    fn filters_match_files() {
        let q = parse("kind:image size:>1k");
        assert!(passes(&q, Path::new("/x/a.JPG"), false, 5000, Some(0), &[]));
        assert!(!passes(&q, Path::new("/x/a.jpg"), false, 10, Some(0), &[]));
        assert!(!passes(&q, Path::new("/x/a.txt"), false, 5000, Some(0), &[]));
        assert!(passes(&parse("kind:folder"), Path::new("/x/Docs"), true, 0, None, &[]));
        assert!(!passes(&parse("kind:folder"), Path::new("/x/Mail.app"), true, 0, None, &[]));
        let recent = Some(now_secs() as u64 - 60);
        assert!(passes(&parse("modified:<1d"), Path::new("/a"), false, 0, recent, &[]));
        assert!(!passes(&parse("modified:>1d"), Path::new("/a"), false, 0, recent, &[]));
    }
}

