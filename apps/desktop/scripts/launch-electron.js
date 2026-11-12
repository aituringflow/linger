#!/usr/bin/env node
/**
 * launch-electron.js
 *
 * 沿用既有本地宿主的启动方案，规避两个已知坑：
 * 1. 运行环境可能注入 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 node 模式，
 *    主进程启动即崩。必须真正 delete，不能置空字符串。
 * 2. 不经过 cmd.exe / 不依赖 PATH，直接 node 直调 npm / electron-vite 的 cli 入口，
 *    失败时打印明确错误与退出码，避免"无输出只报 exit 1"。
 */
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

if ("ELECTRON_RUN_AS_NODE" in process.env) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

const repoRoot = path.resolve(__dirname, "../../.."); // apps/desktop/scripts -> 仓库根
const appDir = path.resolve(__dirname, ".."); // apps/desktop
const IS_WIN = process.platform === "win32";

function fail(message, code = 1) {
  console.error(`\n✗ ${message}`);
  process.exit(code);
}

function run(file, args, cwd, label, opts = {}) {
  const r = spawnSync(file, args, { cwd, stdio: "inherit", env: process.env, ...opts });
  if (r.error) {
    fail(
      `${label} 无法启动：${r.error.message}\n` +
        `    命令：${file} ${args.join(" ")}\n` +
        `    工作目录：${cwd}`
    );
  }
  if (r.status === null) {
    fail(`${label} 被信号终止（signal=${r.signal}），未产生退出码`);
  }
  if (r.status !== 0) {
    fail(`${label} 失败（exit ${r.status}）。详见上方输出。`);
  }
}

function npmCli() {
  const p = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(p) ? p : null;
}

function npm(args, label) {
  const cli = npmCli();
  if (cli) {
    run(process.execPath, [cli, ...args], repoRoot, label);
    return;
  }
  run(IS_WIN ? "npm.cmd" : "npm", args, repoRoot, label, { shell: true });
}

function electronViteCli() {
  const p = path.join(appDir, "node_modules", "electron-vite", "bin", "electron-vite.js");
  return fs.existsSync(p) ? p : null;
}

function electronVite(args, label) {
  const cli = electronViteCli();
  // electron-vite may be hoisted to the workspace root, where its own
  // require('electron') would resolve another app's Electron version.
  const desktopElectron = electronBin();
  const desktopElectronPackage = electronPackageJson();
  if (!desktopElectron || !desktopElectronPackage) {
    fail("找不到桌面端使用的 Electron，请先在工作区执行 npm install");
  }
  process.env.ELECTRON_EXEC_PATH = desktopElectron;
  process.env.ELECTRON_MAJOR_VER = String(require(desktopElectronPackage).version).split(".")[0];
  if (cli) {
    run(process.execPath, [cli, ...args], appDir, label);
    return;
  }
  run(IS_WIN ? "electron-vite.cmd" : "electron-vite", args, appDir, label, { shell: true });
}

/**
 * electron 的 package.json：先查本 app，再查 workspace 根。
 * npm 会把 electron 提升到根 node_modules（本 app 目录里可能没有），这里必须同样兜底，
 * 否则「找不到 Electron」会把 dev 启动整条链掐断。
 */
function electronPackageJson() {
  const candidates = [
    path.join(appDir, "node_modules", "electron", "package.json"),
    path.join(repoRoot, "node_modules", "electron", "package.json"),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/** electron 包在非 Electron 的 node 里 require 时返回可执行文件路径；先查本 app，再查 workspace 根 */
function electronBin() {
  try {
    const p = require(path.join(appDir, "node_modules", "electron", "index.js"));
    return typeof p === "string" ? p : null;
  } catch {
    /* 本目录没有，向下查 workspace 根 node_modules */
  }
  try {
    const p = require(path.join(repoRoot, "node_modules", "electron", "index.js"));
    return typeof p === "string" ? p : null;
  } catch {
    return null;
  }
}

function launchElectron(label) {
  const bin = electronBin();
  if (bin) {
    run(bin, ["."], appDir, label);
    return;
  }
  run(IS_WIN ? "electron.cmd" : "electron", ["."], appDir, label, { shell: true });
}

const mode = process.argv[2];

if (mode === "dev") {
  // agent-kit 源码由 electron-vite 直接编译：main 打进 bundle，renderer 走 Vite HMR。
  // 改 SDK 源码会触发主进程重启 / 界面热更新，不需要预构建 dist。
  electronVite(["dev", "--watch"], "electron-vite dev");
} else if (mode === "start") {
  npm(["run", "build", "-w", "desktop"], "构建桌面端");
  launchElectron("启动 Electron");
} else {
  console.error(`launch-electron: 未知模式 "${mode}"，支持 dev | start`);
  process.exit(1);
}
