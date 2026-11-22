import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { LSPClient } from "@codemirror/lsp-client";
import { toast } from "./toast";
import { t } from "./i18n";

/**
 * Language servers from plugins: completion, errors, hover docs, go to definition, rename and
 * formatting in the editor (@codemirror/lsp-client). One server per language and project, started
 * when the first file of that language is opened; npm servers are downloaded once by Deno.
 */

export interface LanguageSpec {
  /** Shown in messages: "Python". */
  name?: string;
  /** File extensions without the dot: ["py", "pyi"]. */
  extensions: string[];
  /** The LSP language id: "python". */
  languageId: string;
  server: { npm?: string; bin?: string; command?: string; args?: string[] };
  /** Sent to the server with `initialize`. */
  initializationOptions?: unknown;
}

export function parseLanguages(raw: unknown): LanguageSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (l): l is LanguageSpec =>
      !!l && Array.isArray(l.extensions) && typeof l.languageId === "string" && !!l.server &&
      (typeof l.server.npm === "string" || typeof l.server.command === "string"),
  );
}

/** What the server is, for the permission dialog: "pyright@1.1.414" or "rust-analyzer". */
export const serverName = (l: LanguageSpec) => l.server.npm ?? l.server.command ?? "?";

/**
 * A file URI the way VS Code writes it (and servers like pyright answer with): "file:///c%3A/x/y.py".
 * The editor matches a server's replies to its file by this exact string.
 */
export const fileUri = (path: string) =>
  canonical("file:///" + path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/"));

/** Windows drive letters as "c%3A" in every file URI of a message. */
const canonical = (text: string) =>
  text.replace(/file:\/\/\/([A-Za-z])(?::|%3[Aa])/g, (_, d: string) => `file:///${d.toLowerCase()}%3A`);

const uriPath = (uri: string) => {
  const p = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""));
  return /^[a-zA-Z]:/.test(p) ? p.replace(/\//g, "\\") : "/" + p;
};

interface Conn {
  id: number;
  client: LSPClient;
  handlers: Set<(m: string) => void>;
}

export class LanguageServers {
  /** The languages of the running plugins. */
  getLanguages: () => { plugin: string; lang: LanguageSpec }[] = () => [];
  /** Opens a file in the editor and returns its view (for "go to definition" in another file). */
  openFile: (path: string) => Promise<EditorView | null> = async () => null;

  private conns = new Map<string, Promise<Conn | null>>();
  private byId = new Map<number, Conn>();

  constructor() {
    listen<{ id: number; msg: string | null; exit: string | null }>("lsp", (e) => {
      const { id, msg, exit } = e.payload;
      const conn = this.byId.get(id);
      if (!conn) return;
      if (msg !== null) {
        const text = canonical(msg);
        for (const h of conn.handlers) h(text);
      }
      if (exit) this.forget(id, true);
    });
  }

  /** The editor extension for a file: LSP features if a plugin has a server for it. */
  async extensionFor(path: string, root: string | null): Promise<Extension> {
    const ext = (path.split(/[\\/]/).pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
    const found = this.getLanguages().find(({ lang }) => lang.extensions.some((e) => e.replace(/^\./, "").toLowerCase() === ext));
    if (!found) return [];
    const dir = root ?? path.replace(/[\\/][^\\/]*$/, "");
    const key = `${found.plugin}|${found.lang.languageId}|${dir.toLowerCase()}`;
    let conn = this.conns.get(key);
    if (!conn) {
      conn = this.start(found.lang, dir);
      this.conns.set(key, conn);
    }
    const c = await conn;
    if (!c) {
      this.conns.delete(key);
      return [];
    }
    return c.client.plugin(fileUri(path), found.lang.languageId);
  }

  /** Stops the servers a plugin started (it was turned off or removed). */
  stopPlugin(plugin: string) {
    for (const [key, conn] of this.conns) {
      if (!key.startsWith(plugin + "|")) continue;
      this.conns.delete(key);
      conn.then((c) => c && this.forget(c.id, false));
    }
  }

  private async start(lang: LanguageSpec, root: string): Promise<Conn | null> {
    const name = lang.name ?? lang.languageId;
    let id: number;
    try {
      id = await invoke<number>("lsp_start", { server: lang.server, root });
    } catch (err) {
      const e = String(err);
      toast(
        e.startsWith("not-found:")
          ? t("{name}: install {program} to get completion and errors", { name, program: e.slice(10) })
          : t("{name}: the language server didn't start: {error}", { name, error: e }),
        6000,
      );
      return null;
    }
    if (lang.server.npm) toast(t("{name}: starting {server} (the first time it is downloaded)…", { name, server: serverName(lang) }), 4000);
    const [lc, { default: DOMPurify }] = await Promise.all([import("@codemirror/lsp-client"), import("dompurify")]);
    const handlers = new Set<(m: string) => void>();
    const servers = this;
    // Like the library's default workspace, plus opening other files in Tern's editor.
    class TernWorkspace extends lc.Workspace {
      files: { uri: string; languageId: string; version: number; doc: EditorView["state"]["doc"]; view: EditorView; getView(): EditorView }[] = [];
      private versions: Record<string, number> = {};
      private next(uri: string) {
        return (this.versions[uri] = (this.versions[uri] ?? -1) + 1);
      }
      syncFiles() {
        const out = [];
        for (const file of this.files) {
          const plugin = lc.LSPPlugin.get(file.view);
          if (!plugin || plugin.unsyncedChanges.empty) continue;
          out.push({ changes: plugin.unsyncedChanges, file, prevDoc: file.doc });
          file.doc = file.view.state.doc;
          file.version = this.next(file.uri);
          plugin.clear();
        }
        return out;
      }
      openFile(uri: string, languageId: string, view: EditorView) {
        this.closeFile(uri);
        const file = { uri, languageId, version: this.next(uri), doc: view.state.doc, view, getView: () => view };
        this.files.push(file);
        this.client.didOpen(file);
      }
      closeFile(uri: string) {
        if (!this.files.some((f) => f.uri === uri)) return;
        this.files = this.files.filter((f) => f.uri !== uri);
        this.client.didClose(uri);
      }
      async displayFile(uri: string) {
        const open = this.files.find((f) => f.uri === uri);
        return open ? open.view : servers.openFile(uriPath(uri));
      }
    }
    const client = new lc.LSPClient({
      rootUri: fileUri(root),
      initializationOptions: lang.initializationOptions,
      // The first start of an npm server includes its download.
      timeout: 120_000,
      workspace: (c) => new TernWorkspace(c),
      sanitizeHTML: (html) => DOMPurify.sanitize(html),
      extensions: lc.languageServerExtensions(),
    });
    const conn: Conn = { id, client, handlers };
    this.byId.set(id, conn);
    client.connect({
      send: (msg) => {
        invoke("lsp_send", { id, msg }).catch(() => {});
      },
      subscribe: (h) => handlers.add(h),
      unsubscribe: (h) => handlers.delete(h),
    });
    client.initializing.catch((err) => toast(t("{name}: the language server didn't start: {error}", { name, error: String(err) }), 6000));
    return conn;
  }

  private forget(id: number, crashed: boolean) {
    const conn = this.byId.get(id);
    if (!conn) return;
    this.byId.delete(id);
    try {
      conn.client.disconnect();
    } catch {
      /* already gone */
    }
    for (const [key, p] of this.conns) p.then((c) => c?.id === id && this.conns.delete(key));
    if (crashed) toast(t("A language server stopped; it restarts when you open a file again"), 4000);
    else invoke("lsp_stop", { id }).catch(() => {});
  }
}
