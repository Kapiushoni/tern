//! Saves and loads the UI session (open tabs, active tab, sidebar width) as a small JSON file.
//! The UI owns the format; Rust only stores the text.

use tauri::{AppHandle, Manager};

fn file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
pub fn session_load(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(file(&app).ok()?).ok()
}

#[tauri::command]
pub fn session_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = file(&app)?;
    // Write then rename, so a crash mid-write never leaves a broken file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Whether Claude Code still has this conversation on disk, so a tab can resume it.
/// Looks in every project folder of the Claude config dir, so it does not depend on how
/// Claude Code encodes the working directory into a folder name.
#[tauri::command]
pub fn claude_session_exists(id: String) -> bool {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return false;
    }
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(|h| std::path::PathBuf::from(h).join(".claude"))
        });
    let Some(projects) = config.map(|c| c.join("projects")) else { return false };
    let file = format!("{id}.jsonl");
    std::fs::read_dir(projects)
        .map(|dirs| dirs.flatten().any(|d| d.path().join(&file).is_file()))
        .unwrap_or(false)
}
