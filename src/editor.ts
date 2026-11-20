import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { CodeEditor } from "./cm";
import { isImage } from "./attach";

const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
const isMarkdown = (p: string) => /\.(md|markdown)$/i.test(p);
const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

type Mode = "code" | "preview" | "image" | "message";

/**
 * The file panel to the right of the terminal: code with highlighting (CodeMirror), images, and
 * Markdown with a text / preview switch. Saves with Ctrl+S, follows changes made on disk and asks
 * before throwing away unsaved edits.
 */
export class Editor {
  path: string | null = null;
  private mtime = 0;
  private code: CodeEditor | null = null;
  private dirty = false;
  private mode: Mode = "code";
  /** Text as last loaded or saved, to tell a real disk change from our own save. */
  private savedText = "";
  /** A question shown in the bar; resolved by its buttons. */
  private pending: ((choice: string) => void) | null = null;

  private head: HTMLElement;
  private nameEl: HTMLElement;
  private dirEl: HTMLElement;
  private modeBtn: HTMLButtonElement;
  private bar: HTMLElement;
  private body: HTMLElement;

  /** Opened, closed or saved: the session remembers the open file. */
  onChange: () => void = () => {};

  constructor(private panel: HTMLElement) {
    this.head = panel.querySelector(".ed-head")!;
    this.nameEl = panel.querySelector(".ed-name")!;
    this.dirEl = panel.querySelector(".ed-dir")!;
    this.modeBtn = panel.querySelector(".ed-mode")!;
    this.bar = panel.querySelector(".ed-bar")!;
    this.body = panel.querySelector(".ed-body")!;

    panel.querySelector(".ed-close")!.addEventListener("click", () => this.close());
    this.modeBtn.addEventListener("click", () => this.toggleMarkdown());
    this.bar.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-choice]");
      if (!b || !this.pending) return;
      const done = this.pending;
      this.pending = null;
      this.hideBar();
      done(b.dataset.choice!);
    });
    // Esc closes the panel, unless CodeMirror's search panel is open (Esc closes that first).
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || panel.querySelector(".cm-search")) return;
      e.preventDefault();
      this.close();
    });
  }

  get isOpen() {
    return this.path !== null;
  }

  async open(path: string, opts: { focus?: boolean } = {}) {
    if (this.path && samePath(this.path, path)) {
      if (opts.focus !== false) this.focus();
      return;
    }
    if (!(await this.confirmLeave())) return;
    this.teardown();
    this.path = path;
    this.panel.hidden = false;
    document.getElementById("app")!.classList.add("with-editor");
    this.nameEl.textContent = baseName(path);
    this.dirEl.textContent = path.slice(0, path.length - baseName(path).length).replace(/[\\/]$/, "");
    this.head.title = path;
    this.modeBtn.hidden = !isMarkdown(path);

    if (isImage(path)) {
      this.mode = "image";
      const img = document.createElement("img");
      img.src = convertFileSrc(path) + `?t=${Date.now()}`;
      img.className = "ed-image";
      img.onerror = () => this.message("Can't show this image.");
      this.body.replaceChildren(img);
    } else {
      await this.load(isMarkdown(path) ? "preview" : "code", opts.focus !== false);
    }
    this.onChange();
  }

  /** Loads the file's text into the code view or the Markdown preview. */
  private async load(mode: "code" | "preview", focus: boolean) {
    const path = this.path!;
    let file: { text: string; mtime: number };
    try {
      file = await invoke("read_text", { path });
    } catch (err) {
      const e = String(err);
      this.message(
        e === "too-large" ? "This file is too big to open here (over 5 MB)."
          : e === "binary" ? "This is not a text file."
          : `Can't open the file: ${e}`,
      );
      return;
    }
    if (this.path !== path) return;
    this.mtime = file.mtime;
    this.savedText = file.text;
    this.setDirty(false);
    if (mode === "preview") {
      await this.showPreview(file.text);
    } else {
      await this.showCode(file.text);
      if (focus) this.focus();
    }
  }

  private async showCode(text: string) {
    const path = this.path!;
    const { createEditor } = await import("./cm");
    if (this.path !== path) return;
    this.code?.destroy();
    this.body.replaceChildren();
    this.code = await createEditor(this.body, path, text, {
      save: () => this.save(),
      change: () => this.setDirty(this.code!.text() !== this.savedText),
    });
    this.mode = "code";
    this.modeBtn.textContent = "preview";
  }

  private async showPreview(text: string) {
    const [{ marked }, { default: DOMPurify }] = await Promise.all([import("marked"), import("dompurify")]);
    // Sanitised: a Markdown file must never be able to run script inside Tern.
    const html = DOMPurify.sanitize(await marked.parse(text), { USE_PROFILES: { html: true } });
    const div = document.createElement("div");
    div.className = "md-preview";
    div.innerHTML = html;
    div.tabIndex = -1;
    // Links would navigate Tern's own window away: ignore them for now.
    div.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("a")) e.preventDefault();
    });
    this.code?.destroy();
    this.code = null;
    this.body.replaceChildren(div);
    this.mode = "preview";
    this.modeBtn.textContent = "text";
  }

  private async toggleMarkdown() {
    if (!this.path) return;
    if (this.mode === "preview") {
      await this.showCode(this.savedText);
      this.focus();
    } else if (this.mode === "code") {
      if (this.dirty) await this.save();
      if (!this.dirty) await this.showPreview(this.code?.text() ?? this.savedText);
    }
  }

  private message(text: string) {
    this.code?.destroy();
    this.code = null;
    this.mode = "message";
    const m = document.createElement("div");
    m.className = "ed-message";
    m.textContent = text;
    this.body.replaceChildren(m);
  }

  focus() {
    if (this.code) this.code.view.focus();
    else this.body.querySelector<HTMLElement>(".md-preview")?.focus();
  }

  async save(force = false): Promise<boolean> {
    if (!this.path || !this.code) return false;
    const text = this.code.text();
    try {
      this.mtime = await invoke<number>("write_text", {
        path: this.path,
        text,
        expectedMtime: force ? null : this.mtime,
      });
      this.savedText = text;
      this.setDirty(this.code.text() !== text);
      this.onChange();
      return true;
    } catch (err) {
      if (String(err) === "changed-on-disk") {
        const c = await this.ask("The file was changed on disk since you opened it.", [
          ["overwrite", "Overwrite with mine"],
          ["reload", "Load theirs"],
          ["cancel", "Cancel"],
        ]);
        if (c === "overwrite") return this.save(true);
        if (c === "reload") await this.reloadFromDisk();
        return false;
      }
      await this.ask(`Could not save: ${err}`, [["ok", "OK"]]);
      return false;
    }
  }

  /** Called with the paths the watcher reports. */
  async onDiskChange(paths: string[]) {
    if (!this.path || !paths.some((p) => samePath(p, this.path!))) return;
    if (this.mode === "image") {
      const img = this.body.querySelector<HTMLImageElement>("img");
      if (img) img.src = convertFileSrc(this.path) + `?t=${Date.now()}`;
      return;
    }
    let file: { text: string; mtime: number };
    try {
      file = await invoke("read_text", { path: this.path });
    } catch {
      return; // deleted or unreadable: keep what is shown; saving will recreate it
    }
    if (file.text === this.savedText) {
      this.mtime = file.mtime; // our own save, or no real change
      return;
    }
    if (!this.dirty) {
      this.apply(file);
      return;
    }
    const c = await this.ask("The file changed on disk, and you have unsaved edits.", [
      ["theirs", "Load the new version"],
      ["mine", "Keep mine"],
    ]);
    if (c === "theirs") this.apply(file);
  }

  private apply(file: { text: string; mtime: number }) {
    this.mtime = file.mtime;
    this.savedText = file.text;
    if (this.mode === "code" && this.code) this.code.replace(file.text);
    else if (this.mode === "preview") this.showPreview(file.text);
    this.setDirty(false);
  }

  private async reloadFromDisk() {
    if (!this.path) return;
    try {
      this.apply(await invoke("read_text", { path: this.path }));
    } catch {
      /* gone: keep the buffer */
    }
  }

  /** Before switching files or closing: false if the user wants to stay. */
  private async confirmLeave(): Promise<boolean> {
    if (!this.dirty) return true;
    const c = await this.ask(`Save changes to ${baseName(this.path!)}?`, [
      ["save", "Save"],
      ["discard", "Don't save"],
      ["cancel", "Cancel"],
    ]);
    if (c === "save") return this.save();
    return c === "discard";
  }

  async close() {
    if (!this.path || !(await this.confirmLeave())) return;
    this.teardown();
    this.path = null;
    this.panel.hidden = true;
    document.getElementById("app")!.classList.remove("with-editor");
    this.onChange();
  }

  private teardown() {
    this.code?.destroy();
    this.code = null;
    this.body.replaceChildren();
    this.hideBar();
    this.setDirty(false);
  }

  private setDirty(on: boolean) {
    this.dirty = on;
    this.panel.classList.toggle("dirty", on);
  }

  private ask(text: string, choices: [string, string][]): Promise<string> {
    this.pending?.("cancel");
    const msg = document.createElement("span");
    msg.textContent = text;
    const buttons = choices.map(([id, label]) => {
      const b = document.createElement("button");
      b.dataset.choice = id;
      b.textContent = label;
      return b;
    });
    this.bar.replaceChildren(msg, ...buttons);
    this.bar.hidden = false;
    buttons[0]?.focus();
    return new Promise((resolve) => (this.pending = resolve));
  }

  private hideBar() {
    this.bar.hidden = true;
    this.bar.replaceChildren();
  }
}
