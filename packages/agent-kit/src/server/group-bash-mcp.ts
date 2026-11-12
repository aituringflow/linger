import { createSdkMcpServer, tool, type SdkMcpServerResult } from "@tencent-ai/agent-sdk";
import { z } from "zod";
import { execGroupBash, startGroupPreview } from "./group-container.js";

/** A fresh MCP instance is required for each CodeBuddy query. The server owns the group identity. */
export function createGroupBashMcpServer(sessionId: string, basePath: string, previewToken: string, origin: string): SdkMcpServerResult {
  const previewPath = `${basePath}/preview/${previewToken}/`;
  const previewUrl = new URL(previewPath, origin).toString();
  return createSdkMcpServer({
    name: "group-bash",
    version: "1.0.0",
    tools: [tool("group_bash", "在当前群的隔离容器执行 shell 命令。/group/uploads 只读，/group/artifacts 可读写，工作目录为 /group/artifacts。", {
      cmd: z.string().min(1).max(16_000),
    }, async ({ cmd }) => {
      try { return { content: [{ type: "text" as const, text: await execGroupBash(sessionId, cmd) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
    }), tool("start_preview", `启动当前群 AI 创建的应用预览并返回群成员可访问的链接。应用必须监听 0.0.0.0:3000；前端应用需把资源 base path 设为 ${previewPath}。输入启动命令，例如 npm run dev -- --host 0.0.0.0 --port 3000。只有本工具返回的 ${previewUrl} 才是应发给用户的预览链接；容器内 localhost:3000 不是用户链接。`, {
      cmd: z.string().min(1).max(16_000),
    }, async ({ cmd }) => {
      try {
        await startGroupPreview(sessionId, cmd);
        return { content: [{ type: "text" as const, text: `预览已启动，群成员可访问：${previewUrl}` }] };
      } catch (error) { return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] }; }
    })],
  });
}
