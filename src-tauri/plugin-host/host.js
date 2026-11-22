// Tern's plugin host: one Deno process for every plugin's background code ("backend" in
// plugin.json). Each plugin runs in its own Worker with only the Deno permissions its granted
// Tern permissions translate to. Tern talks to this process in JSON lines:
//   stdin:  { op: "start", id, file, dir, data, perms } | { op: "stop", id } | { op: "to", id, msg }
//   stdout: { id, msg } (a message from a plugin) | { id, exit: "reason" } (it stopped or crashed)
// Anything else a worker prints is routed through `tern` as a log line, never to stdout.

const workers = new Map();
const out = new TextEncoder();

function send(obj) {
  Deno.stdout.writeSync(out.encode(JSON.stringify(obj) + "\n"));
}

/** Tern permissions → what the plugin's Worker may do in Deno. */
function denoPermissions(perms, dir, data) {
  const hosts = [];
  let net = false;
  for (const p of perms) {
    if (p === "network") net = true;
    else if (p.startsWith("network:")) hosts.push(p.slice(8));
  }
  return {
    // Its own folder (code, assets) to read; its own data folder to keep files in.
    read: [dir, data],
    write: [data],
    net: net || (hosts.length ? hosts : false),
    run: perms.includes("commands"),
    env: false,
    sys: false,
    ffi: false,
    import: false,
  };
}

function start({ id, file, dir, data, perms }) {
  stop(id);
  let worker;
  try {
    worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
      name: id,
      deno: { permissions: denoPermissions(perms ?? [], dir, data) },
    });
  } catch (e) {
    send({ id, exit: String(e?.message ?? e) });
    return;
  }
  worker.onmessage = (e) => send({ id, msg: e.data });
  worker.onerror = (e) => {
    e.preventDefault();
    send({ id, exit: e.message ?? "crashed" });
    stop(id);
  };
  worker.postMessage({ init: { file, dir, data } });
  workers.set(id, worker);
}

function stop(id) {
  workers.get(id)?.terminate();
  workers.delete(id);
}

// Read commands until Tern closes the pipe (it quit or crashed): then quit too.
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Deno.stdin.readable) {
  buf += decoder.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.op === "start") start(cmd);
    else if (cmd.op === "stop") stop(cmd.id);
    else if (cmd.op === "to") workers.get(cmd.id)?.postMessage(cmd.msg);
  }
}
Deno.exit(0);
