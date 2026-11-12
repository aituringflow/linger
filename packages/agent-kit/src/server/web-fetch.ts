/**
 * agent-kit · web-fetch MCP 工具（方案B：真实浏览器抓取，正文 + 图片）
 *
 * 背景：CodeBuddy 内置网页抓取工具能渲染正文，但内容清洗管线会剥离 <img>；
 * 而今日头条等反爬站图片 CDN 对冷 HTTP 请求一律 403，图片必须在页面会话内抓取。
 *
 * 本模块用 Playwright 持久浏览器上下文（launchPersistentContext）实现：
 *   - 真实 Chromium 执行页面 JS（自动过 __ac_signature 类签名挑战）；
 *   - 图片在页面上下文内 fetch（携带会话），绕开图片 CDN 403；
 *   - 持久 userDataDir 复用登录态/会话，降低反复建连开销。
 *
 * 对外暴露一个 MCP 工具：fetch_webpage(url, maxImages?, maxBytesPerImage?, maxTextChars?)
 * 返回：{ title, text, images: [{ url, mediaType, bytes, base64 }] }
 */

import { chromium, type BrowserContext, type Page } from "playwright";
import { z } from "zod";
import {
  createSdkMcpServer,
  tool,
  type SdkMcpServerResult,
} from "@tencent-ai/agent-sdk";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// tsconfig lib 不含 DOM：page.evaluate 回调内的 DOM 全局显式声明为 any
declare const document: any;
declare const window: any;

/**
 * 持久浏览器用户数据目录（保留会话 cookie）。
 * 解析顺序：1) 环境变量 WEB_FETCH_PROFILE_DIR；2) monorepo 仓库根/.web-fetch-profile
 * （由本文件位置上溯 4 级定位到仓库根）；3) 兜底当前工作目录。
 * 统一固定位置，避免各进程（agent-kit CLI / web Next.js）各自散落一份。
 */
function defaultProfileDir(): string {
  if (process.env.WEB_FETCH_PROFILE_DIR?.trim()) {
    return path.resolve(process.env.WEB_FETCH_PROFILE_DIR.trim());
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, "..", "..", "..", "..");
    return path.join(repoRoot, ".web-fetch-profile");
  } catch {
    return path.join(process.cwd(), ".web-fetch-profile");
  }
}

export interface WebFetchOptions {
  /** 最大返回图片数（0 = 不抓图），默认 3 */
  maxImages?: number;
  /** 正文最大字符数，默认 60000 */
  maxTextChars?: number;
  /** 图片缩放阈值（字节），默认 1MB。超过该大小的图片在送入模型前本地缩放（不再整张跳过） */
  maxBytesPerImage?: number;
  /** 页面渲染等待上限（ms），默认 25s */
  navigationTimeoutMs?: number;
  /** 持久上下文 userDataDir（默认 <cwd>/.web-fetch-profile） */
  profileDir?: string;
  /** 是否无头模式，默认 true */
  headless?: boolean;
}

export interface WebFetchImage {
  url: string;
  mediaType: string;
  bytes: number;
  base64: string;
}

export interface WebFetchResult {
  url: string;
  title: string;
  text: string;
  images: WebFetchImage[];
  imageSkipped: number;
  imageDownscaled: number;
  truncated: boolean;
}

/** 是否头条系图片 URL（仅用于头条页图片去重范围；普通页面取 article 内全部图片） */
export function isMediaUrl(u: string): boolean {
  return (
    u.startsWith("http") &&
    /\.(jpe?g|png|webp|gif)([?#]|$)/i.test(u) ||
    /toutiaoimg\.com|byteimg\.com|toutiaostatic\.com/.test(u)
  );
}

/**
 * 页面内收集真实图片 URL（处理懒加载 data-src / currentSrc / background-image）。
 * 注意：以字符串（IIFE 表达式）形式传给 page.evaluate —— tsx/esbuild 会把回调
 * 转换成带模块级 __name helper 的形式，浏览器上下文无该 helper 会 ReferenceError；
 * 而裸箭头函数字符串会被 evaluate 当作表达式求值（返回函数对象，不执行），
 * 因此必须写成立即执行的 IIFE。
 */
const COLLECT_IMAGES_JS = `(() => {
  const seen = new Set();
  const add = (u) => { if (u && u.startsWith("http")) seen.add(u); };
  const scope = document.querySelector("article") || document.querySelector(".article-content") || document.body;
  const nodes = scope ? scope.querySelectorAll("img, [data-src], [style]") : [];
  for (const el of Array.from(nodes)) {
    add(el.currentSrc || el.src || "");
    add((el.dataset && el.dataset.src) || el.getAttribute("data-src") || "");
    const bg = (el.style && el.style.backgroundImage) || "";
    const m = bg.match(/url\\(['"]?([^'")]+)['"]?\\)/);
    if (m) add(m[1]);
  }
  return [...seen];
})()`;

export function collectImageUrls(page: Page): Promise<string[]> {
  return page.evaluate(COLLECT_IMAGES_JS);
}

/** 由 URL 扩展名 + 文件魔数推断图片 media type */
function sniffMediaType(url: string, buf: Buffer): string {
  const ext = (url.match(/\.(jpe?g|png|webp|gif)([?#]|$)/i) || [])[1]?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext && ext.startsWith("jpe")) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46)
    return "image/webp";
  return "image/jpeg";
}

/** 单图超过该体积（25MB）视为异常，安全跳过以防 OOM；其余一律下载并缩放。 */
const SAFETY_MAX_IMAGE_BYTES = 25 * 1024 * 1024;

/**
 * 用页面内 canvas 把原图缩放：最长边不超过 maxEdge，重编码为 jpeg（白底，兼容透明 png）。
 * 复用已存在的 Playwright 页面，无需引入图像处理原生依赖；data: URL 同源、不会污染 canvas。
 */
async function downscaleImage(page: Page, buf: Buffer, maxEdge = 1280, quality = 0.82): Promise<Buffer> {
  const mime = sniffMediaType("", buf); // 仅用于 data URL 前缀，内部会重新编码为 jpeg
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
  const out = await page.evaluate(
    async ({ dataUrl, maxEdge, quality }: { dataUrl: string; maxEdge: number; quality: number }) => {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("image decode failed"));
        img.src = dataUrl;
      });
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", quality);
    },
    { dataUrl, maxEdge, quality },
  );
  return Buffer.from(out.split(",")[1], "base64");
}

/** 滚动触发懒加载（IIFE 字符串形式） */
const SCROLL_JS = `(async () => {
  for (let i = 0; i < 6; i++) {
    window.scrollBy(0, 900);
    await new Promise((r) => setTimeout(r, 250));
  }
  window.scrollTo(0, 0);
})()`;

/** 提取正文（IIFE 字符串形式，参数内联） */
function extractTextJs(maxLen: number): string {
  return `((maxLen) => {
    const article = document.querySelector("article") || document.querySelector(".article-content");
    const raw = article ? article.innerText : document.body.innerText;
    return { raw: raw.slice(0, maxLen), truncated: raw.length > maxLen };
  })(${maxLen})`;
}

/**
 * WebFetchService：单例浏览器（持久上下文），串行处理请求。
 * 浏览器实例跨请求复用；每个请求独立 page，处理完即关。
 */
export class WebFetchService {
  private static instance: WebFetchService | null = null;
  private contextPromise: Promise<BrowserContext> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly opts: Required<Pick<WebFetchOptions, "maxImages" | "maxTextChars" | "maxBytesPerImage" | "navigationTimeoutMs" | "profileDir" | "headless">>;

  private constructor(opts: WebFetchOptions = {}) {
    this.opts = {
      maxImages: opts.maxImages ?? 50,
      maxTextChars: opts.maxTextChars ?? 60000,
      maxBytesPerImage: opts.maxBytesPerImage ?? 1 * 1024 * 1024,
      navigationTimeoutMs: opts.navigationTimeoutMs ?? 25_000,
      profileDir: opts.profileDir ?? defaultProfileDir(),
      headless: opts.headless ?? true,
    };
    try {
      mkdirSync(this.opts.profileDir, { recursive: true });
    } catch {
      /* 目录已存在等情况忽略 */
    }
  }

  static get(opts?: WebFetchOptions): WebFetchService {
    if (!WebFetchService.instance) WebFetchService.instance = new WebFetchService(opts);
    return WebFetchService.instance;
  }

  private context(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.contextPromise = chromium
        .launchPersistentContext(this.opts.profileDir, {
          headless: this.opts.headless,
          viewport: { width: 1280, height: 900 },
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        })
        .catch((err) => {
          this.contextPromise = null;
          throw new Error(`浏览器启动失败：${err instanceof Error ? err.message : err}`);
        });
    }
    return this.contextPromise;
  }

  /** 串行执行（同一浏览器上下文同一时刻只跑一个请求） */
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.then(() => undefined, () => undefined);
    return p;
  }

  /** 抓取单个网页：正文 + 图片（base64） */
  fetchWebpage(url: string, opts: WebFetchOptions = {}): Promise<WebFetchResult> {
    return this.run(() => this.doFetch(url, opts));
  }

  private async doFetch(url: string, opts: WebFetchOptions): Promise<WebFetchResult> {
    const maxImages = opts.maxImages ?? this.opts.maxImages;
    const maxTextChars = opts.maxTextChars ?? this.opts.maxTextChars;
    const maxBytes = opts.maxBytesPerImage ?? this.opts.maxBytesPerImage;
    const navTimeout = opts.navigationTimeoutMs ?? this.opts.navigationTimeoutMs;

    const context = await this.context();
    const page = await context.newPage();
    // 页面图片真实加载的响应体（走浏览器网络栈，绕开冷请求 403 与跨域 CORS）
    const imageBodies = new Map<string, Buffer>();
    const onResponse = (resp: import("playwright").Response) => {
      if (resp.request().resourceType() !== "image") return;
      const u = resp.url();
      if (!isMediaUrl(u)) return;
      resp
        .body()
        .then((b) => {
          if (b.length <= SAFETY_MAX_IMAGE_BYTES) imageBodies.set(u, b);
        })
        .catch(() => undefined);
    };
    page.on("response", onResponse);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: navTimeout });
      // 头条等页面先出签名挑战 JS、随后 reload 渲染正文：等待 article 出现
      try {
        await page.waitForSelector("article, .article-content", { timeout: 20_000 });
      } catch {
        /* 非文章页：不阻塞，走 body 提取 */
      }
      // 滚动触发懒加载
      try {
        await page.evaluate(SCROLL_JS);
      } catch {
        /* 忽略 */
      }
      // 再等图片加载落定
      await new Promise((r) => setTimeout(r, 800));

      const title = await page.title().catch(() => "");
      let text = "";
      let truncated = false;
      try {
        const out = (await page.evaluate(extractTextJs(maxTextChars))) as
          | { raw?: string; truncated?: boolean }
          | null
          | undefined;
        text = out?.raw ?? "";
        truncated = !!out?.truncated;
      } catch {
        /* 页面结构异常时 text 保持空 */
      }

      let imageSkipped = 0;
      let imageDownscaled = 0;
      const images: WebFetchImage[] = [];
      if (maxImages > 0) {
        let urls = await collectImageUrls(page).catch(() => []);
        urls = [...new Set(urls)].filter(isMediaUrl);
        for (const u of urls) {
          if (images.length >= maxImages) {
            imageSkipped += urls.length - images.length;
            break;
          }
          // 1) 响应监听缓存；2) 兜底：共享会话 cookie 的 Node 侧请求
          let buf = imageBodies.get(u) ?? null;
          if (!buf) {
            try {
              const r = await context.request.get(u);
              if (r.ok()) buf = Buffer.from(await r.body());
            } catch {
              buf = null;
            }
          }
          if (!buf || buf.length === 0) {
            imageSkipped += 1;
            continue;
          }
          // 超过安全上限的异常大图直接跳过，防 OOM；其余一律保留（不再整张丢弃）。
          if (buf.length > SAFETY_MAX_IMAGE_BYTES) {
            imageSkipped += 1;
            continue;
          }
          // 超过缩放阈值的原图在送入模型前本地缩放（最长边 1280px、重编码 jpeg），
          // 既不让模型漏看图片，也避免大图撑爆多模态 token 预算。
          if (buf.length > maxBytes) {
            try {
              buf = await downscaleImage(page, buf);
              imageDownscaled += 1;
            } catch {
              /* 缩放失败则保留原图，交给模型自行处理 */
            }
          }
          images.push({
            url: u,
            mediaType: sniffMediaType(u, buf),
            bytes: buf.length,
            base64: buf.toString("base64"),
          });
        }
      }

      return {
        url,
        title: title.replace(/\s*-\s*今日头条\s*$/, "").trim(),
        text,
        images,
        imageSkipped,
        imageDownscaled,
        truncated,
      };
    } finally {
      page.removeListener("response", onResponse);
      await page.close().catch(() => undefined);
    }
  }

  /** 释放浏览器（进程退出时调用） */
  async close(): Promise<void> {
    if (this.contextPromise) {
      const ctx = await this.contextPromise.catch(() => null);
      if (ctx) await ctx.close().catch(() => undefined);
      this.contextPromise = null;
    }
  }
}

/** 每次调用创建独立 McpServer 实例（绝不共享）：agent-sdk 每个 query 的 transport 都会对
 *  传入实例调用 server.connect()，而 MCP Protocol 实例只允许 connect 一次；共享实例在并发
 *  或先后复用时抛 "Already connected to a transport"。薄壳开销可忽略（WebFetchService 为单例）。 */
export function createWebFetchMcpServer(opts?: WebFetchOptions): SdkMcpServerResult {
  const service = WebFetchService.get(opts);
  return createSdkMcpServer({
    name: "web-fetch",
    version: "1.0.0",
    tools: [
      tool(
        "fetch_webpage",
        "只读抓取并展示一个网页的完整内容：返回页面标题、正文文本，以及页面内图片的 base64 数据（可直接内联到回复或 HTML 中展示）。用真实浏览器（Playwright 持久上下文）渲染，能处理 JS 动态渲染与反爬签名校验页面（如今日头条），图片在页面会话内获取（冷请求会被 CDN 拒绝 403）。这是「只读展示网页内容」的标准工具——当用户要求「查看 / 显示 / 读取 / 翻译 / 总结某篇文章或网页的内容（含图片）」时，应优先使用本工具，而不是去「操作」浏览器。适合新闻文章、博客、帖子等文章型页面。",
        {
          url: z.string().describe("要抓取的网页完整 URL（https://）"),
          maxImages: z
            .number()
            .int()
            .min(0)
            .max(200)
            .optional()
            .describe("最多返回图片数，默认 50；0 表示不抓图片"),
          maxBytesPerImage: z
            .number()
            .int()
            .min(0)
            .max(25 * 1024 * 1024)
            .optional()
            .describe("图片缩放阈值（字节），默认 1MB；超过该大小的图片在送入模型前本地缩放，不再整张跳过"),
          maxTextChars: z
            .number()
            .int()
            .min(0)
            .max(100000)
            .optional()
            .describe("正文最大字符数，默认 60000"),
        },
        async ({ url, maxImages, maxBytesPerImage, maxTextChars }) => {
          try {
            const result = await service.fetchWebpage(url, { maxImages, maxBytesPerImage, maxTextChars });
            const totalBytes = result.images.reduce((s, i) => s + (i.bytes || 0), 0);
            console.log(
              `[agent-kit web-fetch] 抓取成功 url=${url} 正文=${result.text.length}字 图片=${result.images.length}张 图片字节=${totalBytes}${result.imageDownscaled ? ` (${result.imageDownscaled}张大图已缩放)` : ""}${result.imageSkipped ? ` (${result.imageSkipped}张跳过)` : ""}${result.truncated ? " (正文截断)" : ""}`,
            );
            const summary = {
              url: result.url,
              title: result.title,
              text: result.text,
              images: result.images.map((i) => ({
                url: i.url,
                mediaType: i.mediaType,
                bytes: i.bytes,
                base64: i.base64,
              })),
              imageSkipped: result.imageSkipped,
              imageDownscaled: result.imageDownscaled,
              truncated: result.truncated,
            };
            return { content: [{ type: "text" as const, text: JSON.stringify(summary) }] };
          } catch (err) {
            console.error(`[agent-kit web-fetch] 抓取失败 url=${url}:`, err instanceof Error ? err.stack || err.message : err);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `抓取失败：${err instanceof Error ? err.message : String(err)}`,
                },
              ],
            };
          }
        },
      ),
    ],
  });
}
