import fs from "node:fs";
import path from "node:path";
import { appHomePath } from "./app-home.js";
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

/** 已落盘到缓存 / 兜底目录里的 SDK 模型条目（id/展示名/详情 meta，已剔除凭据）。 */
type SdkModelEntry = { id: string; name?: string; meta?: Record<string, unknown> };
let sdkModelsCache: { at: number; models: SdkModelEntry[] } | null = null;
/**
 * 上一次成功拉取的云端模型目录（不设 TTL）。新鲜拉取失败时作为 stale 兜底：
 * 慢网 / VPN 抖动导致本次超时或报错时，下拉仍保留上一份可用目录，而不是整列只剩自定义模型。
 */
let lastGoodSdkModels: { models: SdkModelEntry[] } | null = null;

/**
 * 最近一次「探针成功返回」的登录态。探针因 CLI 冷启动 / 超时 / 网络抖动失败时沿用这份结果，
 * 避免慢网（VPN）下把已登录误判成未登录、弹出重新登录。
 * 探针返回「空账号」（明确未登录）会覆盖成 false；显式登出时由 clearCodeBuddyAuthCache 清空。
 */
let lastKnownAuth: { authenticated: boolean; at: number } | null = null;

/** 磁盘兜底记录的有效期：超过后不再采信，真实登录态以本次探针 / 发送请求为准。 */
const AUTH_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PersistedAuthState { authenticated: boolean; environment: string; at: number }

function authStateFile(): string {
  return appHomePath("codebuddy-auth-state.json");
}

/** 读磁盘兜底登录态；记录缺失 / 损坏 / 过期 / 环境不一致时返回 null。 */
function readPersistedAuth(): boolean | null {
  try {
    const raw = JSON.parse(fs.readFileSync(authStateFile(), "utf8")) as Partial<PersistedAuthState>;
    if (typeof raw.authenticated !== "boolean" || typeof raw.at !== "number") return null;
    if (Date.now() - raw.at > AUTH_STATE_TTL_MS) return null;
    if (raw.environment !== codeBuddyAuthEnvironment()) return null;
    return raw.authenticated;
  } catch {
    return null;
  }
}

function writePersistedAuth(authenticated: boolean): void {
  try {
    fs.mkdirSync(path.dirname(authStateFile()), { recursive: true });
    const payload: PersistedAuthState = { authenticated, environment: codeBuddyAuthEnvironment(), at: Date.now() };
    fs.writeFileSync(authStateFile(), JSON.stringify(payload), "utf8");
  } catch {
    // 落盘失败不影响主流程；下次探针成功后再写。
  }
}

function clearPersistedAuth(): void {
  try { fs.unlinkSync(authStateFile()); } catch { /* ENOENT 等忽略 */ }
}

// 慢网 / VPN 下 CLI 冷启动 + 登录态回读可能超过 10s：探针超时过短会被误判为未登录，
// 云端模型整列被丢掉。阈值放宽并允许环境变量覆盖。
const AUTH_PROBE_TIMEOUT_MS = Number(process.env.CODEBUDDY_AUTH_PROBE_TIMEOUT_MS || 20_000);
// 一次模型目录拉取（CLI 冷启动 + getAvailableModels 请求）的整体上限。
const MODELS_REQUEST_TIMEOUT_MS = Number(process.env.CODEBUDDY_MODELS_TIMEOUT_MS || 15_000);
// 首次拉取失败后的瞬时重试间隔（只重试一次，避免慢网下反复冷启动 CLI）。
const MODELS_FETCH_RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("CodeBuddy 登录状态查询超时")), AUTH_PROBE_TIMEOUT_MS); }),
    ]);
    // 当前 CLI 的实际 account 响应还包含 uid/userId/token，SDK 类型声明尚未覆盖这些字段。
    const cliAccount = account as typeof account & { uid?: string; userId?: string; token?: string };
    const authenticated = Boolean(cliAccount.token || cliAccount.userId || cliAccount.uid || account.email || account.tokenSource || account.apiKeySource || account.subscriptionType);
    // 探针成功返回：这是明确结论，更新内存与磁盘缓存。
    lastKnownAuth = { authenticated, at: Date.now() };
    writePersistedAuth(authenticated);
    return authenticated;
  } catch {
    // 探针自身失败（CLI 冷启动 / 超时 / 网络抖动）不等于未登录：先沿用本次运行的历史结论，
    // 再回退到磁盘上的最近一次明确结果；都没有（首次运行 / 缓存已清）才按未登录兜底。
    if (lastKnownAuth) return lastKnownAuth.authenticated;
    const persisted = readPersistedAuth();
    return persisted ?? false;
  } finally {
    if (timeout) clearTimeout(timeout);
    // 当前 SDK 的 Query 未公开 close；cleanup 是它内部结束 CLI 子进程的方法。
    (probe as unknown as { cleanup(): void }).cleanup();
  }
}

/** 显式登出后清空登录态与模型缓存，下次探针必须重新判定，不能沿用旧的「已登录」结论。 */
export function clearCodeBuddyAuthCache(): void {
  lastKnownAuth = null;
  sdkModelsCache = null;
  lastGoodSdkModels = null;
  clearPersistedAuth();
}

/** A successful authentication is authoritative even if the next status probe fails. */
export function recordCodeBuddyAuthentication(): void {
  lastKnownAuth = { authenticated: true, at: Date.now() };
  writePersistedAuth(true);
}

/** SDK 模型与第一个 models.json 分开读取，供本地应用替换自定义部分。 */
export async function getCodeBuddyModelGroups(): Promise<{ native: ServerModelOption[]; custom: ServerModelOption[] }> {
  const custom = getModelOptions();
  if (isCustomModelOnly()) return { native: [], custom };
  if (!(await isCodeBuddyAuthenticated())) {
    sdkModelsCache = null;
    lastGoodSdkModels = null;
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
 *
 * 慢网 / VPN 抖动下一次拉取可能超时或报错：失败后重试一次；仍失败则回退到上一份成功目录
 * （stale 兜底），保证下拉不被清空；一次成功后刷新缓存与 stale 目录。
 */
export async function getAvailableCodeBuddyModels(): Promise<ServerModelOption[] | null> {
  if (sdkModelsCache && Date.now() - sdkModelsCache.at < SDK_MODELS_TTL_MS) {
    return supplementModelDetails(sdkModelsCache.models);
  }
  let enriched: SdkModelEntry[] | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const fetched = await fetchAvailableCodeBuddyModelsOnce();
    if (fetched && fetched.length) { enriched = fetched; break; }
    if (attempt < 2) await sleep(MODELS_FETCH_RETRY_DELAY_MS);
  }
  if (enriched && enriched.length) {
    sdkModelsCache = { at: Date.now(), models: enriched };
    lastGoodSdkModels = { models: enriched };
    return supplementModelDetails(enriched);
  }
  // 新鲜拉取失败：有上一份成功目录时先回退 stale 数据（即使已过 TTL），保住下拉列表。
  if (lastGoodSdkModels?.models.length) return supplementModelDetails(lastGoodSdkModels.models);
  return null;
}

/** 单次创建 SDK 会话拉取模型目录；我方超时竞态兜底，超时/报错一律返回 null。 */
async function fetchAvailableCodeBuddyModelsOnce(): Promise<SdkModelEntry[] | null> {
  let session: { getAvailableModels?: () => Promise<Array<{ modelId: string; name: string; description?: string }>>; getAvailableModelsRaw?: () => Promise<RawLanguageModel[]>; close?: () => void } | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    session = unstable_v2_createSession({
      model: "hy3",
      cwd: process.cwd(),
      ...codeBuddyRuntimeOptions(),
      // Some bundled CLI versions reject the SDK's --request-timeout-ms flag.
      // The outer Promise.race below bounds the whole request instead.
      env: {
        ...process.env,
        ...codeBuddyRuntimeOptions().env,
        CODEBUDDY_INTERNET_ENVIRONMENT:
          process.env.CODEBUDDY_INTERNET_ENVIRONMENT?.trim() || "internal",
      },
    }) as typeof session;
    const work = (async () => {
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
      return models.map((model) => {
        const details = raw.find((entry) => entry.id === model.id);
        return { ...model, meta: { ...model.meta, ...(details ? rawModelDetails(details) : {}) } };
      });
    })();
    // 我方整体超时竞态：到点直接判失败并在 finally 里关闭会话，避免孤儿 CLI 进程挂到 SDK 默认 60s。
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("CodeBuddy 模型目录拉取超时")), MODELS_REQUEST_TIMEOUT_MS);
    });
    return await Promise.race([work, timedOut]);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
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
