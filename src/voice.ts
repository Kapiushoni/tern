import { invoke, Channel } from "@tauri-apps/api/core";
import type { Tabs } from "./tabs";
import type { TermSession } from "./terminal";
import { toast } from "./toast";
import { t, tt } from "./i18n";
import { matches, showCombo } from "./settings";

/**
 * Voice input: Alt+Z (or the mic button) starts recording, pressing again stops it, and the
 * recognised text is typed into the tab's input line, not sent. Esc throws a recording away.
 * Speech is recognised offline by whisper.cpp; the model is downloaded on first use.
 */

export interface VoiceSettings {
  model: string;
  /** Microphone id; unset = the system default. */
  mic?: string;
  /** whisper language code or "auto"; unset = the system language. */
  lang?: string;
}

interface ModelInfo {
  id: string;
  size: number;
  installed: boolean;
}
interface Mic {
  id: string;
  name: string;
  default: boolean;
}

export const MODEL_LABEL: Record<string, [string, string]> = {
  small: ["small", "fast, good for most speech"],
  "large-v3-turbo": ["large-v3-turbo", "more accurate, slower"],
};
export const LANGS: [string, string][] = [
  ["auto", "auto-detect (slower)"],
  ["en", "English"],
  ["ru", "Русский"],
  ["uk", "Українська"],
];

/** Speaking the system's language is the likely case; detecting it costs seconds per phrase. */
export function defaultLang() {
  const sys = navigator.language.slice(0, 2).toLowerCase();
  return LANGS.some(([code]) => code === sys) ? sys : "en";
}

const MIC =
  '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';

type Phase = "idle" | "starting" | "recording" | "busy";

export class Voice {
  settings: VoiceSettings = { model: "small" };
  /** Called when settings change, so they can be saved. */
  onChange: () => void = () => {};
  /** The start / stop key (from settings). */
  key = "Alt+Z";

  private phase: Phase = "idle";
  private button: HTMLButtonElement;
  private pill: HTMLElement;
  private pop: HTMLElement;
  private target: TermSession | null = null;
  private downloading = false;
  private startedAt = 0;
  private clock = 0;

  constructor(
    private tabs: Tabs,
    tools: HTMLElement,
    private host: HTMLElement,
  ) {
    this.button = document.createElement("button");
    this.button.id = "btn-voice";
    tt(this.button, "Voice input (Alt+Z) — right-click for options");
    this.button.tabIndex = -1;
    this.button.innerHTML = MIC;
    this.button.addEventListener("mousedown", (e) => e.preventDefault());
    this.button.addEventListener("click", () => this.toggle());
    this.button.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openPop();
    });
    tools.prepend(this.button);

    this.pill = document.createElement("div");
    this.pill.id = "voice-pill";
    this.pill.hidden = true;
    host.append(this.pill);

    this.pop = document.createElement("div");
    this.pop.id = "voice-pop";
    this.pop.hidden = true;
    document.body.append(this.pop);
    document.addEventListener("mousedown", (e) => {
      if (!this.pop.hidden && !this.pop.contains(e.target as Node) && e.target !== this.button) this.closePop();
    });

    window.addEventListener(
      "keydown",
      (e) => {
        if (matches(e, this.key)) {
          e.preventDefault();
          e.stopPropagation();
          if (!e.repeat) this.toggle();
        } else if (e.key === "Escape" && !this.pop.hidden) {
          e.preventDefault();
          e.stopPropagation();
          this.closePop();
        } else if (e.key === "Escape" && (this.phase === "recording" || this.phase === "starting")) {
          e.preventDefault();
          e.stopPropagation();
          this.cancel();
        }
      },
      { capture: true },
    );
  }

  private get lang() {
    return this.settings.lang ?? defaultLang();
  }

  async toggle() {
    if (this.phase === "recording") return this.stop();
    if (this.phase !== "idle") return;
    const session = this.tabs.activeSession;
    if (!session) return toast(t("Open a terminal tab first"));
    const models = await invoke<ModelInfo[]>("voice_models").catch(() => []);
    if (!models.find((m) => m.id === this.settings.model)?.installed) {
      const other = models.find((m) => m.installed);
      if (!other) return this.openPop();
      this.settings.model = other.id;
      this.onChange();
    }
    this.target = session;
    this.setPhase("starting");
    const levels = new Channel<number>();
    levels.onmessage = (v) => this.host.style.setProperty("--voice-level", Math.min(1, v * 4).toFixed(2));
    try {
      await invoke("voice_start", { mic: this.settings.mic ?? null, model: this.settings.model, onLevel: levels });
    } catch (err) {
      this.setPhase("idle");
      return toast(micError(String(err)), 4000);
    }
    if ((this.phase as Phase) !== "starting") {
      // Cancelled while the microphone was opening.
      invoke("voice_cancel").catch(() => {});
      return;
    }
    this.startedAt = Date.now();
    this.setPhase("recording");
  }

  private async stop() {
    this.setPhase("busy");
    const target = this.target;
    try {
      const text = await invoke<string>("voice_stop", { model: this.settings.model, lang: this.lang === "auto" ? null : this.lang });
      if (!text) toast(t("Didn't catch any speech"));
      else if (target) {
        target.paste(text + " ");
        target.focus();
      }
    } catch (err) {
      toast(t("Voice input failed: {error}", { error: String(err).replace(/^\w+: /, "") }), 4000);
    }
    this.setPhase("idle");
  }

  private cancel() {
    invoke("voice_cancel").catch(() => {});
    this.setPhase("idle");
    toast(t("Recording discarded"));
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.button.classList.toggle("rec", p === "recording" || p === "starting");
    this.button.classList.toggle("busy", p === "busy");
    this.host.classList.toggle("listening", p === "recording");
    clearInterval(this.clock);
    if (p === "idle") {
      this.pill.hidden = true;
      this.host.style.removeProperty("--voice-level");
      return;
    }
    this.pill.hidden = false;
    this.pill.className = p;
    if (p === "busy") {
      this.pill.innerHTML = `<span class="vp-dots"><i></i><i></i><i></i></span> ${t("transcribing…")}`;
      return;
    }
    const draw = () => {
      const s = Math.max(0, Math.round((Date.now() - (this.startedAt || Date.now())) / 1000));
      const time = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      this.pill.innerHTML =
        `<span class="vp-dot"></span><span class="vp-bars"><i></i><i></i><i></i><i></i><i></i></span>` +
        `<span class="vp-time">${time}</span><span class="vp-hint">${t("{key} stop · Esc cancel", { key: showCombo(this.key) })}</span>`;
    };
    draw();
    this.clock = window.setInterval(draw, 1000);
  }

  // ── options / model download ──────────────────────────

  async openPop() {
    const [models, mics] = await Promise.all([
      invoke<ModelInfo[]>("voice_models").catch(() => [] as ModelInfo[]),
      invoke<Mic[]>("voice_mics").catch(() => [] as Mic[]),
    ]);
    const anyInstalled = models.some((m) => m.installed);
    const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
    const pop = this.pop;
    pop.innerHTML = "";

    const title = el("div", "vo-title", t("voice input"));
    const note = el(
      "div",
      "vo-note",
      anyInstalled
        ? t("{key} to start and stop. Speech is recognised on this computer, offline.", { key: showCombo(this.key) })
        : t("Speech is recognised on this computer, offline. It needs a speech model, downloaded once."),
    );
    pop.append(title, note);

    pop.append(el("div", "vo-label", t("model")));
    for (const m of models) {
      const [name, desc] = MODEL_LABEL[m.id] ?? [m.id, ""];
      const row = el("label", "vo-model");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "vo-model";
      radio.checked = m.id === this.settings.model;
      radio.addEventListener("change", () => {
        this.settings.model = m.id;
        this.onChange();
        this.openPop();
      });
      const text = el("span", "vo-mtext");
      text.append(el("span", "vo-mname", name), el("span", "vo-mdesc", `${mb(m.size)} · ${t(desc)}`));
      row.append(radio, text);
      if (m.installed) {
        const del = el("button", "vo-del", t("delete"));
        del.title = t("Delete the downloaded model");
        del.addEventListener("click", async (e) => {
          e.preventDefault();
          await invoke("voice_delete_model", { model: m.id }).catch((err) => toast(String(err)));
          this.openPop();
        });
        row.append(el("span", "vo-ok", "✓"), del);
      }
      pop.append(row);
    }

    const chosen = models.find((m) => m.id === this.settings.model);
    if (chosen && !chosen.installed) {
      const dl = el("div", "vo-dl");
      const btn = el("button", "vo-btn", t("download {model} · {size}", { model: MODEL_LABEL[chosen.id]?.[0] ?? chosen.id, size: mb(chosen.size) }));
      const bar = el("div", "vo-bar");
      const fill = el("i", "");
      bar.append(fill);
      bar.hidden = true;
      const status = el("span", "vo-status");
      btn.addEventListener("click", () => this.download(chosen, btn, bar, fill, status));
      if (this.downloading) {
        btn.textContent = t("cancel");
        bar.hidden = false;
        status.textContent = t("downloading…");
      }
      dl.append(btn, bar, status);
      pop.append(dl);
    }

    pop.append(el("div", "vo-label", t("microphone")));
    const micSel = document.createElement("select");
    micSel.className = "vo-select";
    micSel.append(new Option(t("system default"), ""));
    for (const m of mics) micSel.append(new Option(m.name, m.id));
    micSel.value = mics.some((m) => m.id === this.settings.mic) ? this.settings.mic! : "";
    micSel.addEventListener("change", () => {
      this.settings.mic = micSel.value || undefined;
      this.onChange();
    });
    if (!mics.length) micSel.title = t("No microphone found");
    pop.append(micSel);

    pop.append(el("div", "vo-label", t("language")));
    const langSel = document.createElement("select");
    langSel.className = "vo-select";
    for (const [code, name] of LANGS) langSel.append(new Option(t(name), code));
    langSel.value = this.lang;
    langSel.addEventListener("change", () => {
      this.settings.lang = langSel.value === defaultLang() ? undefined : langSel.value;
      this.onChange();
    });
    pop.append(langSel);

    pop.hidden = false;
    this.placePop();
  }

  private placePop() {
    const b = this.button.getBoundingClientRect();
    const anchor = b.width ? b : this.host.getBoundingClientRect();
    const w = this.pop.offsetWidth;
    const h = this.pop.offsetHeight;
    const left = Math.max(8, Math.min(anchor.right - w, window.innerWidth - w - 8));
    const top = b.width ? (anchor.top - h - 8 >= 8 ? anchor.top - h - 8 : anchor.bottom + 8) : anchor.bottom - h - 16;
    this.pop.style.left = `${left}px`;
    this.pop.style.top = `${Math.max(8, top)}px`;
  }

  private closePop() {
    this.pop.hidden = true;
    this.tabs.activeSession?.focus();
  }

  private async download(m: ModelInfo, btn: HTMLElement, bar: HTMLElement, fill: HTMLElement, status: HTMLElement) {
    if (this.downloading) {
      invoke("voice_download_cancel").catch(() => {});
      return;
    }
    this.downloading = true;
    btn.textContent = t("cancel");
    bar.hidden = false;
    status.textContent = t("connecting…");
    const events = new Channel<{ type: "progress"; done: number; total: number }>();
    events.onmessage = (e) => {
      const pct = e.total ? (e.done / e.total) * 100 : 0;
      fill.style.width = `${pct}%`;
      status.textContent = `${Math.round(e.done / 1048576)} / ${Math.round((e.total || m.size) / 1048576)} MB`;
    };
    try {
      await invoke("voice_download", { model: m.id, onEvent: events });
      this.downloading = false;
      toast(t("Speech model ready — press {key} to talk", { key: showCombo(this.key) }));
      this.openPop();
    } catch (err) {
      this.downloading = false;
      const msg = String(err);
      if (msg === "cancelled") this.openPop();
      else {
        btn.textContent = t("retry");
        status.textContent = msg.startsWith("network") ? t("no connection — try again") : msg;
      }
    }
  }
}

function micError(err: string) {
  if (err === "no-model") return t("Download a speech model first (right-click the mic)");
  if (err.includes("none")) return t("No microphone found");
  return t("Microphone unavailable — check Windows privacy settings ({error})", { error: err.replace(/^mic: /, "") });
}

function el(tag: string, cls: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
