import { invoke } from "@tauri-apps/api/core";
import { t, translateTree } from "./i18n";
import { showCombo } from "./settings";

/**
 * Ctrl+P: find a file by name with a fuzzy match ("tvrnidx" finds tavern/index.html).
 * Enter opens it in the editor; Shift+Enter puts its path into Claude's input instead.
 * Starting with ">" (or Ctrl+Shift+P) it finds commands instead: Tern's own and plugins'.
 */

export interface PaletteCommand {
  name: string;
  /** Its shortcut, shown on the right. */
  key?: string;
  /** Which plugin it comes from (empty for Tern's own). */
  source?: string;
  run: () => void;
}

interface Match {
  rel: string;
  score: number;
  /** Indexes into `rel` of the matched characters, for highlighting. */
  at: number[];
}

const LIMIT = 60;

export class QuickOpen {
  onOpen: (path: string) => void = () => {};
  onAskClaude: (path: string) => void = () => {};
  /** The folder to search; null when nothing is open. */
  getRoot: () => string | null = () => null;
  /** Everything the command palette lists. */
  getCommands: () => PaletteCommand[] = () => [];

  private el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private files: Promise<string[]> | null = null;
  private filesRoot = "";
  private matches: Match[] = [];
  /** Commands mode (the query starts with ">"): what each match runs. */
  private commands: PaletteCommand[] | null = null;
  private index = 0;
  private returnFocus: HTMLElement | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.id = "quick-open";
    this.el.hidden = true;
    this.el.innerHTML =
      `<input type="text" spellcheck="false" autocomplete="off" data-i18n-ph="Go to file… (> for commands)" />` +
      `<div class="qo-list" role="listbox"></div>` +
      `<div class="qo-hint"><kbd>Enter</kbd> <span data-i18n="open"></span> · <kbd>Shift+Enter</kbd> <span data-i18n="ask Claude"></span> · <kbd>Esc</kbd> <span data-i18n="close"></span></div>`;
    translateTree(this.el);
    document.body.append(this.el);
    this.input = this.el.querySelector("input")!;
    this.list = this.el.querySelector(".qo-list")!;

    this.input.addEventListener("input", () => this.update());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("blur", () => setTimeout(() => {
      if (!this.el.contains(document.activeElement)) this.close(false);
    }));
    this.list.addEventListener("mousedown", (e) => e.preventDefault());
    this.list.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".qo-row");
      if (row) this.pick(Number(row.dataset.i), e.shiftKey);
    });
  }

  /** The file list is read again on the next open after anything on disk changed. */
  invalidate() {
    this.files = null;
  }

  get isOpen() {
    return !this.el.hidden;
  }

  /** Opens with `prefix` typed in: "" for files, ">" for commands. */
  open(prefix = "") {
    const root = this.getRoot();
    // No folder open: the box still opens (for commands), with nothing to list as files.
    if (!root) {
      this.filesRoot = "";
      this.files = Promise.resolve([]);
    } else if (root !== this.filesRoot || !this.files) {
      this.filesRoot = root;
      this.files = invoke<string[]>("list_files", { root }).catch(() => []);
    }
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.el.hidden = false;
    this.input.value = prefix;
    this.input.focus();
    this.update();
  }

  /** In commands mode now. */
  get inCommands() {
    return this.isOpen && this.input.value.startsWith(">");
  }

  close(restoreFocus = true) {
    if (this.el.hidden) return;
    this.el.hidden = true;
    if (restoreFocus) this.returnFocus?.focus();
  }

  private async update() {
    if (this.input.value.startsWith(">")) return this.updateCommands();
    this.commands = null;
    this.el.classList.remove("commands");
    const q = this.input.value.trim();
    const files = (await this.files) ?? [];
    if (q !== this.input.value.trim()) return; // typed on meanwhile
    if (!q) {
      this.matches = files.slice(0, LIMIT).map((rel) => ({ rel, score: 0, at: [] }));
    } else {
      const found: Match[] = [];
      for (const rel of files) {
        const m = fuzzy(q, rel);
        if (m) found.push(m);
      }
      found.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
      this.matches = found.slice(0, LIMIT);
    }
    this.index = 0;
    this.render(files.length);
  }

  private updateCommands() {
    this.el.classList.add("commands");
    const q = this.input.value.slice(1).trim();
    const all = this.getCommands();
    const found: { m: Match; c: PaletteCommand }[] = [];
    for (const c of all) {
      const m = q ? fuzzy(q, c.name) : { rel: c.name, score: 0, at: [] };
      if (m) found.push({ m, c });
    }
    if (q) found.sort((a, b) => b.m.score - a.m.score);
    this.commands = found.map((f) => f.c);
    this.matches = found.map((f) => f.m);
    this.index = 0;
    this.list.replaceChildren();
    if (!found.length) {
      const empty = document.createElement("div");
      empty.className = "qo-empty";
      empty.textContent = t("No matching commands");
      this.list.append(empty);
      return;
    }
    found.forEach(({ m, c }, i) => {
      const row = document.createElement("div");
      row.className = "qo-row";
      row.dataset.i = String(i);
      row.setAttribute("role", "option");
      const name = document.createElement("span");
      name.className = "qo-name";
      highlight(name, c.name, 0, c.name.length, m.at);
      row.append(name);
      if (c.source) {
        const src = document.createElement("span");
        src.className = "qo-dir";
        src.textContent = c.source;
        row.append(src);
      }
      if (c.key) {
        const k = document.createElement("kbd");
        k.className = "qo-key";
        k.textContent = showCombo(c.key);
        row.append(k);
      }
      this.list.append(row);
    });
    this.select(0);
  }

  private render(total: number) {
    this.list.replaceChildren();
    if (!this.matches.length) {
      const empty = document.createElement("div");
      empty.className = "qo-empty";
      empty.textContent = !this.filesRoot
        ? t("Open a folder to find files — or type > for commands")
        : total
          ? t("No matching files")
          : t("No files");
      this.list.append(empty);
      return;
    }
    this.matches.forEach((m, i) => {
      const row = document.createElement("div");
      row.className = "qo-row";
      row.dataset.i = String(i);
      row.setAttribute("role", "option");
      const slash = m.rel.lastIndexOf("/");
      const name = document.createElement("span");
      name.className = "qo-name";
      const dir = document.createElement("span");
      dir.className = "qo-dir";
      highlight(name, m.rel, slash + 1, m.rel.length, m.at);
      highlight(dir, m.rel, 0, Math.max(0, slash), m.at);
      row.append(name, dir);
      this.list.append(row);
    });
    this.select(0);
  }

  private select(i: number) {
    const rows = this.list.querySelectorAll<HTMLElement>(".qo-row");
    if (!rows.length) return;
    this.index = (i + rows.length) % rows.length;
    rows.forEach((r, k) => r.classList.toggle("sel", k === this.index));
    rows[this.index].scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") this.select(this.index + 1);
    else if (e.key === "ArrowUp") this.select(this.index - 1);
    else if (e.key === "PageDown") this.select(Math.min(this.index + 10, this.matches.length - 1));
    else if (e.key === "PageUp") this.select(Math.max(this.index - 10, 0));
    else if (e.key === "Enter") this.pick(this.index, e.shiftKey);
    else if (e.key === "Escape") this.close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  private pick(i: number, ask: boolean) {
    if (this.commands) {
      const c = this.commands[i];
      if (!c) return;
      this.close();
      c.run();
      return;
    }
    const m = this.matches[i];
    if (!m) return;
    const sep = this.filesRoot.includes("\\") ? "\\" : "/";
    const path = this.filesRoot.replace(/[\\/]+$/, "") + sep + m.rel.split("/").join(sep);
    this.close(false);
    if (ask) this.onAskClaude(path);
    else this.onOpen(path);
  }
}

/** Highlights the matched characters of rel[from, to) inside `el`. */
function highlight(el: HTMLElement, rel: string, from: number, to: number, at: number[]) {
  const hits = new Set(at);
  let run = "";
  let runHit = false;
  const flush = () => {
    if (!run) return;
    if (runHit) {
      const b = document.createElement("b");
      b.textContent = run;
      el.append(b);
    } else el.append(run);
    run = "";
  };
  for (let i = from; i < to; i++) {
    const h = hits.has(i);
    if (h !== runHit) {
      flush();
      runHit = h;
    }
    run += rel[i];
  }
  flush();
}

const isBoundary = (s: string, i: number) =>
  i === 0 || "/\\._- ".includes(s[i - 1]) || (s[i] >= "A" && s[i] <= "Z" && s[i - 1] >= "a" && s[i - 1] <= "z");

/**
 * Subsequence match, scored: characters at word starts and in runs score more, and a match
 * that fits inside the file name beats one spread over the folders.
 */
export function fuzzy(query: string, rel: string): Match | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const s = rel.toLowerCase();
  const base = rel.lastIndexOf("/") + 1;
  // Fast reject: every query character must appear in order.
  let k = 0;
  for (let i = 0; i < s.length && k < q.length; i++) if (s[i] === q[k]) k++;
  if (k < q.length) return null;

  // Try the file name alone first, then the whole path matching from the end backwards so the
  // tail of the query lands in the name.
  const inName = matchFrom(q, s, rel, base);
  const whole = inName ?? matchBackward(q, s);
  if (!whole) return null;
  let score = 0;
  let prev = -2;
  for (const i of whole) {
    score += 1;
    if (isBoundary(rel, i)) score += 8;
    if (i === prev + 1) score += 5;
    if (i >= base) score += 2;
    prev = i;
  }
  if (inName) score += 20;
  if (s.slice(base).startsWith(q)) score += 30;
  score -= rel.length * 0.05;
  return { rel, score, at: whole };
}

function matchFrom(q: string, s: string, rel: string, start: number): number[] | null {
  // Prefer starts of words: for each query char, look for a boundary match before a plain one.
  const at: number[] = [];
  let i = start;
  for (let k = 0; k < q.length; k++) {
    let found = -1;
    for (let j = i; j < s.length; j++) {
      if (s[j] !== q[k]) continue;
      if (found < 0) found = j;
      if (j === i || isBoundary(rel, j)) {
        found = j;
        break;
      }
    }
    if (found < 0) return null;
    at.push(found);
    i = found + 1;
  }
  return at;
}

function matchBackward(q: string, s: string): number[] | null {
  const at: number[] = [];
  let i = s.length - 1;
  for (let k = q.length - 1; k >= 0; k--) {
    while (i >= 0 && s[i] !== q[k]) i--;
    if (i < 0) return null;
    at.unshift(i--);
  }
  return at;
}
