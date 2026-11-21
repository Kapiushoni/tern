# Tern

A fast, minimal terminal workspace for [Claude Code](https://docs.claude.com/en/docs/claude-code/overview).
A file tree on the left, a real terminal running `claude` in the middle — plus voice input, image
paste, a light editor and project search around it. No chat window: Claude Code itself, in a
terminal that makes it pleasant to use.

Tern is an independent project and is not affiliated with or endorsed by Anthropic.

## Features

- **Terminal tabs** — each tab is a Claude Code session (or a plain shell) in its own folder.
  A dot on the tab pulses while Claude works; a soft chime when it's done. Tabs, folders and
  conversations come back when you reopen Tern.
- **Files and images** — paste a screenshot with `Ctrl+V`, drop files from Explorer or the tree,
  or click `+`. Hover `[Image #N]` or any path in the terminal for a preview.
- **Voice input** — `Alt+Z`, speak, `Alt+Z` again: the text lands in Claude's input line, not
  sent. Recognised offline on your computer by [whisper.cpp](https://github.com/ggml-org/whisper.cpp).
- **Editor** — view and edit files with syntax highlighting, find and replace, Markdown and HTML
  preview. Follows changes Claude makes on disk.
- **File tree** — git status colours, create / rename / delete (to the Recycle Bin), drag to move,
  "Ask Claude about this file".
- **Search** — `Ctrl+P` finds a file by name (fuzzy), `Ctrl+Shift+F` searches the text of every
  file (ripgrep's engine; `.gitignore` respected).
- **Run ▶** — guesses how to start the project (npm, Gradle, Maven, Cargo, Python, a lone Java
  file…) and runs it in a new tab. **Open in IDE** — IntelliJ IDEA, PyCharm or VS Code.
- **Looks** — dark and light themes, any accent colour, neon glow, CRT lines; English, Русский,
  Українська.

## Install

Download the installer for your system from [Releases](https://github.com/Kapiushoni/tern/releases/latest):

| System | File |
| --- | --- |
| Windows 10 / 11 | `Tern_x.y.z_x64-setup.exe` (about 4 MB) |
| macOS | `Tern_x.y.z_aarch64.dmg` (Apple Silicon) or `Tern_x.y.z_x64.dmg` (Intel) |
| Linux | `.AppImage` or `.deb` |

Tern updates itself: when a new version is out, it offers to install it.

The installers are not code-signed yet. On Windows, SmartScreen may say "Windows protected your
PC" — click **More info → Run anyway**. On macOS, right-click the app and choose **Open** the
first time.

Tern needs [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) to talk to Claude;
if it isn't installed, Tern offers to install it. Without it, Tern still works as a file browser,
editor and terminal.

**Voice input** needs a speech model (466 MB, downloaded once): tick "Voice input" in the
installer, or right-click the mic button in Tern.

## Keys

All of them can be changed in `settings.json`. On macOS, `Ctrl` is `Cmd`.

| Action | Keys |
| --- | --- |
| Voice input: start / stop | `Alt+Z` (`Esc` discards) |
| New Claude tab | ``Ctrl+` `` |
| New shell tab | `Ctrl+Shift+T` |
| Close tab (or the open file) | `Ctrl+W` |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Go to tab 1–9 | `Ctrl+1…9` |
| Show / hide the file tree | `Ctrl+B` |
| Go to file | `Ctrl+P` |
| Search in files | `Ctrl+Shift+F` |
| Attach files | `Ctrl+Shift+A` |
| Settings | `Ctrl+,` |

## Settings

`Ctrl+,` opens a short settings page. Everything else — exact colours, keys, the path and
arguments of `claude`, the shell, hidden folders, how long pasted pictures are kept — lives in
`settings.json` ("Open as JSON" in the settings page). Edits apply as soon as the file is saved.

## Build from source

Requirements:

- [Rust](https://rustup.rs) (stable) and Node.js 20+
- CMake (whisper.cpp is built from source)
- Clang / LLVM (for the whisper.cpp bindings): `winget install LLVM.LLVM` on Windows
- Windows: Visual Studio Build Tools with "Desktop development with C++"
- Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libasound2-dev`

```sh
npm install
npm run tauri dev     # run in development
npm run tauri build   # build the installer
```

On Windows, release builds need two environment variables (set them in `src-tauri/.cargo/config.toml`
under `[env]`, or in your shell):

- `CMAKE_C_FLAGS_RELEASE = "/O2 /Ob2 /DNDEBUG"` and `CMAKE_CXX_FLAGS_RELEASE = "/O2 /Ob2 /DNDEBUG /utf-8"`
  — without them whisper.cpp is built unoptimised and voice input is about ten times slower.
- If bindgen can't find the C headers: `BINDGEN_EXTRA_CLANG_ARGS` with `-I` paths to clang's,
  MSVC's and the Windows SDK's include folders (or build from a "Developer Command Prompt").

## License

MIT. Bundled font: Commit Mono (SIL Open Font License); file icons: [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) (MIT). See `THIRD-PARTY-NOTICES.md`.
