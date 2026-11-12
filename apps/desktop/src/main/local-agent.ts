// 应用身份（AGENT_APP_NAME=linger）必须先在 env 里生效，kit / CLI 才能把数据落到 ~/.linger。
import { APP_HOME_DIR } from "./app-name.js";
import { app } from "electron";
import { readDshKey } from "./dsh-credentials.js";
import { listComputeProviders } from "./compute-providers.js";
import { knowledgeMcpServers } from "./knowledge-base/index.js";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  getAgentAdapter, readArtifact, listSessionArtifacts, ensureSessionDir, byteRange,
  resolvePendingAsk, steerSession, BrowserAgentService,
  attachResumableRun, cancelResumableRun, hasResumableRun, startResumableRun, validRunId,
  createVoiceTokenHandler, createVoiceTranscribeHandler, summarizeSessionTitle,
  type AgentMode, type AgentMessage,
} from "@turingflow/agent-kit";
import { CAPABILITY_INTRO_SYSTEM_PROMPT, CAPABILITY_LIST } from "./capability-intro.js";
import type { LocalReference, LocalReferenceStore } from "./local-references.js";

const validSession = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);

/** Node's Headers type here is not iterable; collect it for http.writeHead. */
function headerRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key] = value; });
  return result;
}

/** Match the model picker's custom models.json when launching the CLI. */
function localModelConfig(model: unknown): Record<string, string> {
  if (typeof model !== "string" || !model) return {};
  const configured = process.env.AGENT_MODELS_PATH?.trim();
  const candidates = [
    ...(configured ? [configured.endsWith(".json") ? configured : path.join(configured, "models.json")] : []),
    path.join(APP_HOME_DIR, "models.json"),
  ];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file || path.basename(file).toLowerCase() !== "models.json") return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { models?: Array<{ id?: string; url?: string }> };
    const selected = parsed.models?.find((entry) => entry.id === model && typeof entry.url === "string");
    if (!selected?.url) return {};
    new URL(selected.url);
    return { CODEBUDDY_CONFIG_DIR: path.dirname(file) };
  } catch { return {}; }
}

async function jsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let value = "";
  for await (const chunk of request) {
    value += String(chunk);
    if (value.length > 4 * 1024 * 1024) throw new Error("请求过大");
  }
  return JSON.parse(value || "{}") as Record<string, unknown>;
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

/** Node 请求 → Web Request：kit 的端点工厂（voice 等）都是 Web 风格签名，直接复用不必重写业务。 */
function toWebRequest(request: http.IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (typeof value === "string") headers.set(key, value);
  }
  const withBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(`http://127.0.0.1${request.url ?? "/"}`, {
    method: request.method,
    headers,
    // multipart 流式透传：FormData 解析交给 undici（手写 multipart 极易踩边界）
    ...(withBody ? { body: Readable.toWeb(request) as unknown as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);
}

/** Web Response → Node 响应。 */
async function sendWebResponse(response: http.ServerResponse, result: Response): Promise<void> {
  const headers: Record<string, string> = {};
  result.headers.forEach((value, key) => { headers[key] = value; });
  response.writeHead(result.status, headers);
  if (!result.body) { response.end(); return; }
  const reader = result.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done || response.destroyed) break;
      if (!response.write(Buffer.from(chunk.value))) await once(response, "drain");
    }
  } finally { reader.releaseLock(); response.end(); }
}

/**
 * Launcher 本地 Agent HTTP 服务（无数据库、无账号体系）：
 *   /chat            SSE 流式对话（getAgentAdapter 直连模型）
 *   /chat/answer     AskUserQuestion 人工回答
 *   /chat/steer      运行中会话插话
 *   /chat/browser-answer  浏览器接管答案
 *   /artifact        会话产物目录读写（落到 <userData>/artifacts/<sid>）
 *   /file-ref        本机文件引用（local-ref://）的字节读取，供渲染层预览图片/文件
 *   /api/voice/token、/api/voice/transcribe  语音听写（复用 kit 端点工厂，ASR 由环境变量决定）
 * 供渲染层 AgentWindow/AgentApp 的 chatEndpoint/artifactEndpoint 复用 kit 完整能力。
 */
export async function startLocalAgentServer(
  artifactRoot: string,
  refs: LocalReferenceStore,
  options?: { onAutoTitle?: (sid: string, title: string, owner?: string) => void; onProviderUnavailable?: (provider: "workbuddy" | "codex" | "dsh") => void },
): Promise<{ url: string; close: () => Promise<void> }> {
  const onAutoTitle = options?.onAutoTitle;
  fs.mkdirSync(artifactRoot, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  // 语音端点：本机无账号体系，令牌里放 guest 主体即可（仅用于校验请求来自本机页面）。
  // persist=1（移动端语音即发送、要把录音存进资料库）在 launcher 里没有 DB，会被 kit 拒绝，
  // 桌面按住说话/点麦克风不会带这个字段，正常走转写。
  const voiceToken = createVoiceTokenHandler({ userResolver: () => ({ userId: "local-guest", name: "本机用户" }) });
  const voiceTranscribe = createVoiceTranscribeHandler();
  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin === "null" || /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin ?? "")) {
      response.setHeader("Access-Control-Allow-Origin", origin!);
      response.setHeader("Access-Control-Allow-Credentials", "true");
      // Authorization 要放行：语音转写带 Bearer 短时令牌（preflight 不带就会被拦）
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    }
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.searchParams.get("token") !== secret) { json(response, 403, { error: "无权访问本机 Agent" }); return; }
    try {
      // 会话自动标题：kit 的 AgentWindow/CoworkPanel 首条消息后会 POST 到这里生成 LLM 标题。
      // 完整 server 有此端点；本机精简服务此前缺失 → 请求 404 → 标题一直是"新任务"/首条截断。
      // 标题生成成功即通过 onAutoTitle 回写 LocalChatStore（重启后侧边栏仍显示生成结果）。
      if (request.method === "POST" && /^\/api\/sessions\/[a-zA-Z0-9_-]{1,128}\/auto-title$/.test(url.pathname)) {
        const sid = url.pathname.split("/")[3];
        if (!validSession(sid)) { json(response, 400, { error: "无效的会话 ID" }); return; }
        const body = await jsonBody(request) as { userMessage?: unknown; agentMode?: unknown; model?: unknown; codexModelKey?: unknown; owner?: unknown };
        const userMessage = typeof body?.userMessage === "string" ? body.userMessage : "";
        if (!userMessage.trim() || userMessage.length > 100_000) { json(response, 400, { error: "缺少用户消息" }); return; }
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<string>((resolve) => {
          timeout = setTimeout(() => { controller.abort(); resolve(""); }, 45_000);
        });
        try {
          const title = await Promise.race([summarizeSessionTitle(userMessage, {
            agentMode: body.agentMode === "codex" ? "codex" : "codebuddy",
            model: typeof body.model === "string" ? body.model : undefined,
            codexModelKey: typeof body.codexModelKey === "string" ? body.codexModelKey : undefined,
            cliExecutable: process.execPath,
            env: { AGENT_APP_NAME: process.env.AGENT_APP_NAME ?? "", ELECTRON_RUN_AS_NODE: "1" },
            signal: controller.signal,
          }), deadline]);
          if (!title) { json(response, 502, { error: "标题生成失败" }); return; }
          onAutoTitle?.(sid, title, typeof body.owner === "string" && body.owner ? body.owner : undefined);
          json(response, 200, { title });
        } catch (error) {
          json(response, 502, { error: error instanceof Error ? error.message : String(error) });
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        return;
      }
      if (url.pathname === "/chat/run" && (request.method === "GET" || request.method === "POST")) {
        const sid = url.searchParams.get("sessionId");
        const runId = url.searchParams.get("runId");
        if (!validSession(sid) || !validRunId(runId)) { json(response, 400, { error: "无效的任务 ID" }); return; }
        if (request.method === "POST") {
          json(response, 200, { ok: await cancelResumableRun(sid, runId) });
          return;
        }
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const replay = await attachResumableRun(sid, runId, after);
        response.writeHead(replay.status, headerRecord(replay.headers));
        if (!replay.body) { response.end(await replay.text()); return; }
        const reader = replay.body.getReader();
        response.on("close", () => { void reader.cancel().catch(() => {}); });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done || response.destroyed) break;
            if (!response.write(Buffer.from(chunk.value))) await once(response, "drain");
          }
        } finally { reader.releaseLock(); response.end(); }
        return;
      }
      if (request.method === "POST" && url.pathname === "/chat") {
        const body = await jsonBody(request);
        const sid = body.sessionId;
        if (!validSession(sid)) { json(response, 400, { error: "无效的会话 ID" }); return; }
        const runId = body.runId;
        if (runId !== undefined && !validRunId(runId)) { json(response, 400, { error: "无效的任务 ID" }); return; }
        if (validRunId(runId) && await hasResumableRun(sid, runId)) {
          const replay = await attachResumableRun(sid, runId);
          response.writeHead(replay.status, headerRecord(replay.headers));
          const reader = replay.body!.getReader();
          response.on("close", () => { void reader.cancel().catch(() => {}); });
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done || response.destroyed) break;
              if (!response.write(Buffer.from(chunk.value))) await once(response, "drain");
            }
          } finally { reader.releaseLock(); response.end(); }
          return;
        }
        const mode = body.agentMode === "dsh" ? "dsh" : body.agentMode === "codex" ? "codex" : "codebuddy";
        const providerId = mode === "codebuddy" ? "workbuddy" : mode;
        const status = (await listComputeProviders()).find((provider) => provider.id === providerId);
        if (!status?.available || !status.authenticated) {
          options?.onProviderUnavailable?.(providerId);
          json(response, 401, { error: status?.error || "该算力提供商尚未登录或无法使用，请到算力设置检查" });
          return;
        }
        const dshKey = mode === "dsh" ? readDshKey() : null;
        if (mode === "dsh" && !dshKey) { json(response, 400, { error: "请先配置 DeepSeek API Key" }); return; }
        const modelEnv = mode === "codebuddy" ? localModelConfig(body.model) : {};
        const original = Array.isArray(body.messages) ? body.messages : [];
        const messages: AgentMessage[] = original.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item) => ({ role: String(item.role ?? ""), content: String(item.content ?? "") }))
          .filter((item) => item.role === "user" || item.role === "assistant" || item.role === "system");
        if (!messages.some((item) => item.role === "user")) { json(response, 400, { error: "缺少用户消息" }); return; }
        // 本轮附件：渲染层只传 local-ref:// 句柄，这里换回绝对路径。
        // 句柄由本机登记表签发（含 machineId），别的机器拷来的句柄解析不到 → 明确报错而不是静默忽略附件。
        const turnAttachments = Array.isArray(body.attachments) ? body.attachments : [];
        const localUrls = turnAttachments
          .map((item) => String((item as { url?: unknown })?.url ?? ""))
          .filter((url) => url.startsWith("local-ref://"));
        const localRefs = localUrls
          .map((url) => refs.resolve(url))
          .filter((item): item is LocalReference => !!item);
        if (localRefs.length !== localUrls.length) { json(response, 409, { error: "本机文件不可用，请重新选择文件" }); return; }
        const folderRefs = localRefs.filter((item) => item.kind === "folder");
        const fileRefs = localRefs.filter((item) => item.kind === "file");
        const referencedFiles = fileRefs.map((ref) => ref.path);
        // 只读引用说明：明确告诉模型这些是外部资料，不是工作空间，别去改原文件。
        const hint = [
          ...folderRefs.map((ref) => `本轮引用本机文件夹：${ref.path}。这是只读资料，不是工作空间；保持当前工作空间不变。按需读取该文件夹，勿预先遍历全部内容。`),
          ...fileRefs.map((ref) => `本轮引用本机文件：${ref.name}，可读取本机路径 ${ref.path}。这是只读引用，不要修改原文件。`),
        ].join("\n");
        if (hint) {
          const last = [...messages].reverse().find((item) => item.role === "user");
          if (last) last.content += `\n\n${hint}`;
        }
        const workspaceDir = refs.workspace(sid) ?? path.join(artifactRoot, sid);
        await fs.promises.mkdir(workspaceDir, { recursive: true });
        // codebuddy 走多模态图片通道：小图直接内联 base64，模型才能真正"看到"图。
        if (mode === "codebuddy" || mode === "dsh") {
          const images = fileRefs.filter((ref) => /\.(?:png|jpe?g|gif|webp)$/i.test(ref.name) && ref.size <= 20 * 1024 * 1024);
          const last = [...messages].reverse().find((item) => item.role === "user");
          if (last && images.length) last.images = await Promise.all(images.map(async (ref) => ({
            base64: (await fs.promises.readFile(ref.path)).toString("base64"),
            media_type: (/\.png$/i.test(ref.name) ? "image/png" : /\.gif$/i.test(ref.name) ? "image/gif" : /\.webp$/i.test(ref.name) ? "image/webp" : "image/jpeg") as "image/png" | "image/gif" | "image/webp" | "image/jpeg",
          })));
        }
        const abort = new AbortController();
        if (!validRunId(runId)) response.on("close", () => abort.abort());
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
        const createStream = (signal: AbortSignal) => getAgentAdapter(mode as AgentMode).stream({
          messages, signal,
          config: {
            sessionId: sid, resume: body.resume === true,
            workspaceDir,
            readOnlyPaths: [...folderRefs.map((ref) => ref.path), ...referencedFiles],
            attachmentPaths: referencedFiles,
            model: typeof body.model === "string" ? body.model : undefined,
            cliExecutable: process.execPath,
            env: { AGENT_APP_NAME: process.env.AGENT_APP_NAME ?? "", ...modelEnv, ELECTRON_RUN_AS_NODE: "1", ...(dshKey ? { DEEPSEEK_API_KEY: dshKey, DSH_HOME: path.join(APP_HOME_DIR, "dsh") } : {}) },
            codexModelKey: typeof body.codexModelKey === "string" ? body.codexModelKey : undefined,
            permissionMode: body.permissionMode === "default" ? "default" : "full",
            allowBash: body.permissionMode !== "default",
            unrestrictedFileAccess: body.permissionMode !== "default",
            // 能力答复：注入 kit 现成的 systemPrompt + capabilities 通道，不改 kit 代码。
            // 用户在聊天中询问系统能力（"你能干什么"等）时，模型按能力答复页原样输出。
            systemPrompt: mode === "dsh" ? "请准确回答用户的问题。没有可用工具时，不要声称已经使用工具或检索过知识库。" : CAPABILITY_INTRO_SYSTEM_PROMPT + "\n\n## 本地知识库使用规则\n用户的本地知识库既收文档（内部资料、审计报告、PPT、表格等），也收**独立图片**（照片、截图，每张都带文字描述）以及按时间索引的视频画面和音轨（音频命中的 modality 为 audio，videoStart/videoEnd 是音轨时间段）。所以「相关的问题」包括：问文档内容、**让用户从自己的资料/照片里找某张图或某个场景**。这类问题**必须先检索知识库**，不要先反问用户「去哪找」——除非知识库里确实没有相关结果。\n\n### 强制流程（必须严格遵守）：\n1. 先用 `local_knowledge` 的 `search_knowledge` 搜索相关片段（找图片时把场景、人物、事件等关键词一起写进 query）\n2. **绝对不能仅凭召回的片段就下结论**——片段是碎片化的，会丢失上下文，导致错误结论\n3. 必须从返回结果中找到最相关文件的 filePath，文档用 `Read` 工具读取完整内容（图片请用 `ViewImage`；视频返回命中时间范围，不能用 Read 读取视频二进制，无法查看时明确说明尚未核实）\n4. 如果涉及多个文件，逐一读取完整内容\n5. 基于完整文件内容综合分析后，再回答\n6. 来源用文件**名称**或知识库名说明即可，不要输出磁盘路径（安全保密要求禁止输出本机路径）\n7. 对用户请求查找视频时，返回最相关候选的 videoMarkdown，原样复制且每条单独一行，不要伪造或修改地址；它们会在答复中呈现可播放卡片。说明这些是尚未经画面核实的候选，未查看不得断言具体内容。\n8. 结果里带 `imageUrl` 的条目，必须用 Markdown `![说明](imageUrl)` 把图片直接内嵌在答复里，图文放在一起；不要只写文件名，也不要用 filePath 拼图片地址\n\n只有当本地知识库没有相关结果时，才回退到网页搜索。",
            mcpServers: knowledgeMcpServers,
            // AgentRunConfig 未声明 capabilities（kit 运行时以 SdkConfig 透传），spread 注入以保持类型通过。
            ...(CAPABILITY_LIST.length ? { capabilities: CAPABILITY_LIST } : {}),
          },
        });
        const stream = validRunId(runId)
          ? (await startResumableRun(sid, runId, createStream)).body!
          : createStream(abort.signal);
        const reader = stream.getReader();
        if (validRunId(runId)) response.on("close", () => { void reader.cancel().catch(() => {}); });
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done || abort.signal.aborted) break;
            if (!response.write(Buffer.from(chunk.value))) await once(response, "drain");
          }
        } finally { reader.releaseLock(); response.end(); }
        return;
      }
      if (request.method === "POST" && url.pathname === "/chat/answer") {
        const body = await jsonBody(request);
        json(response, 200, { ok: validSession(body.sessionId) && body.answers && typeof body.answers === "object"
          ? resolvePendingAsk(body.sessionId, body.answers as Record<string, string>) : false });
        return;
      }
      if (request.method === "POST" && url.pathname === "/chat/steer") {
        const body = await jsonBody(request);
        const result = validSession(body.sessionId) && typeof body.text === "string"
          ? await steerSession(body.sessionId, body.text) : { steered: false, reason: "invalid_request" };
        json(response, 200, { ok: result.steered, reason: result.reason ?? null });
        return;
      }
      if (request.method === "POST" && url.pathname === "/chat/browser-answer") {
        const body = await jsonBody(request);
        json(response, 200, { ok: typeof body.sessionId === "string" && typeof body.text === "string"
          ? BrowserAgentService.get().input(body.sessionId, body.text) : false });
        return;
      }
      // 语音听写：kit 的端点工厂是 Web Request/Response 签名，这里做一层 Node 适配，
      // 业务（令牌签发/校验、multipart 解析、ASR 转发、错误文案）全部复用 kit，不再另写一份。
      if (request.method === "POST" && url.pathname === "/api/voice/token") {
        await sendWebResponse(response, await voiceToken.POST(toWebRequest(request)));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/voice/transcribe") {
        await sendWebResponse(response, await voiceTranscribe.POST(toWebRequest(request)));
        return;
      }
      if (request.method === "GET" && url.pathname === "/artifact") {
        const sid = url.searchParams.get("session");
        if (!validSession(sid)) { json(response, 400, { error: "无效的会话 ID" }); return; }
        const workspace = path.join(artifactRoot, sid);
        if (url.searchParams.has("list")) { json(response, 200, { artifacts: await listSessionArtifacts(sid, workspace) }); return; }
        if (url.searchParams.has("dir")) { json(response, 200, { dir: await ensureSessionDir(sid, workspace) }); return; }
        const file = url.searchParams.get("file") ?? "";
        const result = await readArtifact(sid, file, workspace);
        if (!result) { json(response, 404, { error: "文件不存在" }); return; }
        const headers: Record<string, string> = { "Content-Type": result.mime, "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
        const range = url.searchParams.has("download") ? null : byteRange(result.buf, request.headers.range);
        if (range === "unsatisfiable") {
          response.writeHead(416, { ...headers, "Content-Range": `bytes */${result.buf.length}` });
          response.end();
        } else if (range) {
          response.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${result.buf.length}`, "Content-Length": String(range.body.length) });
          response.end(range.body);
        } else {
          response.writeHead(200, headers);
          response.end(result.buf);
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/file-ref") {
        // 渲染层预览：AgentWindow.resolveFileUrl 把 local-ref:// 句柄拼成 /file-ref?ref=…
        const ref = refs.resolve(url.searchParams.get("ref") ?? "");
        if (!ref || ref.kind !== "file") { json(response, 404, { error: "本机文件不可用" }); return; }
        const ext = path.extname(ref.name).toLowerCase();
        const mime: Record<string, string> = {
          ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
          ".pdf": "application/pdf", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
          ".html": "text/html; charset=utf-8",
        };
        response.writeHead(200, {
          "Content-Type": mime[ext] ?? "application/octet-stream",
          "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(ref.name)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          // 本机 HTML 只做静态预览，禁止其拿到同源权限（否则可以反过来读本机任意文件）。
          ...(ext === ".html" ? { "Content-Security-Policy": "sandbox" } : {}),
        });
        fs.createReadStream(ref.path).pipe(response);
        return;
      }
      json(response, 404, { error: "not_found" });
    } catch (error) {
      if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}?token=${secret}`,
    close: () => new Promise((resolve) => server.close(() => resolve())) };
}
