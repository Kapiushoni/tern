// One plugin's background code, inside its Worker. Sets up the `tern` object (the same one the
// plugin's windows get, plus messaging with them), then loads the plugin's "backend" file.

let seq = 0;
const tag = Math.random().toString(36).slice(2, 8);
const pending = new Map();
const callbacks = new Map();
const listeners = {};
const messageListeners = [];
/** Messages that came before the plugin called tern.onMessage (its code may still be starting). */
let early = [];

const post = (m) => self.postMessage({ tern: 1, ...m });
const call = (method, ...args) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    post({ id, method, args });
  });
const cb = (fn) => {
  if (typeof fn !== "function") return null;
  const k = `${tag}.${++seq}`;
  callbacks.set(k, fn);
  return k;
};
const report = (err) => call("log", String(err?.stack ?? err)).catch(() => {});

// console.* goes to Tern's log (stdout is the host's channel to Tern).
const text = (args) => args.map((a) => (typeof a === "string" ? a : Deno.inspect(a))).join(" ");
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => call("log", text(args)).catch(() => {});
}
self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  report(e.reason);
});

let started = false;
self.onmessage = async (e) => {
  const m = e.data;
  if (!m) return;
  if (m.init && !started) {
    started = true;
    globalThis.tern = makeTern(m.init);
    try {
      await import(toFileUrl(m.init.file));
    } catch (err) {
      report(err);
    }
    return;
  }
  if (!m.tern) return;
  if (m.reply) {
    const p = pending.get(m.reply);
    pending.delete(m.reply);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
  } else if (m.callback) {
    const f = callbacks.get(m.callback);
    if (f) try { await f(...(m.args ?? [])); } catch (err) { report(err); }
  } else if (m.event) {
    for (const f of listeners[m.event] ?? []) try { await f(m.data); } catch (err) { report(err); }
  } else if ("message" in m) {
    if (early) early.push(m.message);
    for (const f of messageListeners) try { await f(m.message); } catch (err) { report(err); }
  }
};

function toFileUrl(path) {
  const p = path.replace(/\\/g, "/");
  return new URL(`file://${p.startsWith("/") ? "" : "/"}${encodeURI(p).replace(/[?#]/g, encodeURIComponent)}`).href;
}

function makeTern({ dir, data }) {
  return {
    /** The plugin's own folder, and a folder it may keep files in. */
    pluginDir: dir,
    dataDir: data,
    addButton: (o) => call("addButton", { icon: o.icon, title: o.title, onClick: cb(o.onClick) }),
    addMenuItem: (o) => call("addMenuItem", { label: o.label, onClick: cb(o.onClick) }),
    addCommand: (o) => call("addCommand", { name: o.name, key: o.key, run: cb(o.run) }),
    addStatus: async (o) => {
      const id = await call("addStatus", { text: o.text, title: o.title, align: o.align, onClick: cb(o.onClick) });
      return {
        set: (u) => call("setStatus", id, { text: u.text, title: u.title }),
        remove: () => call("removeStatus", id),
      };
    },
    on: (event, fn) => {
      (listeners[event] ??= []).push(fn);
      return call("on", event);
    },
    notify: (t) => call("notify", String(t)),
    openWindow: (file, opts) => call("openWindow", file, opts ?? {}),
    closeWindow: (file) => call("closeWindow", file),
    project: () => call("project"),
    settings: { get: (k) => call("settings.get", k), all: () => call("settings.all") },
    storage: { get: (k) => call("storage.get", k), set: (k, v) => call("storage.set", k, v) },
    files: {
      read: (p) => call("files.read", p),
      write: (p, t) => call("files.write", p, String(t)),
      list: (p) => call("files.list", p ?? "."),
    },
    run: (command) => call("run", command),
    fetch: (url, opts) => call("fetch", url, opts ?? {}),
    terminal: { send: (t) => call("terminal.send", String(t)) },
    /** To the plugin's windows and main.js (they get it in tern.onMessage). */
    send: (message) => call("send", message),
    onMessage: (fn) => {
      messageListeners.push(fn);
      const queued = early ?? [];
      early = null;
      for (const msg of queued) Promise.resolve().then(() => fn(msg)).catch(report);
    },
  };
}
