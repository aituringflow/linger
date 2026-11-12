/** Codex may stream formatting-only commentary; keep the UI free of empty scroll boxes. */
export function visibleThinkingText(text: string | undefined, mode?: string): string {
  if (!text) return "";
  if (mode !== "codex") return text.trim();
  const cleaned = text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return /[^\s\p{C}]/u.test(cleaned) ? cleaned : "";
}
