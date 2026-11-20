/** A short message at the bottom of the window that fades out by itself. */
let el: HTMLElement | null = null;
let timer = 0;

export function toast(text: string, ms = 2600) {
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(timer);
  timer = window.setTimeout(() => el?.classList.remove("show"), ms);
}
