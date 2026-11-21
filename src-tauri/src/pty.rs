use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::hooks::{self, HookState};

struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, Session>>,
    next_id: AtomicU32,
}

/// Variables a parent Claude Code session sets for its own children. If Tern itself was started
/// from inside Claude Code, a tab inheriting them would act as that session's child (and, for
/// example, keep no history of its own). Settings such as CLAUDE_CONFIG_DIR are kept.
const PARENT_SESSION_VARS: &[&str] = &[
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_NOTES_DIR",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
];

fn build_command(kind: &str) -> Result<CommandBuilder, String> {
    match kind {
        "claude" => {
            let path = which::which("claude").map_err(|_| "claude-not-found".to_string())?;
            Ok(CommandBuilder::new(path))
        }
        _ => {
            #[cfg(windows)]
            {
                let shell = which::which("pwsh")
                    .or_else(|_| which::which("powershell"))
                    .map_err(|e| e.to_string())?;
                let mut cmd = CommandBuilder::new(shell);
                // UTF-8 console: otherwise programs print "●", Cyrillic and the like as "?".
                cmd.args([
                    "-NoLogo",
                    "-NoExit",
                    "-Command",
                    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $OutputEncoding = [Text.Encoding]::UTF8",
                ]);
                Ok(cmd)
            }
            #[cfg(not(windows))]
            {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
                Ok(CommandBuilder::new(shell))
            }
        }
    }
}

/// Starts `claude` or a plain shell in a pseudo-terminal.
/// Output is streamed as raw bytes over `on_data`; `on_exit` fires once when it ends.
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyState>,
    hooks: State<'_, HookState>,
    cwd: String,
    kind: String,
    tab: String,
    resume: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<u32>,
) -> Result<u32, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = build_command(&kind)?;
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "tern");
    for var in PARENT_SESSION_VARS {
        cmd.env_remove(var);
    }
    // Tern is a colour terminal. Tools that start it (npm and the Tauri dev runner, among others)
    // may set these for their own output; inherited, they turn colour off in every tab.
    for var in ["NO_COLOR", "FORCE_COLOR"] {
        cmd.env_remove(var);
    }
    if kind == "claude" {
        if let Some(file) = &hooks.settings_file {
            cmd.arg("--settings");
            cmd.arg(file);
            cmd.env(hooks::ENV_TAB, &tab);
        }
        match resume.as_deref() {
            None | Some("") => {}
            Some("continue") => cmd.arg("--continue"),
            Some(id) => {
                cmd.arg("--resume");
                cmd.arg(id);
            }
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    std::thread::Builder::new()
        .name(format!("pty-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = on_exit.send(id);
        })
        .map_err(|e| e.to_string())?;

    state
        .sessions
        .lock()
        .unwrap()
        .insert(id, Session { master: pair.master, writer, child });
    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let s = sessions.get_mut(&id).ok_or("no such terminal")?;
    s.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    s.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("no such terminal")?;
    s.master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: u32) -> Result<(), String> {
    if let Some(mut s) = state.sessions.lock().unwrap().remove(&id) {
        let _ = s.child.kill();
    }
    Ok(())
}

/// Lets Ctrl+C stop programs in the tabs. "Ignore Ctrl+C" is inherited from whatever started Tern
/// (a terminal running a background job, for one), and every shell would inherit it in turn.
pub fn allow_ctrl_c() {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn SetConsoleCtrlHandler(handler: *const core::ffi::c_void, add: i32) -> i32;
        }
        unsafe {
            SetConsoleCtrlHandler(std::ptr::null(), 0);
        }
    }
}
