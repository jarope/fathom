//! New ▸ from Template (Dolphin's "Create New"): every file or folder in the
//! templates folder (~/Templates unless Preferences says otherwise) can be
//! copied into the current folder in one click.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct Template {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub struct Templates {
    dir: String,
    exists: bool,
    items: Vec<Template>,
}

fn resolve(dir: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    match dir.trim() {
        "" => PathBuf::from(home).join("Templates"),
        d if d.starts_with("~/") => PathBuf::from(home).join(&d[2..]),
        d => PathBuf::from(d),
    }
}

/// What's in the templates folder (hidden files skipped), sorted by name.
#[tauri::command]
pub fn templates(dir: String) -> Templates {
    let d = resolve(&dir);
    let mut items: Vec<Template> = std::fs::read_dir(&d)
        .map(|rd| {
            rd.flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| Template {
                    name: e.file_name().to_string_lossy().into_owned(),
                    path: e.path().to_string_lossy().into_owned(),
                    is_dir: e.path().is_dir(),
                })
                .collect()
        })
        .unwrap_or_default();
    items.sort_by_key(|t| t.name.to_lowercase());
    Templates { dir: d.to_string_lossy().into_owned(), exists: d.is_dir(), items }
}

/// Copy a template into `parent` under a free name; returns the new path.
#[tauri::command]
pub fn create_from_template(template: String, parent: String) -> Result<String, String> {
    let src = Path::new(&template);
    let name = src.file_name().ok_or("Not a template")?.to_string_lossy().into_owned();
    let dir = Path::new(&parent);
    if !dir.is_dir() {
        return Err(format!("Not a folder: {parent}"));
    }
    let target = crate::unique_new(dir, &name);
    crate::copy_recursive(src, &target).map_err(|e| format!("Couldn't create {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

const STARTERS: &[(&str, &str, bool)] = &[
    ("Text file.txt", "", false),
    ("Markdown note.md", "# Title\n\n", false),
    ("Shell script.sh", "#!/usr/bin/env bash\nset -euo pipefail\n\n", true),
    ("Python script.py", "#!/usr/bin/env python3\n\n\ndef main():\n    pass\n\n\nif __name__ == \"__main__\":\n    main()\n", true),
    ("Web page.html", "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>Untitled</title>\n</head>\n<body>\n\n</body>\n</html>\n", false),
    ("JSON file.json", "{\n}\n", false),
    (".editorconfig", "root = true\n\n[*]\nindent_style = space\nindent_size = 2\nend_of_line = lf\ninsert_final_newline = true\n", false),
];

/// Make the templates folder with a few starter templates (never overwrites).
#[tauri::command]
pub fn templates_setup(dir: String) -> Result<String, String> {
    let d = resolve(&dir);
    std::fs::create_dir_all(&d).map_err(|e| format!("Couldn't create {}: {e}", d.display()))?;
    for (name, body, exec) in STARTERS {
        // ".editorconfig" would be hidden in the menu; ship it visible.
        let name = name.strip_prefix('.').unwrap_or(name);
        let p = d.join(name);
        if p.exists() {
            continue;
        }
        std::fs::write(&p, body).map_err(|e| format!("{}: {e}", p.display()))?;
        if *exec {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
        }
    }
    Ok(d.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_list_create() {
        let root = std::env::temp_dir().join(format!("fathom-tpl-{}", std::process::id()));
        let tpl = root.join("T");
        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let dir = tpl.to_string_lossy().into_owned();
        assert!(!templates(dir.clone()).exists);
        templates_setup(dir.clone()).unwrap();
        let t = templates(dir.clone());
        assert!(t.exists && t.items.iter().any(|i| i.name == "Shell script.sh"));
        let sh = t.items.iter().find(|i| i.name == "Shell script.sh").unwrap();
        let a = create_from_template(sh.path.clone(), out.to_string_lossy().into_owned()).unwrap();
        let b = create_from_template(sh.path.clone(), out.to_string_lossy().into_owned()).unwrap();
        assert!(a.ends_with("/Shell script.sh") && b.ends_with("/Shell script 2.sh"));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&a).unwrap().permissions().mode() & 0o111, 0o111);
        std::fs::write(tpl.join("Shell script.sh"), "mine").unwrap();
        templates_setup(dir).unwrap(); // doesn't overwrite your edits
        assert_eq!(std::fs::read_to_string(tpl.join("Shell script.sh")).unwrap(), "mine");
        std::fs::remove_dir_all(root).unwrap();
    }
}
