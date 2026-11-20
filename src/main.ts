import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import "./styles.css";
import { FileTree } from "./tree";
import { setLayoutPaused, TermKind } from "./terminal";
import { Tabs, SavedTab } from "./tabs";

const app = document.getElementById("app")!;
const termHost = document.getElementById("terminal-host")!;
const rootName = document.getElementById("root-name")!;
const btnHidden = document.getElementById("btn-hidden")!;
const btnOpen = document.getElementById("btn-open")!;
const btnNew = document.getElementById("btn-new")!;
const newMenu = document.getElementById("new-menu")!;
const splitter = document.getElementById("splitter")!;

const tree = new FileTree(document.getElementById("tree")!);
const tabs = new Tabs(document.getElementById("tabs")!, termHost);
let home = "";

interface Saved {
  version: 1;
  tabs: SavedTab[];
  active: number;
  sidebarW?: number;
  sidebarHidden?: boolean;
}

function baseName(p: string) {
  return p.replace(/[\/]+$/, "").split(/[\/]/).pop() || p;
}

// ── session save (debounced) ─────────────────────────────
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"));
    const data: Saved = {
      version: 1,
      ...tabs.saved(),
      sidebarW: Number.isFinite(w) ? w : undefined,
      sidebarHidden: app.classList.contains("no-sidebar"),
    };
    invoke("session_save", { json: JSON.stringify(data) }).catch(() => {});
  }, 300);
}
tabs.onChange = save;

// ── tree follows the active tab ──────────────────────────
function showEmpty(on: boolean) {
  termHost.querySelector(".notice")?.remove();
  if (!on) return;
  const n = document.createElement("div");
  n.className = "notice";
  n.innerHTML =
    `<div><b>No tabs open</b></div>` +
    `<div><kbd>Ctrl+\`</kbd> Claude &nbsp; <kbd>Ctrl+Shift+T</kbd> shell</div>`;
  termHost.append(n);
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

// ── splitter ─────────────────────────────────────────────
splitter.addEventListener("pointerdown", (e) => {
  splitter.setPointerCapture(e.pointerId);
  // Freeze the terminal while dragging and refit once on release, so it does not
  // re-render on every pixel and flicker.
  setLayoutPaused(true);
  let frame = 0;
  const move = (ev: PointerEvent) => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const w = Math.min(Math.max(ev.clientX, 160), window.innerWidth * 0.5);
      document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    });
  };
  const up = () => {
    splitter.removeEventListener("pointermove", move);
    splitter.removeEventListener("pointerup", up);
    splitter.removeEventListener("pointercancel", up);
    setLayoutPaused(false);
    save();
  };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up);
  splitter.addEventListener("pointercancel", up);
});

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
    else if (!shift && e.code === "KeyW") tabs.close();
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
    opening.push(tabs.open(t.kind, t.cwd, { resume, focus: i === activeIdx }));
  });
  await Promise.all(opening);

  // A folder passed on the command line opens its own Claude tab (unless one is already there).
  if (dirs.cli && !restore.some((t) => t.cwd === dirs.cli)) await tabs.open("claude", dirs.cli);
  if (tabs.count === 0) await tabs.open("claude", dirs.cli ?? home);
})();
