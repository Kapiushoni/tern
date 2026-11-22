import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import type { Terminal } from "@xterm/xterm";
import type { Tabs } from "./tabs";
import { t, tt } from "./i18n";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;
export const isImage = (path: string) => IMAGE_EXT.test(path);

/** Quotes a path only when it needs it, the way terminals do for dropped files. */
export const quotePath = (path: string) => (/[\s"'&()]/.test(path) ? `"${path}"` : path);

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

// ── reading the screen ───────────────────────────────────

/** A buffer line as text, plus the terminal column of every character (wide glyphs take two). */
function readLine(term: Terminal, y: number): { text: string; cols: number[] } {
  const line = term.buffer.active.getLine(y);
  let text = "";
  const cols: number[] = [];
  if (!line) return { text, cols };
  for (let x = 0; x < term.cols; x++) {
    const cell = line.getCell(x);
    if (!cell) break;
    if (cell.getWidth() === 0) continue; // second half of a wide glyph
    const ch = cell.getChars() || " ";
    for (let i = 0; i < ch.length; i++) cols.push(x);
    text += ch;
  }
  return { text: text.trimEnd(), cols };
}

const BORDER = /^[─━]/;
const PROMPT = /^(❯|>)(\s| |$)/;

/**
 * Where Claude Code's input box is on screen (absolute buffer rows): the "❯" prompt line and the
 * border lines above and below it. Found bottom-up, so it is the live input, not an old message.
 */
export function inputBox(term: Terminal): { top: number; prompt: number; bottom: number } | null {
  const buf = term.buffer.active;
  const first = buf.viewportY;
  const last = first + term.rows - 1;
  const text = (y: number) => readLine(term, y).text.trimStart();
  for (let y = last; y > first && y > last - 40; y--) {
    if (!PROMPT.test(text(y)) || !BORDER.test(text(y - 1))) continue;
    let bottom = y + 1;
    while (bottom <= last && !BORDER.test(text(bottom))) bottom++;
    return { top: y - 1, prompt: y, bottom };
  }
  return null;
}

export interface MenuHit {
  /** Buffer row of the clicked item; how many items down (+) or up (−) from the ❯ one it is. */
  row: number;
  delta: number;
}

const MARK = /^(\s*)(❯|›)\s+(?=\S)/;

/**
 * Claude Code's menus (permission prompts, "do you trust this folder", pickers) are keyboard
 * only: a column of options with ❯ on the current one, numbered or not. This finds the option at
 * a row, if that row belongs to such a menu on the live screen. The input box's own ❯ (between
 * two ─── lines) and anything in scrolled-back history are not menus.
 */
export function menuItemAt(term: Terminal, row: number): MenuHit | null {
  const buf = term.buffer.active;
  const first = buf.baseY;
  const last = first + term.rows - 1;
  if (row < first || row > last) return null;
  const text = (y: number) => readLine(term, y).text;
  // The ❯ line near the click.
  let markRow = -1;
  let textCol = 0;
  for (let d = 0; d <= 14 && markRow < 0; d++) {
    for (const y of d ? [row - d, row + d] : [row]) {
      if (y < first || y > last) continue;
      const m = MARK.exec(text(y));
      if (!m) continue;
      if (BORDER.test(text(y - 1).trimStart()) || BORDER.test(text(y + 1).trimStart())) continue; // the input box
      markRow = y;
      textCol = m[0].length;
      break;
    }
  }
  if (markRow < 0) return null;
  // Options: lines whose text starts at the same column (only spaces before it).
  const isItem = (y: number) => {
    const t = text(y);
    return t.length > textCol && /\S/.test(t[textCol]) && !/\S/.test(t.slice(0, textCol));
  };
  const items = [markRow];
  for (const step of [-1, 1]) {
    let gap = 0;
    for (let y = markRow + step; y >= first && y <= last; y += step) {
      const t = text(y);
      if (!t.trim()) {
        if (++gap > 1) break;
        continue;
      }
      if (/(Enter|Esc) to /.test(t)) break; // the hint line under the menu
      if (isItem(y)) {
        items.push(y);
        gap = 0;
      } else if (/^\s*$/.test(t.slice(0, textCol + 1)) && t.length > textCol + 1) {
        continue; // an option's description, indented further
      } else break;
    }
  }
  if (items.length < 2 || !items.includes(row)) return null;
  items.sort((x, y) => x - y);
  return { row, delta: items.indexOf(row) - items.indexOf(markRow) };
}

/** The "[Image #N]" numbers currently in Claude Code's input box. */
export function imageTagsInInput(term: Terminal): number[] {
  const box = inputBox(term);
  if (!box) return [];
  const found: number[] = [];
  for (let y = box.prompt; y < box.bottom; y++) {
    for (const m of readLine(term, y).text.matchAll(/\[Image #(\d+)\]/g)) found.push(Number(m[1]));
  }
  return found;
}

interface FileInfo {
  size: number;
  modified: number;
  is_dir: boolean;
}

/** Something under the mouse that has a file behind it. */
interface Hit {
  row: number;
  start: number;
  end: number;
  path: string;
  label: string;
}

const PATH_RE = /"([A-Za-z]:[\\/][^"\r\n]+)"|([A-Za-z]:[\\/][^\s"'<>|*?]+)/g;
const TAG_RE = /\[Image #(\d+)\]/g;

function formatSize(n: number) {
  if (n < 1024) return t("{n} B", { n });
  if (n < 1024 * 1024) return t("{n} KB", { n: (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) });
  return t("{n} MB", { n: (n / 1024 / 1024).toFixed(1) });
}

const PLUS = `<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>`;

/**
 * Attaching files: Ctrl+V, drag-and-drop from Explorer, the "+" button next to Claude Code's
 * prompt and Ctrl+Shift+A. Paths go straight into the input line. Hovering an "[Image #N]" tag
 * or a file path in the terminal shows a card with the picture or the file's details.
 */
export class Attachments {
  private plus: HTMLButtonElement;
  private card: HTMLElement;
  private viewer: HTMLElement;
  /** The row of buttons at the end of the prompt line. */
  readonly tools: HTMLElement;
  private frame = 0;
  private unwatch: (() => void) | null = null;
  private hit: Hit | null = null;
  private hoverFrame = 0;
  private info = new Map<string, { at: number; value: Promise<FileInfo | null> }>();
  /** Ctrl+click on a file path in the terminal opens it in the editor. */
  onOpenFile: (path: string) => void = () => {};
  /**
   * Files dragged in from outside, over something other than the terminal (the file tree):
   * return true to take them. `drop` is false while they are only hovering.
   */
  onExternalDrop: (paths: string[], target: Element | null, drop: boolean) => boolean = () => false;

  constructor(
    termHost: HTMLElement,
    private panes: HTMLElement,
    private tabs: Tabs,
  ) {
    this.card = document.getElementById("peek")!;
    this.viewer = document.getElementById("viewer")!;

    this.plus = document.createElement("button");
    this.plus.id = "btn-attach";
    tt(this.plus, "Attach files (Ctrl+Shift+A) — or paste / drop them");
    this.plus.tabIndex = -1;
    this.plus.innerHTML = PLUS;
    this.plus.addEventListener("mousedown", (e) => e.preventDefault());
    this.plus.addEventListener("click", () => this.pick());
    // Buttons that sit at the right end of Claude's prompt line (the mic joins later).
    this.tools = document.createElement("div");
    this.tools.id = "prompt-tools";
    this.tools.hidden = true;
    this.tools.append(this.plus);
    panes.append(this.tools);

    tabs.onTerm = () => this.follow();
    new ResizeObserver(() => this.place()).observe(panes);

    panes.addEventListener("mousemove", (e) => this.onMouseMove(e));
    panes.addEventListener("mouseleave", () => {
      this.setHit(null);
      this.showMenuHover(null);
    });
    // Capture phase, so a click on a tag opens the picture instead of going to Claude Code.
    panes.addEventListener("mousedown", (e) => this.onMouseDown(e), { capture: true });

    this.viewer.addEventListener("click", () => this.closeViewer());
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || this.viewer.hidden) return;
        this.closeViewer();
        e.preventDefault();
        e.stopPropagation();
      },
      { capture: true },
    );

    // Capture phase: runs before xterm's own paste handler, so files and images can be taken here.
    termHost.addEventListener("paste", (e) => this.onPaste(e), { capture: true });

    let dragged: string[] = [];
    getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter") dragged = p.paths;
      // Where the pointer is (the event gives physical pixels).
      const at =
        "position" in p
          ? document.elementFromPoint(p.position.x / devicePixelRatio, p.position.y / devicePixelRatio)
          : null;
      if (p.type === "leave") {
        termHost.classList.remove("dropping");
        this.onExternalDrop([], null, false);
        return;
      }
      const elsewhere = this.onExternalDrop(p.type === "drop" ? p.paths : dragged, at, p.type === "drop");
      termHost.classList.toggle("dropping", !elsewhere && p.type !== "drop");
      if (p.type === "drop" && !elsewhere) tabs.attach(p.paths);
    });
  }

  /** The "+" button / Ctrl+Shift+A: pick one or more files. */
  async pick() {
    const picked = await open({ multiple: true, directory: false, defaultPath: this.tabs.activeCwd ?? undefined });
    await this.tabs.attach(picked ?? []);
  }

  private async onPaste(e: ClipboardEvent) {
    const data = e.clipboardData;
    if (!data) return;
    // Read everything now: the clipboard data is only available during the event.
    const text = data.getData("text/plain");
    const image = [...data.items].find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
    e.preventDefault();
    e.stopPropagation();

    const files = await invoke<string[]>("clipboard_files").catch(() => []);
    if (files.length) return this.tabs.attach(files);
    // Text wins over a picture: Excel, for one, puts both on the clipboard.
    if (!text && image) {
      const ext = image.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\W.*$/, "") || "png";
      try {
        const bytes = new Uint8Array(await image.arrayBuffer());
        const path = await invoke<string>("save_paste", bytes, { headers: { "x-ext": ext } });
        return this.tabs.attach([path]);
      } catch (err) {
        console.error("could not save pasted image", err);
        return;
      }
    }
    if (text) this.tabs.pasteText(text);
  }

  // ── the "+" button follows the prompt ─────────────────

  private follow() {
    this.unwatch?.();
    this.unwatch = null;
    this.setHit(null);
    const term = this.tabs.activeTerm;
    if (term && this.tabs.activeKind === "claude") {
      const d = term.onRender(() => this.place());
      this.unwatch = () => d.dispose();
    }
    this.place();
  }

  private place() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      const term = this.tabs.activeTerm;
      const box = term && this.tabs.activeKind === "claude" ? inputBox(term) : null;
      const geo = term && this.geometry(term);
      if (!term || !box || !geo) {
        this.tools.hidden = true;
        return;
      }
      // Right end of the prompt line, inside the input box: that part is nearly always empty.
      const y = geo.top + (box.prompt - term.buffer.active.viewportY) * geo.cellH;
      this.tools.style.top = `${y + (geo.cellH - 20) / 2}px`;
      this.tools.style.left = `${geo.left + geo.screen.width - 6}px`;
      this.tools.hidden = false;
    });
  }

  /** Where the active terminal's grid is on screen, relative to the panes, and its cell size. */
  private geometry(term: Terminal) {
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    if (!screen || !screen.clientHeight) return null;
    const s = screen.getBoundingClientRect();
    const p = this.panes.getBoundingClientRect();
    return {
      top: s.top - p.top,
      left: s.left - p.left,
      cellW: s.width / term.cols,
      cellH: s.height / term.rows,
      screen: s,
    };
  }

  // ── hover cards ───────────────────────────────────────

  private onMouseMove(e: MouseEvent) {
    const { clientX, clientY } = e;
    cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = requestAnimationFrame(() => {
      this.showMenuHover(this.menuAt(clientX, clientY));
      this.setHit(this.hitAt(clientX, clientY), clientX);
    });
  }

  // ── clicking Claude Code's menu items ─────────────────

  private menuHover: HTMLElement | null = null;

  private menuAt(x: number, y: number): MenuHit | null {
    const term = this.tabs.activeTerm;
    if (!term || this.tabs.activeKind !== "claude") return null;
    const geo = this.geometry(term);
    if (!geo) return null;
    const r = Math.floor((y - geo.screen.top) / geo.cellH);
    const col = Math.floor((x - geo.screen.left) / geo.cellW);
    if (r < 0 || r >= term.rows || col < 0 || col >= term.cols) return null;
    return menuItemAt(term, term.buffer.active.viewportY + r);
  }

  /** A soft highlight on the menu item under the pointer. */
  private showMenuHover(hit: MenuHit | null) {
    const term = this.tabs.activeTerm;
    const geo = term && this.geometry(term);
    document.body.classList.toggle("menu-hover", !!hit);
    if (!hit || !term || !geo) {
      this.menuHover?.remove();
      this.menuHover = null;
      return;
    }
    if (!this.menuHover) {
      this.menuHover = document.createElement("div");
      this.menuHover.className = "menu-item-hover";
      this.panes.append(this.menuHover);
    }
    const top = geo.top + (hit.row - term.buffer.active.viewportY) * geo.cellH;
    Object.assign(this.menuHover.style, {
      top: `${top}px`,
      left: `${geo.left}px`,
      width: `${geo.screen.width}px`,
      height: `${geo.cellH}px`,
    });
  }

  /** Picks the item: arrow keys to it, then Enter — exactly what the keyboard would do. */
  private async pickMenuItem(hit: MenuHit) {
    const session = this.tabs.activeSession;
    const term = this.tabs.activeTerm;
    if (!session || !term) return;
    const app = term.modes.applicationCursorKeysMode;
    const key = hit.delta > 0 ? (app ? "\x1bOB" : "\x1b[B") : app ? "\x1bOA" : "\x1b[A";
    for (let i = 0; i < Math.abs(hit.delta); i++) {
      session.send(key);
      // One key per read: the menu handles keys one at a time.
      await new Promise((r) => setTimeout(r, 30));
    }
    session.send("\r");
    session.focus();
  }

  private hitAt(x: number, y: number): Hit | null {
    const term = this.tabs.activeTerm;
    const geo = term && this.geometry(term);
    if (!term || !geo) return null;
    const col = Math.floor((x - geo.screen.left) / geo.cellW);
    const r = Math.floor((y - geo.screen.top) / geo.cellH);
    if (col < 0 || r < 0 || col >= term.cols || r >= term.rows) return null;
    const row = term.buffer.active.viewportY + r;
    const { text, cols } = readLine(term, row);
    const at = (i: number) => cols[i] ?? cols[cols.length - 1] ?? 0;
    for (const m of text.matchAll(TAG_RE)) {
      const start = at(m.index!);
      const end = at(m.index! + m[0].length - 1);
      if (col < start || col > end) continue;
      const path = this.tabs.imagePath(Number(m[1]));
      return path ? { row, start, end, path, label: m[0].slice(1, -1) } : null;
    }
    for (const m of text.matchAll(PATH_RE)) {
      const path = (m[1] ?? m[2]).replace(/[.,;:)\]}]+$/, "");
      const start = at(m.index!);
      const end = at(m.index! + m[0].length - 1);
      if (col < start || col > end) continue;
      return { row, start, end, path, label: baseName(path) };
    }
    return null;
  }

  private setHit(hit: Hit | null, mouseX = 0) {
    const h = this.hit;
    if (hit && h && hit.path === h.path && hit.row === h.row && hit.start === h.start) return;
    this.hit = hit;
    document.body.classList.toggle("link-hover", !!hit && isImage(hit.path));
    if (!hit) this.card.hidden = true;
    else this.showCard(hit, mouseX);
  }

  private fileInfo(path: string) {
    const cached = this.info.get(path);
    if (cached && Date.now() - cached.at < 5000) return cached.value;
    const value = invoke<FileInfo | null>("file_info", { path }).catch(() => null);
    this.info.set(path, { at: Date.now(), value });
    return value;
  }

  private async showCard(hit: Hit, mouseX: number) {
    const info = await this.fileInfo(hit.path);
    if (this.hit !== hit) return;
    if (!info) {
      this.card.hidden = true;
      document.body.classList.remove("link-hover");
      return;
    }
    const parts: HTMLElement[] = [];
    if (isImage(hit.path)) parts.push(this.img(hit.path));
    const div = (cls: string, text: string) => {
      const el = document.createElement("div");
      el.className = cls;
      el.textContent = text;
      parts.push(el);
    };
    const name = baseName(hit.path);
    div("card-name", hit.label === name ? name : `${hit.label} · ${name}`);
    div(
      "card-meta",
      [info.is_dir ? t("folder") : formatSize(info.size), info.modified ? new Date(info.modified).toLocaleString(document.documentElement.lang) : ""]
        .filter(Boolean)
        .join(" · "),
    );
    div("card-path", hit.path);
    if (isImage(hit.path)) div("card-tip", t("click to open"));
    else if (!info.is_dir) div("card-tip", t("Ctrl+click to open in the editor"));
    this.card.replaceChildren(...parts);
    this.card.hidden = false;

    // Above the line if there is room, else below it.
    const term = this.tabs.activeTerm;
    const geo = term && this.geometry(term);
    if (!term || !geo) return;
    const rowTop = geo.screen.top + (hit.row - term.buffer.active.viewportY) * geo.cellH;
    const w = this.card.offsetWidth;
    const h = this.card.offsetHeight;
    this.card.style.left = `${Math.max(8, Math.min(mouseX - 20, window.innerWidth - w - 8))}px`;
    this.card.style.top = `${rowTop - h - 6 >= 8 ? rowTop - h - 6 : rowTop + geo.cellH + 6}px`;
  }

  private onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const menu = !e.shiftKey && !e.ctrlKey && this.menuAt(e.clientX, e.clientY);
    if (menu) {
      e.preventDefault();
      e.stopPropagation();
      this.showMenuHover(null);
      this.pickMenuItem(menu);
      return;
    }
    const hit = this.hitAt(e.clientX, e.clientY);
    if (!hit) return;
    // Images open on a plain click; other files on Ctrl+click, so clicking text still works.
    const image = isImage(hit.path);
    if (!image && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    this.setHit(null);
    if (image) this.show(hit.path);
    else this.onOpenFile(hit.path);
  }

  // ── full-size viewer ──────────────────────────────────

  private img(path: string): HTMLImageElement {
    const img = document.createElement("img");
    img.src = convertFileSrc(path);
    img.decoding = "async";
    img.alt = baseName(path);
    img.onerror = () => img.classList.add("missing");
    return img;
  }

  private show(path: string) {
    const cap = document.createElement("div");
    cap.className = "caption";
    cap.textContent = path;
    this.viewer.replaceChildren(this.img(path), cap);
    this.viewer.hidden = false;
  }

  private closeViewer() {
    this.viewer.hidden = true;
    this.viewer.replaceChildren();
    this.tabs.activeTerm?.focus();
  }
}
