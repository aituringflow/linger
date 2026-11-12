import { randomUUID } from "node:crypto";
import { createAgentSessionWithMembers, getPool, ensureMigrated } from "./auth/db.js";
import { getSessionUser } from "./auth/handlers.js";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const key = (unionId: string) => `builtin:${unionId}`;
const validId = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

async function notify(userSub: string, type: string, id: string) {
  const pool = getPool();
  if (pool) await pool.query("SELECT pg_notify('agent_domain_events',$1)", [JSON.stringify({ userSub, domain: "contacts", type, id })]);
}

export async function contactsDomainApi(request: Request, parts: string[]): Promise<Response> {
  const user = getSessionUser(request);
  if (!user || user.provider !== "builtin") return json({ error: "请使用内置账号登录" }, 401);
  const pool = getPool();
  if (!pool) return json({ error: "数据库不可用" }, 503);
  await ensureMigrated();
  const sub = user.sub;
  const method = request.method;
  try {
    if (method === "GET" && parts.length === 1 && parts[0] === "users") {
      const q = new URL(request.url).searchParams.get("q")?.trim().toLowerCase() || "";
      if (q.length < 2 || q.length > 128) return json({ users: [] });
      const result = await pool.query(
        `SELECT u.union_id AS id,u.user_code AS username,COALESCE(NULLIF(u.name,''),u.user_code) AS name,u.avatar,
          EXISTS(SELECT 1 FROM builtin_friendships f WHERE (f.user_a=$2 AND f.user_b='builtin:'||u.union_id) OR (f.user_b=$2 AND f.user_a='builtin:'||u.union_id)) AS friend,
          EXISTS(SELECT 1 FROM builtin_friend_invitations i WHERE i.sender_sub=$2 AND i.recipient_sub='builtin:'||u.union_id AND i.status='pending') AS requested
         FROM builtin_credentials c JOIN users u ON u.id=c.user_id AND u.provider='builtin'
         WHERE u.user_code ILIKE $1 AND 'builtin:'||u.union_id<>$2 ORDER BY u.user_code LIMIT 30`,
        [`%${q.replace(/[\\%_]/g, "\\$&")}%`, sub]);
      return json({ users: result.rows });
    }
    if (method === "GET" && parts.length === 0) {
      const [friends, incoming, outgoing] = await Promise.all([
        pool.query(`SELECT u.union_id AS id,u.user_code AS username,COALESCE(NULLIF(u.name,''),u.user_code) AS name,u.avatar,f.created_at
          FROM builtin_friendships f JOIN users u ON 'builtin:'||u.union_id=CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
          JOIN builtin_credentials c ON c.user_id=u.id WHERE f.user_a=$1 OR f.user_b=$1 ORDER BY name`, [sub]),
        pool.query(`SELECT i.id,i.created_at,COALESCE(NULLIF(u.name,''),u.user_code) AS name,u.user_code AS username,u.avatar FROM builtin_friend_invitations i
          JOIN users u ON 'builtin:'||u.union_id=i.sender_sub JOIN builtin_credentials c ON c.user_id=u.id
          WHERE i.recipient_sub=$1 AND i.status='pending' ORDER BY i.created_at DESC`, [sub]),
        pool.query(`SELECT i.id,i.created_at,COALESCE(NULLIF(u.name,''),u.user_code) AS name,u.user_code AS username FROM builtin_friend_invitations i
          JOIN users u ON 'builtin:'||u.union_id=i.recipient_sub JOIN builtin_credentials c ON c.user_id=u.id
          WHERE i.sender_sub=$1 AND i.status='pending' ORDER BY i.created_at DESC`, [sub]),
      ]);
      return json({ friends: friends.rows, incoming: incoming.rows, outgoing: outgoing.rows });
    }
    if (method === "GET" && parts.length === 3 && parts[0] === "friends" && parts[2] === "session") {
      const peerId = parts[1];
      if (!validId(peerId)) return json({ error: "无效用户" }, 400);
      const peerSub = key(peerId);
      const pair = [sub, peerSub].sort();
      const found = await pool.query(`SELECT s.id FROM builtin_friendships f
        JOIN agent_session_members m ON m.provider='builtin'
        JOIN agent_sessions s ON s.id=m.session_id AND NOT s.cowork_ever_group
        WHERE f.user_a=$1 AND f.user_b=$2 AND
          (SELECT count(*) FROM agent_session_members m2 WHERE m2.session_id=s.id)=1 AND
          EXISTS (SELECT 1 FROM agent_messages msg WHERE msg.session_id=s.id AND msg.role='user') AND
          ((s.user_id=$4 AND m.contact_id=$3) OR (s.user_id=$6 AND m.contact_id=$5))
        ORDER BY s.updated_at DESC LIMIT 1`, [pair[0], pair[1], peerId, sub, user.unionId, peerSub]);
      return json({ sessionId: found.rows[0]?.id ?? null });
    }
    if (method === "DELETE" && parts.length === 2 && parts[0] === "friends") {
      const peerId = parts[1];
      if (!validId(peerId)) return json({ error: "无效用户" }, 400);
      const peerSub = key(peerId);
      const pair = [sub, peerSub].sort();
      const deleted = await pool.query("DELETE FROM builtin_friendships WHERE user_a=$1 AND user_b=$2 RETURNING user_a", pair);
      if (!deleted.rowCount) return json({ error: "对方还不是你的好友" }, 404);
      await notify(peerSub, "friend_removed", peerId).catch(error => console.warn("[contacts domain] notification delayed", error));
      return json({ ok: true });
    }
    if (method === "POST" && parts.length === 3 && parts[0] === "friends" && parts[2] === "session") {
      const peerId = parts[1];
      if (!validId(peerId)) return json({ error: "无效用户" }, 400);
      const peerSub = key(peerId);
      const pair = [sub, peerSub].sort();
      const friend = await pool.query("SELECT 1 FROM builtin_friendships WHERE user_a=$1 AND user_b=$2", pair);
      if (!friend.rowCount) return json({ error: "对方还不是你的好友" }, 403);
      // 已有 1v1 内置好友会话（含空会话）直接复用，避免重复建会话
      const found = await pool.query(`SELECT s.id FROM agent_sessions s
        JOIN agent_session_members m ON m.session_id=s.id AND m.provider='builtin'
        WHERE NOT s.cowork_ever_group
          AND (SELECT count(*) FROM agent_session_members m2 WHERE m2.session_id=s.id)=1
          AND ((s.user_id=$1 AND m.contact_id=$2) OR (s.user_id=$3 AND m.contact_id=$4))
        ORDER BY s.updated_at DESC LIMIT 1`, [sub, peerId, peerSub, user.unionId]);
      if (found.rows[0]?.id) return json({ sessionId: String(found.rows[0].id), created: false });
      // 没有则创建：1v1 会话标题固定为对方姓名
      const profile = await pool.query(`SELECT COALESCE(NULLIF(u.name,''),u.user_code) AS name,u.avatar FROM users u
        JOIN builtin_credentials c ON c.user_id=u.id WHERE u.provider='builtin' AND u.union_id=$1`, [peerId]);
      if (!profile.rowCount) return json({ error: "用户不存在" }, 404);
      const name = String(profile.rows[0].name);
      const avatar = String(profile.rows[0].avatar ?? "");
      const sessionId = randomUUID();
      const created = await createAgentSessionWithMembers(sub, sessionId, name, null, "single", null, [{ provider: "builtin", contactId: peerId, name, avatar }]);
      if (!created) return json({ error: "会话创建失败" }, 500);
      return json({ sessionId, created: true });
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "group-session") {
      const ids = [...new Set((new URL(request.url).searchParams.get("ids") || "").split(",").filter(validId))].sort();
      if (ids.length < 2 || ids.length > 30) return json({ sessionId: null });
      const peers = ids.map(id => key(id)).sort();
      const found = await pool.query(`SELECT s.id FROM agent_sessions s
        WHERE s.cowork_ever_group AND (s.user_id=$1 OR EXISTS (
          SELECT 1 FROM agent_session_members mine WHERE mine.session_id=s.id AND mine.provider='builtin' AND mine.contact_id=$2))
          AND ARRAY(SELECT participant.id FROM (
            SELECT s.user_id AS id
            UNION SELECT m.provider||':'||m.contact_id AS id FROM agent_session_members m WHERE m.session_id=s.id
          ) participant WHERE participant.id<>$1 ORDER BY participant.id)=$3::text[]
        ORDER BY s.updated_at DESC LIMIT 1`, [sub,user.unionId,peers]);
      return json({ sessionId: found.rows[0]?.id ?? null });
    }
    if (method === "POST" && parts[0] === "invitations" && parts.length === 1) {
      const body = await request.json().catch(() => ({})) as { userId?: unknown };
      const userId = typeof body.userId === "string" ? body.userId : "";
      if (!validId(userId) || key(userId) === sub) return json({ error: "无效用户" }, 400);
      const target = key(userId);
      const client = await pool.connect();
      let id = "";
      try {
        await client.query("BEGIN");
        const exists = await client.query("SELECT 1 FROM users WHERE provider='builtin' AND union_id=$1", [userId]);
        if (!exists.rowCount) { await client.query("ROLLBACK"); return json({ error: "用户不存在" }, 404); }
        const pair = [sub, target].sort();
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [pair.join("|")]);
        const friend = await client.query("SELECT 1 FROM builtin_friendships WHERE user_a=$1 AND user_b=$2", pair);
        if (friend.rowCount) { await client.query("ROLLBACK"); return json({ error: "已经是好友" }, 409); }
        const reverse = await client.query("SELECT id FROM builtin_friend_invitations WHERE sender_sub=$1 AND recipient_sub=$2 AND status='pending' FOR UPDATE", [target, sub]);
        if (reverse.rowCount) { await client.query("ROLLBACK"); return json({ error: "对方已向你发送邀请，请在待处理邀请中同意" }, 409); }
        const inserted = await client.query("INSERT INTO builtin_friend_invitations(sender_sub,recipient_sub) VALUES($1,$2) RETURNING id", [sub,target]);
        id = String(inserted.rows[0].id);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); if ((error as {code?:string}).code === "23505") return json({ error: "邀请已发送" }, 409); throw error; }
      finally { client.release(); }
      await notify(target, "friend_invitation", id).catch(error => console.warn("[contacts domain] notification delayed", error));
      return json({ id }, 201);
    }
    if (method === "POST" && parts[0] === "invitations" && parts.length === 3 && parts[2] === "respond") {
      const id = parts[1];
      if (!/^\d+$/.test(id)) return json({ error: "无效邀请" }, 400);
      const body = await request.json().catch(() => ({})) as { accept?: unknown };
      if (typeof body.accept !== "boolean") return json({ error: "请选择同意或拒绝" }, 400);
      const client = await pool.connect();
      let sender = "";
      try {
        await client.query("BEGIN");
        const found = await client.query("SELECT sender_sub FROM builtin_friend_invitations WHERE id=$1 AND recipient_sub=$2 AND status='pending' FOR UPDATE", [id,sub]);
        if (!found.rowCount) { await client.query("ROLLBACK"); return json({ error: "邀请已处理或不存在" }, 404); }
        sender = String(found.rows[0].sender_sub);
        if (body.accept) {
          const pair = [sub,sender].sort();
          await client.query("INSERT INTO builtin_friendships(user_a,user_b) VALUES($1,$2) ON CONFLICT DO NOTHING", pair);
        }
        await client.query("UPDATE builtin_friend_invitations SET status=$2,responded_at=now() WHERE id=$1", [id,body.accept ? "accepted" : "rejected"]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
      await Promise.all([notify(sender, body.accept ? "friend_accepted" : "friend_rejected", id), notify(sub, "invitation_resolved", id)])
        .catch(error => console.warn("[contacts domain] notification delayed", error));
      return json({ ok: true });
    }
    return json({ error: "未找到联系人操作" }, 404);
  } catch (error) {
    console.error("[contacts domain]", error);
    return json({ error: "联系人服务暂不可用" }, 503);
  }
}

/** Built-in 会话仅可邀请已互相确认的好友。 */
export async function builtinFriendContacts(sub: string, ids: string[]) {
  const pool = getPool();
  if (!pool || !ids.length) return [];
  await ensureMigrated();
  const result = await pool.query(`SELECT u.union_id AS id,COALESCE(NULLIF(u.name,''),u.user_code) AS name,u.avatar FROM builtin_friendships f
    JOIN users u ON u.provider='builtin' AND 'builtin:'||u.union_id=CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
    WHERE (f.user_a=$1 OR f.user_b=$1) AND u.union_id=ANY($2::text[])`, [sub, ids]);
  return result.rows.map(row => ({ provider: "builtin", id: String(row.id), name: String(row.name), avatar: String(row.avatar ?? "") }));
}
