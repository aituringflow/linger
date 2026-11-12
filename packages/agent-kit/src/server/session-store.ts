/**
 * agent-kit · Session 常驻注册表（多轮 + steer 支撑）
 *
 * 基于 @tencent-ai/agent-sdk 的 V2 Session API（unstable_v2_createSession）：
 * 一个前端 sessionId 对应一个常驻 CLI 会话进程，跨轮复用，运行中可插入消息（steer）。
 *
 * 为什么不用每轮 query()：
 *   query() 是单发模式（一轮一 CLI 进程），中途无法插入消息；
 *   Session API 底层 CLI（>= 2.140.0，bundled 2.158.0）支持 stream-json 的
 *   steer control_request：消息进入 SteerInputBuffer，在「下一次模型请求前」注入，
 *   不打断当前正在执行的工具循环——这正是前端「插话/steer」所需的语义。
 *
 * steer 通道说明（TS SDK 尚未公开，走 transport 内部通道，官方暴露后可替换）：
 *   transport.sendControlRequest({
 *     subtype: "steer",
 *     session_id: <CLI 侧会话 ID>,          // 从 stream 的 system 消息捕获
 *     content_blocks: [{ type: "text", text }],
 *     expected_request_id: <可选，同轮约束>,
 *   })
 *   → { steered: true } | { steered: false, reason: "stale" | "idle" }
 *
 * 注意：TS 的 private 在运行时只是普通属性，因此可以访问 session._transport
 * 与 session.getSessionIdForControl()；SDK 升级可能改名，调用处均有防御。
 */

import { unstable_v2_createSession, unstable_v2_resumeSession, type Session, type SessionOptions } from "@tencent-ai/agent-sdk";
import { slog } from "./debug-log.js";

export type SteerResult = {
  steered: boolean;
  reason?: string;
  response?: unknown;
};

export interface ManagedSession {
  /** 前端会话 ID（registry key，也是 AskUserQuestion 挂起/产物隔离用的 sid） */
  sid: string;
  /** SDK Session 实例（常驻 CLI 进程；Session 接口不含 interrupt/setCanUseTool，调用处断言） */
  session: Session;
  /** CLI 侧会话 ID（从 stream 的 system 消息捕获；steer control_request 需要它） */
  cliSessionId: string | null;
  /** CLI 创建时的 cwd；Session API 不支持在复用时修改它。 */
  cwd: string;
  /** MCP configuration is fixed when the CLI process starts. */
  mcpFingerprint: string;
  /** Tool exposure is fixed when the CLI process starts. */
  allowBash: boolean;
  lastActiveAt: number;
  createdAt: number;
}

const registry = new Map<string, ManagedSession>();

/** 空闲回收：会话超过该时长无任何活动则关闭 CLI 进程，避免常驻进程堆积 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let sweeper: ReturnType<typeof setInterval> | null = null;

export function getManagedSession(sid: string): ManagedSession | undefined {
  const entry = registry.get(sid);
  if (entry) entry.lastActiveAt = Date.now();
  return entry;
}

export function createManagedSession(sid: string, options: SessionOptions, mcpFingerprint = "", allowBash = false, resumeSessionId?: string): ManagedSession {
  const session = resumeSessionId
    ? unstable_v2_resumeSession(resumeSessionId, { ...options })
    : unstable_v2_createSession({ ...options });
  const entry: ManagedSession = {
    sid,
    session: session as Session,
    cliSessionId: null,
    cwd: options.cwd ?? process.cwd(),
    mcpFingerprint,
    allowBash,
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
  };
  registry.set(sid, entry);
  console.log(`[agent-kit] Session 已创建 sid=${sid}（registry=${registry.size}）`);
  slog(sid, "session.created", { registrySize: registry.size }, "info");
  return entry;
}

/** 首轮 stream 的 system 消息会携带 CLI 侧会话 ID，捕获后供 steer 使用（只取第一个） */
export function setCliSessionId(sid: string, cliSessionId: string): void {
  const entry = registry.get(sid);
  if (entry && !entry.cliSessionId) entry.cliSessionId = cliSessionId;
}

export function touchSession(sid: string): void {
  const entry = registry.get(sid);
  if (entry) entry.lastActiveAt = Date.now();
}

/**
 * 运行中插入消息（steer）：走 CLI 2.140.0+ 的 stream-json steer 控制通道。
 * 返回 { steered: true } 表示已进入缓冲，将在下一次模型请求前注入。
 */
export async function steerSession(sid: string, text: string, images: Array<{ base64?: string; media_type?: string }> = []): Promise<SteerResult> {
  const entry = registry.get(sid);
  if (!entry) {
    slog(sid, "steer.reject", { reason: "no_session" }, "warn");
    return { steered: false, reason: "no_session" };
  }
  const session = entry.session as unknown as {
    _transport?: { sendControlRequest?: (payload: unknown) => Promise<unknown> };
    getSessionIdForControl?: () => string | undefined;
  };
  const transport = session._transport;
  if (!transport?.sendControlRequest) {
    slog(sid, "steer.reject", { reason: "no_transport" }, "warn");
    return { steered: false, reason: "no_transport" };
  }
  const cliSessionId = entry.cliSessionId ?? session.getSessionIdForControl?.();
  if (!cliSessionId) {
    slog(sid, "steer.reject", { reason: "no_session_id" }, "warn");
    return { steered: false, reason: "no_session_id" };
  }
  try {
    slog(sid, "steer.request", { cliSessionId, textLen: text.length, text }, "info");
    const resp = (await transport.sendControlRequest({
      subtype: "steer",
      session_id: cliSessionId,
      content_blocks: [{ type: "text", text }, ...images.filter(image => !!image.base64).map(image => ({ type: "image", source: { type: "base64", media_type: image.media_type || "image/png", data: image.base64 } }))],
    })) as { steered?: boolean; reason?: string };
    entry.lastActiveAt = Date.now();
    const steered = resp?.steered === true;
    console.log(
      `[agent-kit] steer sid=${sid} steered=${steered}${steered ? "" : ` reason=${resp?.reason ?? "unknown"}`}`,
    );
    slog(sid, "steer.response", { steered, reason: resp?.reason ?? null, response: resp }, "info");
    return { steered, reason: resp?.reason, response: resp };
  } catch (err) {
    console.error(`[agent-kit] steer 请求异常 sid=${sid}:`, err instanceof Error ? err.message : err);
    slog(sid, "steer.error", { error: err instanceof Error ? err.message : String(err) }, "error");
    return { steered: false, reason: "error" };
  }
}

/** 中断当前轮的模型执行（前端"停止生成"→ request.signal abort → 本函数） */
export async function interruptSession(sid: string): Promise<void> {
  const entry = registry.get(sid);
  if (!entry) return;
  try {
    // Session 接口未声明 interrupt（SessionImpl 才有）；运行时存在，防御性调用
    await (entry.session as unknown as { interrupt(): Promise<void> }).interrupt();
    slog(sid, "session.interrupt", {}, "info");
  } catch (err) {
    console.warn(`[agent-kit] interrupt sid=${sid}:`, err instanceof Error ? err.message : err);
    slog(sid, "session.interrupt.error", { error: err instanceof Error ? err.message : String(err) }, "warn");
  }
}

export function closeSession(sid: string): void {
  const entry = registry.get(sid);
  if (!entry) return;
  try {
    entry.session.close();
  } catch { /* ignore */ }
  registry.delete(sid);
  console.log(`[agent-kit] Session 已关闭 sid=${sid}（registry=${registry.size}）`);
  slog(sid, "session.closed", { registrySize: registry.size }, "info");
}

export function getSessionCount(): number {
  return registry.size;
}

/** 惰性启动空闲回收（Node 环境；.unref 让定时器不阻塞进程退出） */
export function startSessionSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of registry) {
      if (now - entry.lastActiveAt > IDLE_TIMEOUT_MS) {
        console.log(
          `[agent-kit] 回收空闲会话 ${sid}（${Math.round((now - entry.lastActiveAt) / 1000)}s 无活动）`,
        );
        closeSession(sid);
      }
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof (sweeper as NodeJS.Timeout).unref === "function") (sweeper as NodeJS.Timeout).unref();
}
