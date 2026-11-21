import { translateTree } from "./i18n";
import { showCombo } from "./settings";

/** "TERN" in block letters: the launch splash and the start screen. */
export const LOGO = [
  "████████╗███████╗██████╗ ███╗   ██╗",
  "╚══██╔══╝██╔════╝██╔══██╗████╗  ██║",
  "   ██║   █████╗  ██████╔╝██╔██╗ ██║",
  "   ██║   ██╔══╝  ██╔══██╗██║╚██╗██║",
  "   ██║   ███████╗██║  ██║██║ ╚████║",
  "   ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝",
].join("\n");

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/**
 * The logo flashes over the window on launch and fades away. It sits on top of the app, which is
 * already loading underneath, so it never delays the start.
 */
export function showSplash() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const el = document.createElement("div");
  el.id = "splash";
  const pre = document.createElement("pre");
  pre.textContent = LOGO;
  el.append(pre);
  document.body.append(el);
  el.addEventListener("animationend", () => el.remove());
}

/** Shown in place of the terminal when no tab is open: recent projects and how to start. */
export class StartScreen {
  onOpen: (dir: string) => void = () => {};
  onPickFolder: () => void = () => {};
  private el: HTMLElement | null = null;

  constructor(private host: HTMLElement) {}

  show(recent: string[], logo: boolean, keys: { newClaude: string; newShell: string }) {
    this.hide();
    const el = document.createElement("div");
    el.className = "start-screen";
    const head = logo
      ? `<pre class="start-logo"></pre>`
      : `<div class="start-word">tern</div>`;
    el.innerHTML =
      head +
      `<div class="start-sub" data-i18n="a terminal workspace for Claude Code"></div>` +
      `<div class="start-cols">` +
      `<div class="start-recent"><div class="start-label" data-i18n="recent projects"></div><div class="start-list"></div></div>` +
      `<div class="start-actions"><div class="start-label" data-i18n="start"></div>` +
      `<button class="start-btn start-open"><span data-i18n="Open folder…"></span></button>` +
      `<div class="start-keys"><kbd class="k-claude"></kbd> <span data-i18n="Claude in the current folder"></span></div>` +
      `<div class="start-keys"><kbd class="k-shell"></kbd> <span data-i18n="plain terminal"></span></div>` +
      `</div></div>`;
    if (logo) el.querySelector(".start-logo")!.textContent = LOGO;
    el.querySelector(".k-claude")!.textContent = showCombo(keys.newClaude);
    el.querySelector(".k-shell")!.textContent = showCombo(keys.newShell);
    const list = el.querySelector(".start-list")!;
    for (const dir of recent) {
      const b = document.createElement("button");
      b.className = "start-project";
      b.title = dir;
      const name = document.createElement("span");
      name.className = "sp-name";
      name.textContent = baseName(dir);
      const path = document.createElement("span");
      path.className = "sp-path";
      path.textContent = dir;
      b.append(name, path);
      b.addEventListener("click", () => this.onOpen(dir));
      list.append(b);
    }
    if (!recent.length) {
      const none = document.createElement("div");
      none.className = "start-none";
      none.dataset.i18n = "Nothing yet — open a folder to begin.";
      list.append(none);
    }
    el.querySelector(".start-open")!.addEventListener("click", () => this.onPickFolder());
    translateTree(el);
    this.host.append(el);
    this.el = el;
  }

  hide() {
    this.el?.remove();
    this.el = null;
  }
}

/** First launch without Claude Code: offer the official installer. */
export class InstallScreen {
  onInstall: () => void = () => {};
  /** "Don't show again". */
  onNever: () => void = () => {};
  private el: HTMLElement | null = null;

  constructor(private host: HTMLElement) {}

  get isOpen() {
    return this.el !== null;
  }

  show() {
    if (this.el) return;
    const el = document.createElement("div");
    el.className = "install-screen";
    el.innerHTML =
      `<div class="is-box">` +
      `<div class="is-title" data-i18n="Claude Code isn't installed"></div>` +
      `<p data-i18n="Tern works without it: files, the editor, search and a regular terminal."></p>` +
      `<p data-i18n="To talk to Claude, install Claude Code. The official installer runs in a terminal tab, then you sign in to your account right there."></p>` +
      `<div class="is-buttons">` +
      `<button class="is-install primary" data-i18n="Install"></button>` +
      `<button class="is-later" data-i18n="Later"></button>` +
      `<button class="is-never" data-i18n="Don't show again"></button>` +
      `</div></div>`;
    translateTree(el);
    el.querySelector(".is-install")!.addEventListener("click", () => {
      this.hide();
      this.onInstall();
    });
    el.querySelector(".is-later")!.addEventListener("click", () => this.hide());
    el.querySelector(".is-never")!.addEventListener("click", () => {
      this.hide();
      this.onNever();
    });
    this.host.append(el);
    this.el = el;
  }

  hide() {
    this.el?.remove();
    this.el = null;
  }
}
