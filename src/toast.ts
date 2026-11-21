/** A short message at the bottom of the window that fades out by itself. */
let el: HTMLElement | null = null;
let timer = 0;
let typing = 0;
/** "Typewriter" effect: Tern's own messages appear letter by letter. */
let typewriter = true;

export function setTypewriter(on: boolean) {
  typewriter = on;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function toast(text: string, ms = 2600, opts: { instant?: boolean } = {}) {
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  clearInterval(typing);
  el.setAttribute("aria-label", text);
  if (typewriter && !opts.instant && !reducedMotion() && text.length < 160) {
    // About 0.3 s for a typical message, however long it is.
    const step = Math.max(1, Math.ceil(text.length / 24));
    let shown = 0;
    el.textContent = "";
    typing = window.setInterval(() => {
      shown = Math.min(text.length, shown + step);
      el!.textContent = text.slice(0, shown);
      if (shown >= text.length) clearInterval(typing);
    }, 12);
  } else {
    el.textContent = text;
  }
  el.classList.add("show");
  clearTimeout(timer);
  timer = window.setTimeout(() => el?.classList.remove("show"), ms);
}
