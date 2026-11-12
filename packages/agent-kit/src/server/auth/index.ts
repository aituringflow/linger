/**
 * agent-kit · 认证模块统一出口
 *
 * 公共、可复用代码全部收敛于此；具体路由接线（app 侧）只消费本出口，不感知内部实现。
 */
// 类型
export type { AuthUser, AuthProvider, AuthProviderId, SessionUser, AuthConfig } from "./types.js";

// 配置
export { loadAuthConfig, isAuthEnabled, isMethodConfigured, parseAuthProviders } from "./config.js";

// 登录方式清单（服务端登录页决策）
export { getLoginOptions, getLoginOptionsForMethods, resolveLoginOptions } from "./login-options.js";
export type { LoginOption, LoginOptions } from "./login-options.js";

// 会话与 Cookie
export {
  createSessionToken,
  verifySessionToken,
  generateState,
  toSessionUser,
  sessionCookieOptions,
  stateCookieOptions,
} from "./session.js";

// 提供方工厂
export { createProvider, createProviderFor, createDingTalkProvider, createFeishuProvider } from "./providers/index.js";

// 路由工厂
export { createLoginHandlers, verifySession, getSessionUser } from "./handlers.js";
export type { LoginHandlers, LoginHandlersOptions } from "./handlers.js";

// 数据库（PostgreSQL 用户持久化）
export {
  migrate,
  upsertUser,
  findUserByProvider,
  touchLastLogin,
  getPool,
  isDbEnabled,
  // 会话与消息（agent_sessions / agent_messages）
  createAgentSession,
  listAgentSessions,
  getAgentSession,
  renameAgentSession,
  deleteAgentSession,
  addAgentMessage,
  listAgentMessages,
} from "./db.js";
export type { DbUser, AgentSessionRow, AgentMessageRow } from "./db.js";
