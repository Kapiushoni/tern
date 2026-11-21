import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * Ctrl+Shift+F: search the text of every file in the project (ripgrep's engine in Rust). Lives in
 * the sidebar in place of the tree; results stream in grouped by file, a click opens the file at
 * that line.
 */

interface Hit {
  line: number;
  col: number;
  len: number;
  pre: string;
  mat: string;
  post: string;
}
type Event =
  | { type: "file"; path: string; rel: string; hits: Hit[] }
  | { type: "done"; files: number; hits: number; truncated: boolean }
  | { type: "error"; message: string };

export class Search {
  onOpen: (path: string, at: { line: number; col: number; len: number }) => void = () => {};
  /** Shown or hidden: the sidebar switches between the tree and this panel. */
  onToggle: (open: boolean) => void = () => {};
  getRoot: () => string | null = () => null;

  private input: HTMLInputElement;
  private caseBtn: HTMLButtonElement;
  private regexBtn: HTMLButtonElement;
  private status: HTMLElement;
  private results: HTMLElement;
  private timer = 0;
  private run = 0;
  private searchedRoot = "";
  private hits = 0;
  private files = 0;

  constructor(private el: HTMLElement) {
    el.innerHTML =
      `<div class="sr-head">` +
      `<span class="sr-title">search</span>` +
      `<button class="icon-btn sr-close" title="Back to files (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` +
      `</div>` +
      `<div class="sr-box">` +
      `<input type="text" spellcheck="false" autocomplete="off" placeholder="Search in files" />` +
      `<button class="sr-opt" data-opt="case" title="Match case" aria-pressed="false">Aa</button>` +
      `<button class="sr-opt" data-opt="regex" title="Regular expression" aria-pressed="false">.*</button>` +
      `</div>` +
      `<div class="sr-status"></div>` +
      `<div class="sr-results"></div>`;
    this.input = el.querySelector("input")!;
    this.caseBtn = el.querySelector('[data-opt="case"]')!;
    this.regexBtn = el.querySelector('[data-opt="regex"]')!;
    this.status = el.querySelector(".sr-status")!;
    this.results = el.querySelector(".sr-results")!;

    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(this.timer);
        this.start();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.results.querySelector<HTMLElement>(".sr-hit")?.focus();
      }
    });
    for (const b of [this.caseBtn, this.regexBtn]) {
      b.addEventListener("click", () => {
        b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
        this.start();
      });
    }
    el.querySelector(".sr-close")!.addEventListener("click", () => this.close());
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const hit = (e.target as HTMLElement).closest(".sr-hit");
        if (!hit) return;
        e.preventDefault();
        const all = [...this.results.querySelectorAll<HTMLElement>(".sr-file:not(.folded) .sr-hit")];
        const i = all.indexOf(hit as HTMLElement) + (e.key === "ArrowDown" ? 1 : -1);
        if (i < 0) this.input.focus();
        else all[Math.min(i, all.length - 1)]?.focus();
      } else if (e.key === "Enter") {
        (e.target as HTMLElement).closest<HTMLElement>(".sr-hit")?.click();
      }
    });
    this.results.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const hit = t.closest<HTMLElement>(".sr-hit");
      if (hit) {
        const d = hit.dataset;
        this.onOpen(hit.closest<HTMLElement>(".sr-file")!.dataset.path!, {
          line: Number(d.line),
          col: Number(d.col),
          len: Number(d.len),
        });
        return;
      }
      const head = t.closest<HTMLElement>(".sr-fhead");
      if (head) head.parentElement!.classList.toggle("folded");
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    const sel = window.getSelection()?.toString().trim();
    if (sel && !sel.includes("\n") && sel.length < 200) this.input.value = sel;
    this.el.hidden = false;
    this.onToggle(true);
    this.input.focus();
    this.input.select();
    if (this.input.value && this.searchedRoot !== this.getRoot()) this.start();
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    invoke("search_cancel").catch(() => {});
    this.onToggle(false);
  }

  /** The project changed (another tab): search it instead. */
  rootChanged() {
    if (this.isOpen && this.input.value) this.start();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.start(), 220);
  }

  private start() {
    const root = this.getRoot();
    const query = this.input.value;
    const run = ++this.run;
    this.results.replaceChildren();
    this.hits = 0;
    this.files = 0;
    this.searchedRoot = root ?? "";
    if (!root || !query) {
      this.status.textContent = "";
      invoke("search_cancel").catch(() => {});
      return;
    }
    this.status.textContent = "searching…";
    this.status.classList.remove("error");
    const events = new Channel<Event>();
    events.onmessage = (e) => {
      if (run !== this.run) return;
      if (e.type === "file") this.addFile(e.path, e.rel, e.hits);
      else if (e.type === "error") {
        this.status.textContent = e.message;
        this.status.classList.add("error");
      } else {
        const n = (v: number, w: string) => `${v} ${w}${v === 1 ? "" : "s"}`;
        this.status.textContent = e.hits
          ? `${n(e.hits, "result")} in ${n(e.files, "file")}${e.truncated ? " (stopped at the first 5000)" : ""}`
          : "No results";
      }
    };
    invoke("search_text", {
      root,
      query,
      regex: this.regexBtn.getAttribute("aria-pressed") === "true",
      matchCase: this.caseBtn.getAttribute("aria-pressed") === "true",
      onEvent: events,
    }).catch((err) => {
      this.status.textContent = String(err);
      this.status.classList.add("error");
    });
  }

  private addFile(path: string, rel: string, hits: Hit[]) {
    this.files++;
    this.hits += hits.length;
    this.status.textContent = `${this.hits} results in ${this.files} files…`;
    const file = document.createElement("div");
    file.className = "sr-file";
    file.dataset.path = path;
    const head = document.createElement("div");
    head.className = "sr-fhead";
    head.title = rel;
    const slash = rel.lastIndexOf("/");
    const name = document.createElement("span");
    name.className = "sr-fname";
    name.textContent = rel.slice(slash + 1);
    const dir = document.createElement("span");
    dir.className = "sr-fdir";
    dir.textContent = slash > 0 ? rel.slice(0, slash) : "";
    const count = document.createElement("span");
    count.className = "sr-count";
    count.textContent = String(hits.length);
    head.append(name, dir, count);
    file.append(head);
    for (const h of hits) {
      const row = document.createElement("div");
      row.className = "sr-hit";
      row.tabIndex = -1;
      row.dataset.line = String(h.line);
      row.dataset.col = String(h.col);
      row.dataset.len = String(h.len);
      const ln = document.createElement("span");
      ln.className = "sr-ln";
      ln.textContent = String(h.line);
      const text = document.createElement("span");
      text.className = "sr-text";
      const mark = document.createElement("mark");
      mark.textContent = h.mat;
      text.append(h.pre, mark, h.post);
      row.append(ln, text);
      file.append(row);
    }
    // Keep the list in a stable order (the search runs on many threads at once).
    const after = [...this.results.children].find((c) => (c.firstElementChild as HTMLElement).title > rel);
    this.results.insertBefore(file, after ?? null);
  }
}
