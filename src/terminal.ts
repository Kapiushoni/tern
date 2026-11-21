import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

export type TermKind = "claude" | "shell";

const DARK = {
  background: "#0b0a0d",
  foreground: "#d9d4de",
  cursor: "#ff2e88",
  cursorAccent: "#0b0a0d",
  selectionBackground: "rgba(255, 46, 136, 0.30)",
  black: "#1b1820", brightBlack: "#5a5263",
  red: "#ff5c7a", brightRed: "#ff8aa0",
  green: "#5ef0a8", brightGreen: "#8cf7c3",
  yellow: "#ffcf5c", brightYellow: "#ffe08f",
  blue: "#6ab0ff", brightBlue: "#9bcaff",
  magenta: "#ff2e88", brightMagenta: "#ff6fae",
  cyan: "#4fe3e8", brightCyan: "#86eef1",
  // ANSI "white" is the secondary-text gray (hints, suggestions in Claude Code's ANSI theme);
  // bright white is the real white.
  white: "#9a93a3", brightWhite: "#ffffff",
};

/** Light: the same roles, darkened enough to read on a light background. */
const LIGHT = {
  background: "#f7f5f9",
  foreground: "#2a2530",
  cursor: "#d6006e",
  cursorAccent: "#f7f5f9",
  selectionBackground: "rgba(214, 0, 110, 0.18)",
  black: "#e4dfe9", brightBlack: "#9a93a3",
  red: "#c8102e", brightRed: "#e0314f",
  green: "#0b7a45", brightGreen: "#13995a",
  yellow: "#8f5b00", brightYellow: "#a86b00",
  blue: "#1d5fc2", brightBlue: "#2f74d8",
  magenta: "#d6006e", brightMagenta: "#e8338a",
  cyan: "#0a7c84", brightCyan: "#0e9199",
  white: "#7c7486", brightWhite: "#1d1922",
};

export type ThemeName = "dark" | "light";
let theme = DARK;

/** Hex colour → rgba() with this opacity. */
function alpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * Switches every terminal (and the ones opened later) to the dark or light palette. The cursor
 * and selection take the accent colour, when one is given.
 */
export function setTerminalTheme(name: ThemeName, accent?: string, extra: Record<string, string> = {}) {
  const base = name === "light" ? LIGHT : DARK;
  theme = accent ? { ...base, cursor: accent, selectionBackground: alpha(accent, name === "light" ? 0.18 : 0.3) } : { ...base };
  // Colours from theme plugins (xterm's names: background, red, brightGreen…).
  theme = { ...theme, ...extra };
  for (const s of live) s.term.options.theme = theme;
}

/** Font, history length and renderer for every terminal. */
const look = { fontFamily: '"Commit Mono", "Cascadia Mono", Consolas, monospace', fontSize: 14, scrollback: 10_000, gpu: false };

export function setTerminalOptions(o: { font: string; size: number; scrollback: number; gpu: boolean }) {
  const family = `"${o.font.replace(/"/g, "")}", "Commit Mono", "Cascadia Mono", Consolas, monospace`;
  const fontChanged = family !== look.fontFamily || o.size !== look.fontSize;
  Object.assign(look, { fontFamily: family, fontSize: o.size, scrollback: o.scrollback, gpu: o.gpu });
  for (const s of live) {
    s.term.options.scrollback = o.scrollback;
    if (fontChanged) {
      s.term.options.fontFamily = family;
      s.term.options.fontSize = o.size;
      s.refit();
    }
  }
}

/** Size of the last terminal that was measured: a good guess for tabs not yet on screen. */
let lastSize = { cols: 100, rows: 30 };
const live = new Set<TermSession>();

/** One terminal panel bound to one pseudo-terminal process. */
export class TermSession {
  readonly term: Terminal;
  private fit = new FitAddon();
  private id: number | null = null;
  private resizeTimer = 0;
  private observer: ResizeObserver;
  private opened = false;
  /** Typed input (and xterm's replies to terminal queries) that arrived before the process id. */
  private pending: string[] = [];
  /** Output seen so far (only the start is kept), e.g. to spot a failed resume. */
  onOutput: (text: string) => void = () => {};

  /** Called for every chunk the user types (after it is sent to the process). */
  onInput: (data: string) => void = () => {};

  /** Sees every key event first; returning false stops xterm from handling it. */
  onKey: (e: KeyboardEvent) => boolean = () => true;

  constructor(
    private host: HTMLElement,
    onExit: () => void,
  ) {
    this.term = new Terminal({
      fontFamily: look.fontFamily,
      fontSize: look.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: look.scrollback,
      allowProposedApi: true,
      theme,
    });
    this.term.loadAddon(this.fit);

    this.term.onData((data) => {
      this.send(data);
      if (this.id !== null) this.onInput(data);
    });
    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));

    this.observer = new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.refit(), 30);
    });
    live.add(this);
    this.onExit = onExit;
  }

  private onExit: () => void;

  /**
   * Attaches xterm to the page. Done on first show only: a terminal opened inside a hidden tab
   * cannot measure itself and may render blank. Output that arrives before is kept in its buffer.
   */
  private ensureOpen() {
    if (this.opened || this.host.offsetParent === null) return this.opened;
    this.opened = true;
    this.term.open(this.host);
    // The DOM renderer is the default: with WebGL, the whole terminal blinked blank for a frame
    // whenever the layout changed under a held mouse button (WebView2 on integrated graphics).
    // settings.json "terminal.gpu" turns WebGL on for tabs opened afterwards.
    if (look.gpu) try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      // No WebGL: xterm falls back to its DOM renderer.
    }
    this.observer.observe(this.host);
    return true;
  }

  /** `resume`: a Claude session id, "continue", or nothing for a fresh session. */
  async start(kind: TermKind, cwd: string, tab: string, resume?: string): Promise<void> {
    const onData = new Channel<ArrayBuffer>();
    const decoder = new TextDecoder();
    let seen = 0;
    onData.onmessage = (buf) => {
      const bytes = new Uint8Array(buf);
      this.term.write(bytes);
      if (seen < 64 * 1024) {
        seen += bytes.length;
        this.onOutput(decoder.decode(bytes, { stream: true }));
      }
    };
    this.refit();
    const onExit = new Channel<number>();
    onExit.onmessage = () => this.onExit();

    this.id = await invoke<number>("pty_spawn", {
      cwd,
      kind,
      tab,
      resume: resume ?? null,
      cols: this.term.cols,
      rows: this.term.rows,
      onData,
      onExit,
    });
    for (const data of this.pending.splice(0)) invoke("pty_write", { id: this.id, data });
  }

  refit() {
    if (!this.ensureOpen()) {
      if (this.term.cols !== lastSize.cols || this.term.rows !== lastSize.rows) {
        this.term.resize(lastSize.cols, lastSize.rows);
      }
      return;
    }
    const before = `${this.term.cols}x${this.term.rows}`;
    this.fit.fit();
    lastSize = { cols: this.term.cols, rows: this.term.rows };
    if (before !== `${this.term.cols}x${this.term.rows}`) this.renderNow();
    if (this.id !== null && before !== `${this.term.cols}x${this.term.rows}`) {
      invoke("pty_resize", { id: this.id, cols: this.term.cols, rows: this.term.rows });
    }
  }

  /**
   * Draws the terminal right away. A resize clears the WebGL canvas and xterm would only paint it
   * on the next animation frame, so one blank frame could reach the screen (a visible blink).
   * Uses xterm internals; if they change, the normal next-frame paint still happens.
   */
  private renderNow() {
    try {
      (this.term as any)._core._renderService._renderRows(0, this.term.rows - 1);
    } catch {
      /* fine: xterm paints on the next frame anyway */
    }
  }

  /** Writes straight to the process (queued until it has started). */
  send(data: string) {
    if (this.id === null) this.pending.push(data);
    else invoke("pty_write", { id: this.id, data });
  }

  /** Pastes text as if from the clipboard (bracketed when the program asked for it). */
  paste(text: string) {
    this.term.paste(text);
  }

  focus() {
    this.term.focus();
  }

  dispose() {
    live.delete(this);
    this.observer.disconnect();
    if (this.id !== null) invoke("pty_kill", { id: this.id });
    this.term.dispose();
  }
}
