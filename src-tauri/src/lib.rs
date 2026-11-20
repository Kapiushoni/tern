mod fs;
mod hooks;
mod pty;
mod session;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .setup(|app| {
            let state = hooks::start(app.handle());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs::list_dir,
            fs::initial_dir,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            session::session_load,
            session::session_save,
            session::claude_session_exists,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Tern");
}
