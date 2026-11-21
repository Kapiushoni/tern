// CodeMirror setup. Loaded only when the first file is opened, so it costs nothing at startup;
// each language is loaded on first use too.
import { EditorState, Extension, Compartment } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, highlightSpecialChars, rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches, search } from "@codemirror/search";
import {
  syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, StreamLanguage,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

type Loader = () => Promise<Extension>;
const legacy = (load: () => Promise<Parameters<typeof StreamLanguage.define>[0]>): Loader => async () =>
  StreamLanguage.define(await load());

const LANGS: Record<string, Loader> = {
  java: async () => (await import("@codemirror/lang-java")).java(),
  kt: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin),
  kts: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).kotlin),
  py: async () => (await import("@codemirror/lang-python")).python(),
  rs: async () => (await import("@codemirror/lang-rust")).rust(),
  ts: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true }),
  tsx: async () => (await import("@codemirror/lang-javascript")).javascript({ typescript: true, jsx: true }),
  js: async () => (await import("@codemirror/lang-javascript")).javascript(),
  mjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
  cjs: async () => (await import("@codemirror/lang-javascript")).javascript(),
  jsx: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true }),
  html: async () => (await import("@codemirror/lang-html")).html(),
  htm: async () => (await import("@codemirror/lang-html")).html(),
  css: async () => (await import("@codemirror/lang-css")).css(),
  json: async () => (await import("@codemirror/lang-json")).json(),
  yml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  yaml: async () => (await import("@codemirror/lang-yaml")).yaml(),
  md: async () => (await import("@codemirror/lang-markdown")).markdown(),
  sql: async () => (await import("@codemirror/lang-sql")).sql(),
  sh: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
  bash: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
  zsh: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
  ps1: legacy(async () => (await import("@codemirror/legacy-modes/mode/powershell")).powerShell),
  toml: legacy(async () => (await import("@codemirror/legacy-modes/mode/toml")).toml),
  // C and C++ (one grammar covers both), headers included.
  c: async () => (await import("@codemirror/lang-cpp")).cpp(),
  h: async () => (await import("@codemirror/lang-cpp")).cpp(),
  cpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
  cc: async () => (await import("@codemirror/lang-cpp")).cpp(),
  cxx: async () => (await import("@codemirror/lang-cpp")).cpp(),
  "c++": async () => (await import("@codemirror/lang-cpp")).cpp(),
  hpp: async () => (await import("@codemirror/lang-cpp")).cpp(),
  hh: async () => (await import("@codemirror/lang-cpp")).cpp(),
  hxx: async () => (await import("@codemirror/lang-cpp")).cpp(),
  ino: async () => (await import("@codemirror/lang-cpp")).cpp(),
  cs: legacy(async () => (await import("@codemirror/legacy-modes/mode/clike")).csharp),
  go: legacy(async () => (await import("@codemirror/legacy-modes/mode/go")).go),
  lua: legacy(async () => (await import("@codemirror/legacy-modes/mode/lua")).lua),
  rb: legacy(async () => (await import("@codemirror/legacy-modes/mode/ruby")).ruby),
  swift: legacy(async () => (await import("@codemirror/legacy-modes/mode/swift")).swift),
  cmake: legacy(async () => (await import("@codemirror/legacy-modes/mode/cmake")).cmake),
};

/** Files known by their whole name rather than an extension. */
const BY_NAME: Record<string, Loader> = {
  "cmakelists.txt": LANGS.cmake,
  dockerfile: legacy(async () => (await import("@codemirror/legacy-modes/mode/dockerfile")).dockerFile),
  makefile: legacy(async () => (await import("@codemirror/legacy-modes/mode/shell")).shell),
};

async function languageFor(path: string): Promise<Extension> {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  const load = BY_NAME[name] ?? LANGS[ext];
  if (!load) return [];
  try {
    return await load();
  } catch {
    return [];
  }
}

// Colours come from CSS variables, so the dark and light themes both work without rebuilding.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.heading], color: "var(--accent)", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "var(--syn-string)", textDecoration: "underline" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.meta, t.processingInstruction], color: "var(--dim)" },
  { tag: [t.invalid], color: "var(--syn-error)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg)", fontSize: "13px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.5" },
  ".cm-content": { caretColor: "var(--accent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-gutters": { backgroundColor: "var(--bg)", color: "var(--faint)", border: "none" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--dim)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none" },
  ".cm-selectionMatch": { backgroundColor: "var(--accent-soft)" },
  ".cm-searchMatch": { backgroundColor: "var(--search-match)", outline: "1px solid var(--accent)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--accent-soft)" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--fg)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
});

export interface CodeEditor {
  view: EditorView;
  /** The whole text, with the file's own line endings. */
  text(): string;
  /** Replaces the text (after a change on disk), keeping the cursor and scroll where possible. */
  replace(text: string): void;
  setReadOnly(on: boolean): void;
  /** Types text at the cursor (replacing the selection), as if typed. */
  insert(text: string): void;
  /** Selects `len` characters at line/column (1-based line, 0-based column) and centres them. */
  goto(line: number, col: number, len: number): void;
  destroy(): void;
}

export async function createEditor(
  parent: HTMLElement,
  path: string,
  text: string,
  on: { save: () => void; change: () => void },
): Promise<CodeEditor> {
  const crlf = text.includes("\r\n");
  const readOnly = new Compartment();
  const state = EditorState.create({
    doc: text,
    extensions: [
      EditorState.lineSeparator.of(crlf ? "\r\n" : "\n"),
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      rectangularSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(highlight),
      theme,
      readOnly.of(EditorState.readOnly.of(false)),
      keymap.of([
        { key: "Mod-s", preventDefault: true, run: () => (on.save(), true) },
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) on.change();
      }),
      await languageFor(path),
    ],
  });
  const view = new EditorView({ state, parent });
  return {
    view,
    text: () => view.state.doc.toString(),
    replace(next: string) {
      const sel = view.state.selection.main;
      const scroll = view.scrollDOM.scrollTop;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
      const len = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.min(sel.anchor, len), head: Math.min(sel.head, len) } });
      view.scrollDOM.scrollTop = scroll;
    },
    setReadOnly(on: boolean) {
      view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(on)) });
    },
    insert(text: string) {
      view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.type" });
      view.focus();
    },
    goto(line: number, col: number, len: number) {
      const doc = view.state.doc;
      const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
      const from = l.from + Math.min(col, l.length);
      const to = Math.min(from + len, l.to);
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
    },
    destroy: () => view.destroy(),
  };
}
