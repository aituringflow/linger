/**
 * 应用身份：声明本应用的名字，agent-kit 据此把本机数据（models.json、会话、产物、
 * 知识库、终端 HOME 等）统一放到 `~/.<应用名>`（这里即 `~/.linger`）。
 *
 * 本模块必须在任何 `@turingflow/agent-kit` / `@tencent-ai/agent-sdk` 模块之前被 import：
 * kit 有在模块加载期就解析主目录的常量（如 terminal-home），晚设置会让部分路径落到默认目录。
 * 可用 env `LAUNCHER_APP_NAME` 覆盖应用名（测试/多实例隔离用）。
 */

import os from "node:os";
import path from "node:path";

/** 应用名（决定本机数据主目录 `~/.<name>`）。 */
export const APP_PROJECT_NAME = process.env.LAUNCHER_APP_NAME?.trim() || "linger";

process.env.AGENT_APP_NAME = APP_PROJECT_NAME;

/** 本应用数据主目录：`~/.linger`。 */
export const APP_HOME_DIR = path.join(os.homedir(), `.${APP_PROJECT_NAME}`);
