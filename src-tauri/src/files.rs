//! Reading and saving files for the editor, and the file actions of the tree
//! (create, rename, move, delete to the Recycle Bin, show in Explorer).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

/// Bigger files are not opened in the editor: it would be slow and is rarely useful.
/// CodeMirror only renders what is on screen, so logs of tens of MB are still fine.
const MAX_EDIT_SIZE: u64 = 50 * 1024 * 1024;

fn mtime(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
pub struct TextFile {
    text: String,
    /// Last change on disk, in ms; sent back on save to notice changes made meanwhile.
    mtime: u64,
}

/// Reads a text file. Errors: "too-large", "binary" (or not UTF-8), or the OS message.
#[tauri::command]
pub fn read_text(path: String) -> Result<TextFile, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_EDIT_SIZE {
        return Err("too-large".into());
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return Err("binary".into());
    }
    let mut text = String::from_utf8(bytes).map_err(|_| "binary".to_string())?;
    if text.starts_with('\u{feff}') {
        text.remove(0); // byte-order mark: the editor does not need to show it
    }
    Ok(TextFile { text, mtime: mtime(p) })
}

/// Saves a text file. If `expected_mtime` is given and the file changed on disk since,
/// nothing is written and the error is "changed-on-disk". Returns the new mtime.
#[tauri::command]
pub fn write_text(path: String, text: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    let p = Path::new(&path);
    if let Some(expected) = expected_mtime {
        if p.exists() && mtime(p) != expected {
            return Err("changed-on-disk".into());
        }
    }
    std::fs::write(p, text).map_err(|e| e.to_string())?;
    Ok(mtime(p))
}

fn check_name(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'));
    if bad {
        Err("invalid-name".into())
    } else {
        Ok(())
    }
}

/// Creates an empty file or folder named `name` inside `dir`. Returns its path.
#[tauri::command]
pub fn create_entry(dir: String, name: String, is_dir: bool) -> Result<String, String> {
    check_name(&name)?;
    let path = Path::new(&dir).join(&name);
    if path.exists() {
        return Err("exists".into());
    }
    if is_dir {
        std::fs::create_dir(&path).map_err(|e| e.to_string())?;
    } else {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Renames a file or folder in place. Returns the new path.
#[tauri::command]
pub fn rename_entry(path: String, name: String) -> Result<String, String> {
    check_name(&name)?;
    let from = PathBuf::from(&path);
    let to = from.with_file_name(&name);
    // Changing only the letter case is allowed on Windows even though the target "exists".
    if to.exists() && !to.to_string_lossy().eq_ignore_ascii_case(&from.to_string_lossy()) {
        return Err("exists".into());
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(to.to_string_lossy().into_owned())
}

/// Moves a file or folder into another folder. Returns the new path.
#[tauri::command]
pub fn move_entry(path: String, to_dir: String) -> Result<String, String> {
    let from = PathBuf::from(&path);
    let name = from.file_name().ok_or("invalid-name")?;
    let dest_dir = PathBuf::from(&to_dir);
    if dest_dir.starts_with(&from) {
        return Err("into-itself".into());
    }
    let to = dest_dir.join(name);
    if to == from {
        return Ok(path);
    }
    if to.exists() {
        return Err("exists".into());
    }
    std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
    Ok(to.to_string_lossy().into_owned())
}

/// Copies files and folders (dropped from Explorer, or picked) into a folder. A name that is
/// taken gets a number: "notes (1).txt". Returns the new paths.
#[tauri::command]
pub async fn copy_into(paths: Vec<String>, to_dir: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dest_dir = PathBuf::from(&to_dir);
        if !dest_dir.is_dir() {
            return Err("not a folder".to_string());
        }
        let mut out = Vec::new();
        for p in paths {
            let from = PathBuf::from(&p);
            if dest_dir.starts_with(&from) {
                return Err("into-itself".into());
            }
            let name = from.file_name().ok_or("invalid-name")?.to_string_lossy().into_owned();
            let to = free_name(&dest_dir, &name);
            copy_any(&from, &to).map_err(|e| e.to_string())?;
            out.push(to.to_string_lossy().into_owned());
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `name` in `dir`, or "name (1).ext", "name (2).ext"… if taken.
fn free_name(dir: &std::path::Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn copy_any(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for e in std::fs::read_dir(from)? {
            let e = e?;
            copy_any(&e.path(), &to.join(e.file_name()))?;
        }
        Ok(())
    } else {
        std::fs::copy(from, to).map(|_| ())
    }
}

/// Moves a file or folder to the Recycle Bin (never deletes for good).
#[tauri::command]
pub fn trash_entry(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| e.to_string())
}

/// Opens Explorer (Finder, the file manager) with the item selected.
#[tauri::command]
pub fn reveal_entry(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").args(["-R", &path]).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = Path::new(&path).parent().unwrap_or(Path::new("/"));
        std::process::Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}
