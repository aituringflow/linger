import { app, net } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import type { CodexRuntimeState } from "../shared/types";

/**
 * Codex CLI 的按需下载。
 *
 * Codex 的平台包（`@openai/codex-win32-x64` 等）单平台解开就 437MB —— codex.exe 一个
 * 文件 319MB —— 打进安装包会让 NSIS 多压 437MB，安装包从 ~250MB 涨到 512MB。而它只是
 * 「算力提供商」里可选的一项，多数用户从不启用。
 *
 * 所以这里改成：安装包不内置平台包，用户第一次要用 Codex 时再从 npm 镜像把官方 tgz
 * 下到 userData/runtime/codex/<version>/（压缩包约 157MB，解开约 437MB），解压后通过
 * CODEX_CLI_PATH 注入。agent-kit 的 getCodexCliPath() 本来就优先读这个环境变量
 * （packages/agent-kit/src/server/codex-cli.ts），因此运行期代码零改动。
 *
 * 版本号在构建期由 electron.vite.config.ts 注入（__CODEX_CLI_VERSION__），与
 * node_modules/@openai/codex 的版本一致；平台包在 npm 上的版本就是 `<version>-<target>`，
 * 例如 0.162.1-win32-x64。
 */

declare const __CODEX_CLI_VERSION__: string;

/** 构建期注入失败时的兜底（dev 下直接读 node_modules 也能拿到，正常不会走到这里）。 */
const VERSION = typeof __CODEX_CLI_VERSION__ === "string" && __CODEX_CLI_VERSION__ ? __CODEX_CLI_VERSION__ : "0.162.1";

interface Target {
  /** npm 上平台包的版本后缀，也是 tgz 文件名的一部分。 */
  suffix: string;
  /** 压缩包内 vendor 目录名（Rust target triple）。 */
  triple: string;
  executable: string;
}

const TARGETS: Record<string, Target> = {
  "win32-x64": { suffix: "win32-x64", triple: "x86_64-pc-windows-msvc", executable: "codex.exe" },
  "win32-arm64": { suffix: "win32-arm64", triple: "aarch64-pc-windows-msvc", executable: "codex.exe" },
  "darwin-x64": { suffix: "darwin-x64", triple: "x86_64-apple-darwin", executable: "codex" },
  "darwin-arm64": { suffix: "darwin-arm64", triple: "aarch64-apple-darwin", executable: "codex" },
};

/** npmmirror 优先（国内直连），回落到官方源。 */
const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
/** 下载后要解压出等量体积，留一点余量给临时文件。 */
const REQUIRED_FREE_BYTES = 1200 * 1024 * 1024;

function target(): Target | null {
  return TARGETS[`${process.platform}-${process.arch}`] ?? null;
}

function rootDir(): string {
  return path.join(app.getPath("userData"), "runtime", "codex");
}

function installDir(): string {
  return path.join(rootDir(), `${VERSION}-${target()?.suffix ?? "unknown"}`);
}

/** 解压后 codex 可执行文件的绝对路径；未安装时也要能算出来（用于判断是否已装）。 */
export function codexExecutablePath(): string | null {
  const t = target();
  if (!t) return null;
  return path.join(installDir(), "package", "vendor", t.triple, "bin", t.executable);
}

/**
 * 本机可能已装的 codex：Codex 桌面版默认装到 `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`，
 * npm -g / Homebrew / scoop 装的在 PATH 里。用户已经有一份就没必要再下 157MB。
 *
 * 复用规则：**本机版本 ≥ 内置版本**。codex-sdk 与 CLI 之间走 JSON 事件协议，旧版 CLI 会缺
 * 字段、认不出新的 item 类型，所以低于内置版本一律拒绝；同版本或更新则直接复用（用户装得
 * 更勤就不必再占 437MB 磁盘）。万一新版协议有破坏性变更，报错会显示在设置面板的 title 上，
 * 用户可以手动删掉本机那份或设置 CODEX_CLI_PATH 指定版本。
 */
function localCandidates(): string[] {
  const dirs: string[] = [];
  if (process.platform === "win32") {
    // Codex 桌面版的安装位置（不受 PATH 影响，最容易被漏掉）。
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) dirs.push(path.join(localAppData, "Programs", "OpenAI", "Codex", "bin"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin"));
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir.trim()) dirs.push(dir.trim());
  }
  const names = process.platform === "win32" ? ["codex.exe"] : ["codex"];
  const seen = new Set<string>();
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      // 只认真正的可执行文件：npm 的 codex.cmd 走 shell 才能起，这里不要。
      try {
        if (!fs.statSync(candidate).isFile()) continue;
      } catch { continue; }
      found.push(candidate);
    }
  }
  return found;
}

/** 读 `codex --version`（输出形如 `codex-cli 0.162.1`）；起不来或超时返回 null。 */
function probeVersion(executable: string): string | null {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
    // 探测不该触发登录态检查或网络请求，顺手屏蔽掉子进程里用不到的东西。
    env: { ...process.env },
  });
  if (result.error || result.status !== 0) return null;
  const match = `${result.stdout ?? ""}${result.stderr ?? ""}`.match(/codex-cli\s+v?([0-9][^\s]*)/i);
  return match ? match[1] : null;
}

/**
 * 语义化版本比较（够用即可）：只比较数字核心，缺位按 0 补；带预发布后缀（1.2.3-beta.1）
 * 的视为低于同核心的正式版。返回 <0 / 0 / >0。
 */
function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre = ""] = v.trim().replace(/^v/i, "").split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < Math.max(left.nums.length, right.nums.length); i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // 核心相同：有预发布后缀的那个更小（0.163.0-beta < 0.163.0）。
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

/**
 * 找到并确认可用时返回路径与版本：本机版本 ≥ 内置版本才复用，低于内置版本回落到下载
 * （老 CLI 缺协议字段，跑起来会以很难查的方式失败）。
 */
function discoverLocalCodex(): { path: string; version: string } | null {
  // 用户显式指定过 CODEX_CLI_PATH：尊重选择，与 agent-kit 的 getCodexCliPath() 保持一致。
  const explicit = process.env.CODEX_CLI_PATH?.trim();
  if (explicit && explicit !== codexExecutablePath() && fs.existsSync(explicit)) {
    return { path: explicit, version: probeVersion(explicit) ?? "" };
  }
  for (const candidate of localCandidates()) {
    if (candidate === codexExecutablePath()) continue;
    const version = probeVersion(candidate);
    if (!version) continue;
    const diff = compareVersions(version, VERSION);
    if (diff >= 0) {
      if (diff > 0) {
        console.log(`[launcher] 复用本机 Codex ${version}（内置 ${VERSION}，按「不低于内置」规则放行）：${candidate}`);
      }
      return { path: candidate, version };
    }
    console.log(`[launcher] 跳过本机 Codex ${version}（低于内置 ${VERSION}）：${candidate}`);
  }
  return null;
}

let state: CodexRuntimeState = {
  installed: false,
  version: VERSION,
  downloading: false,
  downloaded: 0,
  total: 0,
};
const listeners = new Set<(next: CodexRuntimeState) => void>();

function publish(patch: Partial<CodexRuntimeState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) {
    try { listener(state); } catch { /* 渲染层已销毁 */ }
  }
}

export function onCodexRuntimeState(listener: (next: CodexRuntimeState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function codexRuntimeState(): CodexRuntimeState {
  return state;
}

/**
 * 启动时调用（async，最多几百毫秒：只可能起一次 `codex --version`）：
 * 1. 我们自己下载过 → 直接用，注入 CODEX_CLI_PATH；
 * 2. 本机已装同版本 codex → 复用，同样注入（省掉 157MB 下载与 437MB 磁盘）；
 * 3. 都没有 → 什么都不做，**绝不**在启动阶段自动下载。
 */
export async function bootstrapCodexRuntime(): Promise<void> {
  const managed = codexExecutablePath();
  const managedReady = Boolean(managed && fs.existsSync(managed));
  if (managedReady && managed) {
    process.env.CODEX_CLI_PATH = managed;
    publish({ installed: true, source: "download" });
    console.log(`[launcher] Codex CLI 已就绪（下载版）：${managed}`);
  } else {
    const local = discoverLocalCodex();
    if (local) {
      process.env.CODEX_CLI_PATH = local.path;
      // 报本机真实版本：本机若比内置新，面板上要显示实际在跑的那个版本。
      publish({ installed: true, source: "local", version: local.version || VERSION });
      console.log(`[launcher] Codex CLI 复用本机安装：${local.path}`);
    } else {
      publish({ installed: false, source: undefined, version: VERSION });
    }
  }
  // 上次退出时可能留下半截 .install-* 目录（下载中关掉 app）：启动顺手清掉，别白占空间。
  try {
    for (const entry of fs.readdirSync(rootDir())) {
      if (entry.startsWith(".install-")) fs.rmSync(path.join(rootDir(), entry), { recursive: true, force: true });
    }
  } catch { /* 目录还不存在 */ }
}

let installing: Promise<{ ok: boolean; error?: string }> | null = null;

/** 下载并安装 Codex 平台包；并发调用合并成一次。 */
export function installCodexRuntime(): Promise<{ ok: boolean; error?: string }> {
  if (installing) return installing;
  const task = runInstall().finally(() => { installing = null; });
  installing = task;
  return task;
}

async function runInstall(): Promise<{ ok: boolean; error?: string }> {
  const t = target();
  if (!t) return { ok: false, error: `当前平台不支持 Codex：${process.platform}-${process.arch}` };
  const executable = codexExecutablePath()!;
  if (fs.existsSync(executable)) {
    process.env.CODEX_CLI_PATH = executable;
    publish({ installed: true, source: "download", version: VERSION, downloading: false, downloaded: state.total, total: state.total });
    return { ok: true };
  }
  const tar = tarCommand();
  if (!tar) return { ok: false, error: "系统缺少 tar，无法解压 Codex 组件（Windows 需 Win10 1803 及以上）" };

  const free = await freeBytes(rootDir());
  if (free !== null && free < REQUIRED_FREE_BYTES) {
    return { ok: false, error: `磁盘空间不足（需约 1.2GB，当前可用 ${(free / 1024 / 1024 / 1024).toFixed(1)}GB）` };
  }

  const staged = path.join(rootDir(), `.install-${Date.now().toString(36)}`);
  publish({ downloading: true, downloaded: 0, total: 0, error: undefined });
  try {
    fs.mkdirSync(staged, { recursive: true });
    const archive = path.join(staged, "codex.tgz");
    await download(t, archive);
    await extract(tar, archive, staged);
    fs.rmSync(archive, { force: true });
    const extracted = path.join(staged, "package", "vendor", t.triple, "bin", t.executable);
    if (!fs.existsSync(extracted)) throw new Error("下载的组件包结构异常（缺少 codex 可执行文件）");
    if (process.platform !== "win32") fs.chmodSync(extracted, 0o755);
    // 同卷 rename：要么完全装好，要么完全没装，不会留半截目录骗过下次启动的检查。
    fs.mkdirSync(path.dirname(installDir()), { recursive: true });
    fs.rmSync(installDir(), { recursive: true, force: true });
    fs.renameSync(staged, installDir());
    // 升级后旧版本的 437MB 没有保留价值：只留当前版本，避免每升一次就多占一份。
    try {
      const keep = path.basename(installDir());
      for (const entry of fs.readdirSync(rootDir())) {
        if (entry !== keep && entry.endsWith(`-${t.suffix}`)) {
          fs.rmSync(path.join(rootDir(), entry), { recursive: true, force: true });
        }
      }
    } catch { /* 清理失败不影响已安装的这份 */ }
    process.env.CODEX_CLI_PATH = executable;
    publish({ installed: true, source: "download", version: VERSION, downloading: false, downloaded: state.total, total: state.total, error: undefined });
    console.log(`[launcher] Codex CLI 安装完成：${executable}`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fs.rmSync(staged, { recursive: true, force: true });
    publish({ downloading: false, error: message });
    return { ok: false, error: message };
  }
}

async function download(t: Target, destination: string): Promise<void> {
  const failures: string[] = [];
  for (const registry of REGISTRIES) {
    const url = `${registry}/@openai/codex/-/codex-${VERSION}-${t.suffix}.tgz`;
    try {
      await downloadFrom(url, destination);
      return;
    } catch (error) {
      failures.push(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Codex 组件下载失败（${failures.join("；")}）`);
}

async function downloadFrom(url: string, destination: string): Promise<void> {
  // 用 Electron 的 net.fetch 而不是全局 fetch：它走 Chromium 网络栈，会遵守系统代理设置，
  // 公司网络里只有代理能出网时也能下载（Node 的 fetch 不认系统代理）。
  const response = await net.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  publish({ downloading: true, downloaded: 0, total });
  const file = fs.createWriteStream(destination);
  let downloaded = 0;
  let lastReportAt = 0;
  let lastReported = 0;
  const step = total > 0 ? Math.max(total / 100, 1024 * 1024) : 1024 * 1024;
  try {
    for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)) {
      if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", resolve));
      downloaded += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk as Uint8Array);
      // 每 1% 或 500ms 推一次进度：437MB 有上万个 chunk，全推会把 IPC 打满。
      const now = Date.now();
      if (now - lastReportAt > 500 || downloaded - lastReported >= step) {
        lastReportAt = now;
        lastReported = downloaded;
        publish({ downloaded, total: total || downloaded });
      }
    }
    await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())));
  } catch (error) {
    file.destroy();
    await fs.promises.rm(destination, { force: true });
    throw error;
  }
  publish({ downloaded, total: total || downloaded });
}

function tarCommand(): string | null {
  if (process.platform === "win32") {
    const candidate = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    return fs.existsSync(candidate) ? candidate : null;
  }
  return fs.existsSync("/usr/bin/tar") ? "/usr/bin/tar" : null;
}

function extract(tar: string, archive: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ["-xzf", archive, "-C", destination], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.once("error", (error) => reject(new Error(`解压失败：${error.message}`)));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压失败（tar 退出码 ${code}）${stderr ? `：${stderr.trim()}` : ""}`));
    });
  });
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    // statfs 在 Node 18.15+ 可用；拿不到就不拦（宁可让下载去失败，也不要误报空间不足）。
    const stats = await (fs.promises as typeof fs.promises & { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs?.(nearestExisting(dir));
    if (!stats) return null;
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

/** statfs 要求路径存在；userData 一定存在，但 runtime/codex 可能还没建。 */
function nearestExisting(dir: string): string {
  let current = dir;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
