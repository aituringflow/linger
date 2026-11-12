/**
 * 编译状态栏的系统采集器（native/statusctl.m → resources/statusctl）。
 *
 * 为什么放在脚本里而不是随包发布二进制：这个工程目前不做打包，dev 也要能跑；
 * 每次 dev/build 前顺手编一下最省事（编译 ~0.3s）。机器上没有 clang（没装 Command Line Tools）
 * 时**不打断流程**，只警告 —— 主进程发现二进制不存在会自动退回命令行采集，只是拿不到信号强度和输入法。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "native", "statusctl.m");
const outDir = path.join(root, "resources");
const outFile = path.join(outDir, "statusctl");

if (process.platform !== "darwin") {
  console.log("[statusctl] 跳过：非 macOS 平台");
  process.exit(0);
}

if (!fs.existsSync(source)) {
  console.warn("[statusctl] 跳过：找不到 native/statusctl.m");
  process.exit(0);
}

// 源码没变就不重复编译（dev 重启很频繁）。
const fresh = fs.existsSync(outFile)
  && fs.statSync(outFile).mtimeMs >= fs.statSync(source).mtimeMs;
if (fresh) {
  console.log("[statusctl] 已是最新，跳过编译");
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
try {
  execFileSync("clang", [
    "-fobjc-arc", "-O2",
    "-arch", process.arch === "arm64" ? "arm64" : "x86_64",
    "-framework", "Foundation",
    "-framework", "CoreWLAN",
    "-framework", "IOKit",
    "-framework", "Carbon",
    "-o", outFile,
    source,
  ], { stdio: "inherit" });
  fs.chmodSync(outFile, 0o755);
  console.log(`[statusctl] 已编译 → ${path.relative(root, outFile)}`);
} catch (error) {
  // 编译失败不阻塞启动：状态栏会退化为命令行采集（没有信号强度/输入法名称）。
  console.warn("[statusctl] 编译失败，状态栏将退化为命令行采集：", error?.message ?? error);
}
