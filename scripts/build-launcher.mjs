#!/usr/bin/env node
/**
 * build-launcher.mjs —— 桌面端（apps/desktop）打包脚本（macOS 为主）
 *
 * 用法（在仓库任意位置执行均可）：
 *   node scripts/build-launcher.mjs                # ①免安装版（默认，最常用）
 *   node scripts/build-launcher.mjs setup          # ②安装包（macOS=dmg）
 *   node scripts/build-launcher.mjs unpacked        # 同①，等价写法
 *
 * 选项：
 *   --out=<dir>    自定义输出目录；必须在工作区之外
 *   --copy-back    产物复制回 apps/desktop/release/
 *   --dry-run      只打印将要执行的命令，不实际执行
 *
 * 产物：
 *   macOS 免安装版 → <out>/mac-arm64/Linger.app
 *   macOS 安装包   → <out>/Linger-x.x.x-arm64.dmg
 *
 * 默认输出目录：<repo>/../linger-dist
 */

import { spawnSync } from "node:child_process";
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

function run(cmd, args, cwd, label) {
  if (!cmd) {
    console.error("");
    console.error(`✗ 找不到可执行文件：${label || args[0]}`);
    console.error("  请确认依赖已安装（在仓库根目录执行 npm install）。");
    process.exit(1);
  }
  if (DRY_RUN) {
    log(`(dry-run) ${cmd} ${args.join(" ")}`);
    return 0;
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const res = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: IS_WIN, env });

  if (res.error) {
    console.error(`✗ 命令执行失败：${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`✗ 命令返回非零退出码 ${res.status}`);
    console.error(`  ${cmd} ${args.join(" ")}`);
    process.exit(res.status ?? 1);
  }
  return 0;
}

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch { /* skip */ } }
    }
  };
  walk(dir);
  return total / 1024 / 1024;
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
const TOTAL = 4;
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
  console.error(`✗ 缺少打包目标的 Codex 平台包：@openai/codex-${codexTarget}。请安装该目标平台的依赖后重新打包。`);
  process.exit(1);
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
run(npmCmd(), ["run", "build"], appDir, "npm run build");

// --- 2. 清理上次产物（重命名让位） ------------------------------------------
step(2, TOTAL, "清理上次产物");

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

// --- 3. electron-builder 打包 -------------------------------------------------
step(3, TOTAL, IS_SETUP ? "打包并生成安装包" : "打包免安装版（--dir）");
const builderArgs = [];
if (IS_WIN) builderArgs.push("--win", "--x64");
else if (IS_MAC) builderArgs.push("--mac");
else {
  console.error(`✗ 不支持的平台：${process.platform}`);
  process.exit(2);
}
if (!IS_SETUP) builderArgs.push("--dir");
builderArgs.push(`--config=${packageConfig}`);
builderArgs.push(`--config.directories.output=${outDir}`);
run(resolveBin("electron-builder"), builderArgs, appDir, "electron-builder");

// --- 4. 校验产物并汇报 -------------------------------------------------------
step(4, TOTAL, "校验产物");

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
if (codexFiles(resourcesDir).some((file) => !fs.existsSync(file))) {
  console.error(`✗ 打包产物缺少 Codex 平台包：@openai/codex-${codexTarget}。请检查依赖安装后重新打包。`);
  process.exit(1);
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

log("");
log("═".repeat(64));
log("✓ 打包成功");
log("═".repeat(64));
log(`产物目录 : ${productDir}`);
log(`主程序   : ${exePath}`);
for (const a of artifacts) {
  log(`${a.label} : ${a.file}  (${humanSize(a.mb)})`);
}
log(`产物大小 : ${humanSize(dirSizeMb(productDir))}`);

log("");
if (IS_MAC) {
  log(`直接运行 App：open "${productDir}"`);
  log("提示：未签名 App 首次双击可能被 Gatekeeper 拦截，右键→打开 一次即可；");
  log(`      若仍被拦：sudo xattr -dr com.apple.quarantine "${productDir}"`);
}
