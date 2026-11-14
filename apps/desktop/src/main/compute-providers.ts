import { getCodexCliPath, getWorkBuddyAuthStatus, loginWorkBuddy, logoutWorkBuddy } from "@turingflow/agent-kit";
import { readDshKey } from "./dsh-credentials.js";
import { verifyDshKey } from "./dsh-auth.js";
import { codexRuntimeState } from "./codex-runtime.js";
import { spawn } from "node:child_process";
import type { ComputeProviderId, LauncherComputeProvider } from "../shared/types";

/**
 * 系统设置 →「算力提供商」的主进程状态。
 *
 * WorkBuddy 由 SDK 探测，Codex 由其 CLI 的 login status 探测；不读凭据文件、也不落盘。
 * 探测一次要拉一个 CLI 子进程（最坏 10s），所以这里做 20s 内存缓存 + 首次请求合并，
 * 让设置面板反复开合不会把 CLI 拉起来一串。
 *
 */
const STATUS_TTL_MS = 20_000;

let cache: { at: number; providers: LauncherComputeProvider[] } | null = null;
let inFlight: { generation: number; promise: Promise<LauncherComputeProvider[]> } | null = null;
let generation = 0;
const loginInFlight = new Map<ComputeProviderId, Promise<{ ok: boolean; error?: string }>>();

function runCodex(args: string[], timeoutMs = 10_000): Promise<{ code: number; output: string }> {
  let executable: string;
  try { executable = getCodexCliPath(); }
  catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => { child.kill(); reject(new Error("Codex 操作超时")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, output: output.trim() }); });
  });
}

async function codexStatus(): Promise<LauncherComputeProvider> {
  // 平台包不打进安装包（437MB）：没下载就谈不上登录态，直接告诉面板去下载。
  const runtime = codexRuntimeState();
  if (!runtime.installed) {
    return {
      id: "codex",
      name: "Codex",
      available: false,
      authenticated: false,
      error: runtime.error
        ?? (runtime.downloading ? "Codex 组件正在下载，完成后会自动可用" : "Codex 组件未下载，点击图标下载（约 160 MB）"),
    };
  }
  try {
    const result = await runCodex(["login", "status"]);
    return { id: "codex", name: "Codex", available: true, authenticated: result.code === 0,
      accountName: result.code === 0 ? result.output.replace(/^Logged in using\s*/i, "") || undefined : undefined,
      error: result.code === 0 ? undefined : result.output || undefined };
  } catch (error) {
    return { id: "codex", name: "Codex", available: false, authenticated: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function dshStatus(): Promise<LauncherComputeProvider> {
  const key = readDshKey();
  const base = { id: "dsh" as const, name: "DeepSeek Harness", available: true, configured: Boolean(key) };
  if (!key) return { ...base, authenticated: false };
  return { ...base, ...await verifyDshKey(key) };
}

/** 立即丢掉缓存：登录 / 登出 / 窗口重新聚焦后调用，下一次读一定重新探测。 */
export function invalidateComputeProviders(): void {
  cache = null;
  generation++;
}

/** 当前各提供商状态（refresh=true 强制重新探测）。 */
export async function listComputeProviders(refresh = false): Promise<LauncherComputeProvider[]> {
  if (!refresh && cache && Date.now() - cache.at < STATUS_TTL_MS) return cache.providers;
  if (inFlight?.generation === generation) return inFlight.promise;
  const currentGeneration = generation;
  const promise = (async () => {
    const codexPromise = codexStatus();
    const dshPromise = dshStatus();
    let workbuddy: LauncherComputeProvider;
    try {
      const status = await getWorkBuddyAuthStatus();
      workbuddy = {
        id: "workbuddy",
        name: "WorkBuddy",
        available: true,
        authenticated: status.authenticated,
        accountName: status.account?.name || undefined,
      };
    } catch (error) {
      // 探测本身失败（CLI 缺失 / 环境异常）按未登录呈现，并把原因带回去方便排查。
      workbuddy = {
        id: "workbuddy",
        name: "WorkBuddy",
        available: true,
        authenticated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const providers: LauncherComputeProvider[] = [workbuddy, await codexPromise, await dshPromise];
    if (generation === currentGeneration) cache = { at: Date.now(), providers };
    return providers;
  })().finally(() => { if (inFlight?.generation === currentGeneration) inFlight = null; });
  inFlight = { generation: currentGeneration, promise };
  return promise;
}

/**
 * 发起 WorkBuddy 登录。onAuthUrl 由调用方接到系统浏览器（shell.openExternal）。
 * 并发点击只跑一次：SDK 的授权流程是有状态的，同时开两个会互相踩。
 */
export function loginComputeProvider(
  id: ComputeProviderId,
  onAuthUrl: (url: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  const existing = loginInFlight.get(id);
  if (existing) return existing;
  const pending = (async () => {
    const result = id === "workbuddy"
      ? await loginWorkBuddy({ onAuthUrl, timeoutMs: 180_000 })
      : await runCodex(["login"], 180_000).then(({ code, output }) => ({ ok: code === 0, error: code === 0 ? undefined : output || "Codex 登录失败" })).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    invalidateComputeProviders();
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  })().finally(() => { loginInFlight.delete(id); });
  loginInFlight.set(id, pending);
  return pending;
}

/** 退出对应 CLI 的登录。 */
export async function logoutComputeProvider(id: ComputeProviderId): Promise<{ ok: boolean; error?: string }> {
  const result = id === "workbuddy" ? await logoutWorkBuddy()
    : await runCodex(["logout"]).then(({ code, output }) => ({ ok: code === 0, error: code === 0 ? undefined : output || "Codex 登出失败" })).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  invalidateComputeProviders();
  return result;
}
