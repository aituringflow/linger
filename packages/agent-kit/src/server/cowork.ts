/** Group chat transport. Deliberately separate from the single-user run journal. */
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AI_DISPLAY_NAME, getAppDisplayName, setAppDisplayName } from "./names.js";
import { verifySession } from "./auth/handlers.js";
import { pushCoworkMessage } from "./web-push.js";
import { loadAuthConfig } from "./auth/config.js";
import { ensureMigrated, getAgentSession, getFileById, getPool, listAgentMessagesSince, notifySessionMessage, revokeAgentMessage, unhideAgentSession, promoteCoworkAdmin, demoteCoworkAdmin } from "./auth/db.js";
import { getConfiguredAgentModes } from "./agent-runtime.js";
import { attachInternalCoworkAgentTools, markInternalCoworkRequest, type createAgentApiRoute } from "./handlers.js";
import { createCoworkAgentMcpServer } from "./cowork-agent-mcp.js";
import { slog } from "./debug-log.js";
import { uploadStorageDir, resolveUploadPath, baselineArtifacts, collectArtifacts, capArtifactsForMessage, type ArtifactChange, type ArtifactStamp } from "./artifacts.js";
import { readFileBytes } from "./file-store.js";
import { retryPolicy, withRetry, RetryableError } from "./retry-policy.js";
import { extractDocumentText } from "./memory-file-text.js";
import { renderPdfPageImages } from "./pdf-text.js";
import type { ImageSpec } from "./sdk.js";
import { steerSession } from "./sdk.js";
import { interruptSession } from "./session-store.js";
import { GROUP_EMOJIS, isGroupEmoji } from "./cowork-emoji.js";
import { completeGroupBash, ensureGroupContainer, execGroupBashTerminal, groupPreviewOrigin, removeGroupContainer, startGroupPreview } from "./group-container.js";

type AgentRoute = ReturnType<typeof createAgentApiRoute>;
type CoworkAgent = { id: string; name: string; prompt: string; enabled: boolean; createdBy: string; replyPolicy: ReplyPolicy; speakingPrompt: string };
const secretKey = () => {
  const raw = process.env.COWORK_SECRET_KEY?.trim();
  if (!raw) return createHash("sha256").update("turingflow:cowork-connections:default-key:v1").digest();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(raw)) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
};
const encryptSecret = (plain: string, key: Buffer) => {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const payload = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), payload]).toString("base64");
};
const json = (data: unknown, status = 200) => Response.json(data, { status });
const cleanTitle = (value: unknown) => typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : AI_DISPLAY_NAME;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const defaultFastPrompt = "明确要求 AI 回答或做事时必须回应。单独说“大家好”或群聊开场说“Hi”“你好”时礼貌简短回应。适时发言要克制：没有点名或明确邀请 AI 的普通问句，优先理解为对群成员说的，不要代答；即使 AI 知道答案，也不代表轮到 AI 发言。仅发现会影响当前讨论的明显误解、关键遗漏或卡住的决策时，才主动用一两句澄清。无需深度推理或工具的任务直接答复，完整保留回答内容；不能按输出长短决定是否交给慢思考。";
const defaultPromptForPolicy = (policy: ReplyPolicy) => policy === "proactive"
  ? "积极参与群聊。有人打招呼时礼貌回应；看到有用的建议、重要遗漏或可推进讨论的问题时主动简短发言，但不要连续刷屏。无需深度推理或工具的任务直接答复，完整保留回答内容；不要按输出长短分流。"
  : policy === "cautious" ? "谨慎发言：明确要求 AI 回答或做事时必须回应；没有点名或明确邀请 AI 时，默认保持沉默，包括普通问句、闲聊和打招呼。仅当当前讨论存在已能确认的重大事实错误或紧迫风险，且不立即提醒会影响正在进行的决定时，才主动用一两句指出；拿不准就不插话。无需深度推理或工具的请求直接完整回答，需要查证或执行时交给慢思考。"
  : policy === "mentions_only" ? "只在消息明确 @Agent 或 @所有人 时回答。无需深度推理或工具的任务直接答复，完整保留回答内容；不要按输出长短分流。"
  : defaultFastPrompt;
const promptForAgent = (agent: Record<string, unknown>) => {
  const policy = isReplyPolicy(agent.replyPolicy) ? agent.replyPolicy : "mentions_only";
  const saved = (agent.promptByPolicy as Record<string, unknown> | undefined)?.[policy];
  if (policy !== "custom") {
    // A named AI may have its own role prompt alongside a built-in speaking policy.
    if (typeof saved === "string" && saved.trim() && !String(agent.id).endsWith(":default")) return saved;
    return defaultPromptForPolicy(policy).replaceAll("@Agent", `@${String(agent.name)}`);
  }
  return typeof saved === "string" ? saved : "";
};
type ReplyPolicy = "balanced" | "cautious" | "proactive" | "mentions_only" | "custom";
const isReplyPolicy = (value: unknown): value is ReplyPolicy => value === "balanced" || value === "cautious" || value === "proactive" || value === "mentions_only" || value === "custom";
const isAgentManagementRequest = (content: string) =>
  /(?:创建|添加|新增|编辑|修改|删除|移除|配置).{0,100}(?:群\s*AI|AI|agent|助手|机器人)|(?:群\s*AI|AI|agent|助手|机器人).{0,100}(?:创建|添加|新增|编辑|修改|删除|移除|配置)/iu.test(content);

// —— 伴聊（Chatmate）主提示词：内置默认值，可按 群(session)×用户(user_sub) 自定义覆盖 ——
// JSON 输出契约由系统始终强制追加（无论是否自定义），保证 parseChatmateAnswer 稳定；
// 用户自定义部分只覆盖「人设 / 行为主体」，不允许破坏输出格式。
const CHATMATE_OUTPUT_CONTRACT = `最终只输出 JSON：{"reasoning":"私下的判断和依据","reply":"可直接发到群里的第一人称回复，暂不需发则为空","tasks":[{"title":"具体任务","instruction":"具体研究指令"}],"reaction":{"messageId":123,"emoji":"👍"},"blocker":{"decision":"ask_group 或 stop","reason":"缺少什么、为何不能继续","question":"只有 ask_group 时填写"}}。无任务用空数组，无表情回应用 null，无缺口用 blocker:null。若有 blocker，tasks 必须为空；问群时 reply 只包含该具体问题，自行停止时 reply 为空。若有 tasks，reply 只能是简短、明确的当前进展，不能是空泛承诺；任务完成后系统会继续汇报。若确无待办且不该回复，reply 为空。JSON 中所有文本字段（reasoning、reply、tasks 的 title/instruction/result、blocker 的 reason/question）一律用纯文本，不使用任何 Markdown 语法（不加粗、不写标题、不用列表符号或代码块），像人发的消息。JSON 外不要输出文字。`;
/** 内置默认伴聊主提示词主体；name=当前群成员名，lastBlockerText=上次未解决缺口（无则"无"）。 */
function buildDefaultChatmateSystem(name: string, lastBlockerText: string): string {
  return `你是“伴聊 · Chatmate”，此刻你就是群成员 ${name} 在群里的代理身份。历史中标成“${name}（我）”的消息是你已经说过的话；其他成员对 ${name} 说的“你”指的是你。他们交给 ${name} 的查阅、分析或准备任务，也交给了你。不要等待 ${name} 或让他替你执行。你可能处于自动回复模式，群消息由系统发送；不要声称已经发送。
先检查你已经作出的承诺和待办。能立即查证的先查证；需要分步阅读文档、研究、比较、制作方案或耗时核查时，生成 1–3 个可独立执行的 tasks，系统会按顺序继续执行并把每一步有实质内容的进展发到群里。只列必要任务，完成后停止，不要自行生成下一批。任务必须写明要检查的材料、问题和期望产物。不能只说“我去看看”“稍后整理”就结束；也不能在未完成时声称已经完成。附件提供正文或页面图像时直接阅读；无法取得的内容说明限制。近期事实要用网页工具查证。普通闲聊无需造任务。
从自己的第一人称写自然回复。一律用纯文本，不使用任何 Markdown 语法：不加粗、不斜体、不写标题、不用井号/短横线/星号/反引号等标记、不写代码块或表格；只靠自然换行分段，读起来像人直接在群里发的消息。若触发消息是 @${name} 或明确点名 ${name} 处理的，答复开头 @ 对方成员名字（如 @张三 ），对方名字以群成员名单为准。内联 emoji 默认不用，仅在语境非常贴切、确实增加表达时才用，绝不每句结尾例行加笑脸或点赞。单纯赞同、鼓励或致谢时，优先使用 reaction 对对方具体消息作一个合适的表情回应，并留空 reply；reaction.messageId 必须是历史中真实存在的对方消息编号。需要实质回答时直接写文字，通常不加 reaction。
缺少完成任务必需的信息时，先判断群成员是否合理地可能掌握：可能掌握则设置 blocker.decision="ask_group"，question 写一个明确、可回答的问题，只问一次并暂停任务；不大可能掌握且自己也无法查到时，设置 blocker.decision="stop"，说明缺口并停止，不要追问或重复尝试。若新消息未补足上次已提出的缺口，不要再次提问或重启同一研究。上次缺口：${lastBlockerText}。`;
}
/** 自定义提示词占位插值：${name}=当前成员名，${lastBlocker}=上次缺口；其余原样保留。 */
function applyChatmatePromptPlaceholders(custom: string, name: string, lastBlockerText: string): string {
  return custom.replaceAll("${name}", name).replaceAll("${lastBlocker}", lastBlockerText);
}
/** 组装最终主 system：自定义非空则用自定义主体并强制追加输出契约，否则用完整内置默认。 */
function buildChatmateSystem(customPrompt: string | null | undefined, name: string, lastBlockerText: string): string {
  const custom = typeof customPrompt === "string" ? customPrompt.trim() : "";
  if (!custom) return `${buildDefaultChatmateSystem(name, lastBlockerText)}\n${CHATMATE_OUTPUT_CONTRACT}`;
  return `${applyChatmatePromptPlaceholders(custom, name, lastBlockerText)}\n\n${CHATMATE_OUTPUT_CONTRACT}`;
}
/** 供前端设置面板初始化的内置默认提示词全文（未自定义时填入输入框）。 */
const DEFAULT_CHATMATE_PROMPT = `${buildDefaultChatmateSystem("我", "无")}\n${CHATMATE_OUTPUT_CONTRACT}`;

type GroupAttachment = { url: string; name: string; fileId?: string; size?: number };
export function groupAttachments(value: unknown, sessionId: string): GroupAttachment[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const source = item as Partial<GroupAttachment>;
    if (typeof source.url !== "string") return [];
    try {
      const url = new URL(source.url, "http://local");
      const name = url.searchParams.get("name");
      if (url.origin !== "http://local" || url.pathname !== "/api/upload" || url.searchParams.get("session") !== sessionId ||
        !name || name !== path.basename(name) || name.includes("\\")) return [];
      return [{ url: source.url, name: typeof source.name === "string" ? source.name : name, fileId: source.fileId, size: source.size }];
    } catch { return []; }
  });
}
async function groupAttachmentContext(sessionId: string, attachments: GroupAttachment[]): Promise<{ text: string; images: ImageSpec[] }> {
  const parts: string[] = [];
  const images: ImageSpec[] = [];
  for (const attachment of attachments) {
    const name = new URL(attachment.url, "http://local").searchParams.get("name")!;
    let bytes: Buffer;
    try {
      const file = await resolveUploadPath(sessionId, name);
      const stored = !file && attachment.fileId ? await readFileBytes(attachment.fileId) : null;
      if (!file && !stored) throw new Error("attachment file not found");
      bytes = file ? await fs.readFile(file) : stored!;
    }
    catch { parts.push(`[附件] ${attachment.name}（服务端文件暂时无法读取）`); continue; }
    const ext = path.extname(name).toLowerCase();
    const mediaType = ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp" } as Record<string, ImageSpec["media_type"]>)[ext];
    if (mediaType) {
      if (bytes.length <= 10 * 1024 * 1024) {
        parts.push(`[附件] ${attachment.name}（已作为图片提供给模型）`);
        images.push({ base64: bytes.toString("base64"), media_type: mediaType });
      } else parts.push(`[附件] ${attachment.name}（图片超过视觉输入上限，需要慢思考读取原文件）`);
    } else {
      try {
        const extracted = await extractDocumentText(bytes, name);
        parts.push(`[附件] ${attachment.name}\n<附件正文：${attachment.name}>\n${extracted.text}\n</附件正文>${extracted.truncated ? "\n正文过长，此处仅包含前 40000 字；需要全文时交给慢思考读取原文件。" : ""}`);
      } catch {
        parts.push(`[附件] ${attachment.name}（已上传到服务端；需要读取原文件时交给慢思考）`);
      }
    }
  }
  return { text: parts.join("\n\n"), images };
}

export function greetingReply(text: string, isOpening: boolean): string | null {
  const greeting = text.trim().replace(/[\s，,。.!！?？～~]+$/gu, "").toLocaleLowerCase();
  if (greeting === "大家好") return "大家好！";
  if (isOpening && /^(hi|hello|嗨|你好|你们好)$/u.test(greeting)) return "大家好！";
  return null;
}

export function parseFastDecision(text: string): { decision: "silent" | "reply" | "delegate" | "review" | "react"; answer: string; messageId?: number; emoji?: string } {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, end + 1)) as { decision?: unknown; answer?: unknown; messageId?: unknown; emoji?: unknown };
          if (value.decision !== "silent" && value.decision !== "reply" && value.decision !== "delegate" && value.decision !== "review" && value.decision !== "react") break;
          return { decision: value.decision, answer: typeof value.answer === "string" ? value.answer : "",
            ...(value.messageId != null ? { messageId: Number(value.messageId) } : {}),
            ...(typeof value.emoji === "string" ? { emoji: value.emoji } : {}) };
        } catch { /* Continue to the next candidate object. */ }
        break;
      }
    }
  }
  throw new Error("快思考未返回 JSON 决策");
}

export function shouldReviewFastDecision(decision: "silent" | "reply" | "delegate" | "review" | "react", policy: ReplyPolicy, mustReply: boolean, greeting: string | null): boolean {
  return decision === "review" || decision === "delegate" || (decision === "reply" && !mustReply && (policy === "cautious" || (policy === "balanced" && !greeting)));
}

/** Past-action questions without an AI addressee are usually for another group member. */
export function isHumanDirectedFollowup(content: string, agentTitle: string): boolean {
  if (new RegExp(`(?:@\\s*)?${agentTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|(?:AI|助手|机器人)`, "i").test(content)) return false;
  return /(?:昨天|前天|上周|刚才|之前).*(?:了吗|了没|过吗|过没|有没有)/u.test(content);
}

/** 任务型/命令式消息（延续 AI 刚完成的工作等）：快思考失败时据此决定交给慢思考，而不是静默。 */
export function isTaskDirected(content: string): boolean {
  return /^(?:把|请|帮|存|写|做|改|建|创建|生成|输出|翻译|总结|继续|换|用|加|删除|查|画)/u.test(content.trim());
}

async function readCoworkText(body: ReadableStream<Uint8Array>, onEvent?: (event: string, payload: Record<string, unknown>, answer: string) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const event = block.match(/^event:\s*(.+)$/m)?.[1];
      const data = block.match(/^data:\s*(.+)$/m)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (event === "error") throw new Error(String(payload.text ?? "快思考模型错误"));
      if (event === "text") answer += String(payload.text ?? "");
      onEvent?.(event, payload, answer);
    }
    if (done) break;
  }
  return answer.trim();
}

/* ---- 服务端推送（SSE）：用一条长连接取代客户端高频轮询 /state。
   单实例内用进程级订阅表广播；多实例部署可替换为 Redis pub/sub，接口不变。 ---- */
type RunStep = { thinking?: string; text?: string; tool?: { name: string; input?: string; activity?: string; edit?: unknown; toolUseId?: string; status?: string; result?: string }; secs?: number | null;
  browser?: { id: string; screenshots: string[]; actions: Array<{ step: number; action: string; params?: Record<string, unknown> }>; thinking?: string; ask?: { step: number; question: string } | null; status?: string; finalSummary?: string } };
type RunPush = { id: string; agentId?: string; status: string; content: string; steps?: RunStep[]; elapsedSecs?: number | null; startedAt?: string; error?: string | null };
type MessagePush = {
  id: number; role: string; content: string; senderSub?: string | null; senderName?: string | null;
  clientMessageId?: string | null;
  senderAvatar?: string | null; createdAt?: string | null; replyToId?: number | null; runId?: string | null;
  attachment?: unknown;
  forwardedBundle?: unknown;
  steps?: unknown; elapsedSecs?: number | null;
  /** 用户语音消息 { fileId, durationMs, mimeType } */
  voice?: unknown;
  /** 本轮产物变更清单（added/modified），群聊 AI 消息据此渲染「查看产出物 / 查看变更」 */
  artifacts?: unknown;
};
type CoworkPush =
  | { kind: "message"; message: MessagePush }
  | { kind: "revoked"; messageId: number; revokedAt: string }
  | { kind: "run"; run: RunPush | null }
  | { kind: "agent"; runId: string; event: string; data: Record<string, unknown> }
  | { kind: "fast"; runId: string; agentId: string; content: string; status: string; steps: RunStep[]; elapsedSecs: number; phase: "initial" | "review" }
  | { kind: "reactions"; reactions: Array<{ message_id: number; user_sub: string; user_name: string | null; emoji: string }> }
  | { kind: "agents" }
  | { kind: "admins" }
  | { kind: "preview"; agentId: string; url: string; requesterSub?: string }
  | { kind: "settings"; settings: { title: string; cowork_avatar: string; cowork_mode: string; cowork_model: string | null; cowork_codex_model: string | null; cowork_reply_policy: ReplyPolicy; cowork_fast_prompt: string } | null; ownerSub: string; ownerName?: string; ownerAvatar?: string };
const coworkSubscribers = new Map<string, Set<(event: CoworkPush) => void>>();
const realtimeWrites = new Map<string, Promise<void>>();
async function retryDeadlock<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if ((error as { code?: string }).code !== "40P01" || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}
const activeFastRuns = new Map<string, { runId: string; agentId: string; phase: "initial" | "review" }>();
const fastSteerQueues = new Map<string, Promise<void>>();
const activeChatmateRuns = new Map<string, { id: string; sessionId: string; controller: AbortController; stopped: boolean; finished: Promise<void> }>();
const chatmateQueues = new Map<string, Promise<void>>();
const chatmateManualMessageCutoffs = new Map<string, number>();
const CHATMATE_TASKS_PER_TURN_LIMIT = 3;
const CHATMATE_TURN_TIMEOUT_MS = 60 * 60_000;
const chatmateSessionId = (sessionId: string, userSub: string) => `${sessionId}_cowork_chatmate_${createHash("sha256").update(`acting-v3:${userSub}`).digest("hex").slice(0, 32)}`;
const chatmateSender = (message: MessagePush) => message.senderName || (message.role === "assistant" ? AI_DISPLAY_NAME : "成员");
type ChatmateTask = { title: string; instruction: string; status: "pending" | "running" | "done" | "error" | "blocked" | "skipped"; result?: string; error?: string };
type ChatmateReaction = { messageId: number; emoji: string };
type ChatmateBlocker = { decision: "ask_group" | "stop"; reason: string; question?: string };
function parseChatmateBlocker(value: unknown): ChatmateBlocker | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.decision !== "ask_group" && item.decision !== "stop") return null;
  const reason = (typeof item.reason === "string" ? item.reason.trim().slice(0, 1000) : "") || "缺少完成任务必需的信息";
  const question = typeof item.question === "string" ? item.question.trim().slice(0, 1000) : "";
  if (item.decision === "ask_group" && !question) return null;
  return { decision: item.decision, reason, ...(question && item.decision === "ask_group" ? { question } : {}) };
}
function parseChatmateAnswer(answer: string): { reasoning: string; reply: string | null; tasks: ChatmateTask[]; reaction: ChatmateReaction | null; blocker: ChatmateBlocker | null } {
  const raw = answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const candidates = [raw, raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof value.reasoning !== "string" || typeof value.reply !== "string") continue;
      const reply = value.reply.trim();
      const tasks = Array.isArray(value.tasks) ? value.tasks.slice(0, CHATMATE_TASKS_PER_TURN_LIMIT).flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const task = item as Record<string, unknown>;
        const title = typeof task.title === "string" ? task.title.trim().slice(0, 80) : "";
        const instruction = typeof task.instruction === "string" ? task.instruction.trim().slice(0, 1000) : "";
        return title && instruction ? [{ title, instruction, status: "pending" as const }] : [];
      }) : [];
      const reactionValue = value.reaction && typeof value.reaction === "object" ? value.reaction as Record<string, unknown> : null;
      const messageId = Number(reactionValue?.messageId);
      const reaction = Number.isSafeInteger(messageId) && messageId > 0 && isGroupEmoji(reactionValue?.emoji)
        ? { messageId, emoji: reactionValue!.emoji as string } : null;
      const blocker = parseChatmateBlocker(value.blocker);
      return { reasoning: value.reasoning.trim(), reply: blocker?.decision === "ask_group" ? blocker.question! : blocker?.decision === "stop" ? null : reply && !reply.startsWith("暂不回复") ? reply : null,
        tasks: blocker ? [] : tasks, reaction: blocker ? null : reaction, blocker };
    } catch { /* 不把无法确认的包装文本当作可采纳回复 */ }
  }
  return { reasoning: answer.trim(), reply: null, tasks: [], reaction: null, blocker: null };
}
export function expandMonologues(rows: Array<Record<string, unknown>>) {
  return rows.flatMap(row => {
    const { initialContent, initialElapsedSecs, fastSteers, finishedAt, ...final } = row;
    const steers = Array.isArray(fastSteers) ? fastSteers : [];
    const reviewed = initialContent != null || (Array.isArray(row.steps) && row.steps.some((step: { thinking?: string }) => !!step.thinking));
    if (!reviewed) return [{ ...final, startedAt: steers.length ? finishedAt ?? final.startedAt : final.startedAt }, ...steers];
    return [
      { ...final, content: initialContent ?? "", status: "review_initial", steps: [], elapsedSecs: initialElapsedSecs ?? null },
      { ...final, id: `${row.id}:review`, startedAt: finishedAt ?? final.startedAt, status: row.status === "running" || row.status === "reviewing" ? "reviewing" : "review_done" },
      ...steers,
    ];
  });
}
function subscribeCowork(sessionId: string, listener: (event: CoworkPush) => void): () => void {
  let set = coworkSubscribers.get(sessionId);
  if (!set) { set = new Set(); coworkSubscribers.set(sessionId, set); }
  set.add(listener);
  return () => { set!.delete(listener); if (!set!.size) coworkSubscribers.delete(sessionId); };
}
function publishCowork(sessionId: string, event: CoworkPush) {
  const mapped = event.kind === "agent"
    ? { event: event.event, data: event.data, runId: event.runId }
    : event.kind === "message" ? { event: "message", data: { message: event.message }, runId: event.message.runId ?? null }
    : event.kind === "revoked" ? { event: "revoked", data: { messageId: event.messageId, revokedAt: event.revokedAt }, runId: null }
    : event.kind === "run" ? { event: "run", data: { run: event.run }, runId: event.run?.id ?? null }
    : event.kind === "reactions" ? { event: "reactions", data: { reactions: event.reactions }, runId: null }
    : event.kind === "agents" ? { event: "agents", data: {}, runId: null }
    : event.kind === "admins" ? { event: "admins", data: {}, runId: null }
    : event.kind === "preview" ? { event: "preview", data: { agentId: event.agentId, url: event.url, requesterSub: event.requesterSub }, runId: null }
    : event.kind === "settings" ? { event: "settings", data: { settings: event.settings, ownerSub: event.ownerSub, ownerName: event.ownerName, ownerAvatar: event.ownerAvatar }, runId: null }
    : { event: "fast", data: event, runId: event.runId };
  const pool = getPool();
  if (pool) {
    const previous = realtimeWrites.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await pool.query(
        `WITH inserted AS (INSERT INTO realtime_events(session_id,event,data,run_id) VALUES($1,$2,$3,$4) RETURNING seq)
         SELECT pg_notify('agent_realtime', $1) FROM inserted`,
        [sessionId, mapped.event, JSON.stringify(mapped.data), mapped.runId],
      );
    }).catch(error => console.error("[cowork] realtime event failed", error));
    realtimeWrites.set(sessionId, next);
    void next.finally(() => { if (realtimeWrites.get(sessionId) === next) realtimeWrites.delete(sessionId); });
  }
  if (event.kind === "message") {
    // 解除所有参与者的隐藏标记（软删除）：隐藏的会话因新消息自动重新出现在列表
    void unhideAgentSession(sessionId).catch(error => console.error("[cowork] unhide session failed", error));
    // inbox 通知全部成员即时刷新会话列表未读数（走 agent_session_changes → session_message）
    void notifySessionMessage(sessionId).catch(error => console.error("[cowork] inbox notify failed", error));
    void pushCoworkMessage(sessionId, event.message)
      .catch(error => console.error("[cowork] web push failed", error));
  }
  const set = coworkSubscribers.get(sessionId);
  if (!set) return;
  for (const listener of [...set]) { try { listener(event); } catch { /* 单个订阅失败不影响其他 */ } }
}
export function publishCoworkPreview(sessionId: string, agentId: string, url: string, requesterSub?: string): void {
  publishCowork(sessionId, { kind: "preview", agentId, url, requesterSub });
}
async function publishChatmate(sessionId: string, userSub: string, id: string) {
  const pool = getPool();
  if (!pool) return;
  const result = await pool.query(`SELECT c.id,c.message_id AS "messageId",COALESCE(c.sender_name,CASE WHEN m.role='assistant' THEN '${AI_DISPLAY_NAME}' ELSE COALESCE(NULLIF(u.name,''),u.user_code) END,'成员') AS "senderName",c.status,c.content,c.reasoning,c.draft_text AS "draftText",c.steps,c.tasks,c.blocker,c.suggested_reaction AS "reaction",c.elapsed_secs AS "elapsedSecs",c.error,c.created_at AS "startedAt"
    FROM cowork_chatmate c LEFT JOIN agent_messages m ON m.id=c.message_id LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
    WHERE c.id=$1 AND c.session_id=$2 AND c.user_sub=$3`, [id, sessionId, userSub]);
  if (!result.rows[0]) return;
  const settings = await pool.query("SELECT enabled,auto_reply AS \"autoReply\" FROM cowork_chatmate_settings WHERE session_id=$1 AND user_sub=$2", [sessionId, userSub]);
  await pool.query(`WITH inserted AS (INSERT INTO realtime_events(session_id,event,data) VALUES($1,'chatmate',$2) RETURNING seq)
    SELECT pg_notify('agent_realtime', $1) FROM inserted`, [sessionId, JSON.stringify({ userSub, suggestion: result.rows[0], enabled: settings.rows[0]?.enabled === true, autoReply: settings.rows[0]?.autoReply === true })]);
}
function steerActiveFast(sessionId: string, message: MessagePush): void {
  if (!activeFastRuns.has(sessionId)) return;
  const previous = fastSteerQueues.get(sessionId) ?? Promise.resolve();
  const task = previous.then(async () => {
    const active = activeFastRuns.get(sessionId);
    if (!active) return;
    const attachments = groupAttachments(message.attachment, sessionId);
    const context = await groupAttachmentContext(sessionId, attachments);
    const text = `[群聊新消息，立即据此调整快思考判断；消息 ID ${message.id}] [${message.senderName || "成员"}] ${message.content}${context.text ? `\n\n${context.text}` : ""}`;
    // 快思考进行中收到成员新消息 = 本轮思考被引导。无论模型最终是否确认被引导（steered），
    // 都先记录一条「被引导」日志并推送到界面（AI 内心独白 tab），保证引导过程可追溯、不丢失。
    const record = { id: `${active.runId}:steer:${message.id}`, agentId: active.agentId, status: "steered", content: `${message.senderName || "成员"}：${message.content || "发送了附件"}${attachments.length ? `\n附件：${attachments.map(item => item.name).join("、")}` : ""}`,
      steps: [], elapsedSecs: null, startedAt: message.createdAt || new Date().toISOString() };
    await getPool()?.query("UPDATE cowork_runs SET fast_steers=fast_steers || $2::jsonb WHERE id=$1", [active.runId, JSON.stringify([record])]);
    publishCowork(sessionId, { kind: "fast", runId: record.id, agentId: active.agentId, content: record.content, status: record.status, steps: [], elapsedSecs: 0, phase: "initial" });
    slog(sessionId, "cowork.fast.steer.recorded", { runId: active.runId, messageId: message.id }, "info");
    for (let attempt = 0; attempt < 12 && activeFastRuns.get(sessionId) === active; attempt++) {
      const phase = active.phase;
      const sid = `${sessionId}_cowork_${phase === "initial" ? "fast" : "review"}_${active.runId.replaceAll("-", "")}`;
      const result = await steerSession(sid, text, attempt === 0 ? context.images : []);
      if (result.steered) {
        slog(sessionId, "cowork.fast.steer", { runId: active.runId, messageId: message.id, phase, text, images: attempt === 0 ? context.images.length : 0 }, "info", 1000000);
        return;
      }
      await sleep(120);
    }
    slog(sessionId, "cowork.fast.steer.deferred", { runId: active.runId, messageId: message.id }, "info");
  }).catch(error => slog(sessionId, "cowork.fast.steer.error", { messageId: message.id, error: error instanceof Error ? error.message : String(error) }, "warn"));
  fastSteerQueues.set(sessionId, task);
  void task.finally(() => { if (fastSteerQueues.get(sessionId) === task) fastSteerQueues.delete(sessionId); });
}
async function getCoworkMessageRow(pool: NonNullable<ReturnType<typeof getPool>>, id: number): Promise<MessagePush | null> {
  const result = await pool.query(
    `SELECT m.id, m.role, m.content, m.sender_sub, m.client_message_id, m.reply_to_id, m.run_id, m.attachment, m.voice, m.forwarded_bundle, m.steps, m.elapsed_secs, m.artifacts, m.created_at,
            CASE WHEN m.role='assistant' THEN COALESCE(m.cowork_agent_name,ca.name,'${AI_DISPLAY_NAME}') ELSE COALESCE(NULLIF(u.name,''),u.user_code) END AS sender_name, u.avatar AS sender_avatar
     FROM agent_messages m
     LEFT JOIN cowork_agents ca ON ca.id=m.cowork_agent_id
     LEFT JOIN users u ON u.provider || ':' || u.union_id = COALESCE(m.sender_sub, (SELECT user_id FROM agent_sessions WHERE id=m.session_id))
     WHERE m.id=$1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: Number(row.id), role: String(row.role), content: String(row.content ?? ""),
    senderSub: row.sender_sub == null ? null : String(row.sender_sub),
    clientMessageId: row.client_message_id == null ? null : String(row.client_message_id),
    senderName: row.sender_name == null ? null : String(row.sender_name),
    senderAvatar: row.sender_avatar == null ? null : String(row.sender_avatar),
    createdAt: row.created_at ? new Date(row.created_at as string | number | Date).toISOString() : null,
    replyToId: row.reply_to_id == null ? null : Number(row.reply_to_id),
    runId: row.run_id == null ? null : String(row.run_id),
    attachment: row.attachment ?? null,
    voice: row.voice ?? null,
    forwardedBundle: row.forwarded_bundle ?? null,
    steps: row.steps ?? null, elapsedSecs: row.elapsed_secs == null ? null : Number(row.elapsed_secs),
    artifacts: row.artifacts ?? null,
  };
}

export async function publishCoworkSystemMessage(sessionId: string, messageId: number): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const message = await getCoworkMessageRow(pool, messageId);
  if (message) publishCowork(sessionId, { kind: "message", message });
}

// The model makes the final semantic decision. These only affect response urgency and acknowledgement.
export function explicitlyMentioned(text: string, title: string): boolean {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[@＠]\\s*(?:${escaped}|所有人|all)(?=$|[\\s，。！？?,.!:：；;])`, "i").test(text);
}

/** 针对某成员的答复：若 shouldMention（触发消息 @ 了目标/明确点名），确保回复以 @名字 开头；
 *  回复已以 @名字 或直接以名字开头则不动。返回处理后的文本。 */
function ensureReplyMention(reply: string | null | undefined, targetName: string | undefined, shouldMention: boolean): string {
  const t = String(reply ?? "").trim();
  if (!shouldMention || !t) return String(reply ?? "");
  const name = String(targetName ?? "").trim();
  if (!name) return String(reply ?? "");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`^[@＠]?${esc}`, "i").test(t)) return t;
  return `@${name} ${t}`;
}

function directlyAddressed(text: string, title: string): boolean {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return explicitlyMentioned(text, title) || new RegExp(`(?:听听|问问|请|让|叫|看看).{0,14}${escaped}.{0,14}(?:看法|意见|怎么|回答|分析|总结|说)|${escaped}.{0,12}(?:怎么看|觉得|能否|帮|来)`, "i").test(text);
}

/**
 * 双人内置好友会话（1v1 builtin，非群聊）的好友状态：
 * - true  = 该会话是双人内置好友会话且双方当前仍是好友（放行）；
 * - false = 是双人内置好友会话但双方已不是好友（拦截发消息——删除好友后，对方发的消息不会再送达）；
 * - null  = 不是双人内置好友会话（群聊 / AI 会话等，不适用好友校验）。
 */
async function builtinFriendPairStatus(sessionId: string, sub: string): Promise<boolean | null> {
  const pool = getPool();
  if (!pool) return null;
  const pair = await pool.query(`SELECT s.user_id AS owner,m.contact_id AS member
    FROM agent_sessions s JOIN agent_session_members m ON m.session_id=s.id AND m.provider='builtin'
    WHERE s.id=$1 AND NOT s.cowork_ever_group
      AND (SELECT count(*) FROM agent_session_members m2 WHERE m2.session_id=s.id)=1
      AND (s.user_id=$2 OR 'builtin:'||m.contact_id=$2)`, [sessionId, sub]);
  if (!pair.rowCount) return null;
  const owner = String(pair.rows[0].owner);
  const peer = owner === sub ? `builtin:${String(pair.rows[0].member)}` : owner;
  const pairSorted = [sub, peer].sort();
  const friendship = await pool.query("SELECT 1 FROM builtin_friendships WHERE user_a=$1 AND user_b=$2", pairSorted);
  return !!friendship.rowCount;
}

export function createCoworkHandlers(agent: AgentRoute) {
  async function finishManualChatmateStop(sessionId: string, userSub: string, messageId: number, stoppedIds: string[]): Promise<void> {
    const key = `${sessionId}:${userSub}`;
    chatmateManualMessageCutoffs.set(key, Math.max(chatmateManualMessageCutoffs.get(key) ?? 0, messageId));
    const active = activeChatmateRuns.get(key);
    if (active) {
      active.stopped = true;
      active.controller.abort();
      void interruptSession(active.sessionId).catch(error => console.error("[cowork] chatmate interrupt failed", error));
    }
    for (const id of stoppedIds) await publishChatmate(sessionId, userSub, id).catch(error => console.error("[cowork] chatmate stop publish failed", error));
  }

  async function chatmate(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const setting = await ctx.pool!.query("SELECT enabled,auto_reply AS \"autoReply\",custom_prompt AS \"customPrompt\" FROM cowork_chatmate_settings WHERE session_id=$1 AND user_sub=$2", [sessionId, ctx.user!.sub]);
    const result = await ctx.pool!.query(`SELECT c.id,c.message_id AS "messageId",COALESCE(c.sender_name,CASE WHEN m.role='assistant' THEN '${AI_DISPLAY_NAME}' ELSE COALESCE(NULLIF(u.name,''),u.user_code) END,'成员') AS "senderName",c.status,c.content,c.reasoning,c.draft_text AS "draftText",c.steps,c.tasks,c.blocker,c.suggested_reaction AS "reaction",c.elapsed_secs AS "elapsedSecs",c.error,c.created_at AS "startedAt"
      FROM cowork_chatmate c LEFT JOIN agent_messages m ON m.id=c.message_id LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
      WHERE c.session_id=$1 AND c.user_sub=$2 ORDER BY c.message_id DESC LIMIT 100`, [sessionId, ctx.user!.sub]);
    return json({
      enabled: setting.rows[0]?.enabled === true,
      autoReply: setting.rows[0]?.autoReply === true,
      customPrompt: typeof setting.rows[0]?.customPrompt === "string" ? setting.rows[0].customPrompt : null,
      defaultPrompt: DEFAULT_CHATMATE_PROMPT,
      suggestions: result.rows.reverse(),
    });
  }

  async function setChatmate(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => ({})) as { enabled?: unknown; autoReply?: unknown; customPrompt?: unknown };
    const hasEnabled = body.enabled !== undefined;
    const hasAutoReply = body.autoReply !== undefined;
    const hasCustomPrompt = body.customPrompt !== undefined;
    if (!hasEnabled && !hasAutoReply && !hasCustomPrompt) return json({ error: "invalid_chatmate_settings" }, 400);
    if (hasEnabled && typeof body.enabled !== "boolean") return json({ error: "invalid_chatmate_settings" }, 400);
    if (hasAutoReply && typeof body.autoReply !== "boolean") return json({ error: "invalid_chatmate_settings" }, 400);
    let customPrompt: string | null = null;
    if (hasCustomPrompt) {
      if (typeof body.customPrompt !== "string" || body.customPrompt.length > 12000) return json({ error: "invalid_custom_prompt", message: "提示词需为不超过 12000 字的文本" }, 400);
      const trimmed = body.customPrompt.trim();
      customPrompt = trimmed ? trimmed : null; // 空串 = 恢复内置默认
    }
    const enabled = body.autoReply === true ? true : body.enabled;
    const autoReply = enabled === false ? false : body.autoReply;
    const updated = await ctx.pool!.query(`INSERT INTO cowork_chatmate_settings(session_id,user_sub,enabled,auto_reply,custom_prompt) VALUES($1,$2,COALESCE($3,false),COALESCE($4,false),$5)
      ON CONFLICT(session_id,user_sub) DO UPDATE SET
        enabled=COALESCE($3,cowork_chatmate_settings.enabled),
        auto_reply=COALESCE($4,cowork_chatmate_settings.auto_reply),
        custom_prompt=CASE WHEN $6 THEN $5 ELSE cowork_chatmate_settings.custom_prompt END
      RETURNING enabled,auto_reply AS "autoReply",custom_prompt AS "customPrompt"`,
      [sessionId, ctx.user!.sub, enabled ?? null, autoReply ?? null, hasCustomPrompt ? customPrompt : null, hasCustomPrompt]);
    if (enabled === false) {
      const active = activeChatmateRuns.get(`${sessionId}:${ctx.user!.sub}`);
      if (active) {
        active.stopped = true;
        active.controller.abort();
        void interruptSession(active.sessionId);
        await ctx.pool!.query("UPDATE cowork_chatmate SET status='stopped',tasks='[]'::jsonb,updated_at=now() WHERE id=$1 AND status='running'", [active.id]);
        await publishChatmate(sessionId, ctx.user!.sub, active.id);
      }
    }
    return json({ ...updated.rows[0], defaultPrompt: DEFAULT_CHATMATE_PROMPT });
  }

  async function stopChatmate(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => ({})) as { id?: unknown };
    if (typeof body.id !== "string") return json({ error: "invalid_id" }, 400);
    const stopped = await ctx.pool!.query("UPDATE cowork_chatmate SET status='stopped',tasks='[]'::jsonb,updated_at=now() WHERE id=$1 AND session_id=$2 AND user_sub=$3 AND status='running' RETURNING id", [body.id, sessionId, ctx.user!.sub]);
    if (!stopped.rowCount) return json({ error: "not_running" }, 409);
    const active = activeChatmateRuns.get(`${sessionId}:${ctx.user!.sub}`);
    if (active?.id === body.id) {
      active.stopped = true;
      active.controller.abort();
      void interruptSession(active.sessionId);
    }
    await publishChatmate(sessionId, ctx.user!.sub, body.id);
    return json({ stopped: true });
  }

  /** 停止某个群 AI 当前正在执行的全部会话（快思考 / 复核 / 慢思考）：
   *  中断模型会话、把运行中/复核中的 run 标记 stopped、清掉内存快思考槽位并推送停止事件。 */
  async function stopAgent(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => ({})) as { agentId?: unknown };
    const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
    if (!agentId) return json({ error: "invalid_agent_id" }, 400);
    const agentRow = await ctx.pool!.query("SELECT id,name,created_by AS \"createdBy\" FROM cowork_agents WHERE session_id=$1 AND id=$2", [sessionId, agentId]);
    if (!agentRow.rowCount) return json({ error: "not_found" }, 404);
    // 群主、任命管理员、1v1 双方，或该 AI 创建者可停止。
    if (!ctx.isAdmin && agentRow.rows[0].createdBy !== ctx.user!.sub) return json({ error: "forbidden" }, 403);
    const agentName = String(agentRow.rows[0].name);
    const note = `已手动停止 ${agentName} 的当前任务`;

    const interruptRun = async (runId: string) => {
      const token = runId.replaceAll("-", "");
      await Promise.all([
        interruptSession(`${sessionId}_cowork_fast_${token}`).catch(() => undefined),
        interruptSession(`${sessionId}_cowork_slow_${token}`).catch(() => undefined),
      ]);
    };
    const markStopped = async (runId: string, phase: "initial" | "review") => {
      await interruptRun(runId);
      await ctx.pool!.query(
        "UPDATE cowork_runs SET status='stopped', fast_status='stopped', fast_content=$2, updated_at=now() WHERE id=$1",
        [runId, note],
      );
      publishCowork(sessionId, { kind: "fast", runId, agentId, status: "stopped", content: note, steps: [], elapsedSecs: 0, phase });
    };

    let stopped = false;
    const active = activeFastRuns.get(sessionId);
    if (active && active.agentId === agentId) {
      activeFastRuns.delete(sessionId);
      stopped = true;
      await markStopped(active.runId, active.phase);
    }
    const rows = await ctx.pool!.query(
      `SELECT id FROM cowork_runs WHERE session_id=$1 AND agent_id=$2 AND (status IN ('pending','running') OR fast_status IN ('running','reviewing'))`,
      [sessionId, agentId],
    );
    for (const row of rows.rows) {
      stopped = true;
      await markStopped(String(row.id), "initial");
    }
    return json({ stopped, note });
  }

  async function chatmateAct(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => ({})) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim().slice(0, 12000) : "";
    const userSub = ctx.user!.sub;
    const pool = ctx.pool!;
    if (!text) {
      // —— 无输入：手动触发一次完整 chatmate run（强制慢思考，流程与自动回复一致）——
      const key = `${sessionId}:${userSub}`;
      if (activeChatmateRuns.has(key)) return json({ error: "chatmate_busy", message: "已有正在进行的伴聊，请稍候" }, 409);
      // 优先选最近一条「尚未被伴聊占用」的消息作为触发点（UNIQUE(session_id,message_id,user_sub) 不允许同消息重复插入）
      const last = await pool.query(`SELECT COALESCE(MAX(m.id),0) AS id FROM agent_messages m
        WHERE m.session_id=$1 AND NOT EXISTS (SELECT 1 FROM cowork_chatmate c WHERE c.session_id=m.session_id AND c.message_id=m.id AND c.user_sub=$2)`, [sessionId, userSub]);
      let messageId = Number(last.rows[0].id);
      const id = randomUUID();
      const modelSessionId = chatmateSessionId(sessionId, userSub);
      let inserted;
      if (messageId > 0) {
        inserted = await pool.query(`INSERT INTO cowork_chatmate(id,session_id,message_id,user_sub,sender_name,model_session_id)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [id, sessionId, messageId, userSub, "手动触发", modelSessionId]);
      } else {
        // 全部消息都已被伴聊占用：重开最近一次触发（同 message_id 更新为新 run），不覆盖其他消息的历史
        const fallback = await pool.query(`SELECT message_id FROM cowork_chatmate WHERE session_id=$1 AND user_sub=$2 ORDER BY message_id DESC, created_at DESC LIMIT 1`, [sessionId, userSub]);
        if (!fallback.rowCount) return json({ error: "chatmate_no_message", message: "群内还没有可触发的消息" }, 409);
        messageId = Number(fallback.rows[0].message_id);
        inserted = await pool.query(`INSERT INTO cowork_chatmate(id,session_id,message_id,user_sub,sender_name,model_session_id)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (session_id,message_id,user_sub) DO UPDATE SET id=EXCLUDED.id,status='running',sender_name=EXCLUDED.sender_name,model_session_id=EXCLUDED.model_session_id,
          content='',draft_text=NULL,steps='[]'::jsonb,tasks='[]'::jsonb,error=NULL,reasoning=NULL,suggested_reaction=NULL,blocker=NULL,elapsed_secs=NULL,updated_at=now() RETURNING id`,
          [id, sessionId, messageId, userSub, "手动触发", modelSessionId]);
      }
      if (!inserted.rowCount) return json({ error: "chatmate_conflict", message: "伴聊记录创建冲突，请重试" }, 409);
      const run = { id, sessionId: modelSessionId, controller: new AbortController(), stopped: false, finished: Promise.resolve() };
      activeChatmateRuns.set(key, run);
      const timeout = setTimeout(() => run.controller.abort(), CHATMATE_TURN_TIMEOUT_MS);
      run.finished = runChatmate(request, sessionId, messageId, userSub, id, run.controller.signal, { forceSlow: true }).catch(async error => {
        if (run.stopped) return;
        const failed = await pool.query("UPDATE cowork_chatmate SET status='error',error=$2,tasks='[]'::jsonb,updated_at=now() WHERE id=$1 AND status='running' RETURNING id", [id, error instanceof Error ? error.message : String(error)]).catch(() => null);
        if (failed?.rowCount) await publishChatmate(sessionId, userSub, id).catch(() => {});
      }).finally(async () => {
        clearTimeout(timeout);
        const timedOut = await pool.query("UPDATE cowork_chatmate SET status='error',error='本轮伴聊运行时间已达上限，任务已停止',tasks='[]'::jsonb,updated_at=now() WHERE id=$1 AND status='running' RETURNING id", [id]);
        if (timedOut.rowCount) await publishChatmate(sessionId, userSub, id);
        if (activeChatmateRuns.get(key) === run) activeChatmateRuns.delete(key);
      });
      await publishChatmate(sessionId, userSub, id);
      slog(sessionId, "cowork.chatmate.manual", { id, messageId }, "info");
      return json({ ok: true, runId: id });
    }
    // —— 有输入：chatmate 会话结合整个聊天上下文审视草稿（找纰漏），返回改进文本 ——
    const [profile, setting] = await Promise.all([
      pool.query("SELECT name FROM users WHERE provider || ':' || union_id=$1 LIMIT 1", [userSub]),
      pool.query("SELECT cowork_mode,cowork_model,cowork_codex_model FROM agent_sessions WHERE id=$1", [sessionId]),
    ]);
    const name = String(profile.rows[0]?.name || "当前用户");
    const config = setting.rows[0];
    if (!config) return json({ error: "群聊已删除" }, 404);
    const mode = String(config.cowork_mode) === "codex" ? "codex" : "codebuddy";
    const history = await pool.query(`SELECT m.id,m.role,m.content,CASE WHEN m.role='assistant' THEN COALESCE(m.cowork_agent_name,'${AI_DISPLAY_NAME}') ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS sender_name
      FROM agent_messages m LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
      WHERE m.session_id=$1 AND m.revoked_at IS NULL AND m.role IN ('user','assistant') ORDER BY m.id DESC LIMIT 40`, [sessionId]);
    const messages: Array<{ role: string; content: string }> = [];
    for (const row of history.rows.reverse()) {
      messages.push(row.role === "assistant"
        ? { role: "assistant", content: `[AI] ${String(row.content)}` }
        : { role: "user", content: `[${row.sender_name}] ${String(row.content)}` });
    }
    const enhanceSystem = `你是群成员 ${name} 的伴聊“Chatmate”。下面给出了整个聊天上下文。请审视 ${name} 即将发送的草稿消息，找出纰漏：与上下文矛盾的内容、过时信息、遗漏的关键点、可补充的相关上下文、表达不清之处。输出改进后的文本：保持 ${name} 的原意、语气与第一人称，不要大改，不要替 ${name} 做超出草稿意图的扩展。若草稿已完善，允许小幅润色。改进后的文本一律用纯文本，不使用任何 Markdown 语法（不加粗、不写标题、不用列表符号或代码块），像人发的消息。只输出 JSON：{"text":"改进后的文本"}。JSON 外不要输出文字。`;
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/\/api\/cowork\/[^/]+\/[^/]+$/, "/api/chat");
    const enhanceRequest = new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
      body: JSON.stringify({ messages: [{ role: "system", content: enhanceSystem }, ...messages, { role: "user", content: `[我的草稿] ${text}` }],
        sessionId: `${chatmateSessionId(sessionId, userSub)}_enhance_${Date.now()}`, cowork: true, coworkChatmate: true,
        coworkAttachmentSessionId: sessionId, resume: false, agentMode: mode, model: config.cowork_model ?? undefined, codexModelKey: config.cowork_codex_model ?? undefined }) });
    slog(sessionId, "cowork.chatmate.enhance.start", { text: text.slice(0, 120) }, "info");
    const enhanceResponse = await withRetry(async () => {
      const res = await agent.POST(markInternalCoworkRequest(enhanceRequest), { params: { agent: ["chat"] } });
      if (!res.ok || !res.body) throw new RetryableError(`草稿审视请求失败 (${res.status})`);
      return res;
    }, retryPolicy("low", {
      onRetry: (attempt, error, delayMs) => slog(sessionId, "cowork.chatmate.enhance.retry", { attempt, error: error instanceof Error ? error.message : String(error), delayMs }, "warn"),
    }));
    if (!enhanceResponse.body) throw new Error(`草稿审视请求失败 (${enhanceResponse.status})`);
    const enhanceText = await readCoworkText(enhanceResponse.body, () => {});
    const parsed = JSON.parse(enhanceText.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;
    const improved = typeof parsed.text === "string" && parsed.text.trim() ? parsed.text.trim() : text;
    slog(sessionId, "cowork.chatmate.enhance.done", { text: improved.slice(0, 200) }, "info");
    return json({ ok: true, text: improved });
  }

  async function chatmateAutoReplyEnabled(sessionId: string, userSub: string): Promise<boolean> {
    const result = await getPool()!.query("SELECT 1 FROM cowork_chatmate_settings WHERE session_id=$1 AND user_sub=$2 AND enabled=true AND auto_reply=true", [sessionId, userSub]);
    return !!result.rowCount;
  }

  async function chatmateQuestionAlreadyAsked(sessionId: string, userSub: string, question: string): Promise<boolean> {
    const result = await getPool()!.query(`SELECT 1 FROM agent_messages WHERE session_id=$1 AND sender_sub=$2
      AND lower(trim(content))=lower(trim($3)) AND created_at >= now() - interval '24 hours' LIMIT 1`, [sessionId, userSub, question]);
    return !!result.rowCount;
  }

  async function postChatmateUpdate(request: Request, sessionId: string, userSub: string, runId: string, index: number, content: string, replyToId: number, label = ""): Promise<void> {
    const pool = getPool()!;
    const text = content.trim().slice(0, 12000);
    if (!text) return;
    if (!await chatmateAutoReplyEnabled(sessionId, userSub)) {
      slog(sessionId, "cowork.chatmate.auto_send_skipped", { runId, index, reason: "auto_reply_disabled" }, "info");
      return;
    }
    if (!await getAgentSession(userSub, sessionId)) {
      slog(sessionId, "cowork.chatmate.auto_send_skipped", { runId, index, reason: "no_session_access" }, "warn");
      return;
    }
    // 删除好友后：伴聊自动回复也不能再向该会话代发消息
    if ((await builtinFriendPairStatus(sessionId, userSub)) === false) {
      slog(sessionId, "cowork.chatmate.auto_send_skipped", { runId, index, reason: "no_friendship" }, "info");
      return;
    }
    // label 用于区分同一 run 内的多条同 index 消息（如慢思考占位与最终回复），避免 client_message_id 冲突被去重吞掉
    const clientMessageId = `chatmate_${runId.replaceAll("-", "")}_${label || index}`;
    const inserted = await pool.query(`INSERT INTO agent_messages(session_id,role,content,sender_sub,client_message_id,reply_to_id)
      SELECT $1,'user',$2,$3,$4,$5 WHERE EXISTS (SELECT 1 FROM agent_sessions WHERE id=$1)
      AND EXISTS (SELECT 1 FROM cowork_chatmate WHERE id=$6 AND status='running' FOR UPDATE)
      ON CONFLICT DO NOTHING RETURNING id`, [sessionId, text, userSub, clientMessageId, replyToId, runId]);
    if (!inserted.rowCount) {
      slog(sessionId, "cowork.chatmate.auto_send_skipped", { runId, index, reason: "stopped_or_duplicate" }, "info");
      return;
    }
    await pool.query("UPDATE agent_sessions SET updated_at=now() WHERE id=$1", [sessionId]);
    const message = await getCoworkMessageRow(pool, Number(inserted.rows[0].id));
    if (message) publishCowork(sessionId, { kind: "message", message });
    // chatmate 自动回复的消息必须进入正常消息调度链（触发对方 chatmate 与群 AI 快思考），
    // 否则双方自动回复只进行一轮就停。占位（ack）不触发；是否继续回复由对方快思考判断（skip 即自然停止）。
    if (message && label !== "ack") {
      void scheduleChatmate(request, sessionId, message).catch(error => console.error("[cowork] chatmate loop scheduling failed", error));
      void scheduleMessageRunsForTrigger(request, sessionId, message.id).catch(error => console.error("[cowork] chatmate loop group scheduling failed", error));
    }
    slog(sessionId, "cowork.chatmate.auto_sent", { runId, index, messageId: inserted.rows[0].id }, "info");
  }

  async function applyChatmateReaction(sessionId: string, userSub: string, reaction: ChatmateReaction): Promise<void> {
    if (!await chatmateAutoReplyEnabled(sessionId, userSub) || !await getAgentSession(userSub, sessionId)) return;
    const pool = getPool()!;
    const inserted = await pool.query(`INSERT INTO cowork_message_reactions(message_id,user_sub,emoji)
      SELECT m.id,$2,$3 FROM agent_messages m WHERE m.id=$1 AND m.session_id=$4 AND m.sender_sub IS DISTINCT FROM $2
      ON CONFLICT DO NOTHING RETURNING message_id`, [reaction.messageId, userSub, reaction.emoji, sessionId]);
    if (!inserted.rowCount) return;
    const result = await pool.query("SELECT r.message_id,r.user_sub,CASE WHEN r.user_sub='agent' THEN NULL ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS user_name,r.emoji FROM cowork_message_reactions r JOIN agent_messages m ON m.id=r.message_id LEFT JOIN users u ON u.provider || ':' || u.union_id=r.user_sub WHERE m.session_id=$1 ORDER BY r.created_at,r.emoji", [sessionId]);
    publishCowork(sessionId, { kind: "reactions", reactions: result.rows as Array<{ message_id: number; user_sub: string; user_name: string | null; emoji: string }> });
  }

  async function scheduleChatmate(request: Request, sessionId: string, message: MessagePush): Promise<void> {
    const pool = getPool();
    if (!pool || message.role === "reaction") return;
    const people = await pool.query(`SELECT user_sub AS sub FROM cowork_chatmate_settings
      WHERE session_id=$1 AND enabled=true AND ($2::text IS NULL OR user_sub<>$2)`, [sessionId, message.senderSub ?? null]);
    for (const person of people.rows) {
      const userSub = String(person.sub);
      const key = `${sessionId}:${userSub}`;
      const previous = chatmateQueues.get(key) ?? Promise.resolve();
      const task = previous.then(async () => {
        if (message.id <= (chatmateManualMessageCutoffs.get(key) ?? 0)) return;
        const enabledNow = await pool.query("SELECT 1 FROM cowork_chatmate_settings WHERE session_id=$1 AND user_sub=$2 AND enabled=true", [sessionId, userSub]);
        if (!enabledNow.rowCount) return;
        if (message.id <= (chatmateManualMessageCutoffs.get(key) ?? 0)) return;
        const active = activeChatmateRuns.get(key);
        if (active) {
          const context = await groupAttachmentContext(sessionId, groupAttachments(message.attachment, sessionId));
          const text = `[群聊新消息 #${message.id}，请据此调整给当前用户的回复建议；不要沿用已经过时的回复。][${chatmateSender(message)}] ${message.content}${context.text ? `\n\n${context.text}` : ""}`;
          for (let attempt = 0; attempt < 12 && activeChatmateRuns.get(key) === active; attempt++) {
            const result = await steerSession(active.sessionId, text, context.images);
            if (result.steered) {
              await pool.query("UPDATE cowork_chatmate SET sender_name=$2,updated_at=now() WHERE id=$1", [active.id, chatmateSender(message)]);
              await publishChatmate(sessionId, userSub, active.id);
              return;
            }
            await sleep(120);
          }
          // The current turn may have finished while steer was attempted. Wait for
          // its stream to close before resuming the same model session.
          await active.finished;
        }
        const stillEnabled = await pool.query("SELECT 1 FROM cowork_chatmate_settings WHERE session_id=$1 AND user_sub=$2 AND enabled=true", [sessionId, userSub]);
        if (!stillEnabled.rowCount) return;
        if (message.id <= (chatmateManualMessageCutoffs.get(key) ?? 0)) return;
        const id = randomUUID();
        const modelSessionId = chatmateSessionId(sessionId, userSub);
        const inserted = await pool.query(`INSERT INTO cowork_chatmate(id,session_id,message_id,user_sub,sender_name,model_session_id)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`, [id, sessionId, message.id, userSub, chatmateSender(message), modelSessionId]);
        if (!inserted.rowCount) return;
        if (message.id <= (chatmateManualMessageCutoffs.get(key) ?? 0)) {
          await pool.query("UPDATE cowork_chatmate SET status='stopped',tasks='[]'::jsonb,updated_at=now() WHERE id=$1", [id]);
          await publishChatmate(sessionId, userSub, id);
          return;
        }
        const run = { id, sessionId: modelSessionId, controller: new AbortController(), stopped: false, finished: Promise.resolve() };
        activeChatmateRuns.set(key, run);
        const timeout = setTimeout(() => run.controller.abort(), CHATMATE_TURN_TIMEOUT_MS);
        run.finished = runChatmate(request, sessionId, message.id, userSub, id, run.controller.signal).catch(async error => {
          if (run.stopped) return;
          const failed = await pool.query("UPDATE cowork_chatmate SET status='error',error=$2,tasks='[]'::jsonb,updated_at=now() WHERE id=$1 AND status='running' RETURNING id", [id, error instanceof Error ? error.message : String(error)]).catch(() => null);
          if (failed?.rowCount) await publishChatmate(sessionId, userSub, id).catch(() => {});
        }).finally(async () => {
          clearTimeout(timeout);
          const timedOut = await pool.query("UPDATE cowork_chatmate SET status='error',error='本轮伴聊运行时间已达上限，任务已停止',tasks='[]'::jsonb,updated_at=now() WHERE id=$1 AND status='running' RETURNING id", [id]);
          if (timedOut.rowCount) await publishChatmate(sessionId, userSub, id);
          if (activeChatmateRuns.get(key) === run) activeChatmateRuns.delete(key);
        });
        await publishChatmate(sessionId, userSub, id);
      }).catch(error => console.error("[cowork] chatmate scheduling failed", error));
      chatmateQueues.set(key, task);
      void task.finally(() => { if (chatmateQueues.get(key) === task) chatmateQueues.delete(key); });
    }
  }

  async function runChatmate(request: Request, sessionId: string, messageId: number, userSub: string, id: string, signal: AbortSignal, opts: { forceSlow?: boolean } = {}): Promise<void> {
    const pool = getPool()!;
    if (signal.aborted) return;
    const [profile, setting, chatmateSetting, rows, memberRows, previous, priorBlocked] = await Promise.all([
      pool.query("SELECT name FROM users WHERE provider || ':' || union_id=$1 LIMIT 1", [userSub]),
      pool.query("SELECT cowork_mode,cowork_model,cowork_codex_model FROM agent_sessions WHERE id=$1", [sessionId]),
      pool.query("SELECT custom_prompt FROM cowork_chatmate_settings WHERE session_id=$1 AND user_sub=$2", [sessionId, userSub]),
      pool.query(`SELECT m.id,m.role,m.content,m.attachment,m.reply_to_id,CASE WHEN m.role='assistant' THEN COALESCE(m.cowork_agent_name,'${AI_DISPLAY_NAME}') ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS sender_name,m.sender_sub
        FROM agent_messages m LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
        WHERE m.session_id=$1 AND m.id<=$2 AND m.revoked_at IS NULL AND m.role IN ('user','assistant')
        ORDER BY m.id DESC LIMIT 40`, [sessionId, messageId]),
      pool.query(`SELECT u.provider || ':' || u.union_id AS sub,
          COALESCE(NULLIF(u.name,''),u.user_code,NULLIF(sm.name,''),'成员') AS name
        FROM agent_session_members sm
        LEFT JOIN LATERAL (
          SELECT provider,union_id,name FROM users u
          WHERE u.provider=sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
          LIMIT 1
        ) u ON true
        WHERE sm.session_id=$1 ORDER BY sm.added_at,sm.contact_id`, [sessionId]),
      pool.query("SELECT 1 FROM cowork_chatmate WHERE session_id=$1 AND user_sub=$2 AND id<>$3 AND model_session_id=$4 AND status='done' LIMIT 1", [sessionId, userSub, id, chatmateSessionId(sessionId, userSub)]),
      pool.query("SELECT blocker FROM cowork_chatmate WHERE session_id=$1 AND user_sub=$2 AND id<>$3 AND status='done' ORDER BY created_at DESC LIMIT 1", [sessionId, userSub, id]),
    ]);
    if (!setting.rows[0]) throw new Error("群聊已删除");
    if (signal.aborted) return;
    const resume = (previous.rowCount ?? 0) > 0;
    const name = String(profile.rows[0]?.name || "当前用户");
    const history: Array<{ role: string; content: string; images?: ImageSpec[] }> = [];
    const images: ImageSpec[] = [];
    const readableAttachments: GroupAttachment[] = [];
    for (const row of rows.rows.reverse()) {
      if (signal.aborted) return;
      const contexts: string[] = [];
      for (const attachment of groupAttachments(row.attachment, sessionId)) {
        const context = await groupAttachmentContext(sessionId, [attachment]);
        images.push(...context.images);
        if (/\.pdf$/i.test(attachment.name) && !context.text.includes("<附件正文：")) {
          try {
            const remainingPages = Math.min(24, Math.max(0, 32 - images.length));
            if (!remainingPages) throw new Error("本轮页面图像数量已达上限");
            const fileName = new URL(attachment.url, "http://local").searchParams.get("name")!;
            const pdfFile = await resolveUploadPath(sessionId, fileName);
            if (!pdfFile) throw new Error("附件文件不存在");
            const bytes = await fs.readFile(pdfFile);
            const rendered = await renderPdfPageImages(bytes, remainingPages);
            images.push(...rendered.images);
            contexts.push(`[附件] ${attachment.name}：扫描版 PDF 已作为页面图像提供，顺序对应第 1–${rendered.images.length} 页${rendered.pages > rendered.images.length ? `（共 ${rendered.pages} 页，仅提供前 ${rendered.images.length} 页）` : ""}。请直接查看页面内容。`);
          } catch (error) {
            contexts.push(`[附件] ${attachment.name}：无法提供页面图像（${error instanceof Error ? error.message : String(error)}）。`);
          }
        } else {
          contexts.push(context.text);
          readableAttachments.push(attachment);
        }
      }
      history.push({ role: "user", content: `[消息 #${row.id}${row.reply_to_id ? `，回复 #${row.reply_to_id}` : ""}][${row.sender_sub === userSub ? `${name}（我）` : row.sender_name}] ${row.content}${contexts.length ? `\n\n${contexts.join("\n\n")}` : ""}` });
    }
    if (history.length && images.length) history.at(-1)!.images = images;
    const lastBlocker = parseChatmateBlocker(priorBlocked.rows[0]?.blocker);
    const lastBlockerText = lastBlocker ? JSON.stringify(lastBlocker) : "无";
    // 自定义主提示词（群×用户独立保存，NULL/空=用内置默认）；输出 JSON 契约由 buildChatmateSystem 强制保留
    const savedCustomPrompt = typeof chatmateSetting.rows[0]?.custom_prompt === "string" ? chatmateSetting.rows[0].custom_prompt : null;
    const system = buildChatmateSystem(savedCustomPrompt, name, lastBlockerText);
    const config = setting.rows[0];
    const mode = String(config.cowork_mode) === "codex" ? "codex" : "codebuddy";
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/\/api\/cowork\/[^/]+\/[^/]+$/, "/api/chat");
    // —— 快思考分流（对齐群 AI 的 fast/slow 机制）——
    // 先轻量判断这一轮是否值得回复：AI 的消息默认不打扰，除非是影响本用户的重大问题；
    // 用户消息按「无需回复 / 直接简短回复 / 需要慢思考」分流。需要慢思考时先发占位（如"收到"）。
    // 手动触发（forceSlow）跳过分流：用户已明确要输出，直接进入慢思考。
    const triggerRow = rows.rows.find(r => Number(r.id) === messageId);
    // 触发消息 @ 了当前用户（或明确点名）：答复要 @ 触发人（服务端兜底保证，模型漏写也会补上）
    const chatmateMentionTarget = triggerRow?.role === "user" && (explicitlyMentioned(String(triggerRow.content ?? ""), name) || directlyAddressed(String(triggerRow.content ?? ""), name))
      ? String(triggerRow.sender_name ?? "").trim() : "";
    // —— 明确对别人说话 → 不回复 ——
    // 触发消息若 @ 了其他群成员或 @/点名了群 AI，且没有 @ 当前用户，说明用户是在对别人说话，
    // chatmate 不应越俎代庖回复（模型快思考可能漏判，这里服务端强制兜底）。
    const mentionedMyself = !!chatmateMentionTarget;
    const triggerText = String(triggerRow?.content ?? "");
    const aiTitle = getAppDisplayName();
    const otherMemberNames = [...new Set(memberRows.rows.map(r => String(r.name ?? "").trim()).filter(n => n && n !== name))];
    const addressedToOthers = triggerRow?.role === "user" && !mentionedMyself && (
      (aiTitle && aiTitle !== name && (explicitlyMentioned(triggerText, aiTitle) || directlyAddressed(triggerText, aiTitle)))
      || otherMemberNames.some(other => explicitlyMentioned(triggerText, other))
    );
    if (!opts.forceSlow) {
    const fastIsAiMessage = triggerRow?.role === "assistant";
    const fastSender = String(triggerRow?.sender_name ?? "成员");
    const fastSystem = `你是群成员 ${name} 的伴聊“Chatmate”，此刻你就是 ${name} 在群里的代理，代表 ${name} 判断是否要在群里说话。刚刚${fastIsAiMessage ? `${aiTitle}（${fastSender}）发了一条新消息` : `收到一条新消息（${fastSender}）`}。
${fastIsAiMessage
  ? `${aiTitle} 的消息一般不需要你回应。除非这是影响 ${name} 的重大问题（例如：AI 声称已完成但实际未完成、AI 承诺 ${name} 的任务失败或出错、存在重要事实错误、需要 ${name} 立即行动的紧急事项），否则一律选 skip。只有确认是重大问题才选 reply 或 slow。`
  : `判断这一轮是否需要 ${name} 出面：a) 无需回复、仅需表情、与 ${name} 无关或 AI 已妥善处理 → skip；b) 可以直接简短回复 → reply 并给出回复文本；c) 需要研究、查证、制作方案或耗时核查，或消息明确请求 ${name} 处理 → slow。若消息明确是在 @ 其他群成员或 @/点名 ${aiTitle} 说话（没有 @${name}），说明用户是在对别人讲，一律选 skip，不要替别人或 ${aiTitle} 回复。`}
只输出 JSON：{"decision":"skip|reply|slow","reply":"仅 decision=reply 时填写可直接发到群里的第一人称回复","ack":"仅 decision=slow 时填写的先行占位文本（如“收到，我来看看。”），可为空","reasoning":"私下的简短判断"}。reply、ack、reasoning 都用纯文本，不使用任何 Markdown 语法（不加粗、不写标题、不用列表符号或代码块），像人发的消息。若触发消息 @${name} 或明确点名 ${name}，reply 开头要 @ 对方成员名字（如 @张三 ）。JSON 外不要输出文字。`;
    const fastRequest = new Request(url, { method: "POST", signal, headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
      body: JSON.stringify({ messages: [{ role: "system", content: fastSystem }, ...history.slice(-14)], sessionId: `${chatmateSessionId(sessionId, userSub)}_fast_${id.replaceAll("-", "")}`,
        cowork: true, coworkChatmate: true, coworkAttachmentSessionId: sessionId, resume: false, agentMode: mode,
        model: config.cowork_model ?? undefined, codexModelKey: config.cowork_codex_model ?? undefined }) });
    let fastDecision: { decision: "skip" | "reply" | "slow"; reply?: string; ack?: string } | null = null;
    try {
      slog(sessionId, "cowork.chatmate.fast.start", { id, messageId, isAiMessage: fastIsAiMessage }, "info");
      const fastResponse = await withRetry(async () => {
        const res = await agent.POST(markInternalCoworkRequest(fastRequest), { params: { agent: ["chat"] } });
        if (!res.ok || !res.body) throw new RetryableError(`伴聊快思考请求失败 (${res.status})`);
        return res;
      }, retryPolicy("low", {
        onRetry: (attempt, error, delayMs) => slog(sessionId, "cowork.chatmate.fast.retry", { id, attempt, error: error instanceof Error ? error.message : String(error), delayMs }, "warn"),
      }));
      if (fastResponse.body) {
        const fastText = await readCoworkText(fastResponse.body, () => {});
        const parsed = JSON.parse(fastText.match(/\{[\s\S]*\}/)?.[0] ?? "{}") as Record<string, unknown>;
        const decision = parsed.decision;
        if (decision === "skip" || decision === "reply" || decision === "slow") {
          fastDecision = { decision, reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "", ack: typeof parsed.ack === "string" ? parsed.ack.trim() : "" };
        }
      }
      slog(sessionId, "cowork.chatmate.fast.final", { id, messageId, decision: fastDecision?.decision, reply: fastDecision?.reply?.slice(0, 120) }, "info", 1000000);
    } catch (error) {
      console.error("[cowork] chatmate fast decision failed", error);
      slog(sessionId, "cowork.chatmate.fast.fallback", { id, reason: error instanceof Error ? error.message : String(error) }, "warn");
      fastDecision = null;
    }
    if (!fastDecision) {
      // 快思考失败降级：AI 消息默认不打扰；用户消息退回慢思考（与改造前行为一致）
      fastDecision = fastIsAiMessage ? { decision: "skip" } : { decision: "slow" };
    }
    // 明确对别人说话（@ 其他成员 / @或点名群 AI，且未 @ 当前用户）→ 强制不回复，
    // 覆盖模型快思考的 reply/slow 判断；手动触发（forceSlow）不经此分流，不受影响。
    if (addressedToOthers) {
      fastDecision = { decision: "skip" };
      slog(sessionId, "cowork.chatmate.skip_addressed_other", { id, messageId, aiTitle, mentionedMyself }, "info");
    }
    if (fastDecision.decision === "skip") {
      await pool.query("UPDATE cowork_chatmate SET status='done',tasks='[]'::jsonb,content='（已判断无需回复，未发言）',updated_at=now() WHERE id=$1 AND status='running'", [id]);
      await publishChatmate(sessionId, userSub, id);
      slog(sessionId, "cowork.chatmate.skipped", { id, messageId, isAiMessage: fastIsAiMessage }, "info");
      return;
    }
    if (fastDecision.decision === "reply") {
      const text = ensureReplyMention(fastDecision.reply?.trim(), chatmateMentionTarget, !!chatmateMentionTarget);
      // 必须先发送再置 done：postChatmateUpdate 的 INSERT 依赖 run 仍处于 running 状态，
      // 若先 UPDATE status='done'，自动回复会被 stopped_or_duplicate 静默吞掉（已发送不出的历史 bug）。
      // 发送本身被 try/catch 保护：即使自动回复发送失败，结论也必须落库并推送到面板，不能中断 run。
      if (text) { try { await postChatmateUpdate(request, sessionId, userSub, id, 0, text, messageId); } catch (error) { slog(sessionId, "cowork.chatmate.auto_send_error", { runId: id, index: 0, error: error instanceof Error ? error.message : String(error) }, "warn"); } }
      await pool.query("UPDATE cowork_chatmate SET status='done',content=$2,reasoning=$3,tasks='[]'::jsonb,updated_at=now() WHERE id=$1 AND status='running'",
        [id, text ?? "", `快思考直答：${text ?? ""}`]);
      await publishChatmate(sessionId, userSub, id);
      slog(sessionId, "cowork.chatmate.fast_reply", { id, messageId, reply: text?.slice(0, 120) }, "info");
      return;
    }
    // slow：先发占位（自动回复模式下可见），再进入主请求做完整建议生成/研究
    const ackText = (fastDecision.ack || "收到，我来看看。").trim();
    if (ackText) {
      try { await postChatmateUpdate(request, sessionId, userSub, id, 0, ackText, messageId, "ack"); } catch { /* 占位失败不阻塞主流程 */ }
    }
    } else {
      // 手动触发（强制慢思考）：跳过快思考分流，直接发占位再进主请求
      try { await postChatmateUpdate(request, sessionId, userSub, id, 0, "收到，我来看看。", messageId, "ack"); } catch { /* 占位失败不阻塞主流程 */ }
    }
    const chatRequest = new Request(url, { method: "POST", signal, headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
      body: JSON.stringify({ messages: resume ? [{ role: "system", content: system }, history.at(-1)!] : [{ role: "system", content: system }, ...history], sessionId: chatmateSessionId(sessionId, userSub),
        cowork: true, coworkChatmate: true, coworkAttachmentSessionId: sessionId, attachments: readableAttachments,
        resume, agentMode: mode, model: config.cowork_model ?? undefined, codexModelKey: config.cowork_codex_model ?? undefined }) });
    slog(sessionId, "cowork.chatmate.start", { id, messageId, userSub, resume, attachments: readableAttachments.map(item => item.name), images: images.length }, "info");
    // 伴聊建议生成重试（low=1 次）：HTTP 失败/流中断时重发一次
    const response = await withRetry(async () => {
      const res = await agent.POST(markInternalCoworkRequest(chatRequest), { params: { agent: ["chat"] } });
      if (!res.ok || !res.body) throw new RetryableError(`伴聊请求失败 (${res.status})`);
      return res;
    }, retryPolicy("low", {
      onRetry: (attempt, error, delayMs) => slog(sessionId, "cowork.chatmate.retry", { id, attempt, error: error instanceof Error ? error.message : String(error), delayMs }, "warn"),
    }));
    if (!response.body) throw new Error(`伴聊请求失败 (${response.status})`);
    const steps: RunStep[] = [];
    const startedAt = Date.now();
    let pendingWrite = Promise.resolve();
    let lastWrite = 0;
    const snapshot = (content: string) => {
      if (signal.aborted) return;
      const savedSteps = structuredClone(steps);
      const elapsed = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      pendingWrite = pendingWrite.then(async () => {
        const saved = await pool.query("UPDATE cowork_chatmate SET content=$2,steps=$3,elapsed_secs=$4,updated_at=now() WHERE id=$1 AND status='running' RETURNING id", [id, content, JSON.stringify(savedSteps), elapsed]);
        if (saved.rowCount) await publishChatmate(sessionId, userSub, id);
      });
    };
    const answer = await readCoworkText(response.body, (event, payload, content) => {
      const index = Math.max(1, Number(payload.index) || 1);
      const step = () => (steps[index - 1] ??= { thinking: "", text: "" });
      if (event === "thinking") step().thinking = `${step().thinking ?? ""}${String(payload.text ?? "")}`;
      else if (event === "tool") step().tool = { name: String(payload.name ?? ""), input: String(payload.input ?? ""), activity: String(payload.activity ?? ""),
        toolUseId: String(payload.toolUseId ?? ""), status: "running" };
      else if (event === "tool_result") {
        const tool = step().tool;
        if (tool && (!tool.toolUseId || !payload.toolUseId || tool.toolUseId === String(payload.toolUseId))) {
          tool.status = payload.status === "failed" ? "failed" : "completed";
          tool.result = String(payload.summary ?? "").slice(0, 300);
        }
      } else if (event.startsWith("browser_") && payload.id) {
        const current = steps.at(-1) ?? step();
        const browser = current.browser ??= { id: String(payload.id), screenshots: [], actions: [], ask: null };
        const kind = event.slice("browser_".length);
        if (kind === "thinking") browser.thinking = String(payload.text ?? "");
        else if (kind === "action") {
          const action = payload.action as Record<string, unknown> | undefined;
          if (action && typeof action.action === "string") browser.actions.push({ step: Number(payload.step) || 0, action: action.action, params: action });
          if (browser.actions.length > 40) browser.actions.shift();
        } else if (kind === "ask") { browser.ask = { step: Number(payload.step) || 0, question: String(payload.question ?? "") }; browser.status = "ask"; }
        else if (kind === "ask_result") { browser.ask = null; browser.status = "running"; }
        else if (["done", "error", "stopped", "finished"].includes(kind)) { browser.status = kind; browser.finalSummary = String(payload.summary ?? payload.text ?? ""); }
      }
      if ((["thinking", "tool", "tool_result", "text"].includes(event) || event.startsWith("browser_") && event !== "browser_screenshot") && Date.now() - lastWrite >= 350) {
        lastWrite = Date.now();
        snapshot(content);
      }
    });
    await pendingWrite;
    if (signal.aborted) return;
    const { reasoning, tasks, reaction, blocker, reply: proposedReply } = parseChatmateAnswer(answer);
    let reply = proposedReply;
    // 触发消息 @ 了当前用户/明确点名：答复 at 对方（模型可能漏写，这里兜底）
    reply = ensureReplyMention(reply, chatmateMentionTarget, !!chatmateMentionTarget);
    if (blocker?.decision === "ask_group" && await chatmateQuestionAlreadyAsked(sessionId, userSub, blocker.question!)) reply = null;
    await pool.query("UPDATE cowork_chatmate SET content=$2,reasoning=$3,draft_text=$4,steps=$5,tasks=$6,suggested_reaction=$7,blocker=$8,elapsed_secs=$9,updated_at=now() WHERE id=$1 AND status='running'",
      [id, answer, reasoning, reply, JSON.stringify(steps), JSON.stringify(tasks), reaction ? JSON.stringify(reaction) : null, blocker ? JSON.stringify(blocker) : null, Math.max(1, Math.round((Date.now() - startedAt) / 1000))]);
    await publishChatmate(sessionId, userSub, id);
    if (reaction) await applyChatmateReaction(sessionId, userSub, reaction);
    // 自动回复发送失败不中断主流程：结论已落库，send 错误只记日志（否则慢思考"思考过程闪一下就断"）
    if (reply && !tasks.length) { try { await postChatmateUpdate(request, sessionId, userSub, id, 0, reply, messageId); } catch (error) { slog(sessionId, "cowork.chatmate.auto_send_error", { runId: id, index: 0, error: error instanceof Error ? error.message : String(error) }, "warn"); } }
    const findings: string[] = [];
    for (let index = 0; index < tasks.length && !signal.aborted; index++) {
      tasks[index].status = "running";
      await pool.query("UPDATE cowork_chatmate SET tasks=$2,updated_at=now() WHERE id=$1 AND status='running'", [id, JSON.stringify(tasks)]);
      await publishChatmate(sessionId, userSub, id);
      try {
        const taskSystem = `你就是群成员 ${name}。请现在完成指定的单项研究任务。阅读提供的群聊上下文和附件，必要时使用网页工具查证，不要等待用户。只输出 JSON：{"outcome":"complete | ask_group | stop","finding":"具体发现和证据；受阻时写已知事实和信息缺口","update":"完成时从我第一人称给群里的实质进展","reason":"受阻时说明缺少什么以及为何不能继续","question":"仅当群成员很可能知道关键信息时，写一个具体问题"}。能独立查到的先查；确实缺少必需信息才受阻。群成员可能知道就用 ask_group，问一次后停止本轮任务；群成员也不大可能知道就用 stop，自行停止且不要追问。不要把猜测写成发现，默认不加 emoji。`;
        const taskPrompt = `任务 ${index + 1}/${tasks.length}：${tasks[index].title}\n${tasks[index].instruction}\n之前已完成的发现：${findings.join("\n") || "无"}`;
        const taskRequest = new Request(url, { method: "POST", signal, headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
          body: JSON.stringify({ messages: [{ role: "system", content: taskSystem }, ...history, { role: "user", content: taskPrompt }],
            sessionId: `${chatmateSessionId(sessionId, userSub)}_task_${id.replaceAll("-", "").slice(0, 16)}_${index}`, cowork: true, coworkChatmate: true,
            coworkAttachmentSessionId: sessionId, attachments: readableAttachments, resume: false, agentMode: mode,
            model: config.cowork_model ?? undefined, codexModelKey: config.cowork_codex_model ?? undefined }) });
        // 研究任务重试（low=1 次）：HTTP 失败/流中断时重发一次
        const taskResponse = await withRetry(async () => {
          const res = await agent.POST(markInternalCoworkRequest(taskRequest), { params: { agent: ["chat"] } });
          if (!res.ok || !res.body) throw new RetryableError(`研究任务请求失败 (${res.status})`);
          return res;
        }, retryPolicy("low", {
          onRetry: (attempt, error, delayMs) => slog(sessionId, "cowork.chatmate.task.retry", { id, index: index + 1, attempt, error: error instanceof Error ? error.message : String(error), delayMs }, "warn"),
        }));
        if (!taskResponse.body) throw new Error(`研究任务请求失败 (${taskResponse.status})`);
        const taskAnswer = await readCoworkText(taskResponse.body, () => {});
        if (signal.aborted) return;
        const match = taskAnswer.match(/\{[\s\S]*\}/);
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(match?.[0] ?? "{}"); } catch { /* Preserve plain-text findings. */ }
        const taskBlocker = parseChatmateBlocker(parsed.outcome === "ask_group" || parsed.outcome === "stop"
          ? { decision: parsed.outcome, reason: parsed.reason, question: parsed.question } : null);
        if (taskBlocker) {
          tasks.splice(0);
          const question = taskBlocker.decision === "ask_group" && !await chatmateQuestionAlreadyAsked(sessionId, userSub, taskBlocker.question!) ? taskBlocker.question! : null;
          await pool.query("UPDATE cowork_chatmate SET tasks=$2,blocker=$3,draft_text=$4,updated_at=now() WHERE id=$1 AND status='running'",
            [id, JSON.stringify(tasks), JSON.stringify(taskBlocker), question]);
          await publishChatmate(sessionId, userSub, id);
          if (question) await postChatmateUpdate(request, sessionId, userSub, id, index + 1, question, messageId);
          break;
        }
        const finding = (typeof parsed.finding === "string" ? parsed.finding : taskAnswer).trim().slice(0, 12000);
        const update = (typeof parsed.update === "string" ? parsed.update : finding).trim().slice(0, 12000);
        if (!finding) throw new Error("研究任务未返回结果");
        tasks[index].status = "done";
        tasks[index].result = finding;
        findings.push(`${tasks[index].title}：${finding}`);
        await pool.query("UPDATE cowork_chatmate SET tasks=$2,draft_text=$3,updated_at=now() WHERE id=$1 AND status='running'", [id, JSON.stringify(tasks), update]);
        await publishChatmate(sessionId, userSub, id);
        if (update) await postChatmateUpdate(request, sessionId, userSub, id, index + 1, ensureReplyMention(update, chatmateMentionTarget, !!chatmateMentionTarget), messageId);
      } catch (error) {
        if (signal.aborted) return;
        const failedTitle = tasks[index].title;
        tasks.splice(0);
        await pool.query("UPDATE cowork_chatmate SET tasks=$2,updated_at=now() WHERE id=$1 AND status='running'", [id, JSON.stringify(tasks)]);
        await publishChatmate(sessionId, userSub, id);
        await postChatmateUpdate(request, sessionId, userSub, id, index + 1, ensureReplyMention(`“${failedTitle}”这项我暂时没能核实，先不下结论。本轮先到这里。`, chatmateMentionTarget, !!chatmateMentionTarget), messageId);
        break;
      }
    }
    if (signal.aborted) return;
    const completed = await pool.query("UPDATE cowork_chatmate SET status='done',tasks=$2,elapsed_secs=$3,updated_at=now() WHERE id=$1 AND status='running' RETURNING id",
      [id, JSON.stringify(tasks), Math.max(1, Math.round((Date.now() - startedAt) / 1000))]);
    slog(sessionId, "cowork.chatmate.done", { id, messageId, userSub, hasReply: !!reply, tasks: tasks.length, reasoning }, "info");
    if (completed.rowCount) await publishChatmate(sessionId, userSub, id);
  }
  async function recoverStaleRun(sessionId: string) {
    const pool = getPool();
    if (!pool) return;
    await pool.query(`UPDATE cowork_runs r SET status='done',content=m.content,updated_at=now()
      FROM agent_messages m WHERE r.session_id=$1 AND r.status IN ('pending','running')
      AND r.updated_at < now() - interval '2 minutes' AND m.session_id=r.session_id AND m.run_id=r.id`, [sessionId]);
    await pool.query(`UPDATE cowork_runs SET status='abandoned',error='worker_lost',
      fast_status=CASE WHEN fast_status IN ('running','reviewing') THEN 'error' ELSE fast_status END,updated_at=now()
      WHERE session_id=$1 AND status IN ('pending','running') AND updated_at < now() - interval '2 minutes'`, [sessionId]);
  }

  async function access(request: Request, sessionId: string) {
    // 前端 <AgentApp title> 经 state(?title=) 上报应用名，缓存供默认 AI 命名与兜底；
    // 仅在携带时设置，无 query 不清空已有缓存。send 路径的应用名在 body，由 send() 设置。
    const queryTitle = new URL(request.url).searchParams.get("title");
    if (queryTitle) setAppDisplayName(queryTitle);
    const user = verifySession(request, loadAuthConfig());
    if (!user?.sub) return { error: json({ error: "unauthorized" }, 401) };
    const session = await getAgentSession(user.sub, sessionId);
    if (!session) return { error: json({ error: "not_found" }, 404) };
    const pool = getPool();
    if (!pool) return { error: json({ error: "database_required" }, 503) };
    await ensureMigrated();
    const count = await pool.query("SELECT count(*)::int AS n FROM agent_session_members WHERE session_id=$1", [sessionId]);
    if (!Number(count.rows[0]?.n)) return { error: json({ error: "not_group" }, 409) };
    // 1v1 群聊：发起人 + 恰好 1 名已加入成员。此时双方都是群管理员，可设置 AI、可解散群。
    const twoPerson = Number(count.rows[0]?.n) === 1;
    // 管理员按成员快照 provider+contact_id 存档；当前登录用户经 users 表（open_id/user_code/union_id）匹配。
    const adminRows = await pool.query(
      `SELECT a.provider, a.contact_id AS "contactId", a.name, a.avatar,
          u.provider || ':' || u.union_id AS "matchSub"
       FROM cowork_admins a
       LEFT JOIN users u ON u.provider=a.provider AND (u.open_id=a.contact_id OR u.user_code=a.contact_id OR u.union_id=a.contact_id)
       WHERE a.session_id=$1 ORDER BY a.created_at, a.provider, a.contact_id`,
      [sessionId]);
    const adminRoster = adminRows.rows.map(row => ({
      provider: String(row.provider), contactId: String(row.contactId),
      name: String(row.name ?? ""), avatar: String(row.avatar ?? ""),
    }));
    const isAdmin = twoPerson || session.userId === user.sub || adminRows.rows.some(row =>
      row.matchSub === user.sub
      || (row.provider === user.provider && (row.contactId === user.openId || row.contactId === user.unionId)));
    await pool.query(`INSERT INTO cowork_agents(id,session_id,name,prompt,created_by,reply_policy,speaking_prompt)
      SELECT $1,id,$3,COALESCE(cowork_fast_prompt,''),user_id,
        COALESCE(cowork_reply_policy,'mentions_only'),
        CASE WHEN cowork_reply_policy='custom' THEN COALESCE(cowork_fast_prompt,'') ELSE '' END
      FROM agent_sessions WHERE id=$2
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,updated_at=now()
      WHERE cowork_agents.name<>EXCLUDED.name
        AND NOT EXISTS (SELECT 1 FROM cowork_agents other
          WHERE other.session_id=cowork_agents.session_id AND other.id<>cowork_agents.id AND lower(other.name)=lower(EXCLUDED.name))`,
      [`${sessionId}:default`, sessionId, AI_DISPLAY_NAME]);
    return { user, session, pool, twoPerson, adminRoster, isAdmin };
  }

  async function agents(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const pool = ctx.pool!;
    if (request.method === "GET") {
      const [result, members, group] = await Promise.all([
        pool.query(`SELECT id,name,prompt,enabled,preview_token AS "previewPublicId",reply_policy AS "replyPolicy",speaking_prompt AS "speakingPrompt",prompt_by_policy AS "promptByPolicy",created_by AS "createdBy" FROM cowork_agents
          WHERE session_id=$1 ORDER BY created_at,id`, [sessionId]),
        pool.query(`SELECT sm.provider || ':' || sm.contact_id AS sub,
            COALESCE(NULLIF(u.name,''),u.user_code,NULLIF(sm.name,''),'成员') AS name,
            COALESCE(u.provider || ':' || u.union_id=$2,false) AS "isSelf"
          FROM agent_session_members sm JOIN agent_sessions s ON s.id=sm.session_id
          LEFT JOIN users u ON u.provider=sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
          WHERE sm.session_id=$1 AND (u.union_id IS NULL OR u.provider || ':' || u.union_id<>s.user_id)
          UNION SELECT s.user_id AS sub,COALESCE(NULLIF(u.name,''),u.user_code,'发起人') AS name,
            s.user_id=$2 AS "isSelf" FROM agent_sessions s
            LEFT JOIN users u ON u.provider || ':' || u.union_id=s.user_id WHERE s.id=$1`, [sessionId, ctx.user!.sub]),
        pool.query("SELECT cowork_container_enabled AS enabled FROM agent_sessions WHERE id=$1", [sessionId]),
      ]);
      const agentsWithPrompt = result.rows.map(agent => ({ ...agent, prompt: promptForAgent(agent) }));
      return json({ agents: agentsWithPrompt, members: members.rows, ownerSub: ctx.session!.userId, selfSub: ctx.user!.sub, isTwoPerson: ctx.twoPerson, isAdmin: ctx.isAdmin, adminRoster: ctx.adminRoster, containerEnabled: Boolean(group.rows[0]?.enabled) });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (request.method === "POST") {
      // 群主、任命管理员、1v1 双方均可新增群 AI。
      if (!ctx.isAdmin) return json({ error: "owner_only" }, 403);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 80 || /[\r\n@]/u.test(name) || /^(所有人|all)$/iu.test(name)) return json({ error: "invalid_name" }, 400);
      const prompt = body.prompt === undefined ? "" : typeof body.prompt === "string" ? body.prompt : null;
      const replyPolicy = body.replyPolicy === undefined ? "mentions_only" : isReplyPolicy(body.replyPolicy) ? body.replyPolicy : null;
      const speakingPrompt = body.speakingPrompt === undefined ? "" : typeof body.speakingPrompt === "string" ? body.speakingPrompt : null;
      if (prompt === null || prompt.length > 20000) return json({ error: "invalid_prompt" }, 400);
      if (replyPolicy === null) return json({ error: "invalid_reply_policy" }, 400);
      if (speakingPrompt === null || speakingPrompt.length > 8000) return json({ error: "invalid_speaking_prompt" }, 400);
      const result = await pool.query(`INSERT INTO cowork_agents(id,session_id,name,created_by,prompt,reply_policy,speaking_prompt,prompt_by_policy) VALUES($1,$2,$3,$4,$5,$6::text,$7,jsonb_build_object($6::text,$5::text))
        ON CONFLICT DO NOTHING RETURNING id,name,prompt,enabled,reply_policy AS "replyPolicy",speaking_prompt AS "speakingPrompt",prompt_by_policy AS "promptByPolicy",created_by AS "createdBy"`, [randomUUID(), sessionId, name, ctx.user!.sub, prompt, replyPolicy, speakingPrompt]);
      if (!result.rowCount) return json({ error: "duplicate_name" }, 409);
      publishCowork(sessionId, { kind: "agents" });
      return json({ agent: { ...result.rows[0], prompt: promptForAgent(result.rows[0]) } }, 201);
    }
    const id = typeof body.id === "string" ? body.id : "";
    const existing = await pool.query("SELECT id,created_by,name FROM cowork_agents WHERE session_id=$1 AND id=$2", [sessionId, id]);
    if (!existing.rowCount) return json({ error: "not_found" }, 404);
    // 群主、AI 创建者、任命管理员、1v1 双方均可编辑/删除任一 AI。
    if (!ctx.isAdmin && existing.rows[0].created_by !== ctx.user!.sub) return json({ error: "forbidden" }, 403);
    if (request.method === "PATCH") {
      if (body.restoreDefault === true) {
        if (id !== `${sessionId}:default`) return json({ error: "not_default_agent" }, 400);
        const defaultPrompt = defaultPromptForPolicy("mentions_only");
        let restored;
        try {
          restored = await pool.query(`UPDATE cowork_agents SET name=$2,prompt=$3,prompt_by_policy='{}'::jsonb,reply_policy='mentions_only',speaking_prompt='',updated_at=now()
            WHERE session_id=$1 AND id=$4 RETURNING id,name,prompt,enabled,reply_policy AS "replyPolicy",speaking_prompt AS "speakingPrompt",prompt_by_policy AS "promptByPolicy",created_by AS "createdBy"`, [sessionId, getAppDisplayName(), defaultPrompt, id]);
        } catch (error) { if ((error as { code?: string }).code === "23505") return json({ error: "duplicate_name" }, 409); throw error; }
        await pool.query("UPDATE agent_sessions SET cowork_reply_policy='mentions_only',cowork_fast_prompt=$2 WHERE id=$1", [sessionId, defaultPrompt]);
        publishCowork(sessionId, { kind: "agents" });
        return json({ agent: { ...restored.rows[0], prompt: promptForAgent(restored.rows[0]) } });
      }
      const name = body.name === undefined ? null : typeof body.name === "string" ? body.name.trim() : "";
      const prompt = body.prompt === undefined ? null : typeof body.prompt === "string" ? body.prompt : null;
      const enabled = body.enabled === undefined ? null : typeof body.enabled === "boolean" ? body.enabled : null;
      const replyPolicy = body.replyPolicy === undefined ? null : isReplyPolicy(body.replyPolicy) ? body.replyPolicy : null;
      const speakingPrompt = body.speakingPrompt === undefined ? null : typeof body.speakingPrompt === "string" ? body.speakingPrompt : null;
      if (name !== null && (!name || name.length > 80 || /[\r\n@]/u.test(name) || /^(所有人|all)$/iu.test(name))) return json({ error: "invalid_name" }, 400);
      if (body.prompt !== undefined && (prompt === null || prompt.length > 20000)) return json({ error: "invalid_prompt" }, 400);
      if (body.enabled !== undefined && enabled === null) return json({ error: "invalid_enabled" }, 400);
      if (body.replyPolicy !== undefined && replyPolicy === null) return json({ error: "invalid_reply_policy" }, 400);
      if (body.speakingPrompt !== undefined && (speakingPrompt === null || speakingPrompt.length > 8000)) return json({ error: "invalid_speaking_prompt" }, 400);
      if (name !== null) {
        const duplicate = await pool.query("SELECT 1 FROM cowork_agents WHERE session_id=$1 AND lower(name)=lower($2) AND id<>$3", [sessionId, name, id]);
        if (duplicate.rowCount) return json({ error: "duplicate_name" }, 409);
      }
      let result;
      try {
        result = await pool.query(`UPDATE cowork_agents SET name=COALESCE($3,name),prompt=COALESCE($4,prompt),enabled=COALESCE($5,enabled),
          reply_policy=COALESCE($6,reply_policy),speaking_prompt=COALESCE($7,speaking_prompt),
          prompt_by_policy=CASE WHEN $4::text IS NULL THEN prompt_by_policy ELSE jsonb_set(prompt_by_policy,ARRAY[COALESCE($6,reply_policy)],to_jsonb($4::text),true) END,
          updated_at=now()
          WHERE session_id=$1 AND id=$2 RETURNING id,name,prompt,enabled,reply_policy AS "replyPolicy",speaking_prompt AS "speakingPrompt",prompt_by_policy AS "promptByPolicy",created_by AS "createdBy"`, [sessionId, id, name, prompt, enabled, replyPolicy, speakingPrompt]);
      } catch (error) { if ((error as { code?: string }).code === "23505") return json({ error: "duplicate_name" }, 409); throw error; }
      if (prompt !== null && id === `${sessionId}:default`) await pool.query("UPDATE agent_sessions SET cowork_fast_prompt=$2 WHERE id=$1", [sessionId, prompt]);
      publishCowork(sessionId, { kind: "agents" });
      return json({ agent: { ...result.rows[0], prompt: promptForAgent(result.rows[0]) } });
    }
    if (request.method === "DELETE") {
      if (id === `${sessionId}:default`) return json({ error: "default_agent" }, 409);
      const foreign = await pool.query("SELECT 1 FROM cowork_connections WHERE agent_id=$1 AND owner_sub<>$2 LIMIT 1", [id, ctx.user!.sub]);
      if (foreign.rowCount) return json({ error: "other_members_connections" }, 409);
      // 容器是群级共享资源，删除单个 AI 不关闭群容器。
      await pool.query("DELETE FROM cowork_agents WHERE session_id=$1 AND id=$2", [sessionId, id]);
      publishCowork(sessionId, { kind: "agents" });
      return json({ ok: true });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  /** 群级共享容器开关：一个群一个容器，群内所有 AI 共享（仅群主可开关）。 */
  async function container(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const pool = ctx.pool!;
    if (request.method === "GET") {
      const group = await pool.query("SELECT cowork_container_enabled AS enabled FROM agent_sessions WHERE id=$1", [sessionId]);
      return json({ containerEnabled: Boolean(group.rows[0]?.enabled) });
    }
    if (request.method !== "PATCH") return json({ error: "method_not_allowed" }, 405);
    // 云电脑群容器开关：群主、任命管理员、1v1 双方均可操作。
    if (!ctx.isAdmin) return json({ error: "owner_only" }, 403);
    const body = await request.json().catch(() => ({})) as { containerEnabled?: unknown };
    if (typeof body.containerEnabled !== "boolean") return json({ error: "invalid_container_enabled" }, 400);
    try {
      if (body.containerEnabled) await ensureGroupContainer(sessionId);
      else await removeGroupContainer(sessionId);
    } catch (error) { return json({ error: error instanceof Error ? error.message : "container_failed" }, 503); }
    await pool.query("UPDATE agent_sessions SET cowork_container_enabled=$2,updated_at=now() WHERE id=$1", [sessionId, body.containerEnabled]);
    if (body.containerEnabled) await restoreGroupPreview(sessionId);
    publishCowork(sessionId, { kind: "agents" });
    return json({ ok: true });
  }

  /** Web 终端：在群共享容器内执行一条 shell 命令，返回合并后的输出、退出码与最终工作目录（根目录固定落在群 AI 读写目录）。 */
  async function exec(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await request.json().catch(() => ({})) as { cmd?: unknown; cwd?: unknown };
    if (typeof body.cmd !== "string" || !body.cmd.trim()) return json({ error: "invalid_command" }, 400);
    const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
    try {
      const { output, code, cwd: next } = await execGroupBashTerminal(sessionId, body.cmd, cwd);
      return json({ output, code, cwd: next });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "exec_failed" }, 503);
    }
  }

  /** Web 终端 Tab 补全：返回候选列表（容器未运行时为空，不触发冷启动）。 */
  async function complete(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    const body = await request.json().catch(() => ({})) as { token?: unknown; cwd?: unknown; command?: unknown };
    const token = typeof body.token === "string" ? body.token : "";
    const cwd = typeof body.cwd === "string" ? body.cwd : "/group/artifacts";
    try {
      return json({ items: await completeGroupBash(sessionId, cwd, token, body.command === true) });
    } catch { return json({ items: [] }); }
  }

  /** 恢复群内最近一次保存的预览启动命令（共享容器同一时刻只能跑一个预览应用）。
   *  应用已在容器内监听 3000 时，startGroupPreview 的幂等预检会直接跳过，不会重复启动。 */
  async function restoreGroupPreview(sessionId: string): Promise<void> {
    const pool = getPool();
    if (!pool) return;
    await ensureMigrated();
    const saved = await pool.query(`SELECT preview_command FROM cowork_agents
      WHERE session_id=$1 AND preview_command IS NOT NULL AND preview_command<>''
      ORDER BY updated_at DESC LIMIT 1`, [sessionId]);
    let command = saved.rows[0]?.preview_command as string | undefined;
    if (!command) {
      const older = await pool.query(`SELECT step->'tool'->>'input' AS input FROM cowork_runs r,
        LATERAL jsonb_array_elements(r.steps) AS step
        WHERE r.session_id=$1 AND step->'tool'->>'name' LIKE '%__start_preview'
          AND step->'tool'->>'status'='completed' ORDER BY r.created_at DESC LIMIT 1`, [sessionId]);
      try { command = JSON.parse(String(older.rows[0]?.input ?? "{}")).cmd; } catch { /* no prior preview */ }
    }
    if (typeof command !== "string" || !command.trim()) return;
    try { await startGroupPreview(sessionId, command); }
    catch (error) { console.warn("[cowork] preview restore failed", error); }
  }

  async function preview(request: Request, sessionId: string, agentId: string, rest: string[], publicPrefix?: string): Promise<Response> {
    // Next.js strips basePath before invoking its route handler; AUTH_COOKIE_PATH carries the public mount path.
    const basePath = process.env.AUTH_COOKIE_PATH?.replace(/\/+$/, "") ?? new URL(request.url).pathname.split("/api/")[0];
    const prefix = publicPrefix ?? `${basePath}/api/cowork/${encodeURIComponent(sessionId)}/preview/${encodeURIComponent(agentId)}`;
    const storedAgentId = agentId === "default" ? `${sessionId}:default` : agentId;
    const suppliedToken = rest[0] ?? "";
    let previewToken = suppliedToken;
    if (!/^[0-9a-f]{48}$/.test(suppliedToken)) {
      const ctx = await access(request, sessionId);
      if (ctx.error) return ctx.error;
      const enabled = await ctx.pool!.query(`SELECT a.preview_token FROM cowork_agents a
        JOIN agent_sessions s ON s.id=a.session_id
        WHERE a.session_id=$1 AND a.id=$2 AND s.cowork_container_enabled=true`, [sessionId, storedAgentId]);
      if (!enabled.rowCount) return json({ error: "preview_not_enabled" }, 404);
      previewToken = enabled.rows[0].preview_token as string | null ?? "";
      if (!previewToken) {
        await ctx.pool!.query("UPDATE cowork_agents SET preview_token=$3 WHERE session_id=$1 AND id=$2 AND preview_token IS NULL", [sessionId, storedAgentId, randomBytes(24).toString("hex")]);
        const updated = await ctx.pool!.query("SELECT preview_token FROM cowork_agents WHERE session_id=$1 AND id=$2", [sessionId, storedAgentId]);
        previewToken = String(updated.rows[0]?.preview_token ?? "");
      }
      return Response.redirect(new URL(`${prefix}/${previewToken}/`, request.url), 302);
    }
    const pool = getPool();
    if (!pool) return json({ error: "database_required" }, 503);
    await ensureMigrated();
    const enabled = await pool.query(`SELECT 1 FROM cowork_agents a
      JOIN agent_sessions s ON s.id=a.session_id
      WHERE a.session_id=$1 AND a.id=$2 AND s.cowork_container_enabled=true AND a.preview_token=$3`, [sessionId, storedAgentId, suppliedToken]);
    if (!enabled.rowCount) return json({ error: "preview_not_enabled" }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: {
      "Access-Control-Allow-Origin": "null", "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,authorization", "Access-Control-Max-Age": "600",
    } });
    let origin: string;
    try { origin = await groupPreviewOrigin(sessionId); }
    catch { return json({ error: "preview_not_ready" }, 503); }
    // 容器内应用按 start_preview 约定把 basePath 设为公开挂载路径 /linger/preview/<token>，
    // 转发时必须带上完整前缀（含 token），否则应用对容器根路径返回 404。
    const publicMount = `${publicPrefix ?? `${basePath}/preview`}/${previewToken}`;
    const restPath = rest.slice(1).map(encodeURIComponent).join("/");
    const target = new URL(restPath ? `${publicMount}/${restPath}` : publicMount, `${origin}/`);
    target.search = new URL(request.url).search;
    const headers = new Headers();
    for (const key of ["accept", "content-type", "range", "if-none-match", "if-modified-since"]) {
      const value = request.headers.get(key);
      if (value) headers.set(key, value);
    }
    const upstreamBody = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    const tryFetch = () => fetch(target, { method: request.method, headers,
      body: upstreamBody, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    let upstream: Response | undefined;
    try { upstream = await tryFetch(); } catch { /* 应用未响应 */ }
    if (!upstream) {
      // 应用没在跑：触发一次恢复（群内最近保存的预览命令），再轮询等待其启动，打开链接即自愈。
      void restoreGroupPreview(sessionId);
      for (let attempt = 0; attempt < 10 && !upstream; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        try { upstream = await tryFetch(); } catch { /* 继续等待 */ }
      }
    }
    if (!upstream) return json({ error: "preview_app_unavailable" }, 502);
    const outgoing = new Headers();
    for (const key of ["content-type", "etag", "last-modified", "accept-ranges", "content-range"]) {
      const value = upstream.headers.get(key);
      if (value) outgoing.set(key, value);
    }
    const location = upstream.headers.get("location");
    if (location) {
      const resolved = new URL(location, target);
      // 容器内应用的跳转路径已带 basePath 前缀，原样透传即可，避免前缀重复。
      if (resolved.origin === origin) {
        outgoing.set("location", `${resolved.pathname}${resolved.search}`);
      }
    }
    // The host's right-pane browser is a regular browser. Sandboxing its
    // loopback preview gives it an opaque origin and breaks Next's dev overlay,
    // which inspects frame documents. Keep the sandbox on non-local hosts.
    // Next's route handler may normalize request.url to its bind address.
    const previewHost = new URL(`http://${request.headers.get("host") ?? ""}`).hostname;
    if (previewHost !== "localhost" && previewHost !== "127.0.0.1" && previewHost !== "[::1]") {
      outgoing.set("Content-Security-Policy", "sandbox allow-scripts allow-forms");
    }
    outgoing.set("Access-Control-Allow-Origin", "null");
    outgoing.set("Cache-Control", "no-store");
    outgoing.set("Referrer-Policy", "no-referrer");
    outgoing.set("X-Content-Type-Options", "nosniff");
    if (upstream.headers.get("content-type")?.toLowerCase().includes("text/html")) {
      const html = await upstream.text();
      const baseHref = `${prefix}/${previewToken}/`;
      const withBase = /<base\s/i.test(html) ? html : html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}<base href="${baseHref}">`);
      outgoing.delete("etag");
      outgoing.delete("last-modified");
      return new Response(withBase, { status: upstream.status, headers: outgoing });
    }
    return new Response(upstream.body, { status: upstream.status, headers: outgoing });
  }

  async function publicPreview(request: Request, publicId: string, rest: string[]): Promise<Response> {
    if (!/^[0-9a-f]{48}$/.test(publicId)) return json({ error: "preview_not_found" }, 404);
    const pool = getPool();
    if (!pool) return json({ error: "database_required" }, 503);
    await ensureMigrated();
    const result = await pool.query(`SELECT a.session_id,a.id,s.cowork_container_enabled AS "containerEnabled"
      FROM cowork_agents a JOIN agent_sessions s ON s.id=a.session_id WHERE a.preview_token=$1`, [publicId]);
    if (!result.rowCount) return json({ error: "preview_not_found" }, 404);
    if (!result.rows[0].containerEnabled) return new Response("预览暂不可用，容器启动后可继续使用此链接。", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    const basePath = process.env.AUTH_COOKIE_PATH?.replace(/\/+$/, "") ?? "";
    return preview(request, String(result.rows[0].session_id), String(result.rows[0].id), [publicId, ...rest], `${basePath}/preview`);
  }

  async function connections(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const pool = ctx.pool!;
    if (request.method === "GET") {
      const result = await pool.query(`SELECT c.id,c.agent_id AS "agentId",c.name,c.kind,c.target,c.owner_sub AS "ownerSub",COALESCE(NULLIF(u.name,''),u.user_code,'成员') AS "ownerName",COALESCE(u.avatar,'') AS "ownerAvatar",c.enabled,
        COALESCE(array_agg(g.user_sub) FILTER (WHERE g.user_sub IS NOT NULL),'{}') AS grants
        FROM cowork_connections c LEFT JOIN cowork_connection_grants g ON g.connection_id=c.id
        LEFT JOIN users u ON u.provider || ':' || u.union_id=c.owner_sub
        WHERE c.session_id=$1 GROUP BY c.id,u.name,u.user_code,u.avatar ORDER BY c.created_at`, [sessionId]);
      return json({ connections: result.rows });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const validateGrants = async (raw: unknown): Promise<string[] | null> => {
      if (!Array.isArray(raw) || raw.some(item => typeof item !== "string") || raw.length > 100) return null;
      const members = await pool.query(`SELECT sm.provider || ':' || sm.contact_id AS sub,
          COALESCE(u.provider || ':' || u.union_id=$2,false) AS "isSelf"
        FROM agent_session_members sm LEFT JOIN users u ON u.provider=sm.provider
          AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
        WHERE sm.session_id=$1
        UNION SELECT s.user_id AS sub,s.user_id=$2 AS "isSelf" FROM agent_sessions s WHERE s.id=$1`, [sessionId, ctx.user!.sub]);
      const allowed = new Map(members.rows.map(row => [String(row.sub), Boolean(row.isSelf)]));
      const unique = [...new Set(raw as string[])];
      if (unique.some(sub => !allowed.has(sub))) return null;
      return unique.filter(sub => !allowed.get(sub));
    };
    if (request.method === "POST") {
      const key = secretKey();
      if (!key) return json({ error: "invalid_secret_key" }, 503);
      const agentId = typeof body.agentId === "string" ? body.agentId : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const kind = typeof body.kind === "string" ? body.kind.trim() : "token";
      const target = typeof body.target === "string" ? body.target.trim() : "";
      const value = typeof body.secret === "string" ? body.secret : "";
      if (!name || name.length > 80 || !/^[a-z0-9_-]{1,32}$/i.test(kind) || target.length > 1000 || !value || value.length > 16000) return json({ error: "invalid_connection" }, 400);
      const grants = await validateGrants(body.grants ?? []);
      if (!grants) return json({ error: "grant_requires_member" }, 400);
      const agent = await pool.query("SELECT 1 FROM cowork_agents WHERE session_id=$1 AND id=$2", [sessionId, agentId]);
      if (!agent.rowCount) return json({ error: "agent_not_found" }, 404);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(`INSERT INTO cowork_connections(id,session_id,agent_id,name,kind,target,secret_ciphertext,owner_sub)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (agent_id,name) DO NOTHING RETURNING id`,
          [randomUUID(), sessionId, agentId, name, kind, target, encryptSecret(value, key), ctx.user!.sub]);
        if (!result.rowCount) { await client.query("ROLLBACK"); return json({ error: "duplicate_name" }, 409); }
        const id = result.rows[0].id as string;
        for (const sub of grants) await client.query("INSERT INTO cowork_connection_grants(connection_id,user_sub) VALUES($1,$2)", [id, sub]);
        await client.query("INSERT INTO cowork_connection_audit(session_id,connection_id,actor_sub,action,detail) VALUES($1,$2,$3,'create',$4)",
          [sessionId, id, ctx.user!.sub, JSON.stringify({ name, kind, target, agentId, grants })]);
        await client.query("COMMIT");
        return json({ ok: true, id }, 201);
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
    const id = typeof body.id === "string" ? body.id : "";
    const found = await pool.query("SELECT owner_sub FROM cowork_connections WHERE session_id=$1 AND id=$2", [sessionId, id]);
    if (!found.rowCount) return json({ error: "not_found" }, 404);
    const ownsConnection = found.rows[0].owner_sub === ctx.user!.sub;
    const emergencyDisable = request.method === "PATCH" && ctx.session!.userId === ctx.user!.sub && body.enabled === false
      && body.grants === undefined && body.name === undefined && body.target === undefined && body.secret === undefined;
    if (!ownsConnection && !emergencyDisable) return json({ error: "owner_only" }, 403);
    if (request.method === "DELETE") {
      await pool.query("DELETE FROM cowork_connections WHERE session_id=$1 AND id=$2", [sessionId, id]);
      await pool.query("INSERT INTO cowork_connection_audit(session_id,connection_id,actor_sub,action) VALUES($1,$2,$3,'delete')", [sessionId, id, ctx.user!.sub]);
      return json({ ok: true });
    }
    if (request.method === "PATCH") {
      const name = body.name === undefined ? null : typeof body.name === "string" ? body.name.trim() : "";
      const target = body.target === undefined ? null : typeof body.target === "string" ? body.target.trim() : null;
      const secret = body.secret === undefined ? null : typeof body.secret === "string" ? body.secret : "";
      if (name !== null && (!name || name.length > 80)) return json({ error: "invalid_name" }, 400);
      if (body.target !== undefined && (target === null || target.length > 1000)) return json({ error: "invalid_target" }, 400);
      if (secret !== null && (!secret || secret.length > 16000)) return json({ error: "invalid_secret" }, 400);
      const key = secret === null ? null : secretKey();
      if (secret !== null && !key) return json({ error: "invalid_secret_key" }, 503);
      if (name !== null || target !== null || secret !== null) {
        try {
          await pool.query("UPDATE cowork_connections SET name=COALESCE($2,name),target=COALESCE($3,target),secret_ciphertext=COALESCE($4,secret_ciphertext) WHERE id=$1", [id, name, target, secret === null ? null : encryptSecret(secret, key!)]);
        } catch (error) { if ((error as { code?: string }).code === "23505") return json({ error: "duplicate_name" }, 409); throw error; }
      }
      if (body.grants !== undefined) {
        const unique = await validateGrants(body.grants);
        if (!unique) return json({ error: "grant_requires_member" }, 400);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("DELETE FROM cowork_connection_grants WHERE connection_id=$1", [id]);
          for (const sub of unique) await client.query("INSERT INTO cowork_connection_grants(connection_id,user_sub) VALUES($1,$2)", [id, sub]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") return json({ error: "invalid_enabled" }, 400);
        await pool.query("UPDATE cowork_connections SET enabled=$2 WHERE id=$1", [id, body.enabled]);
      }
      await pool.query("INSERT INTO cowork_connection_audit(session_id,connection_id,actor_sub,action,detail) VALUES($1,$2,$3,'update',$4)",
        [sessionId, id, ctx.user!.sub, JSON.stringify({ ...(name !== null ? { name } : {}), ...(target !== null ? { target } : {}), ...(secret !== null ? { secretUpdated: true } : {}), ...(body.grants !== undefined ? { grants: body.grants } : {}), ...(body.enabled !== undefined ? { enabled: body.enabled } : {}) })]);
      return json({ ok: true });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  async function agentsForMessage(pool: NonNullable<ReturnType<typeof getPool>>, sessionId: string, content: string): Promise<CoworkAgent[]> {
    const result = await pool.query(`SELECT id,name,prompt,enabled,reply_policy AS "replyPolicy",speaking_prompt AS "speakingPrompt",prompt_by_policy AS "promptByPolicy",created_by AS "createdBy" FROM cowork_agents
      WHERE session_id=$1 ORDER BY length(name) DESC,created_at`, [sessionId]);
    const addressed = result.rows.map(row => {
      const escaped = String(row.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { row, index: content.search(new RegExp(`[@＠]\\s*${escaped}(?=$|[\\s，。！？?,.!:：；;])`, "i")) };
    }).filter(item => item.index >= 0).sort((a, b) => a.index - b.index);
    if (addressed.length) return addressed.filter(item => item.row.enabled).map(item => ({ ...item.row, prompt: promptForAgent(item.row) } as CoworkAgent));
    return result.rows.filter(row => row.enabled && row.replyPolicy !== "mentions_only").map(row => ({ ...row, prompt: promptForAgent(row) } as CoworkAgent));
  }

  async function state(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const { user, session, pool } = ctx;
    await recoverStaleRun(sessionId);
    const interrupted = await pool!.query(`SELECT r.trigger_message_id FROM cowork_runs r
      JOIN agent_messages m ON m.id=r.trigger_message_id AND m.revoked_at IS NULL
      WHERE r.session_id=$1 AND r.status='abandoned' AND r.error='worker_lost'
        AND r.updated_at > now() - interval '15 minutes'
        AND NOT EXISTS (SELECT 1 FROM cowork_runs newer WHERE newer.session_id=r.session_id
          AND newer.agent_id=r.agent_id AND newer.trigger_message_id>=r.trigger_message_id AND newer.status<>'abandoned')
      ORDER BY r.trigger_message_id DESC LIMIT 1`, [sessionId]);
    if (interrupted.rowCount) void scheduleMessageRunsForTrigger(request, sessionId, Number(interrupted.rows[0].trigger_message_id))
      .catch(error => console.error("[cowork] interrupted run recovery failed", error));
    const [runs, settings, owner, participantReads] = await Promise.all([
      pool!.query("SELECT * FROM cowork_runs WHERE session_id=$1 AND status IN ('pending','running') ORDER BY created_at DESC LIMIT 1", [sessionId]),
      pool!.query("SELECT title, cowork_avatar, cowork_mode, cowork_model, cowork_codex_model, cowork_reply_policy, cowork_fast_prompt FROM agent_sessions WHERE id=$1", [sessionId]),
      pool!.query("SELECT COALESCE(NULLIF(name,''),user_code) AS name,avatar FROM users WHERE provider || ':' || union_id=$1 LIMIT 1", [session!.userId]),
      pool!.query(`WITH people AS (
        SELECT s.user_id AS user_sub, COALESCE(NULLIF(u.name,''),u.user_code,'发起人') AS name, COALESCE(u.avatar,'') AS avatar, s.created_at AS added_at
          FROM agent_sessions s LEFT JOIN users u ON u.provider || ':' || u.union_id=s.user_id WHERE s.id=$1
        UNION
        SELECT COALESCE(u.provider || ':' || u.union_id,sm.provider || ':' || sm.contact_id),
          COALESCE(NULLIF(u.name,''),u.user_code,sm.name),COALESCE(u.avatar,sm.avatar),sm.added_at
          FROM agent_session_members sm LEFT JOIN users u ON u.provider=sm.provider
            AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id)) WHERE sm.session_id=$1
      ) SELECT DISTINCT ON (p.user_sub) p.user_sub AS "userSub",p.name,p.avatar,p.added_at AS "addedAt",COALESCE(r.last_read_message_id,0)::text AS "throughId"
        FROM people p LEFT JOIN agent_session_reads r ON r.session_id=$1 AND r.user_sub=p.user_sub ORDER BY p.user_sub,p.added_at`,[sessionId]),
    ]);
    const rawAfter = Number(new URL(request.url).searchParams.get("after") ?? 0);
    const after = Number.isSafeInteger(rawAfter) && rawAfter > 0 ? rawAfter : 0;
    const messages = await listAgentMessagesSince(user!.sub, sessionId, after);
    const monologues = await pool!.query(`SELECT id,agent_id AS "agentId",fast_status AS status,fast_content AS content,fast_steps AS steps,fast_elapsed_secs AS "elapsedSecs",fast_initial_content AS "initialContent",fast_initial_elapsed_secs AS "initialElapsedSecs",fast_steers AS "fastSteers",created_at AS "startedAt",updated_at AS "finishedAt"
      FROM cowork_runs WHERE session_id=$1 AND fast_status<>'pending' ORDER BY created_at,id`, [sessionId]);
    const reactions = await pool!.query("SELECT r.message_id, r.user_sub, CASE WHEN r.user_sub='agent' THEN NULL ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS user_name, r.emoji FROM cowork_message_reactions r JOIN agent_messages m ON m.id=r.message_id JOIN agent_sessions s ON s.id=m.session_id LEFT JOIN users u ON u.provider || ':' || u.union_id=r.user_sub WHERE m.session_id=$1 ORDER BY r.created_at,r.emoji", [sessionId]);
    // 注意：此处不再做「查看即补跑 AI」的恢复。打开群聊/1v1 仅查看聊天记录属于只读操作，
    // 不能静默触发 AI 运行（会产生新消息并把会话 updated_at 刷成当前）。
    // 未被答复的用户消息会在下一条真实消息到达时由 send/chatmate 路径统一调度答复。
    const run = runs.rows[0]?.visible ? { ...runs.rows[0], agentId: runs.rows[0].agent_id, elapsedSecs: runs.rows[0].elapsed_secs == null ? null : Number(runs.rows[0].elapsed_secs), startedAt: runs.rows[0].created_at } : null;
    return json({ messages, run, participantReads: participantReads.rows, monologues: expandMonologues(monologues.rows), reactions: reactions.rows, settings: settings.rows[0]
      ? { ...settings.rows[0], cowork_fast_prompt: settings.rows[0].cowork_fast_prompt || defaultPromptForPolicy(isReplyPolicy(settings.rows[0].cowork_reply_policy) ? settings.rows[0].cowork_reply_policy : "mentions_only") } : null,
      ownerSub: session!.userId, ownerName: owner.rows[0]?.name ?? "发起人", ownerAvatar: owner.rows[0]?.avatar ?? "", isTwoPerson: ctx.twoPerson, isAdmin: ctx.isAdmin, adminRoster: ctx.adminRoster });
  }

  /**
   * GET    /api/cowork/:id/admins → 管理员名单（按成员快照，不含群主）
   * POST   /api/cowork/:id/admins {provider, contactId, name, avatar} → 群主任命（目标须为群成员，未登录亦可）
   * DELETE /api/cowork/:id/admins {provider, contactId} → 群主取消管理员
   * 任免仅群主；1v1 不走此接口（双方天然为管理角色）。
   */
  async function admins(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const pool = ctx.pool!;
    if (request.method === "GET") {
      const rows = await pool.query(
        `SELECT provider, contact_id AS "contactId", name, avatar, promoted_by AS "promotedBy", created_at AS "createdAt"
         FROM cowork_admins WHERE session_id=$1 ORDER BY created_at, provider, contact_id`, [sessionId]);
      return json({ admins: rows.rows, ownerSub: ctx.session!.userId, selfSub: ctx.user!.sub, isTwoPerson: ctx.twoPerson });
    }
    // 任免仅群主本人（1v1 双方天然平等，不出现任免入口）。
    if (ctx.session!.userId !== ctx.user!.sub) return json({ error: "owner_only" }, 403);
    const body = await request.json().catch(() => ({})) as { provider?: unknown; contactId?: unknown; name?: unknown; avatar?: unknown };
    const provider = typeof body.provider === "string" ? body.provider.trim() : "";
    const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
    if (!provider || !contactId || contactId.length > 160) return json({ error: "invalid_target" }, 400);
    if (request.method === "POST") {
      // 目标必须是群成员（按快照匹配，不要求已登录）。
      const member = await pool.query(
        `SELECT name, avatar FROM agent_session_members WHERE session_id=$1 AND provider=$2 AND contact_id=$3 LIMIT 1`,
        [sessionId, provider, contactId]);
      if (!member.rowCount) return json({ error: "not_a_member" }, 404);
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : String(member.rows[0].name ?? "");
      const avatar = typeof body.avatar === "string" ? body.avatar : String(member.rows[0].avatar ?? "");
      await promoteCoworkAdmin(sessionId, { provider, contactId, name, avatar }, ctx.user!.sub);
      publishCowork(sessionId, { kind: "admins" });
      return json({ ok: true });
    }
    if (request.method === "DELETE") {
      await demoteCoworkAdmin(sessionId, provider, contactId);
      publishCowork(sessionId, { kind: "admins" });
      return json({ ok: true });
    }
    return json({ error: "method_not_allowed" }, 405);
  }

  async function revoke(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => ({})) as { messageId?: unknown };
    const messageId = Number(body.messageId);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return json({ error: "invalid_message_id" }, 400);
    const ok = await revokeAgentMessage(ctx.user!.sub, sessionId, messageId);
    if (!ok) return json({ error: "not_found" }, 404);
    const revokedAt = new Date().toISOString();
    publishCowork(sessionId, { kind: "revoked", messageId, revokedAt });
    return json({ ok: true, revokedAt });
  }

  async function monologues(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    await recoverStaleRun(sessionId);
    const result = await ctx.pool!.query(`SELECT id,agent_id AS "agentId",fast_status AS status,fast_content AS content,fast_steps AS steps,fast_elapsed_secs AS "elapsedSecs",fast_initial_content AS "initialContent",fast_initial_elapsed_secs AS "initialElapsedSecs",fast_steers AS "fastSteers",created_at AS "startedAt",updated_at AS "finishedAt"
      FROM cowork_runs WHERE session_id=$1 AND fast_status<>'pending' ORDER BY created_at,id`, [sessionId]);
    return json({ monologues: expandMonologues(result.rows) });
  }

  async function send(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => ({})) as { content?: unknown; title?: unknown; attachments?: unknown; clientMessageId?: unknown; replyToId?: unknown; voice?: unknown; context?: unknown };
    // 前端 <AgentApp title> 经 body.title 上报应用名（HTTP send 无 query），缓存供默认 AI 命名。
    setAppDisplayName(body.title);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    // 宿主注册能力的逐轮上下文（报销格式/当前草稿等）；限长，由前端生成，服务端仅透传到慢思考 system。
    const hostContext = typeof body.context === "string" ? body.context.trim().slice(0, 8000) : "";
    // 用户语音消息：{ fileId, durationMs, mimeType }；形状先提取，归属校验在拿到 user 后进行。
    const rawVoice = body.voice && typeof body.voice === "object" ? body.voice as Record<string, unknown> : null;
    if (content.length > 12000) return json({ error: "invalid_content" }, 400);
    const clientMessageId = body.clientMessageId == null ? null : body.clientMessageId;
    if (clientMessageId !== null && (typeof clientMessageId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(clientMessageId))) return json({ error: "invalid_client_message_id" }, 400);
    const { user, pool } = ctx;
    // 双人内置好友会话：删除好友后，双方都不能再向该会话发消息（对方发的消息自然收不到）。
    if ((await builtinFriendPairStatus(sessionId, user!.sub)) === false) return json({ error: "你们已不是好友，无法发送消息" }, 403);
    const targetAgents = await agentsForMessage(pool!, sessionId, content);
    const acknowledgedAgents = targetAgents.filter(agent => directlyAddressed(content, agent.name));
    const acknowledged = acknowledgedAgents.length > 0;
    // 语音消息归属校验：fileId 必须存在且属于当前登录用户，否则丢弃该 voice（不阻断文本）。
    let voice: { fileId: string; durationMs: number; mimeType: string } | null = null;
    if (rawVoice) {
      const fileId = typeof rawVoice.fileId === "string" ? rawVoice.fileId : "";
      const durationMs = Number(rawVoice.durationMs);
      const mimeType = typeof rawVoice.mimeType === "string" ? rawVoice.mimeType : "";
      if (fileId && Number.isFinite(durationMs) && mimeType) {
        const stored = await getFileById(fileId);
        if (stored && stored.ownerSub === user!.sub) {
          voice = { fileId, durationMs: Math.round(Math.max(1000, Math.min(600_000, durationMs))), mimeType };
        }
      }
    }
    const replyToId = body.replyToId == null ? null : Number(body.replyToId);
    if (replyToId != null && (!Number.isSafeInteger(replyToId) || replyToId <= 0 || !(await pool!.query("SELECT 1 FROM agent_messages WHERE id=$1 AND session_id=$2", [replyToId, sessionId])).rowCount)) return json({ error: "invalid_reply_to" }, 400);
    const attachment = Array.isArray(body.attachments) ? groupAttachments(body.attachments, sessionId) : null;
    if (!content && !attachment?.length && !voice) return json({ error: "invalid_content" }, 400);
    if (Array.isArray(body.attachments) && attachment!.length !== body.attachments.length) return json({ error: "invalid_attachment" }, 400);
    if (attachment) for (const item of attachment) {
      const name = new URL(item.url, "http://local").searchParams.get("name")!;
      if (!(await resolveUploadPath(sessionId, name))) {
        const stored = item.fileId ? await getFileById(item.fileId) : null;
        if (!stored || stored.ownerSub !== user!.sub || stored.sessionId !== sessionId || stored.name !== name || stored.kind !== "input") {
          return json({ error: "attachment_not_found" }, 400);
        }
      }
    }
    const client = await pool!.connect();
    let messageId: number;
    let created = false;
    let stoppedChatmateIds: string[] = [];
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM agent_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
      const inserted = await client.query(
        "INSERT INTO agent_messages(session_id,role,content,sender_sub,attachment,voice,client_message_id,reply_to_id) VALUES($1,'user',$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id",
        [sessionId, content, user!.sub, attachment ? JSON.stringify(attachment) : null, voice ? JSON.stringify(voice) : null, clientMessageId, replyToId],
      );
      created = !!inserted.rowCount;
      if (created) messageId = Number(inserted.rows[0].id);
      else {
        const existing = await client.query("SELECT id FROM agent_messages WHERE session_id=$1 AND sender_sub=$2 AND client_message_id=$3", [sessionId, user!.sub, clientMessageId]);
        if (!existing.rowCount) throw new Error("message_insert_conflict");
        messageId = Number(existing.rows[0].id);
      }
      for (const agent of created ? acknowledgedAgents : []) {
        await client.query("INSERT INTO cowork_message_reactions(message_id,user_sub,emoji) VALUES($1,$2,'👌') ON CONFLICT DO NOTHING", [messageId, `agent:${agent.id}`]);
      }
      if (created) {
        const stopped = await client.query("UPDATE cowork_chatmate SET status='stopped',tasks='[]'::jsonb,updated_at=now() WHERE session_id=$1 AND user_sub=$2 AND status='running' RETURNING id", [sessionId, user!.sub]);
        stoppedChatmateIds = stopped.rows.map(row => String(row.id));
        await client.query("UPDATE agent_sessions SET updated_at=now() WHERE id=$1", [sessionId]);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    if (created) await finishManualChatmateStop(sessionId, user!.sub, messageId, stoppedChatmateIds);
    const newMessage = await getCoworkMessageRow(pool!, messageId).catch(() => null);
    if (created && newMessage) {
      publishCowork(sessionId, { kind: "message", message: newMessage });
      void scheduleChatmate(request, sessionId, newMessage).catch(error => console.error("[cowork] chatmate scheduling failed", error));
    }
    if (created && acknowledged) {
      const reactions = await pool!.query("SELECT r.message_id, r.user_sub, CASE WHEN r.user_sub='agent' THEN NULL ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS user_name, r.emoji FROM cowork_message_reactions r JOIN agent_messages m ON m.id=r.message_id JOIN agent_sessions s ON s.id=m.session_id LEFT JOIN users u ON u.provider || ':' || u.union_id=r.user_sub WHERE m.session_id=$1 ORDER BY r.created_at,r.emoji", [sessionId]);
      publishCowork(sessionId, { kind: "reactions", reactions: reactions.rows as Array<{ message_id: number; user_sub: string; user_name: string | null; emoji: string }> });
    }
    // 快思考只被人发的新消息引导（AI 自己的消息不触发引导，避免"被群AI引导"的噪音记录）
    if (created && newMessage && newMessage.role !== "assistant" && (!activeFastRuns.has(sessionId) || targetAgents.some(agent => agent.id === activeFastRuns.get(sessionId)?.agentId))) steerActiveFast(sessionId, newMessage);
    // A short quiet period combines adjacent human messages; the maximum delay is bounded
    // because each run is anchored to a committed message id.
    if (created && targetAgents.length) void scheduleMessageRuns(request, sessionId, messageId, targetAgents, content, hostContext).catch(error => console.error("[cowork] run scheduling failed", error));
    return json({ ok: true, id: messageId, acknowledged });
  }

  async function forward(request: Request, sessionId: string): Promise<Response> {
    const source = await access(request, sessionId);
    if (source.error) return source.error;
    const body = await request.json().catch(() => ({})) as { messageId?: unknown; messageIds?: unknown; mode?: unknown; targetSessionId?: unknown; note?: unknown };
    const ids = Array.isArray(body.messageIds) ? body.messageIds.map(Number) : [Number(body.messageId)];
    const mode = body.mode === "merged" ? "merged" : "individual";
    const targetSessionId = typeof body.targetSessionId === "string" ? body.targetSessionId : "";
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (!ids.length || ids.length > 100 || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length || !targetSessionId || note.length > 4000) return json({ error: "invalid_forward" }, 400);
    const target = await access(request, targetSessionId);
    if (target.error) return target.error;
    // 与 send 一致：已删除好友的双人会话禁止转发消息
    if ((await builtinFriendPairStatus(targetSessionId, source.user!.sub)) === false) return json({ error: "你们已不是好友，无法转发消息" }, 403);
    const pool = source.pool!;
    const original = await pool.query(`SELECT m.id,m.content,m.attachment,m.forwarded_bundle,m.revoked_at,m.created_at,
      CASE WHEN m.role='assistant' THEN 'Agent' ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS sender_name FROM agent_messages m
      LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
      WHERE m.id=ANY($1::bigint[]) AND m.session_id=$2 AND m.role IN ('user','assistant') ORDER BY m.id`, [ids, sessionId]);
    if (original.rows.length !== ids.length) return json({ error: "message_not_found" }, 404);
    if (original.rows.some(row => row.revoked_at)) return json({ error: "message_revoked" }, 409);
    for (const row of original.rows) {
      const attachments = groupAttachments(row.attachment, sessionId);
      if (row.attachment && attachments.length !== (Array.isArray(row.attachment) ? row.attachment.length : 1)) return json({ error: "invalid_attachment" }, 409);
    }
    const copiedFiles: string[] = [];
    const client = await pool.connect();
    const forwardedIds: number[] = [];
    let stoppedChatmateIds: string[] = [];
    try {
      await client.query("BEGIN");
      const bundle: Array<{ senderName: string; content: string; createdAt: string; attachments: GroupAttachment[] }> = [];
      for (const row of original.rows) {
        const copied: GroupAttachment[] = [];
        const sourceAttachments = groupAttachments(row.attachment, sessionId);
        for (const attachment of sourceAttachments) {
          const originalName = new URL(attachment.url, "http://local").searchParams.get("name")!;
          const newName = `${randomUUID()}${path.extname(originalName)}`;
          const directory = uploadStorageDir(targetSessionId);
          await fs.mkdir(directory, { recursive: true });
          const destination = path.join(directory, newName);
          const sourceFile = await resolveUploadPath(sessionId, originalName);
          if (sourceFile) await fs.copyFile(sourceFile, destination);
          else {
            const bytes = attachment.fileId ? await readFileBytes(attachment.fileId) : null;
            if (!bytes) throw new Error("转发附件源文件不存在");
            await fs.writeFile(destination, bytes);
          }
          copiedFiles.push(destination);
          copied.push({ url: `/api/upload?session=${encodeURIComponent(targetSessionId)}&name=${encodeURIComponent(newName)}`, name: attachment.name, size: attachment.size });
        }
        const nested = Array.isArray(row.forwarded_bundle) ? row.forwarded_bundle as Array<{ senderName: string; content: string; createdAt: string; attachments: GroupAttachment[] }> : null;
        const copiedByUrl = new Map(sourceAttachments.map((attachment, index) => [attachment.url, copied[index]]));
        const copiedNested = nested?.map(item => ({ ...item, attachments: (item.attachments ?? []).map(attachment => copiedByUrl.get(attachment.url)).filter((attachment): attachment is GroupAttachment => !!attachment) }));
        if (mode === "merged") {
          if (copiedNested?.length) bundle.push(...copiedNested);
          else bundle.push({ senderName: String(row.sender_name), content: String(row.content ?? ""), createdAt: new Date(row.created_at as Date).toISOString(), attachments: copied });
        }
        else {
          const content = `${note && forwardedIds.length === 0 ? `${note}\n\n` : ""}${String(row.content ?? "")}`;
          const result = await client.query(`INSERT INTO agent_messages(session_id,role,content,sender_sub,attachment,forwarded_bundle)
            VALUES($1,'user',$2,$3,$4,$5) RETURNING id`, [targetSessionId, content, source.user!.sub, copied.length ? JSON.stringify(copied) : null, copiedNested?.length ? JSON.stringify(copiedNested) : null]);
          forwardedIds.push(Number(result.rows[0].id));
        }
      }
      if (mode === "merged") {
        const content = note || `[聊天记录] ${bundle.length} 条消息`;
        const bundleAttachments = bundle.flatMap(item => item.attachments);
        const result = await client.query(`INSERT INTO agent_messages(session_id,role,content,sender_sub,attachment,forwarded_bundle)
          VALUES($1,'user',$2,$3,$4,$5) RETURNING id`, [targetSessionId, content, source.user!.sub, bundleAttachments.length ? JSON.stringify(bundleAttachments) : null, JSON.stringify(bundle)]);
        forwardedIds.push(Number(result.rows[0].id));
      }
      const stopped = await client.query("UPDATE cowork_chatmate SET status='stopped',tasks='[]'::jsonb,updated_at=now() WHERE session_id=$1 AND user_sub=$2 AND status='running' RETURNING id", [targetSessionId, source.user!.sub]);
      stoppedChatmateIds = stopped.rows.map(row => String(row.id));
      await client.query("UPDATE agent_sessions SET updated_at=now() WHERE id=$1", [targetSessionId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      await Promise.all(copiedFiles.map(file => fs.unlink(file).catch(() => {})));
      throw error;
    } finally { client.release(); }
    await finishManualChatmateStop(targetSessionId, source.user!.sub, Math.max(...forwardedIds), stoppedChatmateIds);
    for (const id of forwardedIds) {
      const forwarded = await getCoworkMessageRow(pool, id);
      if (forwarded) {
        publishCowork(targetSessionId, { kind: "message", message: forwarded });
        void scheduleChatmate(request, targetSessionId, forwarded).catch(error => console.error("[cowork] chatmate scheduling failed", error));
      }
    }
    return json({ ok: true, ids: forwardedIds });
  }

  async function reaction(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const body = await request.json().catch(() => ({})) as { messageId?: unknown; emoji?: unknown; title?: unknown };
    const id = Number(body.messageId);
    if (!Number.isSafeInteger(id) || id <= 0 || !isGroupEmoji(body.emoji)) return json({ error: "invalid_reaction" }, 400);
    const { user, pool } = ctx;
    const exists = await pool!.query("SELECT id FROM agent_messages WHERE id=$1 AND session_id=$2", [id, sessionId]);
    if (!exists.rowCount) return json({ error: "not_found" }, 404);
    const removed = await pool!.query("DELETE FROM cowork_message_reactions WHERE message_id=$1 AND user_sub=$2 AND emoji=$3 RETURNING message_id", [id, user!.sub, body.emoji]);
    if (!removed.rowCount) await pool!.query("INSERT INTO cowork_message_reactions(message_id,user_sub,emoji) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [id, user!.sub, body.emoji]);
    const reactions = await pool!.query("SELECT r.message_id, r.user_sub, CASE WHEN r.user_sub='agent' THEN NULL ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS user_name, r.emoji FROM cowork_message_reactions r JOIN agent_messages m ON m.id=r.message_id JOIN agent_sessions s ON s.id=m.session_id LEFT JOIN users u ON u.provider || ':' || u.union_id=r.user_sub WHERE m.session_id=$1 ORDER BY r.created_at,r.emoji", [sessionId]);
    publishCowork(sessionId, { kind: "reactions", reactions: reactions.rows as Array<{ message_id: number; user_sub: string; user_name: string | null; emoji: string }> });
    if (!removed.rowCount) {
      const event = await pool!.query("INSERT INTO agent_messages(session_id,role,content,sender_sub,reply_to_id) VALUES($1,'reaction',$2,$3,$4) RETURNING id", [sessionId, `对消息 #${id} 添加了 ${body.emoji} 表情`, user!.sub, id]);
      if (event.rows[0]) void scheduleMessageRunsForTrigger(request, sessionId, Number(event.rows[0].id)).catch(error => console.error("[cowork] reaction scheduling failed", error));
    }
    return json({ ok: true, active: !removed.rowCount });
  }

  async function settings(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    // 群主、任命管理员、1v1 双方均可改群信息/框架/模型/发言策略/提示词。
    if (!ctx.isAdmin) return json({ error: "owner_only" }, 403);
    const body = await request.json().catch(() => ({})) as { title?: unknown; avatar?: unknown; mode?: unknown; model?: unknown; codexModel?: unknown; replyPolicy?: unknown; fastPrompt?: unknown };
    const hasTitle = Object.prototype.hasOwnProperty.call(body, "title");
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (hasTitle && (!title || title.length > 80)) return json({ error: "invalid_title" }, 400);
    const hasAvatar = Object.prototype.hasOwnProperty.call(body, "avatar");
    const avatar = typeof body.avatar === "string" ? body.avatar : "";
    if (hasAvatar) {
      if (typeof body.avatar !== "string" || avatar.length > 2048) return json({ error: "invalid_avatar" }, 400);
      if (avatar) {
        const url = new URL(avatar, "http://local");
        if (!avatar.startsWith("/api/upload?") || url.origin !== "http://local" || url.pathname !== "/api/upload" || url.searchParams.get("session") !== sessionId || !url.searchParams.get("name")) return json({ error: "invalid_avatar" }, 400);
      }
    }
    if (hasAvatar && Object.keys(body).length === 1) {
      const updated = await ctx.pool!.query(`UPDATE agent_sessions SET cowork_avatar=$2,
        updated_at = CASE WHEN cowork_avatar IS DISTINCT FROM $2 THEN now() ELSE updated_at END
        WHERE id=$1
        RETURNING title,cowork_avatar,cowork_mode,cowork_model,cowork_codex_model,cowork_reply_policy,cowork_fast_prompt`, [sessionId, avatar]);
      const row = updated.rows[0];
      if (!row) return json({ error: "not_found" }, 404);
      const savedPolicy: ReplyPolicy = isReplyPolicy(row.cowork_reply_policy) ? row.cowork_reply_policy : "mentions_only";
      const owner = await ctx.pool!.query("SELECT COALESCE(NULLIF(name,''),user_code) AS name,avatar FROM users WHERE provider || ':' || union_id=$1 LIMIT 1", [ctx.session!.userId]);
      publishCowork(sessionId, { kind: "settings", settings: {
        title: String(row.title), cowork_avatar: String(row.cowork_avatar ?? ""), cowork_mode: String(row.cowork_mode),
        cowork_model: row.cowork_model == null ? null : String(row.cowork_model), cowork_codex_model: row.cowork_codex_model == null ? null : String(row.cowork_codex_model),
        cowork_reply_policy: savedPolicy, cowork_fast_prompt: String(row.cowork_fast_prompt || defaultPromptForPolicy(savedPolicy)),
      }, ownerSub: ctx.session!.userId, ownerName: String(owner.rows[0]?.name ?? "发起人"), ownerAvatar: String(owner.rows[0]?.avatar ?? "") });
      return json({ ok: true, avatar: String(row.cowork_avatar ?? "") });
    }
    const hasMode = Object.prototype.hasOwnProperty.call(body, "mode");
    const hasModel = Object.prototype.hasOwnProperty.call(body, "model");
    const hasCodexModel = Object.prototype.hasOwnProperty.call(body, "codexModel");
    const hasReplyPolicy = Object.prototype.hasOwnProperty.call(body, "replyPolicy");
    const hasFastPrompt = Object.prototype.hasOwnProperty.call(body, "fastPrompt");
    // PATCH 语义：只校验并落库请求中实际携带的字段（改名称/头像/模型/发言方式可独立保存）
    if (hasMode) {
      if (body.mode !== "codebuddy" && body.mode !== "codex") return json({ error: "invalid_mode" }, 400);
      if (!getConfiguredAgentModes().includes(body.mode)) return json({ error: "mode_unavailable" }, 400);
    }
    const model = typeof body.model === "string" ? body.model.slice(0, 160) : null;
    const codexModel = typeof body.codexModel === "string" ? body.codexModel.slice(0, 160) : null;
    const replyPolicy = hasReplyPolicy && isReplyPolicy(body.replyPolicy) ? body.replyPolicy : "mentions_only";
    if (body.fastPrompt != null && (typeof body.fastPrompt !== "string" || body.fastPrompt.length > 8000)) return json({ error: "invalid_fast_prompt" }, 400);
    const fastPrompt = typeof body.fastPrompt === "string" && body.fastPrompt.trim() ? body.fastPrompt.trim() : null;
    const updated = await ctx.pool!.query(`UPDATE agent_sessions SET
      cowork_mode = CASE WHEN $9 THEN $2 ELSE cowork_mode END,
      cowork_model = CASE WHEN $10 THEN $3 ELSE cowork_model END,
      cowork_codex_model = CASE WHEN $11 THEN $4 ELSE cowork_codex_model END,
      cowork_reply_policy = CASE WHEN $12 THEN $5 ELSE cowork_reply_policy END,
      cowork_fast_prompt = CASE WHEN $13 THEN $6 ELSE cowork_fast_prompt END,
      title=COALESCE($7,title),cowork_avatar=COALESCE($8,cowork_avatar),
      user_renamed=CASE WHEN $7::text IS NOT NULL AND $7::text <> title THEN true ELSE user_renamed END,
      updated_at = CASE WHEN
        ($9 AND cowork_mode IS DISTINCT FROM $2)
        OR ($10 AND cowork_model IS DISTINCT FROM $3)
        OR ($11 AND cowork_codex_model IS DISTINCT FROM $4)
        OR ($12 AND cowork_reply_policy IS DISTINCT FROM $5)
        OR ($13 AND cowork_fast_prompt IS DISTINCT FROM $6)
        OR ($7::text IS NOT NULL AND $7::text <> title)
        OR ($8::text IS NOT NULL AND $8::text <> cowork_avatar)
        THEN now() ELSE updated_at END
      WHERE id=$1 RETURNING title,cowork_avatar,cowork_mode,cowork_model,cowork_codex_model,cowork_reply_policy,cowork_fast_prompt`,
      [sessionId, hasMode ? body.mode : null, model, codexModel, replyPolicy, fastPrompt, hasTitle ? title : null, hasAvatar ? avatar : null, hasMode, hasModel, hasCodexModel, hasReplyPolicy, hasFastPrompt]);
    const row = updated.rows[0];
    if (!row) return json({ error: "not_found" }, 404);
    const savedTitle = String(row.title);
    const savedAvatar = String(row.cowork_avatar ?? "");
    const savedMode = String(row.cowork_mode);
    const savedModel = row.cowork_model == null ? null : String(row.cowork_model);
    const savedCodexModel = row.cowork_codex_model == null ? null : String(row.cowork_codex_model);
    const savedPolicy: ReplyPolicy = isReplyPolicy(row.cowork_reply_policy) ? row.cowork_reply_policy : "mentions_only";
    const savedFastPrompt = String(row.cowork_fast_prompt || defaultPromptForPolicy(savedPolicy));
    if (hasFastPrompt || hasReplyPolicy) {
      await ctx.pool!.query("UPDATE cowork_agents SET reply_policy=CASE WHEN $2 THEN $3 ELSE reply_policy END,speaking_prompt=CASE WHEN $4 THEN $5 ELSE speaking_prompt END,updated_at=now() WHERE id=$1", [`${sessionId}:default`, hasReplyPolicy, savedPolicy, hasFastPrompt, String(row.cowork_fast_prompt ?? "")]);
      publishCowork(sessionId, { kind: "agents" });
    }
    const owner = await ctx.pool!.query("SELECT COALESCE(NULLIF(name,''),user_code) AS name,avatar FROM users WHERE provider || ':' || union_id=$1 LIMIT 1", [ctx.session!.userId]);
    publishCowork(sessionId, {
      kind: "settings",
      settings: { title: savedTitle, cowork_avatar: savedAvatar, cowork_mode: savedMode, cowork_model: savedModel, cowork_codex_model: savedCodexModel, cowork_reply_policy: savedPolicy, cowork_fast_prompt: savedFastPrompt },
      ownerSub: ctx.session!.userId, ownerName: String(owner.rows[0]?.name ?? "发起人"), ownerAvatar: String(owner.rows[0]?.avatar ?? ""),
    });
    return json({ ok: true, title: savedTitle, avatar: savedAvatar });
  }

  async function scheduleMessageRuns(request: Request, sessionId: string, triggerId: number, agents: CoworkAgent[], content: string, hostContext = "") {
    await Promise.all(agents.map(agent => scheduleRun(request, sessionId, triggerId, agent, directlyAddressed(content, agent.name), hostContext)));
  }

  async function scheduleMessageRunsForTrigger(request: Request, sessionId: string, triggerId: number) {
    const pool = getPool();
    if (!pool) return;
    const trigger = await pool.query("SELECT content FROM agent_messages WHERE session_id=$1 AND id=$2", [sessionId, triggerId]);
    if (!trigger.rowCount) return;
    const agents = await agentsForMessage(pool, sessionId, String(trigger.rows[0].content ?? ""));
    await scheduleMessageRuns(request, sessionId, triggerId, agents, String(trigger.rows[0].content ?? ""));
  }

  async function scheduleRun(request: Request, sessionId: string, triggerId: number, selectedAgent: CoworkAgent, direct: boolean, hostContext = "") {
    await sleep(direct ? 100 : 1300);
    const pool = getPool();
    if (!pool) return;
    // Active runs are serialized per group for now, but each mentioned AI gets its own
    // run ID and model session. Wait for the slot instead of dropping the other mentions.
    while (true) {
      await recoverStaleRun(sessionId);
      const runId = randomUUID();
      const result = await pool.query(
        `INSERT INTO cowork_runs(id,session_id,trigger_message_id,status,agent_id)
         SELECT $1,$2,$3,'pending',$4 WHERE $3 > COALESCE((SELECT max(trigger_message_id) FROM cowork_runs
           WHERE session_id=$2 AND agent_id=$4 AND status<>'abandoned'),0)
         ON CONFLICT DO NOTHING RETURNING id`,
        [runId, sessionId, triggerId, selectedAgent.id],
      );
      if (result.rowCount) { await executeRun(request, runId, sessionId, triggerId, selectedAgent, hostContext); return; }
      const previous = await pool.query("SELECT max(trigger_message_id) AS id FROM cowork_runs WHERE session_id=$1 AND agent_id=$2 AND status<>'abandoned'", [sessionId, selectedAgent.id]);
      if (Number(previous.rows[0]?.id ?? 0) >= triggerId) return;
      await sleep(500);
    }
  }

  async function executeRun(request: Request, runId: string, sessionId: string, triggerId: number, selectedAgent: CoworkAgent, hostContext = "") {
    const title = selectedAgent.name;
    const pool = getPool()!;
    const activeFast = { runId, agentId: selectedAgent.id, phase: "initial" as "initial" | "review" };
    activeFastRuns.set(sessionId, activeFast);
    let coveredThroughId = triggerId;
    let reviewSucceeded = false;
    let replyTargetId = triggerId;
    const startedAt = Date.now();
    const steps: RunStep[] = [];
    const elapsedSecs = () => Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const update = async (status: string, content: string, error: string | null = null, broadcast = true) => {
      const elapsed = elapsedSecs();
      const result = await pool.query("UPDATE cowork_runs SET status=$2,content=$3,error=$4,steps=$5,elapsed_secs=$6,visible=visible OR $7,updated_at=now() WHERE id=$1 AND status IN ('pending','running')", [runId, status, content, error, JSON.stringify(steps), elapsed, broadcast && status === "running"]);
      const changed = Boolean(result.rowCount);
      if (changed && broadcast) publishCowork(sessionId, { kind: "run", run: { id: runId, agentId: selectedAgent.id, status, content, steps: structuredClone(steps), elapsedSecs: elapsed, startedAt: new Date(startedAt).toISOString(), error } });
      return changed;
    };
    const appendAnswer = async (content: string, showProcess = true, artifacts: ArtifactChange[] = []): Promise<number | null> => {
      let insertedId: number | null = null;
      await retryDeadlock(async () => {
        const client = await pool.connect();
        insertedId = null;
        try {
          await client.query("BEGIN");
          await client.query("SELECT id FROM agent_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
          const active = await client.query("SELECT status FROM cowork_runs WHERE id=$1 FOR UPDATE", [runId]);
          if (active.rows[0]?.status !== "running") { await client.query("ROLLBACK"); return; }
          const inserted = await client.query("INSERT INTO agent_messages(session_id,role,content,run_id,reply_to_id,steps,elapsed_secs,thinking_secs,artifacts,cowork_agent_id,cowork_agent_name) VALUES($1,'assistant',$2,$3,$4,$5,$6,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id", [sessionId, content, runId, replyTargetId, showProcess ? JSON.stringify(steps) : null, showProcess ? elapsedSecs() : null, artifacts.length ? JSON.stringify(capArtifactsForMessage(artifacts)) : null, selectedAgent.id, selectedAgent.name]);
          insertedId = inserted.rows[0] ? Number(inserted.rows[0].id) : null;
          await client.query("UPDATE agent_sessions SET updated_at=now() WHERE id=$1", [sessionId]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      });
      if (insertedId != null) {
        const row = await getCoworkMessageRow(pool, insertedId).catch(() => null);
        if (row) {
          publishCowork(sessionId, { kind: "message", message: row });
          void scheduleChatmate(request, sessionId, row).catch(error => console.error("[cowork] chatmate scheduling failed", error));
        }
      }
      return insertedId;
    };
    let answer = "";
    let fastContent = "";
    const fastSteps: RunStep[] = [];
    let fastStartedAt = Date.now();
    let fastPhase: "initial" | "review" = "initial";
    const fastElapsedSecs = () => Math.max(1, Math.round((Date.now() - fastStartedAt) / 1000));
    const updateFast = async (status: string) => {
      const elapsed = fastElapsedSecs();
      await pool.query("UPDATE cowork_runs SET fast_content=$2,fast_status=$3,fast_steps=$4,fast_elapsed_secs=$5 WHERE id=$1", [runId, fastContent, status, JSON.stringify(fastSteps), elapsed]);
      publishCowork(sessionId, { kind: "fast", runId, agentId: selectedAgent.id, content: fastContent, status, steps: structuredClone(fastSteps), elapsedSecs: elapsed, phase: fastPhase });
    };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    // 本轮产物基线 + 收集：慢思考可能写文件，完成后把本轮变更（added/modified）随助手消息一起落库，
    // 群聊前端据此渲染「查看产出物 / 查看变更」。声明在 try 之外以便 catch 分支也能收集。
    let workspaceDir: string | undefined;
    let artifactBaseline: Map<string, ArtifactStamp> | undefined;
    // 本轮模型会话 id（带 run 后缀）：收集时以「当前 run 目录」优先扫描，
    // 避免其他 run 目录里的同名旧副本（diskKeys 按相对路径去重）遮蔽本轮新写入的文件
    // —— 这正是「模型说存了文件但没有产物卡片」的根因之一。
    const runToken = runId.replaceAll("-", "");
    const fastSessionId = `${sessionId}_cowork_fast_${runToken}`;
    const slowSessionId = `${sessionId}_cowork_slow_${runToken}`;
    const collectRunArtifacts = async (collectSession: string): Promise<ArtifactChange[]> => {
      try {
        return await collectArtifacts(collectSession, artifactBaseline ?? new Map(), workspaceDir);
      } catch (error) {
        console.error("[cowork] collect run artifacts failed", error instanceof Error ? error.message : error);
        return [];
      }
    };
    try {
      // 自发言先等待模型确认要说话；沉默轮次不向群成员显示思考状态。
      if (!await retryDeadlock(() => update("running", "", null, false))) return;
      heartbeat = setInterval(() => { void pool.query("UPDATE cowork_runs SET updated_at=now() WHERE id=$1 AND status='running'", [runId]).catch(() => {}); }, 15_000);
      const [rows, settings, participants, pendingRequests] = await retryDeadlock(() => Promise.all([
        pool.query(`SELECT m.id,m.role,m.content,m.attachment,m.sender_sub,m.cowork_agent_id,CASE WHEN m.role='assistant' THEN COALESCE(m.cowork_agent_name,'${AI_DISPLAY_NAME}') ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS sender_name FROM agent_messages m
          LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
          WHERE m.session_id=$1 AND m.id <= $2 AND m.revoked_at IS NULL AND m.role IN ('user','assistant') ORDER BY m.id DESC LIMIT 60`, [sessionId, triggerId]),
        pool.query(`SELECT cowork_mode,cowork_model,cowork_codex_model,cowork_reply_policy,cowork_fast_prompt,user_id,workspace_dir,
          (SELECT count(*) FROM agent_messages WHERE session_id=$1 AND role='user'
            AND id>agent_sessions.cowork_start_id AND id<$2) AS prior_group_user_count
          FROM agent_sessions WHERE id=$1`, [sessionId, triggerId]),
        pool.query(`SELECT u.provider || ':' || u.union_id AS sub,
            COALESCE(NULLIF(u.name,''),u.user_code,NULLIF(sm.name,''),'成员') AS name,u.email,u.mobile,u.dept_name
          FROM agent_session_members sm
          LEFT JOIN LATERAL (
            SELECT provider,union_id,name,email,mobile,dept_name FROM users u
            WHERE u.provider=sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
            LIMIT 1
          ) u ON true
          WHERE sm.session_id=$1 ORDER BY sm.added_at,sm.contact_id`, [sessionId]),
        pool.query(`SELECT id,content FROM agent_messages WHERE session_id=$1 AND role='user' AND revoked_at IS NULL AND id<=$3
          AND id>GREATEST(COALESCE((SELECT max(trigger_message_id) FROM cowork_runs
            WHERE session_id=$1 AND id<>$2 AND trigger_message_id<$3 AND status<>'abandoned'),0),
            (SELECT cowork_start_id FROM agent_sessions WHERE id=$1)) ORDER BY id`, [sessionId, runId, triggerId]),
      ]));
      const setting = settings.rows[0];
      if (!setting) throw new Error("会话已删除");
      const ownerProfile = await retryDeadlock(() => pool.query("SELECT name,email,mobile,dept_name FROM users WHERE provider || ':' || union_id=$1", [setting.user_id]));
      const members = [{ sub: String(setting.user_id), name: ownerProfile.rows[0]?.name || "发起人", ...ownerProfile.rows[0] },
        ...participants.rows.filter(row => row.sub !== setting.user_id)];
      const replyPolicy: ReplyPolicy = isReplyPolicy(selectedAgent.replyPolicy) ? selectedAgent.replyPolicy : "mentions_only";
      const customPrompt = selectedAgent.prompt.trim();
      const speakingInstruction = replyPolicy === "custom" ? customPrompt || selectedAgent.speakingPrompt.trim() : defaultPromptForPolicy(replyPolicy);
      setting.cowork_fast_prompt = speakingInstruction;
      workspaceDir = setting.workspace_dir == null ? undefined : String(setting.workspace_dir);
      artifactBaseline = await baselineArtifacts(sessionId, workspaceDir).catch(() => new Map());
      slog(sessionId, "cowork.fast.start", { runId, triggerId, replyPolicy, mode: setting.cowork_mode }, "info");
      const directlyRequested = pendingRequests.rows.filter(row => replyPolicy === "mentions_only"
        ? explicitlyMentioned(String(row.content), title) : directlyAddressed(String(row.content), title));
      const triggerMessage = rows.rows.find(row => Number(row.id) === triggerId);
      const managementRequest = selectedAgent.id === `${sessionId}:default` && triggerMessage?.role === "user"
        && isAgentManagementRequest(String(triggerMessage.content ?? ""));
      if (triggerMessage?.role === "user" && !directlyRequested.some(row => Number(row.id) === triggerId) &&
        (replyPolicy === "mentions_only" ? explicitlyMentioned(String(triggerMessage.content), title) : directlyAddressed(String(triggerMessage.content), title))) {
        directlyRequested.push(triggerMessage);
      }
      let mustReply = directlyRequested.length > 0;
      const socialGreeting = triggerMessage?.role === "user"
        ? greetingReply(String(triggerMessage.content), Number(setting.prior_group_user_count) === 0) : null;
      const humanFollowup = (replyPolicy === "balanced" || replyPolicy === "cautious") && !mustReply && triggerMessage?.role === "user"
        && isHumanDirectedFollowup(String(triggerMessage.content), title);
      let visible = false;
      if (mustReply) replyTargetId = Number(directlyRequested[0].id);
      if (managementRequest) replyTargetId = triggerId;
      if (replyPolicy === "mentions_only" && !mustReply) { await update("silent", "", null, false); return; }
      const history: Array<{ role: string; content: string; images?: ImageSpec[]; fromAssistant?: boolean }> = [];
      const attachmentsForRun: GroupAttachment[] = [];
      const groupImages: ImageSpec[] = [];
      for (const row of rows.rows.reverse()) {
        const attached = row.role === "user" && (!customPrompt || Number(row.id) === triggerId) ? groupAttachments(row.attachment, sessionId) : [];
        attachmentsForRun.push(...attached);
        const context = await groupAttachmentContext(sessionId, attached);
        groupImages.push(...context.images);
        history.push({ role: row.role === "assistant" && (row.cowork_agent_id === selectedAgent.id || row.cowork_agent_id == null && selectedAgent.id === `${sessionId}:default`) ? "assistant" : "user",
          content: row.role === "assistant" ? `[消息 #${row.id}][${row.sender_name}] ${String(row.content)}` : `[消息 #${row.id}][${row.sender_name}] ${row.content}${context.text ? `\n\n${context.text}` : ""}`,
          fromAssistant: row.role === "assistant" });
      }
      const lastUser = [...history].reverse().find(message => message.role === "user");
      if (lastUser && groupImages.length) lastUser.images = groupImages;
      const modelHistory = (messages: typeof history): typeof history => {
        if (!customPrompt) return messages;
        const transcript = messages.filter(message => !message.fromAssistant).map(message => message.content).join("\n").slice(-4000);
        const images = messages.flatMap(message => message.images ?? []);
        return [{ role: "user", content: `以下是群成员的消息背景。请处理末尾发给你的请求，回复内容与格式以你的独立提示词为准。\n${transcript}`, ...(images.length ? { images } : {}) }];
      };
      const publicMembers = members.map(member => {
        const details = [member.dept_name && `部门：${member.dept_name}`, member.email && `邮箱：${member.email}`, member.mobile && `电话：${member.mobile}`].filter(Boolean).join("；");
        return `${member.name}${details ? `（${details}）` : ""}`;
      }).join("、");
      const publicMemories = await pool.query(`SELECT owner_sub,content FROM (
        SELECT m.owner_sub,m.content,row_number() OVER (PARTITION BY m.owner_sub ORDER BY m.updated_at DESC) AS rank
        FROM agent_memories m JOIN users u ON u.provider || ':' || u.union_id=m.owner_sub
        WHERE m.owner_sub=ANY($1::text[]) AND u.memory_public=true
      ) ranked WHERE rank<=5`, [members.map(member => String(member.sub))]);
      const memoryByOwner = new Map<string, string[]>();
      for (const row of publicMemories.rows) {
        const owner = String(row.owner_sub);
        memoryByOwner.set(owner, [...(memoryByOwner.get(owner) ?? []), String(row.content)]);
      }
      const publicMemoryContext = members.map(member => {
        const memories = memoryByOwner.get(String(member.sub)) ?? [];
        return memories.length ? `${member.name}：${memories.join("；")}` : "";
      }).filter(Boolean).join("\n");
      slog(sessionId, "cowork.context", { runId, attachments: attachmentsForRun.map(item => item.name), images: groupImages.length, members: publicMembers }, "info", 1000000);
      // 快思考禁用 thinking、工具及 MCP，只读固定消息快照。
      // 原始决策流仅推送到右栏并持久化；正式消息仍按 reply/delegate 决策处理。
      const fastSystem = `你是群聊中的快思考分流器，${managementRequest ? "本轮可以使用专属的群 AI 管理工具" : "不使用工具"}，不输出思考过程。只输出一个 JSON 对象，格式为 {"decision":"silent|reply|review|delegate|react","answer":"","messageId":0,"emoji":""}。可以用 reply 的 answer 只发送一个表情；也可以选 react 给可见的具体消息添加表情，此时填写其 messageId 和 emoji。可用表情：${GROUP_EMOJIS.join(" ")}。表情回应事件也会作为群聊上下文供你判断，通常无须再回应单纯的表情；避免循环回应。拿不准消息意图、附件是否可见或自己是否该发言时选 review，进入第二轮“让我想想”，不要直接猜测并答复。` +
        (managementRequest ? "本轮是管理员请求管理群 AI。你已有 group-agents 工具，必须先调用 list_agents 核对，再调用 create_agent、edit_agent 或 delete_agent 完成操作。如果要求创建的同名 AI 已存在，仍可调用 create_agent，由工具返回已存在的结果。工具成功后才可选 reply；工具不可用、失败或没有权限时选 delegate。历史里声称已创建的文字不是操作依据。" : "") +
        (customPrompt ? "" : `若某成员明确 @${title} 或 @所有人 请求你发言，选 reply 或 delegate 时 answer 开头要 @ 该成员名字（如 @张三 ），名字以群成员名单为准。`) +
        `本 AI 发言规则：${replyPolicy === "proactive" ? "积极参与讨论；有帮助时主动简短回应，但不要打断明显的人与人对话。" : replyPolicy === "mentions_only" ? `只有明确 @${title} 或 @所有人 才允许回答。` : ""}${speakingInstruction.slice(0, 8000)}。` +
        (replyPolicy === "balanced" && !mustReply ? `当前是适时发言，且无人明确请求 AI。普通问句、对同事的追问、关于某人昨天是否做了某事的问题都默认是人际交流，选 silent；不要把它解释成在问 AI 自己，也不要以“我是 AI、没有领导”之类的自我说明抢答。只有明确影响当前群讨论的关键误解或决策阻塞，才允许主动发言。` : "") +
        (replyPolicy === "cautious" && !mustReply ? `当前是谨慎发言，且无人明确请求 AI。普通问句、闲聊、问候和对同事的追问都选 silent。仅当可见消息足以确认重大事实错误或紧迫风险，且不立即提醒会影响正在进行的决定时，才考虑主动发言；有疑问选 silent。` : "") +
        `仅凭可见消息、无需查资料、个人记忆、工具或复杂推理且能直接答好时选 reply，并在 answer 中写出符合当前 AI 提示词的最终回复；需要深入思考、调用工具、处理尚未出现在上下文中的附件或读取个人记忆时选 delegate。分流只看处理方式，不看输出长度；其余选 silent。` +
        (mustReply ? `这些点名请求必须得到回答，禁止 silent：${directlyRequested.map(row => String(row.content)).join("；").slice(0, 3000)}。` : "") +
        `群成员公开信息：${publicMembers.slice(0, 8000)}${publicMemoryContext ? `\n群成员已公开记忆：\n${publicMemoryContext.slice(0, 8000)}` : ""}` +
        (customPrompt ? `\n【${title} 的独立提示词，决定回复内容与格式】\n${customPrompt.slice(0, 8000)}\nreply.answer 必须直接符合这段提示词；不要自动添加称呼、解释或其他前后缀。` : "");
      const availableModes = getConfiguredAgentModes().filter(candidate => candidate === "codebuddy" || candidate === "codex");
      const configuredMode = String(setting.cowork_mode);
      const mode = availableModes.find(candidate => candidate === configuredMode) ?? availableModes[0] ?? "codebuddy";
      const url = new URL(request.url);
      url.pathname = url.pathname.replace(/\/api\/cowork\/[^/]+\/(?:send|state)$/, "/api/chat");
      let managementMutation: { method: "POST" | "PATCH" | "DELETE"; data: unknown } | null = null;
      const attachManagementTools = async (target: Request) => {
        if (!managementRequest) return;
        const actor = await pool.query("SELECT sender_sub FROM agent_messages WHERE session_id=$1 AND id=$2 AND role='user'", [sessionId, triggerId]);
        const authenticated = verifySession(request, loadAuthConfig());
        if (!actor.rows[0]?.sender_sub || actor.rows[0].sender_sub !== authenticated?.sub) return;
        const execute = async (method: "GET" | "POST" | "PATCH" | "DELETE", body?: Record<string, unknown>) => {
          const ctx = await access(request, sessionId);
          if (ctx.error || !ctx.isAdmin || ctx.user?.sub !== actor.rows[0].sender_sub) throw new Error("仅群管理员可以管理群 AI");
          const response = await agents(new Request(request.url, { method, headers: { cookie: request.headers.get("cookie") ?? "", "content-type": "application/json" }, ...method === "GET" ? {} : { body: JSON.stringify(body ?? {}) } }), sessionId);
          let data = await response.json();
          if (method === "POST" && response.status === 409 && data.error === "duplicate_name" && typeof body?.name === "string") {
            const existing = await pool.query(`SELECT id,name,prompt,enabled,reply_policy AS "replyPolicy",speaking_prompt AS "speakingPrompt",prompt_by_policy AS "promptByPolicy",created_by AS "createdBy"
              FROM cowork_agents WHERE session_id=$1 AND lower(name)=lower($2) LIMIT 1`, [sessionId, body.name.trim()]);
            if (existing.rows[0]) data = { agent: { ...existing.rows[0], prompt: promptForAgent(existing.rows[0]) }, alreadyExists: true };
          }
          if (!response.ok && !data.alreadyExists) throw new Error(String(data.error ?? `操作失败 (${response.status})`));
          if (method !== "GET") {
            managementMutation = { method, data };
            slog(sessionId, "cowork.agent_management.resolved", { runId, triggerId, method, alreadyExists: Boolean(data.alreadyExists), agentId: (data as { agent?: { id?: string } }).agent?.id }, "info");
          }
          return data;
        };
        attachInternalCoworkAgentTools(target, createCoworkAgentMcpServer(execute));
      };
      let fastDecision: "silent" | "reply" | "review" | "delegate" | "react" = mustReply ? "delegate" : "silent";
      let fastAnswer = "";
      let fastReaction: { messageId?: number; emoji?: string } = {};
      let fastFailed = false;
      try {
        const fastRequest = new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
          body: JSON.stringify({ messages: [{ role: "system", content: fastSystem }, ...modelHistory(history)], sessionId: `${sessionId}_cowork_fast_${runId.replaceAll("-", "")}`,
            cowork: true, coworkFast: true, coworkCustomPrompt: !!customPrompt, resume: false, agentMode: "codebuddy", model: mode === "codebuddy" ? setting.cowork_model ?? undefined : undefined }) });
        await attachManagementTools(fastRequest);
        // 快思考重试（low=1 次）：hy3 免费渠道常出现 429 / 不按 JSON 输出，重发一次可显著提高决策成功率。
        let firstThinkingChars = 0;
        const { fastText, parsed } = await withRetry(async () => {
          const fastResponse = await agent.POST(markInternalCoworkRequest(fastRequest), { params: { agent: ["chat"] } });
          if (!fastResponse.ok || !fastResponse.body) throw new RetryableError(`快思考请求失败 (${fastResponse.status})`);
          let lastFastWrite = 0;
          firstThinkingChars = 0;
          let pendingFastWrite: Promise<unknown> = Promise.resolve();
          const text = await readCoworkText(fastResponse.body, (event, payload, content) => {
            if (event === "thinking" && fastPhase === "initial") firstThinkingChars += String(payload.text ?? "").length;
            if (event === "thinking" && fastPhase === "review") {
              const step = (fastSteps[Math.max(1, Number(payload.index) || 1) - 1] ??= { thinking: "" });
              step.thinking = `${step.thinking ?? ""}${String(payload.text ?? "")}`;
            }
            if (event !== "text" && event !== "thinking") return;
            fastContent = content;
            publishCowork(sessionId, { kind: "fast", runId, agentId: selectedAgent.id, content, status: "running", steps: structuredClone(fastSteps), elapsedSecs: fastElapsedSecs(), phase: "initial" });
            if (Date.now() - lastFastWrite > 500) {
              lastFastWrite = Date.now();
              const snapshot = JSON.stringify(fastSteps);
              pendingFastWrite = pendingFastWrite.then(() => pool.query("UPDATE cowork_runs SET fast_content=$2,fast_status='running',fast_steps=$3 WHERE id=$1", [runId, content, snapshot])).catch(() => {});
            }
          });
          await pendingFastWrite;
          let decision: ReturnType<typeof parseFastDecision>;
          try {
            decision = parseFastDecision(text);
          } catch (error) {
            // 模型未按约定输出 JSON：整体重试，让模型重新生成决策
            throw new RetryableError(error instanceof Error ? error.message : "快思考未返回 JSON 决策");
          }
          return { fastText: text, parsed: decision };
        }, retryPolicy("low", {
          onRetry: (attempt, error, delayMs) => slog(sessionId, "cowork.fast.retry", { runId, attempt, error: error instanceof Error ? error.message : String(error), delayMs }, "warn"),
        }));
        slog(sessionId, "cowork.fast.initial", { runId, decision: parsed.decision, answer: parsed.answer, raw: fastText, firstThinkingChars, elapsedSecs: fastElapsedSecs() }, "info", 1000000);
        fastDecision = parsed.decision;
        fastAnswer = parsed.answer;
        fastReaction = { messageId: parsed.messageId, emoji: parsed.emoji };
        const newMessages = await pool.query(`SELECT m.id,m.content,m.attachment,COALESCE(NULLIF(u.name,''),u.user_code,'成员') AS sender_name
          FROM agent_messages m LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
          WHERE m.session_id=$1 AND m.role IN ('user','reaction') AND m.id>$2 ORDER BY m.id`, [sessionId, triggerId]);
        const reviewHistory = [...history];
        let reviewMustReply = mustReply;
        const newImages: ImageSpec[] = [];
        for (const row of newMessages.rows) {
          const nextAgents = await agentsForMessage(pool, sessionId, String(row.content));
          if (!nextAgents.some(agent => agent.id === selectedAgent.id)) break;
          const attached = groupAttachments(row.attachment, sessionId);
          const context = await groupAttachmentContext(sessionId, attached);
          newImages.push(...context.images);
          reviewHistory.push({ role: "user", content: `[${row.sender_name}] ${row.content}${context.text ? `\n\n${context.text}` : ""}` });
          coveredThroughId = Math.max(coveredThroughId, Number(row.id));
          if (replyPolicy === "mentions_only" ? explicitlyMentioned(String(row.content), title) : directlyAddressed(String(row.content), title)) {
            reviewMustReply = true;
            mustReply = true;
            directlyRequested.push(row);
            replyTargetId = Number(row.id);
          }
        }
        if (newMessages.rowCount && (groupImages.length || newImages.length)) {
          const lastReviewUser = [...reviewHistory].reverse().find(message => message.role === "user");
          if (lastReviewUser) lastReviewUser.images = [...groupImages, ...newImages];
        }
        if (!managementRequest && (newMessages.rowCount || (!humanFollowup && shouldReviewFastDecision(fastDecision, replyPolicy, mustReply, socialGreeting)))) {
          const initialElapsed = fastElapsedSecs();
          await pool.query("UPDATE cowork_runs SET fast_initial_content=$2,fast_initial_elapsed_secs=$3 WHERE id=$1", [runId, fastText, initialElapsed]);
          publishCowork(sessionId, { kind: "fast", runId, agentId: selectedAgent.id, content: fastText, status: "review_initial", steps: [], elapsedSecs: initialElapsed, phase: "initial" });
          fastPhase = "review";
          activeFast.phase = "review";
          fastStartedAt = Date.now();
          fastContent = "";
          await updateFast("reviewing");
          const policyDescription = replyPolicy === "proactive" ? "积极参与：发现有帮助的建议或关键遗漏时可以主动简短发言" :
            replyPolicy === "mentions_only" ? `仅被 @${title} 或 @所有人 时发言` : replyPolicy === "cautious" ? "谨慎发言：无人明确请求时，只有已确认的重大错误或紧迫风险会影响当前决定才提醒" : replyPolicy === "balanced" ? "适时发言：人与人交流时默认不插话，明确请求或关键遗漏时回应" : "自定义";
          const reviewSystem = `你仍是群聊的快思考分流器。上一轮快速判断为 ${fastDecision}；现在认真复核一次。只依据消息中已提供的附件摘要判断是否发言；若必须读取原文件或深入处理，选 delegate，交给慢思考。上一轮出现了 ${firstThinkingChars} 字的模型思考；如果首轮拿不准，不要沿用未经核实的直接答复。` +
            `以下是本轮从会话成员表读取的群成员公开信息，群成员不需要先发言才能被识别：${publicMembers.slice(0, 8000)}。${publicMemoryContext ? `群成员已公开记忆：${publicMemoryContext.slice(0, 8000)}。` : ""}` +
            `请特别依据当前 AI 的发言方式（${policyDescription}）判断是否真的应该发言。${speakingInstruction.slice(0, 8000)}` +
            `没有明确点名或邀请 AI 时，尤其是问某个人有没有做事、普通追问、问句里主语不明时，默认是在问群成员，选 silent。不要因为能回答或能解释“我作为 AI 没有领导”就主动插话。` +
            (replyPolicy === "cautious" && !reviewMustReply ? `谨慎发言下，普通遗漏或可补充的建议不足以主动发言；只有已确认的重大事实错误或紧迫风险会影响当前决定时才选 reply，否则选 silent。` : `只有当前讨论存在明显且重要的误解、遗漏或阻塞，且此刻插话确有必要，才主动选 reply；`) +
            `明确请求 AI 时，若已核实并能完成，选 reply，并让 answer 遵循当前 AI 的提示词；复核后仍需较长执行或超出本轮工具处理能力才选 delegate。` +
            (reviewMustReply ? `本轮存在明确点名请求，必须回答，不允许 silent。` : "") +
            `思考结束后仅输出 JSON：{"decision":"silent|reply|delegate|react","answer":"","messageId":0,"emoji":""}。可以用 reply 发送单个表情，或用 react 给具体可见消息添加表情；可用表情：${GROUP_EMOJIS.join(" ")}。不要循环回应表情。` +
            (customPrompt ? `\n【${title} 的独立提示词，决定回复内容与格式】\n${customPrompt.slice(0, 8000)}\nreply.answer 必须直接符合这段提示词；不要自动添加称呼、解释或其他前后缀。` : "");
          const reviewRequest = new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
            body: JSON.stringify({ messages: [{ role: "system", content: reviewSystem }, ...modelHistory(reviewHistory)], sessionId: `${sessionId}_cowork_review_${runId.replaceAll("-", "")}`,
              cowork: true, coworkFast: true, coworkFastReasoning: true, coworkCustomPrompt: !!customPrompt, coworkAttachmentSessionId: sessionId,
              resume: false, agentMode: "codebuddy", model: mode === "codebuddy" ? setting.cowork_model ?? undefined : undefined }) });
          const reviewResponse = await agent.POST(markInternalCoworkRequest(reviewRequest), { params: { agent: ["chat"] } });
          if (!reviewResponse.ok || !reviewResponse.body) throw new Error(`快思考复核失败 (${reviewResponse.status})`);
          let lastReviewWrite = 0;
          let pendingReviewWrite: Promise<unknown> = Promise.resolve();
          const reviewText = await readCoworkText(reviewResponse.body, (event, payload, content) => {
            const step = () => (fastSteps[Math.max(1, Number(payload.index) || 1) - 1] ??= { thinking: "" });
            if (event === "thinking") {
              const current = step();
              current.thinking = `${current.thinking ?? ""}${String(payload.text ?? "")}`;
            }
            if (event === "tool") step().tool = { name: String(payload.name ?? ""), input: String(payload.input ?? ""),
              activity: String(payload.activity ?? ""), edit: payload.edit, toolUseId: String(payload.toolUseId ?? ""), status: "running" };
            if (event === "tool_result") {
              const tool = step().tool;
              if (tool && (!tool.toolUseId || !payload.toolUseId || tool.toolUseId === String(payload.toolUseId))) {
                tool.status = payload.status === "failed" ? "failed" : "completed";
                tool.result = String(payload.summary ?? "").slice(0, 300);
              }
            }
            if (event !== "text" && event !== "thinking" && event !== "tool" && event !== "tool_result") return;
            if (event === "text") fastContent = content;
            publishCowork(sessionId, { kind: "fast", runId, agentId: selectedAgent.id, content: fastContent, status: "reviewing", steps: structuredClone(fastSteps), elapsedSecs: fastElapsedSecs(), phase: "review" });
            if (Date.now() - lastReviewWrite > 500) {
              lastReviewWrite = Date.now();
              const snapshot = JSON.stringify(fastSteps);
              const currentContent = fastContent;
              pendingReviewWrite = pendingReviewWrite.then(() => pool.query("UPDATE cowork_runs SET fast_content=$2,fast_status='reviewing',fast_steps=$3 WHERE id=$1", [runId, currentContent, snapshot])).catch(() => {});
            }
          });
          await pendingReviewWrite;
          const reviewed = parseFastDecision(reviewText);
          slog(sessionId, "cowork.fast.review", { runId, decision: reviewed.decision, answer: reviewed.answer, raw: reviewText, steps: fastSteps, elapsedSecs: fastElapsedSecs() }, "info", 1000000);
          fastDecision = reviewed.decision === "review" ? "delegate" : reviewed.decision;
          fastAnswer = reviewed.answer;
          fastReaction = { messageId: reviewed.messageId, emoji: reviewed.emoji };
          fastContent = reviewText;
          reviewSucceeded = true;
        }
      } catch (error) {
        console.error("[cowork] fast decision failed", error);
        slog(sessionId, "cowork.fast.fallback", { runId, phase: fastPhase, reason: error instanceof Error ? error.message : String(error) }, "warn");
        fastFailed = true;
        fastDecision = mustReply || coveredThroughId > triggerId || isTaskDirected(String(triggerMessage?.content ?? ""))
          || fastDecision === "reply" || fastDecision === "delegate" || fastDecision === "review" ? "delegate" : "silent";
        fastAnswer = "";
        fastContent = JSON.stringify({ decision: fastDecision, answer: "" });
        await updateFast("done");
      }
      if (socialGreeting && coveredThroughId === triggerId && !mustReply && (replyPolicy === "balanced" || replyPolicy === "proactive")) {
        if (fastDecision !== "reply" || !fastAnswer.trim()) fastAnswer = socialGreeting;
        fastDecision = "reply";
      }
      if (mustReply && fastDecision === "silent") fastDecision = "delegate";
      if (fastDecision === "review") fastDecision = "delegate";
      if (humanFollowup && !mustReply && coveredThroughId === triggerId) fastDecision = "silent";
      if (managementRequest) {
        if (managementMutation) {
          const mutation = managementMutation as { method: "POST" | "PATCH" | "DELETE"; data: { agent?: { name?: string }; alreadyExists?: boolean } };
          const action = mutation.data.alreadyExists ? "已存在" : mutation.method === "POST" ? "创建" : mutation.method === "PATCH" ? "更新" : "删除";
          fastDecision = "reply";
          fastAnswer = mutation.data.alreadyExists ? `群 AI${mutation.data.agent?.name ? `「${mutation.data.agent.name}」` : ""}已存在。` : `已${action}群 AI${mutation.data.agent?.name ? `「${mutation.data.agent.name}」` : ""}。`;
        } else fastDecision = "delegate";
      }
      // 复核只决定是否交给慢思考；复核生成的草稿不是群聊正式答复。
      const slowReply = reviewSucceeded && fastDecision === "reply";
      if (slowReply) fastDecision = "delegate";
      if (!reviewSucceeded) coveredThroughId = triggerId;
      if (coveredThroughId > triggerId) await pool.query("UPDATE cowork_runs SET trigger_message_id=$2 WHERE id=$1", [runId, coveredThroughId]);
      if (fastDecision === "reply" && !fastAnswer.trim()) fastDecision = mustReply ? "delegate" : "silent";
      slog(sessionId, "cowork.fast.final", { runId, decision: fastDecision, answer: fastAnswer, reviewed: fastPhase === "review", fastFailed, socialGreeting, mustReply, humanFollowup }, "info", 1000000);
      fastContent = JSON.stringify({ decision: slowReply ? "slow_reply" : fastDecision, answer: fastDecision === "reply" ? fastAnswer : "" });
      await updateFast("done");
      if (fastDecision === "silent") { await update("silent", "", null, false); return; }
      if (fastDecision === "react") {
        const target = Number(fastReaction.messageId);
        if (!Number.isSafeInteger(target) || !isGroupEmoji(fastReaction.emoji)) { await update("silent", "", null, false); return; }
        const inserted = await pool.query(`INSERT INTO cowork_message_reactions(message_id,user_sub,emoji)
          SELECT id,$4,$3 FROM agent_messages WHERE id=$1 AND session_id=$2 AND role<>'reaction'
          ON CONFLICT DO NOTHING RETURNING message_id`, [target, sessionId, fastReaction.emoji, `agent:${selectedAgent.id}`]);
        if (inserted.rowCount) {
          const reactions = await pool.query("SELECT r.message_id, r.user_sub, CASE WHEN r.user_sub='agent' THEN NULL ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END AS user_name, r.emoji FROM cowork_message_reactions r JOIN agent_messages m ON m.id=r.message_id JOIN agent_sessions s ON s.id=m.session_id LEFT JOIN users u ON u.provider || ':' || u.union_id=r.user_sub WHERE m.session_id=$1 ORDER BY r.created_at,r.emoji", [sessionId]);
          publishCowork(sessionId, { kind: "reactions", reactions: reactions.rows as Array<{ message_id: number; user_sub: string; user_name: string | null; emoji: string }> });
        }
        await update("done", "", null, false);
        return;
      }
      if (fastDecision === "reply") {
        const replyTargetRow = mustReply ? rows.rows.find(r => Number(r.id) === replyTargetId) : null;
        const answer = ensureReplyMention(fastAnswer.trim(), String(replyTargetRow?.sender_name ?? ""), !!replyTargetRow && !customPrompt);
        slog(sessionId, "cowork.message.reply", { runId, answer }, "info", 1000000);
        // 快思考/复核阶段是模型做决策的临时产物（写 fast/review run 目录），展示侧按
        // TEMP_RUN_DIR_RE 过滤，不作为交付卡片挂到回复上；只有 slow 交付轮的产物才挂。
        await appendAnswer(answer, false, await collectRunArtifacts(fastSessionId));
        await update("done", answer, null, false);
        return;
      }
      slog(sessionId, "cowork.slow.start", { runId, triggerId, modelMode: mode, fastDecision }, "info");
      visible = true;
      await update("running", "");
      const memoryParts = members.map(member => {
        const profile = [member.dept_name && `部门：${member.dept_name}`, member.email && `邮箱：${member.email}`, member.mobile && `电话：${member.mobile}`].filter(Boolean).join("；");
        const memories = memoryByOwner.get(String(member.sub)) ?? [];
        return `${member.name}${profile ? `（${profile}）` : ""}${memories.length ? `：${memories.join("；")}` : ""}`;
      });
      const system = `你是群聊中的 ${title}。快思考已判定这一轮需要深度思考或工具调用。请完成任务并给出正式答复，不要输出 <SILENT>。` +
        (selectedAgent.id === `${sessionId}:default` ? "管理员要求创建、编辑、删除群 AI 时，必须使用 group-agents 工具实际操作。历史消息即使声称已创建，也不能作为完成依据；先用 list_agents 核对，再按当前请求调用 create_agent、edit_agent 或 delete_agent。同名 AI 已存在时 create_agent 会返回已存在的结果。创建时根据描述写出独立角色提示词并选择发言方式；工具成功后再告知结果。无工具或无权限时如实说明。" : "") +
        `如果是未被点名的主动发言，最多两句，优先提出一个让群成员决策的问题。` +
        (customPrompt ? "" : `若这轮被某成员明确 @ 或点名请求你发言，答复开头 @ 该成员名字（如 @张三 ），名字以群成员名单为准。`) +
        (mustReply ? `以下尚未回应的消息明确请你发言，必须逐一回应，不能输出 <SILENT>：${directlyRequested.map(row => String(row.content)).join("；").slice(0, 4000)}。` : "") +
        `群内决定由人做。不要泄露不在本群的资料。\n群成员公开资料与获准共享的记忆：\n${memoryParts.filter(Boolean).join("\n").slice(0, 16000)}` +
        (hostContext ? `\n\n【宿主能力上下文】\n${hostContext}` : "") +
        (customPrompt ? `\n\n【${title} 的独立提示词，决定最终回复内容与格式】\n${customPrompt.slice(0, 16000)}\n严格按此提示词回复；不要自动添加称呼、解释或其他前后缀。` : "");
      const slowMode = managementRequest ? "codebuddy" : mode;
      const agentRequest = new Request(url, { method: "POST", headers: { "content-type": "application/json", cookie: request.headers.get("cookie") ?? "" },
        body: JSON.stringify({ messages: [{ role: "system", content: system }, ...modelHistory(history)], sessionId: `${sessionId}_cowork_slow_${runId.replaceAll("-", "")}`, cowork: true, coworkCustomPrompt: !!customPrompt,
          coworkAttachmentSessionId: sessionId, coworkAgentId: selectedAgent.id, attachments: attachmentsForRun,
          resume: false, agentMode: slowMode, model: slowMode === "codebuddy" && mode === "codebuddy" ? setting.cowork_model ?? undefined : undefined, codexModelKey: setting.cowork_codex_model ?? undefined }) });
      await attachManagementTools(agentRequest);
      // 慢思考重试（high=最多 3 次重试）：hy3 免费渠道 429 / 5xx / 流中断频繁，
      // 产出型调用值得等待重试；每次尝试从零重建流，answer/steps 重置避免累积。
      const slowText = await withRetry(async () => {
        const response = await agent.POST(markInternalCoworkRequest(agentRequest), { params: { agent: ["chat"] } });
        if (!response.ok || !response.body) throw new RetryableError(`模型请求失败 (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let lastWrite = 0;
        let lastSnapshot = 0;
        answer = "";
        steps.length = 0;
        const consume = async (event: string, data: string) => {
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(data) as Record<string, unknown>; } catch { return; }
          const index = Math.max(1, Number(payload.index) || 1);
          const step = () => (steps[index - 1] ??= { thinking: "", text: "" });
          const publishAgent = (value = payload) => {
            if (visible) publishCowork(sessionId, { kind: "agent", runId, event, data: value });
          };
          if (event === "text") {
            answer += String(payload.text ?? "");
            const partial = answer.trim();
            if ("<SILENT>".startsWith(partial) || partial.startsWith("<SILENT>")) return;
            if (!visible && partial && !"<SILENT>".startsWith(partial) && !partial.startsWith("<SILENT>")) {
              visible = true;
              await update("running", "");
              publishAgent({ ...payload, text: answer });
            } else if (visible) publishAgent();
            if (visible && Date.now() - lastWrite > 300) {
              await update("running", answer, null, false); lastWrite = Date.now();
            }
          } else if (event === "thinking") {
            step().thinking = `${step().thinking ?? ""}${String(payload.text ?? "")}`;
            publishAgent();
          } else if (event === "tool") {
            step().tool = { name: String(payload.name ?? ""), input: String(payload.input ?? ""), activity: String(payload.activity ?? ""), edit: payload.edit,
              toolUseId: String(payload.toolUseId ?? ""), status: "running" };
            publishAgent();
          } else if (event === "tool_result") {
            const tool = step().tool;
            if (tool && (!tool.toolUseId || !payload.toolUseId || tool.toolUseId === String(payload.toolUseId))) {
              tool.status = payload.status === "failed" ? "failed" : "completed";
              tool.result = String(payload.summary ?? "").slice(0, 300);
              if (tool.name.endsWith("__start_preview") && tool.status === "completed") {
                let command = "";
                try { command = String((JSON.parse(String(tool.input ?? "{}")) as { cmd?: unknown }).cmd ?? ""); } catch { /* malformed tool input */ }
                if (command.trim()) await pool.query("UPDATE cowork_agents SET preview_command=$3,updated_at=now() WHERE session_id=$1 AND id=$2", [sessionId, selectedAgent.id, command]);
                const published = await pool.query("SELECT preview_token FROM cowork_agents WHERE session_id=$1 AND id=$2", [sessionId, selectedAgent.id]);
                const publicId = published.rows[0]?.preview_token;
                if (typeof publicId === "string" && /^[0-9a-f]{48}$/.test(publicId)) {
                  const basePath = process.env.AUTH_COOKIE_PATH?.replace(/\/+$/, "") ?? "";
                  const publicUrl = new URL(`${basePath}/preview/${publicId}/`, process.env.APP_PUBLIC_URL || request.url).toString();
                  const requesterSub = verifySession(request, loadAuthConfig())?.sub;
                  publishCoworkPreview(sessionId, selectedAgent.id, publicUrl, requesterSub);
                }
              }
            }
            publishAgent();
          } else if (event === "error") {
            publishAgent();
            throw new RetryableError(String(payload.text ?? "模型错误"));
          } else if (event !== "title") {
            publishAgent();
          }
          if (visible && Date.now() - lastSnapshot > 500) {
            await update("running", answer, null, false);
            lastSnapshot = Date.now();
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          buffer = buffer.replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, boundary).replaceAll("\r", ""); buffer = buffer.slice(boundary + 2);
            const event = block.match(/^event:\s*(.+)$/m)?.[1] ?? "";
            const data = block.match(/^data:\s*(.+)$/m)?.[1] ?? "{}";
            await consume(event, data);
          }
          if (done) break;
        }
        return answer.trim();
      }, retryPolicy("high", {
        onRetry: (attempt, error, delayMs) => slog(sessionId, "cowork.slow.retry", { runId, attempt, error: error instanceof Error ? error.message : String(error), delayMs }, "warn"),
      }));
      answer = slowText;
      if (managementRequest && !managementMutation) answer = "群 AI 尚未创建或修改成功。请由群管理员重试；我不能在未完成操作时声称已创建。";
      answer = !answer || answer.startsWith("<SILENT>") ? "我需要更多信息才能继续，你希望我先处理哪一部分？" : answer;
      // 被点名时答复 @ 对方：确保回复以 @名字 开头（模型可能漏写，服务端兜底）
      const replyTargetRow = mustReply ? rows.rows.find(r => Number(r.id) === replyTargetId) : null;
      answer = ensureReplyMention(answer, String(replyTargetRow?.sender_name ?? ""), !!replyTargetRow && !customPrompt);
      slog(sessionId, "cowork.slow.final", { runId, answer, steps, elapsedSecs: elapsedSecs() }, "info", 1000000);
      await appendAnswer(answer, true, await collectRunArtifacts(slowSessionId));
      await update("done", answer);
    } catch (error) {
      console.error("[cowork] run failed", error);
      slog(sessionId, "cowork.run.error", { runId, error: error instanceof Error ? error.stack ?? error.message : String(error),
        dbCode: (error as { code?: string }).code, dbDetail: (error as { detail?: string }).detail, answer, steps }, "error", 1000000);
      await appendAnswer(`这轮处理失败：${error instanceof Error ? error.message : "服务暂时不可用"}`, true, await collectRunArtifacts(slowSessionId));
      await update("error", answer, error instanceof Error ? error.message : String(error));
    } finally {
      if (activeFastRuns.get(sessionId) === activeFast) activeFastRuns.delete(sessionId);
      if (heartbeat) clearInterval(heartbeat);
      const pending = await pool.query("SELECT id FROM agent_messages WHERE session_id=$1 AND role IN ('user','reaction') AND id>$2 ORDER BY id ASC LIMIT 1", [sessionId, coveredThroughId]);
      if (pending.rowCount) void scheduleMessageRunsForTrigger(request, sessionId, Number(pending.rows[0].id)).catch(error => console.error("[cowork] follow-up failed", error));
    }
  }

  async function stream(request: Request, sessionId: string): Promise<Response> {
    const ctx = await access(request, sessionId);
    if (ctx.error) return ctx.error;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const sendEvent = (event: string, data: unknown) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* 已关闭 */ }
        };
        sendEvent("open", {});
        const unsubscribe = subscribeCowork(sessionId, (push) => {
          if (push.kind === "message") sendEvent("message", { message: push.message });
          else if (push.kind === "revoked") sendEvent("revoked", { messageId: push.messageId, revokedAt: push.revokedAt });
          else if (push.kind === "run") sendEvent("run", { run: push.run });
          else if (push.kind === "agent") sendEvent("agent", { runId: push.runId, event: push.event, data: push.data });
          else if (push.kind === "agents") sendEvent("agents", {});
          else if (push.kind === "preview") sendEvent("preview", { agentId: push.agentId, url: push.url, requesterSub: push.requesterSub });
          else if (push.kind === "fast") sendEvent("fast", push);
          else if (push.kind === "reactions") sendEvent("reactions", { reactions: push.reactions });
          else if (push.kind === "settings") sendEvent("settings", { settings: push.settings, ownerSub: push.ownerSub, ownerName: push.ownerName, ownerAvatar: push.ownerAvatar });
        });
        // 保活：部分代理会掐断空闲连接
        const heartbeat = setInterval(() => { try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { /* 已关闭 */ } }, 15_000);
        const cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try { controller.close(); } catch { /* 已关闭 */ }
        };
        request.signal.addEventListener("abort", cleanup);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return { state, agents, container, admins, exec, complete, preview, publicPreview, connections, monologues, chatmate, setChatmate, stopChatmate, stopAgent, chatmateAct, send, forward, revoke, reaction, settings, stream };
}
