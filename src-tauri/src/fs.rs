use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use serde::Serialize;

/// Folders that are hidden from the tree unless the user asks to see them.
pub(crate) const SERVICE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "target",
    "build",
    "__pycache__",
    ".idea",
];

/// A recursive walk of a project the way the tree shows it: .gitignore respected, service folders
/// skipped. Used by quick open and project search.
pub(crate) fn project_walker(root: &Path) -> WalkBuilder {
    let mut w = WalkBuilder::new(root);
    w.hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .filter_entry(|d| !SERVICE_DIRS.contains(&d.file_name().to_string_lossy().as_ref()));
    w
}

#[derive(Serialize)]
pub struct Entry {
    name: String,
    path: String,
    is_dir: bool,
    /// Hidden by default (a service folder or gitignored); only listed when showing hidden files.
    hidden: bool,
}

/// Lists ONE folder level. The tree calls this only when a folder is expanded,
/// so huge folders cost nothing until they are opened.
#[tauri::command]
pub fn list_dir(path: String, show_hidden: bool) -> Result<Vec<Entry>, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("not a folder: {path}"));
    }

    let visible: Vec<Entry> = WalkBuilder::new(&root)
        .max_depth(Some(1))
        .hidden(false) // dotfiles like .env stay visible unless gitignored
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .build()
        .filter_map(Result::ok)
        .filter(|d| d.depth() == 1)
        .filter(|d| !SERVICE_DIRS.contains(&d.file_name().to_string_lossy().as_ref()))
        .map(|d| {
            to_entry(
                d.path(),
                d.file_type().map(|t| t.is_dir()).unwrap_or(false),
                false,
            )
        })
        .collect();

    let mut entries = if show_hidden {
        // Everything in the folder; whatever the normal listing leaves out is marked hidden.
        let shown: std::collections::HashSet<String> =
            visible.into_iter().map(|e| e.path).collect();
        std::fs::read_dir(&root)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|d| {
                let path = d.path();
                let hidden = !shown.contains(path.to_string_lossy().as_ref());
                to_entry(
                    &path,
                    d.file_type().map(|t| t.is_dir()).unwrap_or(false),
                    hidden,
                )
            })
            .collect()
    } else {
        visible
    };

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn to_entry(path: &Path, is_dir: bool, hidden: bool) -> Entry {
    Entry {
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        is_dir,
        hidden,
    }
}

#[derive(Serialize)]
pub struct StartDirs {
    /// Folder passed on the command line, if any.
    cli: Option<String>,
    home: String,
}

/// The folder given as the first command-line argument (if it is a folder) and the home folder.
#[tauri::command]
pub fn initial_dir() -> StartDirs {
    let cli = std::env::args().nth(1).filter(|a| Path::new(a).is_dir());
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    StartDirs { cli, home }
}
