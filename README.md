# Tern

A fast, minimal terminal workspace for [Claude Code](https://docs.claude.com/en/docs/claude-code/overview).
File tree on the left, a big terminal in the middle, voice input and image paste on the way.

Tern is an independent project and is not affiliated with or endorsed by Anthropic.

## Status

Stage 2 of 8: lazy file tree, tabs (Claude or shell), activity dot and a soft chime when Claude
finishes, session restore (Claude tabs resume their conversation).

## Hotkeys (so far)

| Action | Keys |
| --- | --- |
| New Claude terminal | ``Ctrl+` `` |
| New shell terminal | `Ctrl+Shift+T` |
| Close tab | `Ctrl+W` or middle click |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Go to tab 1–8 / last | `Ctrl+1…8` / `Ctrl+9` |
| Toggle file tree | `Ctrl+B` |

## Build from source

Requirements: Rust (stable), Node.js 20+, and on Windows the Visual Studio C++ Build Tools.

```sh
npm install
npm run tauri dev     # run in development
npm run tauri build   # build the installer
```

## License

MIT. Bundled font: Commit Mono, SIL Open Font License (see `src/fonts/CommitMono-OFL.txt`).
