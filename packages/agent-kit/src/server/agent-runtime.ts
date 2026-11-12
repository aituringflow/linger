/** Agent selection and adapters. One chat can later own several runs. */
import type { SdkConfig } from "./sdk.js";
import { createAgentStream, createAgentSessionStream } from "./sdk.js";
import { createDshStream } from "./providers/dsh.js";
import { createCodexStream } from "./providers/codex.js";
import type { AgentMode, AgentAdapter } from "./agent-contract.js";
export type { AgentMode, AgentAdapter, AgentCapabilities, AgentRequest, AgentMessage } from "./agent-contract.js";

const codebuddy: AgentAdapter = {
  mode: "codebuddy",
  capabilities: { tools: true, images: true, steer: true, questions: true, resume: true },
  stream: ({ messages, signal, config, titleSink }) => config.sessionId
    ? createAgentSessionStream({ messages, signal, config: config as SdkConfig, titleSink })
    : createAgentStream({ messages, signal, config: config as SdkConfig, titleSink }),
};
const codex: AgentAdapter = {
  mode: "codex",
  capabilities: { tools: true, images: true, steer: false, questions: false, resume: true },
  stream: createCodexStream,
};
function pending(mode: "cc" | "dsh"): AgentAdapter {
  return {
    mode,
    capabilities: { tools: false, images: false, steer: false, questions: false, resume: false },
    stream: () => {
      throw new Error(`${mode} 模式尚未实现`);
    },
  };
}
const dsh: AgentAdapter = { mode: "dsh", capabilities: { tools: true, images: true, steer: false, questions: false, resume: true }, stream: createDshStream };
const adapters: Record<AgentMode, AgentAdapter> = { codebuddy, codex, cc: pending("cc"), dsh };

export function getConfiguredAgentModes(): AgentMode[] {
  const raw = process.env.AGENT_PROVIDER?.trim() || "codebuddy";
  const modes = [...new Set(raw.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean))];
  for (const mode of modes) {
    if (!(mode in adapters)) throw new Error(`未知 Agent 模式：${mode}（可选 codebuddy | codex | cc | dsh）`);
  }
  return modes as AgentMode[];
}

export function resolveAgentMode(value?: string): AgentMode {
  const configured = getConfiguredAgentModes();
  const mode = value ?? configured[0];
  if (configured.includes(mode as AgentMode)) return mode as AgentMode;
  throw new Error(`Agent 模式 ${mode} 未在 AGENT_PROVIDER 中配置`);
}
export function getAgentAdapter(mode: AgentMode): AgentAdapter { return adapters[mode]; }

/** Collect the final text from an adapter stream for hosts that do not show incremental output. */
export async function collectAgentText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let streamError = "";
  const consume = (frame: string) => {
    const event = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    let payload: { text?: unknown; error?: unknown };
    try { payload = JSON.parse(data); } catch { return; }
    if (event === "text") answer += String(payload.text ?? "");
    if (event === "error") streamError = String(payload.text ?? payload.error ?? "模型请求失败");
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    reader.releaseLock();
  }
  if (streamError) throw new Error(streamError);
  if (!answer.trim()) throw new Error("模型没有返回内容");
  return answer;
}
