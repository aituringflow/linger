/**
 * agent-kit · 按会话落盘的调试日志（服务端）
 *
 * 用途：对话链路出问题时，拿"最近一个会话"的日志文件即可还原完整时间线：
 * HTTP 请求 → Session 复用/创建 → CLI 消息流（模型/文本/思考/工具/结果）→ SSE 下发 → steer/interrupt。
 *
 * 设计：
 *  - 每个 sessionId 一个文件：<logDir>/<sid>.log，每行一条 JSON（时间戳/级别/事件/明细）；
 *  - 级别：debug < info < warn < error，env AGENT_KIT_LOG_LEVEL 控制（默认 debug，最详细）；
 *  - 目录：env AGENT_KIT_LOG_DIR 覆盖，默认 <进程 cwd>/logs/sessions（web 下即 apps/web/logs/sessions）；
 *  - 写入 fire-and-forget，按文件串行（promise 链）防交错；日志失败绝不影响对话主链路；
 *  - 流式输出（text/thinking delta、SSE 帧）不逐块记日志，只保留关键锚点：
 *    turn.start / turn.send / turn.done / turn.error / cli.system / cli.model /
 *    cli.tool_use / cli.tool_result / cli.stream.end / cli.result；
 *  - 明细里的长文本统一 clip 截断，保证文件可读且不爆炸。
 */

import fs from "node:fs";
import path from "node:path";

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let levelCache: number | null = null;
function levelThreshold(): number {
  if (levelCache == null) {
    const raw = String(process.env.AGENT_KIT_LOG_LEVEL || "debug").trim().toLowerCase();
    levelCache = LEVELS[raw] ?? LEVELS.debug;
  }
  return levelCache;
}

export function logDir(): string {
  return process.env.AGENT_KIT_LOG_DIR?.trim()
    ? path.resolve(process.env.AGENT_KIT_LOG_DIR.trim())
    : path.resolve(process.cwd(), "logs", "sessions");
}

/** 长文本截断：日志可读性优先，超长部分标注省略长度 */
function clip(v: unknown, max = 2000): unknown {
  if (typeof v !== "string") return v;
  if (v.length <= max) return v;
  return `${v.slice(0, max)}…[+${v.length - max} chars]`;
}

// 每个日志文件一条写入队列，串行追加避免并发交错
const writeQueues = new Map<string, Promise<void>>();
let dirReady: Promise<void> | null = null;

/** 首次写入前确保日志目录存在（slog 之前因目录缺失而全部静默失败，导致问题无法从日志排查） */
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = fs.promises
      .mkdir(logDir(), { recursive: true })
      .then(() => undefined)
      .catch(() => undefined);
  }
  return dirReady ?? Promise.resolve();
}

function appendLine(file: string, line: string): void {
  const prev = writeQueues.get(file) ?? ensureDir();
  const next = prev
    .then(() => fs.promises.appendFile(file, line, "utf8"))
    .catch(() => { /* 日志失败静默：绝不影响对话链路 */ });
  writeQueues.set(file, next);
  // 队列防无限增长：写完且仍是当前尾项时清掉
  void next.then(() => {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  });
}

/**
 * 写一条会话日志。
 * @param sid  会话 ID（无会话的请求传空，落到 _server.log）
 * @param event 事件名，点分层级，如 "turn.start"、"cli.tool_use"、"steer.response"
 * @param detail 明细（值中的长字符串自动截断）
 * @param level  日志级别，默认 debug
 */
export function slog(
  sid: string | null | undefined,
  event: string,
  detail: Record<string, unknown> = {},
  level: "debug" | "info" | "warn" | "error" = "debug",
  clipMax = 2000,
): void {
  try {
    if (LEVELS[level] < levelThreshold()) return;
    const safeSid = String(sid || "_server").replace(/[^\w.-]/g, "_").slice(0, 120) || "_server";
    const file = path.join(logDir(), `${safeSid}.log`);
    const record: Record<string, unknown> = { t: new Date().toISOString(), lvl: level, ev: event, ...detail };
    // detail 里的长字符串统一截断（clipMax 控制上限，全量转储事件可传大值）
    for (const k of Object.keys(record)) record[k] = clip(record[k], clipMax);
    appendLine(file, `${JSON.stringify(record)}\n`);
  } catch { /* ignore */ }
}

/**
 * 当前是否处于 debug 级别（最详细）。
 * 用于按需开关重量级的全量消息转储：排查“无最终输出”时开启，
 * 生产把 AGENT_KIT_LOG_LEVEL 调到 info 即自动关闭（既不再打印、也不再产生 stringify 开销）。
 */
export function isDebugLevel(): boolean {
  return levelThreshold() <= LEVELS.debug;
}
