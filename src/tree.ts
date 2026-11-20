import { invoke } from "@tauri-apps/api/core";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  hidden: boolean;
}

/** Lazy file tree: a folder's children are read only when it is expanded. */
export class FileTree {
  private showHidden = false;
  private expanded = new Set<string>();
  /** Expanded folders per project root, so switching tabs keeps each tree as it was. */
  private memory = new Map<string, Set<string>>();
  private selected: HTMLElement | null = null;
  root = "";
  /** A row was dragged out of the tree and dropped on `target` (the element under the pointer). */
  onDragOut: (path: string, target: Element | null) => void = () => {};

  constructor(private el: HTMLElement) {
    el.addEventListener("click", (e) => this.onClick(e));
    el.addEventListener("pointerdown", (e) => this.onPointerDown(e));
  }

  /**
   * Dragging with pointer events rather than HTML drag-and-drop: the window takes native drops
   * (files from Explorer), which turns HTML drag-and-drop off inside the page on Windows.
   */
  private onPointerDown(down: PointerEvent) {
    const row = (down.target as HTMLElement).closest<HTMLElement>(".node");
    if (!row || down.button !== 0) return;
    let ghost: HTMLElement | null = null;
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
    };
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove("dragging");
      if (e.type === "pointerup") {
        // A click that follows the drag (released over the same row) must not select or toggle it.
        const swallow = (c: MouseEvent) => c.stopPropagation();
        window.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
        this.onDragOut(row.dataset.path!, document.elementFromPoint(e.clientX, e.clientY));
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
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
      await this.renderChildren(path, row, depth + 1, false, row.classList.contains("hidden-entry"));
    }
  }
}
