//! Installed font families, for the font picker in settings (the UI keeps the monospaced ones).

use std::collections::BTreeSet;

/// Style words that end a font's registered name ("Consolas Bold", "Cascadia Code SemiLight").
const STYLES: &[&str] = &[
    "regular", "bold", "italic", "oblique", "light", "extralight", "ultralight", "semilight", "demilight",
    "medium", "semibold", "demibold", "extrabold", "ultrabold", "black", "heavy", "thin", "book", "normal",
    "condensed", "semicondensed", "extracondensed", "narrow", "wide", "extended", "retina", "nerd", "font",
];

/// "Cascadia Code SemiBold Italic" → "Cascadia Code".
fn family(name: &str) -> String {
    let mut words: Vec<&str> = name.split_whitespace().collect();
    while words.len() > 1 && STYLES.contains(&words[words.len() - 1].to_lowercase().as_str()) {
        words.pop();
    }
    words.join(" ")
}

#[tauri::command]
pub async fn system_fonts() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(list).await.unwrap_or_default()
}

fn list() -> Vec<String> {
    let mut out = BTreeSet::new();
    for raw in raw_names() {
        // Registry values look like "Consolas Bold (TrueType)" or "A Regular & A Bold (TrueType)".
        let raw = raw.split(" (").next().unwrap_or(&raw).to_string();
        for part in raw.split(" & ") {
            let f = family(part.trim());
            if !f.is_empty() && !f.starts_with('@') {
                out.insert(f);
            }
        }
    }
    out.into_iter().collect()
}

#[cfg(windows)]
fn raw_names() -> Vec<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;
    let mut names = Vec::new();
    // Fonts for all users, and the ones installed for this user only.
    for (hive, path) in [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
        (HKEY_CURRENT_USER, r"Software\Microsoft\Windows NT\CurrentVersion\Fonts"),
    ] {
        if let Ok(key) = RegKey::predef(hive).open_subkey(path) {
            names.extend(key.enum_values().flatten().map(|(name, _)| name));
        }
    }
    names
}

#[cfg(target_os = "linux")]
fn raw_names() -> Vec<String> {
    // fontconfig knows exactly which families are monospaced.
    std::process::Command::new("fc-list")
        .args([":spacing=mono", "family"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.split(',').next().map(|s| s.trim().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn raw_names() -> Vec<String> {
    // Font file names are close enough to family names ("JetBrainsMono-Regular.ttf").
    let mut names = Vec::new();
    let home = std::env::var("HOME").unwrap_or_default();
    for dir in ["/System/Library/Fonts".to_string(), "/Library/Fonts".to_string(), format!("{home}/Library/Fonts")] {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            let stem = n.rsplit_once('.').map(|(s, _)| s).unwrap_or(&n);
            let base = stem.split('-').next().unwrap_or(stem);
            // "JetBrainsMono" → "JetBrains Mono"
            let mut spaced = String::new();
            let mut prev_lower = false;
            for ch in base.chars() {
                if ch.is_uppercase() && prev_lower {
                    spaced.push(' ');
                }
                prev_lower = ch.is_lowercase();
                spaced.push(ch);
            }
            names.push(spaced);
            names.push(base.to_string());
        }
    }
    names
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn raw_names() -> Vec<String> {
    Vec::new()
}

