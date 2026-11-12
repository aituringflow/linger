/** Display-only cleanup. Preserve Markdown whitespace and never clean fenced/indented code. */
export function stripRateLimitText(text?: string | null): string {
  if (!text) return text || "";
  let fence: { marker: string; length: number } | undefined;
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const delimiter = rawLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      out.push(rawLine);
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      continue;
    }
    if (delimiter) {
      fence = { marker: delimiter[1][0], length: delimiter[1].length };
      out.push(rawLine);
      continue;
    }
    if (/^(?: {4}|\t)/.test(rawLine)) { out.push(rawLine); continue; }
    const rest = rawLine.replace(/^\(\s*[0-9a-fA-F]{8,}\s*\/\s*[0-9a-fA-F-]{8,}[^)\n]*\)\s*/, "");
    if (/429/.test(rest) && /频率限制|rate\s*[- ]?limit/i.test(rest)) continue;
    out.push(rest);
  }
  return out.join("\n");
}
