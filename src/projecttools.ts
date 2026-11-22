import { invoke } from "@tauri-apps/api/core";
import type { Tabs } from "./tabs";
import { toast } from "./toast";
import { t } from "./i18n";

/**
 * The ▶ run button and "Open in IDE", both for the project shown in the tree.
 * ▶ guesses the command (package.json, Gradle, Maven, Cargo, Python…) and runs it in a new shell
 * tab; right-click changes it for this project (saved in .tern/run.json).
 */

interface RunInfo {
  command: string | null;
  preview: string | null;
  custom: boolean;
  source: string | null;
  /** The folder the command runs in. */
  dir: string;
}
interface Ide {
  id: string;
  name: string;
}
type MenuItem = { label: string; hint?: string; run: () => void } | null;

export class ProjectTools {
  /** The IDE picked by the user; unset = chosen by the project's language. */
  ide: string | undefined;
  onChange: () => void = () => {};
  getRoot: () => string | null = () => null;
  /** Where to start looking for a project: the selected file/folder or the open file. */
  getFrom: () => string | null = () => null;
  showMenu: (items: MenuItem[], x: number, y: number) => void = () => {};
  openPreview: (path: string) => void = () => {};

  private ides: Promise<Ide[]> | null = null;
  private pop: HTMLElement;

  constructor(
    private tabs: Tabs,
    private runBtn: HTMLElement,
  ) {
    runBtn.addEventListener("click", () => this.run());
    runBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.editCommand();
    });
    runBtn.addEventListener("mouseenter", () => this.describeRun());

    this.pop = document.createElement("div");
    this.pop.id = "run-pop";
    this.pop.hidden = true;
    document.body.append(this.pop);
    document.addEventListener("mousedown", (e) => {
      if (!this.pop.hidden && !this.pop.contains(e.target as Node)) this.pop.hidden = true;
    });
  }

  // ── run ▶ ─────────────────────────────────────────────

  async run() {
    const root = this.getRoot();
    if (!root) return;
    const info = await invoke<RunInfo>("run_detect", { root, from: this.getFrom() });
    if (info.command || info.preview) {
      await this.start(info);
    } else {
      // A folder of projects: offer the ones inside it that can be run.
      const list = await invoke<RunInfo[]>("run_candidates", { root }).catch(() => [] as RunInfo[]);
      if (!list.length) {
        this.editCommand(t("Tern couldn't tell how to start this project. What command runs it?"));
        return;
      }
      const b = this.runBtn.getBoundingClientRect();
      const items: MenuItem[] = list.map((c) => ({
        label: baseName(c.dir),
        hint: c.source ?? undefined,
        run: () => this.start(c),
      }));
      items.push(null, { label: t("Set a command for this folder…"), run: () => this.editCommand() });
      this.showMenu(items, b.left, b.bottom + 4);
    }
  }

  /** The ▶ tab of each folder: running again reuses it instead of opening another. */
  private runTabs = new Map<string, string>();

  private async start(info: RunInfo) {
    if (info.command) {
      const key = info.dir.toLowerCase();
      const tab = this.runTabs.get(key);
      if (tab && this.tabs.show(tab)) {
        // Stop what is still running there (Ctrl+C), then start again.
        const s = this.tabs.sessionOf(tab);
        s.send("\x03");
        setTimeout(() => s.send(info.command + "\r"), 150);
        s.focus();
        return;
      }
      this.runTabs.set(key, await this.tabs.open("shell", info.dir, { run: info.command, label: `▶ ${baseName(info.dir)}` }));
    } else if (info.preview) {
      this.openPreview(info.preview);
    }
  }

  private async describeRun() {
    const root = this.getRoot();
    if (!root) return;
    const info = await invoke<RunInfo>("run_detect", { root, from: this.getFrom() }).catch(() => null);
    if (!info) return;
    this.runBtn.title = info.command
      ? t("Run: {command}\nin {dir}\nRight-click to change", { command: info.command, dir: info.dir })
      : info.preview
        ? t("Preview index.html\nRight-click to set a command")
        : t("Run a project from this folder");
  }

  private async editCommand(note?: string) {
    const root = this.getRoot();
    if (!root) return;
    const info = await invoke<RunInfo>("run_detect", { root, from: this.getFrom() });
    const pop = this.pop;
    pop.innerHTML =
      `<div class="rp-title">${t("run command")}</div>` +
      `<div class="rp-note"></div>` +
      `<input type="text" spellcheck="false" autocomplete="off" />` +
      `<div class="rp-row"><span class="rp-where"></span><span class="rp-buttons"></span></div>`;
    pop.querySelector(".rp-note")!.textContent =
      note ?? t("Runs in a new terminal tab in the project folder. Saved for this project only.");
    const input = pop.querySelector("input")!;
    input.value = info.command ?? "";
    input.placeholder = t("e.g. npm run dev");
    pop.querySelector<HTMLElement>(".rp-where")!.title = info.dir;
    pop.querySelector(".rp-where")!.textContent = info.custom ? ".tern/run.json" : info.source ? t("detected from {source}", { source: info.source }) : "";
    const buttons = pop.querySelector(".rp-buttons")!;
    const save = button(t("save & run"), "primary");
    buttons.append(save);
    if (info.custom) {
      const reset = button(t("auto"));
      reset.title = t("Forget this command and detect it again");
      reset.addEventListener("click", async () => {
        await invoke("run_save", { root: info.dir, command: "" }).catch((e) => toast(String(e)));
        pop.hidden = true;
        toast(t("Run command: back to automatic"));
      });
      buttons.prepend(reset);
    }
    const commit = async () => {
      const cmd = input.value.trim();
      if (!cmd) return;
      if (cmd !== info.command || !info.custom) {
        try {
          await invoke("run_save", { root: info.dir, command: cmd });
        } catch (e) {
          return toast(t("Could not save: {error}", { error: String(e) }));
        }
      }
      pop.hidden = true;
      this.run();
    };
    save.addEventListener("click", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") {
        pop.hidden = true;
        this.tabs.activeSession?.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    });
    pop.hidden = false;
    const b = this.runBtn.getBoundingClientRect();
    pop.style.top = `${b.bottom + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(b.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8))}px`;
    input.focus();
    input.select();
  }

  // ── Open in IDE ───────────────────────────────────────

  private list() {
    this.ides ??= invoke<Ide[]>("ide_list").catch(() => []);
    return this.ides;
  }

  /** Opens `path` (default: the project folder) in the chosen IDE. */
  async openIde(path?: string) {
    const root = this.getRoot();
    const target = path ?? root;
    if (!target) return;
    const ides = await this.list();
    if (!ides.length) {
      this.ides = null; // look again next time: one may have been installed meanwhile
      return toast(t("No IDE found — install IntelliJ IDEA, PyCharm or VS Code"), 4000);
    }
    const ide = await this.pick(ides, root ?? target);
    try {
      await invoke("ide_open", { id: ide.id, path: target });
      toast(t("Opening in {ide}…", { ide: ide.name }));
    } catch (err) {
      toast(t("Could not start {ide}: {error}", { ide: ide.name, error: String(err) }), 4000);
    }
  }

  private async pick(ides: Ide[], root: string): Promise<Ide> {
    const chosen = ides.find((i) => i.id === this.ide);
    if (chosen) return chosen;
    const guess = await guessIde(root);
    return ides.find((i) => i.id === guess) ?? ides.find((i) => i.id === "vscode") ?? ides[0];
  }
}

/** Python → PyCharm, Java/Kotlin → IntelliJ IDEA, anything else → VS Code. */
async function guessIde(root: string): Promise<string> {
  const entries = await invoke<{ name: string }[]>("list_dir", { path: root, showHidden: true }).catch(() => []);
  const names = new Set(entries.map((e) => e.name.toLowerCase()));
  const any = (...n: string[]) => n.some((x) => names.has(x));
  if (any("pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts")) return "idea";
  if (any("requirements.txt", "pyproject.toml", ".venv", "venv", "main.py", "bot.py", "setup.py")) return "pycharm";
  return "vscode";
}

function baseName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
}

function button(text: string, cls = "") {
  const b = document.createElement("button");
  b.textContent = text;
  if (cls) b.className = cls;
  return b;
}
