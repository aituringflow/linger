#!/usr/bin/env node
/**
 * build-launcher.mjs —— 桌面端（apps/desktop）打包脚本（macOS 为主）
 *
 * 用法（在仓库任意位置执行均可）：
 *   node scripts/build-launcher.mjs                # ①免安装版（默认，最常用）
 *   node scripts/build-launcher.mjs setup          # ②安装包（macOS=dmg）
 *   node scripts/build-launcher.mjs setup --reuse   # ③直接用现有免安装版压安装包（不重新打包）
 *   node scripts/build-launcher.mjs unpacked        # 同①，等价写法
 *
 * 选项：
 *   --out=<dir>    自定义输出目录；必须在工作区之外
 *   --copy-back    产物复制回 apps/desktop/release/
 *   --dry-run      只打印将要执行的命令，不实际执行
 *   --reuse        仅 setup：输出目录里已有免安装版时跳过打包，只做压缩
 *   --debug        打开 electron-builder 的 DEBUG 日志（配合行首时间戳定位卡点）
 *
 * 计时：每行日志带 `[+Ns]` 相对时间；每个阶段结束打 `⏱ 阶段名：用时`；
 * 结束时有「耗时汇总」与「体积构成」两张表，不用再手动 du / 掐表。
 *
 * 产物的生成方式（为什么 setup 不再打包两遍）：
 *   打包分两步——「目录产物」（拷贝 1.8GB 进 win-unpacked / Linger.app）和「压安装包」
 *   （NSIS/DMG 压缩同一批文件）。setup 现在先出目录产物，再用 --prepackaged 让
 *   electron-builder 只压不打包，所以整套流程只拷贝一次；先跑①再跑②时加 --reuse
 *   可以直接跳到压缩，省掉那次 1.8GB 的拷贝。
 *
 * 产物：
 *   macOS 免安装版 → <out>/mac-arm64/Linger.app
 *   macOS 安装包   → <out>/Linger-x.x.x-arm64.dmg
 *
 * 默认输出目录：<repo>/../linger-dist
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const appDir = path.join(repoRoot, "apps", "desktop");

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const ARCH = process.arch;
// Windows distribution is configured for x64, including when built on ARM64.
const TARGET_ARCH = IS_WIN ? "x64" : ARCH;
const codexTargets = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const codexTarget = `${process.platform}-${TARGET_ARCH}`;
const codexTriple = codexTargets[codexTarget];
function codexFiles(root) {
  const pkg = path.join(root, "node_modules", "@openai", `codex-${codexTarget}`);
  return [path.join(pkg, "package.json"), path.join(pkg, "vendor", codexTriple ?? "", "bin", IS_WIN ? "codex.exe" : "codex")];
}

function resolveBin(name) {
  const file = IS_WIN ? `${name}.cmd` : name;
  const candidates = [
    path.join(appDir, "node_modules", ".bin", file),
    path.join(repoRoot, "node_modules", ".bin", file),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function npmCmd() {
  return IS_WIN ? "npm.cmd" : "npm";
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const COPY_BACK = argv.includes("--copy-back");
/** --debug：打开 electron-builder 的 DEBUG 输出，配合时间戳定位卡在哪个子步骤。 */
const DEBUG_EB = argv.includes("--debug");
/** setup：输出目录里已有免安装版时跳过打包，只做压缩（见文件头的「产物的生成方式」）。 */
const REUSE = argv.includes("--reuse");

function readFlag(flag) {
  const hit = argv.find((a) => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : null;
}

const positional = argv.filter((a) => !a.startsWith("--"));
const MODE = (positional[0] || "unpacked").toLowerCase();

if (!["unpacked", "setup"].includes(MODE)) {
  console.error(`未知模式 "${MODE}"，只支持：unpacked | setup`);
  process.exit(2);
}

const IS_SETUP = MODE === "setup";

const outDir = path.resolve(readFlag("out") || path.join(repoRoot, "..", "linger-dist"));

// ---------------------------------------------------------------------------
// 安全检查：输出目录必须不在工作区内
// ---------------------------------------------------------------------------
const rel = path.relative(repoRoot, outDir);
const insideWorkspace = rel && !rel.startsWith("..") && !path.isAbsolute(rel);

if (insideWorkspace) {
  console.error(
    [
      "",
      "✗ 拒绝执行：输出目录在工作区之内。",
      `    工作区：${repoRoot}`,
      `    输出目录：${outDir}`,
      "",
      "  请指定工作区外的目录，例如：--out=/Users/you/linger-dist",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
const t0 = Date.now();
function log(msg = "") {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  console.log(`[${s}s] ${msg}`);
}
function step(n, total, title) {
  console.log("");
  log(`─── [${n}/${total}] ${title}${"─".repeat(Math.max(0, 46 - title.length))}`);
}

/** 把毫秒变成人看的：850ms / 12.3s / 5m12s。 */
function fmtDur(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** 阶段计时：track("名称") → end("附加信息")，结束时打印并记入汇总表。 */
const timings = [];
function track(name) {
  const startedAt = Date.now();
  return {
    end(detail) {
      const ms = Date.now() - startedAt;
      timings.push({ name, ms, detail });
      log(`⏱  ${name}：${fmtDur(ms)}${detail ? `　（${detail}）` : ""}`);
      return ms;
    },
  };
}

/** 子进程输出加时间戳：能看出 electron-builder 到底卡在拷贝、asar 还是压缩。 */
function run(cmd, args, cwd, label) {
  if (!cmd) {
    console.error("");
    console.error(`✗ 找不到可执行文件：${label || args[0]}`);
    console.error("  请确认依赖已安装（在仓库根目录执行 npm install）。");
    process.exit(1);
  }
  if (DRY_RUN) {
    log(`(dry-run) ${cmd} ${args.join(" ")}`);
    return Promise.resolve(0);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (DEBUG_EB && !env.DEBUG) env.DEBUG = "electron-builder";

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, { cwd, stdio: ["inherit", "pipe", "pipe"], shell: IS_WIN, env });
    const prefix = () => `[+${((Date.now() - startedAt) / 1000).toFixed(1)}s]`;

    const pump = (stream) => {
      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.search(/\r?\n/)) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, "");
          buffer = buffer.slice(index + (buffer[index] === "\r" ? 2 : 1));
          if (line.trim()) process.stdout.write(`${prefix()} ${line}\n`);
        }
      });
      stream.on("end", () => { if (buffer.trim()) process.stdout.write(`${prefix()} ${buffer.trim()}\n`); });
    };
    pump(child.stdout);
    pump(child.stderr);

    // 长时间无输出时打个心跳，避免看不出「到底是慢还是卡死」。
    const heartbeat = setInterval(() => {
      log(`… ${label || cmd} 仍在执行（已 ${fmtDur(Date.now() - startedAt)}）`);
    }, 30_000);

    child.once("error", (error) => {
      clearInterval(heartbeat);
      console.error(`✗ 命令执行失败：${error.message}`);
      process.exit(1);
    });
    child.once("close", (code) => {
      clearInterval(heartbeat);
      const ms = Date.now() - startedAt;
      if (code !== 0) {
        console.error(`✗ 命令返回非零退出码 ${code}（用时 ${fmtDur(ms)}）`);
        console.error(`  ${cmd} ${args.join(" ")}`);
        process.exit(code ?? 1);
      }
      log(`✓ ${label || cmd} 完成，用时 ${fmtDur(ms)}`);
      resolve(0);
    });
  });
}

function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch { /* skip */ }
      }
    }
  };
  walk(dir);
  return { mb: bytes / 1024 / 1024, bytes, files };
}

function dirSizeMb(dir) {
  return dirStats(dir).mb;
}

function humanSize(mb) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

// ---------------------------------------------------------------------------
// 前置检查：Linger 是否还在跑
// ---------------------------------------------------------------------------
function warnIfAppRunning() {
  if (IS_MAC) {
    const pattern = "/Linger.app/Contents/MacOS/Linger";
    try {
      const res = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
      if (res.stdout && res.stdout.trim()) {
        log("⚠ 检测到 Linger.app 仍在运行。建议先退出再继续打包。");
        log(`  强制结束：pkill -f "${pattern}"`);
        return true;
      }
    } catch { /* ignore */ }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const TOTAL = IS_SETUP ? 5 : 4;
const productDirNameForCheck = IS_WIN ? "win-unpacked" : `mac-${ARCH}`;

console.log("=".repeat(64));
console.log("  Linger 打包");
console.log("=".repeat(64));
log(`平台　　: ${IS_WIN ? "Windows" : IS_MAC ? "macOS" : process.platform}${IS_MAC ? ` (${ARCH})` : ""}`);
log(`模式　　: ${MODE}${IS_SETUP ? "（安装包）" : "（免安装版）"}`);
log(`输出目录 : ${outDir}`);
log(`工作区   : ${repoRoot}`);
log("agent-kit: 源码直连，无构建步骤");
if (DRY_RUN) log("dry-run : 只打印命令，不实际执行");

if (!DRY_RUN && warnIfAppRunning()) {
  console.error("");
  console.error("✗ 检测到 Linger 仍在运行，继续打包大概率失败。");
  console.error(`  先退出 app，或执行：pkill -f "/Linger.app/Contents/MacOS/Linger"`);
  console.error("");
  if (!process.argv.includes("--force")) process.exit(3);
  log("已指定 --force，跳过检查继续执行");
}

if (!DRY_RUN && (!codexTriple || codexFiles(repoRoot).some((file) => !fs.existsSync(file)))) {
  // Codex 平台包不再进安装包（改为首次使用按需下载，见 apps/desktop/src/main/codex-runtime.ts），
  // 因此本机没装它不影响出包；构建期只用到 @openai/codex 的版本号来拼下载地址。
  log(`提示：本机没有 @openai/codex-${codexTarget}，Codex CLI 将由用户首次启用时下载。`);
}

// The watcher and packaging must never write the same output tree.
const packageTemp = DRY_RUN ? path.join(os.tmpdir(), "linger-package-<temporary>") : fs.mkdtempSync(path.join(os.tmpdir(), "linger-package-"));
const packageOut = path.join(packageTemp, "out");
const packageConfig = path.join(packageTemp, "electron-builder.yml");
if (!DRY_RUN) {
  process.on("exit", () => { try { fs.rmSync(packageTemp, { recursive: true, force: true }); } catch { /* best effort */ } });
  const sourceConfig = fs.readFileSync(path.join(appDir, "electron-builder.yml"), "utf8");
  const marker = "  - out/**";
  if (!sourceConfig.includes(marker)) throw new Error("electron-builder.yml is missing the out/** file rule");
  const packagedFiles = `  - from: ${JSON.stringify(packageOut)}\n    to: out\n    filter:\n      - "**/*"`;
  fs.writeFileSync(packageConfig, sourceConfig.replace(marker, packagedFiles));
  process.env.LINGER_PACKAGE_OUT_DIR = packageOut;
}
log(`独立构建目录: ${packageOut}`);

// --- 1. 编译（原生工具 + Electron UI） ---------------------------------------
// npm run build 已包含：build-statusctl → build-wechat-windowctl → electron-vite build。
// agent-kit 是私有源码 workspace 包，由 electron-vite 直接编译，没有 dist/ 产物。
step(1, TOTAL, "编译原生工具与 Electron UI");
const compileTimer = track("① 编译（npm run build）");
await run(npmCmd(), ["run", "build"], appDir, "npm run build");
compileTimer.end();

// --- 2. 清理上次产物（重命名让位） ------------------------------------------
/** setup 复用模式要保留现有产物，不能让它让位。 */
const prepackagedApp = IS_WIN
  ? path.join(outDir, "win-unpacked")
  : path.join(outDir, `mac-${ARCH}`, "Linger.app");
const prepackagedReady = IS_SETUP && REUSE && fs.existsSync(IS_WIN ? path.join(prepackagedApp, "Linger.exe") : prepackagedApp);

step(2, TOTAL, prepackagedReady ? "复用现有产物（跳过清理）" : "清理上次产物");

/** 让旧产物改名让位（Windows 上被占用的目录 rename 失败也不影响继续）。 */
function cleanPreviousOutput() {
  if (!DRY_RUN) fs.mkdirSync(outDir, { recursive: true });

  const productDirName = productDirNameForCheck;
  const staleProductDir = path.join(outDir, productDirName);
  const staleDirs = [staleProductDir, `${staleProductDir}.tmp`].filter((p) => fs.existsSync(p));

  if (DRY_RUN) {
    log(staleDirs.length ? `将让位：${staleDirs.map((p) => path.basename(p)).join(", ")}` : "无旧产物，跳过");
  } else {
    if (staleDirs.length === 0) {
      log("无旧产物，跳过");
    }
    const stashNames = [];
    for (const dir of staleDirs) {
      const stash = `${dir}.old-${Date.now().toString().slice(-8)}`;
      try {
        fs.renameSync(dir, stash);
        stashNames.push(path.basename(stash));
        log(`已让位：${path.basename(dir)} → ${path.basename(stash)}`);
      } catch (e) {
        const busy = /EBUSY|EPERM|resource busy|locked/i.test(String(e && e.message));
        log(`⚠ 让位失败（${path.basename(dir)}）：${e.message}`);
        log(busy ? "  文件被占用——通常是 app 还在运行。" : "  不影响本次打包可继续。");
      }
    }
    if (stashNames.length) log(`确认新包正常后可手动删除：${stashNames.join(", ")}`);
  }

  // 清掉更早的 .old-* 历史备份
  if (!DRY_RUN) {
    const stashes = fs
      .readdirSync(outDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(`${productDirName}.old-`))
      .map((e) => e.name)
      .sort();
    for (const name of stashes.slice(0, -1)) {
      try {
        fs.rmSync(path.join(outDir, name), { recursive: true, force: true, maxRetries: 3 });
        log(`已清理历史备份：${name}`);
      } catch { /* ignore */ }
    }
  }
}

if (prepackagedReady) {
  log(`复用：${prepackagedApp}`);
} else {
  const cleanTimer = track("② 清理上次产物");
  cleanPreviousOutput();
  cleanTimer.end();
}

const platformArgs = IS_WIN ? ["--win", "--x64"] : IS_MAC ? ["--mac"] : null;
if (!platformArgs) {
  console.error(`✗ 不支持的平台：${process.platform}`);
  process.exit(2);
}

// --- 3. 打包目录产物（--dir） -------------------------------------------------
// setup 也先走这一步：安装包只是把这份目录产物压缩一遍（见第 4 步 --prepackaged），
// 不再像以前那样单独做一次完整打包，省一遍 1.8GB 的拷贝与 asar 生成。
step(3, TOTAL, prepackagedReady ? "跳过打包（--reuse）" : "打包目录产物（--dir）");
if (prepackagedReady) {
  log("已指定 --reuse 且产物齐备，跳过 electron-builder 打包。");
} else {
  const packTimer = track("③ 目录产物（--dir：拷贝 + asar）");
  await run(resolveBin("electron-builder"), [
    ...platformArgs,
    "--dir",
    `--config=${packageConfig}`,
    `--config.directories.output=${outDir}`,
  ], appDir, "electron-builder");
  const packed = IS_WIN ? path.join(outDir, "win-unpacked") : path.join(outDir, `mac-${ARCH}`, "Linger.app");
  const stats = dirStats(packed);
  packTimer.end(`${humanSize(stats.mb)} / ${stats.files} 个文件`);
}

// --- 4. 安装包：只压缩，不再打包（setup） -------------------------------------
if (IS_SETUP) {
  step(4, TOTAL, "由目录产物生成安装包（--prepackaged）");
  const appDirForInstaller = IS_WIN ? path.join(outDir, "win-unpacked") : path.join(outDir, `mac-${ARCH}`, "Linger.app");
  if (!DRY_RUN && !fs.existsSync(appDirForInstaller)) {
    console.error(`✗ 缺少目录产物：${appDirForInstaller}（先跑一次免安装版打包）`);
    process.exit(1);
  }
  const setupTimer = track("④ 压缩安装包（--prepackaged）");
  await run(resolveBin("electron-builder"), [
    ...platformArgs,
    `--prepackaged=${appDirForInstaller}`,
    `--config=${packageConfig}`,
    `--config.directories.output=${outDir}`,
  ], appDir, "electron-builder");
  setupTimer.end();
}

// --- 5. 校验产物并汇报 -------------------------------------------------------
step(IS_SETUP ? 5 : 4, TOTAL, "校验产物");

if (DRY_RUN) {
  log("dry-run：跳过产物校验。");
  if (IS_MAC) {
    log(`预期 App 包：${path.join(outDir, `mac-${ARCH}`, "Linger.app")}`);
  }
  process.exit(0);
}

let productDir;
let exePath;
const artifacts = [];

if (IS_WIN) {
  productDir = path.join(outDir, "win-unpacked");
  exePath = path.join(productDir, "Linger.exe");
} else if (IS_MAC) {
  productDir = path.join(outDir, `mac-${ARCH}`, "Linger.app");
  if (!fs.existsSync(productDir)) {
    console.error(`✗ 未找到本次构建的 App：${productDir}`);
    process.exit(1);
  }
  exePath = path.join(productDir, "Contents", "MacOS", "Linger");
}

if (!fs.existsSync(exePath)) {
  console.error(`✗ 未找到主程序：${exePath}`);
  process.exit(1);
}

const resourcesDir = IS_WIN ? path.join(productDir, "resources") : path.join(productDir, "Contents", "Resources");
if (codexFiles(path.join(resourcesDir, "app.asar.unpacked")).some((file) => fs.existsSync(file))) {
  console.error(`✗ Codex 平台包被重复打包：@openai/codex-${codexTarget}。`);
  process.exit(1);
}
// Codex CLI 默认按需下载，包里没有它是正常状态；只有在离线分发（手动打回平台包）时才校验。
if (codexFiles(resourcesDir).every((file) => fs.existsSync(file))) {
  const codexExecutable = codexFiles(resourcesDir)[1];
  const codexCheck = spawnSync(codexExecutable, ["--version"], { encoding: "utf8", timeout: 30000, windowsHide: true });
  if (codexCheck.error || codexCheck.status !== 0) {
    console.error(`✗ 打包的 Codex CLI 无法启动：${codexCheck.error?.message || codexCheck.stderr || `退出码 ${codexCheck.status}`}`);
    process.exit(1);
  }
  log(`Codex CLI 校验通过（内置）：${codexCheck.stdout.trim()}`);
} else {
  log("Codex CLI 未内置：用户首次启用「算力提供商 → Codex」时按需下载（约 437 MB）");
}

// 安装包（setup）
if (IS_SETUP) {
  let setupFile = null;
  const version = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8")).version;
  if (IS_WIN) {
    setupFile = `Linger Setup ${version}.exe`;
    if (!fs.existsSync(path.join(outDir, setupFile))) setupFile = null;
  } else if (IS_MAC) {
    setupFile = fs.readdirSync(outDir).find((f) => f.startsWith(`Linger-${version}-`) && f.endsWith(".dmg"));
  }
  if (!setupFile) {
    console.error(`✗ 未找到安装包，请检查 ${outDir}`);
    process.exit(1);
  }
  const p = path.join(outDir, setupFile);
  artifacts.push({ label: IS_WIN ? "安装包" : "DMG 安装包", file: p, mb: fs.statSync(p).size / 1024 / 1024 });
}

if (COPY_BACK && !DRY_RUN) {
  const backDir = path.join(appDir, "release");
  fs.mkdirSync(backDir, { recursive: true });
  for (const a of artifacts) {
    const dest = path.join(backDir, path.basename(a.file));
    fs.copyFileSync(a.file, dest);
    log(`已复制回 ${dest}`);
  }
}

/** 体积构成：每次都要想知道「这 400M 是谁」，直接列出来，省得再 du。 */
function reportSize(dir, limit = 8) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  const rows = entries.map((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const s = dirStats(full);
      return { name: `${e.name}/`, mb: s.mb, files: s.files, dir: true };
    }
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* skip */ }
    return { name: e.name, mb: size / 1048576, files: 1, dir: false };
  }).sort((a, b) => b.mb - a.mb).slice(0, limit);
  log("体积构成（前 8 项）");
  for (const r of rows) {
    log(`  ${String(Math.round(r.mb)).padStart(6)} MB  ${r.name}${r.dir ? `（${r.files} 个文件）` : ""}`);
  }
}

log("");
log("═".repeat(64));
log("✓ 打包成功");
log("═".repeat(64));
log(`产物目录 : ${productDir}`);
log(`主程序   : ${exePath}`);
for (const a of artifacts) {
  log(`${a.label} : ${a.file}  (${humanSize(a.mb)})`);
}
const productStats = dirStats(productDir);
log(`产物大小 : ${humanSize(productStats.mb)}（${productStats.files} 个文件）`);
const installer = artifacts[0];
if (installer && productStats.mb > 0) {
  log(`压缩效果 : ${humanSize(productStats.mb)} → ${humanSize(installer.mb)}（${((installer.mb / productStats.mb) * 100).toFixed(0)}%）`);
}

reportSize(productDir);
reportSize(path.join(productDir, IS_WIN ? "resources" : path.join("Contents", "Resources")), 6);

log("");
log("耗时汇总（长 → 短）");
for (const t of [...timings].sort((a, b) => b.ms - a.ms)) {
  log(`  ${fmtDur(t.ms).padStart(7)}  ${t.name}${t.detail ? `　（${t.detail}）` : ""}`);
}
log(`  ${fmtDur(Date.now() - t0).padStart(7)}  总计`);

log("");
if (IS_MAC) {
  log(`直接运行 App：open "${productDir}"`);
  log("提示：未签名 App 首次双击可能被 Gatekeeper 拦截，右键→打开 一次即可；");
  log(`      若仍被拦：sudo xattr -dr com.apple.quarantine "${productDir}"`);
}
