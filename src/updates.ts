import { check, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { t, translateTree } from "./i18n";
import { toast } from "./toast";

/**
 * Checks GitHub for a new version a few seconds after start and then every few hours, and offers
 * it in a small card. Updates are signed; Tern refuses one whose signature doesn't match.
 */

const FIRST_CHECK = 5_000;
const EVERY = 6 * 60 * 60 * 1000;

let card: HTMLElement | null = null;
let offered = "";

export function startUpdateChecks() {
  // Dev builds have nothing to update.
  if (!import.meta.env.PROD) return;
  setTimeout(run, FIRST_CHECK);
  setInterval(run, EVERY);
}

async function run() {
  let update: Update | null = null;
  try {
    update = await check();
  } catch {
    return; // offline, or GitHub unreachable: try again later
  }
  if (!update || update.version === offered) return;
  offered = update.version;
  show(update);
}

function show(update: Update) {
  card?.remove();
  card = document.createElement("div");
  card.id = "update-card";
  card.innerHTML =
    `<div class="uc-title"></div>` +
    `<div class="uc-buttons">` +
    `<button class="uc-install primary" data-i18n="Install and restart"></button>` +
    `<button class="uc-later" data-i18n="Later"></button>` +
    `</div>`;
  card.querySelector(".uc-title")!.textContent = t("Tern {version} is available", { version: update.version });
  translateTree(card);
  card.querySelector(".uc-later")!.addEventListener("click", () => card?.remove());
  card.querySelector(".uc-install")!.addEventListener("click", () => install(update));
  document.body.append(card);
}

async function install(update: Update) {
  const title = card?.querySelector(".uc-title");
  card?.querySelectorAll("button").forEach((b) => (b.disabled = true));
  let total = 0;
  let done = 0;
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") {
        done += e.data.chunkLength;
        if (title && total) title.textContent = t("Downloading the update… {pct}%", { pct: Math.round((done / total) * 100) });
      } else if (e.event === "Finished" && title) title.textContent = t("Installing…");
    });
    await relaunch();
  } catch (err) {
    card?.remove();
    toast(t("The update failed: {error}", { error: String(err) }), 5000);
  }
}
