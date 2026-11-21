import { listen } from "@tauri-apps/api/event";
import { TermSession, TermKind } from "./terminal";
import { chime } from "./sound";
import { isImage, quotePath, imageTagsInInput } from "./attach";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** idle: nothing asked yet · working: Claude is busy · done: finished, waiting for you. */
type Activity = "idle" | "working" | "done";

export interface SavedTab {
  kind: TermKind;
  cwd: string;
  /** Claude session to resume; only set once the session has at least one prompt. */
  sessionId?: string;
  /** Had prompts but no known session id (hooks unavailable): resume with --continue. */
  continue?: boolean;
  /** Which file each "[Image #N]" tag in this Claude session stands for. */
  images?: Record<number, string>;
}

interface Tab extends SavedTab {
  key: string;
  activity: Activity;
  used: boolean;
  /** Claude asked for permission mid-task; the next keystroke means it is working again. */
  awaitingAnswer: boolean;
  images: Record<number, string>;
  el: HTMLElement;
  pane: HTMLElement;
  term: TermSession;
}

function baseName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

let keySeq = 0;
const newKey = () => `${Date.now().toString(36)}-${(keySeq++).toString(36)}`;

export class Tabs {
  private tabs: Tab[] = [];
  private active: Tab | null = null;

  /** Fired when the active tab changes (or the last one closes) and when tabs change at all. */
  onActivate: (cwd: string | null) => void = () => {};
  onChange: () => void = () => {};
  /** Fired when the active tab changes or its terminal is replaced. */
  onTerm: () => void = () => {};

  constructor(
    private strip: HTMLElement,
    private host: HTMLElement,
  ) {
    listen<{ tab: string; event: string; session_id: string | null }>("claude-hook", (e) =>
      this.onHook(e.payload.tab, e.payload.event, e.payload.session_id),
    );
    strip.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      const t = this.fromEl(e.target);
      if (t) this.close(t);
    });
    strip.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault());
    strip.addEventListener("click", (e) => {
      const t = this.fromEl(e.target);
      if (!t) return;
      if ((e.target as HTMLElement).closest(".close")) this.close(t);
      else this.activate(t);
    });
  }

  get activeCwd() {
    return this.active?.cwd ?? null;
  }

  saved(): { tabs: SavedTab[]; active: number } {
    return {
      tabs: this.tabs.map((t) => ({
        kind: t.kind,
        cwd: t.cwd,
        sessionId: t.kind === "claude" && t.used ? t.sessionId : undefined,
        continue: t.kind === "claude" && t.used && !t.sessionId ? true : undefined,
        images: t.kind === "claude" && Object.keys(t.images).length ? t.images : undefined,
      })),
      active: this.active ? this.tabs.indexOf(this.active) : 0,
    };
  }

  /** Opens a tab. `resume` is a session id or "continue". */
  async open(kind: TermKind, cwd: string, opts: { resume?: string; focus?: boolean; images?: Record<number, string> } = {}) {
    const key = newKey();
    const el = document.createElement("div");
    el.className = `tab ${kind}`;
    el.dataset.key = key;
    el.title = cwd;
    el.innerHTML =
      `<span class="dot"></span><span class="kind"></span><span class="dir"></span>` +
      `<button class="close" title="Close (Ctrl+W)" tabindex="-1">×</button>`;
    el.querySelector(".kind")!.textContent = kind;
    el.querySelector(".dir")!.textContent = baseName(cwd);
    this.strip.append(el);

    const pane = document.createElement("div");
    pane.className = "pane";
    pane.hidden = true;
    this.host.append(pane);

    const tab: Tab = {
      key, kind, cwd, el, pane,
      sessionId: opts.resume && opts.resume !== "continue" ? opts.resume : undefined,
      used: !!opts.resume,
      activity: "idle",
      awaitingAnswer: false,
      // Tag numbers belong to one Claude conversation: only keep them when resuming it.
      images: opts.resume ? { ...opts.images } : {},
      term: null!,
    };
    this.tabs.push(tab);
    if (opts.focus !== false || !this.active) this.activate(tab);
    await this.spawn(tab, opts.resume);
    this.onChange();
  }

  private async spawn(tab: Tab, resume?: string) {
    tab.pane.replaceChildren();
    let restarted = false;
    // The conversation to resume is gone: quietly start a fresh session instead.
    const startFresh = () => {
      if (restarted) return;
      restarted = true;
      tab.sessionId = undefined;
      tab.used = false;
      tab.images = {};
      term.dispose();
      this.spawn(tab);
      this.onChange();
    };
    const term = new TermSession(tab.pane, () => {
      if (restarted) return;
      if (resume && failedResume) return startFresh();
      this.setActivity(tab, "idle");
      term.term.write("\r\n\x1b[2m[process exited — press Enter to restart, Ctrl+W to close]\x1b[0m");
      const d = term.term.onKey(({ domEvent }) => {
        if (domEvent.key !== "Enter") return;
        d.dispose();
        term.dispose();
        this.spawn(tab);
      });
    });
    tab.term = term;
    let failedResume = false;
    if (resume) {
      term.onOutput = (text) => {
        if (/No conversation found|No conversations? to continue/i.test(text)) {
          failedResume = true;
          startFresh();
        }
      };
    }
    term.onKey = (e) => {
      // Ctrl+V: let the browser fire a paste event (handled in attach.ts) instead of sending ^V.
      return !(e.type === "keydown" && e.code === "KeyV" && e.ctrlKey && !e.altKey && !e.metaKey);
    };
    term.onInput = () => {
      if (tab.awaitingAnswer) {
        tab.awaitingAnswer = false;
        this.setActivity(tab, "working");
      }
    };
    if (this.active === tab) {
      term.focus();
      this.onTerm();
    }
    try {
      await term.start(tab.kind, tab.cwd, tab.key, resume);
    } catch (err) {
      if (String(err).includes("claude-not-found")) {
        // Stage 1 fallback: turn this tab into a shell. The install screen comes in stage 7.
        tab.kind = "shell";
        tab.el.classList.replace("claude", "shell");
        tab.el.querySelector(".kind")!.textContent = "shell";
        term.dispose();
        await this.spawn(tab);
        tab.term.term.write(
          "\x1b[35mClaude Code not found.\x1b[0m Install it, then press Ctrl+` to open a Claude tab.\r\n\r\n",
        );
      } else {
        term.term.write(`\x1b[31mCould not start the terminal:\x1b[0m ${String(err)}\r\n`);
      }
    }
  }

  /** The active tab's xterm, if any. */
  get activeTerm() {
    return this.active?.term?.term ?? null;
  }

  /** The active tab's terminal session (stays valid if the user switches tabs later). */
  get activeSession() {
    return this.active?.term ?? null;
  }

  get activeKind() {
    return this.active?.kind ?? null;
  }

  /** The file behind "[Image #N]" in the active tab, if Tern pasted it. */
  imagePath(n: number): string | undefined {
    return this.active?.images[n];
  }

  /**
   * Types the paths into the active tab's input, one paste per file. Claude Code turns an image
   * path into an "[Image #N]" tag; Tern notes which file got which number, for the hover preview.
   */
  async attach(paths: string[]) {
    const tab = this.active;
    if (!tab) return;
    tab.term.focus();
    if (tab.kind === "shell") {
      if (paths.length) tab.term.paste(paths.map(quotePath).join(" ") + " ");
      return;
    }
    for (const p of paths) {
      const term = tab.term;
      const before = new Set(imageTagsInInput(term.term));
      term.paste(quotePath(p) + " ");
      if (!isImage(p)) {
        await sleep(80);
        continue;
      }
      // Wait for Claude Code to show the new tag, so the next paste is not merged with this one.
      for (let waited = 0; waited < 2000; waited += 100) {
        await sleep(100);
        if (tab.term !== term) return;
        const fresh = imageTagsInInput(term.term).find((n) => !before.has(n));
        if (fresh !== undefined) {
          tab.images[fresh] = p;
          this.onChange();
          break;
        }
      }
    }
  }

  /**
   * "Ask Claude about this file": puts the path into a Claude tab's input. Uses the active tab if
   * it is a Claude tab, else a Claude tab whose folder holds the file, else any Claude tab.
   */
  async askClaude(path: string) {
    const inside = (t: Tab) => path.toLowerCase().startsWith(t.cwd.toLowerCase());
    let tab = this.active?.kind === "claude" ? this.active : undefined;
    tab ??= this.tabs.find((t) => t.kind === "claude" && inside(t)) ?? this.tabs.find((t) => t.kind === "claude");
    if (!tab) {
      const dir = path.replace(/[\\/][^\\/]+$/, "");
      await this.open("claude", this.active?.cwd ?? dir);
      // Give Claude Code a moment to draw its input before typing into it.
      await sleep(1500);
    } else {
      this.activate(tab);
    }
    await this.attach([path]);
  }

  pasteText(text: string) {
    this.active?.term.paste(text);
  }

  activate(tab: Tab) {
    if (this.active === tab) return tab.term?.focus();
    if (this.active) {
      this.active.el.classList.remove("active");
      this.active.pane.hidden = true;
    }
    this.active = tab;
    tab.el.classList.add("active");
    tab.pane.hidden = false;
    tab.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    // The pane was hidden, so its size may be stale.
    requestAnimationFrame(() => {
      tab.term?.refit();
      tab.term?.focus();
    });
    this.onActivate(tab.cwd);
    this.onTerm();
    this.onChange();
  }

  close(tab: Tab = this.active!) {
    if (!tab) return;
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    tab.term?.dispose();
    tab.el.remove();
    tab.pane.remove();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else {
        this.onActivate(null);
        this.onTerm();
      }
    }
    this.onChange();
  }

  /** Moves to the next (+1) or previous (-1) tab, wrapping around. */
  cycle(dir: 1 | -1) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + dir + this.tabs.length) % this.tabs.length]);
  }

  /** Ctrl+1..8 picks that tab, Ctrl+9 the last one (as in browsers). */
  pick(n: number) {
    const t = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
    if (t) this.activate(t);
  }

  get count() {
    return this.tabs.length;
  }

  private fromEl(target: EventTarget | null): Tab | undefined {
    const el = (target as HTMLElement | null)?.closest<HTMLElement>(".tab");
    return el ? this.tabs.find((t) => t.key === el.dataset.key) : undefined;
  }

  private setActivity(tab: Tab, a: Activity) {
    tab.activity = a;
    tab.el.dataset.activity = a;
  }

  private onHook(key: string, event: string, sessionId: string | null) {
    const tab = this.tabs.find((t) => t.key === key);
    if (!tab) return;
    if (sessionId && sessionId !== tab.sessionId) {
      tab.sessionId = sessionId;
      this.onChange();
    }
    const unseen = !(document.hasFocus() && this.active === tab);
    switch (event) {
      case "UserPromptSubmit":
        tab.awaitingAnswer = false;
        if (!tab.used) {
          tab.used = true;
          this.onChange();
        }
        this.setActivity(tab, "working");
        break;
      case "Stop":
        tab.awaitingAnswer = false;
        if (tab.activity === "working" && unseen) chime();
        this.setActivity(tab, "done");
        break;
      case "Notification":
        // A permission prompt mid-task (an idle reminder after Stop changes nothing).
        if (tab.activity === "working") {
          tab.awaitingAnswer = true;
          if (unseen) chime();
          this.setActivity(tab, "done");
        }
        break;
    }
  }
}
