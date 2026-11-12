import { createSdkMcpServer, tool } from "@tencent-ai/agent-sdk";
import { z } from "zod";

const policy = z.enum(["mentions_only", "cautious", "balanced", "proactive", "custom"]);
const fields = { name: z.string().min(1).max(80), prompt: z.string().max(20000), replyPolicy: policy, speakingPrompt: z.string().max(8000).optional() };

/** The caller is bound to a real group message and its authenticated sender. */
export function createCoworkAgentMcpServer(
  execute: (method: "GET" | "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) => Promise<unknown>,
) {
  const result = async (method: "GET" | "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await execute(method, body)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
  };
  return createSdkMcpServer({ name: "group-agents", version: "1.0.0", tools: [
    tool("list_agents", "列出本群 AI，编辑和删除时先用此工具取得准确的 AI ID。", {}, async () => result("GET")),
    tool("create_agent", "根据管理员的描述创建群 AI。你需拟定名称、独立角色提示词、发言方式及必要的发言补充指令。发言方式：mentions_only 仅@；cautious 谨慎；balanced 适时；proactive 积极；custom 自定义。创建后群 AI 列表自动刷新。", fields,
      async input => result("POST", input)),
    tool("edit_agent", "编辑本群已有 AI。只传管理员要求更改的字段；提示词和发言方式可一起修改。", { id: z.string().min(1), name: fields.name.optional(), prompt: fields.prompt.optional(), replyPolicy: policy.optional(), speakingPrompt: fields.speakingPrompt.optional(), enabled: z.boolean().optional() },
      async input => result("PATCH", input)),
    tool("delete_agent", "删除指定群 AI。先核对准确 ID；默认 AI 不可删除。", { id: z.string().min(1) }, async input => result("DELETE", input)),
  ] });
}
