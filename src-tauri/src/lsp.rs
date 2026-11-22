//! Language servers declared by plugins ("languages" in plugin.json). Each runs as a child process
//! speaking LSP over stdio. npm-packaged servers (pyright, typescript-language-server…) run in the
//! bundled Deno, which downloads them once into Tern's cache — no Node needed. Others are programs
//! found on PATH (rust-analyzer, clangd…). This module only moves framed JSON messages; the editor
//! side is @codemirror/lsp-client.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct LspState {
    next: AtomicU32,
    servers: Mutex<HashMap<u32, Server>>,
}

struct Server {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// How to start a server: an npm package (run by Deno) or a program.
#[derive(Deserialize)]
pub struct ServerSpec {
    /// "pyright@1.1.414"
    npm: Option<String>,
    /// The package's executable: "pyright-langserver".
    bin: Option<String>,
    /// A program on PATH: "rust-analyzer".
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Serialize, Clone)]
struct LspEvent {
    id: u32,
    msg: Option<String>,
    exit: Option<String>,
}

fn safe(s: &str, extra: &str) -> bool {
    !s.is_empty() && s.len() < 120 && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_.@/".contains(c) || extra.contains(c))
}

fn command_for(app: &AppHandle, spec: &ServerSpec) -> Result<Command, String> {
    if let Some(pkg) = &spec.npm {
        let bin = spec.bin.as_deref().unwrap_or("");
        if !safe(pkg, "^~") || !pkg[1..].contains('@') || (!bin.is_empty() && !safe(bin, "")) {
            return Err("invalid npm server".into());
        }
        let deno = crate::plugin_host::deno_path().ok_or("Deno is missing")?;
        let base = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let mut cmd = Command::new(deno);
        let spec_arg = if bin.is_empty() { format!("npm:{pkg}") } else { format!("npm:{pkg}/{bin}") };
        cmd.args(["run", "-A", "--no-config", "--no-lock", "--quiet"]).arg(spec_arg);
        cmd.env("DENO_DIR", base.join("deno-cache"));
        cmd.env("NO_COLOR", "1");
        return Ok(cmd);
    }
    let name = spec.command.as_deref().ok_or("no server command")?;
    let path = which::which(name).map_err(|_| format!("not-found:{name}"))?;
    Ok(Command::new(path))
}

/// Starts a language server for a project. Returns its id; messages arrive as "lsp" events.
#[tauri::command]
pub fn lsp_start(app: AppHandle, state: State<LspState>, server: ServerSpec, root: String) -> Result<u32, String> {
    let mut cmd = command_for(&app, &server)?;
    cmd.args(&server.args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;

    let handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let reason = loop {
            // Headers, then a body of Content-Length bytes.
            let mut len = 0usize;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let l = line.trim();
                if l.is_empty() {
                    break;
                }
                if let Some(v) = l.strip_prefix("Content-Length:").or_else(|| l.strip_prefix("content-length:")) {
                    len = v.trim().parse().unwrap_or(0);
                }
            }
            if len == 0 {
                break "stopped";
            }
            let mut body = vec![0u8; len];
            if reader.read_exact(&mut body).is_err() {
                break "stopped";
            }
            let msg = String::from_utf8_lossy(&body).into_owned();
            let _ = handle.emit("lsp", LspEvent { id, msg: Some(msg), exit: None });
        };
        let _ = handle.emit("lsp", LspEvent { id, msg: None, exit: Some(reason.into()) });
        if let Some(state) = handle.try_state::<LspState>() {
            if let Ok(mut s) = state.servers.lock() {
                s.remove(&id);
            }
        }
    });
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[lsp {id}] {line}");
        }
    });
    state
        .servers
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id, Server { child, stdin: Arc::new(Mutex::new(stdin)) });
    Ok(id)
}

#[tauri::command]
pub fn lsp_send(state: State<LspState>, id: u32, msg: String) -> Result<(), String> {
    let stdin = {
        let servers = state.servers.lock().map_err(|e| e.to_string())?;
        servers.get(&id).ok_or("server stopped")?.stdin.clone()
    };
    let mut w = stdin.lock().map_err(|e| e.to_string())?;
    write!(w, "Content-Length: {}\r\n\r\n", msg.len())
        .and_then(|_| w.write_all(msg.as_bytes()))
        .and_then(|_| w.flush())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(state: State<LspState>, id: u32) -> Result<(), String> {
    state.servers.lock().map_err(|e| e.to_string())?.remove(&id);
    Ok(())
}
