import { invoke } from "@tauri-apps/api/core";
import { t, translateTree } from "./i18n";
import { DEFAULTS, Settings, SettingsStore, showCombo } from "./settings";
import { LANGS, MODEL_LABEL, defaultLang } from "./voice";
import { chime } from "./sound";

/**
 * The settings window (Ctrl+,): one short page of the common settings. Everything else is in
 * settings.json, one click away.
 */

interface Ide {
  id: string;
  name: string;
}
interface Mic {
  id: string;
  name: string;
}

export class SettingsWindow {
  onOpenJson: () => void = () => {};
  onInstallClaude: () => void = () => {};
  /** The voice model popover (downloads live there). */
  onVoiceModels: () => void = () => {};
  private el: HTMLElement;
  private returnFocus: HTMLElement | null = null;

  constructor(private store: SettingsStore) {
    this.el = document.createElement("div");
    this.el.id = "settings";
    this.el.hidden = true;
    document.body.append(this.el);
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  async open() {
    this.returnFocus = document.activeElement as HTMLElement | null;
    await this.render();
    this.el.hidden = false;
    this.el.querySelector<HTMLElement>(".st-panel")!.focus();
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.returnFocus?.focus();
  }

  /** settings.json changed while the window is open: show the new values. */
  refresh() {
    if (this.isOpen) this.render();
  }

  private async render() {
    const s = this.store.value;
    const [ides, mics, claude] = await Promise.all([
      invoke<Ide[]>("ide_list").catch(() => [] as Ide[]),
      invoke<Mic[]>("voice_mics").catch(() => [] as Mic[]),
      invoke<string | null>("claude_status").catch(() => null),
    ]);
    const set = (change: (s: Settings) => void) => this.store.update(change);

    const panel = div("st-panel");
    panel.tabIndex = -1;
    const head = div("st-head");
    head.append(span("st-title", "settings"));
    const close = button("×", "st-close icon-btn");
    close.dataset.i18nTitle = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    head.append(close);
    panel.append(head);
    const body = div("st-body");
    panel.append(body);
    const row = (label: string, ...controls: HTMLElement[]) => {
      const r = div("st-row");
      r.append(span("st-label", label));
      const c = div("st-controls");
      c.append(...controls);
      r.append(c);
      body.append(r);
      return c;
    };

    // Language (names in their own language, never translated).
    row(
      "Language",
      select(
        [["en", "English"], ["ru", "Русский"], ["uk", "Українська"]],
        s.language,
        (v) => set((x) => (x.language = v as Settings["language"])),
        false,
      ),
    );

    row(
      "Theme",
      segmented(
        [["dark", "dark"], ["light", "light"]],
        s.theme,
        (v) => set((x) => (x.theme = v as Settings["theme"])),
      ),
    );

    const color = document.createElement("input");
    color.type = "color";
    color.value = s.accent;
    color.className = "st-color";
    color.addEventListener("change", () => set((x) => (x.accent = color.value)));
    const accentControls = [color as HTMLElement];
    if (s.accent.toLowerCase() !== DEFAULTS.accent) {
      const reset = button("reset", "st-link");
      reset.addEventListener("click", () => set((x) => (x.accent = DEFAULTS.accent)));
      accentControls.push(reset);
    }
    row("Accent colour", ...accentControls);

    const font = document.createElement("input");
    font.type = "text";
    font.className = "st-input";
    font.value = s.font.family;
    font.setAttribute("list", "st-fonts");
    font.spellcheck = false;
    const fonts = document.createElement("datalist");
    fonts.id = "st-fonts";
    for (const f of ["Commit Mono", "Cascadia Mono", "Cascadia Code", "Consolas", "JetBrains Mono", "Fira Code", "Menlo", "SF Mono", "DejaVu Sans Mono"]) {
      fonts.append(new Option(f));
    }
    font.addEventListener("change", () => set((x) => (x.font.family = font.value.trim() || DEFAULTS.font.family)));
    const size = document.createElement("input");
    size.type = "number";
    size.min = "9";
    size.max = "32";
    size.className = "st-input st-num";
    size.value = String(s.font.size);
    size.addEventListener("change", () => set((x) => (x.font.size = Number(size.value) || DEFAULTS.font.size)));
    row("Font", font, fonts, size, span("st-unit", "px"));

    const fx = div("st-checks");
    const effects: [keyof Settings["effects"], string][] = [
      ["glow", "neon glow"],
      ["crt", "CRT lines"],
      ["asciiLogo", "ASCII logo"],
      ["typewriter", "typing animation"],
    ];
    for (const [k, label] of effects) {
      fx.append(check(label, s.effects[k], (on) => set((x) => (x.effects[k] = on))));
    }
    row("Effects", fx);

    const vol = document.createElement("input");
    vol.type = "range";
    vol.min = "0";
    vol.max = "100";
    vol.value = String(s.sound.volume);
    vol.className = "st-range";
    vol.disabled = !s.sound.enabled;
    vol.addEventListener("change", () => {
      set((x) => (x.sound.volume = Number(vol.value)));
      chime(Number(vol.value));
    });
    row(
      "Sound when Claude finishes",
      check("on", s.sound.enabled, (on) => set((x) => (x.sound.enabled = on))),
      vol,
    );

    const models = Object.entries(MODEL_LABEL).map(([id, [name]]) => [id, name] as [string, string]);
    const voiceModel = select(models, s.voice.model, (v) => set((x) => (x.voice.model = v)), false);
    voiceModel.title = t("Speech model");
    const mic = select(
      [["", "system default"], ...mics.map((m) => [m.id, m.name] as [string, string])],
      mics.some((m) => m.id === s.voice.microphone) ? s.voice.microphone! : "",
      (v) => set((x) => (x.voice.microphone = v || null)),
    );
    // Translate only the "system default" entry; device names stay as they are.
    for (const o of mic.querySelectorAll("option")) if (o.value) delete o.dataset.i18n;
    mic.title = t("Microphone");
    const speech = select(
      LANGS,
      s.voice.language ?? defaultLang(),
      (v) => set((x) => (x.voice.language = v === defaultLang() ? null : v)),
    );
    speech.title = t("Speech language");
    const manage = button("models…", "st-link");
    manage.addEventListener("click", () => {
      this.close();
      this.onVoiceModels();
    });
    const voiceRow = row("Voice input", voiceModel, mic, speech, manage);
    voiceRow.parentElement!.title = showCombo(s.keys.voice);

    row(
      "Open in IDE",
      select(
        [["", "by project language"], ...ides.map((i) => [i.id, i.name] as [string, string])],
        s.ide ?? "",
        (v) => set((x) => (x.ide = v || null)),
      ),
    );

    const claudeInfo = span("st-claude", claude ? "installed" : "not installed");
    if (claude) claudeInfo.title = claude;
    const claudeControls: HTMLElement[] = [claudeInfo];
    if (!claude) {
      const install = button("Install", "st-btn");
      install.addEventListener("click", () => {
        this.close();
        this.onInstallClaude();
      });
      claudeControls.push(install);
    }
    row("Claude Code", ...claudeControls);

    const foot = div("st-foot");
    foot.append(span("st-note", "Colours, hotkeys, claude's path and arguments, hidden folders and more are in settings.json."));
    const json = button("Open as JSON", "st-btn");
    json.addEventListener("click", () => {
      this.close();
      this.onOpenJson();
    });
    foot.append(json);
    panel.append(foot);

    translateTree(panel);
    this.el.replaceChildren(panel);
  }
}

function div(cls: string) {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function span(cls: string, en: string) {
  const s = document.createElement("span");
  s.className = cls;
  s.dataset.i18n = en;
  s.textContent = en;
  return s;
}

function button(en: string, cls: string) {
  const b = document.createElement("button");
  b.className = cls;
  b.dataset.i18n = en;
  b.textContent = en;
  return b;
}

function select(options: [string, string][], value: string, onChange: (v: string) => void, translate = true) {
  const sel = document.createElement("select");
  sel.className = "st-select";
  for (const [v, label] of options) {
    const o = new Option(label, v);
    if (translate) o.dataset.i18n = label;
    sel.append(o);
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

function segmented(options: [string, string][], value: string, onChange: (v: string) => void) {
  const wrap = div("st-seg");
  for (const [v, label] of options) {
    const b = button(label, v === value ? "on" : "");
    b.addEventListener("click", () => onChange(v));
    wrap.append(b);
  }
  return wrap;
}

function check(en: string, on: boolean, onChange: (on: boolean) => void) {
  const l = document.createElement("label");
  l.className = "st-check";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = on;
  box.addEventListener("change", () => onChange(box.checked));
  l.append(box, span("", en));
  return l;
}
