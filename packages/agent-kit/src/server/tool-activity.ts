/** A display detail from the SDK's complete tool input, before JSON/log truncation. */
export function toolActivitySummary(name: string, rawInput: unknown): string {
  let input = rawInput;
  if (typeof input === "string") {
    const text = input;
    try { input = JSON.parse(text); } catch { return text.trim(); }
  }
  if (!input || typeof input !== "object") return "";
  const values = input as Record<string, unknown>;
  const base = (name.split("__").pop() ?? name).toLowerCase();
  const shell = /bash|powershell|command|shell/.test(base) || base === "run";
  const keys = shell
    ? ["command", "cmd", "script", "description"]
    : ["description", "file_path", "notebook_path", "query", "url", "pattern", "path", "prompt"];
  for (const key of keys) {
    if (typeof values[key] === "string" && values[key].trim()) return values[key];
  }
  return "";
}
