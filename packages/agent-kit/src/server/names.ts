/**
 * 群 AI 显示名称（应用层 title）。
 *
 * 来源：前端 <AgentApp title="…"> 传入的应用名，经 /state(?title=) 与 /send(body.title)
 * 上报到服务端（setAppDisplayName）；未上报或清洗为空时兜底 AI_DISPLAY_NAME。
 *
 * 注意：当前为进程级缓存（单宿主部署）。若未来一个进程服务多个不同应用名的宿主，
 * 需改为按会话 / 按租户隔离缓存，避免串名。
 */
import { ASSISTANT_NAME } from "../shared/assistant-name.js";

export const AI_DISPLAY_NAME = ASSISTANT_NAME;

let appDisplayName = "";

/** 清洗并缓存前端上报的应用名；非法（空 / 换行 / @ / “所有人”）时清空，回退兜底。 */
export function setAppDisplayName(value: unknown): void {
  const name = typeof value === "string" ? value.trim().slice(0, 80) : "";
  const invalid = !name || /[\r\n@＠]/u.test(name) || /^(所有人|all)$/iu.test(name);
  appDisplayName = invalid ? "" : name;
}

/** 当前应用名：优先上报值，缺失回退 AI_DISPLAY_NAME。 */
export function getAppDisplayName(): string {
  return appDisplayName || AI_DISPLAY_NAME;
}
