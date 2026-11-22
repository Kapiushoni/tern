//! Background code of plugins ("backend" in plugin.json) runs in Deno: one process for all of them,
//! started when the first one is needed, each plugin in its own Worker with only the permissions
//! the user granted (see plugin-host/host.js). This module owns that process and passes JSON lines
//! between it and the UI, which answers the plugins' `tern.*` calls exactly as for their windows.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

const HOST_JS: &str = include_str!("../plugin-host/host.js");
const WORKER_JS: &str = include_str!("../plugin-host/worker.js");

#[derive(Default)]
pub struct PluginHostState(Mutex<Option<Host>>);

struct Host {
    child: Child,
    stdin: ChildStdin,
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Serialize, Clone)]
struct FromPlugin {
    id: String,
    msg: Option<Value>,
    exit: Option<String>,
}

/// Deno next to Tern's executable (bundled), else one on PATH.
fn deno_path() -> Option<PathBuf> {
    let name = if cfg!(windows) { "deno.exe" } else { "deno" };
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    which::which("deno").ok()
}

fn spawn(app: &AppHandle) -> Result<Host, String> {
    let deno = deno_path().ok_or("Deno is missing: plugins with background code can't run")?;
    let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let dir = base.join("plugin-host");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Always the scripts of this Tern version.
    std::fs::write(dir.join("host.js"), HOST_JS).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("worker.js"), WORKER_JS).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(deno);
    cmd.arg("run")
        // The host may grant these to workers; each worker gets only its plugin's share.
        .args(["--allow-read", "--allow-write", "--allow-net", "--allow-run", "--allow-env", "--allow-sys"])
        .args(["--unstable-worker-options", "--no-prompt", "--no-config", "--no-lock"])
        // Plugins ship bundled: nothing is downloaded from the internet at run time.
        .args(["--no-remote", "--no-npm"])
        .arg(dir.join("host.js"))
        .env("DENO_DIR", base.join("deno-cache"))
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("Deno: {e}"))?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    let handle = app.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            let Some(id) = v.get("id").and_then(Value::as_str) else { continue };
            let _ = handle.emit(
                "plugin-backend",
                FromPlugin {
                    id: id.to_string(),
                    msg: v.get("msg").cloned(),
                    exit: v.get("exit").and_then(Value::as_str).map(str::to_string),
                },
            );
        }
        // The host is gone: forget it, so the next start spawns a fresh one.
        if let Some(state) = handle.try_state::<PluginHostState>() {
            if let Ok(mut h) = state.0.lock() {
                *h = None;
            }
        }
        let _ = handle.emit("plugin-backend", FromPlugin { id: String::new(), msg: None, exit: Some("host".into()) });
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[plugin host] {line}");
        }
    });
    Ok(Host { child, stdin })
}

fn send(app: &AppHandle, state: &State<PluginHostState>, line: Value, start_if_needed: bool) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if guard.is_none() {
        if !start_if_needed {
            return Ok(());
        }
        *guard = Some(spawn(app)?);
    }
    let host = guard.as_mut().unwrap();
    let mut text = line.to_string();
    text.push('\n');
    if host.stdin.write_all(text.as_bytes()).and_then(|_| host.stdin.flush()).is_err() {
        *guard = None;
        return Err("the plugin host stopped".into());
    }
    Ok(())
}

/// Where Claude Code keeps its conversation logs (CLAUDE_CONFIG_DIR, else ~/.claude).
fn claude_projects(app: &AppHandle) -> Option<String> {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| app.path().home_dir().ok().map(|h| h.join(".claude")))?;
    Some(base.join("projects").to_string_lossy().into_owned())
}

/// Starts (or restarts) a plugin's background code with the permissions the user granted.
#[tauri::command]
pub fn plugin_backend_start(
    app: AppHandle,
    state: State<PluginHostState>,
    id: String,
    file: String,
    perms: Vec<String>,
) -> Result<(), String> {
    let (dir, path, data) = crate::plugins::backend_paths(&app, &id, &file)?;
    let claude = claude_projects(&app);
    send(
        &app,
        &state,
        json!({ "op": "start", "id": id, "file": path, "dir": dir, "data": data, "perms": perms, "claude": claude }),
        true,
    )
}

#[tauri::command]
pub fn plugin_backend_stop(app: AppHandle, state: State<PluginHostState>, id: String) -> Result<(), String> {
    send(&app, &state, json!({ "op": "stop", "id": id }), false)?;
    Ok(())
}

/// A message to a plugin's background code (a reply to its call, an event, a callback…).
#[tauri::command]
pub fn plugin_backend_send(app: AppHandle, state: State<PluginHostState>, id: String, msg: Value) -> Result<(), String> {
    send(&app, &state, json!({ "op": "to", "id": id, "msg": msg }), false)
}
