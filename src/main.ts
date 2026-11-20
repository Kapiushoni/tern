import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";
import { FileTree } from "./tree";
import { setTerminalTheme, TermKind, ThemeName } from "./terminal";
import { Tabs, SavedTab } from "./tabs";
import { Attachments } from "./attach";
import { Editor } from "./editor";

const app = document.getElementById("app")!;
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

const tree = new FileTree(document.getElementById("tree")!);
const tabs = new Tabs(document.getElementById("tabs")!, panes);
const attachments = new Attachments(termHost, panes, tabs);
const editor = new Editor(document.getElementById("editor")!);
tree.onDragOut = (path, target) => {
  if (target?.closest("#terminal-host")) tabs.attach([path]);
  else if (target?.closest("#editor")) editor.open(path);
};
tree.onOpen = (path) => editor.open(path);
tree.onAskClaude = (path) => tabs.askClaude(path);
attachments.onOpenFile = (path) => editor.open(path);
let home = "";
let theme: ThemeName = "dark";

interface Saved {
  version: 1;
  tabs: SavedTab[];
  active: number;
  sidebarW?: number;
  sidebarHidden?: boolean;
  /** The file open in the editor panel, and the panel's share of the height in %. */
  editorFile?: string;
  editorH?: number;
  theme?: ThemeName;
}

function baseName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

// ── session save (debounced) ─────────────────────────────
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const css = getComputedStyle(document.documentElement);
    const w = parseInt(css.getPropertyValue("--sidebar-w"));
    const eh = parseFloat(css.getPropertyValue("--editor-h"));
    const data: Saved = {
      version: 1,
      ...tabs.saved(),
      sidebarW: Number.isFinite(w) ? w : undefined,
      sidebarHidden: app.classList.contains("no-sidebar"),
      editorFile: editor.path ?? undefined,
      editorH: Number.isFinite(eh) ? eh : undefined,
      theme,
    };
    invoke("session_save", { json: JSON.stringify(data) }).catch(() => {});
  }, 300);
}
tabs.onChange = save;

// ── watching the disk: tree, git colours and the open file follow outside edits ──
let watchKey = "";
function updateWatch() {
  const roots = tree.root ? [tree.root] : [];
  const files = editor.path ? [editor.path] : [];
  const key = JSON.stringify([roots, files]);
  if (key === watchKey) return;
  watchKey = key;
  invoke("watch_set", { roots, files }).catch(() => {});
}
tree.onRoot = () => queueMicrotask(updateWatch);
editor.onChange = () => {
  save();
  updateWatch();
};
listen<{ paths: string[]; git: boolean }>("fs-change", (e) => {
  tree.onDiskChange(e.payload.paths, e.payload.git);
  editor.onDiskChange(e.payload.paths);
});

// ── theme ────────────────────────────────────────────────
function applyTheme(name: ThemeName) {
  theme = name;
  if (name === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  setTerminalTheme(name);
  // The Windows title bar follows too.
  getCurrentWindow().setTheme(name).catch(() => {});
  btnTheme.title = name === "light" ? "Dark theme" : "Light theme";
}
btnTheme.addEventListener("click", () => {
  applyTheme(theme === "light" ? "dark" : "light");
  save();
});

// ── tree follows the active tab ──────────────────────────
function showEmpty(on: boolean) {
  panes.querySelector(".notice")?.remove();
  if (!on) return;
  const n = document.createElement("div");
  n.className = "notice";
  n.innerHTML =
    `<div><b>No tabs open</b></div>` +
    `<div><kbd>Ctrl+\`</kbd> Claude &nbsp; <kbd>Ctrl+Shift+T</kbd> shell</div>`;
  panes.append(n);
}

tabs.onActivate = (cwd) => {
  showEmpty(cwd === null);
  if (cwd === null) return;
  rootName.textContent = baseName(cwd);
  rootName.title = cwd;
  tree.open(cwd);
};

const currentDir = () => tabs.activeCwd ?? tree.root ?? home;
const newTab = (kind: TermKind) => tabs.open(kind, currentDir() || home);

// ── buttons ──────────────────────────────────────────────
btnHidden.addEventListener("click", async () => {
  const on = btnHidden.getAttribute("aria-pressed") !== "true";
  btnHidden.setAttribute("aria-pressed", String(on));
  btnHidden.title = on ? "Hide hidden files" : "Show hidden files";
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
 * release. Resizing live made the terminal's WebGL canvas blink on every frame.
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
  (x) => document.documentElement.style.setProperty("--sidebar-w", `${x}px`),
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
    document.documentElement.style.setProperty("--editor-h", `${(((y - r.top) / r.height) * 100).toFixed(1)}%`);
  },
);

// ── hotkeys (physical key codes: work in any keyboard layout) ─
window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape" && !newMenu.hidden) return toggleMenu(false);
    if (!mod || e.altKey) return;
    const shift = e.shiftKey;
    let handled = true;
    if (!shift && e.code === "KeyB") {
      app.classList.toggle("no-sidebar");
      save();
    } else if (!shift && e.code === "Backquote") newTab("claude");
    else if (shift && e.code === "KeyT") newTab("shell");
    else if (shift && e.code === "KeyA") attachments.pick();
    else if (!shift && e.code === "KeyW") {
      // In the editor, Ctrl+W closes the file rather than the terminal tab.
      if (editor.isOpen && document.activeElement?.closest("#editor")) editor.close();
      else tabs.close();
    }
    else if (e.code === "Tab") tabs.cycle(shift ? -1 : 1);
    else if (!shift && /^Digit[1-9]$/.test(e.code)) tabs.pick(Number(e.code.slice(5)));
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  { capture: true },
);

// ── start: restore the last session ──────────────────────
(async () => {
  const [, dirs, raw] = await Promise.all([
    document.fonts.load('14px "Commit Mono"').catch(() => {}),
    invoke<{ cli: string | null; home: string }>("initial_dir"),
    invoke<string | null>("session_load").catch(() => null),
  ]);
  home = dirs.home;

  let saved: Saved | null = null;
  try {
    saved = raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    saved = null;
  }
  if (saved?.sidebarW) document.documentElement.style.setProperty("--sidebar-w", `${saved.sidebarW}px`);
  if (saved?.sidebarHidden) app.classList.add("no-sidebar");
  if (saved?.editorH) document.documentElement.style.setProperty("--editor-h", `${saved.editorH}%`);
  // Before any terminal is created, so they all start in the right colours.
  applyTheme(saved?.theme === "light" ? "light" : "dark");

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
    opening.push(tabs.open(t.kind, t.cwd, { resume, focus: i === activeIdx, images: t.images }));
  });
  await Promise.all(opening);

  // A folder passed on the command line opens its own Claude tab (unless one is already there).
  if (dirs.cli && !restore.some((t) => t.cwd === dirs.cli)) await tabs.open("claude", dirs.cli);
  if (tabs.count === 0) await tabs.open("claude", dirs.cli ?? home);
  if (saved?.editorFile) await editor.open(saved.editorFile, { focus: false });
})();
