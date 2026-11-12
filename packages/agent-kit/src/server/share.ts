/**
 * agent-kit · 会话分享 API（外部只读访问 + 发送到 OA）
 *
 * 路由接线（宿主 app，basePath=/agent）：
 *   // app/api/share/route.js          -> POST 创建分享链接（登录态）
 *   // app/api/share/jsapi-sign/route.js -> POST 返回钉钉/飞书 H5 JSAPI 前端鉴权参数（登录态）
 *   // app/api/share/[token]/route.js  -> GET 公开只读页（自包含 HTML，无需登录）
 *   //                                  -> POST 发送到 OA 会话（登录态，仅创建者可发）
 *
 * 设计要点：
 *   - 分享链接不可枚举（token 为 24 字节随机 hex），公开页只读、不渲染产物内容；
 *   - 「发送到 OA」：钉钉走 chooseConversationByCorpId 一次性 cid + message/send_to_conversation，
 *     飞书走 chooseChat open_chat_id + im/v1/messages（见 oa.ts）；
 *   - 钉钉 JSAPI 鉴权需要 agentId（企业内部应用微应用 ID，env DD_AGENT_ID）。
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import { parseSessionKey } from "./auth/session.js";
import {
  getAgentSession,
  getShareByToken,
  createShareRecord,
  createShare,
  canAccessFile,
  getFileById,
  getSessionTitleBySessionId,
  listAgentMessagesPublic,
  getUserCodeByKey,
  getUserOauthTokenByKey,
  updateUserOauthToken,
  isDbEnabled,
  getPool,
  ensureMigrated,
  revokeAgentMessage,
  type ShareRow,
} from "./auth/db.js";
import {
  dingTalkJsapiConfig,
  resolveDingTalkUserIdByUnionId,
  sendDingTalkMessage,
  feishuJsapiConfig,
  sendFeishuMessage,
  sendFeishuMessageAsUser,
  refreshFeishuUserToken,
} from "./oa.js";
import { renderMarkdownHtml } from "./render-markdown.js";
import { AI_DISPLAY_NAME } from "./names.js";
import { readFile, recordFileToStore, deleteStoredFile } from "./file-store.js";
import { readArtifact } from "./artifacts.js";

/**
 * 生成分享卡片用的聊天摘要：最近 5 条非空消息，每条一行「我/AI：内容」。
 * 与 view() 同一清洗口径：assistant 剥离限流提示、user 剥离附件首行。
 */
async function buildChatSummary(sessionId: string): Promise<string> {
  const messages = await listAgentMessagesPublic(sessionId);
  const lines: string[] = [];
  for (const m of messages) {
    const raw = String(m.content || "").trim();
    if (!raw) continue;
    const clean = m.role === "assistant" ? stripRateLimitText(raw) : m.attachment ? stripAttachmentLine(raw) : raw;
    if (!clean.trim()) continue;
    lines.push(`${m.role === "assistant" ? "AI" : "我"}：${clean.trim().slice(0, 60)}`);
    if (lines.length >= 5) break;
  }
  return lines.join("\n");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 解析对外 origin：优先 env（APP_PUBLIC_URL），否则用请求头（x-forwarded-host / host）推断。
 *  注意：不能依赖 `new URL(request.url).origin`——反代/Next dev 场景下 request.url 的 host
 *  可能是代理内部地址（如 localhost），导致分享链接 host 错误；请求头才是用户实际访问的地址。 */
function publicOrigin(request: Request): string {
  const cfg = loadAuthConfig();
  if (cfg.publicUrl) return cfg.publicUrl;
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (host) return `${proto}://${host}`;
  try {
    return new URL(request.url).origin;
  } catch {
    return `${proto}://localhost`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 以下两个清洗函数与 ui/AgentWindow.tsx 保持一致（分享页渲染与聊天区域看齐）：
// - 用户消息：剥离消息开头的 "[附件] 文件名" 行（附件已在气泡上方独立展示）；
// - 助手消息：剥离 CLI transcript 的 trace 前缀、丢弃 429 限流错误整段。
function stripAttachmentLine(content: string): string {
  return String(content).replace(/^\[附件\] [^\n]*\n?/, "");
}

function stripRateLimitText(text?: string | null): string {
  if (!text) return text || "";
  const out = [];
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      out.push("");
      continue;
    }
    // trace 前缀：形如 (32hex/uuid) 开头的行，剥离前缀保留正文
    const rest = line.replace(/^\(\s*[0-9a-fA-F]{8,}\s*\/\s*[0-9a-fA-F-]{8,}[^)\n]*\)\s*/, "");
    if (/429/.test(rest) && /频率限制|rate\s*[- ]?limit/i.test(rest)) continue;
    if (!rest.trim()) continue;
    out.push(rest.replace(/429[^\n]*?频率限制[^\n]*$/i, ""));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface ShareHandlers {
  create: { POST: (request: Request) => Promise<Response> };
  jsapiSign: { POST: (request: Request) => Promise<Response> };
  view: { GET: (request: Request, ctx: unknown) => Promise<Response> };
  send: { POST: (request: Request, ctx: unknown) => Promise<Response> };
  chat: { POST: (request: Request) => Promise<Response>; GET: (request: Request, token: string) => Promise<Response> };
}

export function createShareHandlers(sendToChat?: (request: Request, sessionId: string) => Promise<Response>): ShareHandlers {
  const cfg = loadAuthConfig();

  async function currentUser(request: Request): Promise<{ userId: string; provider: string } | null> {
    const user = verifySession(request, cfg);
    if (!user || !user.sub) return null;
    return { userId: user.sub, provider: user.provider || cfg.method || "" };
  }

  /** 文件级分享只读页：按 mime 内联预览（图片/文本/markdown）或提供下载；套用同一套黑白灰风格。 */
  async function renderFileSharePage(share: ShareRow, request: Request): Promise<Response> {
    const data = await readFile(share.scopeId, null, share.token);
    if (!data) return new Response("文件不存在或已失效", { status: 404 });
    const fileName = data.name || "file";
    const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
    const mime = data.mime || "application/octet-stream";
    const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) || mime.startsWith("image/");
    const isText =
      ["txt", "md", "markdown", "json", "csv", "css", "js", "ts", "tsx", "jsx", "py", "xml", "yaml", "yml", "toml", "log"].includes(ext) ||
      mime.startsWith("text/");
    const isPdf = ext === "pdf" || mime === "application/pdf";
    const isHtml = ext === "html" || ext === "htm" || mime === "text/html";

    const origin = publicOrigin(request);
    const cookiePath = cfg.cookiePath.replace(/\/+$/, "");
    const fileUrl = `${origin}${cookiePath}/api/file?fileId=${encodeURIComponent(share.scopeId)}&token=${encodeURIComponent(share.token)}`;

    let body = "";
    if (isImage) {
      const b64 = data.buf.toString("base64");
      body = `<div class="file-preview"><img src="data:${mime};base64,${b64}" alt="${escapeHtml(fileName)}"></div>`;
    } else if (isText) {
      const text = data.buf.toString("utf8");
      let inner: string;
      if (ext === "md" || ext === "markdown") {
        inner = (await renderMarkdownHtml(text)) || escapeHtml(text).split("\n").join("<br>");
      } else {
        inner = `<pre>${escapeHtml(text)}</pre>`;
      }
      body = `<div class="file-preview">${inner}</div>`;
    } else if (isPdf) {
      body = `<div class="file-preview"><iframe src="${escapeHtml(fileUrl)}" title="${escapeHtml(fileName)}"></iframe></div>`;
    } else if (isHtml) {
      // HTML 预览沙箱化，与产物预览一致
      body = `<div class="file-preview"><iframe src="${escapeHtml(fileUrl)}" sandbox title="${escapeHtml(fileName)}"></iframe></div>`;
    }
    const download = `<div class="share-foot"><a class="dl" href="${escapeHtml(fileUrl)}" download="${escapeHtml(fileName)}">下载文件（${escapeHtml(fileName)}，约 ${(data.size / 1024).toFixed(1)} KB）</a></div>`;

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(fileName)} · 文件分享</title>
<style>
  :root { --bg:#f4f6fb; --ink:#1f2733; --ink-soft:#5b6573; --line:#e3e8f0; --brand:#2f6bff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .share-wrap { min-height:100vh; display:flex; flex-direction:column; }
  .share-head { width:100%; max-width:900px; margin:0 auto; padding:22px 26px 10px 18px; border-bottom:1px solid var(--line); }
  .share-head h1 { margin:0; font-size:17px; font-weight:700; }
  .share-head p { margin:5px 0 0; font-size:12px; color:var(--ink-soft); }
  .file-preview { width:100%; max-width:900px; margin:18px auto; padding:0 18px; }
  .file-preview img { max-width:100%; border-radius:8px; }
  .file-preview pre { white-space:pre-wrap; word-break:break-word; background:#0f172a; color:#e2e8f0; border-radius:10px; padding:14px; overflow-x:auto; font-size:12.5px; }
  .file-preview iframe { width:100%; height:70vh; border:1px solid var(--line); border-radius:10px; background:#fff; }
  .share-foot { width:100%; max-width:900px; margin:0 auto; padding:8px 26px 26px 18px; text-align:center; font-size:13px; color:var(--ink-soft); }
  .dl { color:var(--brand); text-decoration:none; border-bottom:1px solid rgba(47,107,255,.35); }
</style>
</head>
<body>
<div class="share-wrap">
  <div class="share-head">
    <h1>${escapeHtml(fileName)}</h1>
    <p>文件分享 · ${escapeHtml(mime)} · ${(data.size / 1024).toFixed(1)} KB</p>
  </div>
  ${body || ""}
  ${download}
  <div class="share-foot">内容由分享者通过 AI 助手生成，仅供查看</div>
</div>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  /** POST /api/share：创建分享链接（双粒度）。
   *  默认 session 级（兼容旧行为）；传 scope='file' + scopeId=fileId 走文件级分享。 */
  async function create(request: Request): Promise<Response> {
    const user = await currentUser(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!isDbEnabled()) return json({ error: "database_unavailable" }, 503);
    const body = (await request.json().catch(() => ({}))) as {
      sessionId?: unknown;
      scope?: unknown;
      scopeId?: unknown;
      permission?: unknown;
      granteeSub?: unknown;
      expiresAt?: unknown;
    };
    const scope: "session" | "file" = body.scope === "file" ? "file" : "session";
    let sessionId = "";
    let scopeId = "";

    if (scope === "session") {
      sessionId = typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "";
      if (!sessionId) return json({ error: "missing_session_id" }, 400);
      // 会话必须归属当前用户
      const session = await getAgentSession(user.userId, sessionId);
      if (!session) return json({ error: "not_found" }, 404);
      scopeId = sessionId;
    } else {
      scopeId = typeof body.scopeId === "string" && body.scopeId ? body.scopeId : "";
      if (!scopeId) return json({ error: "missing_scope_id" }, 400);
      // 文件必须属于当前用户或可访问（防越权分享他人文件）
      const can = await canAccessFile(scopeId, user.userId);
      if (!can) return json({ error: "not_found" }, 404);
    }

    const permission = body.permission === "comment" || body.permission === "edit" || body.permission === "view" ? body.permission : "view";
    const granteeSub = typeof body.granteeSub === "string" && body.granteeSub ? body.granteeSub : null;
    let expiresAt: Date | null = null;
    if (typeof body.expiresAt === "string" && body.expiresAt) {
      const d = new Date(body.expiresAt);
      if (!Number.isNaN(d.getTime())) expiresAt = d;
    }

    const token = randomBytes(24).toString("hex");
    const ok = await createShare({
      token,
      scopeType: scope,
      scopeId,
      sessionId: scope === "session" ? sessionId : null,
      createdBy: user.userId,
      permission,
      granteeSub,
      expiresAt,
    });
    if (!ok) return json({ error: "share_create_failed" }, 500);

    const origin = publicOrigin(request);
    const url = `${origin}${cfg.cookiePath.replace(/\/+$/, "")}/api/share/${token}`;
    const sessionTitle = scope === "session" ? (await getSessionTitleBySessionId(sessionId)) || "AI 对话" : "文件";
    // 文件级分享：标题取文件名
    const fileTitle = scope === "file" ? (await getFileById(scopeId))?.name ?? "文件" : "";
    const title = scope === "session" ? `AI 对话分享：${sessionTitle}` : `文件分享：${fileTitle}`;
    // 聊天摘要：最近 5 条非空消息（与飞书分享卡片同口径），供钉钉原生分享面板的正文使用
    const summary = scope === "session" ? await buildChatSummary(sessionId) : `分享文件：${fileTitle}`;
    return json({
      url,
      token,
      scope,
      provider: user.provider,
      // 分享卡片（用户身份发送）展示用：标题 / 正文 / 聊天摘要 / 跳转链接
      title,
      text: scope === "session" ? `来自「${sessionTitle}」的 AI 对话，点击查看完整内容。` : `分享文件：${fileTitle}`,
      summary,
      // 钉钉 H5 JSAPI 前端鉴权需要 agentId + corpId（agentId 来自 env DD_AGENT_ID）
      oa: {
        dingtalk:
          user.provider === "dingtalk"
            ? { agentId: cfg.dingtalk.agentId, corpId: cfg.dingtalk.corpId }
            : undefined,
      },
    });
  }

  /** POST /api/share/jsapi-sign：返回当前登录方式的 H5 JSAPI 前端鉴权参数。 */
  async function jsapiSign(request: Request): Promise<Response> {
    const user = await currentUser(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    const body = (await request.json().catch(() => ({}))) as { url?: unknown };
    const pageUrl = typeof body.url === "string" && body.url ? body.url : "";
    if (!pageUrl) return json({ error: "missing_url" }, 400);

    if (user.provider === "dingtalk") {
      if (!cfg.dingtalk.clientId || !cfg.dingtalk.clientSecret || !cfg.dingtalk.corpId) {
        return json({ error: "dingtalk_not_configured" }, 400);
      }
      // agentId 是钉钉企业内部应用的微应用 AgentId，不是 clientId；
      // 缺失时明确报错（否则钉钉返回「无效的agentid」，难以排查）
      if (!cfg.dingtalk.agentId) {
        return json({ error: "dingtalk_agent_id_missing", message: "缺少 DD_AGENT_ID 配置" }, 400);
      }
      try {
        const config = await dingTalkJsapiConfig(
          cfg.dingtalk.clientId,
          cfg.dingtalk.clientSecret,
          cfg.dingtalk.corpId,
          cfg.dingtalk.agentId,
          pageUrl,
        );
        // 用户身份发送互动卡片（sendMessageToGroup）需要 clientId + 卡片模板 ID
        return json({
          provider: "dingtalk",
          config: {
            ...config,
            clientId: cfg.dingtalk.clientId,
            cardTemplateId: cfg.dingtalk.cardTemplateId || "",
          },
        });
      } catch (e) {
        return json({ error: "sign_failed", message: e instanceof Error ? e.message : String(e) }, 502);
      }
    }
    if (user.provider === "feishu") {
      if (!cfg.feishu.appId || !cfg.feishu.appSecret) {
        return json({ error: "feishu_not_configured" }, 400);
      }
      try {
        const config = await feishuJsapiConfig(cfg.feishu.appId, cfg.feishu.appSecret, cfg.feishu.baseUrl, pageUrl);
        return json({ provider: "feishu", config });
      } catch (e) {
        return json({ error: "sign_failed", message: e instanceof Error ? e.message : String(e) }, 502);
      }
    }
    return json({ error: "unsupported_provider" }, 400);
  }

  /** GET /api/share/[token]：公开只读页（自包含 HTML，与聊天区域同一套黑白灰风格）。 */
  async function view(request: Request, ctx: unknown): Promise<Response> {
    const params = (ctx && (ctx as { params?: unknown }).params) || {};
    const resolved = params instanceof Promise ? await params : params;
    const token = String((resolved as { token?: unknown }).token || "");
    if (!token) return new Response("Not Found", { status: 404 });
    const share = await getShareByToken(token);
    if (!share) return new Response("分享不存在或已失效", { status: 404 });

    if (share.scopeType === "file") return renderFileSharePage(share, request);
    const shareUrl = `${publicOrigin(request)}${cfg.cookiePath.replace(/\/+$/, "")}/api/share/${token}`;
    return renderSessionPage(request, share.sessionId ?? "", shareUrl);
  }

  async function renderSessionPage(request: Request, sessionId: string, shareUrl: string): Promise<Response> {
    const title = (await getSessionTitleBySessionId(sessionId)) || "AI 对话";
    const messages = await listAgentMessagesPublic(sessionId);
    // 摘要：钉钉等 IM 分享链接卡片时以页面 meta（og:description）为内容来源（而非 JSAPI 参数），
    // 这里与 create() 同口径生成摘要并写入 meta，保证分享出去的卡片正文展示会话内容
    const summary = await buildChatSummary(sessionId);
    // 不做分享图预览：卡片只展示标题/摘要/域名（og:title / og:description / og:url），
    // 无 og:image（IM 抓取器缩略图依赖公网静态图，维护成本高且兼容性差）
    const metaDesc = escapeHtml((summary ? `${summary.slice(0, 200)}…` : `来自「${title}」的 AI 对话，点击查看完整内容。`).slice(0, 300));
    const rows: string[] = [];
    for (const m of messages) {
      const text = String(m.content || "");
      if (m.role === "assistant") {
        const clean = stripRateLimitText(text);
        if (!clean) continue;
        // 服务端 markdown 渲染（与聊天区域同一管线）；失败时回退纯文本
        const html = await renderMarkdownHtml(clean);
        rows.push(
          `<div class="msg bot"><div class="bubble">${
            html ? `<div class="md">${html}</div>` : escapeHtml(clean).split("\n").join("<br>")
          }</div></div>`,
        );
      } else {
        // 与聊天区 UserBubble 一致：仅当消息带附件时剥离首行 "[附件] 文件名"（附件已在气泡上方独立展示）
        const clean = m.attachment ? stripAttachmentLine(text) : text;
        rows.push(`<div class="msg user"><div class="bubble">${escapeHtml(clean || "…").split("\n").join("<br>")}</div></div>`);
      }
    }
    const rowsHtml = rows.join("\n");

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${metaDesc}">
<meta property="og:title" content="${escapeHtml(title)} · AI 对话分享">
<meta property="og:description" content="${metaDesc}">
<meta property="og:url" content="${escapeHtml(shareUrl)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${AI_DISPLAY_NAME}">
<title>${escapeHtml(title)} · AI 对话分享</title>
<style>
  :root { --bg:#f4f6fb; --ink:#1f2733; --ink-soft:#5b6573; --line:#e3e8f0; --brand:#2f6bff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .share-wrap { min-height:100vh; display:flex; flex-direction:column; }
  .share-head { width:100%; max-width:900px; margin:0 auto; padding:22px 26px 10px 18px; border-bottom:1px solid var(--line); }
  .share-head h1 { margin:0; font-size:17px; font-weight:700; color:var(--ink); }
  .share-head p { margin:5px 0 0; font-size:12px; color:var(--ink-soft); }
  .chat-body-inner { width:100%; max-width:900px; margin:0 auto; padding:20px 26px 20px 18px; display:flex; flex-direction:column; gap:14px; flex:1; }
  .msg { display:flex; max-width:86%; min-width:0; }
  .msg.user { align-self:flex-end; flex-direction:column; align-items:flex-end; }
  .msg.bot { align-self:flex-start; flex-direction:column; width:100%; }
  .msg .bubble { padding:11px 14px; border-radius:14px; font-size:14.5px; line-height:1.65; white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; min-width:0; max-width:100%; }
  .msg.bot .bubble { align-self:flex-start; background:transparent; color:var(--ink); padding:2px 0; border-bottom-left-radius:4px; white-space:normal; }
  .msg.user .bubble { background:#f0f0f0; color:var(--ink); border-bottom-right-radius:4px; }
  /* Markdown（与聊天区域 .md 一致） */
  .bubble .md { font-size:14.5px; line-height:1.7; color:var(--ink); white-space:normal; overflow-wrap:anywhere; }
  .bubble .md > *:first-child { margin-top:0; }
  .bubble .md > *:last-child { margin-bottom:0; }
  .bubble .md p { margin:0 0 8px; }
  .bubble .md h1, .bubble .md h2, .bubble .md h3, .bubble .md h4, .bubble .md h5, .bubble .md h6 { margin:12px 0 6px; line-height:1.35; font-weight:700; }
  .bubble .md h1 { font-size:19px; } .bubble .md h2 { font-size:17px; } .bubble .md h3 { font-size:15.5px; }
  .bubble .md h4, .bubble .md h5, .bubble .md h6 { font-size:14.5px; }
  .bubble .md ul, .bubble .md ol { margin:0 0 8px; padding-left:22px; }
  .bubble .md li { margin:2px 0; }
  .bubble .md a { color:var(--brand); text-decoration:none; border-bottom:1px solid rgba(47,107,255,.35); }
  .bubble .md strong { font-weight:700; }
  .bubble .md em { font-style:italic; }
  .bubble .md del { color:var(--ink-soft); }
  .bubble .md :not(pre) > code { background:#eef2f8; border:1px solid #dfe6f0; border-radius:5px; padding:1px 5px; font-size:12.5px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; color:#c0392b; }
  .bubble .md pre { background:#0f172a; color:#e2e8f0; border-radius:10px; padding:12px 14px; overflow-x:auto; margin:0 0 10px; font-size:12.5px; line-height:1.55; }
  .bubble .md pre code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; white-space:pre; background:none; border:none; padding:0; color:inherit; }
  .bubble .md table { border-collapse:collapse; margin:0 0 12px; font-size:13.5px; width:100%; display:block; overflow-x:auto; }
  .bubble .md th, .bubble .md td { border:1px solid var(--line); padding:6px 10px; text-align:left; }
  .bubble .md th { background:#eef2f8; font-weight:700; }
  .bubble .md tr:nth-child(2n) td { background:rgba(0,0,0,.02); }
  .bubble .md blockquote { margin:0 0 10px; padding:8px 12px; border-left:3px solid var(--brand); background:#eef4ff; border-radius:0 8px 8px 0; color:#334155; }
  .bubble .md blockquote > *:last-child { margin-bottom:0; }
  .bubble .md hr { border:none; border-top:1px solid var(--line); margin:12px 0; }
  .bubble .md img { max-width:100%; border-radius:8px; }
  /* rehype-highlight 代码高亮：GitHub Dark 精简版（同聊天区域） */
  .bubble .md .hljs-comment, .bubble .md .hljs-quote { color:#8b949e; font-style:italic; }
  .bubble .md .hljs-keyword, .bubble .md .hljs-selector-tag, .bubble .md .hljs-literal, .bubble .md .hljs-doctag, .bubble .md .hljs-type { color:#ff7b72; }
  .bubble .md .hljs-string, .bubble .md .hljs-regexp, .bubble .md .hljs-addition, .bubble .md .hljs-attribute, .bubble .md .hljs-meta .hljs-string { color:#a5d6ff; }
  .bubble .md .hljs-number, .bubble .md .hljs-symbol, .bubble .md .hljs-bullet, .bubble .md .hljs-variable, .bubble .md .hljs-template-variable { color:#79c0ff; }
  .bubble .md .hljs-title, .bubble .md .hljs-section, .bubble .md .hljs-name { color:#d2a8ff; }
  .bubble .md .hljs-built_in, .bubble .md .hljs-builtin-name, .bubble .md .hljs-params { color:#ffa657; }
  .bubble .md .hljs-emphasis { font-style:italic; }
  .bubble .md .hljs-strong { font-weight:700; }
  .share-foot { width:100%; max-width:900px; margin:0 auto; padding:8px 26px 26px 18px; text-align:center; font-size:12px; color:var(--ink-soft); }
</style>
</head>
<body>
<div class="share-wrap">
  <div class="share-head">
    <h1>${escapeHtml(title)}</h1>
    <p>AI 对话分享 · ${messages.length} 条消息</p>
  </div>
  <div class="chat-body-inner">
    ${rowsHtml || '<div class="msg bot"><div class="bubble">该会话暂无消息</div></div>'}
  </div>
  <div class="share-foot">内容由分享者通过 AI 助手生成，仅供查看</div>
</div>
</body>
</html>`;
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  /** POST /api/share/[token]/send：把分享链接发送到指定 OA 会话（仅创建者）。 */
  async function send(request: Request, ctx: unknown): Promise<Response> {
    const user = await currentUser(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    const params = (ctx && (ctx as { params?: unknown }).params) || {};
    const resolved = params instanceof Promise ? await params : params;
    const token = String((resolved as { token?: unknown }).token || "");
    if (!token) return json({ error: "missing_token" }, 400);

    const share = await getShareByToken(token);
    if (!share) return json({ error: "not_found" }, 404);
    if (share.createdBy !== user.userId) return json({ error: "forbidden" }, 403);

    const body = (await request.json().catch(() => ({}))) as {
      provider?: unknown;
      cid?: unknown;
      chatId?: unknown;
    };
    const provider = body.provider === "dingtalk" ? "dingtalk" : body.provider === "feishu" ? "feishu" : "";
    if (!provider) return json({ error: "missing_provider" }, 400);

    const sessionTitle = (await getSessionTitleBySessionId(share.sessionId ?? "")) || "AI 对话";
    const origin = publicOrigin(request);
    const url = `${origin}${cfg.cookiePath.replace(/\/+$/, "")}/api/share/${token}`;
    // 链接预览：钉钉发 markdown 卡片（title + 链接）、飞书发 interactive 卡片（整卡点击跳转）
    const title = `AI 对话分享：${sessionTitle}`;
    const text = `来自「${sessionTitle}」的 AI 对话，点击查看完整内容。`;

    try {
      if (provider === "dingtalk") {
        const cid = typeof body.cid === "string" && body.cid ? body.cid : "";
        if (!cid) return json({ error: "missing_cid" }, 400);
        if (!cfg.dingtalk.clientId || !cfg.dingtalk.clientSecret) {
          return json({ error: "dingtalk_not_configured" }, 400);
        }
        // 以用户身份发送到会话（旧接口 send_to_conversation：sender = 钉钉 userid + cid）。
        // sender 优先取用户表 user_code（免登登录会落库）；为空时用主体键里的 unionId 实时解析（OAuth 登录兜底）。
        let sender = await getUserCodeByKey(user.userId);
        if (!sender) {
          const unionId = parseSessionKey(user.userId).unionId;
          if (unionId) {
            sender = await resolveDingTalkUserIdByUnionId(
              cfg.dingtalk.clientId,
              cfg.dingtalk.clientSecret,
              unionId,
            );
          }
        }
        if (!sender) {
          return json(
            { error: "dingtalk_sender_missing", message: "未获取到钉钉 userid（请确认应用已申请“成员信息读权限”）" },
            400,
          );
        }
        await sendDingTalkMessage(cfg.dingtalk.clientId, cfg.dingtalk.clientSecret, cid, sender, text, { title, url });
      } else {
        const chatId = typeof body.chatId === "string" && body.chatId ? body.chatId : "";
        if (!chatId) return json({ error: "missing_chat_id" }, 400);
        if (!cfg.feishu.appId || !cfg.feishu.appSecret) {
          return json({ error: "feishu_not_configured" }, 400);
        }
        // 优先以当前用户身份发送（无需机器人进群，用户本就在自己的会话里）：
        // DB 有 user_access_token 则用用户身份；失效时用 refresh_token 刷新一次重发；
        // 无令牌或用户身份全部失败时，回退应用身份（需机器人已在群内）。
        // 聊天摘要：最近 5 条非空消息直接展示进飞书分享卡片（豆包分享同款样式）
        const chatSummary = await buildChatSummary(share.sessionId ?? "");
        const oauth = await getUserOauthTokenByKey(user.userId);
        let lastErr: unknown;
        if (oauth?.accessToken) {
          try {
            await sendFeishuMessageAsUser(oauth.accessToken, cfg.feishu.baseUrl, chatId, text, {
              title,
              url,
              chatSummary,
            });
          } catch (e) {
            lastErr = e;
            if (oauth.refreshToken) {
              try {
                const refreshed = await refreshFeishuUserToken(
                  cfg.feishu.appId,
                  cfg.feishu.appSecret,
                  cfg.feishu.baseUrl,
                  oauth.refreshToken,
                );
                await updateUserOauthToken(user.userId, {
                  accessToken: refreshed.accessToken,
                  refreshToken: refreshed.refreshToken ?? undefined,
                });
                await sendFeishuMessageAsUser(refreshed.accessToken, cfg.feishu.baseUrl, chatId, text, {
                  title,
                  url,
                  chatSummary,
                });
                lastErr = undefined;
              } catch (e2) {
                lastErr = e2;
              }
            }
          }
        }
        if (lastErr) {
          try {
            await sendFeishuMessage(cfg.feishu.appId, cfg.feishu.appSecret, cfg.feishu.baseUrl, chatId, text, { title, url });
            lastErr = undefined;
          } catch (e3) {
            lastErr = new Error(
              `用户身份发送失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}；` +
                `应用身份回退失败：${e3 instanceof Error ? e3.message : String(e3)}`,
            );
          }
        }
        if (lastErr) throw lastErr;
      }
    } catch (e) {
      console.error(`[agent-kit share] OA 发送失败 token=${token} provider=${provider}:`, e instanceof Error ? e.message : e);
      return json({ error: "send_failed", message: e instanceof Error ? e.message : String(e) }, 502);
    }
    return json({ ok: true });
  }

  /** 应用内分享使用独立凭据；访问资格始终由目标群当前成员身份与消息撤回状态决定。 */
  async function sendToAppChat(request: Request): Promise<Response> {
    const user = await currentUser(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!sendToChat || !isDbEnabled()) return json({ error: "unavailable" }, 503);
    const body = await request.json().catch(() => ({})) as { sourceSessionId?: unknown; targetSessionId?: unknown; artifactId?: unknown };
    const sourceId = typeof body.sourceSessionId === "string" ? body.sourceSessionId : "";
    const targetId = typeof body.targetSessionId === "string" ? body.targetSessionId : "";
    if (!sourceId || !targetId || sourceId === targetId) return json({ error: "invalid_session" }, 400);
    await ensureMigrated();
    const pool = getPool();
    if (!pool) return json({ error: "database_unavailable" }, 503);
    const [source, target, members] = await Promise.all([
      getAgentSession(user.userId, sourceId),
      getAgentSession(user.userId, targetId),
      pool.query("SELECT 1 FROM agent_session_members WHERE session_id=$1 LIMIT 1", [targetId]),
    ]);
    if (!source || !target || !members.rowCount) return json({ error: "not_found" }, 404);
    const artifactId = typeof body.artifactId === "string" ? body.artifactId : "";
    if (artifactId) {
      const sourceSession = await pool.query("SELECT workspace_dir FROM agent_sessions WHERE id=$1", [sourceId]);
      const workspaceDir = process.env.AGENT_ALLOW_SERVER_WORKSPACE === "1" ? String(sourceSession.rows[0]?.workspace_dir || "") || undefined : undefined;
      const artifact = await readArtifact(sourceId, artifactId, workspaceDir);
      if (!artifact) return json({ error: "artifact_not_found" }, 404);
      const displayName = path.basename(artifactId).slice(0, 180);
      const storedName = `${randomBytes(16).toString("hex")}${path.extname(displayName)}`;
      let copiedFileId = "";
      try {
        const indexed = await recordFileToStore({ buf: artifact.buf, ownerSub: user.userId, kind: "input",
          name: storedName, sessionId: targetId, mime: artifact.mime });
        if (!indexed) throw new Error("file_index_failed");
        copiedFileId = indexed.fileId;
        const attachment = { url: `/api/upload?session=${encodeURIComponent(targetId)}&name=${encodeURIComponent(storedName)}&fileId=${encodeURIComponent(indexed.fileId)}`,
          name: displayName, fileId: indexed.fileId, size: artifact.buf.length };
        const sendRequest = new Request(new URL(`${cfg.cookiePath.replace(/\/+$/, "")}/api/cowork/${encodeURIComponent(targetId)}/send`, request.url), {
          method: "POST", headers: { cookie: request.headers.get("cookie") || "", "content-type": "application/json" },
          body: JSON.stringify({ content: "", attachments: [attachment], clientMessageId: randomBytes(16).toString("hex") }),
        });
        const sent = await sendToChat(sendRequest, targetId);
        const result = await sent.json().catch(() => ({})) as { id?: number; error?: string };
        if (!sent.ok || !Number.isSafeInteger(result.id)) throw new Error(result.error || "send_failed");
        return json({ ok: true, messageId: result.id, fileId: indexed.fileId });
      } catch (error) {
        if (copiedFileId) await deleteStoredFile(copiedFileId).catch(() => {});
        return json({ error: error instanceof Error ? error.message : "send_failed" }, 500);
      }
    }
    const token = randomBytes(24).toString("hex");
    const url = `${publicOrigin(request)}${cfg.cookiePath.replace(/\/+$/, "")}/api/share/chat/${token}`;
    const title = (await getSessionTitleBySessionId(sourceId)) || "AI 对话";
    const content = `AI 对话分享：${title.slice(0, 100)}\n${url}`;
    const sendRequest = new Request(new URL(`${cfg.cookiePath.replace(/\/+$/, "")}/api/cowork/${encodeURIComponent(targetId)}/send`, request.url), {
      method: "POST", headers: { cookie: request.headers.get("cookie") || "", "content-type": "application/json" },
      body: JSON.stringify({ content, clientMessageId: token }),
    });
    const sent = await sendToChat(sendRequest, targetId);
    const result = await sent.json().catch(() => ({})) as { id?: number; error?: string };
    if (!sent.ok || !Number.isSafeInteger(result.id)) return json({ error: result.error || "send_failed" }, sent.status || 500);
    try {
      await pool.query(`INSERT INTO agent_chat_shares(token,source_session_id,target_session_id,message_id,created_by)
        VALUES($1,$2,$3,$4,$5)`, [token, sourceId, targetId, result.id, user.userId]);
    } catch (error) {
      await revokeAgentMessage(user.userId, targetId, result.id!).catch(() => {});
      console.error("[agent-kit share] 应用内分享授权失败:", error);
      return json({ error: "grant_failed" }, 500);
    }
    return json({ ok: true, messageId: result.id, url });
  }

  async function viewAppChat(request: Request, token: string): Promise<Response> {
    const user = await currentUser(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!/^[0-9a-f]{48}$/.test(token)) return new Response("分享不存在或已失效", { status: 404 });
    await ensureMigrated();
    const pool = getPool();
    if (!pool) return json({ error: "database_unavailable" }, 503);
    const result = await pool.query(`SELECT cs.source_session_id,cs.target_session_id,cs.scope_type,cs.artifact_id
      FROM agent_chat_shares cs JOIN agent_messages m ON m.id=cs.message_id AND m.session_id=cs.target_session_id
      WHERE cs.token=$1 AND m.revoked_at IS NULL`, [token]);
    const row = result.rows[0] as { source_session_id: string; target_session_id: string; scope_type: string; artifact_id: string | null } | undefined;
    if (!row || !await getAgentSession(user.userId, row.target_session_id)) return new Response("分享不存在或已失效", { status: 404 });
    if (row.scope_type === "artifact") return new Response("此产物分享方式已失效，请重新发送文件", { status: 410 });
    const url = `${publicOrigin(request)}${cfg.cookiePath.replace(/\/+$/, "")}/api/share/chat/${token}`;
    return renderSessionPage(request, row.source_session_id, url);
  }

  return {
    create: { POST: create },
    jsapiSign: { POST: jsapiSign },
    view: { GET: view },
    send: { POST: send },
    chat: { POST: sendToAppChat, GET: viewAppChat },
  };
}
