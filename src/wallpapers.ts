import tern from "./wallpapers/tern.jpg";
import ternThumb from "./wallpapers/tern-thumb.jpg";
import moon from "./wallpapers/moon.jpg";
import moonThumb from "./wallpapers/moon-thumb.jpg";
import island from "./wallpapers/island.jpg";
import islandThumb from "./wallpapers/island-thumb.jpg";
import forest from "./wallpapers/forest.jpg";
import forestThumb from "./wallpapers/forest-thumb.jpg";

/**
 * Start screen pictures. A "tinted" one is a black-and-white brightness mask that CSS multiplies
 * by the accent colour (background-blend-mode), so its glow follows the theme's accent. The
 * others are ordinary photos, shown as they are.
 */
export interface Wallpaper {
  id: string;
  url: string;
  thumb: string;
  tinted: boolean;
}

export const WALLPAPERS: Wallpaper[] = [
  { id: "tern", url: tern, thumb: ternThumb, tinted: true },
  { id: "moon", url: moon, thumb: moonThumb, tinted: false },
  { id: "island", url: island, thumb: islandThumb, tinted: false },
  { id: "forest", url: forest, thumb: forestThumb, tinted: false },
];

export const WALLPAPER_IDS = [...WALLPAPERS.map((w) => w.id), "none"];

export const wallpaper = (id: string) => WALLPAPERS.find((w) => w.id === id) ?? null;

/** Sets an element's background to a wallpaper (or its thumbnail). */
export function paint(el: HTMLElement, w: Wallpaper, thumb = false) {
  el.style.backgroundImage = `url("${thumb ? w.thumb : w.url}")`;
  el.classList.toggle("wall-tinted", w.tinted);
}
