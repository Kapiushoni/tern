// The editor's find / replace bar (Ctrl+F, Ctrl+H), in Tern's own look instead of CodeMirror's
// default panel: one row to find with Aa / ab / .* toggles, a match counter and ↑ ↓, and a
// replace row that folds away.
import { EditorView, Panel, runScopeHandlers, ViewUpdate } from "@codemirror/view";
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel,
  replaceAll, replaceNext, setSearchQuery,
} from "@codemirror/search";
import { t } from "./i18n";

/** Counting stops here, so a huge file stays fast while typing. */
const COUNT_LIMIT = 9999;
/** Whether the replace row is unfolded; kept between files. */
let replaceOpen = false;
const panels = new WeakMap<EditorView, FindPanel>();

const svg = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;

class FindPanel implements Panel {
  dom: HTMLElement;
  top = true;
  private query: SearchQuery;
  private find: HTMLInputElement;
  private repl: HTMLInputElement;
  private caseBtn: HTMLButtonElement;
  private wordBtn: HTMLButtonElement;
  private regexBtn: HTMLButtonElement;
  private count: HTMLElement;
  private fold: HTMLButtonElement;

  constructor(private view: EditorView) {
    this.query = getSearchQuery(view.state);
    const dom = (this.dom = document.createElement("div"));
    dom.className = "tf-panel";
    dom.innerHTML =
      `<button class="tf-fold" type="button">${svg("M9 6l6 6-6 6")}</button>` +
      `<div class="tf-rows">` +
      `<div class="tf-row">` +
      `<div class="tf-field">` +
      `<input class="tf-find" type="text" spellcheck="false" autocomplete="off" main-field="true" />` +
      `<button class="tf-opt" data-opt="case" type="button">Aa</button>` +
      `<button class="tf-opt tf-word" data-opt="word" type="button">ab</button>` +
      `<button class="tf-opt" data-opt="regex" type="button">.*</button>` +
      `</div>` +
      `<span class="tf-count"></span>` +
      `<button class="tf-btn" data-act="prev" type="button">${svg("M12 19V5M5 12l7-7 7 7")}</button>` +
      `<button class="tf-btn" data-act="next" type="button">${svg("M12 5v14M5 12l7 7 7-7")}</button>` +
      `<button class="tf-btn" data-act="close" type="button">${svg("M6 6l12 12M18 6L6 18")}</button>` +
      `</div>` +
      `<div class="tf-row tf-replace">` +
      `<div class="tf-field"><input class="tf-repl" type="text" spellcheck="false" autocomplete="off" /></div>` +
      `<button class="tf-text" data-act="replace" type="button"></button>` +
      `<button class="tf-text" data-act="all" type="button"></button>` +
      `</div>` +
      `</div>`;
    this.find = dom.querySelector(".tf-find")!;
    this.repl = dom.querySelector(".tf-repl")!;
    this.caseBtn = dom.querySelector('[data-opt="case"]')!;
    this.wordBtn = dom.querySelector('[data-opt="word"]')!;
    this.regexBtn = dom.querySelector('[data-opt="regex"]')!;
    this.count = dom.querySelector(".tf-count")!;
    this.fold = dom.querySelector(".tf-fold")!;

    this.find.placeholder = t("Find");
    this.repl.placeholder = t("Replace");
    this.caseBtn.title = t("Match case");
    this.wordBtn.title = t("Whole word");
    this.regexBtn.title = t("Regular expression");
    this.fold.title = t("Toggle replace (Ctrl+H)");
    const label = (act: string, text: string) => ((dom.querySelector(`[data-act="${act}"]`) as HTMLElement).title = text);
    label("prev", t("Previous match (Shift+Enter)"));
    label("next", t("Next match (Enter)"));
    label("close", t("Close (Esc)"));
    (dom.querySelector('[data-act="replace"]') as HTMLElement).textContent = t("Replace");
    (dom.querySelector('[data-act="all"]') as HTMLElement).textContent = t("Replace all");

    this.find.addEventListener("input", () => this.commit());
    this.repl.addEventListener("input", () => this.commit());
    for (const b of [this.caseBtn, this.wordBtn, this.regexBtn]) {
      b.addEventListener("click", () => {
        b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
        this.commit();
      });
    }
    this.fold.addEventListener("click", () => this.setReplace(!replaceOpen, true));
    dom.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act === "prev") findPrevious(view);
      else if (act === "next") findNext(view);
      else if (act === "close") closeSearchPanel(view);
      else if (act === "replace") replaceNext(view);
      else if (act === "all") replaceAll(view);
    });
    dom.addEventListener("keydown", (e) => this.onKey(e));
    this.show(this.query);
    this.setReplace(replaceOpen, false);
    panels.set(view, this);
  }

  mount() {
    this.find.select();
    this.recount();
  }

  destroy() {
    panels.delete(this.view);
  }

  update(u: ViewUpdate) {
    for (const tr of u.transactions) {
      for (const e of tr.effects) {
        if (e.is(setSearchQuery) && !e.value.eq(this.query)) this.show(e.value);
      }
    }
    if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) this.recount();
    // A read-only file can be searched but not changed.
    this.dom.classList.toggle("tf-readonly", u.state.readOnly);
  }

  /** Shows the replace row; `focus` moves the cursor into it. */
  setReplace(on: boolean, focus: boolean) {
    replaceOpen = on;
    this.dom.classList.toggle("tf-open", on);
    this.fold.setAttribute("aria-expanded", String(on));
    if (on && focus) this.repl.focus();
  }

  private show(q: SearchQuery) {
    this.query = q;
    this.find.value = q.search;
    this.repl.value = q.replace;
    this.caseBtn.setAttribute("aria-pressed", String(q.caseSensitive));
    this.wordBtn.setAttribute("aria-pressed", String(q.wholeWord));
    this.regexBtn.setAttribute("aria-pressed", String(q.regexp));
  }

  private commit() {
    const q = new SearchQuery({
      search: this.find.value,
      replace: this.repl.value,
      caseSensitive: this.caseBtn.getAttribute("aria-pressed") === "true",
      wholeWord: this.wordBtn.getAttribute("aria-pressed") === "true",
      regexp: this.regexBtn.getAttribute("aria-pressed") === "true",
    });
    if (q.eq(this.query)) return;
    this.query = q;
    this.view.dispatch({ effects: setSearchQuery.of(q) });
  }

  /** "3 of 12": which match the selection is on, and how many there are. */
  private recount() {
    const q = this.query;
    this.find.classList.remove("tf-bad");
    if (!q.search) {
      this.count.textContent = "";
      return;
    }
    if (!q.valid) {
      this.count.textContent = t("Invalid pattern");
      this.find.classList.add("tf-bad");
      return;
    }
    const sel = this.view.state.selection.main;
    let n = 0;
    let at = 0;
    const cur = q.getCursor(this.view.state);
    for (let m = cur.next(); !m.done; m = cur.next()) {
      n++;
      if (m.value.from === sel.from && m.value.to === sel.to) at = n;
      if (n >= COUNT_LIMIT) break;
    }
    const total = n >= COUNT_LIMIT ? `${COUNT_LIMIT}+` : String(n);
    if (!n) {
      this.count.textContent = t("No results");
      this.find.classList.add("tf-bad");
    } else this.count.textContent = at ? t("{at} of {n}", { at, n: total }) : t("{n} found", { n: total });
  }

  private onKey(e: KeyboardEvent) {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    const inRepl = e.target === this.repl;
    if (e.key === "Enter" && e.target === this.find) {
      (e.shiftKey ? findPrevious : findNext)(this.view);
      e.preventDefault();
    } else if (e.key === "Enter" && inRepl) {
      ((e.ctrlKey || e.metaKey) && e.altKey ? replaceAll : replaceNext)(this.view);
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.code === "KeyH") {
      this.setReplace(true, true);
      e.preventDefault();
    } else if (e.altKey && !e.ctrlKey && !e.metaKey) {
      // Alt+C / Alt+W / Alt+R flip the options, as in VS Code.
      const b = { KeyC: this.caseBtn, KeyW: this.wordBtn, KeyR: this.regexBtn }[e.code];
      if (b) {
        b.click();
        e.preventDefault();
      }
    }
  }
}

export const createFindPanel = (view: EditorView): Panel => new FindPanel(view);

/** Ctrl+H: opens the bar with the replace row unfolded. */
export function openReplace(view: EditorView): boolean {
  if (view.state.readOnly) return openSearchPanel(view);
  replaceOpen = true;
  openSearchPanel(view);
  panels.get(view)?.setReplace(true, true);
  return true;
}
