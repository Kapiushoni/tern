import { invoke } from "@tauri-apps/api/core";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Lazy file tree: a folder's children are read only when it is expanded. */
export class FileTree {
  private showHidden = false;
  private expanded = new Set<string>();
  /** Expanded folders per project root, so switching tabs keeps each tree as it was. */
  private memory = new Map<string, Set<string>>();
  private selected: HTMLElement | null = null;
  root = "";

  constructor(private el: HTMLElement) {
    el.addEventListener("click", (e) => this.onClick(e));
  }

  async open(root: string) {
    if (root === this.root) return;
    if (this.root) this.memory.set(this.root, new Set(this.expanded));
    this.root = root;
    await this.rebuild(this.memory.get(root) ?? new Set());
  }

  async setShowHidden(v: boolean) {
    this.showHidden = v;
    await this.rebuild(new Set(this.expanded));
  }

  private async rebuild(keep: Set<string>) {
    const root = this.root;
    const frag = document.createElement("div");
    this.expanded = new Set();
    await this.renderChildren(root, frag, 0, true);
    // Re-open what was open, top-down.
    for (const path of [...keep].sort((a, b) => a.length - b.length)) {
      const row = frag.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
      if (row) await this.toggle(row);
    }
    if (root !== this.root) return; // another open() won the race
    this.el.replaceChildren(...frag.childNodes);
    this.selected = null;
  }

  private async renderChildren(dir: string, after: HTMLElement, depth: number, inside = false) {
    let entries: Entry[];
    try {
      entries = await invoke<Entry[]>("list_dir", { path: dir, showHidden: this.showHidden });
    } catch {
      return;
    }
    const frag = document.createDocumentFragment();
    for (const e of entries) frag.append(this.row(e, depth));
    if (inside || after === this.el) after.append(frag);
    else after.after(frag);
  }

  private row(e: Entry, depth: number): HTMLElement {
    const row = document.createElement("div");
    row.className = `node ${e.is_dir ? "dir" : "file"}`;
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
    return row;
  }

  private async onClick(ev: MouseEvent) {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".node");
    if (!row) return;
    this.selected?.classList.remove("selected");
    row.classList.add("selected");
    this.selected = row;
    if (row.classList.contains("dir")) await this.toggle(row);
  }

  private async toggle(row: HTMLElement) {
    const path = row.dataset.path!;
    const depth = Number(row.dataset.depth);
    const twisty = row.querySelector(".twisty")!;
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      row.setAttribute("aria-expanded", "false");
      twisty.textContent = "›";
      let next = row.nextElementSibling as HTMLElement | null;
      while (next && Number(next.dataset.depth) > depth) {
        const n = next.nextElementSibling as HTMLElement | null;
        if (next.dataset.path) this.expanded.delete(next.dataset.path);
        next.remove();
        next = n;
      }
    } else {
      this.expanded.add(path);
      row.setAttribute("aria-expanded", "true");
      twisty.textContent = "⌄";
      await this.renderChildren(path, row, depth + 1);
    }
  }
}
