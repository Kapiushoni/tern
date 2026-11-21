/**
 * File and folder icons from the Material Icon Theme (the popular VS Code icon theme, MIT).
 * src/icon-map.json says which icon a name gets (scripts/gen-icon-map.mjs builds it from the
 * theme's manifest); the SVGs ship as separate files and load only when shown.
 */

interface IconMap {
  file: string;
  folder: string;
  folderOpen: string;
  ext: Record<string, string>;
  names: Record<string, string>;
  folders: Record<string, string>;
  light: { ext: Record<string, string>; names: Record<string, string>; folders: Record<string, string> };
}

// File URLs only (see vite.config.ts): nothing is read until an <img> asks for it.
const URLS = import.meta.glob("/node_modules/material-icon-theme/icons/*.svg", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;
const url = (icon: string) => URLS[`/node_modules/material-icon-theme/icons/${icon}.svg`];

let MAP: IconMap | null = null;
/** Resolves once the name → icon table is loaded (a small separate chunk). */
export const iconsReady: Promise<void> = import("./icon-map.json").then((m) => {
  MAP = m.default as IconMap;
});

const light = () => document.documentElement.dataset.theme === "light";

function fileIconName(name: string): string {
  if (!MAP) return "file";
  const lower = name.toLowerCase();
  const l = light();
  const byName = (l && MAP.light.names[lower]) || MAP.names[lower];
  if (byName) return byName;
  // Longest extension first: "app.spec.ts" tries "spec.ts", then "ts".
  for (let i = lower.indexOf("."); i !== -1; i = lower.indexOf(".", i + 1)) {
    const ext = lower.slice(i + 1);
    const hit = (l && MAP.light.ext[ext]) || MAP.ext[ext];
    if (hit) return hit;
  }
  return MAP.file;
}

function folderIconName(name: string, open: boolean): string {
  if (!MAP) return open ? "folder-open" : "folder";
  const lower = name.toLowerCase();
  const base = (light() && MAP.light.folders[lower]) || MAP.folders[lower];
  if (!base) return open ? MAP.folderOpen : MAP.folder;
  const openName = `${base}-open`;
  return open && url(openName) ? openName : base;
}

function paint(el: HTMLImageElement) {
  const name = el.dataset.name ?? "";
  const icon = el.dataset.dir ? folderIconName(name, el.dataset.open === "1") : fileIconName(name);
  const src = url(icon) ?? url(el.dataset.dir ? "folder" : "file");
  if (src && el.getAttribute("src") !== src) el.src = src;
}

/** The icon element for a tree row. */
export function fileIcon(name: string, isDir: boolean, open = false): HTMLElement {
  const el = document.createElement("img");
  el.className = "ficon";
  el.alt = "";
  el.draggable = false;
  el.decoding = "async";
  el.dataset.name = name;
  if (isDir) el.dataset.dir = "1";
  if (open) el.dataset.open = "1";
  paint(el);
  return el;
}

/** Switches a folder icon between open and closed. */
export function setFolderOpen(el: Element | null, open: boolean) {
  if (!(el instanceof HTMLImageElement) || !el.dataset.dir) return;
  el.dataset.open = open ? "1" : "";
  paint(el);
}

/** Repaints every icon under `root` (the theme changed: some icons have light variants). */
export function repaintIcons(root: ParentNode) {
  root.querySelectorAll<HTMLImageElement>("img.ficon").forEach(paint);
}
