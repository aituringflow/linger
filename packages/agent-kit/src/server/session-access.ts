/**
 * agent-kit · 会话访问控制（隔离核心）
 *
 * 目标：不同用户之间不能访问彼此的会话数据（消息 / 产物 / 常驻 CLI 会话）。
 * 唯一路径：以会话 Cookie（agent_session）解析 user.sub（主体键 `provider:unionId`），再查 PostgreSQL
 * agent_sessions.user_id —— 只能访问**自己**的会话。任何请求带别人的 sessionId
 * → 拒绝。未登录一律无权限（不再支持游客模式）。
 *
 * 设计取舍：
 *   - 产物（iframe/img/a 无法带 header）同样走 Cookie：同源请求自动携带，
 *     无需 URL 签名票据；
 *   - 数据库故障时放行登录用户（体验优先，风险=失去归属校验，接受并记日志）。
 */
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import { getAgentSession, isDbEnabled } from "./auth/db.js";
import { authorizeTemporaryChat } from "./temporary-chat.js";

export type SessionAccessKind = "user" | null;

/** 判断某个会话是否属于当前请求者（登录用户 → DB 归属校验）。 */
export async function assertSessionAccess(request: Request, sessionId: string): Promise<SessionAccessKind> {
  if (sessionId.startsWith("side_")) return authorizeTemporaryChat(request, sessionId, false) ? null : "user";
  const user = verifySession(request, loadAuthConfig());
  if (!user?.sub) return null;
  if (isDbEnabled()) {
    try {
      const row = await getAgentSession(user.sub, sessionId);
      return row ? "user" : null;
    } catch (e) {
      // DB 查询异常：放行登录用户（体验优先，风险=数据库故障时失去归属校验，接受并记日志）
      console.warn("[agent-kit access] DB 归属校验异常，放行登录用户:", e instanceof Error ? e.message : e);
      return "user";
    }
  }
  return "user"; // 数据库未启用：会话无持久化，无跨用户数据可泄露
}

/** chat / answer / steer 的访问判定：登录用户 → DB 归属；未登录 → 拒绝。 */
export async function assertChatAccess(
  request: Request,
  sessionId: string,
  resume: boolean,
): Promise<SessionAccessKind> {
  if (sessionId.startsWith("side_")) return authorizeTemporaryChat(request, sessionId, false) ? null : "user";
  const user = verifySession(request, loadAuthConfig());
  if (!user?.sub) return null;
  if (isDbEnabled()) {
    try {
      const row = await getAgentSession(user.sub, sessionId);
      if (row) return "user";
      // 编辑重发时前端会换一个「临时 SDK transcript id」避免 CLI 加载旧 transcript。
      // 该 id 形如 `${本会话 id}_${随机后缀}`（会话 id 为 UUID，不含 '_'）。
      // 取 '_' 前的会话 id 校验归属——id 由受信会话 id 派生，无法借它冒用他人会话：
      //   · 直接拿他人会话 id 当 sessionId → 上面查不到，无 '_' 可选，落到此处仍拒绝；
      //   · 伪造 `${他人会话 id}_x` → 基准 id 非本人所有，拒绝。
      const sep = sessionId.indexOf("_");
      if (sep > 0) {
        const base = sessionId.slice(0, sep);
        const owner = await getAgentSession(user.sub, base);
        if (owner) return "user";
      }
    } catch (e) {
      console.warn("[agent-kit access] DB 归属校验异常，放行登录用户:", e instanceof Error ? e.message : e);
      return "user";
    }
    // DB 可用但库里没有该会话：仅首轮（resume=false）放行——视为当前用户的新会话
    //（前端发送前会先 POST /api/sessions 注册；此分支覆盖注册竞态）；
    // 续接一个"不属于自己"的会话 → 拒绝。
    return resume ? null : "user";
  }
  return "user"; // 数据库未启用
}
