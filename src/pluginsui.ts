import { invoke } from "@tauri-apps/api/core";
import { open as pickFolder } from "@tauri-apps/plugin-dialog";
import { t, translateTree } from "./i18n";
import { toast } from "./toast";
import { describePermission, implied, Plugin, PluginHost } from "./plugins";

/**
 * The plugins window: installed plugins (on / off, settings, remove) and the catalog, where a
 * plugin installs with one click after showing what it is allowed to do.
 */

interface CatalogEntry {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  permissions?: string[];
  /** It has background code (Deno). */
  backend?: boolean;
  /** Language servers it runs ("pyright@1.1.414"). */
  servers?: string[];
  /** A zip to download (a GitHub archive) and the plugin's folder inside it. */
  url: string;
  path?: string;
}

export class PluginsWindow {
  private el: HTMLElement;
  private tab: "installed" | "catalog" = "installed";
  private catalog: CatalogEntry[] | null = null;
  private catalogError = "";

  constructor(private host: PluginHost) {
    this.el = document.createElement("div");
    this.el.id = "plugins";
    this.el.hidden = true;
    document.body.append(this.el);
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (this.el.querySelector(".pl-dialog")) this.el.querySelector(".pl-dialog")!.remove();
        else this.close();
      }
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.el.hidden = false;
    this.render();
  }

  close() {
    this.el.hidden = true;
  }

  refresh() {
    if (this.isOpen) this.render();
  }

  private render() {
    const panel = div("pl-panel");
    panel.tabIndex = -1;
    const head = div("pl-head");
    head.append(span("pl-title", "plugins"));
    const tabs = div("pl-tabs");
    for (const [id, label] of [["installed", "Installed"], ["catalog", "Catalog"]] as const) {
      const b = button(label, this.tab === id ? "on" : "");
      b.addEventListener("click", () => {
        this.tab = id;
        this.render();
      });
      tabs.append(b);
    }
    head.append(tabs);
    const close = button("×", "pl-close icon-btn");
    close.addEventListener("click", () => this.close());
    head.append(close);
    panel.append(head);

    const body = div("pl-body");
    panel.append(body);
    if (this.tab === "installed") this.renderInstalled(body);
    else this.renderCatalog(body);

    const foot = div("pl-foot");
    const folder = button("Open plugins folder", "pl-btn");
    folder.addEventListener("click", async () => {
      const dir = await invoke<string>("plugins_dir_path");
      invoke("reveal_entry", { path: dir }).catch(() => toast(dir));
    });
    const reload = button("Reload plugins", "pl-btn");
    reload.title = t("Picks up plugins added to the folder and changes to their code");
    reload.addEventListener("click", async () => {
      await this.host.load();
      this.render();
      toast(t("Plugins reloaded"));
    });
    const fromLink = button("Install from link…", "pl-btn");
    fromLink.addEventListener("click", () => this.installFromLink());
    const fromFolder = button("Install from folder…", "pl-btn");
    fromFolder.addEventListener("click", () => this.installFromFolder());
    foot.append(span("pl-note", "How to write one: PLUGINS.md in Tern's repository."), fromLink, fromFolder, folder, reload);
    panel.append(foot);

    translateTree(panel);
    this.el.replaceChildren(panel);
    panel.focus();
  }

  private renderInstalled(body: HTMLElement) {
    const list = this.host.plugins;
    if (!list.length) {
      body.append(span("pl-empty", "No plugins yet. Install one from the catalog, or put a plugin folder in the plugins folder."));
      return;
    }
    for (const p of list) body.append(this.row(p));
  }

  private row(p: Plugin) {
    const row = div("pl-row");
    const info = div("pl-info");
    const name = div("pl-name");
    name.textContent = p.manifest?.name ?? p.id;
    if (p.manifest?.version) {
      const v = document.createElement("span");
      v.className = "pl-ver";
      v.textContent = ` v${p.manifest.version}`;
      name.append(v);
    }
    info.append(name);
    const desc = div("pl-desc");
    desc.textContent = p.error ?? [p.manifest?.description, p.manifest?.author && `— ${p.manifest.author}`].filter(Boolean).join(" ");
    if (p.error) desc.classList.add("error");
    info.append(desc);
    const missing = this.host.missing(p);
    if (p.data.enabled && missing.length) {
      info.append(span("pl-warn", "It asks for new permissions: turn it on again to review them."));
    }
    row.append(info);

    const actions = div("pl-actions");
    if (p.manifest) {
      const toggle = document.createElement("label");
      toggle.className = "pl-switch";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = this.host.canRun(p);
      box.addEventListener("change", async () => {
        if (box.checked) {
          const perms = [...implied(p.manifest!), ...(p.manifest!.permissions ?? [])];
          if (perms.length && !(await this.confirm(p.manifest!.name, perms))) {
            box.checked = false;
            return;
          }
        }
        await this.host.setEnabled(p, box.checked);
        this.render();
      });
      toggle.append(box, span("", "on"));
      actions.append(toggle);
      if (p.manifest.settings?.length) {
        const s = button("settings", "pl-link");
        s.addEventListener("click", () => this.settings(p, row));
        actions.append(s);
      }
    }
    const rm = button("remove", "pl-link danger");
    rm.addEventListener("click", async () => {
      await this.host.remove(p).catch((e) => toast(String(e)));
      this.render();
    });
    actions.append(rm);
    row.append(actions);
    return row;
  }

  /** The plugin's own settings, as a small form under its row. */
  private settings(p: Plugin, row: HTMLElement) {
    const old = row.nextElementSibling;
    if (old?.classList.contains("pl-settings")) {
      old.remove();
      return;
    }
    const form = div("pl-settings");
    for (const s of p.manifest!.settings!) {
      const line = div("pl-field");
      const label = document.createElement("label");
      label.textContent = s.label;
      const value = p.data.settings[s.key] ?? s.default ?? "";
      let input: HTMLInputElement | HTMLSelectElement;
      if (s.type === "select") {
        input = document.createElement("select");
        for (const o of s.options ?? []) input.append(new Option(o, o));
        input.value = String(value);
      } else {
        input = document.createElement("input");
        input.type = s.type === "password" ? "password" : s.type === "number" ? "number" : s.type === "checkbox" ? "checkbox" : "text";
        if (s.type === "checkbox") (input as HTMLInputElement).checked = !!value;
        else input.value = String(value);
        input.spellcheck = false;
      }
      input.addEventListener("change", async () => {
        p.data.settings[s.key] =
          s.type === "checkbox" ? (input as HTMLInputElement).checked : s.type === "number" ? Number(input.value) : input.value;
        await this.host.saveData(p);
      });
      line.append(label, input);
      if (s.description) {
        const d = div("pl-hint");
        d.textContent = s.description;
        line.append(d);
      }
      form.append(line);
    }
    row.after(form);
  }

  private async renderCatalog(body: HTMLElement) {
    if (!this.catalog && !this.catalogError) {
      body.append(span("pl-empty", "loading the catalog…"));
      try {
        const raw = JSON.parse(await invoke<string>("plugin_catalog"));
        this.catalog = (Array.isArray(raw) ? raw : raw.plugins ?? []).filter((e: CatalogEntry) => e && e.id && e.url);
      } catch (e) {
        this.catalogError = String(e).startsWith("network") ? t("No connection — try again later.") : String(e);
      }
      if (this.isOpen && this.tab === "catalog") this.render();
      return;
    }
    if (this.catalogError) {
      body.append(span("pl-empty", this.catalogError));
      const retry = button("retry", "pl-link");
      retry.addEventListener("click", () => {
        this.catalogError = "";
        this.render();
      });
      body.append(retry);
      return;
    }
    for (const e of this.catalog ?? []) {
      const installed = this.host.plugins.find((p) => p.id === e.id);
      const row = div("pl-row");
      const info = div("pl-info");
      const name = div("pl-name");
      name.textContent = e.name;
      if (e.version) {
        const v = document.createElement("span");
        v.className = "pl-ver";
        v.textContent = ` v${e.version}`;
        name.append(v);
      }
      const desc = div("pl-desc");
      desc.textContent = [e.description, e.author && `— ${e.author}`].filter(Boolean).join(" ");
      info.append(name, desc);
      row.append(info);
      const actions = div("pl-actions");
      const newer = installed && e.version && installed.manifest?.version !== e.version;
      const b = button(installed ? (newer ? "Update" : "Installed") : "Install", "pl-btn primary");
      b.disabled = !!installed && !newer;
      b.addEventListener("click", () => this.install(e, b));
      actions.append(b);
      row.append(actions);
      body.append(row);
    }
  }

  private async install(e: CatalogEntry, b: HTMLButtonElement) {
    const perms = [...implied(e), ...(e.permissions ?? [])];
    if (perms.length && !(await this.confirm(e.name, perms))) return;
    b.disabled = true;
    b.textContent = t("installing…");
    try {
      await invoke("plugin_install", { id: e.id, url: e.url, subdir: e.path ?? null });
      await this.host.load();
      const p = this.host.plugins.find((x) => x.id === e.id);
      if (p) await this.host.setEnabled(p, true);
      toast(t("{name} is installed", { name: e.name }));
    } catch (err) {
      toast(t("Could not install {name}: {error}", { name: e.name, error: String(err) }), 5000);
    }
    this.render();
  }

  /** A GitHub link (repository, or a folder in it via /tree/branch/path) or a .zip address. */
  private async installFromLink() {
    const url = await this.ask(t("Plugin link"), "https://github.com/someone/tern-plugin");
    if (!url) return;
    const src = parseLink(url.trim());
    if (!src) {
      toast(t("That isn't a GitHub link or a .zip address"), 4000);
      return;
    }
    if (this.host.plugins.some((p) => p.id === src.id) && !(await this.yesNo(t("{name} is already installed. Replace it?", { name: src.id })))) return;
    toast(t("Downloading {name}…", { name: src.id }));
    try {
      await invoke("plugin_install", { id: src.id, url: src.zip, subdir: src.subdir });
    } catch (err) {
      toast(t("Could not install {name}: {error}", { name: src.id, error: String(err) }), 5000);
      return;
    }
    await this.finishOutside(src.id);
  }

  private async installFromFolder() {
    const dir = await pickFolder({ directory: true, title: t("The plugin's folder (with plugin.json)") });
    if (typeof dir !== "string") return;
    let id: string;
    try {
      id = await invoke<string>("plugin_install_dir", { from: dir });
    } catch (err) {
      toast(t("Could not install {name}: {error}", { name: dir, error: String(err) }), 5000);
      return;
    }
    await this.finishOutside(id);
  }

  /** Installed from outside the catalog: show what it wants, with a warning; no = removed again. */
  private async finishOutside(id: string) {
    await this.host.load();
    const p = this.host.plugins.find((x) => x.id === id);
    if (!p?.manifest) {
      toast(t("Could not install {name}: {error}", { name: id, error: p?.error ?? "plugin.json" }), 5000);
      this.render();
      return;
    }
    const perms = [...implied(p.manifest), ...(p.manifest.permissions ?? [])];
    if (await this.confirm(p.manifest.name, perms, true)) {
      await this.host.setEnabled(p, true);
      toast(t("{name} is installed", { name: p.manifest.name }));
    } else {
      await this.host.remove(p).catch(() => {});
    }
    this.tab = "installed";
    this.render();
  }

  /** A one-line question in the plugins window. */
  private ask(title: string, placeholder: string): Promise<string | null> {
    return new Promise((resolve) => {
      const d = div("pl-dialog");
      const box = div("pl-dialog-box");
      const head = div("pl-dialog-title");
      head.textContent = title;
      const input = document.createElement("input");
      input.className = "pl-input";
      input.placeholder = placeholder;
      input.spellcheck = false;
      const btns = div("pl-dialog-buttons");
      const ok = button("Install", "pl-btn primary");
      const no = button("Cancel", "pl-btn");
      const done = (v: string | null) => {
        d.remove();
        resolve(v);
      };
      ok.addEventListener("click", () => done(input.value.trim() || null));
      no.addEventListener("click", () => done(null));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") done(input.value.trim() || null);
      });
      btns.append(ok, no);
      box.append(head, input, btns);
      d.append(box);
      translateTree(d);
      this.el.append(d);
      input.focus();
    });
  }

  private yesNo(text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const d = div("pl-dialog");
      const box = div("pl-dialog-box");
      const head = div("pl-dialog-title");
      head.textContent = text;
      const btns = div("pl-dialog-buttons");
      const ok = button("Replace", "pl-btn primary");
      const no = button("Cancel", "pl-btn");
      ok.addEventListener("click", () => (d.remove(), resolve(true)));
      no.addEventListener("click", () => (d.remove(), resolve(false)));
      btns.append(ok, no);
      box.append(head, btns);
      d.append(box);
      translateTree(d);
      this.el.append(d);
      ok.focus();
    });
  }

  /** "This plugin wants to…": the user allows it or not. */
  private confirm(name: string, perms: string[], outside = false): Promise<boolean> {
    return new Promise((resolve) => {
      const d = div("pl-dialog");
      const box = div("pl-dialog-box");
      const title = div("pl-dialog-title");
      title.textContent = t("{name} wants to:", { name });
      box.append(title);
      const ul = document.createElement("ul");
      for (const p of perms) {
        const li = document.createElement("li");
        li.textContent = describePermission(p);
        ul.append(li);
      }
      if (perms.length) box.append(ul);
      else box.append(span("pl-hint", "It asks for no permissions."));
      if (outside) box.append(span("pl-warn pl-outside", "Not from Tern's catalog: nobody has checked this plugin."));
      box.append(span("pl-hint", "Install plugins only from authors you trust."));
      const btns = div("pl-dialog-buttons");
      const ok = button("Allow", "pl-btn primary");
      const no = button("Cancel", "pl-btn");
      const done = (v: boolean) => {
        d.remove();
        resolve(v);
      };
      ok.addEventListener("click", () => done(true));
      no.addEventListener("click", () => done(false));
      btns.append(ok, no);
      box.append(btns);
      d.append(box);
      translateTree(d);
      this.el.append(d);
      ok.focus();
    });
  }
}

function div(cls: string) {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function span(cls: string, en: string) {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.dataset.i18n = en;
  s.textContent = en;
  return s;
}

function button(en: string, cls: string) {
  const b = document.createElement("button");
  b.className = cls;
  b.dataset.i18n = en;
  b.textContent = en;
  return b;
}

/**
 * Where to download a plugin from a link people paste:
 *   https://github.com/owner/repo                        → the default branch, plugin at the root
 *   https://github.com/owner/repo/tree/branch/some/path  → that branch, plugin in some/path
 *   https://example.com/plugin.zip                       → that zip
 */
export function parseLink(url: string): { id: string; zip: string; subdir: string | null } | null {
  const safeId = (s: string) =>
    s.toLowerCase().replace(/^tern-?plugin-?|-?tern-?plugin$/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "plugin";
  const gh = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/.exec(url);
  if (gh) {
    const [, owner, repo, branch, path] = gh;
    const zip = branch
      ? `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`
      : `https://github.com/${owner}/${repo}/archive/HEAD.zip`;
    const sub = path ? decodeURIComponent(path).replace(/\/+$/, "") : null;
    return { id: safeId(sub ? sub.split("/").pop()! : repo), zip, subdir: sub };
  }
  if (/^https:\/\/\S+\.zip(\?\S*)?$/i.test(url)) {
    const name = decodeURIComponent(url.split("?")[0].split("/").pop()!).replace(/\.zip$/i, "");
    return { id: safeId(name), zip: url, subdir: null };
  }
  return null;
}
