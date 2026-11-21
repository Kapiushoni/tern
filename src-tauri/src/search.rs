//! Quick open (every file name in the project) and project-wide text search, using ripgrep's own
//! engine. Both skip service folders and whatever .gitignore lists.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use grep_matcher::Matcher;
use grep_regex::RegexMatcherBuilder;
use grep_searcher::sinks::UTF8;
use grep_searcher::{BinaryDetection, SearcherBuilder};
use ignore::WalkState;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::fs::project_walker;

/// Quick open lists at most this many files.
const MAX_FILES: usize = 200_000;
/// Text search stops after this many matches...
const MAX_HITS: usize = 5_000;
/// ...and shows at most this many per file.
const MAX_HITS_PER_FILE: usize = 200;
/// Bigger files are skipped: they are logs or data, not code.
const MAX_FILE_SIZE: u64 = 4 * 1024 * 1024;

#[derive(Default)]
pub struct SearchState {
    /// Bumped by every new search; a running search stops when it no longer matches.
    generation: Arc<AtomicU64>,
}

/// All files of the project, as paths relative to `root` with "/" separators.
#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(root);
        let mut out = Vec::new();
        for entry in project_walker(&root).build().filter_map(Result::ok) {
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if let Ok(rel) = entry.path().strip_prefix(&root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
                if out.len() >= MAX_FILES {
                    break;
                }
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct Hit {
    line: u64,
    /// Column of the match in UTF-16 units (what the editor counts in).
    col: usize,
    len: usize,
    /// The line, cut down around the match when it is long.
    pre: String,
    mat: String,
    post: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SearchEvent {
    File { path: String, rel: String, hits: Vec<Hit> },
    #[serde(rename_all = "camelCase")]
    Done { files: usize, hits: usize, truncated: bool },
    Error { message: String },
}

#[tauri::command]
pub fn search_text(
    state: State<'_, SearchState>,
    root: String,
    query: String,
    regex: bool,
    match_case: bool,
    on_event: Channel<SearchEvent>,
) {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    if query.is_empty() {
        return;
    }
    let matcher = match RegexMatcherBuilder::new()
        .case_insensitive(!match_case)
        .fixed_strings(!regex)
        .build(&query)
    {
        Ok(m) => m,
        Err(e) => {
            let msg = e.to_string();
            let short = msg.lines().last().unwrap_or(&msg).trim().to_string();
            let _ = on_event.send(SearchEvent::Error { message: short });
            return;
        }
    };
    let counter = state.generation.clone();

    std::thread::spawn(move || {
        let root = PathBuf::from(root);
        let hits_total = Arc::new(AtomicUsize::new(0));
        let files_total = Arc::new(AtomicUsize::new(0));
        let truncated = Arc::new(AtomicBool::new(false));

        project_walker(&root).build_parallel().run(|| {
            let matcher = matcher.clone();
            let root = root.clone();
            let on_event = on_event.clone();
            let hits_total = hits_total.clone();
            let files_total = files_total.clone();
            let truncated = truncated.clone();
            let counter = counter.clone();
            let stale = move || counter.load(Ordering::SeqCst) != generation;
            let mut searcher = SearcherBuilder::new()
                .binary_detection(BinaryDetection::quit(0))
                .line_number(true)
                .build();
            Box::new(move |entry| {
                if stale() {
                    return WalkState::Quit;
                }
                if hits_total.load(Ordering::Relaxed) >= MAX_HITS {
                    truncated.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else { return WalkState::Continue };
                if !entry.file_type().is_some_and(|t| t.is_file()) {
                    return WalkState::Continue;
                }
                if entry.metadata().map(|m| m.len() > MAX_FILE_SIZE).unwrap_or(true) {
                    return WalkState::Continue;
                }
                let mut hits = Vec::new();
                let _ = searcher.search_path(
                    &matcher,
                    entry.path(),
                    UTF8(|lnum, line| {
                        let line = line.trim_end_matches(['\r', '\n']);
                        if let Ok(Some(m)) = matcher.find(line.as_bytes()) {
                            hits.push(make_hit(lnum, line, m.start(), m.end()));
                        }
                        Ok(hits.len() < MAX_HITS_PER_FILE)
                    }),
                );
                if !hits.is_empty() && !stale() {
                    hits_total.fetch_add(hits.len(), Ordering::Relaxed);
                    files_total.fetch_add(1, Ordering::Relaxed);
                    let _ = on_event.send(SearchEvent::File {
                        path: entry.path().to_string_lossy().into_owned(),
                        rel: rel_path(&root, entry.path()),
                        hits,
                    });
                }
                WalkState::Continue
            })
        });
        if counter.load(Ordering::SeqCst) == generation {
            let _ = on_event.send(SearchEvent::Done {
                files: files_total.load(Ordering::Relaxed),
                hits: hits_total.load(Ordering::Relaxed),
                truncated: truncated.load(Ordering::Relaxed),
            });
        }
    });
}

/// Stops a running search (the panel was closed or the query cleared).
#[tauri::command]
pub fn search_cancel(state: State<'_, SearchState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

fn make_hit(lnum: u64, line: &str, start: usize, end: usize) -> Hit {
    const BEFORE: usize = 40;
    const TOTAL: usize = 220;
    let start = floor_char(line, start);
    let end = floor_char(line, end.max(start));
    let col = line[..start].encode_utf16().count();
    let len = line[start..end].encode_utf16().count();
    // Cut the line down around the match, at character boundaries.
    let mut from = 0;
    if line[..start].chars().count() > BEFORE {
        from = line[..start].char_indices().rev().nth(BEFORE - 1).map(|(i, _)| i).unwrap_or(0);
    }
    let mut to = line.len();
    let room = TOTAL.saturating_sub(line[from..end].chars().count());
    if line[end..].chars().count() > room {
        to = line[end..].char_indices().nth(room).map(|(i, _)| end + i).unwrap_or(line.len());
    }
    let mut pre = line[from..start].trim_start().to_string();
    if from > 0 {
        pre.insert(0, '…');
    }
    let mut post = line[end..to].to_string();
    if to < line.len() {
        post.push('…');
    }
    let mat: String = line[start..end].chars().take(TOTAL).collect();
    Hit { line: lnum, col, len, pre, mat, post }
}

fn floor_char(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}
