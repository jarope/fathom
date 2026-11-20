//! Network places: which mounted volumes are network shares, and Connect to
//! Server (⌘K) — macOS mounts the share itself (`mount volume`), so its own
//! login prompt, Keychain and "Connect As" all work as in Finder.

use std::ffi::CString;

const NETWORK_FS: &[&str] = &["smbfs", "afpfs", "nfs", "webdav", "cifs", "ftp"];

/// Is the volume at `path` a network share (SMB, AFP, NFS, WebDAV…)?
pub fn is_network(path: &str) -> bool {
    let Ok(c) = CString::new(path) else { return false };
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 {
        return false;
    }
    let raw: Vec<u8> = st.f_fstypename.iter().take_while(|&&b| b != 0).map(|&b| b as u8).collect();
    NETWORK_FS.contains(&String::from_utf8_lossy(&raw).as_ref())
}

fn check_url(url: &str) -> Result<String, String> {
    let u = url.trim();
    let scheme = u.split("://").next().unwrap_or("").to_ascii_lowercase();
    if !u.contains("://") || !["smb", "afp", "nfs", "cifs", "ftp", "http", "https", "vnc"].contains(&scheme.as_str()) {
        return Err("Use an address like smb://server/share, afp://server, nfs://server/path or https://server/webdav.".into());
    }
    if u.chars().any(|c| c.is_control()) {
        return Err("That address has invisible characters in it.".into());
    }
    Ok(u.to_string())
}

/// Mount a server (macOS asks for the password if it needs one); returns the
/// mounted folder.
#[tauri::command]
pub async fn connect_server(url: String) -> Result<String, String> {
    let url = check_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            const SCRIPT: &str = "on run argv\n\tset r to mount volume (item 1 of argv)\n\treturn POSIX path of (r as alias)\nend run";
            let o = std::process::Command::new("osascript")
                .args(["-e", SCRIPT, &url])
                .output()
                .map_err(|e| format!("Couldn't ask macOS to connect: {e}"))?;
            if o.status.success() {
                let p = String::from_utf8_lossy(&o.stdout).trim().trim_end_matches('/').to_string();
                return Ok(if p.is_empty() { "/Volumes".into() } else { p });
            }
            Err(osascript_error(&String::from_utf8_lossy(&o.stderr), &url))
        }
        #[cfg(not(target_os = "macos"))]
        Err(format!("Connecting to {url} isn't supported here."))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// "0:42: execution error: The server … (-36)" → "Couldn't connect: The server …"
fn osascript_error(stderr: &str, url: &str) -> String {
    if stderr.contains("(-128)") {
        return "Cancelled.".into();
    }
    let msg = stderr.rsplit("execution error:").next().unwrap_or("").trim();
    let msg = match msg.rfind(" (-") {
        Some(i) if msg.ends_with(')') => &msg[..i],
        _ => msg,
    };
    if msg.is_empty() { format!("Couldn't connect to {url}.") } else { format!("Couldn't connect: {msg}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert!(check_url("smb://nas.local/share").is_ok());
        assert!(check_url(" afp://server ").is_ok());
        assert!(check_url("https://dav.example.com/files").is_ok());
        assert!(check_url("server/share").is_err());
        assert!(check_url("file:///etc").is_err());
        assert!(check_url("smb://x\n\"; do shell script \"rm").is_err());
    }

    #[test]
    fn errors() {
        assert_eq!(osascript_error("0:52: execution error: User canceled. (-128)\n", "smb://x"), "Cancelled.");
        assert_eq!(osascript_error("0:52: execution error: There was a problem connecting to the server. (-36)", "smb://x"), "Couldn't connect: There was a problem connecting to the server.");
        assert_eq!(osascript_error("", "smb://x"), "Couldn't connect to smb://x.");
    }

    #[test]
    fn local_disk_is_not_network() {
        assert!(!is_network("/"));
        assert!(!is_network("/definitely/not/here"));
    }
}
