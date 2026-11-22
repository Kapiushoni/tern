import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";
import { FileTree } from "./tree";
import { setTerminalOptions, setTerminalTheme, TermKind } from "./terminal";
import { Tabs, SavedTab } from "./tabs";
import { Attachments } from "./attach";
import { Editor } from "./editor";
import { Voice } from "./voice";
import { QuickOpen } from "./quickopen";
import { Search } from "./search";
import { ProjectTools } from "./projecttools";
import { Action, matches, Settings, SettingsStore, showCombo } from "./settings";
import { SettingsWindow } from "./settingsui";
import { setLang, t, tt } from "./i18n";
import { InstallScreen, showSplash, StartScreen } from "./screens";
import { setSound } from "./sound";
import { setTypewriter, toast } from "./toast";
import { startUpdateChecks } from "./updates";
import { repaintIcons } from "./fileicons";
import { PluginHost } from "./plugins";
import { PluginsWindow } from "./pluginsui";

const app = document.getElementById("app")!;
const root = document.documentElement;
const termHost = document.getElementById("terminal-host")!;
const panes = document.getElementById("panes")!;
const rootName = document.getElementById("root-name")!;
const btnHidden = document.getElementById("btn-hidden")!;
const btnOpen = document.getElementById("btn-open")!;
const btnNew = document.getElementById("btn-new")!;
const newMenu = document.getElementById("new-menu")!;
const splitter = document.getElementById("splitter")!;
const editorSplit = document.getElementById("editor-split")!;
const center = document.getElementById("center")!;
const btnTheme = document.getElementById("btn-theme")!;

const store = new SettingsStore();
const tree = new FileTree(document.getElementById("tree")!);
const tabs = new Tabs(document.getElementById("tabs")!, panes);
const attachments = new Attachments(termHost, panes, tabs);
const editor = new Editor(document.getElementById("editor")!);
const voice = new Voice(tabs, attachments.tools, termHost);
const quickOpen = new QuickOpen();
const search = new Search(document.getElementById("search-view")!);
const projectTools = new ProjectTools(tabs, document.getElementById("btn-run")!);
const settingsWindow = new SettingsWindow(store);
const startScreen = new StartScreen(panes);
const installScreen = new InstallScreen(termHost);
const plugins = new PluginHost(document.getElementById("btn-tile")!);
const pluginsWindow = new PluginsWindow(plugins);

const projectRoot = () => tree.root || null;
quickOpen.getRoot = projectRoot;
quickOpen.onOpen = (path) => editor.open(path);
quickOpen.onAskClaude = (path) => tabs.askClaude(path);
search.getRoot = projectRoot;
search.onOpen = (path, at) => editor.open(path, { at, focus: false });
search.onToggle = (open) => {
  document.getElementById("sidebar")!.classList.toggle("searching", open);
  if (open) toggleSidebar(true);
  else tabs.activeSession?.focus();
};
projectTools.getRoot = projectRoot;
projectTools.getFrom = () => tree.selected ?? editor.path;
projectTools.showMenu = (items, x, y) => tree.showMenu(items, x, y);
projectTools.openPreview = (path) => editor.open(path, { preview: true });
tree.onOpenInIde = (path) => projectTools.openIde(path);
// An HTML preview serves the project folder, so links like "/css/site.css" work.
editor.previewRoot = (path) => {
  const r = tree.root.replace(/[\\/]+$/, "");
  const lower = path.toLowerCase();
  if (r && (lower.startsWith(r.toLowerCase() + "\\") || lower.startsWith(r.toLowerCase() + "/"))) return r;
  return path.replace(/[\\/][^\\/]*$/, "");
};
document.getElementById("btn-search")!.addEventListener("click", () => search.open());
document.getElementById("btn-settings")!.addEventListener("click", () => settingsWindow.open());
tree.onDragOut = (paths, target) => {
  // The open file first: in window mode it sits inside the terminal area.
  if (target?.closest("#editor")) editor.open(paths[0]);
  else if (target?.closest("#terminal-host")) tabs.attach(paths);
};
tree.onOpen = (path) => editor.open(path);
tree.onAskClaude = (paths) => tabs.askClaude(paths);
attachments.onOpenFile = (path) => editor.open(path);
// Files dragged from Explorer onto the tree are copied into the project.
attachments.onExternalDrop = (paths, target, drop) => tree.externalDrag(paths, target, drop);
let home = "";

/** The session (what is open, and where); settings live in settings.json. */
interface Saved {
  version: 1;
  tabs: SavedTab[];
  active: number;
  sidebarW?: number;
  sidebarHidden?: boolean;
  /** The file open in the editor panel, and the panel's share of the height in %. */
  editorFile?: string;
  editorH?: number;
  /** Project folders, most recent first, for the start screen. */
  recent?: string[];
  /** All tabs shown as tiles. */
  tiled?: boolean;
  // Older versions kept these here; they seed settings.json once.
  theme?: "dark" | "light";
  voice?: { model?: string; mic?: string; lang?: string };
  ide?: string;
}

function baseName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

let recent: string[] = [];
function noteRecent(dir: string) {
  recent = [dir, ...recent.filter((d) => d.toLowerCase() !== dir.toLowerCase())].slice(0, 8);
}

// ── session save (debounced) ─────────────────────────────
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const css = getComputedStyle(root);
    const w = parseInt(css.getPropertyValue("--sidebar-w"));
    const eh = parseFloat(css.getPropertyValue("--editor-h"));
    const data: Saved = {
      version: 1,
      ...tabs.saved(),
      sidebarW: Number.isFinite(w) ? w : undefined,
      sidebarHidden: app.classList.contains("no-sidebar"),
      editorFile: editor.path ?? undefined,
      editorH: Number.isFinite(eh) ? eh : undefined,
      recent,
      tiled: tabs.isTiled || undefined,
    };
    invoke("session_save", { json: JSON.stringify(data) }).catch(() => {});
  }, 300);
}
tabs.onChange = save;
voice.onChange = () =>
  store.update((s) => {
    s.voice = { model: voice.settings.model, microphone: voice.settings.mic ?? null, language: voice.settings.lang ?? null };
  });
projectTools.onChange = () => store.update((s) => (s.ide = projectTools.ide ?? null));

// ── watching the disk: tree, git colours, the open file and settings.json ──
let watchKey = "";
function updateWatch() {
  const roots = tree.root ? [tree.root] : [];
  const files = [editor.path, store.path].filter((p): p is string => !!p);
  const key = JSON.stringify([roots, files]);
  if (key === watchKey) return;
  watchKey = key;
  invoke("watch_set", { roots, files }).catch(() => {});
}
tree.onRoot = (root) => {
  queueMicrotask(updateWatch);
  plugins.emit("project:change", { project: root });
};
let shownFile: string | null = null;
editor.onChange = () => {
  save();
  updateWatch();
  if (tabs.isTiled) {
    // A file just opened comes to the front as its own window.
    if (editor.path && editor.path !== shownFile) tabs.focusExtra("editor");
    else tabs.refreshWindows();
  }
  if (editor.path && editor.path !== shownFile) plugins.emit("file:open", { path: editor.path, project: tree.root || null });
  shownFile = editor.path;
};
listen<{ paths: string[]; git: boolean }>("fs-change", (e) => {
  const paths = e.payload.paths;
  if (store.path && paths.some((p) => p.toLowerCase() === store.path.toLowerCase())) store.reload();
  tree.onDiskChange(paths, e.payload.git);
  quickOpen.invalidate();
  editor.onDiskChange(paths);
});

// ── settings → every part of the app ─────────────────────
/** CSS variables set from settings (accent, colour overrides), so stale ones can be removed. */
let styled: string[] = [];

function hexAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function applyLook(s: Settings) {
  if (s.theme === "light") root.dataset.theme = "light";
  else delete root.dataset.theme;
  for (const name of styled) root.style.removeProperty(name);
  styled = [];
  const setVar = (name: string, value: string) => {
    root.style.setProperty(name, value);
    styled.push(name);
  };
  const light = s.theme === "light";
  // The light theme keeps the default accent a little darker, for contrast on white.
  const accent = s.accent.toLowerCase() === "#ff2e88" && light ? "#d6006e" : s.accent;
  setVar("--accent", accent);
  setVar("--accent-soft", hexAlpha(accent, light ? 0.1 : 0.14));
  // Glow off = an invisible shadow, so every rule using --glow simply loses it.
  setVar("--glow", s.effects.glow ? `0 0 6px ${hexAlpha(accent, light ? 0.35 : 0.55)}` : "0 0 0 transparent");
  // Theme plugins first, then the user's own colours from settings.json.
  for (const [k, v] of Object.entries(plugins.themeVars(s.theme))) setVar(`--${k.replace(/^--/, "")}`, v);
  for (const [k, v] of Object.entries(s.colors[s.theme])) setVar(`--${k.replace(/^--/, "")}`, v);
  setVar("--mono", `"${s.font.family.replace(/"/g, "")}", "Commit Mono", "Cascadia Mono", Consolas, ui-monospace, monospace`);
  setVar("--term-pad", `${s.terminal.padding}px`);
  root.classList.toggle("fx-glow", s.effects.glow);
  root.classList.toggle("fx-crt", s.effects.crt);
  setTerminalTheme(s.theme, accent, plugins.terminalColors(s.theme));
  setTerminalOptions({ font: s.font.family, size: s.font.size, scrollback: s.terminal.scrollback, gpu: s.terminal.gpu });
  getCurrentWindow().setTheme(s.theme).catch(() => {});
  tt(btnTheme, light ? "Dark theme" : "Light theme");
  repaintIcons(document.getElementById("tree")!);
}

let keys: Settings["keys"] = store.value.keys;

store.onError = (msg) => toast(t("settings.json has an error: {error}", { error: msg }), 6000);
store.onApply = (s, before) => {
  setLang(s.language);
  applyLook(s);
  setSound(s.sound.enabled, s.sound.volume);
  setTypewriter(s.effects.typewriter);
  voice.settings = { model: s.voice.model, mic: s.voice.microphone ?? undefined, lang: s.voice.language ?? undefined };
  voice.key = s.keys.voice;
  projectTools.ide = s.ide ?? undefined;
  tabs.setLayout(s.windows.layout);
  keys = s.keys;
  invoke("settings_runtime", {
    runtime: {
      claudePath: s.claude.path,
      claudeArgs: s.claude.args,
      shell: s.terminal.shell,
      hiddenFolders: s.tree.hiddenFolders,
      imagesKeepDays: s.images.keepDays,
    },
  }).catch(() => {});
  if (JSON.stringify(s.tree.hiddenFolders) !== JSON.stringify(before.tree.hiddenFolders)) {
    tree.refreshSoon();
    quickOpen.invalidate();
  }
  if (tabs.count === 0 && home) showStart();
  settingsWindow.refresh();
  updateWatch();
};

btnTheme.addEventListener("click", () => store.update((s) => (s.theme = s.theme === "light" ? "dark" : "light")));

settingsWindow.onOpenJson = () => editor.open(store.path);
settingsWindow.onVoiceModels = () => voice.openPop();
settingsWindow.onInstallClaude = () => installClaude();
settingsWindow.onPlugins = () => pluginsWindow.open();
settingsWindow.pluginCount = () => ({
  installed: plugins.plugins.length,
  on: plugins.plugins.filter((p) => plugins.canRun(p)).length,
});

// ── plugins ──────────────────────────────────────────────
plugins.getProject = () => tree.root || null;
plugins.sendToTerminal = (text) => {
  const s = tabs.activeSession;
  if (!s) throw new Error("no terminal tab is open");
  s.paste(text);
  s.focus();
};
// Voice input from inside a plugin window (Alt+Z, Esc).
plugins.onHotkey = (e) => voice.handleKey(e);
plugins.onChange = () => {
  applyLook(store.value);
  pluginsWindow.refresh();
};
tabs.onEvent = (name, data) => plugins.emit(name, data);
editor.onSaved = (path) => plugins.emit("file:save", { path, project: tree.root || null });
tree.extraMenuItems = (path) => plugins.menuItems(path);

// ── voice input goes wherever you're typing ──────────────
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  el.focus();
  el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
voice.resolveTarget = () => {
  const el = document.activeElement as HTMLElement | null;
  // A plugin's window (its own field gets the text).
  if (el instanceof HTMLIFrameElement && el.closest(".plugin-window")) return { insert: (t) => plugins.insertInto(el, t) };
  // The open file.
  if (el?.closest(".cm-editor")) return { insert: (t) => editor.insertText(t) };
  // Any text field: search, quick open, settings, a run command…
  const textField =
    (el instanceof HTMLInputElement && /^(text|search|url|email|number|)$/.test(el.type)) || el instanceof HTMLTextAreaElement;
  if (textField && !el.classList.contains("xterm-helper-textarea")) {
    const field = el as HTMLInputElement | HTMLTextAreaElement;
    return { insert: (t) => typeInto(field, t) };
  }
  // A terminal: the one with the focus (window mode), else the active tab.
  const s = tabs.sessionFor(el) ?? tabs.activeSession;
  return s
    ? {
        insert: (t) => {
          s.paste(t);
          s.focus();
        },
      }
    : null;
};

// ── title bar: Tern draws its own (tabs share the row with the window buttons) ──
const appWindow = getCurrentWindow();
const isMac = navigator.platform.toLowerCase().includes("mac");
// macOS keeps its own traffic-light buttons, drawn over the left end of the tab row.
root.classList.toggle("mac", isMac);
const btnMax = document.querySelector<HTMLElement>('[data-wc="max"]')!;
async function syncMaximized() {
  const max = await appWindow.isMaximized().catch(() => false);
  root.classList.toggle("maximized", max);
  tt(btnMax, max ? "Restore" : "Maximize");
}
document.getElementById("win-controls")!.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-wc]");
  if (!b) return;
  if (b.dataset.wc === "min") appWindow.minimize();
  else if (b.dataset.wc === "max") appWindow.toggleMaximize();
  else appWindow.close();
});
appWindow.onResized(() => syncMaximized());
syncMaximized();

// ── tiling mode ──────────────────────────────────────────
const btnTile = document.getElementById("btn-tile")!;
const editorEl = document.getElementById("editor")!;
const editorHead = editorEl.querySelector<HTMLElement>(".ed-head")!;
// In window mode the open file is a window too, with the editor's own header as its title bar.
tabs.addWindow("editor", {
  tile: () =>
    editor.isOpen
      ? { key: "editor", pane: editorEl, kind: "file", label: baseName(editor.path!), active: false, head: editorHead, headHome: editorEl, flush: true }
      : null,
  focus: () => editor.focus(),
  close: () => editor.close(),
});
editorEl.addEventListener("pointerdown", () => tabs.isTiled && tabs.focusExtra("editor"), true);

// The settings are a window too, in window mode.
panes.append(settingsWindow.pane);
settingsWindow.asWindow = () => tabs.isTiled;
settingsWindow.onWindow = (open) => (open ? tabs.focusExtra("settings") : tabs.refreshWindows());
tabs.addWindow("settings", {
  tile: () =>
    settingsWindow.isWindow
      ? {
          key: "settings",
          pane: settingsWindow.pane,
          kind: "settings",
          label: "Tern",
          active: false,
          head: settingsWindow.head,
          headHome: settingsWindow.pane,
          bar: 41,
          flush: true,
          size: [660, 640],
        }
      : null,
  focus: () => settingsWindow.pane.querySelector<HTMLElement>(".st-panel")?.focus(),
  close: () => settingsWindow.close(),
});
settingsWindow.pane.addEventListener("pointerdown", () => tabs.isTiled && tabs.focusExtra("settings"), true);

function toggleTiling(on = !tabs.isTiled) {
  if (on) {
    panes.append(editorEl);
    app.classList.add("windows");
  }
  // Settings open as a window close with window mode (they reopen as the usual dialog).
  if (!on && settingsWindow.isWindow) settingsWindow.close();
  tabs.setTiled(on);
  if (!on) {
    center.insertBefore(editorEl, editorSplit);
    editorEl.style.cssText = "";
    app.classList.remove("windows");
  }
  btnTile.setAttribute("aria-pressed", String(on));
}
btnTile.addEventListener("click", () => toggleTiling());

// ── start screen and Claude Code install ─────────────────
function showStart() {
  startScreen.show(recent, store.value.effects.asciiLogo, keys, store.value.wallpaper);
}
startScreen.onOpen = (dir) => tabs.open("claude", dir);
startScreen.onPickFolder = async () => {
  const picked = await open({ directory: true, defaultPath: home });
  if (typeof picked === "string") await tabs.open("claude", picked);
};

async function installClaude() {
  const cmd = await invoke<string>("claude_install_command");
  await tabs.open("shell", currentDir() || home, { run: cmd, label: "Claude Code ⇣" });
}
installScreen.onInstall = installClaude;
installScreen.onNever = () => store.update((s) => (s.claude.installPrompt = false));

// ── tree follows the active tab ──────────────────────────
tabs.onActivate = (cwd) => {
  if (cwd === null) {
    showStart();
    return;
  }
  startScreen.hide();
  noteRecent(cwd);
  rootName.textContent = baseName(cwd);
  rootName.title = cwd;
  tree.open(cwd);
  search.rootChanged();
};

const currentDir = () => tabs.activeCwd ?? tree.root ?? home;
const newTab = (kind: TermKind) => tabs.open(kind, currentDir() || home);

// ── buttons ──────────────────────────────────────────────
const btnSidebar = document.getElementById("btn-sidebar")!;
/** Shows or hides the whole file tree (the button left of the tabs, × in the tree, Ctrl+B). */
function toggleSidebar(show = app.classList.contains("no-sidebar")) {
  app.classList.toggle("no-sidebar", !show);
  btnSidebar.setAttribute("aria-pressed", String(show));
  save();
}
btnSidebar.addEventListener("click", () => toggleSidebar());
document.getElementById("btn-tree-close")!.addEventListener("click", () => toggleSidebar(false));

btnHidden.addEventListener("click", async () => {
  const on = btnHidden.getAttribute("aria-pressed") !== "true";
  btnHidden.setAttribute("aria-pressed", String(on));
  tt(btnHidden, on ? "Hide hidden files" : "Show hidden files");
  await tree.setShowHidden(on);
});

btnOpen.addEventListener("click", async () => {
  const picked = await open({ directory: true, defaultPath: currentDir() });
  if (typeof picked === "string") await tabs.open("claude", picked);
});

function toggleMenu(show = newMenu.hidden) {
  newMenu.hidden = !show;
  btnNew.setAttribute("aria-expanded", String(show));
  if (show) {
    const kbds = newMenu.querySelectorAll("kbd");
    kbds[0].textContent = showCombo(keys.newClaude);
    kbds[1].textContent = showCombo(keys.newShell);
    const r = btnNew.getBoundingClientRect();
    newMenu.style.left = `${Math.min(r.left, window.innerWidth - newMenu.offsetWidth - 8)}px`;
    newMenu.querySelector<HTMLElement>("button")?.focus();
  }
}
btnNew.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu();
});
newMenu.addEventListener("click", (e) => {
  const item = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]");
  if (!item) return;
  toggleMenu(false);
  newTab(item.dataset.kind as TermKind);
});
document.addEventListener("click", (e) => {
  if (!newMenu.hidden && !newMenu.contains(e.target as Node)) toggleMenu(false);
});

// ── splitters ────────────────────────────────────────────
/**
 * Dragging a splitter shows only a thin line where it will land; the layout changes once, on
 * release. Resizing live made the terminal blink on every frame.
 */
function dragSplitter(
  el: HTMLElement,
  axis: "x" | "y",
  clamp: (pos: number) => number,
  apply: (pos: number) => void,
) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const line = document.createElement("div");
    line.className = `split-line ${axis}`;
    document.body.append(line);
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
    let pos = clamp(axis === "x" ? e.clientX : e.clientY);
    const show = () => (line.style.transform = axis === "x" ? `translateX(${pos}px)` : `translateY(${pos}px)`);
    const r = center.getBoundingClientRect();
    if (axis === "y") {
      line.style.left = `${r.left}px`;
      line.style.width = `${r.width}px`;
    }
    show();
    const move = (ev: PointerEvent) => {
      pos = clamp(axis === "x" ? ev.clientX : ev.clientY);
      show();
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      line.remove();
      document.body.classList.remove("resizing-x", "resizing-y");
      if (ev.type === "pointerup") {
        apply(pos);
        save();
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
}

dragSplitter(
  splitter,
  "x",
  (x) => Math.min(Math.max(x, 160), window.innerWidth * 0.5),
  (x) => root.style.setProperty("--sidebar-w", `${x}px`),
);

dragSplitter(
  editorSplit,
  "y",
  (y) => {
    const r = center.getBoundingClientRect();
    return Math.min(Math.max(y, r.top + r.height * 0.15), r.top + r.height * 0.85);
  },
  (y) => {
    // Kept as a percentage of the column, so it fits any window size.
    const r = center.getBoundingClientRect();
    root.style.setProperty("--editor-h", `${(((y - r.top) / r.height) * 100).toFixed(1)}%`);
  },
);

// ── hotkeys (from settings; physical key positions, so any keyboard layout works) ─
const actions: Record<Exclude<Action, "voice">, () => void> = {
  toggleTree: () => toggleSidebar(),
  newClaude: () => newTab("claude"),
  newShell: () => newTab("shell"),
  attach: () => attachments.pick(),
  goToFile: () => (quickOpen.isOpen ? quickOpen.close() : quickOpen.open()),
  searchFiles: () => search.open(),
  settings: () => (settingsWindow.isOpen ? settingsWindow.close() : settingsWindow.open()),
  toggleTiling: () => toggleTiling(),
  closeTab: () => {
    // In the editor, closing means the file rather than the terminal tab.
    if (editor.isOpen && document.activeElement?.closest("#editor")) editor.close();
    else tabs.close();
  },
  nextTab: () => tabs.cycle(1),
  prevTab: () => tabs.cycle(-1),
};

window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape" && !newMenu.hidden) return toggleMenu(false);
    let handled = plugins.handleKey(e, matches);
    if (!handled) for (const [action, run] of Object.entries(actions)) {
      if (matches(e, keys[action as Action])) {
        run();
        handled = true;
        break;
      }
    }
    // Ctrl+1…9 picks a tab.
    const mod = e.ctrlKey || e.metaKey;
    if (!handled && mod && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) {
      tabs.pick(Number(e.code.slice(5)));
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  { capture: true },
);

// ── start: settings first, then restore the last session ─
(async () => {
  const [, dirs, raw] = await Promise.all([
    document.fonts.load('14px "Commit Mono"').catch(() => {}),
    invoke<{ cli: string | null; home: string }>("initial_dir"),
    invoke<string | null>("session_load").catch(() => null),
  ]);
  let saved: Saved | null = null;
  try {
    saved = raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    saved = null;
  }
  recent = saved?.recent ?? [];

  // Settings before any terminal exists, so they all start in the right colours and font.
  // A first settings.json takes over what older versions kept in the session.
  await store.load({
    theme: saved?.theme,
    ide: saved?.ide ?? null,
    voice: saved?.voice?.model
      ? { model: saved.voice.model, microphone: saved.voice.mic ?? null, language: saved.voice.lang ?? null }
      : undefined,
  } as Partial<Settings>);
  home = dirs.home;
  if (store.value.effects.asciiLogo) showSplash();
  // Before the tabs, so theme plugins colour the terminals from the start.
  await plugins.load();

  if (saved?.sidebarW) root.style.setProperty("--sidebar-w", `${saved.sidebarW}px`);
  if (saved?.sidebarHidden) {
    app.classList.add("no-sidebar");
    btnSidebar.setAttribute("aria-pressed", "false");
  }
  if (saved?.editorH) root.style.setProperty("--editor-h", `${saved.editorH}%`);

  const restore = saved?.tabs ?? [];
  const activeIdx = Math.min(Math.max(saved?.active ?? 0, 0), restore.length - 1);
  // Open the active tab first so it is on screen at once; the rest start in the background.
  // Only resume conversations Claude Code still has; otherwise start a fresh session.
  const alive = await Promise.all(
    restore.map((t) =>
      t.sessionId ? invoke<boolean>("claude_session_exists", { id: t.sessionId }).catch(() => false) : false,
    ),
  );
  const opening: Promise<void>[] = [];
  restore.forEach((t, i) => {
    let resume: string | undefined;
    if (t.kind === "claude") resume = alive[i] ? t.sessionId : t.continue ? "continue" : undefined;
    opening.push(tabs.open(t.kind, t.cwd, { resume, focus: i === activeIdx, images: t.images, win: t.win }));
  });
  await Promise.all(opening);

  // A folder passed on the command line opens its own Claude tab (unless one is already there).
  if (dirs.cli && !restore.some((t) => t.cwd === dirs.cli)) await tabs.open("claude", dirs.cli);
  // Nothing was open: the start screen (recent projects, open a folder).
  if (tabs.count === 0) showStart();
  if (saved?.tiled) toggleTiling(true);
  if (saved?.editorFile) await editor.open(saved.editorFile, { focus: false });

  startUpdateChecks();
  voice.downloadPending();
  if (store.value.claude.installPrompt && !(await invoke<string | null>("claude_status").catch(() => "?"))) {
    installScreen.show();
  }
})();
