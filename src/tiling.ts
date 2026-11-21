/**
 * Window mode: every tab becomes a small window inside the terminal area (the file tree and Tern's
 * own window stay put). Windows can be moved by their title bar (or Alt+drag anywhere), resized
 * from any edge or corner, and are raised on click. On first use they are laid out in a tidy grid
 * with even gaps; after that they stay where you put them. Positions are fractions of the area, so
 * they scale with the window.
 */

export interface Tile {
  key: string;
  pane: HTMLElement;
  /** "claude", "shell". */
  kind: string;
  label: string;
  active: boolean;
  /**
   * Its own title bar instead of the standard one (the editor brings its header: file name,
   * unsaved dot, text / preview, close). It goes back to `headHome` when the window goes away.
   */
  head?: HTMLElement;
  headHome?: HTMLElement;
}

/** x, y, w, h as fractions of the terminal area. */
export type Rect = [number, number, number, number];

const GAP = 10; // px: around the edges and between windows in the automatic layout
const BAR = 24; // px: title bar
const PAD = 6; // px: around the terminal inside a window
const SNAP = 8; // px: edges this close snap together
const MIN_W = 220;
const MIN_H = 120;

/** How many windows go in each column of the automatic layout: as square as possible. */
function columnsFor(n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [1];
  const cols = Math.ceil(Math.sqrt(n));
  const base = Math.floor(n / cols);
  const extra = n % cols;
  return Array.from({ length: cols }, (_, i) => base + (i >= cols - extra ? 1 : 0));
}

type Edge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export class Tiler {
  /** Positions changed (moved, resized, arranged): save them. */
  onChange: () => void = () => {};
  /** A window's close button. */
  onClose: (key: string) => void = () => {};
  /** A window was clicked: make its tab the active one. */
  onFocus: (key: string) => void = () => {};

  private rects = new Map<string, Rect>();
  /** Bottom to top. */
  private order: string[] = [];
  /** A window maximised by double-click remembers where it was. */
  private restore = new Map<string, Rect>();
  private chrome = new Map<string, HTMLElement>();
  private tiles: Tile[] = [];

  constructor(private host: HTMLElement) {
    // Double-click on the empty backdrop: arrange all windows again.
    host.addEventListener("dblclick", (e) => {
      if (e.target === host) this.arrange();
    });
    new ResizeObserver(() => this.tiles.length && this.render()).observe(host);
  }

  /** Saved positions, by tab key. */
  get saved(): Map<string, Rect> {
    return this.rects;
  }

  setRect(key: string, r: Rect | undefined) {
    if (r && r.length === 4 && r.every((v) => Number.isFinite(v))) this.rects.set(key, r);
  }

  /** Shows the windows (call again whenever tabs open, close or change). */
  layout(tiles: Tile[]) {
    this.tiles = tiles;
    const keys = new Set(tiles.map((t) => t.key));
    for (const k of [...this.rects.keys()]) if (!keys.has(k)) this.rects.delete(k);
    this.order = this.order.filter((k) => keys.has(k));
    const fresh = tiles.filter((t) => !this.rects.has(t.key));
    if (fresh.length === tiles.length) this.arrange(false);
    else for (const t of fresh) this.rects.set(t.key, this.cascade());
    for (const t of tiles) if (!this.order.includes(t.key)) this.order.push(t.key);
    // The active window comes to the front.
    const active = tiles.find((t) => t.active);
    if (active) this.order = [...this.order.filter((k) => k !== active.key), active.key];
    this.render();
  }

  /** Lays every window out in a grid with even gaps. */
  arrange(notify = true) {
    const cols = columnsFor(this.tiles.length);
    let i = 0;
    cols.forEach((n, c) => {
      for (let r = 0; r < n; r++) {
        const t = this.tiles[i++];
        this.rects.set(t.key, [c / cols.length, r / n, 1 / cols.length, 1 / n]);
      }
    });
    this.restore.clear();
    if (notify) {
      this.render();
      this.onChange();
    }
  }

  /** Back to tabs: removes the window frames and the panes' positions. */
  reset(panes: HTMLElement[]) {
    for (const [k, el] of this.chrome) this.dropFrame(k, el);
    this.chrome.clear();
    this.tiles = [];
    for (const p of panes) {
      p.style.cssText = "";
      p.classList.remove("active-tile");
    }
  }

  /** A new window: a bit down and right of the top one, half the area. */
  private cascade(): Rect {
    const top = this.rects.get(this.order[this.order.length - 1] ?? "");
    const w = 0.5;
    const h = 0.6;
    if (!top) return [0.25, 0.2, w, h];
    let x = top[0] + 0.04;
    let y = top[1] + 0.05;
    if (x + w > 1) x = 0.02;
    if (y + h > 1) y = 0.02;
    return [x, y, w, h];
  }

  private area() {
    return { w: this.host.clientWidth - GAP, h: this.host.clientHeight - GAP };
  }

  /** Pixel box of a window (with the gap taken off, so neighbours show a seam). */
  private box(r: Rect) {
    const a = this.area();
    return {
      left: GAP / 2 + r[0] * a.w + GAP / 2,
      top: GAP / 2 + r[1] * a.h + GAP / 2,
      width: Math.max(MIN_W, r[2] * a.w - GAP),
      height: Math.max(MIN_H, r[3] * a.h - GAP),
    };
  }

  private render() {
    const keys = new Set(this.tiles.map((t) => t.key));
    for (const [k, el] of this.chrome) {
      if (!keys.has(k)) {
        this.dropFrame(k, el);
        this.chrome.delete(k);
      }
    }
    for (const t of this.tiles) {
      let frame = this.chrome.get(t.key);
      if (!frame) {
        frame = this.makeFrame(t);
        this.chrome.set(t.key, frame);
        this.host.append(frame);
      }
      if (!t.head) {
        frame.querySelector(".win-kind")!.textContent = t.kind;
        frame.querySelector(".win-label")!.textContent = t.label;
      }
      frame.classList.toggle("shell", t.kind !== "claude");
      frame.classList.toggle("active", t.active);
      t.pane.classList.toggle("active-tile", t.active);
      t.pane.hidden = false;
      this.position(t.key);
    }
  }

  /** Puts a window's frame and terminal where its rect says. */
  private position(key: string) {
    const r = this.rects.get(key);
    const frame = this.chrome.get(key);
    const tile = this.tiles.find((t) => t.key === key);
    if (!r || !frame || !tile) return;
    const b = this.box(r);
    const z = 10 + this.order.indexOf(key) * 2;
    Object.assign(frame.style, {
      left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, zIndex: String(z),
    });
    Object.assign(tile.pane.style, {
      left: `${b.left + PAD}px`,
      top: `${b.top + BAR + PAD / 2}px`,
      width: `${b.width - PAD * 2}px`,
      height: `${b.height - BAR - PAD * 1.5}px`,
      zIndex: String(z + 1),
    });
  }

  /** Removes a window's frame, first giving a borrowed title bar back to its owner. */
  private dropFrame(key: string, frame: HTMLElement) {
    const t = this.tiles.find((x) => x.key === key) ?? this.borrowed.get(key);
    if (t?.head && t.headHome) {
      t.head.classList.remove("win-bar");
      t.headHome.prepend(t.head);
    }
    this.borrowed.delete(key);
    frame.remove();
  }

  /** Tiles whose title bar is borrowed, kept so it can be returned. */
  private borrowed = new Map<string, Tile>();

  private makeFrame(t: Tile) {
    const f = document.createElement("div");
    f.className = "win-frame";
    f.dataset.key = t.key;
    f.innerHTML =
      (t.head
        ? ""
        : `<div class="win-bar"><span class="win-dot"></span><span class="win-kind"></span>` +
          `<span class="win-label"></span><button class="win-close" tabindex="-1">×</button></div>`) +
      (["n", "s", "e", "w", "ne", "nw", "se", "sw"] as Edge[]).map((e) => `<div class="win-edge ${e}" data-edge="${e}"></div>`).join("");
    let bar: HTMLElement;
    if (t.head) {
      bar = t.head;
      bar.classList.add("win-bar");
      f.prepend(bar);
      this.borrowed.set(t.key, t);
    } else {
      bar = f.querySelector<HTMLElement>(".win-bar")!;
      f.querySelector(".win-close")!.addEventListener("click", () => this.onClose(t.key));
    }
    // Buttons in the bar keep working; anywhere else on it drags the window.
    bar.addEventListener("pointerdown", (e) => {
      if (!f.isConnected || (e.target as HTMLElement).closest("button")) return;
      this.startMove(t.key, e);
    });
    bar.addEventListener("dblclick", (e) => {
      if (f.isConnected && !(e.target as HTMLElement).closest("button")) this.toggleMax(t.key);
    });
    f.querySelectorAll<HTMLElement>(".win-edge").forEach((h) =>
      h.addEventListener("pointerdown", (e) => this.startResize(t.key, h.dataset.edge as Edge, e)),
    );
    return f;
  }

  private raise(key: string) {
    this.order = [...this.order.filter((k) => k !== key), key];
    for (const k of this.order) this.position(k);
  }

  private toggleMax(key: string) {
    const was = this.restore.get(key);
    if (was) {
      this.rects.set(key, was);
      this.restore.delete(key);
    } else {
      this.restore.set(key, this.rects.get(key)!);
      this.rects.set(key, [0, 0, 1, 1]);
    }
    this.raise(key);
    this.onChange();
  }

  /** Moves a window with the pointer (title bar, or Alt+drag anywhere on it). Live: no resize. */
  startMove(key: string, e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    this.onFocus(key);
    this.raise(key);
    const r0 = this.rects.get(key)!;
    const a = this.area();
    const x0 = e.clientX;
    const y0 = e.clientY;
    this.restore.delete(key);
    document.body.classList.add("win-moving");
    const move = (ev: PointerEvent) => {
      let x = r0[0] + (ev.clientX - x0) / a.w;
      let y = r0[1] + (ev.clientY - y0) / a.h;
      [x, y] = this.snapMove(key, x, y, r0[2], r0[3]);
      this.rects.set(key, [x, y, r0[2], r0[3]]);
      this.position(key);
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      document.body.classList.remove("win-moving");
      this.onChange();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  /**
   * Resizes from an edge or corner. An outline follows the pointer and the window takes the new
   * size on release: resizing a terminal live makes it (and Claude Code) redraw on every frame.
   */
  private startResize(key: string, edge: Edge, e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this.onFocus(key);
    this.raise(key);
    this.restore.delete(key);
    const a = this.area();
    const r0 = this.rects.get(key)!;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const ghost = document.createElement("div");
    ghost.className = "win-ghost";
    this.host.append(ghost);
    let next: Rect = r0;
    const minW = (MIN_W + GAP) / a.w;
    const minH = (MIN_H + GAP) / a.h;
    const draw = () => {
      const b = this.box(next);
      Object.assign(ghost.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    };
    draw();
    document.body.dataset.winResize = edge;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / a.w;
      const dy = (ev.clientY - y0) / a.h;
      let [x, y, w, h] = r0;
      if (edge.includes("e")) w = Math.max(minW, Math.min(1 - x, r0[2] + dx));
      if (edge.includes("s")) h = Math.max(minH, Math.min(1 - y, r0[3] + dy));
      if (edge.includes("w")) {
        const nx = Math.max(0, Math.min(r0[0] + r0[2] - minW, r0[0] + dx));
        w = r0[2] + (r0[0] - nx);
        x = nx;
      }
      if (edge.includes("n")) {
        const ny = Math.max(0, Math.min(r0[1] + r0[3] - minH, r0[1] + dy));
        h = r0[3] + (r0[1] - ny);
        y = ny;
      }
      next = this.snapResize(key, [x, y, w, h], edge);
      draw();
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      ghost.remove();
      delete document.body.dataset.winResize;
      if (ev.type !== "pointerup") return;
      this.rects.set(key, next);
      this.position(key);
      this.onChange();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  /** Edges a moving or resized window can snap to: the area's and the other windows'. */
  private snapLines(key: string) {
    const xs = [0, 1];
    const ys = [0, 1];
    for (const [k, r] of this.rects) {
      if (k === key) continue;
      xs.push(r[0], r[0] + r[2]);
      ys.push(r[1], r[1] + r[3]);
    }
    return { xs, ys };
  }

  private snapMove(key: string, x: number, y: number, w: number, h: number): [number, number] {
    const a = this.area();
    const { xs, ys } = this.snapLines(key);
    const tx = SNAP / a.w;
    const ty = SNAP / a.h;
    const near = (v: number, lines: number[], t: number) => lines.find((l) => Math.abs(l - v) < t);
    const sx = near(x, xs, tx);
    const sx2 = near(x + w, xs, tx);
    if (sx !== undefined) x = sx;
    else if (sx2 !== undefined) x = sx2 - w;
    const sy = near(y, ys, ty);
    const sy2 = near(y + h, ys, ty);
    if (sy !== undefined) y = sy;
    else if (sy2 !== undefined) y = sy2 - h;
    // Keep at least the title bar reachable.
    x = Math.min(Math.max(x, -w + 0.1), 0.95);
    y = Math.min(Math.max(y, 0), 1 - (BAR + GAP) / a.h);
    return [x, y];
  }

  private snapResize(key: string, r: Rect, edge: Edge): Rect {
    const a = this.area();
    const { xs, ys } = this.snapLines(key);
    const near = (v: number, lines: number[], t: number) => lines.find((l) => Math.abs(l - v) < t);
    let [x, y, w, h] = r;
    if (edge.includes("e")) {
      const s = near(x + w, xs, SNAP / a.w);
      if (s !== undefined) w = s - x;
    }
    if (edge.includes("s")) {
      const s = near(y + h, ys, SNAP / a.h);
      if (s !== undefined) h = s - y;
    }
    if (edge.includes("w")) {
      const s = near(x, xs, SNAP / a.w);
      if (s !== undefined) {
        w += x - s;
        x = s;
      }
    }
    if (edge.includes("n")) {
      const s = near(y, ys, SNAP / a.h);
      if (s !== undefined) {
        h += y - s;
        y = s;
      }
    }
    return [x, y, w, h];
  }
}
