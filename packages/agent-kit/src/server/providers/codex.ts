import { Codex, type ThreadItem, type UserInput } from "@openai/codex-sdk";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentRequest } from "../agent-contract.js";
import { artifactRoot, ARTIFACTS_DIR_NAME, uploadStorageDir, baselineArtifacts, collectArtifacts, ensureSessionDir } from "../artifacts.js";
import { fetchCodexModelOptions, resolveCodexModel } from "../codex-models.js";
import { codexMcpConfig, type AppMcpServers } from "../mcp-config.js";
import { getCodexCliPath } from "../codex-cli.js";
import { appHomePath, declaredAppName } from "../app-home.js";

function codexClient(selection: ReturnType<typeof resolveCodexModel>, mcpServers?: AppMcpServers, memory?: { owner: string; sessionId?: string; explicit?: boolean }, isolated = false): Codex {
  const codexPathOverride = getCodexCliPath();
  // 群 AI 的 CLI 子进程不继承服务端的数据库密码、连接加密主密钥等环境变量。
  const childEnv = isolated ? Object.fromEntries(
    ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "LANG", "CODEX_HOME", "SYSTEMROOT", "WINDIR", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]
      .flatMap(key => process.env[key] == null ? [] : [[key, process.env[key]!]]),
  ) : process.env as Record<string, string>;
  const provider = selection.baseUrl ? {
    config: { model_provider: "agentkit", model_providers: { agentkit: { name: "Agent Kit custom model", base_url: selection.baseUrl, env_key: "AGENT_KIT_CODEX_API_KEY", wire_api: "responses" } } },
    env: { ...childEnv, AGENT_KIT_CODEX_API_KEY: selection.apiKey! } as Record<string, string>,
  } : {};
  const mcp = codexMcpConfig(mcpServers);
  if (memory) {
    mcp.memory = {
      command: process.execPath,
      args: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "memory-stdio.js")],
      env: { AGENT_MEMORY_OWNER: memory.owner, AGENT_MEMORY_SESSION: memory.sessionId ?? "", AGENT_MEMORY_EXPLICIT: memory.explicit ? "1" : "0" },
    };
  }
  return new Codex({ ...(codexPathOverride ? { codexPathOverride } : {}), ...provider,
    ...(isolated && !selection.baseUrl ? { env: childEnv } : {}),
    ...(Object.keys(mcp).length ? { config: { ...(provider.config ?? {}), mcp_servers: mcp } } : {}),
  });
}
const encoder = new TextEncoder();
const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const runLocks = new Set<string>();

function threadFile(sid: string): string {
  const key = createHash("sha256").update(sid).digest("hex");
  // Codex 原生 threadId 是会话恢复状态：app 声明名字时跟应用主目录走（~/.<name>/codex-threads）。
  const root = declaredAppName() ? appHomePath("codex-threads") : path.join(os.homedir(), ".agent-kit", "codex-threads");
  return path.join(root, `${key}.json`);
}
async function readThreadId(sid: string): Promise<string | null> {
  try {
    const data = JSON.parse(await fs.readFile(threadFile(sid), "utf8")) as { threadId?: unknown };
    return typeof data.threadId === "string" ? data.threadId : null;
  } catch { return null; }
}
async function saveThreadId(sid: string, threadId: string): Promise<void> {
  const file = threadFile(sid);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify({ threadId }), { mode: 0o600 });
}

export function createCodexStream({ messages, signal, config }: AgentRequest): ReadableStream<Uint8Array> {
  const sid = config.sessionId;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (sid && runLocks.has(sid)) {
        controller.enqueue(frame("error", { text: "该会话已有正在运行的 Codex 任务" }));
        controller.close();
        return;
      }
      if (sid) runLocks.add(sid);
      const emit = (event: string, data: unknown) => { if (!signal?.aborted) controller.enqueue(frame(event, data)); };
      try {
        if (signal?.aborted) return;
        const last = [...messages].reverse().find((m) => m.role === "user");
        if (!last?.content?.trim()) throw new Error("缺少用户消息");
        const previous = sid && config.resume ? await readThreadId(sid) : null;
        if (!config.codexModelKey || config.codexModelKey === "__codex_default__") await fetchCodexModelOptions();
        const selection = resolveCodexModel(config.codexModelKey);
        // 慢思考（artifactSessionId=群 base）：工作/交付目录=artifacts/<base>，workspace-write 可写；
        // 复核/伴聊（不传 artifactSessionId）：落到各自私有 run 目录，artifacts/<base> 不可写。
        const explicitBase = config.artifactSessionId;
        const artifactDir = config.uploadsSessionId
          ? await ensureSessionDir(explicitBase || sid || "", config.workspaceDir)
          : config.workspaceDir
            ? null
            : explicitBase
            ? await ensureSessionDir(explicitBase, config.workspaceDir)
            : sid
              ? path.join(artifactRoot(), ARTIFACTS_DIR_NAME, sid)
              : null;
        if (artifactDir) await fs.mkdir(artifactDir, { recursive: true });
        const artifactBaseline = explicitBase ? await baselineArtifacts(explicitBase, config.workspaceDir) : null;
        const workingDirectory = config.uploadsSessionId ? artifactDir || process.cwd() : config.workspaceDir || artifactDir || process.cwd();
        // 只读目录：uploads 私有目录（AI 可读不可写）+ 调用方指定只读路径。
        // 群 run 会话自身 uploads 为空，用 uploadsSessionId（群 base sid）指向群附件目录。
        // Codex SDK 的 additionalDirectories 即「附加只读目录」语义（读白名单、写拦截）。
        const uploadsReadOnlyDir = config.uploadsSessionId ? uploadStorageDir(config.uploadsSessionId) : sid ? uploadStorageDir(sid) : "";
        const readOnlyDirs = [...(config.readOnlyPaths ?? []), ...(uploadsReadOnlyDir ? [uploadsReadOnlyDir] : [])].filter(Boolean);
        const options = {
          model: selection.model,
          workingDirectory,
          additionalDirectories: readOnlyDirs,
          sandboxMode: config.permissionMode === "full" ? "danger-full-access" as const : "workspace-write" as const,
          approvalPolicy: config.permissionMode === "full" ? "never" as const : "on-request" as const,
          skipGitRepoCheck: true,
        };
        const client = codexClient(selection, config.mcpServers, config.memoryOwner ? { owner: config.memoryOwner, sessionId: sid, explicit: config.memoryExplicit } : undefined, Boolean(config.uploadsSessionId));
        const thread = previous ? client.resumeThread(previous, options) : client.startThread(options);
        const system = [config.securitySystemPrompt || "", config.systemPrompt || "", ...messages.filter((m) => m.role === "system").map((m) => m.content), artifactDir ? `若需交付文件，请将最终文件放在 ${artifactDir}，并在答复中说明文件名。` : ""].filter(Boolean).join("\n\n");
        // Codex 续接线程不会重新应用首轮拼入的 app 系统提示；业务级每轮规则需再次送入。
        const prompt = previous
          ? (config.systemPrompt ? `${config.systemPrompt}\n\n用户请求：\n${last.content}` : last.content)
          : (system ? `${system}\n\n用户请求：\n${last.content}` : last.content);
        const seen = new Map<string, string>();
        // Codex SDK exposes both commentary and final answers as agent_message.text.
        // Keep the newest message pending until the next action tells us its role:
        // a later message/tool makes it visible process; turn completion makes it final text.
        let pendingMessage: { id: string; text: string } | null = null;
        const flushMessage = (event: "thinking" | "text") => {
          if (pendingMessage?.text) emit(event, { text: pendingMessage.text });
          pendingMessage = null;
        };
        const imagePaths = (config.attachmentPaths ?? (config.attachmentPath ? [config.attachmentPath] : []))
          .map((filePath) => path.resolve(workingDirectory, filePath))
          .filter((filePath) => /\.(?:png|jpe?g|webp|gif)$/i.test(filePath));
        const input: string | UserInput[] = imagePaths.length
          ? [{ type: "text", text: prompt }, ...imagePaths.map((filePath) => ({ type: "local_image" as const, path: filePath }))]
          : prompt;
        const { events } = await thread.runStreamed(input, { signal });
        emit("model_info", { models: [selection.model || "Codex 默认模型"] });
        let failed = false;
        let toolIndex = 0;
        const toolIndices = new Map<string, number>();
        for await (const event of events) {
          if (signal?.aborted) break;
          if (event.type === "thread.started" && sid) await saveThreadId(sid, event.thread_id);
          if (event.type === "item.started" && isToolItem(event.item)) {
            flushMessage("thinking");
            const index = ++toolIndex;
            toolIndices.set(event.item.id, index);
            emitToolStart(event.item, emit, index);
          }
          if (event.type === "item.updated" || event.type === "item.completed") {
            const item = event.item;
            if (item.type === "agent_message") {
              if (pendingMessage && pendingMessage.id !== item.id) flushMessage("thinking");
              pendingMessage = { id: item.id, text: item.text };
            } else if (item.type === "reasoning") {
              const prior = seen.get(item.id) ?? "";
              const delta = item.text.startsWith(prior) ? item.text.slice(prior.length) : item.text;
              seen.set(item.id, item.text);
              if (delta) emit("thinking", { text: delta });
            } else if (event.type === "item.completed") {
              if (isToolItem(item)) flushMessage("thinking");
              const index = toolIndices.get(item.id) ?? ++toolIndex;
              if (!toolIndices.has(item.id)) emitToolStart(item, emit, index);
              emitToolResult(item, emit, index);
            }
          }
          if (event.type === "turn.completed") {
            flushMessage("text");
            emit("cost_info", { usage: event.usage });
          } else if (event.type === "turn.failed" || event.type === "error") {
            flushMessage("thinking");
            failed = true;
            emit("error", { text: event.type === "error" ? event.message : event.error.message });
          }
        }
        if (sid && artifactBaseline) {
          for (const artifact of await collectArtifacts(sid, artifactBaseline, config.workspaceDir)) emit("artifact", artifact);
        }
        if (!failed && !signal?.aborted) emit("done", { text: "" });
      } catch (error) {
        emit("error", { text: error instanceof Error ? error.message : String(error) });
      } finally {
        if (sid) runLocks.delete(sid);
        controller.close();
      }
    },
  });
}

function isToolItem(item: ThreadItem): boolean {
  return item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call" || item.type === "web_search";
}

function emitToolStart(item: ThreadItem, emit: (event: string, data: unknown) => void, index: number): void {
  if (item.type === "command_execution") {
    emit("tool", { index, name: "Command", input: item.command, toolUseId: item.id });
  } else if (item.type === "file_change") {
    emit("tool", { index, name: "FileChange", input: item.changes.map((c) => `${c.kind} ${c.path}`).join("\n"), toolUseId: item.id });
  } else if (item.type === "mcp_tool_call") {
    emit("tool", { index, name: `${item.server}/${item.tool}`, input: JSON.stringify(item.arguments), toolUseId: item.id });
  } else if (item.type === "web_search") {
    emit("tool", { index, name: "WebSearch", input: item.query, toolUseId: item.id });
  }
}

function emitToolResult(item: ThreadItem, emit: (event: string, data: unknown) => void, index: number): void {
  if (item.type === "command_execution") {
    emit("tool_result", { index, toolUseId: item.id, status: item.status === "failed" ? "failed" : "completed", summary: item.aggregated_output.slice(0, 300) });
  } else if (item.type === "file_change") {
    emit("tool_result", { index, toolUseId: item.id, status: item.status === "failed" ? "failed" : "completed", summary: item.changes.map((c) => c.path).join(", ").slice(0, 300) });
  } else if (item.type === "mcp_tool_call") {
    emit("tool_result", { index, toolUseId: item.id, status: item.status === "failed" ? "failed" : "completed", summary: item.error?.message || "" });
  } else if (item.type === "web_search") {
    emit("tool_result", { index, toolUseId: item.id, status: "completed", summary: item.query });
  }
}
