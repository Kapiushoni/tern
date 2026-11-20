import { Channel, invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";

export type TermKind = "claude" | "shell";

const theme = {
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
  white: "#d9d4de", brightWhite: "#ffffff",
};

let layoutPaused = false;
/** Size of the last terminal that was measured: a good guess for tabs not yet on screen. */
let lastSize = { cols: 100, rows: 30 };
const live = new Set<TermSession>();

/** While paused (e.g. during a splitter drag) terminals keep their size; unpausing refits them once. */
export function setLayoutPaused(paused: boolean) {
  layoutPaused = paused;
  if (!paused) for (const s of live) s.refit();
}

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

  constructor(
    private host: HTMLElement,
    onExit: () => void,
  ) {
    this.term = new Terminal({
      fontFamily: '"Commit Mono", "Cascadia Mono", Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10_000,
      allowProposedApi: true,
      theme,
    });
    this.term.loadAddon(this.fit);

    this.term.onData((data) => {
      if (this.id === null) {
        this.pending.push(data);
        return;
      }
      invoke("pty_write", { id: this.id, data });
      this.onInput(data);
    });

    this.observer = new ResizeObserver(() => {
      if (layoutPaused) return;
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
    try {
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
    if (this.id !== null && before !== `${this.term.cols}x${this.term.rows}`) {
      invoke("pty_resize", { id: this.id, cols: this.term.cols, rows: this.term.rows });
    }
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
