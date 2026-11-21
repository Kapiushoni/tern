import { invoke } from "@tauri-apps/api/core";

/**
 * settings.json: everything the user can change. The settings window edits the common part;
 * the rest (exact colours, keys, claude's path, hidden folders…) only lives in the file. Edits
 * to the file — in Tern's editor or anywhere else — apply at once.
 */

export type Lang = "en" | "ru" | "uk";
export type Action =
  | "voice" | "newClaude" | "newShell" | "closeTab" | "nextTab" | "prevTab" | "toggleTree"
  | "goToFile" | "searchFiles" | "attach" | "settings" | "toggleTiling";

export interface Settings {
  language: Lang;
  theme: "dark" | "light";
  accent: string;
  font: { family: string; size: number };
  effects: { glow: boolean; crt: boolean; asciiLogo: boolean; typewriter: boolean };
  sound: { enabled: boolean; volume: number };
  voice: { model: string; microphone: string | null; language: string | null };
  /** IDE for "Open in IDE": idea, pycharm, vscode, or null = by project language. */
  ide: string | null;
  claude: { path: string | null; args: string[]; installPrompt: boolean };
  terminal: { shell: string | null; scrollback: number; gpu: boolean; padding: number };
  /** Window mode: "tiling" (windows share the space, like Hyprland) or "floating" (free). */
  windows: { layout: "tiling" | "floating" };
  tree: { hiddenFolders: string[] };
  images: { keepDays: number };
  /** Key combinations, e.g. "Ctrl+Shift+F" (by key position, so any keyboard layout works). */
  keys: Record<Action, string>;
  /** Exact interface colours per theme, e.g. { "bg": "#000000" } for --bg. */
  colors: { dark: Record<string, string>; light: Record<string, string> };
}

export const DEFAULTS: Settings = {
  language: "en",
  theme: "dark",
  accent: "#ff2e88",
  font: { family: "Commit Mono", size: 14 },
  effects: { glow: true, crt: true, asciiLogo: true, typewriter: true },
  sound: { enabled: true, volume: 20 },
  voice: { model: "small", microphone: null, language: null },
  ide: null,
  claude: { path: null, args: [], installPrompt: true },
  terminal: { shell: null, scrollback: 10000, gpu: false, padding: 8 },
  windows: { layout: "tiling" },
  tree: { hiddenFolders: [".git", "node_modules", ".venv", "venv", "target", "build", "__pycache__", ".idea"] },
  images: { keepDays: 7 },
  keys: {
    voice: "Alt+Z",
    newClaude: "Ctrl+`",
    newShell: "Ctrl+Shift+T",
    closeTab: "Ctrl+W",
    nextTab: "Ctrl+Tab",
    prevTab: "Ctrl+Shift+Tab",
    toggleTree: "Ctrl+B",
    goToFile: "Ctrl+P",
    searchFiles: "Ctrl+Shift+F",
    attach: "Ctrl+Shift+A",
    settings: "Ctrl+,",
    toggleTiling: "Ctrl+Shift+G",
  },
  colors: { dark: {}, light: {} },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Takes from `raw` only what has the same shape as the default; the rest stays default. */
function merge<T>(def: T, raw: unknown): T {
  if (raw === undefined || raw === null) return clone(def);
  if (Array.isArray(def)) return (Array.isArray(raw) && raw.every((x) => typeof x === "string") ? raw : clone(def)) as T;
  if (def === null) return raw as T; // nullable string fields
  if (typeof def === "object") {
    if (typeof raw !== "object" || Array.isArray(raw)) return clone(def);
    const out: Record<string, unknown> = {};
    const d = def as Record<string, unknown>;
    const r = raw as Record<string, unknown>;
    // Free-form maps (colours) take any string values.
    if (Object.keys(d).length === 0) {
      for (const [k, v] of Object.entries(r)) if (typeof v === "string") out[k] = v;
      return out as T;
    }
    for (const k of Object.keys(d)) out[k] = merge(d[k], r[k]);
    return out as T;
  }
  return (typeof raw === typeof def ? raw : def) as T;
}

/** Field by field validation of a parsed settings.json. */
export function normalize(raw: unknown): Settings {
  const s = merge(DEFAULTS, raw);
  // Nullable fields: anything but a non-empty string means "unset".
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  s.voice.microphone = str(s.voice.microphone);
  s.voice.language = str(s.voice.language);
  s.ide = str(s.ide);
  s.claude.path = str(s.claude.path);
  s.terminal.shell = str(s.terminal.shell);
  if (!["en", "ru", "uk"].includes(s.language)) s.language = "en";
  if (s.theme !== "light") s.theme = "dark";
  if (s.windows.layout !== "floating") s.windows.layout = "tiling";
  if (!/^#[0-9a-f]{6}$/i.test(s.accent)) s.accent = DEFAULTS.accent;
  s.font.size = clamp(Math.round(s.font.size), 9, 32);
  s.sound.volume = clamp(Math.round(s.sound.volume), 0, 100);
  s.terminal.scrollback = clamp(Math.round(s.terminal.scrollback), 100, 200000);
  s.terminal.padding = clamp(Math.round(s.terminal.padding), 0, 48);
  s.images.keepDays = clamp(Math.round(s.images.keepDays), 0, 3650);
  return s;
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** Strips // and /* *\/ comments (outside strings), so a commented settings.json still loads. */
function stripComments(text: string) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  // Trailing commas are a common slip when editing by hand.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export class SettingsStore {
  value: Settings = clone(DEFAULTS);
  path = "";
  /** The text Tern itself wrote last, so its own save is not taken for an outside edit. */
  private written = "";
  /** Called after every change, with the previous settings. */
  onApply: (now: Settings, before: Settings) => void = () => {};
  /** settings.json could not be read: the message says where. */
  onError: (message: string) => void = () => {};

  /** First load. `legacy` seeds a new file from what older versions kept in the session. */
  async load(legacy: Partial<Settings> = {}) {
    this.path = await invoke<string>("settings_path").catch(() => "");
    const text = await invoke<string | null>("settings_read").catch(() => null);
    const before = this.value;
    if (text === null) {
      this.value = normalize({ ...legacy });
      await this.write();
    } else {
      this.value = this.parse(text) ?? normalize(legacy);
      this.written = text;
    }
    this.onApply(this.value, before);
  }

  /** Changes some settings (from the settings window) and saves. */
  async update(change: (s: Settings) => void) {
    const before = clone(this.value);
    change(this.value);
    this.value = normalize(this.value);
    await this.write();
    this.onApply(this.value, before);
  }

  /** The file changed on disk (Tern's editor or another program): reload it. */
  async reload() {
    const text = await invoke<string | null>("settings_read").catch(() => null);
    if (text === null || text === this.written) return;
    const parsed = this.parse(text);
    if (!parsed) return;
    this.written = text;
    const before = this.value;
    this.value = parsed;
    this.onApply(this.value, before);
  }

  private parse(text: string): Settings | null {
    try {
      return normalize(JSON.parse(stripComments(text)));
    } catch (err) {
      this.onError(String(err).replace(/^SyntaxError: /, ""));
      return null;
    }
  }

  private async write() {
    const text = JSON.stringify(this.value, null, 2) + "\n";
    this.written = text;
    await invoke("settings_write", { text }).catch((e) => this.onError(String(e)));
  }
}

// ── keys ─────────────────────────────────────────────────

const isMac = navigator.platform.toLowerCase().includes("mac");

const NAMED: Record<string, string> = {
  "`": "Backquote", "~": "Backquote", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon",
  "'": "Quote", "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", "\\": "Backslash",
  space: "Space", tab: "Tab", enter: "Enter", esc: "Escape", escape: "Escape", backspace: "Backspace",
  delete: "Delete", del: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};

interface Combo {
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

function parseCombo(text: string): Combo | null {
  const parts = text.split("+").map((p) => p.trim()).filter(Boolean);
  // "Ctrl++" style: a trailing empty part means the "+" key itself.
  if (text.trim().endsWith("++")) parts.push("=");
  const key = parts.pop();
  if (!key) return null;
  const mods = parts.map((p) => p.toLowerCase());
  let code: string | undefined;
  if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
  else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) code = key.toUpperCase();
  else code = NAMED[key.toLowerCase()] ?? NAMED[key] ?? (/^[A-Z][A-Za-z0-9]+$/.test(key) ? key : undefined);
  if (!code) return null;
  return {
    code,
    ctrl: mods.some((m) => m === "ctrl" || m === "control" || m === "cmd" || m === "mod"),
    shift: mods.includes("shift"),
    alt: mods.some((m) => m === "alt" || m === "option"),
  };
}

const cache = new Map<string, Combo | null>();

/** Whether the key event is this combination. Ctrl means Cmd on macOS. */
export function matches(e: KeyboardEvent, combo: string): boolean {
  if (!cache.has(combo)) cache.set(combo, parseCombo(combo));
  const c = cache.get(combo);
  if (!c) return false;
  const ctrl = isMac ? e.metaKey : e.ctrlKey;
  return e.code === c.code && ctrl === c.ctrl && e.shiftKey === c.shift && e.altKey === c.alt;
}

/** How a combination is shown to the user ("Ctrl" becomes "Cmd" on macOS). */
export function showCombo(combo: string) {
  return isMac ? combo.replace(/\bCtrl\b/g, "Cmd") : combo;
}
