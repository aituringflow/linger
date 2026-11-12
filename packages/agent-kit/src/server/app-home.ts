/**
 * agent-kit · 应用主目录（app home）
 *
 * 本机应用级数据（models.json、会话元数据、产物、知识库、终端 HOME 等）统一放在
 * 用户主目录下的隐藏目录 `~/.<应用名>/`。应用名由宿主通过 env `AGENT_APP_NAME` 声明：
 * 声明了名字就用名字（`AGENT_APP_NAME=myapp` → `~/.myapp`），未声明则用通用名
 * `.agent`，供多应用共用的部署与脚本沿用默认位置。
 *
 * env 在调用时读取，不在模块顶层缓存：宿主在 import 本包之前写入即可生效，
 * 这样也允许同一进程内不同阶段使用不同目录（测试、多实例隔离）。
 */

import os from "node:os";
import path from "node:path";

/** 未声明应用名时的兜底目录名（不带点）。 */
export const DEFAULT_APP_HOME_NAME = "agent";

/**
 * 读取宿主声明的应用名：只接受单级目录名（不含路径分隔符、空白、`.`/`..`），
 * 非法值按未声明处理，避免把数据写到意料之外的目录。
 */
export function declaredAppName(): string | null {
  const raw = process.env.AGENT_APP_NAME?.trim().replace(/^\.+/, "");
  if (!raw) return null;
  if (raw === "." || raw === ".." || /[/\\]/.test(raw) || /\s/.test(raw)) return null;
  return raw;
}

/** 主目录名（不带点）：`myapp` / `agent`。 */
export function appHomeName(): string {
  return declaredAppName() ?? DEFAULT_APP_HOME_NAME;
}

/** 主目录名（带点，即磁盘上的目录名）：`.myapp` / `.agent`。 */
export function appHomeDirName(): string {
  return `.${appHomeName()}`;
}

/** 主目录绝对路径：`~/.myapp` / `~/.agent`。 */
export function appHomeDir(): string {
  return path.join(os.homedir(), appHomeDirName());
}

/** 主目录下某个子路径：`appHomePath("models.json")` → `~/.myapp/models.json`。 */
export function appHomePath(...segments: string[]): string {
  return path.join(appHomeDir(), ...segments);
}
