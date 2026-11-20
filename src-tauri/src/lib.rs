mod attach;
mod files;
mod fs;
mod git;
mod hooks;
mod pty;
mod session;
mod watch;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(watch::WatchState::default())
        .setup(|app| {
            attach::cleanup_old_pastes();
            let state = hooks::start(app.handle());
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            attach::clipboard_files,
            attach::save_paste,
            attach::file_info,
            files::read_text,
            files::write_text,
            files::create_entry,
            files::rename_entry,
            files::move_entry,
            files::trash_entry,
            files::reveal_entry,
            git::git_status,
            watch::watch_set,
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
