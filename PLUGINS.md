# Writing a Tern plugin

A plugin is a folder with a `plugin.json` and, usually, a `main.js`. Plain JavaScript — no build
step, no packages, no tools. Your code gets a ready-made `tern` object to talk to Tern.

## Your first plugin in one minute

1. In Tern: **Settings → Plugins → Manage… → Open plugins folder**.
2. Make a folder there, say `hello`, with two files:

   `plugin.json`
   ```json
   { "name": "Hello", "main": "main.js" }
   ```

   `main.js`
   ```js
   tern.addButton({ icon: "👋", title: "Say hello", onClick: () => tern.notify("Hello!") });
   tern.on("claude:done", () => tern.notify("Claude is done"));
   ```
3. Click **Reload plugins**, then turn **Hello** on. A 👋 button appears in the title bar.

Edit the code, click **Reload plugins** again to see the change. That's the whole loop.

## plugin.json

```json
{
  "name": "Project TODO",
  "version": "1.0.0",
  "description": "One line about what it does.",
  "author": "you",
  "main": "main.js",
  "style": "style.css",
  "permissions": ["files"],
  "settings": [
    { "key": "token", "label": "API token", "type": "password", "description": "Where to get it." }
  ]
}
```

Only `name` is required. The folder name is the plugin's id (letters, digits, `-`, `_`).

- `main` — your code. Runs once when Tern starts (or the plugin is turned on).
- `style` — a CSS file added to Tern's page: restyle anything.
- `theme` — colours, no code at all (see [Themes](#themes)).
- `permissions` — what the plugin may do beyond the basics (see below). Tern shows the list when
  the plugin is installed or turned on.
- `settings` — fields Tern shows in the plugin's settings. Types: `text`, `password`, `number`,
  `checkbox`, `select` (with `"options": ["a", "b"]`), and an optional `default`.

## Permissions

Without any permission a plugin can add buttons, menu items and shortcuts, listen to events, show
messages and windows, and keep its own small storage. Everything else needs a permission:

| Permission | Allows |
| --- | --- |
| `files` | `tern.files.*`: read, write and list files **inside the open project** |
| `commands` | `tern.run(...)`: run shell commands in the project folder |
| `terminal` | `tern.terminal.send(...)`: type text into the active terminal tab |
| `network:example.com` | `tern.fetch(...)` to that site (and its subdomains) |
| `network` | `tern.fetch(...)` to any site |

Plugins run in a sandbox: plain `fetch()`, cookies and Tern's internals are not reachable — only
the `tern` object, which checks these permissions on every call. Ask only for what you need:
people trust a plugin that asks for less.

## The `tern` object

Every call returns a Promise.

```js
// UI
tern.addButton({ icon, title, onClick })   // icon: emoji/short text, or an SVG path "M3 3h18…" (24×24)
tern.addMenuItem({ label, onClick(path) })  // in the file tree's right-click menu
tern.addCommand({ name, key: "Ctrl+Shift+Y", run })  // a keyboard shortcut
tern.notify("text")                         // a short message at the bottom of the window
tern.openWindow("panel.html", { title, width, height })  // a window from your folder
tern.closeWindow("panel.html")

// Events
tern.on("claude:done", (e) => {})           // e: { project, seen } — seen: you were looking at that tab
tern.on("claude:waiting", (e) => {})        // Claude asks for permission / your answer
tern.on("claude:working", (e) => {})        // you sent a prompt
tern.on("tab:open" | "tab:close" | "tab:switch", (e) => {})  // e: { kind: "claude" | "shell", project }
tern.on("file:open" | "file:save", (e) => {})                 // e: { path, project }
tern.on("project:change", (e) => {})        // e: { project }

// Data
await tern.project()                        // the open project folder (or null)
await tern.settings.get("token")            // a value from your plugin's settings
await tern.settings.all()                   // all of them
await tern.storage.get("key")               // your plugin's own storage (up to 1 MB of JSON)
await tern.storage.set("key", { any: "json" })

// With permissions
await tern.files.read(".tern/notes.md")     // "files": text, or null if missing
await tern.files.write(".tern/notes.md", "text")
await tern.files.list("src")                // names; folders end with "/"
await tern.run("git log -1 --oneline")      // "commands": { code, stdout, stderr }
await tern.terminal.send("explain this file") // "terminal": into the active tab (not sent)
await tern.fetch(url, { method: "POST", headers: {}, body: {} })  // "network:…": { status, ok, text, json }
```

`body` can be an object (sent as JSON) or a string.

## Windows

`tern.openWindow("panel.html")` opens an HTML file from your folder in a small window people can
move and resize. Write it as a normal page: `<style>`, markup and `<script>`. The `tern` object
works there too, and Tern's colours are available as CSS variables: `var(--bg)`, `--panel`,
`--line`, `--fg`, `--dim`, `--accent`, `--accent-soft`.

Inline everything (styles, scripts, images as `data:` URLs): windows can't load other files or
anything from the internet — use `tern.fetch` for data.

See [`plugins/todo`](plugins/todo) for a complete example.

## Themes

A theme is just `plugin.json` with a `theme` — no code:

```json
{
  "name": "My theme",
  "theme": {
    "dark":  { "bg": "#000000", "accent": "#00ff66", "fg": "#9dffbf" },
    "light": { "accent": "#007a33" },
    "terminal": { "background": "#000000", "foreground": "#9dffbf", "green": "#00ff66" }
  }
}
```

Interface colours are Tern's CSS variables without `--`: `bg`, `panel`, `line`, `fg`, `fg2`,
`dim`, `faint`, `accent`, `accent-soft`, `glow`, `hover`, `selection`, `syn-keyword`,
`syn-string`… (see `src/styles.css`). `colors` applies to both themes. `terminal` /
`terminalLight` take xterm's palette names: `background`, `foreground`, `cursor`, `black`, `red`,
`green`, `yellow`, `blue`, `magenta`, `cyan`, `white` and their `bright…` versions. The user's own
colours in settings.json still win over a theme. See [`plugins/matrix-theme`](plugins/matrix-theme).

## Publishing in the catalog

1. Put your plugin in a public GitHub repository (the folder with `plugin.json`, at the root or
   in a subfolder).
2. Open a pull request to Tern that adds an entry to [`plugins/catalog.json`](plugins/catalog.json):

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "author": "you",
  "description": "One line.",
  "permissions": ["files"],
  "url": "https://github.com/you/my-plugin/archive/refs/heads/main.zip",
  "path": ""
}
```

`url` is a zip of your repository; `path` is the plugin's folder inside it (`""` for the root).
List the same permissions as your `plugin.json` — people see them before they install. To ship an
update, raise `version` in both places.

## Debugging

Errors from your code show in Tern's developer console (`[plugin your-id] …`); `tern.notify` is
the quickest way to print something on screen.
