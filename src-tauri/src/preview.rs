//! HTML preview: a tiny local web server for one folder, so a page inside Tern loads its CSS,
//! scripts and pictures by relative or root paths just as it would from a real site.
//! It listens on 127.0.0.1 only, on a random port, and serves nothing outside that folder.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::State;
use tiny_http::{Header, Response, Server};

struct Running {
    root: PathBuf,
    port: u16,
    server: Arc<Server>,
}

#[derive(Default)]
pub struct PreviewState {
    running: Mutex<Option<Running>>,
}

/// The preview address of `file`, served from `root` (the project folder, or the file's own).
#[tauri::command]
pub fn preview_url(state: State<'_, PreviewState>, root: String, file: String) -> Result<String, String> {
    let root = PathBuf::from(root);
    let file = PathBuf::from(file);
    let rel = file.strip_prefix(&root).map_err(|_| "outside-root".to_string())?.to_path_buf();
    let mut running = state.running.lock().unwrap();
    if running.as_ref().map(|r| r.root != root).unwrap_or(true) {
        if let Some(old) = running.take() {
            old.server.unblock();
        }
        *running = Some(start(root)?);
    }
    let port = running.as_ref().unwrap().port;
    let path: Vec<String> = rel.components().map(|c| encode(&c.as_os_str().to_string_lossy())).collect();
    Ok(format!("http://127.0.0.1:{port}/{}", path.join("/")))
}

fn start(root: PathBuf) -> Result<Running, String> {
    let server = Arc::new(Server::http("127.0.0.1:0").map_err(|e| e.to_string())?);
    let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("no port")?;
    let srv = server.clone();
    let base = root.clone();
    std::thread::spawn(move || {
        let hosts = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
        for req in srv.incoming_requests() {
            // Only answer requests addressed to this server by IP (guards against DNS rebinding).
            let host_ok = req
                .headers()
                .iter()
                .any(|h| h.field.equiv("Host") && hosts.iter().any(|x| h.value.as_str() == x));
            let resp = if host_ok { serve(&base, req.url()) } else { None };
            let _ = match resp {
                Some((bytes, mime)) => req.respond(
                    Response::from_data(bytes)
                        .with_header(header("Content-Type", mime))
                        .with_header(header("Cache-Control", "no-store")),
                ),
                None => req.respond(Response::from_string("Not found").with_status_code(404)),
            };
        }
    });
    Ok(Running { root, port, server })
}

fn serve(root: &Path, url: &str) -> Option<(Vec<u8>, &'static str)> {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let rel = decode(path.trim_start_matches('/'))?;
    let rel = PathBuf::from(rel);
    // Plain names only: no "..", no drive letters, no absolute paths.
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    let mut full = root.join(&rel);
    if full.is_dir() {
        full = full.join("index.html");
    }
    let bytes = std::fs::read(&full).ok()?;
    Some((bytes, mime(&full)))
}

fn mime(p: &Path) -> &'static str {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
