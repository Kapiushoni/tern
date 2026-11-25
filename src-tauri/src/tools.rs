//! "Open in IDE" and the ▶ run button: which IDEs are installed, and how a project is started.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

// ── IDEs ─────────────────────────────────────────────────

/// (id, display name, launcher names on PATH, folder-name prefix of a standalone install, exe)
const IDES: &[(&str, &str, &[&str], &str, &str)] = &[
    ("idea", "IntelliJ IDEA", &["idea64", "idea"], "IntelliJ IDEA", "idea64.exe"),
    ("pycharm", "PyCharm", &["pycharm64", "pycharm"], "PyCharm", "pycharm64.exe"),
    ("vscode", "VS Code", &["code"], "Microsoft VS Code", "Code.exe"),
];

#[derive(Serialize)]
pub struct Ide {
    id: &'static str,
    name: &'static str,
}

fn find_ide(id: &str) -> Option<PathBuf> {
    let &(_, _, launchers, folder, exe) = IDES.iter().find(|i| i.0 == id)?;
    // A launcher on PATH (JetBrains Toolbox scripts, VS Code's "code") is the most reliable.
    for name in launchers {
        if let Ok(p) = which::which(name) {
            return Some(p);
        }
    }
    #[cfg(windows)]
    {
        let mut bases = Vec::new();
        for var in ["ProgramFiles", "LOCALAPPDATA"] {
            if let Ok(v) = std::env::var(var) {
                bases.push(PathBuf::from(&v).join("JetBrains"));
                bases.push(PathBuf::from(&v).join("Programs"));
                bases.push(PathBuf::from(v));
            }
        }
        // Newest install first: folder names end in the version.
        for base in bases {
            let Ok(dir) = std::fs::read_dir(&base) else { continue };
            let mut found: Vec<PathBuf> = dir
                .filter_map(Result::ok)
                .filter(|e| e.file_name().to_string_lossy().starts_with(folder))
                .flat_map(|e| [e.path().join("bin").join(exe), e.path().join(exe)])
                .filter(|p| p.is_file())
                .collect();
            found.sort();
            if let Some(p) = found.pop() {
                return Some(p);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let app = match id {
            "idea" => "IntelliJ IDEA",
            "pycharm" => "PyCharm",
            _ => "Visual Studio Code",
        };
        for base in ["/Applications".to_string(), format!("{}/Applications", std::env::var("HOME").unwrap_or_default())] {
            for suffix in ["", " CE", " Community Edition", " Ultimate"] {
                let p = PathBuf::from(&base).join(format!("{app}{suffix}.app"));
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn ide_list() -> Vec<Ide> {
    tauri::async_runtime::spawn_blocking(|| {
        IDES.iter().filter(|i| find_ide(i.0).is_some()).map(|i| Ide { id: i.0, name: i.1 }).collect()
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn ide_open(id: String, path: String) -> Result<(), String> {
    let exe = tauri::async_runtime::spawn_blocking(move || find_ide(&id)).await.map_err(|e| e.to_string())?;
    let exe = exe.ok_or("not-found")?;
    let ext = exe.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut cmd = if cfg!(target_os = "macos") && ext == "app" {
        let mut c = Command::new("open");
        c.arg("-a").arg(&exe);
        c
    } else {
        // .cmd launchers too: Rust starts batch files itself and quotes their arguments safely.
        Command::new(&exe)
    };
    cmd.arg(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens a web link (from the terminal or Claude's answers) in the default browser.
/// Only http(s) and mailto: anything else could start a program.
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    let ok_scheme = lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:");
    if !ok_scheme || url.len() > 8192 || url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"') {
        return Err("bad-url".into());
    }
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler").arg(&url);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ── run ▶ ────────────────────────────────────────────────

#[derive(Serialize, Default)]
pub struct RunInfo {
    /// The shell command to run, if any.
    command: Option<String>,
    /// An HTML page to preview instead (a plain static site).
    preview: Option<String>,
    /// The command comes from .tern/run.json rather than detection.
    custom: bool,
    /// What the detected command is based on, for the tooltip.
    source: Option<String>,
    /// The folder the command runs in (a project inside the open folder, or the folder itself).
    dir: String,
}

#[derive(Serialize, Deserialize)]
struct RunFile {
    command: String,
}

fn run_file(root: &Path) -> PathBuf {
    root.join(".tern").join("run.json")
}

/// How to run the project. Looks in `from` (the selected file or folder) and each folder above it
/// up to `root`, so a project inside the open folder is found too.
#[tauri::command]
pub fn run_detect(root: String, from: Option<String>) -> RunInfo {
    let root = PathBuf::from(root);
    let mut dir = from.map(PathBuf::from).filter(|p| p.starts_with(&root)).unwrap_or_else(|| root.clone());
    if !dir.is_dir() {
        dir.pop();
    }
    loop {
        if let Some(info) = detect_in(&dir) {
            return info;
        }
        if dir == root || !dir.pop() || !dir.starts_with(&root) {
            break;
        }
    }
    RunInfo { dir: root.to_string_lossy().into_owned(), ..Default::default() }
}

/// When the open folder holds several projects rather than being one: each sub-folder that can
/// be run, for a pick list under ▶.
#[tauri::command]
pub async fn run_candidates(root: String) -> Vec<RunInfo> {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(rd) = std::fs::read_dir(&root) else { return Vec::new() };
        let mut dirs: Vec<PathBuf> = rd
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')))
            .collect();
        dirs.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_lowercase()));
        dirs.iter().filter_map(|d| detect_in(d)).collect()
    })
    .await
    .unwrap_or_default()
}

fn detect_in(dir: &Path) -> Option<RunInfo> {
    let dir_s = dir.to_string_lossy().into_owned();
    if let Some(rf) = std::fs::read_to_string(run_file(dir))
        .ok()
        .and_then(|t| serde_json::from_str::<RunFile>(&t).ok())
        .filter(|r| !r.command.trim().is_empty())
    {
        return Some(RunInfo {
            command: Some(rf.command),
            custom: true,
            source: Some(".tern/run.json".into()),
            dir: dir_s,
            ..Default::default()
        });
    }
    if let Some((command, source)) = detect(dir) {
        return Some(RunInfo { command: Some(command), source: Some(source), dir: dir_s, ..Default::default() });
    }
    if dir.join("index.html").is_file() {
        return Some(RunInfo {
            preview: Some(dir.join("index.html").to_string_lossy().into_owned()),
            source: Some("index.html".into()),
            dir: dir_s,
            ..Default::default()
        });
    }
    None
}

/// Files directly in `dir` with the given extension.
fn files_with_ext(dir: &Path, ext: &str) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case(ext)))
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

/// A lone Java file with a main method (no build tool): compiled into a temp folder, so the
/// project doesn't fill up with .class files. Works with any JDK, 8 included.
fn single_java(dir: &Path) -> Option<(String, String)> {
    let mains: Vec<(PathBuf, String)> = files_with_ext(dir, "java")
        .into_iter()
        .filter_map(|p| std::fs::read_to_string(&p).ok().map(|t| (p, t)))
        .filter(|(_, t)| t.contains("static void main") && !t.lines().any(|l| l.trim_start().starts_with("package ")))
        .collect();
    let (file, _) = mains
        .iter()
        .find(|(p, _)| p.file_stem().is_some_and(|s| s == "Main"))
        .or_else(|| mains.first())?;
    let name = file.file_name()?.to_string_lossy().into_owned();
    let class = file.file_stem()?.to_string_lossy().into_owned();
    let project = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "java".into());
    // The newest JDK installed, not whichever is first on PATH: code written today uses text
    // blocks, records and so on, which an old default JDK (often 8) can't compile.
    let jdk = newest_jdk();
    let bin = |tool: &str| match &jdk {
        Some((home, _)) => {
            let exe = home.join("bin").join(if cfg!(windows) { format!("{tool}.exe") } else { tool.to_string() });
            if cfg!(windows) { format!("& \"{}\"", exe.display()) } else { format!("'{}'", exe.display()) }
        }
        None => tool.to_string(),
    };
    let modern = jdk.as_ref().is_some_and(|(_, v)| *v >= 11);
    let cmd = if modern {
        // Java 11+ runs a source file directly: nothing compiled into the project.
        // Quoted: PowerShell would split -Dfile.encoding=UTF-8 at the dot.
        format!("{} \"-Dfile.encoding=UTF-8\" \"{name}\"", bin("java"))
    } else if cfg!(windows) {
        let out = format!("$env:TEMP\\tern-run\\{project}");
        // javac 8 does not create the -d folder itself.
        format!(
            "md -Force \"{out}\" > $null; {} -encoding UTF-8 -d \"{out}\" \"{name}\"; if ($?) {{ {} -cp \"{out}\" {class} }}",
            bin("javac"),
            bin("java")
        )
    } else {
        let out = format!("/tmp/tern-run/{project}");
        format!(
            "mkdir -p '{out}' && {} -encoding UTF-8 -d '{out}' '{name}' && {} -cp '{out}' {class}",
            bin("javac"),
            bin("java")
        )
    };
    Some((cmd, name))
}

/// C or C++ sources with a main() and no build system: all the sources of the folder are compiled
/// together into a temp folder, then run.
fn single_c(dir: &Path) -> Option<(String, String)> {
    let cpp: Vec<PathBuf> = ["cpp", "cc", "cxx"].iter().flat_map(|e| files_with_ext(dir, e)).collect();
    let c = files_with_ext(dir, "c");
    let has_main = |files: &[PathBuf]| {
        files.iter().find(|p| {
            std::fs::read_to_string(p).is_ok_and(|t| t.contains("main(") || t.contains("main ("))
        }).cloned()
    };
    let (sources, main, plus) = if let Some(m) = has_main(&cpp) {
        (cpp, m, true)
    } else if let Some(m) = has_main(&c) {
        (c, m, false)
    } else {
        return None;
    };
    let candidates: &[&str] = if plus { &["g++", "clang++"] } else { &["gcc", "clang"] };
    let compiler = candidates
        .iter()
        .find(|c| which::which(c).is_ok())
        .map(|c| c.to_string())
        .unwrap_or_else(|| candidates[0].to_string());
    let project = dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "c".into());
    let names: Vec<String> = sources.iter().filter_map(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).collect();
    let source = main.file_name()?.to_string_lossy().into_owned();
    let cmd = if cfg!(windows) {
        let out = format!("$env:TEMP\\tern-run\\{project}");
        let files = names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(" ");
        format!(
            "md -Force \"{out}\" > $null; {compiler} {files} -o \"{out}\\main.exe\"; if ($?) {{ & \"{out}\\main.exe\" }}"
        )
    } else {
        let out = format!("/tmp/tern-run/{project}");
        let files = names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(" ");
        format!("mkdir -p '{out}' && {compiler} {files} -o '{out}/main' && '{out}/main'")
    };
    Some((cmd, source))
}

/// The installed JDK with the highest major version: (home folder, major version).
fn newest_jdk() -> Option<(PathBuf, u32)> {
    let mut homes: Vec<PathBuf> = Vec::new();
    if let Ok(h) = std::env::var("JAVA_HOME") {
        homes.push(PathBuf::from(h));
    }
    if let Ok(java) = which::which("java") {
        if let Some(home) = std::fs::canonicalize(&java).unwrap_or(java).parent().and_then(|b| b.parent()) {
            homes.push(home.to_path_buf());
        }
    }
    let mut parents: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Ok(pf) = std::env::var(var) {
                for vendor in ["Java", "BellSoft", "Eclipse Adoptium", "Microsoft", "Zulu", "Amazon Corretto", "OpenJDK"] {
                    parents.push(PathBuf::from(&pf).join(vendor));
                }
            }
        }
    } else {
        parents.push("/Library/Java/JavaVirtualMachines".into());
        parents.push("/usr/lib/jvm".into());
    }
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        parents.push(PathBuf::from(home).join(".jdks")); // IntelliJ's downloads
    }
    for p in parents {
        if let Ok(rd) = std::fs::read_dir(&p) {
            for e in rd.filter_map(Result::ok) {
                homes.push(e.path());
                homes.push(e.path().join("Contents").join("Home")); // macOS bundles
            }
        }
    }
    homes
        .into_iter()
        .filter_map(|h| {
            let release = std::fs::read_to_string(h.join("release")).ok()?;
            let v = release.lines().find_map(|l| l.strip_prefix("JAVA_VERSION="))?.trim_matches('"').to_string();
            let mut parts = v.split(|c: char| !c.is_ascii_digit()).filter(|s| !s.is_empty());
            let first: u32 = parts.next()?.parse().ok()?;
            let major = if first == 1 { parts.next()?.parse().ok()? } else { first };
            h.join("bin").join(if cfg!(windows) { "javac.exe" } else { "javac" }).is_file().then_some((h, major))
        })
        .max_by_key(|(_, v)| *v)
}

fn detect(root: &Path) -> Option<(String, String)> {
    let has = |name: &str| root.join(name).is_file();
    if has("package.json") {
        let scripts = std::fs::read_to_string(root.join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("scripts").cloned());
        let has_script = |s: &str| scripts.as_ref().and_then(|v| v.get(s)).is_some();
        if has_script("dev") {
            return Some(("npm run dev".into(), "package.json".into()));
        }
        if has_script("start") {
            return Some(("npm start".into(), "package.json".into()));
        }
    }
    if has("pom.xml") {
        return Some(("mvn compile exec:java".into(), "pom.xml".into()));
    }
    for build in ["build.gradle", "build.gradle.kts"] {
        if has(build) {
            let text = std::fs::read_to_string(root.join(build)).unwrap_or_default();
            // Minecraft mod toolchains start the game with runClient.
            let modding = ["fabric-loom", "minecraftforge", "neoforge", "runClient"].iter().any(|k| text.contains(k));
            let task = if modding { "runClient" } else { "run" };
            let gradle = if cfg!(windows) && has("gradlew.bat") {
                ".\\gradlew.bat"
            } else if has("gradlew") {
                "./gradlew"
            } else {
                "gradle"
            };
            return Some((format!("{gradle} {task}"), build.into()));
        }
    }
    if has("Cargo.toml") {
        return Some(("cargo run".into(), "Cargo.toml".into()));
    }
    if has("go.mod") {
        return Some(("go run .".into(), "go.mod".into()));
    }
    let py = files_with_ext(root, "py");
    let lone_py = (py.len() == 1).then(|| py[0].file_name().unwrap().to_string_lossy().into_owned());
    for script in ["main.py", "bot.py", "app.py"].into_iter().map(String::from).chain(lone_py) {
        let script = script.as_str();
        if has(script) {
            let venv = [".venv", "venv"].into_iter().find(|v| root.join(v).is_dir());
            let python = match venv {
                Some(v) if cfg!(windows) => format!("{v}\\Scripts\\python"),
                Some(v) => format!("{v}/bin/python"),
                None if cfg!(windows) => "python".into(),
                None => "python3".into(),
            };
            return Some((format!("{python} {script}"), script.into()));
        }
    }
    if let Some(java) = single_java(root) {
        return Some(java);
    }
    if has("CMakeLists.txt") {
        let cmd = if cfg!(windows) {
            "cmake -S . -B build; if ($?) { cmake --build build }"
        } else {
            "cmake -S . -B build && cmake --build build"
        };
        return Some((cmd.into(), "CMakeLists.txt".into()));
    }
    if has("Makefile") || has("makefile") {
        let make = if which::which("make").is_err() && which::which("mingw32-make").is_ok() { "mingw32-make" } else { "make" };
        return Some((make.into(), "Makefile".into()));
    }
    if let Some(c) = single_c(root) {
        return Some(c);
    }
    for script in ["index.js", "main.js", "server.js", "app.js"] {
        if has(script) {
            return Some((format!("node {script}"), script.into()));
        }
    }
    None
}

/// Saves the project's own run command; an empty one goes back to detection.
#[tauri::command]
pub fn run_save(root: String, command: String) -> Result<(), String> {
    let file = run_file(Path::new(&root));
    if command.trim().is_empty() {
        let _ = std::fs::remove_file(&file);
        if let Some(dir) = file.parent() {
            let _ = std::fs::remove_dir(dir); // only if empty
        }
        return Ok(());
    }
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&RunFile { command: command.trim().to_string() }).unwrap();
    std::fs::write(file, json + "\n").map_err(|e| e.to_string())
}

