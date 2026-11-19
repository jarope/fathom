//! Git: per-row status for the folder on screen (rolled up for sub-folders),
//! branch / ahead / behind for the status bar, and a deliberately simple
//! Commit and Push. Everything shells out to the `git` command line, so it
//! behaves exactly like the user's own git (config, hooks, credentials).

use serde::Serialize;
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn git(dir: &str) -> Command {
    let mut c = Command::new("git");
    // Never wait on a password prompt nobody can see; paths are literal names.
    c.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(dir)
        .stdin(Stdio::null());
    c
}

fn run(mut c: Command) -> Result<String, String> {
    let out = c.output().map_err(|e| format!("Couldn't run git: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let mut msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let so = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !so.is_empty() {
            if !msg.is_empty() {
                msg.push('\n');
            }
            msg.push_str(&so);
        }
        Err(if msg.is_empty() { "git failed".into() } else { msg })
    }
}

/// How bad a change is, for rolling a folder's contents up into one badge.
fn rank(s: &str) -> u8 {
    match s {
        "conflict" => 5,
        "modified" => 4,
        "staged" => 3,
        "new" => 2,
        _ => 0,
    }
}

/// XY (index, work tree) → state: unstaged edits win over staged ones.
fn classify(xy: &str) -> &'static str {
    if xy.as_bytes().get(1).copied().unwrap_or(b'.') == b'.' {
        "staged"
    } else {
        "modified"
    }
}

#[derive(Default, Debug)]
struct Status {
    branch: Option<String>,
    oid: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    /// (path, original path if renamed, state, XY)
    items: Vec<(String, Option<String>, &'static str, String)>,
    ignored: Vec<String>,
}

fn parse_status(raw: &str) -> Status {
    let mut st = Status::default();
    let mut recs = raw.split('\0').filter(|r| !r.is_empty());
    while let Some(r) = recs.next() {
        if let Some(h) = r.strip_prefix("# ") {
            let (k, v) = h.split_once(' ').unwrap_or((h, ""));
            match k {
                "branch.oid" if v != "(initial)" => st.oid = Some(v.chars().take(7).collect()),
                "branch.head" if v != "(detached)" => st.branch = Some(v.to_string()),
                "branch.upstream" => st.upstream = Some(v.to_string()),
                "branch.ab" => {
                    for p in v.split(' ') {
                        if let Some(n) = p.strip_prefix('+') {
                            st.ahead = n.parse().unwrap_or(0);
                        } else if let Some(n) = p.strip_prefix('-') {
                            st.behind = n.parse().unwrap_or(0);
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = r.as_bytes()[0];
        match kind {
            b'1' => {
                let f: Vec<&str> = r.splitn(9, ' ').collect();
                if f.len() == 9 {
                    st.items.push((f[8].into(), None, classify(f[1]), f[1].into()));
                }
            }
            b'2' => {
                let f: Vec<&str> = r.splitn(10, ' ').collect();
                let orig = recs.next().map(String::from);
                if f.len() == 10 {
                    st.items.push((f[9].into(), orig, classify(f[1]), f[1].into()));
                }
            }
            b'u' => {
                let f: Vec<&str> = r.splitn(11, ' ').collect();
                if f.len() == 11 {
                    st.items.push((f[10].into(), None, "conflict", f[1].into()));
                }
            }
            b'?' => st.items.push((r[2..].into(), None, "new", "??".into())),
            b'!' => st.ignored.push(r[2..].into()),
            _ => {}
        }
    }
    st
}

/// For the folder `prefix` (repo-relative, "" or ending in "/"), the state of
/// each direct child: its own state, or the worst state inside it.
fn roll_up(st: &Status, prefix: &str) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    for (path, _, state, _) in &st.items {
        let Some(rest) = path.strip_prefix(prefix) else { continue };
        let child = rest.split('/').next().unwrap_or("");
        if child.is_empty() {
            continue;
        }
        let cur = out.get(child).map(|s| rank(s)).unwrap_or(0);
        if rank(state) > cur {
            out.insert(child.to_string(), state.to_string());
        }
    }
    for path in &st.ignored {
        let Some(rest) = path.strip_prefix(prefix) else { continue };
        let rest = rest.trim_end_matches('/');
        if !rest.is_empty() && !rest.contains('/') {
            out.entry(rest.to_string()).or_insert_with(|| "ignored".into());
        }
    }
    out
}

/// When the folder itself is untracked or ignored, git only reports the
/// folder ("sub/"), so everything shown inside it shares that state.
fn whole(st: &Status, prefix: &str) -> Option<String> {
    if prefix.is_empty() {
        return None;
    }
    let inside = |p: &String| p.ends_with('/') && prefix.starts_with(p.as_str());
    if st.ignored.iter().any(inside) {
        return Some("ignored".into());
    }
    st.items.iter().any(|(p, _, s, _)| *s == "new" && inside(p)).then(|| "new".into())
}

#[derive(Serialize, Debug)]
pub struct GitInfo {
    root: String,
    /// The folder's path inside the repo ("" at the top, else ending in "/").
    prefix: String,
    branch: Option<String>,
    /// Short commit id when detached (no branch).
    oid: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    /// Direct child name → "modified" | "staged" | "new" | "conflict" | "ignored".
    files: HashMap<String, String>,
    /// Set when the whole folder is untracked / ignored: applies to every row.
    all: Option<String>,
    /// Changed files anywhere in the repo.
    changes: usize,
    /// Every change as [repo-relative path, state] (a trailing "/" = a whole
    /// untracked folder), and ignored paths — so rows inside expanded
    /// sub-folders can find their own state.
    paths: Vec<[String; 2]>,
    ignored: Vec<String>,
}

/// Where `dir` sits in a work tree: (root, prefix) — None if not in one.
fn locate(dir: &str) -> Option<(String, String)> {
    let mut c = git(dir);
    c.args(["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--show-prefix"]);
    let out = run(c).ok()?;
    let mut l = out.lines();
    if l.next()? != "true" {
        return None;
    }
    Some((l.next()?.to_string(), l.next().unwrap_or("").to_string()))
}

/// `all_untracked` lists files inside new folders one by one (for the Commit
/// dialog) — unless the repo turned untracked scanning off (status.showUntrackedFiles
/// = no, typical for a home-folder dotfiles repo), which is always respected.
fn status_of(root: &str, ignored: bool, all_untracked: bool) -> Result<Status, String> {
    let mut c = git(root);
    c.args(["status", "--porcelain=v2", "--branch", "-z"]);
    if ignored {
        c.arg("--ignored");
    }
    if all_untracked {
        let mut cfg = git(root);
        cfg.args(["config", "--get", "status.showUntrackedFiles"]);
        if run(cfg).map(|v| v.trim() != "no").unwrap_or(true) {
            c.arg("-uall");
        }
    }
    Ok(parse_status(&run(c)?))
}

fn info_for(dir: &str) -> Result<Option<GitInfo>, String> {
    let Some((root, prefix)) = locate(dir) else { return Ok(None) };
    let st = status_of(&root, true, false)?;
    Ok(Some(GitInfo {
        files: roll_up(&st, &prefix),
        all: whole(&st, &prefix),
        paths: st.items.iter().map(|(p, _, s, _)| [p.clone(), s.to_string()]).collect(),
        ignored: st.ignored.clone(),
        prefix,
        changes: st.items.len(),
        root,
        branch: st.branch,
        oid: st.oid,
        upstream: st.upstream,
        ahead: st.ahead,
        behind: st.behind,
    }))
}

/// Git status for the folder on screen (None when it isn't in a repository).
#[tauri::command]
pub async fn git_status(dir: String) -> Result<Option<GitInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || info_for(&dir)).await.map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug)]
pub struct Change {
    path: String,
    orig: Option<String>,
    state: String,
    xy: String,
}

/// Every changed file in the repository, for the Commit dialog.
#[tauri::command]
pub async fn git_changes(root: String) -> Result<Vec<Change>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = status_of(&root, false, true)?;
        Ok(st.items.into_iter().map(|(path, orig, state, xy)| Change { path, orig, state: state.into(), xy }).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn commit(root: &str, paths: &[String], message: &str) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("Write a commit message first".into());
    }
    if paths.is_empty() {
        return Err("Pick at least one file to commit".into());
    }
    // Stage exactly the picked files (new, changed or deleted), then commit
    // only those — anything else already staged stays staged, untouched.
    let mut add = git(root);
    add.args(["add", "-A", "--"]).args(paths);
    run(add)?;
    let mut c = git(root);
    c.args(["commit", "-q", "-m", message, "--"]).args(paths);
    run(c)?;
    let mut h = git(root);
    h.args(["log", "-1", "--format=%h %s"]);
    Ok(run(h)?.trim().to_string())
}

/// Commit the given repo-relative paths. Returns "abc1234 subject".
#[tauri::command]
pub async fn git_commit(root: String, paths: Vec<String>, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || commit(&root, &paths, &message)).await.map_err(|e| e.to_string())?
}

fn push(root: &str) -> Result<String, String> {
    let st = status_of(root, false, false)?;
    let mut c = git(root);
    c.arg("push");
    if st.upstream.is_none() {
        // First push of this branch: set its upstream on the usual remote.
        let branch = st.branch.ok_or("Not on a branch (detached HEAD) — nothing to push")?;
        let mut r = git(root);
        r.arg("remote");
        let remotes = run(r)?;
        let remote = remotes
            .lines()
            .find(|l| *l == "origin")
            .or_else(|| remotes.lines().next())
            .ok_or("This repository has no remote to push to")?
            .to_string();
        c.args(["-u", &remote, &branch]);
    }
    c.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| format!("Couldn't run git: {e}"))?;
    // A push that hangs (network, a prompt we can't show) gets cut off.
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() > Duration::from_secs(180) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Push timed out after 3 minutes".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout)).trim().to_string();
    if out.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() { "Push failed".into() } else { text })
    }
}

/// Push the current branch to its remote (setting the upstream if needed).
#[tauri::command]
pub async fn git_push(root: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || push(&root)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &std::path::Path, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
    }

    #[test]
    fn parses_porcelain_v2() {
        let raw = "# branch.oid 1234567890abcdef\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/a b.rs\0\
1 A. N... 000000 100644 100644 000 ccc src/new.rs\0\
2 R. N... 100644 100644 100644 ddd eee R100 docs/to.md\0docs/from.md\0\
u UU N... 100644 100644 100644 100644 f g h c.txt\0\
? notes/todo.txt\0! target/\0";
        let st = parse_status(raw);
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert_eq!(st.oid.as_deref(), Some("1234567"));
        assert_eq!((st.ahead, st.behind), (2, 1));
        assert_eq!(st.items.len(), 5);
        assert_eq!(st.items[0].0, "src/a b.rs");
        assert_eq!(st.items[0].2, "modified");
        assert_eq!(st.items[1].2, "staged");
        assert_eq!(st.items[2].1.as_deref(), Some("docs/from.md"));
        assert_eq!(st.items[3].2, "conflict");
        assert_eq!(st.items[4].2, "new");
        let top = roll_up(&st, "");
        assert_eq!(top["src"], "modified"); // modified beats staged
        assert_eq!(top["notes"], "new");
        assert_eq!(top["target"], "ignored");
        assert_eq!(top["c.txt"], "conflict");
        let src = roll_up(&st, "src/");
        assert_eq!(src["a b.rs"], "modified");
        assert_eq!(src["new.rs"], "staged");
    }

    #[test]
    fn status_and_commit_in_a_real_repo() {
        let d = std::env::temp_dir().join(format!("fathom-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("sub")).unwrap();
        sh(&d, &["init", "-q", "-b", "main"]);
        sh(&d, &["config", "user.name", "Test"]);
        sh(&d, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(d.join("a.txt"), "a").unwrap();
        std::fs::write(d.join("sub/b*.txt"), "b").unwrap();
        std::fs::write(d.join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir_all(d.join("build")).unwrap();
        std::fs::write(d.join("build/x"), "x").unwrap();
        let root = d.canonicalize().unwrap().to_string_lossy().into_owned();

        let info = info_for(&root).unwrap().unwrap();
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.files["a.txt"], "new");
        assert_eq!(info.files["sub"], "new");
        assert_eq!(info.files["build"], "ignored");
        let sub = info_for(&format!("{root}/sub")).unwrap().unwrap();
        assert_eq!(sub.all.as_deref(), Some("new"));
        let build = info_for(&format!("{root}/build")).unwrap().unwrap();
        assert_eq!(build.all.as_deref(), Some("ignored"));

        // First commit: only a.txt and .gitignore (the literal "*" must not glob).
        let r = commit(&info.root, &["a.txt".into(), ".gitignore".into()], "first").unwrap();
        assert!(r.ends_with(" first"), "{r}");
        let after = info_for(&root).unwrap().unwrap();
        assert!(!after.files.contains_key("a.txt"));
        assert_eq!(after.files["sub"], "new");
        std::fs::write(d.join("sub/c.txt"), "c").unwrap();
        sh(&d, &["add", "sub/c.txt"]);
        let sub = info_for(&format!("{root}/sub")).unwrap().unwrap();
        assert!(sub.all.is_none());
        assert_eq!(sub.files["b*.txt"], "new");
        assert_eq!(sub.files["c.txt"], "staged");

        std::fs::write(d.join("a.txt"), "changed").unwrap();
        assert_eq!(info_for(&root).unwrap().unwrap().files["a.txt"], "modified");
        let changes = tauri::async_runtime::block_on(git_changes(info.root.clone())).unwrap();
        assert!(changes.iter().any(|c| c.path == "sub/b*.txt" && c.state == "new"));
        commit(&info.root, &["a.txt".into(), "sub/b*.txt".into()], "second").unwrap();
        // c.txt was staged but not picked: still staged, not committed.
        assert_eq!(info_for(&format!("{root}/sub")).unwrap().unwrap().files["c.txt"], "staged");
        commit(&info.root, &["sub/c.txt".into()], "third").unwrap();
        assert_eq!(info_for(&root).unwrap().unwrap().changes, 0);

        assert!(push(&info.root).unwrap_err().contains("no remote"));
        assert!(info_for("/").unwrap().is_none());
        let _ = std::fs::remove_dir_all(&d);
    }
}
