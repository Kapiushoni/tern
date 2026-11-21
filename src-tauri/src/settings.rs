//! settings.json: the UI owns its format and defaults; Rust stores the file and keeps the few
//! values it needs itself (how to start claude and the shell, which folders to hide, how long
//! pasted pictures are kept).

use std::path::PathBuf;
use std::sync::RwLock;

use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    /// Path to the claude executable; None = find it.
    pub claude_path: Option<String>,
    pub claude_args: Vec<String>,
    /// Shell for plain terminal tabs; None = PowerShell (Windows) / $SHELL.
    pub shell: Option<String>,
    pub hidden_folders: Vec<String>,
    pub images_keep_days: u32,
}

static RUNTIME: RwLock<Option<Runtime>> = RwLock::new(None);

/// Folders hidden from the tree, search and the watcher.
pub fn hidden_folders() -> Vec<String> {
    RUNTIME
        .read()
        .unwrap()
        .as_ref()
        .map(|r| r.hidden_folders.clone())
        .unwrap_or_else(|| crate::fs::SERVICE_DIRS.iter().map(|s| s.to_string()).collect())
}

pub fn runtime() -> Runtime {
    RUNTIME.read().unwrap().clone().unwrap_or_default()
}

fn file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub fn settings_path(app: AppHandle) -> Result<String, String> {
    Ok(file(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn settings_read(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(file(&app).ok()?).ok()
}

#[tauri::command]
pub fn settings_write(app: AppHandle, text: String) -> Result<(), String> {
    let path = file(&app)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The UI hands over the values Rust uses. The first call also starts the cleanup of old
/// pasted pictures, now that the user's "keep for N days" is known.
#[tauri::command]
pub fn settings_runtime(runtime: Runtime) {
    let first = RUNTIME.read().unwrap().is_none();
    let days = runtime.images_keep_days;
    *RUNTIME.write().unwrap() = Some(runtime);
    if first {
        crate::attach::cleanup_old_pastes(days);
    }
}

/// Where Claude Code is, if installed. Also looks where its installers put it, so a fresh
/// install is found without restarting Tern (its PATH is from before the install).
pub fn find_claude() -> Option<PathBuf> {
    if let Some(p) = runtime().claude_path.filter(|p| !p.trim().is_empty()) {
        let p = PathBuf::from(p);
        return if p.is_file() { Some(p) } else { which::which(&p).ok() };
    }
    if let Ok(p) = which::which("claude") {
        return Some(p);
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)?;
    let mut spots = vec![home.join(".local").join("bin").join(if cfg!(windows) { "claude.exe" } else { "claude" })];
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            spots.push(PathBuf::from(appdata).join("npm").join("claude.cmd"));
        }
    } else {
        spots.push(home.join(".claude").join("local").join("claude"));
        spots.push(PathBuf::from("/opt/homebrew/bin/claude"));
        spots.push(PathBuf::from("/usr/local/bin/claude"));
    }
    spots.into_iter().find(|p| p.is_file())
}

/// Whether Claude Code is installed (for the install screen), and where.
#[tauri::command]
pub fn claude_status() -> Option<String> {
    find_claude().map(|p| p.to_string_lossy().into_owned())
}

/// The official install command for this system, run in a terminal tab.
#[tauri::command]
pub fn claude_install_command() -> String {
    if cfg!(windows) {
        // Then start Claude Code from where the installer put it, to sign in.
        "irm https://claude.ai/install.ps1 | iex; if ($?) { & \"$env:USERPROFILE\\.local\\bin\\claude.exe\" }".into()
    } else {
        "curl -fsSL https://claude.ai/install.sh | bash && ~/.local/bin/claude".into()
    }
}
