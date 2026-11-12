import { DeepSeekHarness, type HarnessNotification, type SdkPromptContentBlock } from "@deepseek-ai/dsh-sdk-client";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRequest } from "../agent-contract.js";

const encoder = new TextEncoder();
const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const active = new Set<string>();

/** SDK transport for an isolated DSH session. Unsupported host integrations must be
 * connected before this adapter can replace the CodeBuddy implementation. */
export function createDshStream({ messages, signal, config }: AgentRequest): ReadableStream<Uint8Array> {
  const sessionId = config.sessionId || randomUUID();
  return new ReadableStream({
    async start(controller) {
      const emit = (type: string, data: unknown) => { if (!signal?.aborted) controller.enqueue(frame(type, data)); };
      if (active.has(sessionId)) { emit("error", { text: "该会话已有正在运行的 DeepSeek Harness 任务" }); controller.close(); return; }
      active.add(sessionId);
      let harness: DeepSeekHarness | undefined;
      const abort = () => { void harness?.close().catch(() => {}); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) return;
        const last = [...messages].reverse().find((message) => message.role === "user");
        if (!last?.content.trim()) throw new Error("缺少用户消息");
        if (!config.env?.DEEPSEEK_API_KEY) throw new Error("请先配置 DeepSeek API Key");
        const inherited = ["PATH", "HOME", "USER", "TMPDIR", "TMP", "TEMP", "LANG", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA"];
        const env: NodeJS.ProcessEnv = Object.fromEntries(inherited.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
        env.DEEPSEEK_API_KEY = config.env.DEEPSEEK_API_KEY;
        if (config.env.DSH_HOME) env.DSH_HOME = config.env.DSH_HOME;
        if (config.env.DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL = config.env.DEEPSEEK_BASE_URL;
        env.DSH_TELEMETRY_DISABLED = "1";
        if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
        harness = new DeepSeekHarness({ cwd: config.workspaceDir, dshHome: env.DSH_HOME, env, model: config.model || "deepseek-flash" });
        if (signal?.aborted) return;
        const marker = env.DSH_HOME ? path.join(env.DSH_HOME, "agent-kit-sessions", createHash("sha256").update(sessionId).digest("hex")) : undefined;
        const hasSession = marker ? await readFile(marker).then(() => true, () => false) : false;
        const session = hasSession && config.resume ? await harness.resumeSession(sessionId) : harness.session(sessionId);
        const prior = !hasSession ? messages.filter((message) => message !== last && (message.role === "user" || message.role === "assistant")).map((message) => `${message.role === "user" ? "用户" : "助手"}：${message.content}`).join("\n\n") : "";
        const text = [config.systemPrompt, ...messages.filter((message) => message.role === "system").map((message) => message.content), prior ? `此前对话：\n${prior}` : "", last.content].filter(Boolean).join("\n\n");
        const content: SdkPromptContentBlock[] = [{ type: "text", text }];
        for (const image of last.images || []) if (image.base64 && image.media_type) content.push({ type: "image", data: image.base64, mimeType: image.media_type });
        const indices = new Map<string, number>();
        const notify = (notification: HarnessNotification) => {
          if (notification.method !== "session.event" || notification.params.sessionId !== sessionId) return;
          const event = notification.params.event as { type?: string; data?: Record<string, any> } | undefined;
          const data = event?.data;
          if (!data) return;
          if (event?.type === "tool/call") {
            const id = String(data.callId); const index = indices.size + 1; indices.set(id, index);
            emit("tool", { index, name: data.name, input: data.arguments, toolUseId: id });
          } else if (event?.type === "tool/result") {
            const message = data.message as { toolCallId?: string; isError?: boolean; content?: unknown };
            const id = String(message?.toolCallId ?? "");
            emit("tool_result", { index: indices.get(id), toolUseId: id, status: message?.isError ? "failed" : "completed", summary: JSON.stringify(message?.content ?? "").slice(0, 300) });
          } else if (event?.type === "assistant/message") {
            for (const block of data.message?.content ?? []) if (block.type === "reasoning" && block.text) emit("thinking", { text: block.text });
          }
        };
        emit("model_info", { models: [config.model || "deepseek-flash"] });
        const result = await session.run(content, { onNotification: notify });
        if (result.finishReason === "error") throw new Error(result.finalResponse || "DeepSeek Harness 运行失败");
        if (marker) { await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 }); await writeFile(marker, "1", { mode: 0o600 }); }
        if (result.finalResponse) emit("text", { text: result.finalResponse });
        emit("done", { text: "" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "DeepSeek Harness 运行失败";
        const key = config.env?.DEEPSEEK_API_KEY;
        emit("error", { text: key ? message.split(key).join("[已隐藏]") : message });
      } finally {
        signal?.removeEventListener("abort", abort);
        await harness?.close().catch(() => {});
        active.delete(sessionId);
        controller.close();
      }
    },
  });
}
