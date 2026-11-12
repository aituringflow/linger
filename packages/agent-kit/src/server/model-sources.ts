import fs from "node:fs";
import path from "node:path";
import { resolveModelsFile } from "./models-file.js";
import { query, unstable_v2_createSession, type RawLanguageModel } from "@tencent-ai/agent-sdk";

/**
 * 模型来源解析（agent-kit 通用能力，供所有宿主复用）：
 *
 *   未登录 CodeBuddy 时只展示选中的 models.json 自定义模型；
 *   已登录时合并 CodeBuddy 可用模型和自定义模型。
 *
 * 这是 CodeBuddy 的原生自定义模型机制：配置文件的 models 字段是数组，
 * agent-kit 只负责读取并暴露给前端下拉，不代为生成。应用端无需感知这套逻辑——
 * 直接调用 getModelOptions()，或让前端自动从 /api/models/list 拉取即可。
 */

/** 模型选项：兼容「纯 id 字符串」与「{id, name, meta} 对象」两种来源。 */
export type ServerModelOption = string | { id: string; name?: string; meta?: Record<string, unknown> };

const SDK_MODELS_TTL_MS = 5 * 60 * 1000;
let sdkModelsCache: { at: number; models: { id: string; name?: string; meta?: Record<string, unknown> }[] } | null = null;

/** 配置仅补充详情，不改变 SDK 返回的可用模型范围。缓存命中时也重新读取配置。 */
function supplementModelDetails(models: NonNullable<typeof sdkModelsCache>["models"]): ServerModelOption[] {
  const custom = readCodeBuddyModels() ?? [];
  return models.map((model) => {
    const matches = custom.filter((entry) => entry.id === model.id);
    const local = matches.find((entry) => model.meta?.vendor && entry.meta.vendor === model.meta.vendor)
      ?? (matches.length === 1 ? matches[0] : undefined);
    const meta = { ...local?.meta, ...model.meta };
    delete meta.apiKey;
    return { ...model, name: model.name || local?.name || undefined, meta };
  });
}

/** 显式选取展示字段，避免把 CLI 原始配置中的凭据下发。 */
function rawModelDetails(model: RawLanguageModel): Record<string, unknown> {
  // iconUrl 由 CodeBuddy 直接给出（远程 SVG/PNG 或内联 data:image/svg+xml;base64），原样下发；覆盖率并非 100%。
  const fields = ["vendor", "version", "family", "maxInputTokens", "maxOutputTokens", "description",
    "descriptionZh", "descriptionEn", "supportsToolCall", "supportsImages", "supportsReasoning",
    "contextWindow", "maxImageCount", "credits", "tags", "reasoning", "modelType", "trustLevel",
    "iconUrl"] as const;
  const meta: Record<string, unknown> = {};
  for (const field of fields) {
    const value = model[field];
    if (value !== undefined && value !== null && value !== "") meta[field] = value;
  }
  return meta;
}

/**
 * 读取优先级最高且存在的 models.json 自定义模型。
 * 不存在 / 损坏 / models 为空 → 返回 null。
 * 返回的 meta 已剔除 apiKey（绝不把密钥下发前端或写进日志）。
 */
export function readCodeBuddyModels(): { id: string; name: string; meta: Record<string, unknown> }[] | null {
  const filePath = resolveModelsFile();
  try {
    if (!filePath) return null;
    const cfg = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const arr = (cfg as { models?: unknown })?.models;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const list = arr
      .map((m: unknown) => {
        if (!m || typeof m !== "object") return null;
        const rec = m as Record<string, unknown>;
        const id = typeof rec.id === "string" ? rec.id.trim() : "";
        if (!id) return null;
        // 剔除 apiKey：绝不下发密钥
        const { apiKey: _apiKey, ...meta } = rec;
        void _apiKey;
        return {
          id,
          name: typeof rec.name === "string" ? rec.name.trim() : "",
          meta,
        };
      })
      .filter(Boolean) as { id: string; name: string; meta: Record<string, unknown> }[];
    return list.length > 0 ? list : null;
  } catch {
    // 文件损坏 / 不可读 → 无自定义模型
    return null;
  }
}

/**
 * 读取自定义模型列表。没有配置时返回空列表。
 * 返回值直接序列化给前端（已剔除 apiKey）。
 */
export function getModelOptions(): ServerModelOption[] {
  const custom = readCodeBuddyModels() ?? [];
  const seen = new Set<string>();
  const result: ServerModelOption[] = [];
  for (const model of custom) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

/** 只展示 models.json 中的自定义模型；仅明确设置为 true 时启用。 */
export function isCustomModelOnly(): boolean {
  return process.env.CUSTOM_MODEL_ONLY?.trim().toLowerCase() === "true";
}

/**
 * 当前应该用哪个 CodeBuddy 环境（登录态、模型、认证流程必须一致，否则「登录成功但仍显示未登录」）。
 * 只认 SDK 支持的四个值，其余（含未配置）回落 internal。
 */
export function codeBuddyAuthEnvironment(): "internal" | "external" | "ioa" | "cloudhosted" {
  const configuredEnvironment = process.env.CODEBUDDY_INTERNET_ENVIRONMENT?.trim();
  return configuredEnvironment === "external" || configuredEnvironment === "ioa" || configuredEnvironment === "cloudhosted"
    ? configuredEnvironment : "internal";
}

/** Electron launches the SDK CLI with its own executable, including in development. */
export function codeBuddyRuntimeOptions(): { executable?: string; env: Record<string, string> } {
  return process.versions.electron
    ? { executable: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } }
    : { env: {} };
}

/** 用 SDK 的 accountInfo 控制请求查询当前 CLI 登录态，不读取或推断本地凭据文件。 */
export async function isCodeBuddyAuthenticated(): Promise<boolean> {
  const environment = codeBuddyAuthEnvironment();
  const probe = query({
    prompt: "",
    options: {
      environment,
      model: "hy3",
      ...codeBuddyRuntimeOptions(),
      env: { ...process.env, ...codeBuddyRuntimeOptions().env, CODEBUDDY_INTERNET_ENVIRONMENT: environment },
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const account = await Promise.race([
      probe.connect().then(() => probe.accountInfo()),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("CodeBuddy 登录状态查询超时")), 10_000); }),
    ]);
    // 当前 CLI 的实际 account 响应还包含 uid/userId/token，SDK 类型声明尚未覆盖这些字段。
    const cliAccount = account as typeof account & { uid?: string; userId?: string; token?: string };
    return Boolean(cliAccount.token || cliAccount.userId || cliAccount.uid || account.email || account.tokenSource || account.apiKeySource || account.subscriptionType);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
    // 当前 SDK 的 Query 未公开 close；cleanup 是它内部结束 CLI 子进程的方法。
    (probe as unknown as { cleanup(): void }).cleanup();
  }
}

/** SDK 模型与第一个 models.json 分开读取，供本地应用替换自定义部分。 */
export async function getCodeBuddyModelGroups(): Promise<{ native: ServerModelOption[]; custom: ServerModelOption[] }> {
  const custom = getModelOptions();
  if (isCustomModelOnly()) return { native: [], custom };
  if (!(await isCodeBuddyAuthenticated())) {
    sdkModelsCache = null;
    return { native: [], custom };
  }
  const native = await getAvailableCodeBuddyModels() ?? [];
  return { native, custom };
}

export function mergeCodeBuddyModels(native: ServerModelOption[], custom: ServerModelOption[]): ServerModelOption[] {
  const key = (model: ServerModelOption): string => {
    if (typeof model === "string") return `::${model}`;
    return `${String(model.meta?.vendor ?? "")}::${model.id}`;
  };
  const seen = new Set(native.map(key));
  return [...native, ...custom.filter((model) => {
    const identity = key(model);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  })];
}

/** 登录时合并内置与自定义模型；登出后只返回自定义模型。 */
export async function getConfiguredCodeBuddyModels(): Promise<ServerModelOption[]> {
  const { native, custom } = await getCodeBuddyModelGroups();
  return mergeCodeBuddyModels(native, custom);
}

/**
 * Ask the logged-in CodeBuddy CLI for the models available to the current account.
 * The SDK call is experimental, so callers should fall back to getModelOptions().
 */
export async function getAvailableCodeBuddyModels(): Promise<ServerModelOption[] | null> {
  if (sdkModelsCache && Date.now() - sdkModelsCache.at < SDK_MODELS_TTL_MS) {
    return supplementModelDetails(sdkModelsCache.models);
  }
  let session: { getAvailableModels?: () => Promise<Array<{ modelId: string; name: string; description?: string }>>; getAvailableModelsRaw?: () => Promise<RawLanguageModel[]>; close?: () => void } | undefined;
  try {
    session = unstable_v2_createSession({
      model: "hy3",
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEBUDDY_INTERNET_ENVIRONMENT:
          process.env.CODEBUDDY_INTERNET_ENVIRONMENT?.trim() || "internal",
      },
    }) as typeof session;
    const available = await session!.getAvailableModels?.();
    if (!Array.isArray(available) || available.length === 0) return null;
    // 部分 CLI 仅支持简化列表；详情请求失败仍保留已拿到的列表。
    const raw = await session!.getAvailableModelsRaw?.().catch(() => []) ?? [];
    const models = available
      .map((m) => ({
        id: typeof m.modelId === "string" ? m.modelId.trim() : "",
        name: typeof m.name === "string" ? m.name.trim() : undefined,
        meta: typeof m.description === "string" && m.description.trim()
          ? { description: m.description.trim() }
          : undefined,
      }))
      // CodeBuddy also reports custom models from its own persisted registry as
      // `custom-local:*`. Our custom source is the first selected models.json only.
      .filter((m) => m.id && !m.id.startsWith("custom-local:"));
    if (!models.length) return null;
    const enriched = models.map((model) => {
      const details = raw.find((entry) => entry.id === model.id);
      return { ...model, meta: { ...model.meta, ...(details ? rawModelDetails(details) : {}) } };
    });
    sdkModelsCache = { at: Date.now(), models: enriched };
    return supplementModelDetails(enriched);
  } catch {
    return null;
  } finally {
    session?.close?.();
  }
}

/**
 * 选中模型是否声明「支持工具调用」。
 *
 * 判定顺序：models.json 自定义模型（id 可能带 `custom-local:` / `custom:` 前缀）→
 * SDK 已缓存的 CodeBuddy 原生模型 → 都没有就按支持处理（保持既有行为，不误伤内置模型）。
 *
 * 为什么必须知道这件事：CLI 侧把「按模型能力剥掉 tools」的兜底关掉了
 * （product.json 的 SkipToolCallSupportCheck=true，见 sendRequest 里的
 * stripToolDefinitions 分支），所以 models.json 的 supportsToolCall:false 只影响
 * 前端展示，请求体里照样带 tools。本地 ollama 之类的服务端会直接 400
 * 「registry.ollama.ai/library/xxx does not support tools」。
 * 因此调用方要在构造 query options 时**从源头不给工具**。
 */
export function modelSupportsToolCall(modelId: string | undefined): boolean {
  const id = modelId?.trim();
  if (!id) return true;
  const bare = id.replace(/^custom-local:/, "").replace(/^custom:/, "");
  const custom = (readCodeBuddyModels() ?? []).find((model) => model.id === id || model.id === bare);
  if (custom) return custom.meta.supportsToolCall !== false;
  const native = sdkModelsCache?.models.find((model) => model.id === id || model.id === bare);
  if (native) return native.meta?.supportsToolCall !== false;
  return true;
}

/**
 * 自定义模型（models.json 里带 url 的条目）跑 CLI 时，必须把 CODEBUDDY_CONFIG_DIR 指向
 * models.json 所在目录，CLI 才会读到那份 url / apiKey；否则它会把模型 id 当云端模型去注册表查，
 * 直接返回「400 model [xxx] service info not found」——主对话之所以能用本地模型，正是调用方
 * 在 env 里做了这一步；标题生成等旁路请求很容易漏掉，于是只有主对话能跑、标题永远失败。
 *
 * 只对自定义模型生效：内置模型保持 ~/.codebuddy 的登录态，绝不能被改指到别处。
 * 调用方已显式给了 CODEBUDDY_CONFIG_DIR 时原样保留。
 */
export function customModelEnv(
  modelId: string | undefined,
  base?: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  const env = { ...(base ?? {}) };
  if (env.CODEBUDDY_CONFIG_DIR) return env;
  const id = modelId?.trim();
  if (!id) return base;
  const bare = id.replace(/^custom-local:/, "").replace(/^custom:/, "");
  const custom = (readCodeBuddyModels() ?? []).find((model) => model.id === id || model.id === bare);
  if (!custom || typeof custom.meta.url !== "string" || !custom.meta.url.trim()) return base;
  try { new URL(custom.meta.url); } catch { return base; }
  const file = resolveModelsFile();
  if (!file || path.basename(file).toLowerCase() !== "models.json") return base;
  env.CODEBUDDY_CONFIG_DIR = path.dirname(file);
  return env;
}

/** 默认允许用户选择模型；只有明确设置为 false 才关闭。 */
export function isModelSelectEnabled(): boolean {
  return process.env.ENABLE_MODEL_SELECT?.trim().toLowerCase() !== "false";
}

/** 关闭模型选择时的固定模型：自定义列表首项 → SDK 默认 hy3。 */
export function getDefaultModel(): string {
  const first = getModelOptions()[0];
  return (typeof first === "string" ? first : first?.id) || "hy3";
}
