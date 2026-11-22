//! Plugins: folders in the plugins directory, each with a plugin.json. Their code runs sandboxed in
//! the UI, which only reaches the computer through these commands, after checking the plugin's
//! granted permissions. Rust adds a second line of defence: paths stay inside the folder they are
//! meant for.

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Where the catalog of plugins lives (a file in Tern's repository).
const CATALOG_URL: &str = "https://raw.githubusercontent.com/Kapiushoni/tern/main/plugins/catalog.json";
/// Largest plugin download accepted.
const MAX_ZIP: u64 = 30 * 1024 * 1024;
/// Largest file a plugin may read through the API.
const MAX_READ: u64 = 5 * 1024 * 1024;

fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("plugin-data");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A plugin id: its folder name. Letters, digits, "-" and "_" only.
fn valid_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err("invalid-id".into())
    }
}

/// `base` joined with a relative path that may not climb out of it.
fn inside(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel.trim_start_matches(['/', '\\']));
    if rel.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir)) {
        return Err("outside".into());
    }
    Ok(base.join(rel))
}

#[derive(Serialize)]
pub struct PluginEntry {
    id: String,
    dir: String,
    /// plugin.json as written (the UI validates it).
    manifest: Option<String>,
}

#[tauri::command]
pub fn plugins_list(app: AppHandle) -> Result<Vec<PluginEntry>, String> {
    let dir = plugins_dir(&app)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let path = e.path();
        let id = e.file_name().to_string_lossy().into_owned();
        if !path.is_dir() || valid_id(&id).is_err() {
            continue;
        }
        let manifest = std::fs::read_to_string(path.join("plugin.json")).ok();
        out.push(PluginEntry { id, dir: path.to_string_lossy().into_owned(), manifest });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub fn plugins_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(plugins_dir(&app)?.to_string_lossy().into_owned())
}

/// A text file from a plugin's own folder (its code, HTML, CSS).
#[tauri::command]
pub fn plugin_file(app: AppHandle, id: String, path: String) -> Result<String, String> {
    valid_id(&id)?;
    let file = inside(&plugins_dir(&app)?.join(&id), &path)?;
    std::fs::read_to_string(file).map_err(|e| e.to_string())
}

/// For the plugin host: the plugin's folder, its background code file (inside that folder) and a
/// folder of its own to keep files in. All three as absolute paths.
pub fn backend_paths(app: &AppHandle, id: &str, file: &str) -> Result<(String, String, String), String> {
    valid_id(id)?;
    let dir = plugins_dir(app)?.join(id);
    let path = inside(&dir, file)?;
    if !path.is_file() {
        return Err(format!("{file} is missing"));
    }
    let data = data_dir(app)?.join(id);
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let s = |p: PathBuf| p.to_string_lossy().into_owned();
    Ok((s(dir), s(path), s(data)))
}

#[tauri::command]
pub fn plugin_remove(app: AppHandle, id: String) -> Result<(), String> {
    valid_id(&id)?;
    let dir = plugins_dir(&app)?.join(&id);
    if dir.is_dir() {
        // To the Recycle Bin when possible, so a removed plugin can be brought back.
        trash::delete(&dir).or_else(|_| std::fs::remove_dir_all(&dir).map_err(|e| e.to_string()))?;
    }
    let _ = std::fs::remove_file(data_dir(&app)?.join(format!("{id}.json")));
    Ok(())
}

/// Per-plugin state kept by Tern: granted permissions, enabled, settings, the plugin's storage.
#[tauri::command]
pub fn plugin_data_load(app: AppHandle, id: String) -> Result<Option<String>, String> {
    valid_id(&id)?;
    Ok(std::fs::read_to_string(data_dir(&app)?.join(format!("{id}.json"))).ok())
}

#[tauri::command]
pub fn plugin_data_save(app: AppHandle, id: String, json: String) -> Result<(), String> {
    valid_id(&id)?;
    let file = data_dir(&app)?.join(format!("{id}.json"));
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn plugin_catalog() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut resp = ureq::get(CATALOG_URL).call().map_err(|e| format!("network: {e}"))?;
        resp.body_mut().read_to_string().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installs a plugin from a zip (a GitHub archive): the folder `subdir` inside it becomes
/// plugins/<id>. Replaces an older copy only once the new one is fully unpacked.
#[tauri::command]
pub async fn plugin_install(app: AppHandle, id: String, url: String, subdir: Option<String>) -> Result<(), String> {
    valid_id(&id)?;
    if !url.starts_with("https://") {
        return Err("https only".into());
    }
    let dir = plugins_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut resp = ureq::get(&url).call().map_err(|e| format!("network: {e}"))?;
        let mut bytes = Vec::new();
        resp.body_mut()
            .as_reader()
            .take(MAX_ZIP + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("network: {e}"))?;
        if bytes.len() as u64 > MAX_ZIP {
            return Err("too-large".into());
        }
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let want = subdir.unwrap_or_default().trim_matches('/').to_string();
        let tmp = dir.join(format!(".{id}.installing"));
        let _ = std::fs::remove_dir_all(&tmp);
        let mut found = false;
        // GitHub archives wrap everything in "<repo>-<branch>/"; a plain zip may have plugin.json at the top.
        let wrapped = !(0..zip.len()).any(|i| zip.by_index(i).ok().and_then(|e| e.enclosed_name()).is_some_and(|n| n == Path::new("plugin.json")));
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let Some(name) = entry.enclosed_name() else { continue };
            // GitHub archives wrap everything in "<repo>-<branch>/".
            let parts: Vec<String> = name.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            let skip = usize::from(wrapped);
            if parts.len() <= skip {
                continue;
            }
            let inner = parts[skip..].join("/");
            let rel = if want.is_empty() {
                inner
            } else if let Some(rest) = inner.strip_prefix(&format!("{want}/")) {
                rest.to_string()
            } else {
                continue;
            };
            if rel.is_empty() {
                continue;
            }
            let out = inside(&tmp, &rel)?;
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(p) = out.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
            found |= rel == "plugin.json";
        }
        if !found {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err("no plugin.json in the download".into());
        }
        let target = dir.join(&id);
        let _ = std::fs::remove_dir_all(&target);
        std::fs::rename(&tmp, &target).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installs a plugin from a folder on this computer (copied, so the original can move on).
/// Returns its id: the folder's name, made safe.
#[tauri::command]
pub fn plugin_install_dir(app: AppHandle, from: String) -> Result<String, String> {
    let src = PathBuf::from(&from);
    if !src.join("plugin.json").is_file() {
        return Err("no plugin.json in that folder".into());
    }
    let name = src.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let id: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(64)
        .collect();
    valid_id(&id)?;
    let dir = plugins_dir(&app)?;
    if dir.starts_with(&src) || src.starts_with(dir.join(&id)) {
        return Err("into-itself".into());
    }
    let tmp = dir.join(format!(".{id}.installing"));
    let _ = std::fs::remove_dir_all(&tmp);
    copy_plugin(&src, &tmp).map_err(|e| e.to_string())?;
    let target = dir.join(&id);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&tmp, &target).map_err(|e| e.to_string())?;
    Ok(id)
}

/// A plugin folder without what never belongs in it (git data, installed packages).
fn copy_plugin(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let name = e.file_name();
        if [".git", "node_modules"].iter().any(|n| name == *n) {
            continue;
        }
        let (src, dst) = (e.path(), to.join(&name));
        if e.file_type()?.is_dir() {
            copy_plugin(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Resolves a plugin's path inside the project folder; anything outside it is refused.
fn project_path(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = std::fs::canonicalize(root).map_err(|_| "no project".to_string())?;
    let path = inside(&root, rel)?;
    // Symlinks could still lead out: check the real location of what exists.
    let mut probe = path.clone();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let real = std::fs::canonicalize(&probe).map_err(|e| e.to_string())?;
    if !real.starts_with(&root) {
        return Err("outside the project".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn plugin_fs_read(root: String, path: String) -> Result<Option<String>, String> {
    let p = project_path(&root, &path)?;
    match std::fs::metadata(&p) {
        Err(_) => Ok(None),
        Ok(m) if m.len() > MAX_READ => Err("too-large".into()),
        Ok(_) => std::fs::read_to_string(&p).map(Some).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
pub fn plugin_fs_write(root: String, path: String, text: String) -> Result<(), String> {
    let p = project_path(&root, &path)?;
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_fs_list(root: String, path: String) -> Result<Vec<String>, String> {
    let p = project_path(&root, &path)?;
    let mut out: Vec<String> = std::fs::read_dir(&p)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() { format!("{name}/") } else { name }
        })
        .collect();
    out.sort();
    Ok(out)
}

#[derive(Serialize)]
pub struct RunResult {
    code: i32,
    stdout: String,
    stderr: String,
}

/// Runs a shell command in `cwd` and returns its output (the "commands" permission).
#[tauri::command]
pub async fn plugin_run(command: String, cwd: String) -> Result<RunResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("powershell");
            c.args(["-NoProfile", "-NonInteractive", "-Command", &command]);
            c
        } else {
            let mut c = Command::new("sh");
            c.args(["-c", &command]);
            c
        };
        cmd.current_dir(&cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let out = child.wait_with_output().map_err(|e| e.to_string())?;
        Ok(RunResult {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct FetchResult {
    status: u16,
    body: String,
}

/// An HTTP request for a plugin (the UI has already checked the host is allowed).
#[tauri::command]
pub async fn plugin_fetch(
    url: String,
    method: Option<String>,
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
) -> Result<FetchResult, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("http(s) only".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .build()
            .into();
        let method = method.unwrap_or_else(|| "GET".into()).to_uppercase();
        let mut req = ureq::http::Request::builder().method(method.as_str()).uri(&url);
        for (k, v) in headers.unwrap_or_default() {
            req = req.header(k, v);
        }
        let req = req.body(body.unwrap_or_default()).map_err(|e| e.to_string())?;
        let mut resp = agent.run(req).map_err(|e| format!("network: {e}"))?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .with_config()
            .limit(MAX_READ)
            .read_to_string()
            .unwrap_or_default();
        Ok(FetchResult { status, body })
    })
    .await
    .map_err(|e| e.to_string())?
}
