/**
 * agent-kit · CLI（交互式订阅对话）
 * CodeBuddy 订阅登录由 agent-kit bin 命令提供：npm run login（根目录）。
 */

import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { runSdkQuery } from "./sdk.js";

function loadDotEnv(): void {
  // 级联加载（仅设置尚未存在的变量，进程 env 优先级最高）：
  //   1) AGENT_ENV_FILE 显式指定的宿主 env 文件；
  //   2) <cwd>/.env —— 宿主应用根目录（npm 安装场景）；
  //   3) 源码仓库约定 apps/web/.env（仅 monorepo 开发，路径存在才命中）；
  //   4) kit 本地 .env（gitignore，仅临时联调）。
  const candidates = [
    process.env.AGENT_ENV_FILE?.trim() ? path.resolve(process.env.AGENT_ENV_FILE.trim()) : "",
    path.resolve(process.cwd(), ".env"),
    path.resolve(import.meta.dirname, "../../../../apps/web/.env"),
    path.join(import.meta.dirname, "..", ".env"),
  ].filter(Boolean);
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

async function runInteractive(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log("agent-kit 订阅对话已启动（hy3），exit 退出。");
  try {
    while (true) {
      let msg: string;
      try {
        msg = (await rl.question("\nYou> ")).trim();
      } catch {
        break;
      }
      if (!msg) continue;
      if (["exit", "quit", "退出", "再见"].includes(msg.toLowerCase())) {
        console.log("再见！");
        break;
      }
      try {
        console.log(`Agent> ${await runSdkQuery(msg)}`);
      } catch (err) {
        console.error(`对话失败：${err instanceof Error ? err.message : err}`);
      }
    }
  } finally {
    rl.close();
  }
}

function printUsage(): void {
  console.log(`agent-kit CLI — 用法：
  无参数 / npm run cli    交互式订阅对话（exit 退出）
  -h / --help             显示本帮助
（CodeBuddy 订阅登录/登出：npm run login / npm run logout）`);
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help") || args.includes("help")) {
    printUsage();
    return;
  }
  await runInteractive();
}

main().catch((err) => {
  console.error(`出错：${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
