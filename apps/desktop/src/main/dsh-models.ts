import { readDshKey } from "./dsh-credentials.js";

/** Shared DeepSeek Harness catalog for chat and settings. */
export async function listDshModels(): Promise<Array<{ id: string; name: string }>> {
  const key = readDshKey();
  if (!key) return [];
  try {
    const response = await fetch("https://api.deepseek.com/models", { headers: { "x-api-key": key, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("model listing failed");
    const body = await response.json() as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error("invalid model listing");
    const models = body.data.flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const model = entry as { id?: unknown; name?: unknown };
      return typeof model.id === "string" && model.id.trim() ? [{ id: model.id, name: typeof model.name === "string" ? model.name : model.id }] : [];
    });
    if (models.length) return models;
  } catch { /* The SDK catalog is the fallback when discovery fails. */ }
  return [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }, { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" }];
}
