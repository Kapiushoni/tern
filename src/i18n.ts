import type { Lang } from "./settings";
import { RU, UK } from "./i18n-strings";

/**
 * Interface languages. Strings are written in English in the code and looked up here; a missing
 * translation simply shows the English. "{name}" marks a value filled in at run time.
 *
 * Static text in the page carries data-i18n (text), data-i18n-title (tooltip) or data-i18n-ph
 * (placeholder) with the English source, so switching the language re-translates it in place.
 */

let lang: Lang = "en";
const TABLES: Record<Lang, Record<string, string>> = { en: {}, ru: RU, uk: UK };

export function setLang(l: Lang) {
  lang = l;
  document.documentElement.lang = l;
  translateTree(document.body);
}

export function currentLang() {
  return lang;
}

export function t(en: string, vars?: Record<string, string | number>): string {
  let s = TABLES[lang][en] ?? en;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Translates every marked element under `root` (and `root` itself). */
export function translateTree(root: Element) {
  const all = [root, ...root.querySelectorAll("[data-i18n], [data-i18n-title], [data-i18n-ph]")];
  for (const el of all) {
    const h = el as HTMLElement;
    if (h.dataset.i18n) h.textContent = t(h.dataset.i18n);
    if (h.dataset.i18nTitle) h.title = t(h.dataset.i18nTitle);
    if (h.dataset.i18nPh) (h as HTMLInputElement).placeholder = t(h.dataset.i18nPh);
  }
}

/** Sets an element's text and remembers the source, so it follows language changes. */
export function tx<T extends HTMLElement>(el: T, en: string): T {
  el.dataset.i18n = en;
  el.textContent = t(en);
  return el;
}

/** The same for a tooltip. */
export function tt<T extends HTMLElement>(el: T, en: string): T {
  el.dataset.i18nTitle = en;
  el.title = t(en);
  return el;
}

/** Plural for counts: English one/other, Russian and Ukrainian one/few/many. */
export function plural(n: number, forms: { one: string; few?: string; many?: string; other: string }) {
  if (lang === "en") return n === 1 ? forms.one : forms.other;
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms.one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms.few ?? forms.other;
  return forms.many ?? forms.other;
}
