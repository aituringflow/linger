import type { ComputeProviderId, LauncherComputeProvider } from "../../shared/types";

type AgentMode = "codebuddy" | "codex" | "dsh";
const CACHE_KEY = "launcher:compute-provider-status:v1";

/** Only non-secret status flags are persisted for an immediate first render. */
export function readCachedProviders(): LauncherComputeProvider[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Partial<LauncherComputeProvider>;
      if ((entry.id !== "workbuddy" && entry.id !== "codex" && entry.id !== "dsh") || typeof entry.available !== "boolean" || typeof entry.authenticated !== "boolean") return [];
      return [{ id: entry.id, name: entry.id, available: entry.available, authenticated: entry.authenticated }];
    });
  } catch { return null; }
}

export function cacheProviders(providers: readonly LauncherComputeProvider[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(providers.map(({ id, available, authenticated }) => ({ id, available, authenticated }))));
  } catch { /* storage unavailable */ }
}

/** Only enabled providers whose credentials were successfully checked can be selected. */
export function availableAgentModes(enabled: readonly ComputeProviderId[], providers: readonly LauncherComputeProvider[]): AgentMode[] {
  const ready = new Set(providers.filter((provider) => provider.available && provider.authenticated).map((provider) => provider.id));
  return enabled.filter((id) => ready.has(id)).map((id) => id === "workbuddy" ? "codebuddy" : id);
}
