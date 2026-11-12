/**
 * models.json 里自定义的模型（带 url 的，例如本机 ollama / lmstudio）：
 * 直接按 OpenAI 兼容协议调用，**不经过 CodeBuddy CLI**。
 *
 * 为什么必须直连：
 * CLI 收到 image content block 后会先把 base64 落到 `~/.codebuddy/blobs/<sha>.png`，
 * 再让模型用 ViewImage 工具去读。知识库这里是「禁用工具、单轮」的场景，
 * 模型拿不到工具就只能编一段 `tool_calls:...ViewImage` 文本，或者整轮报错
 * （界面上表现为「服务暂时不可用，请联系管理员」）。
 * 自定义模型自带 url / apiKey，直连反而更简单，也不会被 CLI 的插件初始化拖慢。
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { APP_HOME_DIR } from "../app-name.js";

export interface CustomModelEntry {
  id: string;
  name?: string;
  url: string;
  apiKey?: string;
  maxOutputTokens?: number;
  supportsImages?: boolean;
}

/** 与 agent-kit 的 resolveModelsFile 同口径：AGENT_MODELS_PATH 优先，其次应用主目录
 *  `~/.linger/models.json`。 */
function modelsFile(): string | null {
  const specified = process.env.AGENT_MODELS_PATH?.trim();
  const candidates = [
    ...(specified ? [specified.endsWith(".json") ? specified : path.join(specified, "models.json")] : []),
    path.join(APP_HOME_DIR, "models.json"),
  ];
  return candidates.find(file => fs.existsSync(file)) ?? null;
}

/**
 * 按 id 找自定义模型。只有**同时有 id 和合法 url** 的条目才算，
 * 因为这类模型才支持我们直连；原生模型（走订阅登录态）不在这里。
 */
export function findCustomModel(id: string | undefined): CustomModelEntry | null {
  const wanted = id?.trim();
  if (!wanted) return null;
  const file = modelsFile();
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return null;
    for (const raw of parsed.models) {
      const entry = raw as Record<string, unknown> | null;
      if (!entry || typeof entry.id !== "string" || entry.id !== wanted) continue;
      if (typeof entry.url !== "string" || !entry.url.trim()) return null;
      try { new URL(entry.url); } catch { return null; }
      return {
        id: entry.id,
        name: typeof entry.name === "string" ? entry.name : undefined,
        url: entry.url.trim(),
        apiKey: typeof entry.apiKey === "string" && entry.apiKey.trim() ? entry.apiKey.trim() : undefined,
        maxOutputTokens: typeof entry.maxOutputTokens === "number" ? entry.maxOutputTokens : undefined,
        supportsImages: entry.supportsImages === true,
      };
    }
  } catch { /* 配置损坏 = 没有自定义模型 */ }
  return null;
}

/**
 * models.json 里的 url 有的写到 `/v1`，有的直接写 `/v1/chat/completions`。
 * 与 CLI 的「ensured /chat/completions」保持一致。
 */
export function chatCompletionsUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  if (/\/v\d+$/i.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

interface HttpResponse { status: number; text: string }

/**
 * 用 node:http(s) 发请求，而不是 fetch：
 * Electron 主进程的 fetch 会走系统代理，本机 127.0.0.1 的 ollama 一旦配了 HTTP_PROXY 就会被转走。
 */
function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let target: URL;
    try { target = new URL(url); } catch { reject(new Error(`模型地址无效：${url}`)); return; }
    const lib = target.protocol === "https:" ? https : http;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });
    if (signal?.aborted) controller.abort();

    const request = lib.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => finish(undefined, { status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", error => finish(error));
    });

    let settled = false;
    const timer = setTimeout(() => {
      request.destroy(new Error(`模型响应超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    const finish = (error: Error | undefined, value?: HttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
      controller.signal.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(value!);
    };
    const onAbort = () => request.destroy(new Error("图片描述已取消"));
    controller.signal.addEventListener("abort", onAbort, { once: true });

    request.on("error", error => finish(error));
    request.write(body);
    request.end();
  });
}

/**
 * 直连自定义模型做一次「文本 + 图片」对话。
 * @returns 模型输出的正文（不含 reasoning）
 */
export async function chatWithImage(
  model: CustomModelEntry,
  systemPrompt: string,
  userPrompt: string,
  image: { buffer: Buffer; mediaType: string },
  signal?: AbortSignal,
): Promise<string> {
  const dataUrl = `data:${image.mediaType};base64,${image.buffer.toString("base64")}`;
  const body = JSON.stringify({
    model: model.id,
    // 描述任务不需要发散
    temperature: 0.2,
    // reasoning 模型（如 gemma4）会先产出一大段思考，给小了正文会被截断成空
    max_tokens: Math.min(Math.max(model.maxOutputTokens ?? 4096, 1024), 8192),
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;

  const { status, text } = await postJson(chatCompletionsUrl(model.url), headers, body, signal, 300_000);
  if (status >= 400) {
    // 把服务端原文带出来，别再让上层只剩一句「服务暂时不可用」
    throw new Error(`模型接口返回 HTTP ${status}：${text.slice(0, 300)}`);
  }
  let parsed: {
    choices?: Array<{ message?: { content?: unknown; reasoning?: unknown }; finish_reason?: string }>;
    error?: { message?: unknown };
  };
  try { parsed = JSON.parse(text); } catch { throw new Error(`模型接口返回了非 JSON 内容：${text.slice(0, 200)}`); }
  if (parsed.error?.message) throw new Error(`模型接口报错：${String(parsed.error.message).slice(0, 300)}`);

  const choice = parsed.choices?.[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
  if (content) return content;
  // 正文为空：reasoning 模型被 max_tokens 截断是最常见的原因，如实报出来
  const reasoning = typeof choice?.message?.reasoning === "string" ? choice.message.reasoning : "";
  throw new Error(
    reasoning
      ? `模型只输出了思考过程就被截断（finish_reason=${choice?.finish_reason ?? "unknown"}），未生成描述`
      : `模型未返回内容（finish_reason=${choice?.finish_reason ?? "unknown"}）`,
  );
}
