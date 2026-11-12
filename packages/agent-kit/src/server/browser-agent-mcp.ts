/**
 * agent-kit · browser-agent MCP 工具（computer use：AI 自主控制浏览器）
 *
 * 设计：把"浏览器操作智能体"封装成一个 MCP 工具 control_browser(task)，由聊天模型（hy3）
 * 在对话中**自主决定**何时调用——无需用户在 UI 上手动触发。
 *
 * 工具内部是一个纯视觉 computer-use 循环（与 web-fetch 同款 Playwright 持久上下文）：
 *   截图 → 把截图作为图片发给 hy3（allowedTools:[] 关掉工具、maxTurns:1 不自循环，仅做视觉
 *   推理输出动作 JSON）→ 解析并执行（click/type/scroll/navigate/wait/done/ask）→ 循环。
 *
 * 关键能力：
 *   - 全程通过 SSE 事件（screenshot / thinking / action / done / ask / finished）外发，
 *     聊天模型经 canUseTool 拦截时注册订阅者，过程事件同步转发进聊天 SSE，
 *     前端 thinking 展开区实时展示浏览器截图与动作（headless 无独立窗口）。
 *   - 单例 BrowserAgentService 同时服务「手动入口（/api/browser/session）」与
 *     「自主 control_browser 工具」，二者共用同一会话注册表，避免重复实现。
 *   - 容错解析：容忍 Markdown 代码块、尾随逗号；连续无效操作（疑似卡死）自动停止。
 *
 * 暴露：control_browser(task: string, max_steps?: number) → { summary, finalUrl, finalTitle, steps }
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import { z } from "zod";
import {
  query,
  createSdkMcpServer,
  tool,
  type SdkMcpServerResult,
  type UserMessage,
} from "@tencent-ai/agent-sdk";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { ReadableStreamDefaultController } from "node:stream/web";
import { createServer as createNetServer } from "node:net";

// tsconfig lib 不含 DOM：page.evaluate 回调内的 DOM 全局显式声明为 any
declare const document: any;
declare const window: any;

/** 视口固定 1280x900：截图尺寸与 hy3 输出的坐标空间一致 */
const VIEWPORT = { width: 1280, height: 900 } as const;
const DEFAULT_MAX_STEPS = 25;

/** 找一个空闲 TCP 端口给 Chromium 远程调试（多会话并发各起独立浏览器进程，端口不能固定） */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function defaultProfileDir(): string {
  if (process.env.BROWSER_AGENT_PROFILE_DIR?.trim()) {
    return path.resolve(process.env.BROWSER_AGENT_PROFILE_DIR.trim());
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..", "..", "..", "..");
    return path.join(repoRoot, ".browser-agent-profile");
  } catch {
    return path.join(process.cwd(), ".browser-agent-profile");
  }
}

/** 允许访问的域名白名单（空数组 = 不限制；建议按需收紧） */
function allowedHosts(): string[] {
  return (process.env.BROWSER_AGENT_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const BROWSER_SYSTEM_PROMPT = `你是一个浏览器操作智能体，运行在 ${VIEWPORT.width}x${VIEWPORT.height} 的视口中。
你的任务：根据当前页面截图，决定下一步浏览器操作，并**只输出一个 JSON 对象**，不要输出任何多余文字、不要调用任何工具。

坐标系统：截图左上角为 (0,0)，x 向右、y 向下，范围 x∈[0,${VIEWPORT.width}]、y∈[0,${VIEWPORT.height}]。
动作 JSON 规范（必须严格遵循其一，一次只做一个动作）：
  {"action":"click","x":<number>,"y":<number>}            点击屏幕坐标
  {"action":"type","text":"<string>"}                      在当前焦点输入框输入文字
  {"action":"scroll","direction":"up"|"down","amount":<px>} 滚动页面（amount 默认 600）
  {"action":"navigate","url":"<https://...>"}              打开/跳转到 URL
  {"action":"wait","ms":<number>}                           等待（默认 1500）
  {"action":"ask","question":"<string>"}                    需要人类接管时提问（如遇到图形验证码）
  {"action":"done","summary":"<string>"}                    任务完成，简述结果

严格格式要求：
  1. 只输出单个 JSON 对象，禁止用 Markdown 代码块包裹，禁止任何解释文字；
  2. 禁止 JSON 尾随逗号；字符串必须用双引号；
  3. 点击前先确认目标元素在视口内，必要时先 scroll 再 click；
  4. 输入前必须先 click 对应输入框使其获得焦点，再输出 type；
  5. 任务完成后务必输出 done，并在 summary 中给出用户在原问题中要的答案；
  6. 遇到图形验证码、短信/邮箱验证等必须人类介入时，输出 ask；
  7. 不要访问白名单之外的危险站点，保持任务聚焦。
  8. 重要：你自身没有任何可调用的工具，这是设计如此、完全正常——你输出的动作 JSON 会由外部执行器（Playwright）真实执行。
     因此**绝不能**以「我没有工具 / 我无法执行浏览器操作 / 我是 AI 助手」为由拒绝任务或输出 ask；
     ask 仅用于页面本身出现人类必须介入的拦阻（图形验证码、滑块、短信验证码、扫码等）。`;

type BrowserAction =
  | { action: "click"; x: number; y: number }
  | { action: "type"; text: string }
  | { action: "scroll"; direction: "up" | "down"; amount?: number }
  | { action: "navigate"; url: string }
  | { action: "wait"; ms?: number }
  | { action: "ask"; question: string }
  | { action: "done"; summary: string };

interface ParsedAction {
  action: BrowserAction;
  /** true=模型确实输出了合法动作；false=解析兜底（如无法提取 JSON），用于卡死检测 */
  valid: boolean;
}

/** 用 hy3 做单步视觉决策：返回模型原始文本（后续解析为动作 JSON）。
 *  correction 非空时，在指令里注入上一步的纠正提示（如模型误以"没工具"为由拒绝）。 */
async function decide(task: string, step: number, base64: string, correction?: string): Promise<string> {
  const instruction =
    `任务：${task}\n` +
    (correction ? `[重要纠正] ${correction}\n` : "") +
    `当前是第 ${step} 步。请观察截图，输出下一步动作 JSON。`;
  const userMsg: UserMessage = {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        { type: "text", text: instruction },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
      ],
    },
  };
  const promptIter = (async function* () {
    yield userMsg;
  })();
  let text = "";
  for await (const msg of query({
    prompt: promptIter,
    options: {
      model: process.env.AGENT_MODEL?.trim() || "hy3",
      allowedTools: [],
      maxTurns: 1,
      continue: false,
      sessionId: undefined,
      permissionMode: "bypassPermissions",
      systemPrompt: { append: BROWSER_SYSTEM_PROMPT },
      includePartialMessages: false,
      thinking: { type: "disabled" },
      cwd: process.cwd(),
    },
  })) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") text += block.text;
      }
    }
  }
  return text;
}

/** 容错 JSON 解析：先试原串，再修尾随逗号；失败回 null */
function tryJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    /* ignore */
  }
  try {
    const fixed = s.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(fixed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从文本提取第一个 {...} 平衡块 */
function extractBraces(raw: string): string {
  const start = raw.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return raw.slice(start);
}

/** 正则兜底：当 JSON 完全无法解析时，直接从文本抽取字段 */
function regexExtract(raw: string): Record<string, unknown> | null {
  const am = raw.match(/"action"\s*:\s*"(click|type|scroll|navigate|wait|ask|done)"/i);
  if (!am) return null;
  const action = am[1].toLowerCase();
  const obj: Record<string, unknown> = { action };
  const pick = (key: string, re: RegExp) => {
    const m = raw.match(re);
    if (m) obj[key] = m[1];
  };
  pick("x", /"x"\s*:\s*([\d.]+)/);
  pick("y", /"y"\s*:\s*([\d.]+)/);
  pick("text", /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  pick("url", /"url"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  pick("direction", /"direction"\s*:\s*"(up|down)"/i);
  pick("amount", /"amount"\s*:\s*([\d.]+)/);
  pick("ms", /"ms"\s*:\s*([\d.]+)/);
  pick("question", /"question"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  pick("summary", /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return obj;
}

function buildAction(obj: Record<string, unknown>): BrowserAction {
  const action = String(obj.action || "");
  switch (action) {
    case "click":
      return { action: "click", x: Number(obj.x) || 0, y: Number(obj.y) || 0 };
    case "type":
      return { action: "type", text: String(obj.text ?? "") };
    case "scroll":
      return { action: "scroll", direction: obj.direction === "up" ? "up" : "down", amount: Number(obj.amount) || 600 };
    case "navigate":
      return { action: "navigate", url: String(obj.url ?? "") };
    case "wait":
      return { action: "wait", ms: Number(obj.ms) || 1500 };
    case "ask":
      return { action: "ask", question: String(obj.question ?? "需要人工接管") };
    case "done":
      return { action: "done", summary: String(obj.summary ?? "") };
    default:
      return { action: "wait", ms: 1500 };
  }
}

/** 解析模型输出为动作；valid=false 表示进入兜底（用于卡死检测） */
function parseAction(raw: string): ParsedAction {
  const cleaned = raw.replace(/```json|```/gi, "").trim();
  const slice = extractBraces(cleaned);
  const obj = (slice && tryJson(slice)) || regexExtract(cleaned);
  if (!obj || !obj.action) return { action: { action: "wait", ms: 1500 }, valid: false };
  return { action: buildAction(obj), valid: true };
}

function clamp(v: number, max: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(max, Math.round(v)));
}

function hostAllowed(url: string, hosts: string[]): boolean {
  if (hosts.length === 0) return true;
  try {
    const h = new URL(url).hostname;
    return hosts.some((a) => h === a || h.endsWith(`.${a}`));
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 判定 ask 是否属于"模型误以为自己没工具"的无效接管（而非页面本身的验证拦阻）。
 *  这类拒绝不该转给人工，应作为无效步纠正后重试。 */
function isCapabilityRefusal(question: string): boolean {
  return /没有[^。]*(工具|自动化)|无法[^。]*(执行|操作|驱动|点击|输入)|作为(一?个)?(AI|人工智能|助手|语言模型)|(不能|无法)[^。]*(真正|实际)[^。]*(执行|操作)/i.test(
    question,
  );
}

export interface BrowserTaskResult {
  summary: string;
  finalUrl: string;
  finalTitle: string;
  steps: string[];
  stopped: boolean;
}

interface BrowserSession {
  id: string;
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  buffer: { event: string; data: unknown }[];
  stopped: boolean;
  context: BrowserContext | null;
  resolveAsk: ((text: string) => void) | null;
  askReject: ((err: Error) => void) | null;
  /** 外部订阅者（聊天 SSE 流转发）：浏览器过程事件（screenshot/thinking/action/ask/done/error）同步推送 */
  subscriber?: ((event: string, data: unknown) => void) | null;
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const enc = new TextEncoder();

/**
 * BrowserAgentService：浏览器 computer-use 单例。
 * 同时服务「手动入口（/api/browser/session）」与「自主 control_browser 工具」。
 * 同一时刻串行执行一个任务（共享 profile 目录）。
 */
export class BrowserAgentService {
  private static instance: BrowserAgentService | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly profileDir: string;
  private sessions = new Map<string, BrowserSession>();
  /** 下一个任务的聊天流订阅者：control_browser 工具经 canUseTool 拦截时设置，
   *  run() 创建会话后自动挂到该会话，浏览器过程事件同步转发进聊天 SSE。 */
  private pendingSubscriber: ((event: string, data: unknown) => void) | null = null;

  private constructor() {
    this.profileDir = defaultProfileDir();
    try {
      mkdirSync(this.profileDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  static get(): BrowserAgentService {
    if (!BrowserAgentService.instance) BrowserAgentService.instance = new BrowserAgentService();
    return BrowserAgentService.instance;
  }

  /** 注册下一个任务的聊天流订阅者（canUseTool 拦截 control_browser 时调用） */
  setPendingSubscriber(cb: (event: string, data: unknown) => void): void {
    this.pendingSubscriber = cb;
  }

  /** 启动一个浏览器任务（异步执行），立即返回会话 id 与完成 Promise。
   *  headless 模式无可见窗口；过程事件经 subscriber 转发进聊天 thinking 展示。 */
  run(task: string, maxSteps?: number, notify = true): { id: string; done: Promise<BrowserTaskResult> } {
    const id = `ba-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: BrowserSession = {
      id,
      controller: null,
      buffer: [],
      stopped: false,
      context: null,
      resolveAsk: null,
      askReject: null,
      subscriber: this.pendingSubscriber,
    };
    this.pendingSubscriber = null; // 只绑定一次
    this.sessions.set(id, session);
    const done = this.queue.then(() => this.doRun(task, maxSteps, session));
    this.queue = done.then(() => undefined, () => undefined);
    if (notify) {
      try {
        process.stdout.write(`BROWSER_SESSION_START ${id}\n`);
      } catch {
        /* ignore */
      }
    }
    return { id, done };
  }

  /** 自主工具调用入口：返回最终结论（headless 无弹窗；过程事件进聊天 thinking） */
  runTask(task: string, maxSteps?: number): Promise<BrowserTaskResult> {
    return this.run(task, maxSteps, true).done;
  }

  /** 把已存在的会话 SSE 流挂到某个控制面板（手动入口或自主模式自动弹窗都走这里） */
  attach(id: string): ReadableStream<Uint8Array> {
    const session = this.sessions.get(id);
    // NodeReadableStream（node:stream/web）与全局 ReadableStream（undici-types）类型存在
    // NonSharedArrayBufferView 细节差异；两者运行时等价，这里做类型收窄。
    return new NodeReadableStream<Uint8Array>({
      start: (controller) => {
        if (!session) {
          controller.enqueue(enc.encode(sseFrame("error", { text: "session 不存在或已结束" })));
          controller.close();
          return;
        }
        if (session.controller) {
          controller.enqueue(enc.encode(sseFrame("error", { text: "该 session 已被其他面板连接" })));
          controller.close();
          return;
        }
        session.controller = controller;
        // 回放已发生的事件（自主模式下面板可能晚于任务启动打开）
        let terminal = false;
        for (const ev of session.buffer) {
          if (ev.event === "finished" || ev.event === "stopped" || ev.event === "error") terminal = true;
          try {
            controller.enqueue(enc.encode(sseFrame(ev.event, ev.data)));
          } catch {
            /* ignore */
          }
        }
        if (terminal) {
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        }
      },
    }) as unknown as ReadableStream<Uint8Array>;
  }

  input(id: string, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s || !s.resolveAsk) return false;
    const resolve = s.resolveAsk;
    s.resolveAsk = null;
    s.askReject = null;
    resolve(text || "");
    return true;
  }

  stop(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.stopped = true;
    if (s.askReject) {
      s.askReject(new Error("已急停"));
      s.askReject = null;
      s.resolveAsk = null;
    }
    void s.context?.close().catch(() => undefined);
    return true;
  }

  private async doRun(task: string, maxSteps: number | undefined, session: BrowserSession): Promise<BrowserTaskResult> {
    const hosts = allowedHosts();
    const emit = (event: string, data: unknown) => {
      // 聊天流订阅者（control_browser 经 canUseTool 挂上的）：事件带会话 id，前端据此
      // 定位 thinking 中的浏览器步骤、渲染截图/动作，并在 ask 时回传人工答案。
      if (session.subscriber) {
        try {
          session.subscriber(event, { id: session.id, ...(data as Record<string, unknown>) });
        } catch {
          /* 订阅者异常不影响浏览器任务 */
        }
      }
      session.buffer.push({ event, data });
      if (session.buffer.length > 120) session.buffer.shift();
      if (session.controller) {
        try {
          session.controller.enqueue(enc.encode(sseFrame(event, data)));
        } catch {
          /* 客户端断开，忽略 */
        }
      } else if (event === "thinking" || event === "action" || event === "done" || event === "error") {
        console.log(`[browser-agent ${session.id} ${event}] ${JSON.stringify(data).slice(0, 200)}`);
      }
    };

    const cdpPort = await findFreePort();
    const context = await chromium.launchPersistentContext(this.profileDir, {
      // 无头模式：不弹独立浏览器窗口；过程截图经 subscriber 转发进聊天 thinking 展示
      headless: true,
      viewport: { ...VIEWPORT },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      // 远程调试端口：暴露 CDP，前端右侧边栏借此把"用户点击截图"转发进同一个浏览器，
      // 实现内嵌预览可点击、且与 AI 操控同一实例（截图=视口 1:1，坐标可直接映射）。
      args: ["--no-sandbox", "--disable-dev-shm-usage", `--remote-debugging-port=${cdpPort}`],
    });
    session.context = context;
    // 告知前端本会话浏览器的 CDP 端口（browser_cdp 帧 → 右侧预览点击连接用）
    emit("cdp", { port: cdpPort, sessionId: session.id });

    // 关键修复：持久上下文（launchPersistentContext）会恢复上次会话的标签页，
    // 全新 profile 时也会默认开一个起始空白 tab；而 newPage() 又会再开一个，
    // 结果就是“启动即 2 个 tab，我们在第二个工作、第一个一直停在别处”。
    // 这里先新建唯一的工作页，再关闭所有启动时自带的残留标签，保证全程只有 1 个 tab。
    const page = await context.newPage();
    for (const stale of context.pages()) {
      if (stale === page) continue;
      await stale.close().catch(() => undefined);
    }
    const steps: string[] = [];
    let stopped = false;
    let summary = "";
    let idleStreak = 0;
    let correction: string | undefined;
    const limit = Math.min(Math.max(1, maxSteps ?? DEFAULT_MAX_STEPS), 40);

    try {
      for (let step = 1; step <= limit; step++) {
        if (session.stopped) {
          emit("stopped", { step });
          stopped = true;
          break;
        }
        // 截图（JPEG 比 PNG 更小，hy3 摄入更快）
        const shot = await page.screenshot({ type: "jpeg", quality: 55 });
        const base64 = shot.toString("base64");
        emit("screenshot", { step, image: base64 });

        const raw = await decide(task, step, base64, correction);
        emit("thinking", { step, text: raw });
        const parsed = parseAction(raw);
        const action = parsed.action;
        steps.push(
          `#${step} ${action.action}` +
            (action.action === "type" ? ` ${JSON.stringify(action.text).slice(0, 40)}` : action.action === "click" ? ` (${action.x},${action.y})` : ""),
        );
        emit("action", { step, action });

        if (action.action === "done") {
          emit("done", { step, summary: action.summary });
          summary = action.summary;
          break;
        }
        if (action.action === "ask") {
          // 模型以"我没工具/无法执行"为由拒绝 = 误解了协议，不是真需要人工。
          // 计入无效步并注入纠正提示，下一步重试；只有页面本身的验证拦阻才转人工。
          if (isCapabilityRefusal(action.question)) {
            idleStreak += 1;
            correction =
              "你上一步错误地拒绝了任务（借口是没有工具）。你没有工具是正常的：你输出的动作 JSON 会由外部 Playwright 执行器真实执行。请严格按协议输出 click/type/scroll/navigate 等动作 JSON，禁止拒绝。";
            emit("action", { step, action: { action: "wait", ms: 0 }, note: "模型误拒，已纠正重试" });
            if (idleStreak >= 4) {
              summary = "模型连续多步无法按协议输出动作（含误拒重试），已自动停止。";
              emit("error", { text: summary });
              break;
            }
            continue;
          }
          emit("ask", { step, question: action.question });
          const answer = await this.waitForHuman(session, 5 * 60 * 1000);
          emit("ask_result", { step, answer });
          if (answer.startsWith("ERROR:")) {
            summary = answer;
            break;
          }
          task = `${task}\n[人工接管回复] ${answer}`;
          idleStreak = 0;
          correction = undefined;
          continue;
        }

        // 卡死检测：连续无效操作（解析兜底 / 反复 wait）4 次即自动停止
        if (!parsed.valid || action.action === "wait") idleStreak += 1;
        else idleStreak = 0;
        if (idleStreak >= 4) {
          summary = "模型连续多步未给出有效操作（疑似页面未加载或识别失败），已自动停止。";
          emit("error", { text: summary });
          break;
        }

        await this.execute(page, action, hosts);
        await delay(250); // 等页面稳定（原 600ms，已缩短）
        correction = undefined; // 有效动作执行成功，清除纠正提示
      }
      if (!summary && !stopped) summary = "任务在步数上限内未完成，已自动结束。";
    } catch (err) {
      summary = `浏览器操作失败：${err instanceof Error ? err.message : String(err)}`;
      emit("error", { text: summary });
    } finally {
      const finalUrl = page.url() || "";
      const finalTitle = await page.title().catch(() => "");
      await context.close().catch(() => undefined);
      this.sessions.delete(session.id);
      emit("finished", { id: session.id });
      return { summary, finalUrl, finalTitle, steps, stopped };
    }
  }

  private async waitForHuman(session: BrowserSession, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      session.resolveAsk = resolve;
      session.askReject = reject;
      const t = setTimeout(() => reject(new Error("人工接管超时（5 分钟）")), timeoutMs);
      const orig = session.resolveAsk;
      const wrapped = (v: string) => {
        clearTimeout(t);
        session.resolveAsk = null;
        session.askReject = null;
        orig?.(v);
      };
      session.resolveAsk = wrapped;
    }).catch((err) => {
      session.resolveAsk = null;
      session.askReject = null;
      return `ERROR:${err instanceof Error ? err.message : String(err)}`;
    });
  }

  private async execute(page: Page, action: BrowserAction, hosts: string[]): Promise<void> {
    switch (action.action) {
      case "click":
        await page.mouse.click(clamp(action.x, VIEWPORT.width), clamp(action.y, VIEWPORT.height));
        break;
      case "type":
        await page.keyboard.type(action.text);
        break;
      case "scroll": {
        const dy = (action.direction === "up" ? -1 : 1) * (action.amount ?? 600);
        await page.mouse.wheel(0, dy);
        break;
      }
      case "navigate":
        if (!hostAllowed(action.url, hosts)) {
          throw new Error(`目标域名不在白名单：${action.url}`);
        }
        await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
        break;
      case "wait":
        await delay(action.ms ?? 1500);
        break;
      default:
        break;
    }
  }
}

/** 每次调用创建独立 McpServer 实例（绝不共享）：agent-sdk 每个 query 的 transport 都会对
 *  传入实例调用 server.connect()，而 MCP Protocol 实例只允许 connect 一次；共享实例在并发
 *  或先后复用时抛 "Already connected to a transport"。薄壳开销可忽略（BrowserAgentService 为单例）。 */
export function createBrowserAgentMcpServer(): SdkMcpServerResult {
  const service = BrowserAgentService.get();
  return createSdkMcpServer({
    name: "browser-agent",
    version: "1.0.0",
    tools: [
      tool(
        "control_browser",
        "用 AI 自主控制浏览器去完成「必须在网页上真正交互操作」才能完成的任务：在页面上点击、输入文字、填写并提交表单、登录账号，或需要多步导航才能拿到的信息（例如：在搜索引擎搜某词并取结果、登录后查某信息、在网页表单填写并提交）。本工具会启动一个无头浏览器，模型截图并逐步自动操作（不弹出独立窗口），最终返回任务结果摘要、最终页面 URL/标题与操作步数，过程截图会实时展示在对话思考步骤中。重要边界：如果任务只是「读取 / 显示 / 展示某个网页或文章的内容（含图片）」，不要用本工具——那是 web-fetch 的 fetch_webpage 的职责（更快更稳、专为只读抓取设计）。control_browser 仅用于需要「动」网页（点击、输入、填表、登录等交互）才能达成的目标。",
        {
          task: z.string().describe("要达成的浏览器操作目标，用自然语言描述，例如：打开 https://www.baidu.com ，搜索「北京天气」，返回第一条结果的标题"),
          max_steps: z
            .number()
            .int()
            .min(1)
            .max(40)
            .optional()
            .describe("最大操作步数，默认 25；复杂任务可调大到 40"),
        },
        async ({ task, max_steps }) => {
          try {
            const result = await service.runTask(task, max_steps);
            console.log(
              `[agent-kit browser-agent] 任务完成 summary=${result.summary.slice(0, 120)} 步数=${result.steps.length} finalUrl=${result.finalUrl}`,
            );
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    summary: result.summary,
                    finalUrl: result.finalUrl,
                    finalTitle: result.finalTitle,
                    steps: result.steps,
                  }),
                },
              ],
            };
          } catch (err) {
            console.error(`[agent-kit browser-agent] 执行失败:`, err instanceof Error ? err.stack || err.message : err);
            return {
              content: [
                { type: "text" as const, text: `浏览器操作失败：${err instanceof Error ? err.message : String(err)}` },
              ],
            };
          }
        },
      ),
    ],
  });
}

/** 工具在模型上下文中暴露的名称（server 名连字符转下划线） */
export const BROWSER_AGENT_TOOL_NAME = "mcp__browser_agent__control_browser";
