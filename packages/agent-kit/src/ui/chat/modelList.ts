import { apiFetch } from "../shared/apiFetch.ts";
import type { ModelOption, ModelMeta } from "../components/ModelSelect.tsx";

// 同时发生的请求共用同一个进行中的 Promise；完成后不缓存模型列表。
export interface ModelListSnapshot {
  basePath: string;
  list: { id: string; name?: string; meta?: ModelMeta }[];
  codexList: { id: string; name?: string; meta?: ModelMeta }[];
  enabled: boolean;
  defaultModel: string;
  defaultAgentMode: "codebuddy" | "codex";
  /** 服务端下发的全量可用模式（未受 agentModesOverride 过滤）；各实例自行按 override 过滤 */
  agentModes: ("codebuddy" | "codex")[];
  modelError: string | null;
}
export let modelListSnapshot: ModelListSnapshot | null = null;
let modelListPromise: Promise<ModelListSnapshot> | null = null;
export function clearModelListSnapshot(): void { modelListSnapshot = null; modelListPromise = null; }
// 模块级归一化（fetchModelList 在组件外，无法复用组件内的 normalizeOpts）：
// 纯字符串 id 或 {id,name,meta} 统一成 {id,name?,meta?}，按 id 匹配与发送。
function normalizeModelList(list: ModelOption[]): { id: string; name?: string; meta?: ModelMeta }[] {
  return list
    .map((m) =>
      typeof m === "string"
        ? { id: m.trim() }
        : { id: (m.id || "").trim(), name: m.name ? m.name.trim() : undefined, meta: m.meta },
    )
    .filter((o) => o.id);
}
export function fetchModelList(bp: string): Promise<ModelListSnapshot> {
  if (modelListPromise) return modelListPromise;
  modelListPromise = (async () => {
    const desktopModels = (window as unknown as { agentHost?: { models?: {
      list(): Promise<{ models: Record<string, unknown>[] }>;
    } } }).agentHost?.models;
    let remote: unknown;
    let offline = false;
    try {
      const controller = new AbortController();
      const timeout = desktopModels ? window.setTimeout(() => controller.abort(), 30_000) : null;
      let res: Response;
      try { res = await apiFetch(`${bp}/api/models/list`, { cache: "no-store", signal: controller.signal }); }
      finally { if (timeout !== null) window.clearTimeout(timeout); }
      if (!res.ok) throw new Error("模型列表加载失败");
      remote = await res.json();
    } catch (error) {
      if (!desktopModels) throw error;
      offline = true;
      remote = {};
    }
    const data = remote as {
      models?: ModelOption[]; nativeModels?: ModelOption[]; customModels?: ModelOption[];
      modelError?: string | null; codexModels?: ModelOption[];
      customModelOnly?: boolean;
      enableModelSelect?: boolean; defaultModel?: string; defaultAgentMode?: string; agentModes?: string[];
    };
    let norm = normalizeModelList(Array.isArray(data?.models) ? data.models : []);
    // Desktop keeps every model returned by the server and adds models from
    // its own models.json. The local SDK must not replace the server list.
    if (desktopModels) {
      const local = await desktopModels.list().catch(() => ({ models: [] as Record<string, unknown>[] }));
      const localCustom = normalizeModelList(local.models.map(({ id, name, hasApiKey: _hasApiKey, ...meta }) => ({
        id: String(id ?? ""), name: typeof name === "string" ? name : undefined, meta,
      })));
      const seen = new Set(norm.map((model) => `${model.meta?.vendor ?? ""}::${model.id}`));
      const custom = localCustom.filter((model) => !seen.has(`${model.meta?.vendor ?? ""}::${model.id}`));
      const localEndpoint = (model: typeof custom[number]) => {
        try { return ["localhost", "127.0.0.1", "::1"].includes(new URL(String(model.meta?.url || "")).hostname); }
        catch { return false; }
      };
      norm = offline || norm.length === 0 ? [...custom.filter(localEndpoint), ...custom.filter((model) => !localEndpoint(model))]
        : [...norm, ...custom];
    }
    const codexList = normalizeModelList(Array.isArray(data?.codexModels) ? data.codexModels : [{ id: "__codex_default__", name: "Codex 默认模型" }]);
    const enabled = desktopModels ? norm.length > 0 : data.enableModelSelect === true;
    const firstModel = desktopModels ? (norm[0]?.id ?? "hy3") : typeof data.defaultModel === "string" && data.defaultModel.trim() ? data.defaultModel.trim() : "hy3";
    const defaultAgentMode = data.defaultAgentMode === "codex" ? "codex" : "codebuddy";
    const configured: ("codebuddy" | "codex")[] = Array.isArray(data.agentModes)
      ? data.agentModes.filter((mode): mode is "codebuddy" | "codex" => mode === "codebuddy" || mode === "codex")
      : offline ? ["codebuddy", "codex"] : [defaultAgentMode];
    const serverModes: ("codebuddy" | "codex")[] = configured.length ? configured : [defaultAgentMode];
    const nextModelError = norm.length ? null : data.modelError || "没有可用模型";
    const snap: ModelListSnapshot = { basePath: bp, list: norm, codexList, enabled, defaultModel: firstModel, defaultAgentMode, agentModes: serverModes, modelError: nextModelError };
    return snap;
  })();
  void modelListPromise.finally(() => { modelListPromise = null; }).catch(() => {});
  return modelListPromise;
}

// 兼容仍在运行的旧版服务端：错误文本不能覆盖本地快速标题。
export function isInvalidGeneratedTitle(value: string): boolean {
  const title = value.trim();
  return !title || /^(?:[45]\d\d)(?:\s|:|\b)/.test(title) ||
    /(?:this model is unavailable|model.*not found|model.*unavailable|rate limit|unauthorized|forbidden|internal server error|bad gateway|service unavailable)/i.test(title);
}

