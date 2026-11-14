import { app, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";

/**
 * LibreOfficeKit 引擎的按需下载。
 *
 * dsh 的 office 能力（`dsh-skill-office` / `dsh-office-to-pdf`）靠
 * `@deepseek-ai/libreoffice-kit-<platform>` 把 Word/Excel/PPT 转成 PDF 再渲染预览。
 * 这个平台包在 Windows 上解开是 184MB / 735 个文件（一份裁剪过的 LibreOffice），
 * 打进安装包就是 NSIS 多压 184MB、安装包里多出 735 次文件写入，而它只在用户真的
 * 打开 Office 文档时才需要。
 *
 * 所以改成：安装包不内置，运行时下到
 *   <userData>/runtime/libreoffice/<version>-<target>/node_modules/@deepseek-ai/libreoffice-kit-<target>
 * 再把它的 `node_modules` 目录塞进 **NODE_PATH** 交给 dsh 子进程。
 *
 * 为什么是 NODE_PATH 而不是改调用方：libreoffice-kit 内部用
 * `createRequire(import.meta.url).resolve("@deepseek-ai/libreoffice-kit-win32-x64/package.json")`
 * 找引擎（node_modules/@deepseek-ai/libreoffice-kit/lib/index.js 的 resolveEngine()），
 * 解析链固定在 asar 内部，插件代码不在我们手里。CJS 的 `require.resolve` 会追加
 * `Module.globalPaths`（即 NODE_PATH 展开后的目录），所以只要让 dsh 子进程带上
 * NODE_PATH，解析就能落到下载目录，其余路径（prebuilds.json、program 目录、exe）
 * 全部由 package.json 派生，不需要额外处理。
 *
 * 触发时机：dsh 子进程里那次 require 是同步的，没法懒加载，因此主进程在窗口起来
 * 之后延迟一段时间静默补齐（不弹窗、不阻塞 UI、失败下次启动再试）。
 */

declare const __LIBREOFFICE_KIT_VERSION__: string;

/** 构建期注入失败时的兜底（dev 下正常也能读到 node_modules 里的版本）。 */
const VERSION =
  typeof __LIBREOFFICE_KIT_VERSION__ === "string" && __LIBREOFFICE_KIT_VERSION__
    ? __LIBREOFFICE_KIT_VERSION__
    : "0.1.5";

const SCOPE = "@deepseek-ai";
const BASE_NAME = "libreoffice-kit";

/** 引擎包名后缀：与 libreoffice-kit 的 ENGINE_VERSIONS 表保持一致。 */
const TARGETS: Record<string, string> = {
  "win32-x64": "win32-x64",
  "win32-arm64": "win32-arm64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
};

/** npmmirror 优先（国内直连），回落到官方源。 */
const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];
/** 下载的 tgz 约 90MB，解开 184MB，留足临时空间。 */
const REQUIRED_FREE_BYTES = 700 * 1024 * 1024;
/** 首次启动后静默补齐的延迟：让窗口先完成加载，别和首屏抢带宽/磁盘。 */
const IDLE_DELAY_MS = 60_000;

function target(): string | null {
  return TARGETS[`${process.platform}-${process.arch}`] ?? null;
}

function packageName(t = target()): string | null {
  return t ? `${SCOPE}/${BASE_NAME}-${t}` : null;
}

function rootDir(): string {
  return path.join(app.getPath("userData"), "runtime", "libreoffice");
}

/** 该版本+平台的安装根目录；其下就是标准的 node_modules 布局。 */
function installDir(): string {
  return path.join(rootDir(), `${VERSION}-${target() ?? "unknown"}`);
}

/** 引擎包目录（npm tgz 里的 `package/` 解到这里）。 */
function packageDir(): string {
  const t = target();
  if (!t) return "";
  return path.join(installDir(), "node_modules", SCOPE, `${BASE_NAME}-${t}`);
}

/** 注入给子进程的 NODE_PATH 目录。 */
export function libreOfficeNodePath(): string | null {
  if (!target()) return null;
  return path.join(installDir(), "node_modules");
}

export function isLibreOfficeRuntimeInstalled(): boolean {
  const dir = packageDir();
  if (!dir) return false;
  // prebuilds.json 是引擎清单，libreoffice-kit 找不到它就判定为「装了一半」。
  return fs.existsSync(path.join(dir, "prebuilds.json")) && fs.existsSync(path.join(dir, "package.json"));
}

/**
 * 把已安装的目录挂进 NODE_PATH。
 *
 * 注意不能覆盖用户/环境的既有值：dsh 子进程可能还依赖别的 NODE_PATH 条目
 * （例如用户自己装的全局包）。追加在末尾即可，CJS 解析按顺序命中。
 *
 * 只写 env、不动主进程的 Module.globalPaths：真正加载引擎的是 dsh 子进程
 * （DeepSeekHarness spawn 出来的 ELECTRON_RUN_AS_NODE 进程），它从 env 读 NODE_PATH；
 * 主进程自身不 import libreoffice-kit，没必要把内部 API 也拖进来。
 */
function exposeOnNodePath(): void {
  const dir = libreOfficeNodePath();
  if (!dir) return;
  const current = process.env.NODE_PATH?.trim();
  if (!current) {
    process.env.NODE_PATH = dir;
    return;
  }
  if (!current.split(path.delimiter).includes(dir)) {
    process.env.NODE_PATH = `${current}${path.delimiter}${dir}`;
  }
}

/**
 * 启动时调用（同步、极快）：已装就直接挂 NODE_PATH；没装就什么都不做，
 * 由 scheduleLibreOfficeRuntime() 在窗口空闲后静默补齐。
 */
export function bootstrapLibreOfficeRuntime(): void {
  if (isLibreOfficeRuntimeInstalled()) {
    exposeOnNodePath();
    console.log(`[launcher] LibreOfficeKit 已就绪：${packageDir()}`);
    return;
  }
  console.log("[launcher] LibreOfficeKit 未安装（office→PDF 预览将在组件下载完成后可用）");
}

let scheduled = false;

/**
 * 窗口出来之后延迟补齐（只跑一次，进程内）。
 * 失败不打扰用户：写日志，下次启动重试；真在下载完成前打开 Office 文档时，
 * dsh 侧会报「Required LibreOfficeKit native package is missing」，重试即可。
 */
export function scheduleLibreOfficeRuntime(delayMs = IDLE_DELAY_MS): void {
  if (scheduled || isLibreOfficeRuntimeInstalled() || !target()) return;
  scheduled = true;
  const timer = setTimeout(() => {
    timer.unref?.();
    void installLibreOfficeRuntime().then((result) => {
      if (result.ok) {
        exposeOnNodePath();
        console.log(`[launcher] LibreOfficeKit 安装完成：${packageDir()}`);
      } else if (result.error) {
        console.warn(`[launcher] LibreOfficeKit 下载失败（下次启动重试）：${result.error}`);
      }
    });
  }, delayMs);
  timer.unref?.();
}

let installing: Promise<{ ok: boolean; error?: string }> | null = null;

/** 下载并安装引擎包；并发调用合并成一次。 */
export function installLibreOfficeRuntime(): Promise<{ ok: boolean; error?: string }> {
  if (installing) return installing;
  const task = runInstall().finally(() => { installing = null; });
  installing = task;
  return task;
}

async function runInstall(): Promise<{ ok: boolean; error?: string }> {
  const t = target();
  const name = packageName(t);
  if (!t || !name) return { ok: false, error: `当前平台不支持 office 转换：${process.platform}-${process.arch}` };
  if (isLibreOfficeRuntimeInstalled()) {
    exposeOnNodePath();
    return { ok: true };
  }
  const tar = tarCommand();
  if (!tar) return { ok: false, error: "系统缺少 tar，无法解压 office 组件（Windows 需 Win10 1803 及以上）" };

  const free = await freeBytes(rootDir());
  if (free !== null && free < REQUIRED_FREE_BYTES) {
    return { ok: false, error: `磁盘空间不足（需约 700MB，当前可用 ${(free / 1024 / 1024 / 1024).toFixed(1)}GB）` };
  }

  const staged = path.join(rootDir(), `.install-${Date.now().toString(36)}`);
  try {
    fs.mkdirSync(staged, { recursive: true });
    const archive = path.join(staged, `${BASE_NAME}-${t}.tgz`);
    await download(name, t, archive);
    await extract(tar, archive, staged);
    fs.rmSync(archive, { force: true });

    const extracted = path.join(staged, "package");
    if (!fs.existsSync(path.join(extracted, "prebuilds.json"))) {
      throw new Error("下载的组件包结构异常（缺少 prebuilds.json）");
    }
    // 换成 npm 的 node_modules 布局，好让 require.resolve 认得。
    const relocated = path.join(staged, "node_modules", SCOPE, `${BASE_NAME}-${t}`);
    fs.mkdirSync(path.dirname(relocated), { recursive: true });
    fs.renameSync(extracted, relocated);

    // 同卷 rename：要么完全装好，要么完全没装，不会留半截目录骗过下次启动。
    fs.mkdirSync(path.dirname(installDir()), { recursive: true });
    fs.rmSync(installDir(), { recursive: true, force: true });
    fs.renameSync(staged, installDir());

    // 只留当前版本/平台，避免每次升级多占一份 184MB。
    try {
      const keep = path.basename(installDir());
      for (const entry of fs.readdirSync(rootDir())) {
        if (entry !== keep && !entry.startsWith(".install-")) {
          fs.rmSync(path.join(rootDir(), entry), { recursive: true, force: true });
        }
      }
    } catch { /* 清理失败不影响已装的这份 */ }

    exposeOnNodePath();
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fs.rmSync(staged, { recursive: true, force: true });
    return { ok: false, error: message };
  }
}

async function download(name: string, t: string, destination: string): Promise<void> {
  const fileName = `${BASE_NAME}-${t}-${VERSION}.tgz`;
  const failures: string[] = [];
  for (const registry of REGISTRIES) {
    const url = `${registry}/${name}/-/${fileName}`;
    try {
      await downloadFrom(url, destination);
      return;
    } catch (error) {
      failures.push(`${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`office 组件下载失败（${failures.join("；")}）`);
}

async function downloadFrom(url: string, destination: string): Promise<void> {
  // net.fetch 走 Chromium 网络栈，会遵守系统代理（公司网络只有代理能出网时也能下）。
  const response = await net.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const file = fs.createWriteStream(destination);
  try {
    for await (const chunk of Readable.fromWeb(response.body as import("node:stream/web").ReadableStream)) {
      if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", resolve));
    }
    await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => (error ? reject(error) : resolve())));
  } catch (error) {
    file.destroy();
    await fs.promises.rm(destination, { force: true });
    throw error;
  }
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
    const stats = await (fs.promises as typeof fs.promises & { statfs?: (p: string) => Promise<{ bavail: number; bsize: number }> }).statfs?.(nearestExisting(dir));
    if (!stats) return null;
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

function nearestExisting(dir: string): string {
  let current = dir;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}
