/**
 * deployment-health · 部署期组件健康检查与安装
 *
 * 回答「npm install 之后，这台机器上还有哪些组件没就位」：
 * 逐项探测部署期需要的系统组件 / 原生模块 / 浏览器二进制 / 凭据 / 配置，
 * 并允许管理员在管理控制台直接触发"可自动安装"组件的安装（后台任务 + 日志轮询）。
 *
 * 组件清单（与 deploy/DEPENDENCIES.md 对齐）：
 *   1. node        —— 运行时（Next 16 要求 ≥ 20.9）
 *   2. npm         —— 随 Node 分发，缺失时不可自愈
 *   3. docker      —— 群容器 / Web 终端（dockerode + docker CLI，Dockerfile.group 在运行时构建镜像）
 *   4. playwright  —— 链接预览 / 正文抓取 / 浏览器 agent 共用的 Chromium 二进制
 *   5. fonts-cjk   —— 系统中文字体（PDF 页图渲染 + 中文页面渲染）
 *   6. canvas      —— @napi-rs/canvas 平台二进制（N-API 原生模块，lockfile 跨平台易缺）
 *   7. rollup-esbuild —— 构建期 Linux 原生包（Vite / electron-vite 打包需要，restart.sh 已固化补装）
 *   8. postgres    —— PostgreSQL 实例（auth=builtin 时的登录/会话/用量落库）
 *   9. codebuddy   —— ~/.codebuddy 登录凭据（默认对话通道）
 *  10. codex       —— 可选：Codex 模式需 codex CLI（PATH 或 CODEX_CLI_PATH）
 *  11. web-push    —— 配置项：VAPID 密钥（浏览器离线通知）
 *  12. asr         —— 配置项（可选）：语音转写 ASR_HOST / ASR_API_KEY
 *
 * 安全：安装动作只允许白名单组件 id；命令参数全部来自本模块静态定义，
 * 不接受任何用户输入拼装；接口全部要求 admin 登录 Cookie（verifyAdmin）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import Dockerode from "dockerode";
import { Client } from "pg";
import { verifyAdmin } from "./sessions.js";

// 用 nodeRequire 而非 require 命名：webpack 会把裸名 `require` 当成模块解析入口，
// 遇到 `${pkg}/package.json` 这种动态参数就报 "Can't resolve <dynamic>"。
// 解析基点落在 monorepo 根（含 node_modules），运行时才能正确读到已装包版本。
const nodeRequire = createRequire(path.join(findWorkspaceRoot(), "package.json"));

/** Windows 下 spawn 需要显式 .cmd 后缀，否则找不到可执行文件。 */
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

/* ── 工具 ─────────────────────────────────────────────────────────── */

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

function timeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** 运行一条命令，收集 stdout/stderr，超时/失败返回 null（绝不抛出）。
 *  Windows 下 Node 直接 spawn .cmd/.bat 会抛 EINVAL，需经 shell（cmd.exe）执行。 */
function run(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });
    let output = "";
    let settled = false;
    const cap = 200 * 1024;
    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    };
    const timer = setTimeout(() => {
      child.kill();
      done(-1);
    }, opts.timeoutMs ?? 15_000);
    child.stdout!.on("data", (chunk) => { output += String(chunk); if (output.length > cap) { child.kill(); done(-1); } });
    child.stderr!.on("data", (chunk) => { output += String(chunk); if (output.length > cap) { child.kill(); done(-1); } });
    child.on("error", () => done(-1));
    child.on("close", (code) => done(code));
  });
}

/** 定位 monorepo 根目录（npm install 的 cwd）：从本文件向上找含 node_modules 的目录。 */
function findWorkspaceRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "node_modules")) && existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const workspaceRoot = findWorkspaceRoot();

/** 读取已安装 npm 包的版本号，读不到返回空串。 */
function pkgVersion(pkg: string): string {
  try { return (nodeRequire(`${pkg}/package.json`) as { version?: string }).version ?? ""; }
  catch { return ""; }
}

const PLATFORM_CANVAS_PACKAGE: Record<string, string> = {
  "win32-x64": "canvas-win32-x64-msvc",
  "win32-arm64": "canvas-win32-arm64-msvc",
  "linux-x64": "canvas-linux-x64-gnu",
  "linux-arm64": "canvas-linux-arm64-gnu",
  "darwin-x64": "canvas-darwin-x64",
  "darwin-arm64": "canvas-darwin-arm64",
};

function canvasPlatformPackage(): string {
  return PLATFORM_CANVAS_PACKAGE[`${process.platform}-${process.arch}`] ?? "";
}

function inPath(binary: string): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

/** Docker CLI 探测（与 group-container.ts 同一套候选逻辑）。 */
function dockerCliPath(): string {
  const configured = process.env.GROUP_DOCKER_CLI_PATH?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Docker", "Docker", "resources", "bin", "docker.exe"),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
    ];
    const installed = candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate));
    if (installed) return installed;
  }
  return inPath(process.platform === "win32" ? "docker.exe" : "docker") || "docker";
}

async function dockerDaemonOk(): Promise<boolean> {
  try {
    const host = process.env.DOCKER_HOST;
    const client = host?.startsWith("tcp://")
      ? new Dockerode({ host: new URL(host).hostname, port: Number(new URL(host).port || 2375) })
      : new Dockerode({ socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock" });
    await timeout(client.ping(), 5_000, null);
    return true;
  } catch {
    return false;
  }
}

/* ── 状态类型 ─────────────────────────────────────────────────────── */

export type ComponentStatus = "ok" | "missing" | "warn" | "disabled" | "n/a";
export type ComponentCategory =
  | "runtime" | "infra" | "browser" | "native" | "auth" | "config" | "build";

export interface ComponentReport {
  id: string;
  name: string;
  category: ComponentCategory;
  categoryLabel: string;
  status: ComponentStatus;
  statusLabel: string;
  detail: string;
  version?: string;
  required: string;
  installable: boolean;
  /** true=有可自动执行的安装命令；false=仅提供安装指引。 */
  autoInstallable: boolean;
  installHint: string;
  guidance?: string;
  checkedAt: string;
}

/* ── 安装任务 ─────────────────────────────────────────────────────── */

export interface InstallJob {
  id: string;
  componentId: string;
  componentName: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  log: string;
}

const jobs = new Map<string, InstallJob>();
const runningByComponent = new Map<string, string>(); // componentId -> jobId

/** 启动一个安装任务（白名单组件），同一组件同时只允许一个任务。 */
function startInstall(componentId: string): { job?: InstallJob; error?: string } {
  if (runningByComponent.has(componentId)) {
    return { error: "该组件已有安装任务在进行中" };
  }
  const plan = INSTALL_PLANS[componentId];
  if (!plan) return { error: "未知组件，无法安装" };
  const job: InstallJob = {
    id: randomUUID(),
    componentId,
    componentName: plan.name,
    state: "running",
    startedAt: Date.now(),
    exitCode: null,
    log: "",
  };
  jobs.set(job.id, job);
  runningByComponent.set(componentId, job.id);
  const append = (text: string) => {
    job.log += text;
    if (job.log.length > 200_000) job.log = job.log.slice(job.log.length - 200_000);
  };
  const finish = (code: number | null) => {
    job.exitCode = code;
    job.state = code === 0 ? "done" : "failed";
    job.finishedAt = Date.now();
    runningByComponent.delete(componentId);
    append(`\n[完成] 退出码 ${code}${code === 0 ? "" : " —— 请查看上方日志定位原因"}\n`);
  };

  // 纯指引型：没有要执行的命令，直接完成并给出指引文本。
  if (!plan.commands?.length) {
    append(`[指引] ${plan.guidance ?? "该组件无法从命令行自动安装，请按上方指引手动处理。"}\n`);
    queueMicrotask(() => finish(0));
    return { job };
  }

  append(`[开始] 安装 ${plan.name}（cwd=${plan.cwd ?? workspaceRoot}）\n`);
  let index = 0;
  const next = () => {
    if (index >= plan.commands!.length) { finish(0); return; }
    const step = plan.commands![index++];
    append(`\n$ ${step.command} ${step.args.join(" ")}\n`);
    const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(step.command);
    const child = spawn(step.command, step.args, {
      cwd: step.cwd ?? plan.cwd ?? workspaceRoot,
      env: { ...process.env, ...(step.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell,
    });
    const timer = setTimeout(() => { child.kill(); append("\n[超时] 该步骤超过时限被终止\n"); finish(-1); }, step.timeoutMs ?? 600_000);
    const onChunk = (chunk: Buffer) => append(String(chunk));
    child.stdout!.on("data", onChunk);
    child.stderr!.on("data", onChunk);
    child.on("error", (error) => {
      clearTimeout(timer);
      append(`\n[失败] 无法启动进程：${error.message}\n`);
      finish(-1);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      append(`\n[步骤完成] 退出码 ${code}\n`);
      if (code !== 0) { finish(code); return; }
      next();
    });
  };
  next();
  return { job };
}

interface InstallStep {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

interface InstallPlan {
  name: string;
  commands?: InstallStep[];
  guidance?: string;
  /** 命令默认工作目录（缺省为 monorepo 根）。 */
  cwd?: string;
}

const INSTALL_PLANS: Record<string, InstallPlan> = {
  node: {
    name: "Node.js",
    guidance: "无法从命令行自升级当前 Node。请使用 nvm / fnm / 官方安装包安装 Node ≥ 20.9，然后重启服务进程。",
  },
  npm: {
    name: "npm",
    guidance: "npm 随 Node.js 一起分发。Node 在但 npm 缺失时，重装 Node 官方安装包即可恢复。",
  },
  docker: {
    name: "Docker",
    commands:
      process.platform === "linux"
        ? [
            { command: "bash", args: ["-c", "apt-get update && apt-get install -y docker.io && (systemctl enable --now docker || service docker start || true)"], timeoutMs: 600_000 },
          ]
        : [],
    guidance:
      process.platform === "win32"
        ? "Windows 请安装 Docker Desktop（https://www.docker.com/products/docker-desktop/），安装后启动并保持运行。\n检测到 Docker Desktop 后请确认 Settings → General → 'Use the WSL 2 based engine' 已开启。"
        : "macOS 请安装 Docker Desktop（https://www.docker.com/products/docker-desktop/）并启动。",
  },
  playwright: {
    name: "Playwright Chromium",
    commands: [
      { command: NPX, args: ["--no-install", "playwright", "install", "chromium"], timeoutMs: 900_000 },
      ...(process.platform === "linux"
        ? [{ command: "bash", args: ["-c", "npx --no-install playwright install-deps chromium || true"], timeoutMs: 600_000 }]
        : []),
    ],
  },
  "fonts-cjk": {
    name: "系统中文字体",
    commands:
      process.platform === "linux"
        ? [{ command: "bash", args: ["-c", "apt-get update && apt-get install -y fonts-noto-cjk"], timeoutMs: 600_000 }]
        : [],
    guidance:
      process.platform === "win32"
        ? "Windows 自带微软雅黑（msyh.ttc），一般无需安装。若检测不到，请手动安装中文字体（如思源黑体）后刷新。"
        : "macOS 自带苹方（PingFang.ttc），一般无需安装。若检测不到，请安装中文字体后刷新。",
  },
  canvas: {
    name: "@napi-rs/canvas 平台二进制",
    commands: (() => {
      const pkg = canvasPlatformPackage();
      const version = pkgVersion("@napi-rs/canvas") || "0.1.100";
      return pkg
        ? [{ command: NPM, args: ["install", "--no-save", "--force", `${pkg}@${version}`], timeoutMs: 600_000 }]
        : [];
    })(),
    guidance: "当前平台（" + `${process.platform}-${process.arch}` + "）没有对应的 canvas 预编译包，需要从源码编译：apt-get install -y build-essential pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev && npm rebuild @napi-rs/canvas",
  },
  "rollup-esbuild": {
    name: "rollup / esbuild Linux 原生包",
    commands: (() => {
      const rollupVer = pkgVersion("rollup");
      const esbuildVer = pkgVersion("esbuild");
      const args = ["install", "--no-save", "--force"];
      if (rollupVer) args.push(`@rollup/rollup-linux-x64-gnu@${rollupVer}`);
      if (esbuildVer) args.push(`@esbuild/linux-x64@${esbuildVer}`);
      return args.length > 2 ? [{ command: NPM, args, timeoutMs: 600_000 }] : [];
    })(),
    guidance: "这是构建期组件，仅 Linux 需要。手动补装：npm install --no-save --force @rollup/rollup-linux-x64-gnu@<rollup版本> @esbuild/linux-x64@<esbuild版本>（或直接跑 deploy/restart.sh）。",
  },
  postgres: {
    name: "PostgreSQL 实例",
    guidance:
      "PostgreSQL 是系统服务，且需要按部署拓扑创建数据库与账号，不适合一键安装。\n" +
      "Linux 参考：apt-get install -y postgresql && sudo -u postgres createuser --createdb <user> && sudo -u postgres createdb -O <user> <db>\n" +
      "Windows 参考：安装 PostgreSQL 官方安装包，或在 Docker 里跑：docker run -d --name agent-pg -e POSTGRES_PASSWORD=<pass> -p 5432:5432 postgres:16\n" +
      "就绪后在 apps/web/.env 配好 POSTGRES_HOST/PORT/USER/PASSWORD/DB，并执行：npm run db:migrate -w web",
  },
  codebuddy: {
    name: "CodeBuddy 登录凭据",
    guidance:
      "请在服务器上用运行服务的同一个系统账号执行一次登录（凭据落在 ~/.codebuddy）：\n" +
      "  npm run login\n" +
      "或把本机已登录的 ~/.codebuddy 用 scp 传到服务器的同一路径。",
  },
  codex: {
    name: "Codex CLI",
    commands: [{ command: NPM, args: ["install", "-g", "@openai/codex"], timeoutMs: 600_000 }],
    guidance: "装完后还需以运行账号完成 Codex 登录（codex login），或设置 CODEX_CLI_PATH 指向 CLI 路径。",
  },
  "web-push": {
    name: "Web Push VAPID 密钥",
    commands: [{ command: NPX, args: ["--no-install", "web-push", "generate-vapid-keys"], timeoutMs: 60_000 }],
    guidance:
      "把上方生成的 PUBLIC_KEY / PRIVATE_KEY 与 SUBJECT（mailto: 或 HTTPS URL）写入 apps/web/.env：\n" +
      "  WEB_PUSH_PUBLIC_KEY=...\n  WEB_PUSH_PRIVATE_KEY=...\n  WEB_PUSH_SUBJECT=mailto:admin@example.com\n" +
      "密钥轮换后浏览器需重新订阅通知，务必保存好。",
  },
  asr: {
    name: "语音转写配置",
    guidance:
      "可选组件。启用语音转写时在 apps/web/.env 配置：\n" +
      "  AGENT_KIT_ASR_HOST=https://your-asr-host.example.com\n  AGENT_KIT_ASR_API_KEY=<长期密钥>\n" +
      "（兼容旧名 BRANDAGENT_ASR_HOST / BRANDAGENT_ASR_API_KEY）",
  },
};

/* ── 检查项 ───────────────────────────────────────────────────────── */

interface CheckResult {
  status: ComponentStatus;
  detail: string;
  version?: string;
}

const CATEGORY_LABELS: Record<ComponentCategory, string> = {
  runtime: "运行时环境",
  infra: "基础设施",
  browser: "浏览器与渲染",
  native: "原生模块",
  auth: "认证与凭据",
  config: "配置项",
  build: "构建期",
};

const STATUS_LABELS: Record<ComponentStatus, string> = {
  ok: "正常",
  missing: "缺失",
  warn: "需关注",
  disabled: "未启用",
  "n/a": "不适用",
};

async function checkNode(): Promise<CheckResult> {
  const major = Number(process.versions.node.split(".")[0]);
  const ok = major >= 20;
  return {
    status: ok ? "ok" : "warn",
    detail: ok ? `当前 Node ${process.versions.node}，满足 ≥ 20.9` : `当前 Node ${process.versions.node}，低于要求的 20.9（Next 16 需要）`,
    version: process.versions.node,
  };
}

async function checkNpm(): Promise<CheckResult> {
  const r = await run(NPM, ["--version"], { timeoutMs: 10_000 });
  const version = r.code === 0 ? r.output.trim() : "";
  return { status: version ? "ok" : "missing", detail: version ? `npm ${version}` : "npm 不在 PATH 中（通常随 Node 安装，缺失时重装 Node）", version: version || undefined };
}

async function checkDocker(): Promise<CheckResult> {
  const cli = dockerCliPath();
  const cliPresent = cli !== "docker" || inPath("docker") !== "" || existsSync(cli);
  const daemon = cliPresent ? await dockerDaemonOk() : false;
  if (cliPresent && daemon) {
    return { status: "ok", detail: `CLI 可用（${cli}），Docker 守护进程响应正常` };
  }
  if (cliPresent && !daemon) {
    return { status: "missing", detail: `找到 CLI（${cli}），但 Docker 守护进程不可达 —— 请启动 Docker Desktop / docker 服务` };
  }
  return { status: "missing", detail: "未找到 docker CLI，Docker 未安装或不在 PATH" };
}

async function checkPlaywright(): Promise<CheckResult> {
  const version = pkgVersion("playwright");
  let executable = "";
  try {
    const { chromium } = await import("playwright") as typeof import("playwright");
    executable = chromium.executablePath();
  } catch { /* playwright 驱动本身缺失 */ }
  if (!version) return { status: "missing", detail: "playwright npm 包未安装（先 npm install）" };
  if (!executable || !existsSync(executable)) {
    return {
      status: "missing",
      detail: `已装驱动 playwright@${version}，但 Chromium 二进制未下载（自 v1.x 起需显式执行 npx playwright install chromium）。缺失时链接预览/网页抓取/浏览器 agent 会静默降级或不可用`,
      version,
    };
  }
  return { status: "ok", detail: `Chromium 就位：${executable}`, version };
}

async function checkFontsCjk(): Promise<CheckResult> {
  if (process.platform === "win32") {
    const fonts = ["msyh.ttc", "msyhbd.ttc", "simsun.ttc"].map((f) => path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts", f));
    const found = fonts.find(existsSync);
    return found
      ? { status: "ok", detail: `中文字体就位（${path.basename(found)}）` }
      : { status: "missing", detail: "未检测到系统中文字体（微软雅黑/宋体），中文 PDF 页图可能缺字" };
  }
  const fc = inPath("fc-list");
  if (!fc) {
    return process.platform === "darwin"
      ? { status: "ok", detail: "macOS 自带苹方中文字体" }
      : { status: "warn", detail: "未找到 fc-list，无法枚举系统字体" };
  }
  const r = await run(fc, ["-f", "%{family}\n", ":lang=zh"], { timeoutMs: 8_000 });
  const first = r.output.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first
    ? { status: "ok", detail: `中文字体就位（${first}）` }
    : { status: "missing", detail: "未安装任何中文字体（Linux 建议 apt-get install -y fonts-noto-cjk）" };
}

async function checkCanvas(): Promise<CheckResult> {
  const version = pkgVersion("@napi-rs/canvas");
  try {
    nodeRequire("@napi-rs/canvas");
    return { status: "ok", detail: "原生模块可加载（PDF 页图渲染可用）", version: version || undefined };
  } catch {
    const pkg = canvasPlatformPackage();
    return {
      status: "missing",
      detail: pkg
        ? `@napi-rs/canvas 无法加载，缺少平台二进制 ${pkg}（lockfile 在别的平台生成时常见）。影响：PDF 页图回退渲染不可用`
        : `@napi-rs/canvas 无法加载，且当前平台（${process.platform}-${process.arch}）没有预编译包，需源码编译`,
      version: version || undefined,
    };
  }
}

async function checkRollupEsbuild(): Promise<CheckResult> {
  if (process.platform !== "linux") return { status: "n/a", detail: "仅 Linux 构建需要（Windows/macOS 用本机二进制）" };
  const rollupPkg = existsSync(path.join(workspaceRoot, "node_modules", "@rollup", "rollup-linux-x64-gnu"));
  const esbuildPkg = existsSync(path.join(workspaceRoot, "node_modules", "@esbuild", "linux-x64"));
  if (rollupPkg && esbuildPkg) return { status: "ok", detail: "rollup / esbuild Linux 原生包就位" };
  const missing = [rollupPkg ? "" : "@rollup/rollup-linux-x64-gnu", esbuildPkg ? "" : "@esbuild/linux-x64"].filter(Boolean).join("、");
  return { status: "missing", detail: `缺少：${missing}（npm install 后可能被清掉，需补装，deploy/restart.sh 已固化此步骤）` };
}

async function checkPostgres(): Promise<CheckResult> {
  const host = process.env.POSTGRES_HOST;
  const db = process.env.POSTGRES_DB;
  if (!host || !db) {
    return { status: "disabled", detail: "未配置 POSTGRES_HOST / POSTGRES_DB（auth=builtin 或用量落库时必需）" };
  }
  try {
    const client = new Client({
      host,
      port: Number(process.env.POSTGRES_PORT || 5432),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD || "",
      database: db,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
    });
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("连接超时（6s）")), 6_000)),
    ]);
    await Promise.race([
      client.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("查询超时（5s）")), 5_000)),
    ]);
    await client.end().catch(() => undefined);
    return { status: "ok", detail: `PostgreSQL 可达（${host}:${process.env.POSTGRES_PORT || 5432}/${db}）` };
  } catch (e) {
    return {
      status: "missing",
      detail: `已配置但连接失败：${e instanceof Error ? e.message : String(e)}（请确认 PostgreSQL 实例已启动、凭据与网络正确）`,
    };
  }
}

async function checkCodebuddy(): Promise<CheckResult> {
  const p = path.join(homedir(), ".codebuddy");
  if (existsSync(p)) {
    return { status: "ok", detail: `登录凭据就位：${p}` };
  }
  return { status: "missing", detail: `未找到 ~/.codebuddy —— 需以运行服务账号执行一次 npm run login` };
}

async function checkCodex(): Promise<CheckResult> {
  const enabled = (process.env.AGENT_PROVIDER ?? "codebuddy").split(/[,\s]+/).some((p) => p === "codex");
  if (!enabled) return { status: "disabled", detail: "未启用 Codex 模式（AGENT_PROVIDER 不含 codex），可选" };
  const explicit = process.env.CODEX_CLI_PATH?.trim();
  const found = explicit && existsSync(explicit) ? explicit : inPath(process.platform === "win32" ? "codex.exe" : "codex");
  return found
    ? { status: "ok", detail: `codex CLI 就位：${found}` }
    : { status: "missing", detail: "已启用 Codex 模式但未找到 codex CLI（安装：npm install -g @openai/codex，或设置 CODEX_CLI_PATH）" };
}

async function checkWebPush(): Promise<CheckResult> {
  const ok = Boolean(process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY && process.env.WEB_PUSH_SUBJECT);
  return ok
    ? { status: "ok", detail: "VAPID 密钥已配置（浏览器离线通知可用）" }
    : { status: "warn", detail: "未配置 WEB_PUSH_PUBLIC_KEY / PRIVATE_KEY / SUBJECT，浏览器关闭后无法推送通知" };
}

async function checkAsr(): Promise<CheckResult> {
  const host = process.env.AGENT_KIT_ASR_HOST || process.env.BRANDAGENT_ASR_HOST;
  const key = process.env.AGENT_KIT_ASR_API_KEY || process.env.BRANDAGENT_ASR_API_KEY;
  return host && key
    ? { status: "ok", detail: "语音转写通道已配置" }
    : { status: "disabled", detail: "未配置 ASR_HOST / ASR_API_KEY（可选，未启用语音转写可忽略）" };
}

/* ── 注册表 ───────────────────────────────────────────────────────── */

interface ComponentDef {
  id: string;
  name: string;
  category: ComponentCategory;
  required: string;
  installable: boolean;
  installHint: string;
  check: () => Promise<CheckResult>;
}

const COMPONENTS: ComponentDef[] = [
  { id: "node", name: "Node.js", category: "runtime", required: "≥ 20.9（Next 16 要求）", installable: false, installHint: "需手动安装（nvm / 官方安装包）", check: checkNode },
  { id: "npm", name: "npm", category: "runtime", required: "随 Node 分发", installable: false, installHint: "重装 Node 官方安装包", check: checkNpm },
  { id: "docker", name: "Docker", category: "infra", required: "群容器 / Web 终端必需", installable: true, installHint: "Windows/macOS 装 Docker Desktop；Linux 可自动 apt 安装", check: checkDocker },
  { id: "postgres", name: "PostgreSQL", category: "infra", required: "auth=builtin 时必需", installable: false, installHint: "系统服务，需按部署拓扑建库建账号，见安装指引", check: checkPostgres },
  { id: "playwright", name: "Playwright Chromium", category: "browser", required: "链接预览 / 网页抓取 / 浏览器 agent 共用", installable: true, installHint: "自动执行 npx playwright install chromium", check: checkPlaywright },
  { id: "fonts-cjk", name: "系统中文字体", category: "browser", required: "PDF 页图渲染 / 中文页面渲染", installable: true, installHint: "Linux 自动 apt 安装 fonts-noto-cjk", check: checkFontsCjk },
  { id: "canvas", name: "@napi-rs/canvas", category: "native", required: "PDF 页图回退渲染", installable: true, installHint: "自动补装当前平台二进制包", check: checkCanvas },
  { id: "rollup-esbuild", name: "rollup / esbuild Linux 包", category: "build", required: "构建期（Vite 打包），仅 Linux", installable: true, installHint: "自动补装 Linux 原生包", check: checkRollupEsbuild },
  { id: "codebuddy", name: "CodeBuddy 凭据", category: "auth", required: "默认对话通道", installable: false, installHint: "需运行服务账号执行一次登录", check: checkCodebuddy },
  { id: "codex", name: "Codex CLI", category: "auth", required: "可选（AGENT_PROVIDER=codex 时）", installable: true, installHint: "自动执行 npm install -g @openai/codex", check: checkCodex },
  { id: "web-push", name: "Web Push VAPID", category: "config", required: "浏览器离线通知", installable: true, installHint: "自动生成密钥对，需手动写入 .env", check: checkWebPush },
  { id: "asr", name: "语音转写配置", category: "config", required: "可选（语音转写功能）", installable: false, installHint: "需在 .env 配置 ASR_HOST / ASR_API_KEY", check: checkAsr },
];

export async function listComponentReports(): Promise<ComponentReport[]> {
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(COMPONENTS.map(async (def) => {
    const r = await timeout(def.check(), 12_000, { status: "warn" as const, detail: "检查超时（12s），请重试", version: undefined })
      .catch(() => ({ status: "warn" as const, detail: "检查失败，请重试", version: undefined }));
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      categoryLabel: CATEGORY_LABELS[def.category],
      status: r.status,
      statusLabel: STATUS_LABELS[r.status],
      detail: r.detail,
      version: r.version,
      required: def.required,
      installable: def.installable && !!INSTALL_PLANS[def.id],
      autoInstallable: def.installable && (INSTALL_PLANS[def.id]?.commands?.length ?? 0) > 0,
      installHint: def.installHint,
      guidance: INSTALL_PLANS[def.id]?.guidance,
      checkedAt,
    };
  }));
  return results;
}

/* ── HTTP 处理（全部要求 admin 登录） ─────────────────────────────── */

/** GET /api/agent-kit-admin/admin/components —— 组件健康状态列表。 */
export async function adminComponentsList(request: Request): Promise<Response> {
  if (!verifyAdmin(request)) return json({ error: "未登录或登录已过期，请先登录" }, 401);
  const components = await listComponentReports();
  const summary = components.reduce(
    (acc, c) => { acc[c.status] = (acc[c.status] ?? 0) + 1; return acc; },
    {} as Record<string, number>,
  );
  return json({ components, summary, platform: `${process.platform}-${process.arch}`, node: process.version, checkedAt: new Date().toISOString() });
}

/** POST /api/agent-kit-admin/admin/components/install —— 启动安装任务（body: { id }）。 */
export async function adminComponentInstall(request: Request): Promise<Response> {
  if (!verifyAdmin(request)) return json({ error: "未登录或登录已过期，请先登录" }, 401);
  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  const def = COMPONENTS.find((c) => c.id === id);
  if (!def) return json({ error: "未知组件 id" }, 404);
  const plan = INSTALL_PLANS[id];
  if (!plan || !def.installable) return json({ error: "该组件不支持一键安装，请按安装指引手动处理", guidance: plan?.guidance ?? def.installHint }, 400);
  const { job, error } = startInstall(id);
  if (error) return json({ error }, 409);
  return json({ jobId: job!.id, componentId: id }, 202);
}

/** GET /api/agent-kit-admin/admin/components/install/:jobId —— 轮询安装任务状态与日志。 */
export async function adminComponentJob(request: Request, jobId: string): Promise<Response> {
  if (!verifyAdmin(request)) return json({ error: "未登录或登录已过期，请先登录" }, 401);
  const job = jobs.get(jobId);
  if (!job) return json({ error: "安装任务不存在或已过期" }, 404);
  return json({
    jobId: job.id,
    componentId: job.componentId,
    componentName: job.componentName,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    exitCode: job.exitCode,
    log: job.log,
  });
}
