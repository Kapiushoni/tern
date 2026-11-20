//! Claude Code activity signals.
//!
//! Every Claude tab is started with `--settings <file>` that registers a few HTTP hooks. Claude Code
//! POSTs the hook JSON straight to a tiny localhost server in this process (no extra process, no
//! shell), with the tab key in a header. The server forwards it to the UI as a `claude-hook` event.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub const ENV_TAB: &str = "TERN_TAB";
// SessionStart is not available as an HTTP hook; the session id arrives with the first prompt.
const EVENTS: [&str; 3] = ["UserPromptSubmit", "Stop", "Notification"];

#[derive(Serialize, Clone)]
struct HookMsg {
    tab: String,
    event: String,
    session_id: Option<String>,
}

pub struct HookState {
    pub settings_file: Option<PathBuf>,
}

/// Starts the server and writes the hook settings file. Never fails hard: without hooks the tabs
/// simply show no activity.
pub fn start(app: &AppHandle) -> HookState {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else {
        return HookState { settings_file: None };
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // A per-run secret, so only our own Claude tabs can post events.
    let key = format!("{:016x}", RandomState::new().build_hasher().finish());

    let handle = app.clone();
    let secret = key.clone();
    std::thread::Builder::new()
        .name("hooks".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                if let Some(msg) = handle_request(stream, &secret) {
                    let _ = handle.emit("claude-hook", msg);
                }
            }
        })
        .ok();

    HookState { settings_file: write_settings(app, port, &key).ok() }
}

/// Reads one small HTTP POST, answers `200 {}` and returns the parsed event.
fn handle_request(mut stream: TcpStream, secret: &str) -> Option<HookMsg> {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let (mut len, mut tab, mut key) = (0usize, String::new(), String::new());
    let mut line = String::new();
    reader.read_line(&mut line).ok()?; // request line
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let value = value.trim();
            match name.trim().to_ascii_lowercase().as_str() {
                "content-length" => len = value.parse().unwrap_or(0),
                "x-tern-tab" => tab = value.to_string(),
                "x-tern-key" => key = value.to_string(),
                _ => {}
            }
        }
    }
    let mut body = vec![0u8; len.min(4 * 1024 * 1024)];
    reader.read_exact(&mut body).ok()?;
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
    );
    if key != secret || tab.is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&body).ok()?;
    Some(HookMsg {
        tab,
        event: v.get("hook_event_name")?.as_str()?.to_string(),
        session_id: v.get("session_id").and_then(|s| s.as_str()).map(String::from),
    })
}

fn write_settings(app: &AppHandle, port: u16, key: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let hook = serde_json::json!([{ "hooks": [{
        "type": "http",
        "url": format!("http://127.0.0.1:{port}/hook"),
        "headers": { "X-Tern-Tab": format!("${ENV_TAB}"), "X-Tern-Key": key },
        "allowedEnvVars": [ENV_TAB],
        "timeout": 2
    }]}]);
    let hooks: serde_json::Map<_, _> = EVENTS.iter().map(|e| (e.to_string(), hook.clone())).collect();

    let dir = app.path().app_data_dir()?.join("hooks");
    std::fs::create_dir_all(&dir)?;
    // One file per running window (several Tern windows can run at once); drop day-old leftovers.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let day = Duration::from_secs(24 * 3600);
        for e in entries.flatten() {
            let old = e.metadata().and_then(|m| m.modified()).ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age > day);
            if old {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    let file = dir.join(format!("claude-hooks-{port}.json"));
    std::fs::write(&file, serde_json::to_vec_pretty(&serde_json::json!({ "hooks": hooks }))?)?;
    Ok(file)
}
