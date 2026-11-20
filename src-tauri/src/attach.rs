//! Attaching files and images to a terminal: files copied in Explorer, images pasted from the
//! clipboard (saved to Tern's temp folder) and the cleanup of old pasted images.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request};

/// Pasted images older than this are deleted on startup.
const KEEP: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn paste_dir() -> PathBuf {
    std::env::temp_dir().join("Tern").join("pasted")
}

/// Paths of files copied to the clipboard (e.g. Ctrl+C in Explorer); empty if there are none.
#[tauri::command]
pub fn clipboard_files() -> Vec<String> {
    #[cfg(windows)]
    {
        use clipboard_win::{formats, get_clipboard};
        get_clipboard::<Vec<String>, _>(formats::FileList).unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

/// Saves image bytes sent as the raw request body; the `x-ext` header gives the extension.
/// Returns the saved file's path.
#[tauri::command]
pub async fn save_paste(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw image bytes".into());
    };
    let ext = request
        .headers()
        .get("x-ext")
        .and_then(|v| v.to_str().ok())
        .filter(|e| !e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("png");
    let dir = paste_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut path = dir.join(format!("paste-{ms}.{ext}"));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("paste-{ms}-{n}.{ext}"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Deletes pasted images older than a week. Runs in the background so startup does not wait.
pub fn cleanup_old_pastes() {
    std::thread::spawn(|| {
        let Ok(entries) = std::fs::read_dir(paste_dir()) else { return };
        let now = SystemTime::now();
        for e in entries.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age > KEEP);
            if old && e.path().is_file() {
                let _ = std::fs::remove_file(e.path());
            }
        }
    });
}

#[derive(serde::Serialize)]
pub struct FileInfo {
    size: u64,
    /// Last change, in milliseconds since 1970.
    modified: u64,
    is_dir: bool,
}

/// Size and date of a file, for the hover card; `None` if it does not exist.
#[tauri::command]
pub fn file_info(path: String) -> Option<FileInfo> {
    let m = std::fs::metadata(&path).ok()?;
    let modified = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Some(FileInfo { size: m.len(), modified, is_dir: m.is_dir() })
}
