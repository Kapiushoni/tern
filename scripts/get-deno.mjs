// Downloads the Deno that Tern bundles (it runs plugins' background code) into
// src-tauri/binaries/deno-<target triple>[.exe], where Tauri's "externalBin" picks it up.
//   node scripts/get-deno.mjs                  — for this computer
//   node scripts/get-deno.mjs aarch64-apple-darwin
// Needs `unzip` (Git Bash, macOS, Linux) or PowerShell on Windows.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/** Pinned: plugins are tested against this version. An LTS release. */
const VERSION = "v2.9.8";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const triple =
  process.argv[2] ??
  execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    .split("\n")
    .find((l) => l.startsWith("host:"))
    .slice(5)
    .trim();
const exe = triple.includes("windows") ? ".exe" : "";
const out = join(root, "src-tauri", "binaries", `deno-${triple}${exe}`);

if (existsSync(out)) {
  console.log(`already there: ${out}`);
  process.exit(0);
}

const url = `https://dl.deno.land/release/${VERSION}/deno-${triple}.zip`;
console.log(`downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const tmp = join(tmpdir(), `tern-deno-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const zip = join(tmp, "deno.zip");
writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
if (process.platform === "win32") {
  execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${tmp}'`]);
} else {
  execFileSync("unzip", ["-o", "-q", zip, "-d", tmp]);
}
mkdirSync(dirname(out), { recursive: true });
renameSync(join(tmp, `deno${exe}`), out);
if (!exe) chmodSync(out, 0o755);
rmSync(tmp, { recursive: true, force: true });
console.log(`saved ${out}`);
