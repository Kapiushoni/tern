// Git panel, background part (Deno). Runs git directly (no shell, so nothing in a commit message
// can turn into a command), keeps the status bar item fresh and answers the panel window.

const decoder = new TextDecoder();

async function git(args, cwd) {
  const out = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" }).output();
  return { code: out.code, out: decoder.decode(out.stdout), err: decoder.decode(out.stderr).trim() };
}

async function root() {
  const project = await tern.project();
  if (!project) return null;
  const r = await git(["rev-parse", "--show-toplevel"], project).catch(() => null);
  return r && r.code === 0 ? r.out.trim() : null;
}

/** Branch, ahead/behind and changed files from `git status --porcelain=v2`. */
async function status(dir) {
  const r = await git(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], dir);
  if (r.code !== 0) throw new Error(r.err || "git status failed");
  const s = { branch: "", ahead: 0, behind: 0, files: [] };
  const parts = r.out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (line.startsWith("# branch.head ")) s.branch = line.slice(14);
    else if (line.startsWith("# branch.ab ")) {
      const [a, b] = line.slice(12).split(" ");
      s.ahead = Math.abs(parseInt(a));
      s.behind = Math.abs(parseInt(b));
    } else if (line.startsWith("1 ") || line.startsWith("u ")) {
      const f = line.split(" ");
      const xy = f[1];
      s.files.push({ path: f.slice(line.startsWith("u ") ? 10 : 8).join(" "), staged: xy[0] !== ".", changed: xy[1] !== ".", code: xy.replace(/\./g, "") });
    } else if (line.startsWith("2 ")) {
      // A rename: the old name follows as the next NUL-separated field.
      const f = line.split(" ");
      const xy = f[1];
      s.files.push({ path: f.slice(9).join(" "), from: parts[++i], staged: xy[0] !== ".", changed: xy[1] !== ".", code: "R" });
    } else if (line.startsWith("? ")) {
      s.files.push({ path: line.slice(2), staged: false, changed: true, code: "?" });
    }
  }
  return s;
}

// ── status bar ──────────────────────────────────────────

const item = await tern.addStatus({ text: "", title: "Git", align: "left", onClick: () => tern.openWindow("panel.html", { title: "Git", width: 520, height: 560 }) });

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const dir = await root();
    if (!dir) {
      item.set({ text: "", title: "Git" });
      return;
    }
    const s = await status(dir);
    const sync = `${s.ahead ? ` ↑${s.ahead}` : ""}${s.behind ? ` ↓${s.behind}` : ""}`;
    const n = s.files.length;
    item.set({
      text: `⎇ ${s.branch}${sync}${n ? ` • ${n}` : ""}`,
      title: `${n} changed file${n === 1 ? "" : "s"}${s.ahead ? `, ${s.ahead} to push` : ""}${s.behind ? `, ${s.behind} to pull` : ""}. Click to open the Git panel.`,
    });
  } catch {
    item.set({ text: "" });
  } finally {
    busy = false;
  }
}

for (const e of ["project:change", "file:save", "claude:done", "tab:switch"]) tern.on(e, refresh);
setInterval(refresh, 10_000);
refresh();

// ── requests from the panel window ─────────────────────

/** What the panel should show when it opens (set by the tree's menu item). */
let pending = null;

const ops = {
  async pending() {
    const p = pending;
    pending = null;
    return p;
  },
  async status(dir) {
    return { root: dir, ...(await status(dir)) };
  },
  async diff(dir, { path, staged, untracked }) {
    const r = await git(["diff", "--no-color", ...(staged ? ["--cached"] : []), "--", path], dir);
    if (r.out || !untracked) return r.out;
    // Untracked: show the whole file as added.
    const u = await git(["diff", "--no-color", "--no-index", "--", process_null(), path], dir);
    return u.out;
  },
  async stage(dir, { paths }) {
    return check(await git(["add", "--", ...paths], dir));
  },
  async unstage(dir, { paths }) {
    return check(await git(["restore", "--staged", "--", ...paths], dir));
  },
  async commit(dir, { message, all }) {
    if (!String(message ?? "").trim()) throw new Error("Write a commit message first");
    if (all) check(await git(["add", "--all"], dir));
    return check(await git(["commit", "-m", String(message)], dir));
  },
  async log(dir, { path }) {
    const r = await git(["log", "-n", "50", "--date=relative", "--pretty=format:%h%x1f%an%x1f%ad%x1f%s", ...(path ? ["--follow", "--", path] : [])], dir);
    check(r);
    return r.out.split("\n").filter(Boolean).map((l) => {
      const [hash, author, date, subject] = l.split("\x1f");
      return { hash, author, date, subject };
    });
  },
  async show(dir, { hash, path }) {
    const r = await git(["show", "--no-color", "--stat", "--patch", hash, ...(path ? ["--", path] : [])], dir);
    return check(r).out;
  },
};

const process_null = () => (Deno.build.os === "windows" ? "NUL" : "/dev/null");

function check(r) {
  if (r.code !== 0) throw new Error(r.err || `git exited with ${r.code}`);
  return r;
}

tern.onMessage(async (m) => {
  if (!m || typeof m.req !== "number" || !ops[m.op]) return;
  try {
    const dir = m.op === "pending" ? null : await root();
    if (!dir && m.op !== "pending") throw new Error("The open folder is not a git repository");
    const result = await ops[m.op](dir, m.args ?? {});
    tern.send({ re: m.req, result: result && typeof result === "object" && "code" in result ? true : result });
    if (["stage", "unstage", "commit"].includes(m.op)) refresh();
  } catch (err) {
    tern.send({ re: m.req, error: String(err?.message ?? err) });
  }
});

// From the file tree: a file's history in the panel.
tern.addMenuItem({
  label: "Git: file history",
  onClick: async (path) => {
    // The window asks for this when it starts (a message now could arrive before it has loaded).
    pending = { show: "history", path };
    await tern.openWindow("panel.html", { title: "Git", width: 520, height: 560 });
    tern.send({ show: "history", path }); // if it was open already
  },
});
tern.addCommand({ name: "Git: open panel", run: () => tern.openWindow("panel.html", { title: "Git", width: 520, height: 560 }) });
