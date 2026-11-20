//! Git status for the tree colours: which files are modified, new or in conflict.

use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
pub struct GitFile {
    /// Absolute path of the file (or of an untracked folder).
    path: String,
    /// "modified", "new", "deleted" or "conflict".
    state: &'static str,
}

fn git(dir: &str) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    cmd
}

fn state_of(x: u8, y: u8) -> &'static str {
    match (x, y) {
        (b'?', b'?') => "new",
        (b'U', _) | (_, b'U') | (b'A', b'A') | (b'D', b'D') => "conflict",
        (b'A', _) => "new",
        (b'D', _) | (_, b'D') => "deleted",
        _ => "modified",
    }
}

/// Changed files of the repository that `dir` is in. Empty if it is not in a git repository
/// or git is not installed.
#[tauri::command]
pub async fn git_status(dir: String) -> Vec<GitFile> {
    let Ok(top) = git(&dir).args(["rev-parse", "--show-toplevel"]).output() else {
        return Vec::new();
    };
    if !top.status.success() {
        return Vec::new();
    }
    let top = String::from_utf8_lossy(&top.stdout).trim().to_string();
    let Ok(out) = git(&dir).args(["status", "--porcelain=v1", "-z"]).output() else {
        return Vec::new();
    };
    let mut files = Vec::new();
    let mut parts = out.stdout.split(|&b| b == 0).peekable();
    while let Some(entry) = parts.next() {
        if entry.len() < 4 {
            continue;
        }
        let (x, y) = (entry[0], entry[1]);
        let rel = String::from_utf8_lossy(&entry[3..]).trim_end_matches('/').to_string();
        if x == b'R' || x == b'C' {
            parts.next(); // the old name of a rename follows; not needed
        }
        let path = Path::new(&top).join(&rel);
        // git prints forward slashes; make the path look like the tree's own paths.
        let path = path.to_string_lossy().replace('/', std::path::MAIN_SEPARATOR_STR);
        files.push(GitFile { path, state: state_of(x, y) });
    }
    files
}
