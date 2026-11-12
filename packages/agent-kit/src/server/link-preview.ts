/**
 * GET /api/link-preview?url=...：用户消息里的链接预览卡（unfurl，Telegram 式）。
 *
 * 设计口径：
 *  - 轻量抓取：直接 fetch + 解析 meta 标签，不走 Playwright（web-fetch.ts 是给正文抓取用的，太重）；
 *    超时 4s、最多跟 3 跳重定向、最多读 256KB（meta 永远在文档前部，够用）。
 *  - 解析 og:title / og:description / og:image / og:site_name，缺则回退 twitter:* / <title> / description / favicon。
 *  - SSRF 防护：只收 http/https；localhost 及 .local/.internal/.lan、私网 IPv4 段、IPv6 回环/ULA/链路本地
 *    一律拒绝；hostname 还要做 DNS 解析复核（防「域名指向内网 IP」绕过）；重定向每一跳重新校验。
 *  - 内存缓存：成功 6h、失败 10min、上限 500 条（Map 按插入序淘汰最旧）；并发同 URL 去重。
 *  - 抓不到（非 HTML / 超时 / 无任何可展示字段）→ 404 no_preview，前端静默不渲染卡片，
 *    行内链接本身不受影响——卡片只是增强，不是关键路径。
 */
import { lookup } from "node:dns/promises";
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import { slog } from "./debug-log.js";

export interface LinkPreview {
  /** 重定向后的最终 URL（卡片点击落点用它，比原始 URL 更可信） */
  url: string;
  siteName: string;
  title: string;
  description: string;
  imageUrl: string;
  faviconUrl: string;
}

const FETCH_TIMEOUT_MS = 6_000;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const CACHE_TTL_OK = 6 * 60 * 60 * 1000;
const CACHE_TTL_FAIL = 10 * 60 * 1000;
const CACHE_CAP = 500;

/** JS 壳页（MSN / SPA）静态 HTML 里没有任何可展示字段，需要无头浏览器渲染后再取。
 *  复用 playwright（web-fetch 同款二进制）；串行执行防内存尖峰（pro 只有 ~2GB）。
 *  AGENT_LINK_PREVIEW_RENDER=0 可整体关掉（浏览器未安装时也会静默失败，不影响行内链接）。 */
const RENDER_TIMEOUT_MS = 12_000;
let renderChain: Promise<unknown> = Promise.resolve();

const cache = new Map<string, { expires: number; value: LinkPreview | null }>();
const pending = new Map<string, Promise<LinkPreview | null>>();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------------- SSRF 防护 ----------------

function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 / 云厂商 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** hostname 字面量层拦截（DNS 解析层的复核在 resolvesToPrivate） */
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.+$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isPrivateIPv4(v4.slice(1).map(Number));
  if (h.includes(":")) return true; // IPv6 字面量一律不抓（回环/ULA/链路本地都在内，公网 v6 损失可接受）
  return false;
}

/** 已知 fake-IP 段（Clash/Surge 类代理 TUN 模式的默认取值）：
 *  这类环境里所有域名都解析成 198.18.0.0/15 或 fdfe:dcba:9876::/48 的假 IP、再由 TUN 按域名转发，
 *  不能据此判定「指向内网」，否则开着代理的机器会全站误拦。 */
function isFakeIp(address: string): boolean {
  if (/^198\.1[89]\./.test(address)) return true; // 198.18.0.0/15
  return /^fdfe:dcba:9876:/i.test(address);
}

/** 域名解析复核：任一解析结果落在私网/回环即拒绝（防域名指向内网 IP 的绕过）。
 *  解析失败交给 fetch 报错；fake-IP 段豁免（见 isFakeIp）。 */
async function resolvesToPrivate(hostname: string): Promise<boolean> {
  try {
    const addrs = await lookup(hostname, { all: true, verbatim: true });
    return addrs.some(({ address }) => {
      if (isFakeIp(address)) return false;
      if (address.includes(":")) {
        return /^(::1|::|f[cd][0-9a-f]{0,4}:|fe[89ab][0-9a-f]{0,4}:)/i.test(address);
      }
      return isPrivateIPv4(address.split(".").map(Number));
    });
  } catch {
    return false;
  }
}

// ---------------- 抓取 ----------------

/** 手动逐跳跟随重定向（自动 follow 无法在中间跳校验私网），最多 MAX_REDIRECTS 跳。 */
async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string } | null> {
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return null;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (isBlockedHost(u.hostname) || (await resolvesToPrivate(u.hostname))) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(u, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" },
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("location");
      if (!loc) return null;
      try {
        current = new URL(loc, u).toString();
      } catch {
        return null;
      }
      continue;
    }
    if (!resp.ok) return null;
    const ctype = resp.headers.get("content-type") || "";
    if (ctype && !/text\/html|application\/xhtml/i.test(ctype)) return null;
    const reader = resp.body?.getReader();
    if (!reader) return null;
    const dec = new TextDecoder();
    let html = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (html.length >= MAX_HTML_BYTES) {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
    return { html, finalUrl: current };
  }
  return null;
}

// ---------------- 解析 ----------------

function safeFromCode(code: number): string {
  try {
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  } catch {
    return "";
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCode(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** 提取全部 meta 标签为 key(lower) → content 映射（同名取第一个） */
function extractMeta(html: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /<meta\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const attr = (name: string): string => {
      const r = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
      return r ? decodeEntities(r[1] ?? r[2] ?? r[3] ?? "").trim() : "";
    };
    const key = (attr("property") || attr("name")).toLowerCase();
    if (key && map[key] === undefined) map[key] = attr("content");
  }
  return map;
}

function clean(s: string | undefined, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 相对地址补全；只放行 http(s)（防 data: 之类混进 <img>） */
function absUrl(raw: string | undefined, base: string): string {
  const v = String(raw ?? "").trim();
  if (!v || /^data:/i.test(v)) return "";
  try {
    const u = new URL(v, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
}

function extractFavicon(html: string, base: string): string {
  const re = /<link\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const rel = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const relValue = rel ? (rel[1] ?? rel[2] ?? rel[3] ?? "") : "";
    if (!/\bicon\b/i.test(relValue)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const resolved = absUrl(href ? (href[1] ?? href[2] ?? href[3] ?? "") : "", base);
    if (resolved) return resolved;
  }
  return absUrl("/favicon.ico", base) || "";
}

/** 抓取并解析单个 URL（缓存层之下的一跳；导出供宿主/脚本复用与自测） */
export async function fetchPreview(url: string): Promise<LinkPreview | null> {
  try {
    const page = await fetchHtml(url);
    if (!page) return null;
    const meta = extractMeta(page.html);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(page.html);
    let finalUrl = page.finalUrl;
    let title = clean(
      meta["og:title"] || meta["twitter:title"] || decodeEntities(titleMatch?.[1] ?? ""),
      200,
    );
    let description = clean(meta["og:description"] || meta["twitter:description"] || meta["description"], 300);
    let siteName = clean(meta["og:site_name"], 100);
    let imageUrl = absUrl(
      meta["og:image"] || meta["og:image:url"] || meta["og:image:secure_url"] || meta["twitter:image"] || meta["twitter:image:src"],
      finalUrl,
    );
    let faviconUrl = extractFavicon(page.html, finalUrl);

    // JS 壳页兜底：静态抓取拿不到标题或描述时，用无头浏览器渲染后再取一遍
    //（MSN / SPA 的正文全在客户端渲染，静态 HTML 只有 <title>MSN</title> 这种壳）。
    if (!title || !description) {
      const rendered = await renderPage(url);
      if (rendered) {
        finalUrl = rendered.finalUrl || finalUrl;
        title = title || clean(rendered.meta["og:title"] || rendered.title, 200);
        if (!description) {
          description = clean(rendered.meta["og:description"] || rendered.meta["description"] || rendered.text, 300);
        }
        siteName = siteName || clean(rendered.meta["og:site_name"], 100);
        imageUrl = imageUrl || absUrl(rendered.meta["og:image"] || rendered.meta["twitter:image"], finalUrl);
        faviconUrl = faviconUrl || absUrl(rendered.favicon || "/favicon.ico", finalUrl);
      }
    }

    if (!title && !description) return null; // 没有任何可展示的字段，不硬凑卡片
    slog("link-preview", "fetched", { url: finalUrl, hasTitle: !!title, hasDesc: !!description, hasImage: !!imageUrl }, "info");
    return { url: finalUrl, siteName, title, description, imageUrl, faviconUrl };
  } catch (err) {
    slog("link-preview", "fetch_failed", { url, error: err instanceof Error ? err.message : String(err) }, "warn");
    return null;
  }
}

interface RenderedPage {
  title: string;
  meta: Record<string, string>;
  text: string;
  favicon: string;
  finalUrl: string;
}

/** 无头浏览器渲染取 meta/正文（playwright 动态引入，串行执行）。失败一律 null，不抛出。 */
export async function renderPage(url: string): Promise<RenderedPage | null> {
  if (process.env.AGENT_LINK_PREVIEW_RENDER === "0") return null;
  const run = renderChain.then(
    () => doRender(url),
    () => doRender(url),
  );
  renderChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// evaluate 必须传 IIFE 字符串：esbuild 会把回调转成带模块级 __name helper 的形式，
// 浏览器上下文没有该 helper 会 ReferenceError（web-fetch.ts 同款坑）。
const RENDER_EXTRACT_JS = `(() => {
  const meta = {};
  for (const el of document.querySelectorAll("meta")) {
    const key = (el.getAttribute("property") || el.getAttribute("name") || "").toLowerCase();
    const content = el.getAttribute("content") || "";
    if (key && content && meta[key] === undefined) meta[key] = content;
  }
  let text = "";
  for (const p of document.querySelectorAll("article p, main p, [role=main] p, p")) {
    const t = (p.innerText || "").trim();
    if (t.length > 24) text += (text ? " " : "") + t;
    if (text.length >= 300) break;
  }
  const icon = document.querySelector('link[rel~="icon"]');
  return {
    title: document.title || "",
    meta,
    text: text.slice(0, 300),
    favicon: icon ? icon.href : "",
  };
})()`;

async function doRender(url: string): Promise<RenderedPage | null> {
  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ userAgent: UA, viewport: { width: 1280, height: 800 } });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: RENDER_TIMEOUT_MS });
    // 富 JS 页（MSN）首屏数据是异步拉的：先等网络安静，超时就算了
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    const data = (await page.evaluate(RENDER_EXTRACT_JS)) as {
      title?: string;
      meta?: Record<string, string>;
      text?: string;
      favicon?: string;
    };
    return {
      title: String(data?.title ?? ""),
      meta: data?.meta ?? {},
      text: String(data?.text ?? ""),
      favicon: String(data?.favicon ?? ""),
      finalUrl: page.url(),
    };
  } catch {
    return null; // 浏览器未安装 / 页面崩溃 / 超时：静默降级，卡片只是少点信息
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export function createLinkPreviewHandler() {
  async function GET(request: Request): Promise<Response> {
    const user = verifySession(request, loadAuthConfig());
    if (!user?.sub) return Response.json({ error: "请先登录" }, { status: 401 });
    const raw = new URL(request.url).searchParams.get("url") || "";
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return Response.json({ error: "invalid_url" }, { status: 400 });
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return Response.json({ error: "invalid_protocol" }, { status: 400 });
    }
    const key = target.toString();
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.value
        ? Response.json(hit.value)
        : Response.json({ error: "no_preview" }, { status: 404 });
    }
    // 并发去重：同一 URL 的在途请求共享同一个 Promise
    let inflight = pending.get(key);
    if (!inflight) {
      inflight = fetchPreview(key).finally(() => pending.delete(key));
      pending.set(key, inflight);
    }
    const value = await inflight;
    cache.set(key, { expires: Date.now() + (value ? CACHE_TTL_OK : CACHE_TTL_FAIL), value });
    if (cache.size > CACHE_CAP) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    if (!value) return Response.json({ error: "no_preview" }, { status: 404 });
    return Response.json(value);
  }
  return { GET };
}
