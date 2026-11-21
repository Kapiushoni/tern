mod attach;
mod files;
mod fs;
mod git;
mod hooks;
mod preview;
mod pty;
mod search;
mod session;
mod tools;
mod voice;
mod watch;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::default())
        .manage(watch::WatchState::default())
        .manage(voice::VoiceState::default())
        .manage(search::SearchState::default())
        .manage(preview::PreviewState::default())
        .setup(|app| {
            pty::allow_ctrl_c();
            attach::cleanup_old_pastes();
            voice::init();
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
            search::list_files,
            search::search_text,
            search::search_cancel,
            preview::preview_url,
            tools::ide_list,
            tools::ide_open,
            tools::run_detect,
            tools::run_candidates,
            tools::run_save,
            voice::voice_models,
            voice::voice_mics,
            voice::voice_download,
            voice::voice_download_cancel,
            voice::voice_delete_model,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_cancel,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Tern");
}
