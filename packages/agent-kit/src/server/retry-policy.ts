/**
 * 模型调用重试策略 —— 服务端无界面模块（类似 ui/side-chat.ts 的无界面形态，但位于 server 侧）。
 *
 * 人机聊天现有的兜底是「前端断流重连 + 服务端 fallback model（主模型 429 时 CLI 自动切换）」；
 * 本模块把「对一次可重放调用按失败原因自动重试」参数化为 none / low / high 三级，
 * 供群快思考、群慢思考、伴聊 Chatmate 以及 agent-kit 内部其他模型调用流程复用。
 *
 * 用法：
 *   const answer = await withRetry(() => postAndRead(request), retryPolicy("high", {
 *     onRetry: (attempt, error, delayMs) => slog(sid, "llm.retry", { attempt, error, delayMs }, "warn"),
 *   }));
 *
 * 约定：
 *   - 被重试的 fn 必须可安全重放（从零重建请求，无不可逆副作用）；流式请求整体重放。
 *   - 用户主动取消（AbortError）永不重试。
 *   - 业务上「模型输出不符合要求」（如快思考未按 JSON 输出）属于可重试失败：
 *     调用方抛 RetryableError 即可纳入重试。
 */
export type RetryLevel = "none" | "low" | "high";

export interface RetryPolicy {
  /** 最大尝试次数（含首次）：none=1、low=2、high=4 */
  maxAttempts: number;
  /** 首次重试前的基础延迟 ms；每次翻 backoffFactor 倍，封顶 30s */
  baseDelayMs: number;
  /** 指数退避因子 */
  backoffFactor: number;
  /** 抖动比例 0-1：实际延迟在 [1-jitter, 1+jitter] 区间随机，避免多实例同时重试 */
  jitter: number;
  /** 判断某次失败是否值得重试；返回 false 立即抛出，不消耗剩余次数 */
  retryable: (error: unknown) => boolean;
  /** 每次失败后、等待重试前回调（记日志 / 更新运行状态） */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/** 标记「应当重试」的业务失败（如模型未按约定输出、HTTP 5xx、限流）。 */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

/** 默认可重试判定：RetryableError / 网络错误 / 429 限流 / 5xx / 超时与连接重置；取消与业务校验错误不重试。 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof RetryableError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false; // 用户主动取消，永不重试
  if (error instanceof TypeError) return true; // fetch 网络错误（fetch failed 等）
  return /(?:429|5\d\d|rate\s*[- ]?limit|频率限制|超时|timed?\s*out|socket\s*hang\s*up|ECONNRESET|ETIMEDOUT|fetch\s+failed)/i.test(error.message);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 生成策略：none=不重试；low=1 次重试（适合快思考等对延迟敏感的调用）；high=3 次重试（适合慢思考等产出型调用）。 */
export function retryPolicy(level: RetryLevel, overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  const base: RetryPolicy = level === "none"
    ? { maxAttempts: 1, baseDelayMs: 0, backoffFactor: 2, jitter: 0, retryable: () => false }
    : level === "low"
      ? { maxAttempts: 2, baseDelayMs: 1500, backoffFactor: 2, jitter: 0.3, retryable: isRetryableError }
      : { maxAttempts: 4, baseDelayMs: 1000, backoffFactor: 2, jitter: 0.3, retryable: isRetryableError };
  return { ...base, ...overrides };
}

/** 通用重试执行器：fn 失败且策略判定可重试时按指数退避重试，返回最后一次成功值或抛出最终错误。 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, policy: RetryPolicy): Promise<T> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= policy.maxAttempts || !policy.retryable(error)) throw error;
      const rawDelay = Math.min(30_000, policy.baseDelayMs * policy.backoffFactor ** (attempt - 1));
      const jittered = Math.max(0, Math.round(rawDelay * (1 + (Math.random() * 2 - 1) * policy.jitter)));
      policy.onRetry?.(attempt, error, jittered);
      await sleep(jittered);
    }
  }
}
