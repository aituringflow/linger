/**
 * 桌面端长期记忆的读入口。
 *
 * 只在 Launcher 壳里存在：web 端没有本地模型，也没有本地会话，直接返回 null，
 * 调用方按"这轮不查记忆"处理即可。
 *
 * 真正的工作（意图门、本地向量、服务端召回）都在主进程做，这里只负责把一句话递过去。
 * 开关关着时主进程会立即返回空结果，所以每轮都问一次没有代价——不进模型、不查库、不发请求。
 */

export interface MemoryRecallResult {
  /** 已拼好的上下文文本；没有命中或未开启时为空串。 */
  context?: string;
  gate?: { hit: boolean; score: number; reason: string };
  facts?: Array<{ description: string; validFrom: string | null; validTo: string | null; score: number; entities: string[] }>;
  mode?: "vector" | "structured";
}

type MemoryHost = {
  launcher?: { memoryRecall?: (query: string) => Promise<MemoryRecallResult> };
};

export function memoryRecallApi(): { recall(query: string): Promise<MemoryRecallResult> } | null {
  const host = globalThis as MemoryHost;
  const recall = host.launcher?.memoryRecall;
  if (typeof recall !== "function") return null;
  return { recall: (query: string) => recall(query) };
}

/**
 * 取最后一条用户消息，问一次记忆。
 *
 * 任何异常都吞掉：记忆是加分项，读不到就当这轮没有历史，
 * 不能因为它让整个对话发不出去。
 */
export async function recallMemoryContext(
  api: { recall(query: string): Promise<MemoryRecallResult> } | null,
  messages: Array<{ role: string; content: unknown }>,
): Promise<string> {
  if (!api) return "";
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  if (!text.trim()) return "";
  try {
    const result = await api.recall(text);
    return result?.context?.trim() ?? "";
  } catch {
    return "";
  }
}
