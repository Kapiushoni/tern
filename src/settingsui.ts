import { paint, WALLPAPERS } from "./wallpapers";
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
  onPlugins: () => void = () => {};
  /** How many plugins are installed / on, for the row. */
  pluginCount: () => { installed: number; on: number } = () => ({ installed: 0, on: 0 });
  private el: HTMLElement;
  private returnFocus: HTMLElement | null = null;
  /** In window mode the settings are a window: this is its content, a pane among the tabs. */
  readonly pane: HTMLElement;
  private docked = false;
  /** The header ("settings" + close). Kept across renders: in window mode it is the title bar. */
  readonly head: HTMLElement;
  /** Whether to open as a window (window mode is on). */
  asWindow: () => boolean = () => false;
  /** Opened or closed as a window: the window layout must follow. */
  onWindow: (open: boolean) => void = () => {};

  constructor(private store: SettingsStore) {
    this.el = document.createElement("div");
    this.el.id = "settings";
    this.el.hidden = true;
    document.body.append(this.el);
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    this.el.addEventListener("keydown", onEsc);
    this.head = div("st-head");
    this.head.append(span("st-title", "settings"));
    const close = button("×", "st-close icon-btn");
    close.dataset.i18nTitle = "Close (Esc)";
    close.addEventListener("click", () => this.close());
    this.head.append(close);
    this.pane = document.createElement("div");
    this.pane.className = "settings-pane";
    this.pane.hidden = true;
    this.pane.addEventListener("keydown", onEsc);
  }

  get isOpen() {
    return this.docked || !this.el.hidden;
  }

  /** Open as a window right now. */
  get isWindow() {
    return this.docked;
  }

  async open() {
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.docked = this.asWindow();
    await this.render();
    if (this.docked) this.onWindow(true);
    else this.el.hidden = false;
    this.target().querySelector<HTMLElement>(".st-panel")?.focus();
  }

  close() {
    if (!this.isOpen) return;
    if (this.docked) {
      this.docked = false;
      this.pane.replaceChildren();
      this.pane.hidden = true;
      this.onWindow(false);
    } else {
      this.el.hidden = true;
    }
    this.returnFocus?.focus();
  }

  private target() {
    return this.docked ? this.pane : this.el;
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
    // As a window, the header is the window's title bar (it lives in the window frame).
    if (!this.docked) panel.append(this.head);
    translateTree(this.head);
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

    // Start screen picture: thumbnails, the tinted one in the current accent.
    const walls = div("st-walls");
    for (const w of [...WALLPAPERS, null]) {
      const id = w?.id ?? "none";
      const b = document.createElement("button");
      b.className = "st-wall" + (id === s.wallpaper ? " on" : "");
      b.title = id;
      if (w) paint(b, w, true);
      else b.append(span("st-wall-none", "no picture"));
      b.addEventListener("click", () => set((x) => (x.wallpaper = id)));
      walls.append(b);
    }
    row("Start screen", walls);

    const font = fontPicker(s.font.family, (name) => set((x) => (x.font.family = name || DEFAULTS.font.family)));
    const size = document.createElement("input");
    size.type = "number";
    size.min = "9";
    size.max = "32";
    size.className = "st-input st-num";
    size.value = String(s.font.size);
    size.addEventListener("change", () => set((x) => (x.font.size = Number(size.value) || DEFAULTS.font.size)));
    row("Font", font, size, span("st-unit", "px"));

    row(
      "Window mode",
      segmented(
        [["tiling", "tiling (like Hyprland)"], ["floating", "floating"]],
        s.windows.layout,
        (v) => set((x) => (x.windows.layout = v as Settings["windows"]["layout"])),
      ),
    );

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

    const pc = this.pluginCount();
    const plugInfo = document.createElement("span");
    plugInfo.className = "st-claude";
    plugInfo.textContent = t("{on} of {n} on", { on: pc.on, n: pc.installed });
    const managePlugins = button("Manage…", "st-btn");
    managePlugins.addEventListener("click", () => {
      this.close();
      this.onPlugins();
    });
    row("Plugins", plugInfo, managePlugins);

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
    this.target().replaceChildren(panel);
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

// ── font picker ──────────────────────────────────────────

let monoFonts: Promise<string[]> | null = null;

/** Installed monospaced fonts (Tern's own Commit Mono first). Checked by measuring: in a
 *  monospaced font "iiii" and "MMMM" are equally wide; a font that isn't there falls back to serif,
 *  which is not, so it drops out too. */
function installedMonoFonts(): Promise<string[]> {
  monoFonts ??= invoke<string[]>("system_fonts")
    .catch(() => [] as string[])
    .then((names) => {
      const ctx = document.createElement("canvas").getContext("2d")!;
      const width = (f: string, text: string) => {
        ctx.font = `20px "${f.replace(/"/g, "")}", serif`;
        return ctx.measureText(text).width;
      };
      const mono = names.filter((f) => Math.abs(width(f, "iiiiiiii") - width(f, "MMMMMMMM")) < 0.5 && width(f, "ilWM") > 0);
      return ["Commit Mono", ...mono.filter((f) => f !== "Commit Mono")];
    });
  return monoFonts;
}

/** A text box with a list of the installed monospaced fonts, each shown in itself. Opens with
 *  the whole list; typing narrows it. */
function fontPicker(value: string, onPick: (name: string) => void) {
  const wrap = div("st-font");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "st-input";
  input.value = value;
  input.spellcheck = false;
  input.autocomplete = "off";
  const arrow = document.createElement("button");
  arrow.className = "st-font-arrow";
  arrow.tabIndex = -1;
  arrow.textContent = "▾";
  const list = div("st-font-list");
  list.hidden = true;
  wrap.append(input, arrow, list);

  let filter = "";
  let sel = -1;
  const show = async () => {
    const all = await installedMonoFonts();
    const f = filter.toLowerCase();
    const shown = f ? all.filter((n) => n.toLowerCase().includes(f)) : all;
    list.replaceChildren();
    for (const name of shown) {
      const o = div("st-font-opt");
      o.textContent = name;
      o.style.fontFamily = `"${name}", monospace`;
      if (name.toLowerCase() === input.value.trim().toLowerCase()) o.classList.add("current");
      o.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(name);
      });
      list.append(o);
    }
    if (!shown.length) list.append(Object.assign(div("st-font-none"), { textContent: t("No matching fonts") }));
    list.hidden = false;
    sel = -1;
    list.querySelector(".current")?.scrollIntoView({ block: "nearest" });
  };
  const hide = () => {
    list.hidden = true;
  };
  const pick = (name: string) => {
    input.value = name;
    hide();
    if (name !== value) onPick(name);
  };
  const move = (d: number) => {
    const opts = [...list.querySelectorAll<HTMLElement>(".st-font-opt")];
    if (!opts.length) return;
    sel = (sel + d + opts.length) % opts.length;
    opts.forEach((o, i) => o.classList.toggle("sel", i === sel));
    opts[sel].scrollIntoView({ block: "nearest" });
  };

  // Opening shows everything; typing filters.
  input.addEventListener("focus", () => {
    filter = "";
    input.select();
    show();
  });
  input.addEventListener("input", () => {
    filter = input.value.trim();
    show();
  });
  input.addEventListener("blur", () => setTimeout(hide, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") {
      const opts = list.querySelectorAll<HTMLElement>(".st-font-opt");
      const chosen = sel >= 0 ? opts[sel]?.textContent : opts.length === 1 ? opts[0].textContent : input.value.trim();
      pick(chosen || value);
      input.blur();
    } else if (e.key === "Escape" && !list.hidden) {
      input.value = value;
      hide();
      // Only close the list, not the settings.
      e.stopPropagation();
    } else return;
    e.preventDefault();
  });
  arrow.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (list.hidden) input.focus();
    else hide();
  });
  return wrap;
}
