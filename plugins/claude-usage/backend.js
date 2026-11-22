// Claude usage: tokens used in the current session and today, in Tern's status bar.
// Background code (Deno). The "claude" permission lets it read Claude Code's conversation logs:
// every reply there carries its token usage.

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
const today = () => new Date().toLocaleDateString("sv"); // YYYY-MM-DD, local time
const dayOf = (iso) => new Date(iso).toLocaleDateString("sv");

/**
 * Per log file: how far it has been read, and its replies (by message id: one reply spans several
 * lines). Logs only grow, so each read streams just the new part — they can be tens of MB.
 */
const files = new Map();

async function readLog(path) {
  let state = files.get(path);
  if (!state) files.set(path, (state = { offset: 0, replies: new Map() }));
  let file;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return null;
  }
  try {
    const { size } = await file.stat();
    if (size < state.offset) state.offset = 0; // rewritten: start over
    if (size === state.offset) return state.replies;
    await file.seek(state.offset, Deno.SeekMode.Start);
    const decoder = new TextDecoder();
    let rest = "";
    let read = 0;
    for await (const chunk of file.readable) {
      read += chunk.length;
      const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
      rest = lines.pop();
      for (const line of lines) take(state.replies, line);
    }
    // An unfinished last line is read again next time.
    state.offset += read - new TextEncoder().encode(rest).length;
  } finally {
    try {
      file.close();
    } catch {
      /* closed by the stream */
    }
  }
  return state.replies;
}

function take(replies, line) {
  if (!line.includes('"usage"')) return;
  try {
    const e = JSON.parse(line);
    const u = e.message?.usage;
    if (e.type !== "assistant" || !u || !e.message.id) return;
    replies.set(e.message.id, {
      day: dayOf(e.timestamp),
      fresh: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      cached: u.cache_read_input_tokens ?? 0,
      out: u.output_tokens ?? 0,
    });
  } catch {
    /* not JSON */
  }
}

function sum(replies, day) {
  const t = { fresh: 0, cached: 0, out: 0, n: 0 };
  for (const r of replies) {
    if (day && r.day !== day) continue;
    t.fresh += r.fresh;
    t.cached += r.cached;
    t.out += r.out;
    t.n++;
  }
  return t;
}

/** Every log touched today, across all projects. */
async function todayTotal() {
  const all = [];
  const d = today();
  if (!tern.claudeDir) return sum([], d);
  try {
    for await (const project of Deno.readDir(tern.claudeDir)) {
      if (!project.isDirectory) continue;
      const dir = `${tern.claudeDir}/${project.name}`;
      for await (const f of Deno.readDir(dir)) {
        if (!f.isFile || !f.name.endsWith(".jsonl")) continue;
        const path = `${dir}/${f.name}`;
        const st = await Deno.stat(path).catch(() => null);
        if (!st?.mtime || st.mtime.toLocaleDateString("sv") !== d) continue;
        const replies = await readLog(path);
        if (replies) all.push(...replies.values());
      }
    }
  } catch {
    /* no logs yet */
  }
  return sum(all, d);
}

let session = null; // totals of the last active conversation
let day = null;

const status = await tern.addStatus({
  text: "✻ …",
  title: "Claude usage",
  onClick: () => {
    const line = (name, t) =>
      `${name}: ${fmt(t.fresh + t.out)} new (${fmt(t.fresh)} in, ${fmt(t.out)} out), ${fmt(t.cached)} from cache, ${t.n} replies`;
    tern.notify([session && line("Session", session), day && line("Today", day)].filter(Boolean).join(" · ") || "No usage yet");
  },
});

function show() {
  const parts = [];
  if (session) parts.push(fmt(session.fresh + session.out));
  if (day) parts.push(`today ${fmt(day.fresh + day.out)}`);
  status.set({
    text: `✻ ${parts.join(" · ") || "0"}`,
    title: "Tokens Claude used (input + output, without cache reads). Click for details.",
  });
}

async function refresh(transcript) {
  if (transcript) {
    const replies = await readLog(transcript);
    if (replies) session = sum(replies.values());
  }
  day = await todayTotal();
  show();
}

tern.on("claude:done", (e) => refresh(e.transcript));
tern.on("claude:waiting", (e) => refresh(e.transcript));
await refresh(null);
