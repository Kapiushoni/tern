import { t } from "./i18n";

/**
 * The label for a tab's kind. A Claude tab shows a spark (✻, the glyph Claude Code itself spins
 * while it works) that turns while Claude is busy and glows when it's done; a shell shows "shell".
 */
export function setKind(el: HTMLElement, kind: string) {
  const claude = kind === "claude";
  el.classList.toggle("claude-mark", claude);
  el.textContent = claude ? "✻" : kind;
  if (claude) el.title = t("Claude Code");
  else el.removeAttribute("title");
}

/** Tooltip for the spark, from the tab's activity. */
export function sparkTitle(activity: string, waiting: boolean) {
  if (activity === "working") return t("Claude Code · working…");
  if (activity === "done") return waiting ? t("Claude Code · waiting for you") : t("Claude Code · finished");
  return t("Claude Code");
}
