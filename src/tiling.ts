/**
 * Window mode: every tab becomes a small window inside the terminal area (the file tree and Tern's
 * own window stay put). Windows can be moved by their title bar (or Alt+drag anywhere), resized
 * from any edge or corner, and are raised on click. On first use they are laid out in a tidy grid
 * with even gaps; after that they stay where you put them. Positions are fractions of the area, so
 * they scale with the window.
 */

import { setKind } from "./marks";

export interface Tile {
  key: string;
  pane: HTMLElement;
  /** "claude", "shell". */
  kind: string;
  label: string;
  /** Claude's state ("idle", "working", "done"), for the spark in the title bar. */
  activity?: string;
  active: boolean;
  /**
   * Its own title bar instead of the standard one (the editor brings its header: file name,
   * unsaved dot, text / preview, close). It goes back to `headHome` when the window goes away.
   */
  head?: HTMLElement;
  headHome?: HTMLElement;
  /** Height of that title bar in px (the standard one is 24). */
  bar?: number;
  /** Content fills the window edge to edge (no inner margin, as a terminal has). */
  flush?: boolean;
  /** Size in px when it first opens, centred (otherwise half the area, cascaded). */
  size?: [number, number];
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

/**
 * "tiling": like Hyprland's dwindle layout — windows share the area as a tree of splits; a new
 * window halves the focused one along its longer side, closing one gives its space to its
 * neighbour, and dragging a border resizes both sides. "floating": free windows.
 */
export type Layout = "tiling" | "floating";

type Leaf = { key: string };
type Split = { dir: "v" | "h"; ratio: number; a: Node; b: Node };
type Node = Leaf | Split;
const isLeaf = (n: Node): n is Leaf => "key" in n;

function keysOf(n: Node | null): string[] {
  if (!n) return [];
  return isLeaf(n) ? [n.key] : [...keysOf(n.a), ...keysOf(n.b)];
}

/** The tree without that window: its sibling takes the whole split. */
function removeLeaf(n: Node | null, key: string): Node | null {
  if (!n) return null;
  if (isLeaf(n)) return n.key === key ? null : n;
  const a = removeLeaf(n.a, key);
  const b = removeLeaf(n.b, key);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

/** Splits window `target` in two: `key` goes before (left/top) or after (right/bottom) it. */
function splitLeaf(n: Node, target: string, key: string, dir: "v" | "h", before: boolean): Node {
  if (isLeaf(n)) {
    if (n.key !== target) return n;
    const add: Leaf = { key };
    return { dir, ratio: 0.5, a: before ? add : n, b: before ? n : add };
  }
  return { ...n, a: splitLeaf(n.a, target, key, dir, before), b: splitLeaf(n.b, target, key, dir, before) };
}

function swapLeaves(n: Node, x: string, y: string): Node {
  if (isLeaf(n)) return n.key === x ? { key: y } : n.key === y ? { key: x } : n;
  return { ...n, a: swapLeaves(n.a, x, y), b: swapLeaves(n.b, x, y) };
}

/** Every window's rect, and every split's region (for resizing). */
function walk(n: Node, r: Rect, out: Map<string, Rect>, splits: { split: Split; region: Rect; path: string[] }[] = []) {
  if (isLeaf(n)) {
    out.set(n.key, r);
    return splits;
  }
  const [x, y, w, h] = r;
  const ra: Rect = n.dir === "v" ? [x, y, w * n.ratio, h] : [x, y, w, h * n.ratio];
  const rb: Rect = n.dir === "v" ? [x + w * n.ratio, y, w * (1 - n.ratio), h] : [x, y + h * n.ratio, w, h * (1 - n.ratio)];
  splits.push({ split: n, region: r, path: keysOf(n) });
  walk(n.a, ra, out, splits);
  walk(n.b, rb, out, splits);
  return splits;
}

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
  private mode: Layout = "tiling";
  /** Tiling mode: the tree of splits, the window rects it gives, and a full-size window. */
  private tree: Node | null = null;
  private tiled = new Map<string, Rect>();
  private maxKey: string | null = null;
  /** The window new ones split (the focused one). */
  private focusKey: string | null = null;

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

  get layoutMode() {
    return this.mode;
  }

  setMode(mode: Layout) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.maxKey = null;
    if (this.tiles.length) this.layout(this.tiles);
  }

  /** Tiling mode: brings the tree in line with the open windows. */
  private syncTree(tiles: Tile[]) {
    const keys = new Set(tiles.map((t) => t.key));
    for (const k of keysOf(this.tree)) if (!keys.has(k)) this.tree = removeLeaf(this.tree, k);
    if (this.maxKey && !keys.has(this.maxKey)) this.maxKey = null;
    const present = new Set(keysOf(this.tree));
    for (const t of tiles) {
      if (present.has(t.key)) continue;
      if (!this.tree) {
        this.tree = { key: t.key };
      } else {
        // Split the focused window (else the last one) along its longer side; the new one goes
        // right or below.
        const inTree = keysOf(this.tree);
        const target = this.focusKey && inTree.includes(this.focusKey) ? this.focusKey : inTree[inTree.length - 1];
        const rects = new Map<string, Rect>();
        walk(this.tree, [0, 0, 1, 1], rects);
        const r = rects.get(target)!;
        const a = this.area();
        const dir = r[2] * a.w >= r[3] * a.h ? "v" : "h";
        this.tree = splitLeaf(this.tree, target, t.key, dir, false);
      }
      present.add(t.key);
      this.focusKey = t.key;
    }
    this.tiled.clear();
    if (this.tree) walk(this.tree, [0, 0, 1, 1], this.tiled);
  }

  /** Where a window is drawn now. */
  private rectOf(key: string): Rect | undefined {
    if (this.mode === "floating") return this.rects.get(key);
    if (this.maxKey === key) return [0, 0, 1, 1];
    return this.tiled.get(key);
  }

  /** Shows the windows (call again whenever tabs open, close or change). */
  layout(tiles: Tile[]) {
    this.tiles = tiles;
    const focused = tiles.find((t) => t.active);
    if (this.mode === "tiling") {
      this.syncTree(tiles);
      if (focused) this.focusKey = focused.key;
      this.order = [...this.order.filter((k) => tiles.some((t) => t.key === k)), ...tiles.map((t) => t.key).filter((k) => !this.order.includes(k))];
      if (focused) this.order = [...this.order.filter((k) => k !== focused.key), focused.key];
      if (this.maxKey) this.order = [...this.order.filter((k) => k !== this.maxKey), this.maxKey];
      this.host.classList.add("wm-tiling");
      this.render();
      return;
    }
    this.host.classList.remove("wm-tiling");
    const keys = new Set(tiles.map((t) => t.key));
    for (const k of [...this.rects.keys()]) if (!keys.has(k)) this.rects.delete(k);
    this.order = this.order.filter((k) => keys.has(k));
    const fresh = tiles.filter((t) => !this.rects.has(t.key));
    if (fresh.length === tiles.length) this.arrange(false);
    else for (const t of fresh) this.rects.set(t.key, t.size ? this.centred(t.size) : this.cascade());
    for (const t of tiles) if (!this.order.includes(t.key)) this.order.push(t.key);
    // The active window comes to the front.
    const active = tiles.find((t) => t.active);
    if (active) this.order = [...this.order.filter((k) => k !== active.key), active.key];
    this.render();
  }

  /** Lays every window out again: tiling rebuilds the splits, floating makes an even grid. */
  arrange(notify = true) {
    if (this.mode === "tiling") {
      this.tree = null;
      this.maxKey = null;
      this.focusKey = null;
      this.syncTree(this.tiles);
      if (notify) {
        this.render();
        this.onChange();
      }
      return;
    }
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
    this.host.classList.remove("wm-tiling");
    this.maxKey = null;
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

  /** A rect of this size in px, in the middle of the area (shrunk to fit). */
  private centred([pw, ph]: [number, number]): Rect {
    const a = this.area();
    const w = Math.min(1, (pw + GAP) / a.w);
    const h = Math.min(1, (ph + GAP) / a.h);
    return [(1 - w) / 2, (1 - h) / 2, w, h];
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
        setKind(frame.querySelector<HTMLElement>(".win-kind")!, t.kind);
        frame.querySelector(".win-label")!.textContent = t.label;
      }
      if (t.activity) frame.dataset.activity = t.activity;
      frame.classList.toggle("claude", t.kind === "claude");
      frame.classList.toggle("shell", t.kind !== "claude");
      frame.classList.toggle("active", t.active);
      t.pane.classList.toggle("active-tile", t.active);
      t.pane.hidden = false;
      this.position(t.key);
    }
  }

  /** Puts a window's frame and terminal where its rect says. */
  private position(key: string) {
    const r = this.rectOf(key);
    const frame = this.chrome.get(key);
    const tile = this.tiles.find((t) => t.key === key);
    if (!r || !frame || !tile) return;
    const b = this.box(r);
    const z = 10 + this.order.indexOf(key) * 2;
    Object.assign(frame.style, {
      left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, zIndex: String(z),
    });
    const bar = tile.bar ?? BAR;
    Object.assign(
      tile.pane.style,
      tile.flush
        ? { left: `${b.left + 1}px`, top: `${b.top + bar}px`, width: `${b.width - 2}px`, height: `${b.height - bar - 1}px` }
        : {
            left: `${b.left + PAD}px`,
            top: `${b.top + bar + PAD / 2}px`,
            width: `${b.width - PAD * 2}px`,
            height: `${b.height - bar - PAD * 1.5}px`,
          },
      { zIndex: String(z + 1) },
    );
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
    if (this.mode === "tiling") {
      this.maxKey = this.maxKey === key ? null : key;
      this.raise(key);
      return;
    }
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
    if (this.mode === "tiling") return this.dragTile(key, e);
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
    if (this.mode === "tiling") return this.resizeTile(key, edge);
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

  // ── tiling mode: moving and resizing inside the tree ──

  /**
   * Drag a window onto another: over its middle the two swap places; near an edge the dragged
   * window goes on that side, sharing the other's space. A highlight shows where it will land.
   */
  private dragTile(key: string, e: PointerEvent) {
    if (this.maxKey) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const tile = this.tiles.find((t) => t.key === key);
    let ghost: HTMLElement | null = null;
    const zone = document.createElement("div");
    zone.className = "wm-drop";
    zone.hidden = true;
    this.host.append(zone);
    let drop: { target: string; side: "c" | "l" | "r" | "t" | "b" } | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      if (!ghost) {
        ghost = document.createElement("div");
        ghost.className = "wm-ghost";
        ghost.textContent = tile?.label || tile?.kind || "";
        document.body.append(ghost);
        document.body.classList.add("win-moving");
      }
      ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 10}px)`;
      drop = null;
      zone.hidden = true;
      const host = this.host.getBoundingClientRect();
      for (const [k, r] of this.tiled) {
        if (k === key) continue;
        const b = this.box(r);
        const left = host.left + b.left;
        const top = host.top + b.top;
        const fx = (ev.clientX - left) / b.width;
        const fy = (ev.clientY - top) / b.height;
        if (fx < 0 || fx > 1 || fy < 0 || fy > 1) continue;
        // The middle swaps; otherwise the nearest edge.
        const side =
          fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7
            ? "c"
            : (["l", "r", "t", "b"] as const)[[fx, 1 - fx, fy, 1 - fy].indexOf(Math.min(fx, 1 - fx, fy, 1 - fy))];
        drop = { target: k, side };
        const z = { left: b.left, top: b.top, width: b.width, height: b.height };
        if (side === "l" || side === "r") z.width /= 2;
        if (side === "r") z.left += z.width;
        if (side === "t" || side === "b") z.height /= 2;
        if (side === "b") z.top += z.height;
        Object.assign(zone.style, { left: `${z.left}px`, top: `${z.top}px`, width: `${z.width}px`, height: `${z.height}px` });
        zone.hidden = false;
        break;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      document.body.classList.remove("win-moving");
      zone.remove();
      if (!ghost) return;
      (ghost as HTMLElement).remove();
      const d = drop as { target: string; side: "c" | "l" | "r" | "t" | "b" } | null;
      if (!d || !this.tree) return;
      if (d.side === "c") {
        this.tree = swapLeaves(this.tree, key, d.target);
      } else {
        const rest = removeLeaf(this.tree, key);
        if (!rest) return;
        const dir = d.side === "l" || d.side === "r" ? "v" : "h";
        this.tree = splitLeaf(rest, d.target, key, dir, d.side === "l" || d.side === "t");
      }
      this.tiled.clear();
      walk(this.tree, [0, 0, 1, 1], this.tiled);
      this.render();
      this.onChange();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  /**
   * Drag a window's edge: the split between it and its neighbour moves, so both change size.
   * An outline shows the window's new size; the layout changes on release.
   */
  private resizeTile(key: string, edge: Edge) {
    if (!this.tree || this.maxKey) return;
    const splits = walk(this.tree, [0, 0, 1, 1], new Map());
    // The deepest split whose border is this edge of the window.
    const find = (dir: "v" | "h", first: boolean) => {
      for (let i = splits.length - 1; i >= 0; i--) {
        const s = splits[i];
        if (s.split.dir !== dir) continue;
        const side = keysOf(first ? s.split.a : s.split.b);
        if (side.includes(key)) return s;
      }
      return null;
    };
    const hs = edge.includes("e") ? find("v", true) : edge.includes("w") ? find("v", false) : null;
    const vs = edge.includes("s") ? find("h", true) : edge.includes("n") ? find("h", false) : null;
    if (!hs && !vs) return;
    const a = this.area();
    const hostBox = this.host.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.className = "win-ghost";
    this.host.append(ghost);
    const start = { h: hs?.split.ratio, v: vs?.split.ratio };
    const draw = () => {
      const rects = new Map<string, Rect>();
      walk(this.tree!, [0, 0, 1, 1], rects);
      const b = this.box(rects.get(key)!);
      Object.assign(ghost.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    };
    draw();
    document.body.dataset.winResize = edge;
    const move = (ev: PointerEvent) => {
      const fx = (ev.clientX - hostBox.left - GAP / 2) / a.w;
      const fy = (ev.clientY - hostBox.top - GAP / 2) / a.h;
      if (hs) hs.split.ratio = Math.min(0.9, Math.max(0.1, (fx - hs.region[0]) / hs.region[2]));
      if (vs) vs.split.ratio = Math.min(0.9, Math.max(0.1, (fy - vs.region[1]) / vs.region[3]));
      draw();
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      ghost.remove();
      delete document.body.dataset.winResize;
      if (ev.type !== "pointerup") {
        if (hs && start.h !== undefined) hs.split.ratio = start.h;
        if (vs && start.v !== undefined) vs.split.ratio = start.v;
      }
      this.tiled.clear();
      walk(this.tree!, [0, 0, 1, 1], this.tiled);
      this.render();
      this.onChange();
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }
}
