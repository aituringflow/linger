/** Codex CLI 的本地 MCP 入口。每轮由服务端以当前登录用户身份启动。 */
import { createInterface } from "node:readline";
import { saveMemory, listMemories, deleteMemory } from "./memory.js";
import { listFilesByOwner } from "./auth/db.js";
import { readMemoryFileText } from "./memory-file-text.js";

const owner = process.env.AGENT_MEMORY_OWNER || "";
const sessionId = process.env.AGENT_MEMORY_SESSION || undefined;
const explicit = process.env.AGENT_MEMORY_EXPLICIT === "1";
type Rpc = { id?: string | number; method?: string; params?: Record<string, unknown> };
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const descriptor = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});
const tools = [
  descriptor("save", "仅当当前用户明确要求长期记住或更正信息时保存记忆；更正传 id。", {
    content: { type: "string" }, category: { type: "string", enum: ["preference", "fact", "instruction", "resource"] },
    fileIds: { type: "array", items: { type: "string" } }, id: { type: "string" },
  }, ["content", "category"]),
  descriptor("list", "列出当前用户的长期记忆，识别要更正或删除的 ID。", {}),
  descriptor("read_file", "从记忆文件快照提取 PDF、Word 或文本正文，无需搜索磁盘。", { memoryId: { type: "string" }, fileId: { type: "string" } }, ["memoryId", "fileId"]),
  descriptor("delete", "用户明确要求忘记时按 ID 删除记忆。", { id: { type: "string" } }, ["id"]),
  descriptor("find_files", "用户要求记住已上传文件时按文件名查找文件 ID。", { query: { type: "string" } }, ["query"]),
];

async function handle(msg: Rpc): Promise<unknown> {
  if (msg.method === "initialize") return { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "agent-memory", version: "1.0.0" } };
  if (msg.method === "ping") return {};
  if (msg.method === "tools/list") return { tools };
  if (msg.method !== "tools/call") throw new Error(`Unknown method: ${msg.method}`);
  if (!owner) throw new Error("Missing authenticated owner");
  const name = String(msg.params?.name ?? "");
  const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
  let result: unknown;
  if (name === "list") result = { memories: await listMemories(owner) };
  else if (name === "read_file") result = await readMemoryFileText(owner, String(args.memoryId ?? ""), String(args.fileId ?? ""));
  else if (name === "find_files") result = { files: (await listFilesByOwner(owner, { q: String(args.query ?? ""), limit: 20 })).map((f) => ({ id: f.id, name: f.name, kind: f.kind, sessionId: f.sessionId })) };
  else if (!explicit) result = { error: "当前用户没有明确要求修改记忆" };
  else if (name === "save") result = { memory: await saveMemory(owner, args, typeof args.id === "string" ? args.id : undefined, sessionId) };
  else if (name === "delete") result = { deleted: await deleteMemory(owner, String(args.id ?? "")) };
  else throw new Error(`Unknown tool: ${name}`);
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  let msg: Rpc;
  try { msg = JSON.parse(line) as Rpc; } catch { continue; }
  if (msg.id === undefined) continue;
  try { send({ jsonrpc: "2.0", id: msg.id, result: await handle(msg) }); }
  catch (e) { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }); }
}
