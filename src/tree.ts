import { invoke } from "@tauri-apps/api/core";
import { toast } from "./toast";
import { t } from "./i18n";

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
  private selectedPath: string | null = null;
  private git = new Map<string, GitState>();
  private refreshTimer = 0;
  private menu: HTMLElement;
  root = "";

  /** The highlighted row's path, if any. */
  get selected(): string | null {
    return this.selectedPath;
  }

  /** A row was dragged out of the tree and dropped on `target` (the element under the pointer). */
  onDragOut: (path: string, target: Element | null) => void = () => {};
  onOpen: (path: string) => void = () => {};
  onAskClaude: (path: string) => void = () => {};
  onOpenInIde: (path: string) => void = () => {};
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
    if (this.selectedPath) this.rowOf(this.selectedPath)?.classList.add("selected");
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
    row.append(twisty, name);
    if (e.is_dir) row.setAttribute("aria-expanded", "false");
    this.paintGit(row);
    return row;
  }

  private rowOf(path: string) {
    return this.el.querySelector<HTMLElement>(`.node[data-path="${CSS.escape(path)}"]`);
  }

  // ── clicks and keys ───────────────────────────────────

  private select(row: HTMLElement | null) {
    this.el.querySelector(".node.selected")?.classList.remove("selected");
    row?.classList.add("selected");
    this.selectedPath = row?.dataset.path ?? null;
  }

  private async onClick(ev: MouseEvent) {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".node");
    if (!row || row.querySelector("input")) return;
    this.select(row);
    if (row.classList.contains("dir")) await this.toggle(row);
    else this.onOpen(row.dataset.path!);
  }

  private onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const row = this.selectedPath ? this.rowOf(this.selectedPath) : null;
    if (!row) return;
    if (e.key === "F2") this.startRename(row);
    else if (e.key === "Delete") this.trash(row.dataset.path!);
    else if (e.key === "Enter") row.click();
    else return;
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
    await this.renderChildren(path, row, Number(row.dataset.depth) + 1, false, row.classList.contains("hidden-entry"));
  }

  // ── context menu ──────────────────────────────────────

  private menuItems: MenuItem[] = [];

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    const row = (e.target as HTMLElement).closest<HTMLElement>(".node");
    this.select(row);
    const path = row?.dataset.path ?? this.root;
    const isDir = !row || row.classList.contains("dir");
    const dir = isDir ? path : parentOf(path);
    const items: (MenuItem | null)[] = [];
    if (row && !isDir) items.push({ label: t("Open"), run: () => this.onOpen(path) });
    if (row) items.push({ label: isDir ? t("Ask Claude about this folder") : t("Ask Claude about this file"), run: () => this.onAskClaude(path) });
    if (row) items.push(null);
    items.push(
      { label: t("New file"), run: () => this.startCreate(dir, false) },
      { label: t("New folder"), run: () => this.startCreate(dir, true) },
    );
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
    temp.append(twisty);
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
  private dropDir(target: Element | null, from: string): { dir: string; row: HTMLElement | null } | null {
    if (!target || !this.el.contains(target)) return null;
    const row = target.closest<HTMLElement>(".node");
    if (!row) return { dir: this.root, row: null };
    if (row.dataset.path === from) return null;
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
    if (!row || down.button !== 0 || row.querySelector("input")) return;
    const path = row.dataset.path!;
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
        ghost.textContent = row.querySelector(".name")!.textContent;
        document.body.append(ghost);
        document.body.classList.add("dragging");
      }
      ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY + 8}px)`;
      const drop = this.dropDir(document.elementFromPoint(e.clientX, e.clientY), path);
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
      const drop = this.dropDir(target, path);
      if (drop) this.move(path, drop.dir);
      else if (!this.el.contains(target)) this.onDragOut(path, target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }
}
