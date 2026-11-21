// Builds src/icon-map.json from the Material Icon Theme manifest (the VS Code icon theme):
// which icon a file name, an extension or a folder name gets. Run after updating the package:
//   node scripts/gen-icon-map.mjs
import { readFileSync, writeFileSync } from "node:fs";

const m = JSON.parse(readFileSync("node_modules/material-icon-theme/dist/material-icons.json", "utf8"));
const icon = (id) => {
  const def = m.iconDefinitions[id];
  return def ? def.iconPath.split("/").pop().replace(/\.svg$/, "") : undefined;
};
const map = (obj = {}) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.includes("/")) continue; // nested paths like ".github/workflows": the tree names one folder at a time
    const name = icon(v);
    if (name) out[k.toLowerCase()] = name;
  }
  return out;
};
// VS Code picks some icons by language rather than extension; map the common extensions here.
const LANGUAGE_EXT = {
  python: ["py", "pyw", "pyi"], javascript: ["js", "mjs", "cjs"], typescript: ["ts", "mts", "cts"],
  javascriptreact: ["jsx"], typescriptreact: ["tsx"], java: ["java"], c: ["c"], cpp: ["cpp", "cc", "cxx", "c++", "hpp", "hh", "hxx"],
  csharp: ["cs"], go: ["go"], rust: ["rs"], ruby: ["rb"], php: ["php"], lua: ["lua"], swift: ["swift"],
  kotlin: ["kt", "kts"], html: ["html", "htm"], css: ["css"], scss: ["scss"], less: ["less"], json: ["json"],
  jsonc: ["jsonc"], yaml: ["yaml", "yml"], xml: ["xml"], markdown: ["md", "markdown"], shellscript: ["sh", "bash", "zsh"],
  powershell: ["ps1", "psm1"], bat: ["bat", "cmd"], sql: ["sql"], dockerfile: [], plaintext: ["txt"],
  vue: ["vue"], svelte: ["svelte"], dart: ["dart"], r: ["r"], scala: ["scala"], groovy: ["groovy"], perl: ["pl"],
};
const byLanguage = (ids = {}) => {
  const out = {};
  for (const [lang, exts] of Object.entries(LANGUAGE_EXT)) {
    const name = icon(ids[lang]);
    if (name) for (const e of exts) out[e] = name;
  }
  return out;
};

const out = {
  file: icon(m.file),
  folder: icon(m.folder),
  folderOpen: icon(m.folderExpanded),
  ext: { ...byLanguage(m.languageIds), ...map(m.fileExtensions) },
  names: map(m.fileNames),
  // An open folder's icon is the closed one + "-open".
  folders: map(m.folderNames),
  light: {
    ext: { ...byLanguage(m.light?.languageIds), ...map(m.light?.fileExtensions) },
    names: map(m.light?.fileNames),
    folders: map(m.light?.folderNames),
  },
};
writeFileSync("src/icon-map.json", JSON.stringify(out));
const kb = (Buffer.byteLength(JSON.stringify(out)) / 1024).toFixed(0);
console.log(`icon map: ${Object.keys(out.ext).length} extensions, ${Object.keys(out.names).length} names, ${Object.keys(out.folders).length} folders, ${kb} KB`);
