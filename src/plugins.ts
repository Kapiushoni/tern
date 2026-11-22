import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "./toast";
import { t } from "./i18n";
import { linkRules } from "./terminal";
import { LanguageSpec, parseLanguages, serverName } from "./lsp";

/**
 * Plugins. A plugin is a folder with plugin.json and, optionally, main.js, style.css and HTML
 * windows. Its code runs in a sandboxed iframe (its own origin, no network, no access to Tern) and
 * talks to Tern through the `tern` object; Tern checks the plugin's permissions on every call.
 * Background code ("backend") runs in Deno (plugin_host.rs): the same `tern` calls arrive here
 * as events and are answered the same way. See PLUGINS.md for the author's side.
 */

export interface SettingSpec {
  key: string;
  label: string;
  type?: "text" | "password" | "number" | "checkbox" | "select";
  options?: string[];
  default?: string | number | boolean;
  description?: string;
}

export interface ThemeSpec {
  /** Interface colours (the CSS variables, e.g. "bg", "accent"), per theme or for both. */
  dark?: Record<string, string>;
  light?: Record<string, string>;
  colors?: Record<string, string>;
  /** Terminal palette (xterm names: background, foreground, red, brightGreen…). */
  terminal?: Record<string, string>;
  terminalLight?: Record<string, string>;
}

export interface Manifest {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  main?: string;
  /** Background code run by Deno (JS or TS), with Deno's APIs limited to the granted permissions. */
  backend?: string;
  style?: string;
  theme?: ThemeSpec;
  /** "files", "commands", "terminal", "terminal:read", "tabs", "claude", "network" or "network:host.com". */
  permissions?: string[];
  settings?: SettingSpec[];
  /** Language servers for the editor (completion, errors, go to definition…). */
  languages?: LanguageSpec[];
}

interface Data {
  enabled: boolean;
  granted: string[];
  settings: Record<string, unknown>;
  storage: Record<string, unknown>;
}

export interface Plugin {
  id: string;
  dir: string;
  manifest: Manifest | null;
  error?: string;
  data: Data;
  running: boolean;
}

interface Running {
  frame: HTMLIFrameElement | null;
  windows: Map<string, { el: HTMLElement; frame: HTMLIFrameElement }>;
  buttons: HTMLElement[];
  menu: { label: string; cb: string }[];
  commands: { name: string; key?: string; cb: string }[];
  events: Set<string>;
  style: HTMLStyleElement | null;
  /** Its background code is running in the plugin host. */
  backend: boolean;
  /** Its items in the status bar, by the id handed to the plugin. */
  status: Map<string, HTMLElement>;
}

/** What turning a plugin on allows, beyond its permissions: background code, language servers. */
export function implied(m: { backend?: unknown; languages?: LanguageSpec[]; servers?: string[] }): string[] {
  const out = m.backend ? ["background"] : [];
  for (const name of m.servers ?? (m.languages ?? []).map(serverName)) out.push(`server:${name}`);
  return out;
}

/** What a permission means, for the install dialog. */
export function describePermission(p: string): string {
  if (p === "background") return t("Run in the background while Tern is open");
  if (p.startsWith("server:")) return t("Download and run the language server {name}", { name: p.slice(7) });
  if (p === "files") return t("Read and change files in the open project");
  if (p === "commands") return t("Run commands on this computer");
  if (p === "terminal") return t("Type into the terminal and send prompts to Claude");
  if (p === "terminal:read") return t("Read what the terminal shows, and make text in it clickable");
  if (p === "tabs") return t("Open terminal and Claude tabs");
  if (p === "claude") return t("See what Claude does: prompts, tools, changed files, conversation logs");
  if (p === "network") return t("Connect to any site on the internet");
  if (p.startsWith("network:")) return t("Connect to {host}", { host: p.slice(8) });
  return p;
}

const KNOWN = /^(files|commands|terminal|terminal:read|tabs|claude|network|network:[a-z0-9.-]+)$/i;

export function parseManifest(text: string | null): { manifest: Manifest | null; error?: string } {
  if (!text) return { manifest: null, error: "plugin.json is missing" };
  let m: Manifest;
  try {
    m = JSON.parse(text);
  } catch (e) {
    return { manifest: null, error: `plugin.json: ${String(e).replace(/^SyntaxError: /, "")}` };
  }
  if (!m || typeof m.name !== "string" || !m.name.trim()) return { manifest: null, error: 'plugin.json needs a "name"' };
  m.permissions = (Array.isArray(m.permissions) ? m.permissions : []).filter((p) => typeof p === "string" && KNOWN.test(p));
  m.settings = Array.isArray(m.settings) ? m.settings.filter((s) => s && typeof s.key === "string") : [];
  m.languages = parseLanguages(m.languages);
  return { manifest: m };
}

// The `tern` object inside a plugin's sandbox. Every call is a message to Tern and a reply back.
const SHIM = `(() => {
  // The webview puts its own bridges into every frame. They don't work from the sandbox (tested),
  // but a plugin has no business seeing them: remove them before its code runs.
  for (const k of ["__TAURI_INTERNALS__", "__TAURI__", "__TAURI_EVENT_PLUGIN_INTERNALS__", "__TAURI_OS_PLUGIN_INTERNALS__", "ipc"]) {
    try { delete window[k]; } catch {}
    try { if (k in window) Object.defineProperty(window, k, { value: undefined, configurable: false }); } catch {}
  }
  try { if (window.chrome) Object.defineProperty(window, "chrome", { value: undefined, configurable: false }); } catch {}
  let seq = 0;
  const tag = Math.random().toString(36).slice(2, 8);
  const pending = new Map(), callbacks = new Map(), listeners = {}, messageListeners = [];
  let early = []; // messages from before tern.onMessage was called
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ tern: 1, id, method, args }, "*");
  });
  // Keys unique per frame: the plugin's code, its windows and its backend all get every callback.
  const cb = (fn) => { if (typeof fn !== "function") return null; const k = tag + "." + (++seq); callbacks.set(k, fn); return k; };
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const m = e.data;
    if (!m || !m.tern) return;
    if (m.reply) {
      const p = pending.get(m.reply); pending.delete(m.reply);
      if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
    } else if (m.callback) {
      const f = callbacks.get(m.callback);
      if (f) try { f(...(m.args || [])); } catch (err) { call("log", String(err && err.stack || err)); }
    } else if (m.event) {
      for (const f of listeners[m.event] || []) try { f(m.data); } catch (err) { call("log", String(err && err.stack || err)); }
    } else if ("message" in m) {
      if (early) early.push(m.message);
      for (const f of messageListeners) try { f(m.message); } catch (err) { call("log", String(err && err.stack || err)); }
    } else if (typeof m.insertText === "string") {
      // Voice input: type into the focused field of this window.
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        el.setRangeText(m.insertText, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (el && el.isContentEditable) {
        document.execCommand("insertText", false, m.insertText);
      }
    }
  });
  // Tern's shortcuts (voice input, Esc to cancel it) still work while this window has the focus.
  addEventListener("keydown", (e) => {
    if (!(e.altKey || e.ctrlKey || e.metaKey || e.key === "Escape")) return;
    parent.postMessage({ tern: 1, hotkey: { code: e.code, key: e.key, altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey } }, "*");
  }, true);
  addEventListener("error", (e) => call("log", String(e.message)));
  addEventListener("unhandledrejection", (e) => call("log", String(e.reason && e.reason.message || e.reason)));
  window.tern = {
    addButton: (o) => call("addButton", { icon: o.icon, title: o.title, onClick: cb(o.onClick) }),
    addMenuItem: (o) => call("addMenuItem", { label: o.label, onClick: cb(o.onClick) }),
    addCommand: (o) => call("addCommand", { name: o.name, key: o.key, run: cb(o.run) }),
    addStatus: async (o) => {
      const id = await call("addStatus", { text: o.text, title: o.title, align: o.align, onClick: cb(o.onClick) });
      return {
        set: (u) => call("setStatus", id, { text: u.text, title: u.title }),
        remove: () => call("removeStatus", id),
      };
    },
    on: (event, fn) => { (listeners[event] = listeners[event] || []).push(fn); return call("on", event); },
    notify: (text) => call("notify", String(text)),
    openWindow: (file, opts) => call("openWindow", file, opts || {}),
    closeWindow: (file) => call("closeWindow", file),
    project: () => call("project"),
    settings: { get: (k) => call("settings.get", k), all: () => call("settings.all") },
    storage: { get: (k) => call("storage.get", k), set: (k, v) => call("storage.set", k, v) },
    files: {
      read: (p) => call("files.read", p),
      write: (p, text) => call("files.write", p, String(text)),
      list: (p) => call("files.list", p || "."),
    },
    run: (command) => call("run", command),
    fetch: (url, opts) => call("fetch", url, opts || {}),
    terminal: {
      send: (text, o) => call("terminal.send", String(text), o || {}),
      read: (o) => call("terminal.read", o || {}),
      addLink: (o) => call("terminal.addLink", { pattern: String(o.pattern), flags: o.flags, onClick: cb(o.onClick) }),
    },
    tabs: { list: () => call("tabs.list"), open: (o) => call("tabs.open", o || {}) },
    send: (message) => call("send", message),
    onMessage: (fn) => {
      messageListeners.push(fn);
      const queued = early || []; early = null;
      for (const msg of queued) Promise.resolve().then(() => fn(msg)).catch((err) => call("log", String(err)));
    },
  };
})();`;

/** A sandboxed document: the plugin's code or window, with `tern` available and nothing else. */
function sandboxDoc(body: string, isHtml: boolean) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:">`;
  // Tern's colours as CSS variables, so a plugin's window can match the theme.
  const vars = ["bg", "panel", "line", "fg", "fg2", "dim", "faint", "accent", "accent-soft", "hover"]
    .map((v) => `--${v}:${cssVar(`--${v}`)}`)
    .join(";");
  const base =
    `<style>:root{${vars};color-scheme:${document.documentElement.dataset.theme === "light" ? "light" : "dark"}}` +
    `body{margin:0;font:13px/1.5 ${cssVar("--mono") || "ui-monospace,Consolas,monospace"};background:var(--bg);color:var(--fg)}</style>`;
  const shim = `<script>${SHIM}</script>`;
  if (!isHtml) return `<!doctype html><meta charset="utf-8">${csp}${shim}<script>${body.replace(/<\/script/gi, "<\\/script")}</script>`;
  // An HTML window: our head first (so the CSP and `tern` come before the page's own code).
  return `<!doctype html><meta charset="utf-8">${csp}${base}${shim}${body}`;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export class PluginHost {
  plugins: Plugin[] = [];
  /** A plugin stopped (turned off, removed, reloaded): its language servers go too. */
  onStopped: (id: string) => void = () => {};
  /** Plugins were loaded, enabled or disabled: themes may have changed. */
  onChange: () => void = () => {};
  /** The open project folder. */
  getProject: () => string | null = () => null;
  /** The open tabs, a tab's terminal, and opening one (main.ts wires these to Tabs). */
  tabs: {
    list: () => unknown[];
    session: (id?: string | null) => { paste: (t: string) => void; send: (d: string) => void; focus: () => void; text: (n: number) => string };
    open: (o: { kind: "claude" | "shell"; cwd: string; run?: string; args?: string[]; label?: string }) => Promise<string>;
  } | null = null;
  /** A key pressed inside a focused plugin window (only Tern's own shortcuts act on it). */
  onHotkey: (e: KeyboardEvent) => void = () => {};
  /** The status bar at the bottom: shown while it has items and the user wants it. */
  statusBar: HTMLElement | null = null;
  private statusOn = true;
  private statusSeq = 0;

  private running = new Map<string, Running>();
  private toolbar: HTMLElement;
  private windowsHost: HTMLElement;

  constructor(toolbarAnchor: HTMLElement) {
    this.toolbar = document.createElement("div");
    this.toolbar.id = "plugin-buttons";
    toolbarAnchor.before(this.toolbar);
    // Plugin windows float over all of Tern below the title bar (the open file, terminals, tree).
    this.windowsHost = document.createElement("div");
    this.windowsHost.id = "plugin-layer";
    document.body.append(this.windowsHost);
    window.addEventListener("message", (e) => this.onMessage(e));
    listen<{ id: string; msg: unknown; exit: string | null }>("plugin-backend", (e) => this.onBackend(e.payload));
  }

  // ── loading ───────────────────────────────────────────

  async load() {
    for (const id of [...this.running.keys()]) this.stop(id);
    const list = await invoke<{ id: string; dir: string; manifest: string | null }[]>("plugins_list").catch(() => []);
    this.plugins = await Promise.all(
      list.map(async (p) => {
        const { manifest, error } = parseManifest(p.manifest);
        const raw = await invoke<string | null>("plugin_data_load", { id: p.id }).catch(() => null);
        let data: Data = { enabled: false, granted: [], settings: {}, storage: {} };
        try {
          if (raw) data = { ...data, ...JSON.parse(raw) };
        } catch {
          /* fresh data */
        }
        return { id: p.id, dir: p.dir, manifest, error, data, running: false };
      }),
    );
    for (const p of this.plugins) if (this.canRun(p)) await this.start(p);
    this.onChange();
  }

  /** Enabled, and every permission it asks for has been granted. */
  canRun(p: Plugin) {
    return !!p.manifest && p.data.enabled && this.missing(p).length === 0;
  }

  /** Permissions the plugin asks for that the user hasn't granted (yet). */
  missing(p: Plugin) {
    return (p.manifest?.permissions ?? []).filter((x) => !p.data.granted.includes(x));
  }

  /** Turns a plugin on (granting what it asks for) or off. */
  async setEnabled(p: Plugin, on: boolean) {
    p.data.enabled = on;
    if (on) p.data.granted = [...(p.manifest?.permissions ?? [])];
    await this.saveData(p);
    if (on && this.canRun(p)) await this.start(p);
    if (!on) this.stop(p.id);
    this.onChange();
  }

  async saveData(p: Plugin) {
    await invoke("plugin_data_save", { id: p.id, json: JSON.stringify(p.data) }).catch((e) => toast(String(e)));
  }

  async remove(p: Plugin) {
    this.stop(p.id);
    await invoke("plugin_remove", { id: p.id });
    this.plugins = this.plugins.filter((x) => x !== p);
    this.onChange();
  }

  private async start(p: Plugin) {
    const m = p.manifest!;
    const r: Running = { frame: null, windows: new Map(), buttons: [], menu: [], commands: [], events: new Set(), style: null, backend: false, status: new Map() };
    this.running.set(p.id, r);
    p.running = true;
    if (m.style) {
      const css = await invoke<string>("plugin_file", { id: p.id, path: m.style }).catch(() => "");
      r.style = document.createElement("style");
      r.style.dataset.plugin = p.id;
      r.style.textContent = css;
      document.head.append(r.style);
    }
    if (m.backend) {
      try {
        await invoke("plugin_backend_start", { id: p.id, file: m.backend, perms: p.data.granted });
        r.backend = true;
      } catch (e) {
        toast(t("Plugin {name}: {error}", { name: m.name, error: String(e) }), 6000);
      }
    }
    if (m.main) {
      const code = await invoke<string>("plugin_file", { id: p.id, path: m.main }).catch((e) => {
        toast(t("Plugin {name}: {error}", { name: m.name, error: String(e) }), 5000);
        return null;
      });
      if (code === null) return;
      const frame = document.createElement("iframe");
      frame.className = "plugin-frame";
      // Scripts only: a unique origin, no way to reach Tern's page, storage or network.
      frame.setAttribute("sandbox", "allow-scripts");
      frame.srcdoc = sandboxDoc(code, false);
      frame.hidden = true;
      document.body.append(frame);
      r.frame = frame;
    }
  }

  private stop(id: string) {
    const r = this.running.get(id);
    if (!r) return;
    r.frame?.remove();
    if (r.backend) invoke("plugin_backend_stop", { id }).catch(() => {});
    for (const w of r.windows.values()) w.el.remove();
    for (const b of r.buttons) b.remove();
    for (const s of r.status.values()) s.remove();
    for (let i = linkRules.length - 1; i >= 0; i--) if (linkRules[i].owner === id) linkRules.splice(i, 1);
    r.style?.remove();
    this.running.delete(id);
    const p = this.plugins.find((x) => x.id === id);
    if (p) p.running = false;
    this.layoutStatus();
    this.onStopped(id);
  }

  /** The status bar setting (settings.json "statusBar"). */
  setStatusBar(on: boolean) {
    this.statusOn = on;
    this.layoutStatus();
  }

  private layoutStatus() {
    const bar = this.statusBar;
    if (!bar) return;
    const show = this.statusOn && !!bar.querySelector(".sb-item");
    bar.hidden = !show;
    document.getElementById("app")?.classList.toggle("has-status", show);
  }

  // ── what Tern asks of running plugins ─────────────────

  /** Theme colours from the running plugins, for the current theme. */
  themeVars(theme: "dark" | "light"): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.plugins) {
      const th = p.running ? p.manifest?.theme : undefined;
      if (th) Object.assign(out, th.colors, theme === "light" ? th.light : th.dark);
    }
    return out;
  }

  terminalColors(theme: "dark" | "light"): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.plugins) {
      const th = p.running ? p.manifest?.theme : undefined;
      if (th) Object.assign(out, theme === "light" ? (th.terminalLight ?? {}) : (th.terminal ?? {}));
    }
    return out;
  }

  /** Items plugins added to the file tree's menu. */
  menuItems(path: string): { label: string; run: () => void }[] {
    const out: { label: string; run: () => void }[] = [];
    for (const [id, r] of this.running) {
      for (const m of r.menu) out.push({ label: m.label, run: () => this.callback(id, m.cb, [path]) });
    }
    return out;
  }

  /** Language servers of the running plugins. */
  languages(): { plugin: string; lang: LanguageSpec }[] {
    const out: { plugin: string; lang: LanguageSpec }[] = [];
    for (const p of this.plugins) {
      if (p.running) for (const lang of p.manifest?.languages ?? []) out.push({ plugin: p.id, lang });
    }
    return out;
  }

  /** Plugins' named commands, for the command palette. */
  paletteCommands(): { name: string; key?: string; source: string; run: () => void }[] {
    const out: { name: string; key?: string; source: string; run: () => void }[] = [];
    for (const [id, r] of this.running) {
      const source = this.plugins.find((x) => x.id === id)?.manifest?.name ?? id;
      for (const c of r.commands) {
        if (c.name) out.push({ name: c.name, key: c.key, source, run: () => this.callback(id, c.cb, []) });
      }
    }
    return out;
  }

  /** A plugin's shortcut: true if one ran. */
  handleKey(e: KeyboardEvent, matches: (e: KeyboardEvent, combo: string) => boolean) {
    for (const [id, r] of this.running) {
      for (const c of r.commands) {
        if (c.key && matches(e, c.key)) {
          this.callback(id, c.cb, []);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Something happened in Tern: tell the plugins listening for it. `detail` (prompts, tools,
   * session ids) only reaches plugins granted "claude"; claude:tool is theirs alone.
   */
  emit(event: string, data: Record<string, unknown> = {}, detail?: Record<string, unknown>) {
    for (const [id, r] of this.running) {
      if (!r.events.has(event)) continue;
      const sees = this.plugins.find((x) => x.id === id)?.data.granted.includes("claude") ?? false;
      if (event === "claude:tool" && !sees) continue;
      this.deliver(r, { tern: 1, event, data: sees && detail ? { ...data, ...detail } : data });
    }
  }

  private callback(id: string, cb: string, args: unknown[]) {
    const r = this.running.get(id);
    if (r) this.deliver(r, { tern: 1, callback: cb, args });
  }

  /** To the parts of a plugin: its code and windows (ui), and its background code (backend). */
  private deliver(r: Running, msg: Record<string, unknown>, ui = true, backend = true) {
    if (ui) {
      r.frame?.contentWindow?.postMessage(msg, "*");
      for (const w of r.windows.values()) w.frame.contentWindow?.postMessage(msg, "*");
    }
    const id = [...this.running].find(([, x]) => x === r)?.[0];
    if (backend && r.backend && id) invoke("plugin_backend_send", { id, msg }).catch(() => {});
  }

  /** A call (or a crash) from a plugin's background code. */
  private async onBackend({ id, msg, exit }: { id: string; msg: unknown; exit: string | null }) {
    if (exit) {
      if (id === "") {
        // The whole host stopped: every backend is gone.
        for (const r of this.running.values()) r.backend = false;
        return;
      }
      const r = this.running.get(id);
      if (r) r.backend = false;
      const p = this.plugins.find((x) => x.id === id);
      toast(t("Plugin {name}: {error}", { name: p?.manifest?.name ?? id, error: exit }), 6000);
      return;
    }
    const m = msg as { tern?: number; id?: number; method?: unknown; args?: unknown } | null;
    if (!m || m.tern !== 1 || typeof m.method !== "string") return;
    const p = this.plugins.find((x) => x.id === id);
    if (!p?.manifest || !this.running.get(id)?.backend) return;
    let reply: Record<string, unknown>;
    try {
      reply = { tern: 1, reply: m.id, value: await this.handle(p, m.method, Array.isArray(m.args) ? m.args : [], "backend") };
    } catch (err) {
      reply = { tern: 1, reply: m.id, error: String(err instanceof Error ? err.message : err) };
    }
    invoke("plugin_backend_send", { id, msg: reply }).catch(() => {});
  }

  // ── the API ───────────────────────────────────────────

  private findSource(src: MessageEventSource | null): { id: string; win: Window } | null {
    if (!src) return null;
    for (const [id, r] of this.running) {
      if (r.frame?.contentWindow === src) return { id, win: src as Window };
      for (const w of r.windows.values()) if (w.frame.contentWindow === src) return { id, win: src as Window };
    }
    return null;
  }

  /** Voice input into a plugin window: its focused field gets the text. */
  insertInto(frame: HTMLIFrameElement, text: string) {
    frame.contentWindow?.postMessage({ tern: 1, insertText: text }, "*");
  }

  private async onMessage(e: MessageEvent) {
    const m = e.data;
    if (!m || m.tern !== 1) return;
    const from = this.findSource(e.source);
    if (!from) return;
    if (m.hotkey && typeof m.hotkey === "object") {
      // Only from the window the user is actually in (a plugin can't fire these in the background).
      const frame = document.activeElement;
      if (frame instanceof HTMLIFrameElement && frame.contentWindow === e.source && document.hasFocus()) {
        const k = m.hotkey;
        this.onHotkey(new KeyboardEvent("keydown", { code: String(k.code), key: String(k.key), altKey: !!k.altKey, ctrlKey: !!k.ctrlKey, shiftKey: !!k.shiftKey, metaKey: !!k.metaKey }));
      }
      return;
    }
    if (typeof m.method !== "string") return;
    const p = this.plugins.find((x) => x.id === from.id);
    if (!p?.manifest) return;
    try {
      const value = await this.handle(p, m.method, Array.isArray(m.args) ? m.args : [], "ui");
      from.win.postMessage({ tern: 1, reply: m.id, value }, "*");
    } catch (err) {
      from.win.postMessage({ tern: 1, reply: m.id, error: String(err instanceof Error ? err.message : err) }, "*");
    }
  }

  private tabsApi() {
    if (!this.tabs) throw new Error("terminals are not available");
    return this.tabs;
  }

  private need(p: Plugin, perm: string) {
    if (!p.data.granted.includes(perm)) throw new Error(`permission "${perm}" is not granted`);
  }

  private project() {
    const root = this.getProject();
    if (!root) throw new Error("no project is open");
    return root;
  }

  /** One `tern.*` call. `from`: the plugin's code or windows ("ui"), or its background code. */
  private async handle(p: Plugin, method: string, args: unknown[], from: "ui" | "backend"): Promise<unknown> {
    const r = this.running.get(p.id)!;
    const m = p.manifest!;
    const str = (v: unknown, what: string) => {
      if (typeof v !== "string") throw new Error(`${what} must be text`);
      return v;
    };
    switch (method) {
      case "log":
        console.warn(`[plugin ${p.id}]`, args[0]);
        return;
      case "send": {
        // Between the plugin's background code and its windows / main.js, both ways.
        const message = JSON.parse(JSON.stringify(args[0] ?? null));
        this.deliver(r, { tern: 1, message }, from === "backend", from === "ui");
        return;
      }
      case "notify":
        toast(`${m.name}: ${str(args[0], "text").slice(0, 300)}`, 4000);
        return;
      case "addButton": {
        const o = (args[0] ?? {}) as { icon?: string; title?: string; onClick?: string };
        const b = document.createElement("button");
        b.className = "icon-btn plugin-btn";
        b.title = `${o.title ?? m.name}`;
        const icon = String(o.icon ?? "★");
        if (/^M[\d\s.,MLHVCSQTAZmlhvcsqtaz-]+$/.test(icon)) {
          // An SVG path ("M3 3h18…") drawn like Tern's own icons.
          const ns = "http://www.w3.org/2000/svg";
          const svg = document.createElementNS(ns, "svg");
          svg.setAttribute("viewBox", "0 0 24 24");
          const path = document.createElementNS(ns, "path");
          path.setAttribute("d", icon);
          svg.append(path);
          b.append(svg);
        } else {
          b.classList.add("text-icon");
          b.textContent = icon.slice(0, 2);
        }
        if (o.onClick) b.addEventListener("click", () => this.callback(p.id, o.onClick!, []));
        this.toolbar.append(b);
        r.buttons.push(b);
        return;
      }
      case "addMenuItem": {
        const o = (args[0] ?? {}) as { label?: string; onClick?: string };
        if (o.label && o.onClick) r.menu.push({ label: String(o.label).slice(0, 60), cb: o.onClick });
        return;
      }
      case "addCommand": {
        const o = (args[0] ?? {}) as { name?: string; key?: string; run?: string };
        if (o.run) r.commands.push({ name: String(o.name ?? ""), key: o.key ? String(o.key) : undefined, cb: o.run });
        return;
      }
      case "addStatus": {
        if (!this.statusBar) throw new Error("no status bar");
        const o = (args[0] ?? {}) as { text?: unknown; title?: unknown; align?: unknown; onClick?: string };
        const el = document.createElement(o.onClick ? "button" : "span");
        el.className = "sb-item";
        el.dataset.plugin = p.id;
        const id = `${p.id}:${++this.statusSeq}`;
        setStatusText(el, o, m.name);
        if (o.onClick) el.addEventListener("click", () => this.callback(p.id, o.onClick!, []));
        const side = this.statusBar.querySelector(o.align === "left" ? ".sb-left" : ".sb-right")!;
        side.append(el);
        r.status.set(id, el);
        this.layoutStatus();
        return id;
      }
      case "setStatus": {
        const el = r.status.get(str(args[0], "id"));
        if (el) setStatusText(el, (args[1] ?? {}) as { text?: unknown; title?: unknown }, m.name);
        return;
      }
      case "removeStatus": {
        const id = str(args[0], "id");
        r.status.get(id)?.remove();
        r.status.delete(id);
        this.layoutStatus();
        return;
      }
      case "on":
        r.events.add(str(args[0], "event"));
        return;
      case "openWindow":
        return this.openWindow(p, str(args[0], "file"), (args[1] ?? {}) as { title?: string; width?: number; height?: number });
      case "closeWindow": {
        const file = typeof args[0] === "string" ? args[0] : [...r.windows.keys()][0];
        r.windows.get(file)?.el.remove();
        r.windows.delete(file);
        return;
      }
      case "project":
        return this.getProject();
      case "settings.get": {
        const key = str(args[0], "key");
        const spec = m.settings?.find((s) => s.key === key);
        return p.data.settings[key] ?? spec?.default ?? null;
      }
      case "settings.all": {
        const out: Record<string, unknown> = {};
        for (const s of m.settings ?? []) out[s.key] = p.data.settings[s.key] ?? s.default ?? null;
        return out;
      }
      case "storage.get":
        return p.data.storage[str(args[0], "key")] ?? null;
      case "storage.set": {
        const key = str(args[0], "key");
        const value = JSON.parse(JSON.stringify(args[1] ?? null));
        p.data.storage[key] = value;
        if (JSON.stringify(p.data.storage).length > 1_000_000) throw new Error("storage is full (1 MB)");
        await this.saveData(p);
        return;
      }
      case "files.read":
        this.need(p, "files");
        return invoke("plugin_fs_read", { root: this.project(), path: str(args[0], "path") });
      case "files.write":
        this.need(p, "files");
        return invoke("plugin_fs_write", { root: this.project(), path: str(args[0], "path"), text: str(args[1], "text") });
      case "files.list":
        this.need(p, "files");
        return invoke("plugin_fs_list", { root: this.project(), path: str(args[0], "path") });
      case "run":
        this.need(p, "commands");
        return invoke("plugin_run", { command: str(args[0], "command"), cwd: this.project() });
      case "terminal.send": {
        this.need(p, "terminal");
        const o = (args[1] ?? {}) as { tab?: string; submit?: boolean };
        const s = this.tabsApi().session(o.tab);
        s.paste(str(args[0], "text"));
        // Submitting: Enter after the paste has landed (Claude Code reads a paste as one chunk).
        if (o.submit) setTimeout(() => s.send("\r"), 80);
        else s.focus();
        return;
      }
      case "terminal.read": {
        this.need(p, "terminal:read");
        const o = (args[0] ?? {}) as { tab?: string; lines?: number };
        const n = Math.min(Math.max(Number(o.lines) || 50, 1), 5000);
        return this.tabsApi().session(o.tab).text(n);
      }
      case "terminal.addLink": {
        this.need(p, "terminal:read");
        const o = (args[0] ?? {}) as { pattern?: string; flags?: string; onClick?: string };
        const pattern = str(o.pattern, "pattern");
        if (pattern.length > 300) throw new Error("pattern is too long");
        const flags = String(o.flags ?? "").replace(/[^imsu]/g, "") + "g";
        const re = new RegExp(pattern, flags);
        if (o.onClick) linkRules.push({ owner: p.id, re, onClick: (text) => this.callback(p.id, o.onClick!, [text]) });
        return;
      }
      case "tabs.list":
        return this.tabsApi().list();
      case "tabs.open": {
        this.need(p, "tabs");
        const o = (args[0] ?? {}) as { kind?: string; cwd?: string; run?: string; args?: unknown; label?: string };
        const kind = o.kind === "shell" ? "shell" : "claude";
        const cwd = o.cwd ? str(o.cwd, "cwd") : this.project();
        const extra = Array.isArray(o.args) ? o.args.map(String).slice(0, 50) : undefined;
        return this.tabsApi().open({
          kind,
          cwd,
          run: kind === "shell" && o.run ? str(o.run, "run") : undefined,
          args: kind === "claude" ? extra : undefined,
          label: o.label ? String(o.label).slice(0, 40) : undefined,
        });
      }
      case "fetch": {
        const url = new URL(str(args[0], "url"));
        const host = url.hostname.toLowerCase();
        const allowed = p.data.granted.some((g) => g === "network" || (g.startsWith("network:") && (host === g.slice(8) || host.endsWith("." + g.slice(8)))));
        if (!allowed) throw new Error(`no permission to connect to ${host}`);
        const o = (args[1] ?? {}) as { method?: string; headers?: Record<string, string>; body?: unknown };
        const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
        const headers = Object.entries(o.headers ?? {}).map(([k, v]) => [String(k), String(v)]);
        if (o.body !== undefined && typeof o.body !== "string" && !headers.some(([k]) => k.toLowerCase() === "content-type")) {
          headers.push(["Content-Type", "application/json"]);
        }
        const res = await invoke<{ status: number; body: string }>("plugin_fetch", { url: url.href, method: o.method ?? "GET", headers, body });
        let json: unknown = null;
        try {
          json = JSON.parse(res.body);
        } catch {
          /* not JSON */
        }
        return { status: res.status, ok: res.status >= 200 && res.status < 300, text: res.body, json };
      }
      default:
        throw new Error(`unknown call: ${method}`);
    }
  }

  // ── plugin windows ────────────────────────────────────

  /** A plugin's HTML file as a small floating window over the terminal area. */
  private async openWindow(p: Plugin, file: string, o: { title?: string; width?: number; height?: number }) {
    const r = this.running.get(p.id)!;
    const existing = r.windows.get(file);
    if (existing) {
      this.windowsHost.append(existing.el); // to the front
      return;
    }
    const html = await invoke<string>("plugin_file", { id: p.id, path: file });
    const el = document.createElement("div");
    el.className = "plugin-window";
    const w = Math.min(Math.max(o.width ?? 380, 200), 1200);
    const h = Math.min(Math.max(o.height ?? 420, 120), 900);
    const n = this.windowsHost.querySelectorAll(".plugin-window").length;
    Object.assign(el.style, { width: `${w}px`, height: `${h}px`, right: `${24 + n * 24}px`, top: `${40 + n * 24}px` });
    el.innerHTML = `<div class="pw-bar"><span class="pw-title"></span><button class="pw-close" tabindex="-1">×</button></div>`;
    el.querySelector(".pw-title")!.textContent = o.title ?? m(p).name;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-forms");
    frame.srcdoc = sandboxDoc(html, true);
    el.append(frame);
    el.querySelector(".pw-close")!.addEventListener("click", () => {
      el.remove();
      r.windows.delete(file);
    });
    // Drag by the title bar; clicking anywhere brings it to the front.
    const bar = el.querySelector<HTMLElement>(".pw-bar")!;
    bar.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest("button") || e.button !== 0) return;
      e.preventDefault();
      this.windowsHost.append(el);
      const box = this.windowsHost.getBoundingClientRect();
      const start = el.getBoundingClientRect();
      const dx = e.clientX - start.left;
      const dy = e.clientY - start.top;
      el.classList.add("moving");
      const move = (ev: PointerEvent) => {
        const x = Math.min(Math.max(ev.clientX - dx - box.left, -start.width + 60), box.width - 60);
        const y = Math.min(Math.max(ev.clientY - dy - box.top, 0), box.height - 30);
        Object.assign(el.style, { left: `${x}px`, top: `${y}px`, right: "auto" });
      };
      const up = () => {
        el.classList.remove("moving");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    el.addEventListener("pointerdown", () => el.nextElementSibling && this.windowsHost.append(el), true);
    this.windowsHost.append(el);
    r.windows.set(file, { el, frame });
  }
}

const m = (p: Plugin) => p.manifest!;

/** A status item's text (short, one line) and tooltip. */
function setStatusText(el: HTMLElement, o: { text?: unknown; title?: unknown }, plugin: string) {
  if (o.text !== undefined) el.textContent = String(o.text).replace(/\s+/g, " ").slice(0, 60);
  if (o.title !== undefined) el.title = (o.title ? `${String(o.title)}\n` : "") + plugin;
  else if (!el.title) el.title = plugin;
}
