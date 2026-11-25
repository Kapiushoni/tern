import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "./toast";
import { t } from "./i18n";
import { fileIcon, iconsReady, setFolderOpen } from "./fileicons";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  hidden: boolean;
}

type GitState = "modified" | "new" | "deleted" | "conflict";
/** Which state wins when a folder holds files in several. */
const GIT_RANK: Record<GitState, number> = { deleted: 1, modified: 2, new: 3, conflict: 4 };

const key = (p: string) => p.toLowerCase();
const parentOf = (p: string) => p.replace(/[\\/][^\\/]+[\\/]?$/, "");
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

const ERRORS: Record<string, string> = {
  exists: "Something with that name is already there.",
  "invalid-name": "That name can't be used.",
  "into-itself": "A folder can't be moved into itself.",
};
const explain = (err: unknown) => (ERRORS[String(err)] ? t(ERRORS[String(err)]) : String(err));

interface MenuItem {
  label: string;
  hint?: string;
  run: () => void;
}

/**
 * Lazy file tree: a folder's children are read only when it is expanded. Clicking a file opens
 * it; the context menu, F2 and Delete manage files; rows can be dragged into other folders or
 * into the terminal. Colours show git status.
 */
export class FileTree {
  private showHidden = false;
  private expanded = new Set<string>();
  /** Expanded folders per project root, so switching tabs keeps each tree as it was. */
  private memory = new Map<string, Set<string>>();
  /** The row last clicked (rename, run ▶, new file go by it). */
  private selectedPath: string | null = null;
  /** Everything selected (Ctrl+click, Shift+click, a drag box, Ctrl+A). */
  private sel = new Set<string>();
  /** Where a Shift+click range starts. */
  private anchor: string | null = null;
  private git = new Map<string, GitState>();
  private refreshTimer = 0;
  private menu: HTMLElement;
  /** Files and folders taken with "Copy" (Ctrl+C) or "Cut" (Ctrl+X), waiting for "Paste" (Ctrl+V). */
  private clipboard: string[] = [];
  /** The clipboard was cut: pasting moves the items instead of copying them. */
  private clipCut = false;
  root = "";

  /** The highlighted row's path, if any. */
  get selected(): string | null {
    return this.selectedPath;
  }

  /** A row was dragged out of the tree and dropped on `target` (the element under the pointer). */
  onDragOut: (paths: string[], target: Element | null) => void = () => {};
  onOpen: (path: string) => void = () => {};
  onAskClaude: (paths: string[]) => void = () => {};
  onOpenInIde: (path: string) => void = () => {};
  /** Items plugins add to the context menu. */
  extraMenuItems: (path: string) => MenuItem[] = () => [];
  /** The tree now shows another folder (the watcher follows it). */
  onRoot: (root: string) => void = () => {};

  constructor(private el: HTMLElement) {
    el.tabIndex = 0;
    el.addEventListener("click", (e) => this.onClick(e));
    el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    el.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    el.addEventListener("keydown", (e) => this.onKey(e));

    this.menu = document.createElement("div");
    this.menu.id = "ctx-menu";
    this.menu.setAttribute("role", "menu");
    this.menu.hidden = true;
    document.body.append(this.menu);
    this.menu.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("button");
      if (!b) return;
      this.closeMenu();
      this.menuItems[Number(b.dataset.i)]?.run();
    });
    window.addEventListener("pointerdown", (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.closeMenu();
    }, { capture: true });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.menu.hidden) {
        e.stopPropagation();
        this.closeMenu();
      }
    }, { capture: true });
    window.addEventListener("blur", () => this.closeMenu());
  }

  // ── loading ───────────────────────────────────────────

  async open(root: string) {
    if (root === this.root) return;
    if (this.root) this.memory.set(this.root, new Set(this.expanded));
    this.root = root;
    this.git.clear();
    this.onRoot(root);
    await this.rebuild(this.memory.get(root) ?? new Set());
    this.loadGit();
  }

  async setShowHidden(v: boolean) {
    this.showHidden = v;
    await this.rebuild(new Set(this.expanded));
  }

  /** Re-reads the open folders soon (batched): something changed on disk. */
  refreshSoon(gitToo = true) {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(async () => {
      await this.rebuild(new Set(this.expanded));
      if (gitToo) this.loadGit();
    }, 120);
  }

  /** The watcher saw these paths change: refresh if any is in a folder on screen. */
  onDiskChange(paths: string[], gitChanged: boolean) {
    const shown = new Set([key(this.root), ...[...this.expanded].map(key)]);
    if (paths.some((p) => shown.has(key(parentOf(p))))) this.refreshSoon();
    else if (gitChanged || paths.length) this.loadGitSoon();
  }

  private gitTimer = 0;
  private loadGitSoon() {
    clearTimeout(this.gitTimer);
    this.gitTimer = window.setTimeout(() => this.loadGit(), 300);
  }

  private async loadGit() {
    const root = this.root;
    if (!root) return;
    const files = await invoke<{ path: string; state: GitState }[]>("git_status", { dir: root }).catch(() => []);
    if (root !== this.root) return;
    // Each changed file also colours every folder above it, up to the project root.
    const map = new Map<string, GitState>();
    const mark = (p: string, s: GitState) => {
      const k = key(p);
      const cur = map.get(k);
      if (!cur || GIT_RANK[s] > GIT_RANK[cur]) map.set(k, s);
    };
    const rootKey = key(root);
    for (const f of files) {
      mark(f.path, f.state);
      let dir = parentOf(f.path);
      while (dir.length >= root.length && key(dir).startsWith(rootKey) && dir !== parentOf(dir)) {
        mark(dir, f.state === "deleted" ? "modified" : f.state);
        if (key(dir) === rootKey) break;
        dir = parentOf(dir);
      }
    }
    this.git = map;
    for (const row of this.el.querySelectorAll<HTMLElement>(".node")) this.paintGit(row);
  }

  private paintGit(row: HTMLElement) {
    const s = this.git.get(key(row.dataset.path!));
    row.classList.remove("git-modified", "git-new", "git-deleted", "git-conflict");
    if (s) row.classList.add(`git-${s}`);
  }

  private async rebuild(keep: Set<string>) {
    await iconsReady;
    const root = this.root;
    const scroll = this.el.scrollTop;
    const frag = document.createElement("div");
    this.expanded = new Set();
    await this.renderChildren(root, frag, 0, true);
    // Re-open what was open, top-down.
    for (const path of [...keep].sort((a, b) => a.length - b.length)) {
      const row = frag.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
      if (row) await this.expand(row);
    }
    if (root !== this.root) return; // another open() won the race
    this.el.replaceChildren(...frag.childNodes);
    this.el.scrollTop = scroll;
    this.paintSelection();
    this.paintCut();
  }

  /** `faint`: the folder itself is hidden, so everything in it is shown as hidden too. */
  private async renderChildren(dir: string, after: HTMLElement, depth: number, inside = false, faint = false) {
    let entries: Entry[];
    try {
      entries = await invoke<Entry[]>("list_dir", { path: dir, showHidden: this.showHidden });
    } catch {
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of entries) frag.append(this.row(faint ? { ...e, hidden: true } : e, depth));
    if (inside || after === this.el) after.append(frag);
    else after.after(frag);
  }

  private row(e: Entry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = `node ${e.is_dir ? "dir" : "file"}${e.hidden ? " hidden-entry" : ""}`;
    row.dataset.path = e.path;
    row.dataset.depth = String(depth);
    row.style.paddingLeft = `${10 + depth * 14}px`;
    row.setAttribute("role", "treeitem");

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = e.is_dir ? "›" : "";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = e.name;
    row.append(twisty, fileIcon(e.name, e.is_dir), name);
    if (e.is_dir) row.setAttribute("aria-expanded", "false");
    this.paintGit(row);
    return row;
  }

  private rowOf(path: string) {
    return this.el.querySelector<HTMLElement>(`.node[data-path="${CSS.escape(path)}"]`);
  }

  // ── clicks and keys ───────────────────────────────────

  /** The selected paths, in tree order. */
  get selection(): string[] {
    const rows = [...this.el.querySelectorAll<HTMLElement>(".node[data-path]")].map((r) => r.dataset.path!);
    const shown = rows.filter((p) => this.sel.has(p));
    // Selected items inside a collapsed folder are not on screen but still selected.
    return [...shown, ...[...this.sel].filter((p) => !rows.includes(p))];
  }

  /**
   * single: just this row · toggle: add or remove it (Ctrl+click) · range: from the anchor to
   * this row (Shift+click; Ctrl+Shift adds the range to what is selected).
   */
  private select(row: HTMLElement | null, how: "single" | "toggle" | "range" = "single", add = false) {
    const path = row?.dataset.path ?? null;
    if (!path) {
      this.sel.clear();
      this.selectedPath = null;
    } else if (how === "toggle") {
      if (this.sel.has(path)) this.sel.delete(path);
      else this.sel.add(path);
      this.selectedPath = path;
      this.anchor = path;
    } else if (how === "range" && this.anchor && this.rowOf(this.anchor)) {
      const rows = [...this.el.querySelectorAll<HTMLElement>(".node[data-path]")];
      const a = rows.findIndex((r) => r.dataset.path === this.anchor);
      const b = rows.indexOf(row!);
      if (!add) this.sel.clear();
      for (const r of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) this.sel.add(r.dataset.path!);
      this.selectedPath = path;
    } else {
      this.sel = new Set([path]);
      this.selectedPath = path;
      this.anchor = path;
    }
    this.paintSelection();
  }

  private paintSelection() {
    for (const r of this.el.querySelectorAll<HTMLElement>(".node[data-path]")) {
      r.classList.toggle("selected", this.sel.has(r.dataset.path!));
      r.classList.toggle("focus-row", r.dataset.path === this.selectedPath && this.sel.size > 1);
    }
  }

  private async onClick(ev: MouseEvent) {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".node");
    if (row?.querySelector("input")) return;
    if (!row) return;
    // Ctrl / Shift change the selection only; a plain click opens.
    if (ev.ctrlKey || ev.metaKey) return this.select(row, ev.shiftKey ? "range" : "toggle", ev.shiftKey);
    if (ev.shiftKey) return this.select(row, "range");
    this.select(row);
    if (row.classList.contains("dir")) await this.toggle(row);
    else this.onOpen(row.dataset.path!);
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") {
      this.sel = new Set([...this.el.querySelectorAll<HTMLElement>(".node[data-path]")].map((r) => r.dataset.path!));
      this.paintSelection();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && this.sel.size > 1) {
      this.select(this.selectedPath ? this.rowOf(this.selectedPath) : null);
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyC" && this.sel.size) {
      this.copyEntries(this.selection);
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyX" && this.sel.size) {
      this.copyEntries(this.selection, true);
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyV" && this.clipboard.length) {
      this.paste(this.targetDir());
      e.preventDefault();
      return;
    }
    const row = this.selectedPath ? this.rowOf(this.selectedPath) : null;
    if (e.key === "Delete" && this.sel.size) this.trashMany(this.selection);
    else if (!row) return;
    else if (e.key === "F2") this.startRename(row);
    else if (e.key === "Enter") row.click();
    else if (e.key !== "Delete") return;
    e.preventDefault();
  }

  private async toggle(row: HTMLElement) {
    if (this.expanded.has(row.dataset.path!)) this.collapse(row);
    else await this.expand(row);
  }

  private collapse(row: HTMLElement) {
    const depth = Number(row.dataset.depth);
    this.expanded.delete(row.dataset.path!);
    row.setAttribute("aria-expanded", "false");
    row.querySelector(".twisty")!.textContent = "›";
    setFolderOpen(row.querySelector(".ficon"), false);
    let next = row.nextElementSibling as HTMLElement | null;
    while (next && Number(next.dataset.depth) > depth) {
      const n = next.nextElementSibling as HTMLElement | null;
      if (next.dataset.path) this.expanded.delete(next.dataset.path);
      next.remove();
      next = n;
    }
  }

  private async expand(row: HTMLElement) {
    const path = row.dataset.path!;
    if (this.expanded.has(path)) return;
    this.expanded.add(path);
    row.setAttribute("aria-expanded", "true");
    row.querySelector(".twisty")!.textContent = "⌄";
    setFolderOpen(row.querySelector(".ficon"), true);
    await this.renderChildren(path, row, Number(row.dataset.depth) + 1, false, row.classList.contains("hidden-entry"));
  }

  // ── context menu ──────────────────────────────────────

  private menuItems: MenuItem[] = [];

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>(".node");
    // Right-click inside a multi-selection: actions for all of it.
    if (row && this.sel.size > 1 && this.sel.has(row.dataset.path!)) {
      const paths = this.selection;
      const n = paths.length;
      this.showMenu(
        [
          { label: t("Ask Claude about {n} items", { n }), run: () => this.onAskClaude(paths) },
          null,
          { label: t("Cut"), hint: "Ctrl+X", run: () => this.copyEntries(paths, true) },
          { label: t("Copy"), hint: "Ctrl+C", run: () => this.copyEntries(paths) },
          { label: t("Copy paths"), run: () => this.copy(paths.join("\n")) },
          { label: t("Copy relative paths"), run: () => this.copy(paths.map((p) => this.relative(p)).join("\n")) },
          null,
          { label: t("Delete {n} items", { n }), hint: "Del", run: () => this.trashMany(paths) },
        ],
        e.clientX,
        e.clientY,
      );
      return;
    }
    this.select(row);
    const path = row?.dataset.path ?? this.root;
    const isDir = !row || row.classList.contains("dir");
    const dir = isDir ? path : parentOf(path);
    const items: (MenuItem | null)[] = [];
    if (row && !isDir) items.push({ label: t("Open"), run: () => this.onOpen(path) });
    if (row) items.push({ label: isDir ? t("Ask Claude about this folder") : t("Ask Claude about this file"), run: () => this.onAskClaude([path]) });
    if (row) items.push(null);
    items.push(
      { label: t("New file"), run: () => this.startCreate(dir, false) },
      { label: t("New folder"), run: () => this.startCreate(dir, true) },
      { label: t("Add files…"), run: () => this.pickAndAdd(dir) },
    );
    if (row) {
      items.push(
        { label: t("Cut"), hint: "Ctrl+X", run: () => this.copyEntries([path], true) },
        { label: t("Copy"), hint: "Ctrl+C", run: () => this.copyEntries([path]) },
      );
    }
    // Paste goes into the folder right-clicked, or the project root on empty space.
    if (isDir && this.clipboard.length) {
      const n = this.clipboard.length;
      const label = n === 1 ? t("Paste {name}", { name: baseName(this.clipboard[0]) }) : t("Paste {n} items", { n });
      items.push({ label, hint: "Ctrl+V", run: () => this.paste(dir) });
    }
    if (row) {
      items.push(
        { label: t("Rename"), hint: "F2", run: () => this.startRename(row) },
        { label: t("Delete"), hint: "Del", run: () => this.trash(path) },
      );
    }
    items.push(
      null,
      { label: t("Copy path"), run: () => this.copy(path) },
      { label: t("Copy relative path"), run: () => this.copy(this.relative(path)) },
      { label: t("Open in Explorer"), run: () => invoke("reveal_entry", { path }).catch((err) => toast(explain(err))) },
      { label: t("Open in IDE"), run: () => this.onOpenInIde(path) },
    );
    const extra = this.extraMenuItems(path);
    if (extra.length) items.push(null, ...extra);
    this.showMenu(items, e.clientX, e.clientY);
  }

  showMenu(items: (MenuItem | null)[], x: number, y: number) {
    this.menuItems = [];
    this.menu.replaceChildren();
    for (const it of items) {
      if (!it) {
        this.menu.append(Object.assign(document.createElement("hr"), {}));
        continue;
      }
      const b = document.createElement("button");
      b.setAttribute("role", "menuitem");
      b.dataset.i = String(this.menuItems.push(it) - 1);
      const label = document.createElement("span");
      label.textContent = it.label;
      b.append(label);
      if (it.hint) {
        const k = document.createElement("kbd");
        k.textContent = it.hint;
        b.append(k);
      }
      this.menu.append(b);
    }
    this.menu.hidden = false;
    const w = this.menu.offsetWidth;
    const h = this.menu.offsetHeight;
    this.menu.style.left = `${Math.min(x, window.innerWidth - w - 6)}px`;
    this.menu.style.top = `${Math.min(y, window.innerHeight - h - 6)}px`;
  }

  private closeMenu() {
    this.menu.hidden = true;
  }

  private relative(path: string) {
    return key(path).startsWith(key(this.root)) ? path.slice(this.root.length).replace(/^[\\/]/, "") || "." : path;
  }

  private copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => toast(t("Copied: {text}", { text })),
      () => toast(t("Could not copy")),
    );
  }

  /** "Copy" / "Cut": remembers the items; "Paste" copies (or, after Cut, moves) them into a folder. */
  private copyEntries(paths: string[], cut = false) {
    // A folder already brings its own selected contents along.
    this.clipboard = paths.filter((p) => !paths.some((q) => q !== p && (key(p).startsWith(key(q) + "\\") || key(p).startsWith(key(q) + "/"))));
    this.clipCut = cut;
    this.paintCut();
    const n = this.clipboard.length;
    const name = baseName(this.clipboard[0]);
    if (cut) toast(n === 1 ? t("Cut {name}", { name }) : t("Cut {n} items", { n }));
    else toast(n === 1 ? t("Copied {name}", { name }) : t("Copied {n} items", { n }));
  }

  /** Cut items are shown faded until they are pasted. */
  private paintCut() {
    const cut = new Set(this.clipCut ? this.clipboard.map(key) : []);
    for (const r of this.el.querySelectorAll<HTMLElement>(".node[data-path]")) r.classList.toggle("cut-entry", cut.has(key(r.dataset.path!)));
  }

  /** The folder Ctrl+V pastes into: the selected folder, the selected file's folder, or the root. */
  private targetDir(): string {
    const row = this.selectedPath ? this.rowOf(this.selectedPath) : null;
    if (!row) return this.root;
    return row.classList.contains("dir") ? row.dataset.path! : parentOf(row.dataset.path!);
  }

  private async paste(dir: string) {
    if (!this.clipboard.length) return;
    if (!this.clipCut) return this.addFiles(this.clipboard, dir);
    // Cut: move each item (skipping a folder pasted into itself); the clipboard empties after.
    const paths = this.clipboard;
    this.clipboard = [];
    this.clipCut = false;
    this.paintCut();
    for (const p of paths) {
      if (key(dir) === key(p) || key(dir).startsWith(key(p) + "\\") || key(dir).startsWith(key(p) + "/")) {
        toast(explain("into-itself"));
        continue;
      }
      await this.move(p, dir);
    }
  }

  // ── create / rename / delete / move ───────────────────

  /** An inline text box in the tree; resolves with the typed name, or null if cancelled. */
  private inlineInput(row: HTMLElement, initial: string, selectStem: boolean): Promise<string | null> {
    const input = document.createElement("input");
    input.className = "tree-input";
    input.value = initial;
    input.spellcheck = false;
    row.append(input);
    input.focus();
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, selectStem && dot > 0 ? dot : initial.length);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: string | null) => {
        if (done) return;
        done = true;
        input.remove();
        resolve(value?.trim() ? value.trim() : null);
        this.el.focus();
      };
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(input.value);
        else if (e.key === "Escape") finish(null);
      });
      input.addEventListener("blur", () => finish(input.value));
      input.addEventListener("click", (e) => e.stopPropagation());
    });
  }

  private async startCreate(dir: string, isDir: boolean) {
    // Open the folder so the new item shows up where it will be.
    const dirRow = this.rowOf(dir);
    if (dirRow) await this.expand(dirRow);
    const depth = dirRow ? Number(dirRow.dataset.depth) + 1 : 0;
    const temp = document.createElement("div");
    temp.className = `node ${isDir ? "dir" : "file"} creating`;
    temp.dataset.depth = String(depth);
    temp.style.paddingLeft = `${10 + depth * 14}px`;
    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = isDir ? "›" : "";
    temp.append(twisty, fileIcon("", isDir));
    if (dirRow) dirRow.after(temp);
    else this.el.prepend(temp);
    temp.scrollIntoView({ block: "nearest" });
    const name = await this.inlineInput(temp, "", false);
    temp.remove();
    if (!name) return;
    try {
      const path = await invoke<string>("create_entry", { dir, name, isDir });
      this.selectedPath = path;
      await this.rebuild(new Set(this.expanded));
      if (!isDir) this.onOpen(path);
    } catch (err) {
      toast(explain(err));
    }
  }

  private async startRename(row: HTMLElement) {
    const path = row.dataset.path!;
    const nameEl = row.querySelector<HTMLElement>(".name")!;
    nameEl.hidden = true;
    const name = await this.inlineInput(row, baseName(path), !row.classList.contains("dir"));
    nameEl.hidden = false;
    if (!name || name === baseName(path)) return;
    try {
      const to = await invoke<string>("rename_entry", { path, name });
      this.renamed(path, to);
    } catch (err) {
      toast(explain(err));
    }
  }

  private async trash(path: string) {
    try {
      await invoke("trash_entry", { path });
      toast(t("Moved to the Recycle Bin: {name}", { name: baseName(path) }));
      if (this.selectedPath === path) this.selectedPath = null;
      this.refreshSoon();
    } catch (err) {
      toast(explain(err));
    }
  }

  /** "Add files…": copies the picked files into the folder. */
  private async pickAndAdd(dir: string) {
    const picked = await open({ multiple: true, directory: false });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length) await this.addFiles(paths, dir);
  }

  /** Copies files from elsewhere into a folder of the project and shows them. */
  async addFiles(paths: string[], dir: string) {
    try {
      const added = await invoke<string[]>("copy_into", { paths, toDir: dir });
      if (key(dir) !== key(this.root)) this.expanded.add(dir);
      this.sel = new Set(added);
      this.selectedPath = added[0] ?? null;
      await this.rebuild(new Set(this.expanded));
      toast(added.length === 1 ? t("Added {name}", { name: baseName(added[0]) }) : t("Added {n} items", { n: added.length }));
    } catch (err) {
      toast(explain(err));
    }
  }

  private externalOver: HTMLElement | null = null;

  /**
   * Files dragged in from Explorer: over the tree, the folder they would land in lights up, and
   * a drop copies them there. Returns whether the point is over the tree (else: not ours).
   */
  externalDrag(paths: string[], target: Element | null, drop: boolean): boolean {
    this.externalOver?.classList.remove("drop-into");
    this.externalOver = null;
    this.el.classList.remove("drop-root");
    const sidebar = target?.closest("#sidebar");
    if (!sidebar || !this.root || !paths.length || target?.closest("#search-view")) return false;
    const inRows = this.el.contains(target!);
    const d = inRows ? this.dropDir(target, []) : { dir: this.root, row: null };
    if (!d) return true;
    if (drop) {
      this.addFiles(paths, d.dir);
      return true;
    }
    if (d.row) {
      this.externalOver = d.row;
      d.row.classList.add("drop-into");
    } else this.el.classList.add("drop-root");
    return true;
  }

  private async trashMany(paths: string[]) {
    if (paths.length === 1) return this.trash(paths[0]);
    // Folders first absorb their own selected contents.
    const top = paths.filter((p) => !paths.some((q) => q !== p && (key(p).startsWith(key(q) + "\\") || key(p).startsWith(key(q) + "/"))));
    let done = 0;
    for (const p of top) {
      try {
        await invoke("trash_entry", { path: p });
        done++;
      } catch (err) {
        toast(explain(err));
      }
    }
    if (done) toast(t("Moved {n} items to the Recycle Bin", { n: done }));
    this.sel.clear();
    this.selectedPath = null;
    this.refreshSoon();
  }

  private async move(path: string, toDir: string) {
    if (key(parentOf(path)) === key(toDir)) return;
    try {
      const to = await invoke<string>("move_entry", { path, toDir });
      if (this.rowOf(toDir)) this.expanded.add(toDir);
      this.renamed(path, to);
    } catch (err) {
      toast(explain(err));
    }
  }

  /** After a rename or move: keep open folders open and the item selected. */
  private renamed(from: string, to: string) {
    const fk = key(from);
    this.expanded = new Set(
      [...this.expanded].map((p) => (key(p) === fk || key(p).startsWith(fk + "\\") || key(p).startsWith(fk + "/") ? to + p.slice(from.length) : p)),
    );
    this.selectedPath = to;
    this.refreshSoon();
  }

  // ── dragging ──────────────────────────────────────────

  /** The folder a drop at this point would move into, or null if the point is not in the tree. */
  private dropDir(target: Element | null, from: string[]): { dir: string; row: HTMLElement | null } | null {
    if (!target || !this.el.contains(target)) return null;
    const row = target.closest<HTMLElement>(".node");
    if (!row) return { dir: this.root, row: null };
    if (from.includes(row.dataset.path!)) return null;
    if (row.classList.contains("dir")) return { dir: row.dataset.path!, row };
    const dir = parentOf(row.dataset.path!);
    return { dir, row: this.rowOf(dir) };
  }

  /**
   * Dragging with pointer events rather than HTML drag-and-drop: the window takes native drops
   * (files from Explorer), which turns HTML drag-and-drop off inside the page on Windows.
   */
  private onPointerDown(down: PointerEvent) {
    const row = (down.target as HTMLElement).closest<HTMLElement>(".node");
    if (down.button !== 0) return;
    if (!row) return this.selectBox(down);
    if (row.querySelector("input")) return;
    const path = row.dataset.path!;
    // Dragging a selected row takes the whole selection along.
    const paths = this.sel.has(path) && this.sel.size > 1 ? this.selection : [path];
    let ghost: HTMLElement | null = null;
    let over: HTMLElement | null = null;
    const highlight = (el: HTMLElement | null) => {
      if (el === over) return;
      over?.classList.remove("drop-into");
      over = el;
      over?.classList.add("drop-into");
    };
    const move = (e: PointerEvent) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - down.clientX, e.clientY - down.clientY) < 6) return;
        ghost = document.createElement("div");
        ghost.className = "drag-ghost";
        ghost.textContent = paths.length > 1 ? t("{n} items", { n: paths.length }) : row.querySelector(".name")!.textContent;
        document.body.append(ghost);
        document.body.classList.add("dragging");
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
      const drop = this.dropDir(document.elementFromPoint(e.clientX, e.clientY), paths);
      highlight(drop?.row ?? null);
      this.el.classList.toggle("drop-root", !!drop && !drop.row);
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      highlight(null);
      this.el.classList.remove("drop-root");
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("dragging");
      if (e.type !== "pointerup") return;
      // A click that follows the drag (released over the same row) must not select or toggle it.
      const swallow = (c: MouseEvent) => c.stopPropagation();
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const drop = this.dropDir(target, paths);
      if (drop) {
        // Skip a folder dropped into itself; move the rest one by one.
        for (const p of paths) {
          if (key(drop.dir) === key(p) || key(drop.dir).startsWith(key(p) + "\\") || key(drop.dir).startsWith(key(p) + "/")) continue;
          this.move(p, drop.dir);
        }
      } else if (!this.el.contains(target)) this.onDragOut(paths, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  /**
   * Pressing on empty space and dragging draws a box; the rows it touches are selected
   * (with Ctrl held, added to the selection). A click on empty space clears the selection.
   */
  private selectBox(down: PointerEvent) {
    if (down.target !== this.el && !(down.target as HTMLElement).closest("#tree")) return;
    const box = this.el.getBoundingClientRect();
    const y0 = down.clientY - box.top + this.el.scrollTop;
    const x0 = down.clientX - box.left;
    const keep = down.ctrlKey || down.metaKey ? new Set(this.sel) : new Set<string>();
    let lasso: HTMLElement | null = null;
    const move = (e: PointerEvent) => {
      const y1 = e.clientY - box.top + this.el.scrollTop;
      const x1 = e.clientX - box.left;
      if (!lasso) {
        if (Math.hypot(x1 - x0, y1 - y0) < 4) return;
        lasso = document.createElement("div");
        lasso.className = "tree-lasso";
        this.el.append(lasso);
      }
      const top = Math.min(y0, y1);
      const bottom = Math.max(y0, y1);
      Object.assign(lasso.style, {
        left: `${Math.min(x0, x1)}px`,
        top: `${top}px`,
        width: `${Math.abs(x1 - x0)}px`,
        height: `${bottom - top}px`,
      });
      // Scroll along when the box reaches the edge.
      if (e.clientY > box.bottom - 16) this.el.scrollTop += 12;
      else if (e.clientY < box.top + 16) this.el.scrollTop -= 12;
      this.sel = new Set(keep);
      for (const r of this.el.querySelectorAll<HTMLElement>(".node[data-path]")) {
        const rt = r.offsetTop;
        if (rt + r.offsetHeight > top && rt < bottom) this.sel.add(r.dataset.path!);
      }
      this.paintSelection();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!lasso) {
        if (!keep.size) this.select(null);
        return;
      }
      lasso.remove();
      const first = this.selection[0];
      this.selectedPath = first ?? null;
      this.anchor = first ?? null;
      this.paintSelection();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
}
