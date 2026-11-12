import webPush from "web-push";
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import { ensureMigrated, getPool } from "./auth/db.js";
import { AI_DISPLAY_NAME } from "./names.js";

function config() {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY ?? "";
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY ?? "";
  const subject = process.env.WEB_PUSH_SUBJECT ?? "";
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}

function validPushEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") return false;
    const host = url.hostname.toLowerCase();
    const configured = (process.env.WEB_PUSH_ALLOWED_HOSTS ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
    return host === "fcm.googleapis.com" || host === "web.push.apple.com"
      || host.endsWith(".push.services.mozilla.com") || host.endsWith(".notify.windows.com")
      || configured.includes(host);
  } catch { return false; }
}

export async function webPushApi(request: Request): Promise<Response> {
  const user = verifySession(request, loadAuthConfig());
  if (!user?.sub) return Response.json({ error: "unauthorized" }, { status: 401 });
  const keys = config();
  if (request.method === "GET") return Response.json({ publicKey: keys?.publicKey ?? null }, { headers: { "Cache-Control": "no-store" } });
  const pool = getPool();
  if (!pool) return Response.json({ error: "database_required" }, { status: 503 });
  await ensureMigrated();
  const body = await request.json().catch(() => ({})) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = body.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > 2048 || !validPushEndpoint(endpoint)) return Response.json({ error: "invalid_endpoint" }, { status: 400 });
  if (request.method === "DELETE") {
    await pool.query("DELETE FROM web_push_subscriptions WHERE endpoint=$1 AND user_sub=$2", [endpoint, user.sub]);
    return Response.json({ ok: true });
  }
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  if (!keys) return Response.json({ error: "web_push_unconfigured" }, { status: 503 });
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 256 || auth.length > 256)
    return Response.json({ error: "invalid_subscription" }, { status: 400 });
  await pool.query(`INSERT INTO web_push_subscriptions(endpoint,user_sub,p256dh,auth) VALUES($1,$2,$3,$4)
    ON CONFLICT(endpoint) DO UPDATE SET user_sub=excluded.user_sub,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=now()`,
  [endpoint, user.sub, p256dh, auth]);
  return Response.json({ ok: true });
}

export async function pushCoworkMessage(sessionId: string, message: {
  id: number; role: string; content: string; senderSub?: string | null; senderName?: string | null;
}): Promise<void> {
  const keys = config();
  const pool = getPool();
  if (!keys || !pool) return;
  // AI（assistant）消息：打开「AI 消息免打扰」（ai_muted）或「全量免打扰」（muted）都不推送；
  // 非 AI 消息：仅全量免打扰（muted）拦截。
  const muteFilter = message.role === "assistant"
    ? " AND (r.muted OR r.ai_muted)"
    : " AND r.muted";
  const result = await pool.query<{ endpoint: string; p256dh: string; auth: string; title: string }>(`
    SELECT DISTINCT p.endpoint,p.p256dh,p.auth,s.title
    FROM agent_sessions s JOIN web_push_subscriptions p ON p.user_sub=s.user_id
    WHERE s.id=$1 AND p.user_sub<>COALESCE($2,'')
      AND NOT EXISTS(SELECT 1 FROM agent_session_reads r WHERE r.session_id=s.id AND r.user_sub=p.user_sub${muteFilter})
    UNION
    SELECT DISTINCT p.endpoint,p.p256dh,p.auth,s.title
    FROM agent_sessions s JOIN agent_session_members m ON m.session_id=s.id
    JOIN users u ON u.provider=m.provider AND (u.open_id=m.contact_id OR u.user_code=m.contact_id)
    JOIN web_push_subscriptions p ON p.user_sub=u.provider || ':' || u.union_id
    WHERE s.id=$1 AND p.user_sub<>COALESCE($2,'')
      AND NOT EXISTS(SELECT 1 FROM agent_session_reads r WHERE r.session_id=s.id AND r.user_sub=p.user_sub${muteFilter})`, [sessionId, message.senderSub ?? ""]);
  webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  const payload = JSON.stringify({ title: result.rows[0]?.title || "新消息", body: `${message.role === "assistant" ? AI_DISPLAY_NAME : message.senderName || "成员"}：${(message.content || "[附件]").slice(0, 140)}`,
    tag: `agent-im-${sessionId}`, kind: "new-message", url: `${loadAuthConfig().cookiePath || "/linger"}/?session=${encodeURIComponent(sessionId)}` });
  await Promise.allSettled(result.rows.map(async row => {
    try {
      await webPush.sendNotification({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, { TTL: 3600 });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await pool.query("DELETE FROM web_push_subscriptions WHERE endpoint=$1", [row.endpoint]);
      else console.error("[web-push] send failed", status ?? error);
    }
  }));
}
