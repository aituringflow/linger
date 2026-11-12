/**
 * 图片多模态描述：调用配置的 LLM（如 hy3）对图片进行描述，
 * 并对 OCR 结果进行纠错，生成干净的文字片段用于 embedding。
 */
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { createAgentStream, collectAgentText, getAgentAdapter, getDefaultModel, isModelSelectEnabled } from "@turingflow/agent-kit";
import { query } from "@tencent-ai/agent-sdk";
import { FRAMEWORK_LABELS, knowledgeRoot, readKnowledgeSettings, type KnowledgeFramework } from "./settings.js";
import { chatWithImage, findCustomModel } from "./custom-model.js";
import { APP_HOME_DIR } from "../app-name.js";

export interface ImageDescriptionResult {
  /** 最终用于文字片段的内容（模型描述，或回退的 OCR 原文） */
  description: string;
  /** OCR 原始结果 */
  ocr: string;
  /** model = 大模型生成；fallback = 模型不可用/失败，保留 OCR 原文 */
  source: "model" | "fallback";
  /** 实际使用的模型名，便于在片段上标注来源 */
  model?: string;
  /** 回退原因，用于如实告知用户 */
  error?: string;
}

/**
 * 图片描述用的模型，与 launcher /chat 同口径：
 * - 默认交给 SDK 用订阅登录态 + 默认模型（hy3，实测支持 base64 图片），**不需要 models.json**；
 * - 只有用户配了带 url 的自定义模型、或用 AGENT_KB_IMAGE_MODEL 显式指定时才指定 model；
 * - 自定义模型需要把 CODEBUDDY_CONFIG_DIR 指向 models.json 所在目录，CLI 才读得到那份配置。
 * 绝不能无条件把 CODEBUDDY_CONFIG_DIR 指到 ~/.linger：那会让 CLI 丢掉 ~/.codebuddy 的登录态，
 * 表现为「模型没有返回内容」并静默回退 OCR。
 */
interface ImageModelConfig { model?: string }

const containsToolCall = (text: string) => /<\/?(?:tool_calls?|tool_call|parameter)(?:\s|:|>)/i.test(text);

/**
 * 兜底清理：部分模型偶尔仍会夹带 Markdown 标记。这里把最常见的几种去掉，
 * 保证落库与展示的图片描述是纯文本（不出现 **、#、- 等符号）。
 * 只处理「模型生成」的结果；OCR 回退原文不动。
 */
function stripMarkdown(text: string): string {
  return text
    .replace(/```/g, "")                       // 代码围栏
    .replace(/`([^`]+)`/g, "$1")               // 行内代码
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")        // 标题 #
    .replace(/^\s*[-*+]\s+/gm, "")             // 列表符号（- * +，含「* 加粗」里的星号）
    .replace(/\*\*([^*]+)\*\*/g, "$1")         // 加粗 **
    .replace(/__([^_]+)__/g, "$1")             // 加粗 __
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // 链接 [text](url) → text
    .trim();
}

/** 某些模型需要 ViewImage 工具才能读取图片；只允许读取本次的临时副本。 */
async function describeWithImageTool(image: Buffer, prompt: string, config: ImageModelConfig, signal?: AbortSignal, settingsRoot?: string): Promise<string> {
  const tempRoot = path.join(knowledgeRoot(settingsRoot), "tmp");
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, "image-"));
  const imagePath = path.join(directory, "image.png");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 120_000);
  let viewed = false;
  let succeeded = false;
  let callId = "";
  let answer = "";
  let error = "";
  try {
    await fs.writeFile(imagePath, image, { mode: 0o600 });
    for await (const message of query({
      prompt: `请先使用 ViewImage 读取这张图片，仅读取一次：${imagePath}\n\n${prompt}`,
      options: {
        model: config.model, executable: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NO_PROXY: localNoProxy(), no_proxy: localNoProxy() },
        tools: ["ViewImage"], allowedTools: ["ViewImage"], permissionMode: "bypassPermissions",
        maxTurns: 7, continue: false, persistSession: false, thinking: { type: "disabled" }, abortController: controller,
        hooks: { PreToolUse: [{ matcher: "ViewImage", hooks: [async input => {
          if (input.hook_event_name !== "PreToolUse" || (input.tool_input as { image_path?: unknown })?.image_path !== imagePath || viewed) {
            return { continue: false, decision: "block", reason: "只允许读取当前图片一次" };
          }
          viewed = true;
          return { continue: true };
        }] }] },
      },
    })) {
      if (message.type === "assistant") {
        const texts: string[] = [];
        for (const block of message.message.content) {
          if (block.type === "text") texts.push(block.text);
          if (block.type === "tool_use" && block.name === "ViewImage") callId = block.id;
        }
        if (texts.length) answer = texts.join("\n");
      } else if (message.type === "user" && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) if (block.type === "tool_result" && block.tool_use_id === callId) {
          if (block.is_error) error = "识图工具无法读取图片";
          else succeeded = true;
        }
      } else if (message.type === "result") {
        if (message.subtype !== "success") error = message.errors?.join("；") || `模型调用失败：${message.subtype}`;
        else if (typeof message.result === "string" && message.result.trim()) answer = message.result;
      }
    }
    if (controller.signal.aborted) throw new Error(signal?.aborted ? "图片描述已取消" : "图片描述超时");
    if (error) throw new Error(error);
    if (!viewed || !succeeded) throw new Error("模型未成功读取图片");
    if (!answer.trim() || containsToolCall(answer)) throw new Error("模型未返回有效的图片描述");
    return answer.trim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * 未显式指定模型时，SDK 会在 kit 的 normalizeConfig 里兜底成
 * 「模型选择开启 → AGENT_MODEL 或 hy3；关闭 → getDefaultModel()」。
 * 这里复刻同一口径，**只用于展示**，不写进 config —— 传了 model 就从「默认」变成「显式指定」，
 * 会和 CLI 自己的登录态选模逻辑打架。
 */
function defaultImageModelLabel(): string {
  try {
    return isModelSelectEnabled() ? (process.env.AGENT_MODEL?.trim() || "hy3") : getDefaultModel();
  } catch {
    return "hy3";
  }
}

/**
 * 本地模型（ollama / lmstudio 等）必须绕过系统代理。
 * 机器上如果有 HTTP_PROXY 而 NO_PROXY 不含 127.0.0.1，CLI 请求本地端点会被代理转走并长时间挂起。
 */
function localNoProxy(): string {
  const entries = [process.env.NO_PROXY, process.env.no_proxy, "127.0.0.1", "localhost"]
    .filter((value): value is string => Boolean(value && value.trim()))
    .flatMap(value => value.split(","))
    .map(value => value.trim())
    .filter(Boolean);
  return [...new Set(entries)].join(",");
}

function resolveImageModel(): ImageModelConfig {
  const explicit = process.env.AGENT_KB_IMAGE_MODEL?.trim();
  if (explicit) return { model: explicit };

  const file = modelsFilePath();
  if (!file) return {};
  try {
    const parsed = JSON.parse(fssync.readFileSync(file, "utf8")) as { models?: Array<{ id?: string; url?: string }> };
    const selected = parsed.models?.find(entry => entry?.id && typeof entry.url === "string" && entry.url);
    if (selected?.id && selected.url) {
      new URL(selected.url); // 非法 url 视为没有配置
      return { model: selected.id };
    }
  } catch { /* 配置损坏 → 走 SDK 默认 */ }
  return {};
}

/** models.json 的候选位置：AGENT_MODELS_PATH 优先，其次应用主目录 `~/.linger/models.json`，
 *  未配置时读 `~/.linger/models.json`。 */
function modelsFilePath(): string | null {
  const configured = process.env.AGENT_MODELS_PATH?.trim();
  const candidates = [
    ...(configured ? [configured.endsWith(".json") ? configured : path.join(configured, "models.json")] : []),
    path.join(APP_HOME_DIR, "models.json"),
  ];
  return candidates.find(candidate => fssync.existsSync(candidate)) ?? null;
}

/** 自定义模型（models.json）由 CLI 自己从应用主目录 `~/.linger/models.json` 读取，不需要额外配置目录。 */


/**
 * 模型展示名。自定义模型（models.json）标成「自定义 · 名字」而不是「WorkBuddy · id」——
 * 那些模型的数据根本不经过 WorkBuddy 服务，标错会让排障时找错方向。
 */
function modelLabel(modelId: string | undefined, framework: KnowledgeFramework): string {
  if (!modelId) return defaultImageModelLabel();
  const custom = findCustomModel(modelId);
  if (custom) return `自定义 · ${custom.name || custom.id}`;
  return `${FRAMEWORK_LABELS[framework]} · ${modelId}`;
}

/**
 * 本次会用哪个模型生成图片描述，与 describeImage 内部口径完全一致。
 * 供索引器在「开始识别前」就把模型名展示出来，不用等结果返回。
 */
export function describeModelName(settingsRoot?: string): string {
  const selected = readKnowledgeSettings(settingsRoot).imageModel;
  if (selected) return modelLabel(selected.model, selected.framework);
  return modelLabel(resolveImageModel().model, "codebuddy");
}

/**
 * Codex 分支：把图片落到临时目录，用 local_image 输入交给 Codex CLI。
 * 与 CodeBuddy 不同，Codex 的图片是「路径输入」而不是 base64 content block。
 */
async function describeWithCodex(
  image: Buffer,
  mediaType: string,
  systemPrompt: string,
  userPrompt: string,
  model: string,
  signal?: AbortSignal,
  settingsRoot?: string,
): Promise<string> {
  const tempRoot = path.join(knowledgeRoot(settingsRoot), "tmp");
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, "image-"));
  const imagePath = path.join(directory, `image${mediaType === "image/jpeg" ? ".jpg" : ".png"}`);
  try {
    await fs.writeFile(imagePath, image, { mode: 0o600 });
    const stream = getAgentAdapter("codex").stream({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      signal: signal ?? new AbortController().signal,
      config: {
        codexModelKey: model,
        attachmentPath: imagePath,
        sessionId: undefined,
        resume: false,
        maxTurns: 1,
        disableTools: true,
        webFetch: false,
        browserAgent: false,
      },
    });
    return (await collectAgentText(stream)).trim();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * 对单张图片进行多模态描述，结合 OCR 结果纠错。
 * @param imagePath 图片文件路径
 * @param ocrResult OCR 识别的原始文字（可能有错误）
 * @param signal 取消信号
 * @param settingsRoot 知识库根目录（读 settings.json 里的图片识别模型选择）
 */
export async function describeImage(
  imagePath: string,
  ocrResult: string,
  signal?: AbortSignal,
  settingsRoot?: string,
): Promise<ImageDescriptionResult> {
  const ocr = ocrResult?.trim() || "";

  // 读取图片并转 base64
  const imageBuffer = await fs.readFile(imagePath);
  const base64 = imageBuffer.toString("base64");
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png";

  // 设置里选过就用它；没选则按兜底顺序（AGENT_KB_IMAGE_MODEL / models.json 首条 / SDK 默认）
  // 注意：自定义模型的 url/apiKey 在应用主目录 models.json 里（~/.linger/models.json），CLI 自己会读，
  // 绝不能为此改 CODEBUDDY_CONFIG_DIR —— 那会丢掉 ~/.codebuddy 的登录态，请求直接卡死。
  const selected = readKnowledgeSettings(settingsRoot).imageModel;
  const imageModel: ImageModelConfig = selected
    ? { model: selected.model }
    : resolveImageModel();
  // 落库时记的模型名：框架 + 模型，界面上能直接看出是谁识别的
  const modelName = modelLabel(imageModel.model, selected?.framework ?? "codebuddy");

  const systemPrompt = `你是一个专业的图片内容描述助手。请直接观察整张图片，生成适合知识库检索的准确描述：
1. 描述图片的主题、场景、主要人物或物体、它们之间的关系，以及有助于理解的布局和视觉细节。
2. 识别并保留图片中的关键文字，例如标题、名称、标语、日期和重要数据；文字较多时重点保留与图片含义相关的内容。
3. 如果图片包含表格或图表，说明其类型、主题、行列关系和关键数据。
4. OCR 结果只是辅助参考，可能有误或遗漏；以图片实际内容为准，纠正明显错误，不要照搬无意义的识别碎片。无法辨认的内容不要猜测。
5. 输出连贯、具体的图片描述，既包含视觉内容，也包含关键文字；不要只输出 OCR 文字。只呈现核对后的内容，不要提及 OCR、识别错误、原始错误文字或修正过程，也不要添加解释、注释或前后缀。
6. 图片已作为本次输入提供，请直接观察图片，不要请求或模拟调用任何工具；如果无法看清图片，请如实说明。
7. 仅输出纯文本，不要使用任何 Markdown 语法：不要出现 # 标题、**加粗**、- 或 * 列表、代码块、链接等标记。用自然段落和换行来分隔不同方面即可。`;

  const userPrompt = ocr
    ? `请描述整张图片的内容和关键视觉信息，并根据图片核对以下 OCR 结果，避免遗漏重要文字：

OCR 原始结果：
"""
${ocr}
"""

请输出完整的图片描述：`
    : `请描述整张图片的主题、视觉内容和关键文字；如有表格或图表，也请说明其关键信息：`;

  // Codex 走自己的 CLI（图片以 local_image 路径传入），与 CodeBuddy 的 base64 content block 不同
  if (selected?.framework === "codex") {
    try {
      const description = (await describeWithCodex(imageBuffer, mediaType, systemPrompt, userPrompt, selected.model, signal, settingsRoot)).trim();
      if (!description) {
        return { description: ocr, ocr, source: "fallback", model: modelName, error: `模型未返回描述（${modelName}），保留 OCR 原文` };
      }
      if (containsToolCall(description)) {
        return { description: ocr, ocr, source: "fallback", model: modelName, error: "模型未返回有效的图片描述，保留 OCR 原文" };
      }
      console.log(`[knowledge] 图片描述完成：${modelName} · ${description.length} 字`);
      return { description: stripMarkdown(description), ocr, source: "model", model: modelName };
    } catch (error) {
      if (signal?.aborted) throw error;
      console.error("[knowledge] Codex 图片描述失败，回退 OCR 原文：", error);
      return { description: ocr, ocr, source: "fallback", model: modelName, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // 自定义模型（models.json 里带 url 的，例如本机 ollama）：直连 OpenAI 兼容接口。
  // 走 CLI 会先把 base64 图片落成 ~/.codebuddy/blobs 文件再让模型调 ViewImage，
  // 而这里是「禁用工具、单轮」的场景，必然失败（表现为「服务暂时不可用，请联系管理员」）。
  const custom = findCustomModel(imageModel.model);
  if (custom) {
    // 明确声明不支持图片的模型不必浪费一次请求，直接说清楚要改哪
    if (custom.supportsImages === false) {
      return { description: ocr, ocr, source: "fallback", model: modelName, error: `所选模型未支持图片（models.json 里 supportsImages=false），请换一个视觉模型` };
    }
    try {
      const description = (await chatWithImage(custom, systemPrompt, userPrompt, { buffer: imageBuffer, mediaType }, signal)).trim();
      if (!description) {
        return { description: ocr, ocr, source: "fallback", model: modelName, error: `模型未返回描述（${modelName}），保留 OCR 原文` };
      }
      if (containsToolCall(description)) {
        return { description: ocr, ocr, source: "fallback", model: modelName, error: "模型未返回有效的图片描述，保留 OCR 原文" };
      }
      console.log(`[knowledge] 图片描述完成（直连 ${custom.id}）· ${description.length} 字`);
      return { description: stripMarkdown(description), ocr, source: "model", model: modelName };
    } catch (error) {
      if (signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      console.error("[knowledge] 图片描述失败（直连自定义模型）：", reason);
      return { description: ocr, ocr, source: "fallback", model: modelName, error: reason };
    }
  }

  try {
    const stream = createAgentStream({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt, images: [{ base64, media_type: mediaType as "image/png" | "image/jpeg" }] },
      ] as any,
      signal: signal ?? new AbortController().signal,
      config: {
        model: imageModel.model,
        sessionId: undefined,
        resume: false,
        continueSession: false,
        maxTurns: 1,
        disableTools: true,
        allowedTools: [],
        webFetch: false,
        browserAgent: false,
        cliExecutable: process.execPath,
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          // 本地自定义模型（ollama 等）直连，别被系统代理转走
          NO_PROXY: localNoProxy(),
          no_proxy: localNoProxy(),
        },
      } as any,
    });

    let description = (await collectAgentText(stream)).trim();
    if (!description) {
      return { description: ocr, ocr, source: "fallback", model: modelName, error: `模型未返回描述（${modelName}），保留 OCR 原文` };
    }
    // 有些模型会把工具调用序列化为普通文本，即使工具已禁用；这不是图片描述。
    if (containsToolCall(description)) {
      description = await describeWithImageTool(imageBuffer, `${systemPrompt.replace("图片已作为本次输入提供，请直接观察图片，不要请求或模拟调用任何工具；如果无法看清图片，请如实说明。", "读取图片后直接描述；如果无法看清，请如实说明。") }\n\n${userPrompt}`, imageModel, signal, settingsRoot);
    }
    console.log(`[knowledge] 图片描述完成：${modelName} · ${description.length} 字`);
    return { description: stripMarkdown(description), ocr, source: "model", model: modelName };
  } catch (error) {
    // 窗口关闭 / 暂停索引导致的取消要向上抛，让文件保持 indexing 以便恢复后重跑，
    // 不能降级成「OCR 回退」把中间态当成最终结果。
    if (signal?.aborted) throw error;
    console.error("[knowledge] 图片描述调用失败，回退 OCR 原文：", error);
    // kit 对失败一律抛同一句兜底文案，这里补上「去哪看真实原因」，否则用户只看到「联系管理员」
    const raw = error instanceof Error ? error.message : String(error);
    const reason = raw.includes("服务暂时不可用") ? `${raw.trim()}（模型调用失败，真实原因见 ${path.join(APP_HOME_DIR, "logs")}）` : raw;
    // 带上 model：界面上要能看出「尝试用哪个模型失败了」，而不是只知道失败
    return { description: ocr, ocr, source: "fallback", model: modelName, error: reason };
  }
}
