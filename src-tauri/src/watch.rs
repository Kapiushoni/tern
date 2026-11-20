//! Watches the open project folder (and the file open in the editor) for changes on disk, so the
//! tree, the editor and the git colours follow edits made by Claude or any other program.
//! Changes are batched and sent to the UI as one "fs-change" event every 150 ms at most.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// Busy folders whose churn (installs, builds) nobody needs to see live.
const NOISY: &[&str] = &["node_modules", "target", ".venv", "venv", "__pycache__", ".gradle"];

#[derive(Default)]
pub struct WatchState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize, Clone)]
struct FsChange {
    /// Changed paths (files or folders), outside .git and noisy folders.
    paths: Vec<String>,
    /// Something in .git changed (commit, stage, checkout): git colours need a refresh.
    git: bool,
}

enum Kind {
    Skip,
    Git,
    Path,
}

fn classify(path: &Path) -> Kind {
    let mut in_git = false;
    for c in path.components() {
        if let Component::Normal(name) = c {
            let name = name.to_string_lossy();
            if name == ".git" {
                in_git = true;
            } else if NOISY.contains(&name.as_ref()) {
                return Kind::Skip;
            }
        }
    }
    if !in_git {
        return Kind::Path;
    }
    // Inside .git only the files that change what `git status` says matter.
    let s = path.to_string_lossy();
    let tail = s.rsplit(['\\', '/']).next().unwrap_or("");
    if tail == "index" || tail == "HEAD" || s.contains("refs") {
        Kind::Git
    } else {
        Kind::Skip
    }
}

/// Replaces what is watched: `roots` recursively, `files` (their folders) one level deep.
#[tauri::command]
pub fn watch_set(
    app: AppHandle,
    state: State<'_, WatchState>,
    roots: Vec<String>,
    files: Vec<String>,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    for r in &roots {
        let _ = watcher.watch(Path::new(r), RecursiveMode::Recursive);
    }
    for f in &files {
        let dir = Path::new(f).parent().map(Path::to_path_buf);
        if let Some(dir) = dir {
            if !roots.iter().any(|r| dir.starts_with(r)) {
                let _ = watcher.watch(&dir, RecursiveMode::NonRecursive);
            }
        }
    }
    // Dropping the old watcher ends its channel, which ends its batching thread.
    *state.watcher.lock().unwrap() = Some(watcher);

    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut paths: HashSet<PathBuf> = HashSet::new();
            let mut git = false;
            let mut take = |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    for p in ev.paths {
                        match classify(&p) {
                            Kind::Skip => {}
                            Kind::Git => git = true,
                            Kind::Path => {
                                paths.insert(p);
                            }
                        }
                    }
                }
            };
            take(first);
            std::thread::sleep(Duration::from_millis(150));
            while let Ok(more) = rx.try_recv() {
                take(more);
            }
            if paths.is_empty() && !git {
                continue;
            }
            let paths = paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
            if app.emit("fs-change", FsChange { paths, git }).is_err() {
                break;
            }
        }
    });
    Ok(())
}
