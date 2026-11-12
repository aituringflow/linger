/**
 * agent-kit · 认证配置（从 env 解析）
 *
 * env 分块约定（具体见 apps/web/.env.example）：
 *   - 认证方式开关：AUTH_PROVIDER / APP_PUBLIC_URL / AUTH_COOKIE_PATH /
 *     AUTH_SESSION_SECRET / AUTH_SECURE_COOKIE
 *   - 钉钉（AUTH_PROVIDER 含 dingtalk）：DD_CLIENT_ID / DD_CLIENT_SECRET / DD_CORP_ID /
 *     DD_AGENT_ID（企业内部应用微应用 AgentId，分享到钉钉的 H5 JSAPI 前端鉴权必填）
 *   - 飞书（AUTH_PROVIDER 含 feishu）：FS_APP_ID / FS_APP_SECRET /
 *     FS_BASE_URL（可选，国际版）/ FS_REDIRECT_URI（可选，默认自动拼接）
 *   - builtin（AUTH_PROVIDER 含 builtin）：自建账号体系（用户名+密码，注册/登录均走本地
 *     PostgreSQL 用户表）；启用条件是 POSTGRES_HOST && POSTGRES_DB 已配置。
 *
 * 已移除：guest 模式、dev 免登（AUTH_DEV_LOGIN）、数据库开关（AUTH_DB_ENABLED）。
 * 登录强制真实 OAuth；会话/消息持久化强制 PostgreSQL（配好 POSTGRES_* 即启用）。
 *
 * AUTH_PROVIDER 支持多值（`,` 或 `|` 分隔），例如 `feishu` / `dingtalk|feishu`：
 *   - 只有一个真实登录方式（OAuth 仅一个）→ 登录页直接跳转，不出现选择器；
 *   - 有多个 → 前端渲染登录方式选择界面。
 *
 * adaptive（自适应）：AUTH_PROVIDER=adaptive 时按客户端环境自动决定登录方式——
 *   钉钉 App 内 → 钉钉（JSAPI 免登优先，失败回退 OAuth）；飞书 App 内 → 飞书 OAuth；
 *   其他浏览器 → 渲染钉钉/飞书选择器。实际可用的 provider 由 getLoginOptions 展开为
 *   已配置完整的 OAuth 平台（钉钉 DD_* 与飞书 FS_* env 各自齐全者才会出现）。
 */
import type { AuthConfig, AuthMethod } from "./types.js";

const VALID_METHODS: readonly AuthMethod[] = ["dingtalk", "feishu", "builtin", "none", "adaptive"];

/** 解析 AUTH_PROVIDER：按 [,|] 分隔 → trim → 去重 → 过滤非法值；none 与其它值共存时忽略。 */
export function parseAuthProviders(raw: string | undefined): AuthMethod[] {
  // 未配置任何 auth provider（AUTH_PROVIDER 缺失/为空）→ 默认只启用 builtin（自建账号登录），
  // 而不是"关闭登录"：让宿主开箱即用内置登录，登录来源以应用环境变量为准。
  if (!raw) return ["builtin"];
  const parts = raw
    .split(/[,|]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  const unique: AuthMethod[] = [];
  for (const p of parts) {
    if (!(VALID_METHODS as readonly string[]).includes(p)) continue; // 非法值忽略
    if (unique.includes(p as AuthMethod)) continue; // 去重
    unique.push(p as AuthMethod);
  }
  if (unique.length === 0) return ["none"];
  // none 表示"关闭登录"，只在其单独出现时生效
  if (unique.includes("none") && unique.length > 1) {
    return unique.filter((m) => m !== "none");
  }
  return unique;
}

/** 从完整列表取主认证方式（第一个非 none 的值；不存在 → none）。 */
function primaryMethod(methods: AuthMethod[]): AuthConfig["method"] {
  const primary = methods.find((m) => m !== "none");
  return (primary as AuthConfig["method"]) ?? "none";
}

/** 解析并校验认证配置。非法值一律忽略；无任何合法值 → none。 */
export function loadAuthConfig(): AuthConfig {
  const methods = parseAuthProviders(process.env.AUTH_PROVIDER);

  const publicUrl = (process.env.APP_PUBLIC_URL || "").replace(/\/$/, "");
  const cookiePath = process.env.AUTH_COOKIE_PATH || "/linger";
  const sessionSecret =
    process.env.AUTH_SESSION_SECRET || process.env.SESSION_SECRET || "agent-kit-dev-secret";
  const secureCookie = process.env.AUTH_SECURE_COOKIE === "true";
  // 数据库持久化与开发免登为强制行为：数据必须落 PostgreSQL；登录必须是真实 OAuth。

  return {
    methods,
    method: primaryMethod(methods),
    publicUrl,
    cookiePath,
    sessionSecret,
    secureCookie,
    dingtalk: {
      clientId: process.env.DD_CLIENT_ID || "",
      clientSecret: process.env.DD_CLIENT_SECRET || "",
      corpId: process.env.DD_CORP_ID || "",
      agentId: process.env.DD_AGENT_ID || "",
      robotCode: process.env.DD_ROBOT_CODE || "",
      cardTemplateId: process.env.DD_CARD_TEMPLATE_ID || "",
      redirectUri: process.env.DD_REDIRECT_URI || undefined,
    },
    feishu: {
      appId: process.env.FS_APP_ID || "",
      appSecret: process.env.FS_APP_SECRET || "",
      baseUrl: (process.env.FS_BASE_URL || "https://open.feishu.cn").replace(/\/$/, ""),
      redirectUri: process.env.FS_REDIRECT_URI || undefined,
    },
  };
}

/** 判断某个方式是否已配置完整（OAuth 平台看对应 env）。 */
export function isMethodConfigured(config: AuthConfig, method: AuthMethod): boolean {
  if (method === "dingtalk") {
    return Boolean(config.dingtalk.clientId && config.dingtalk.clientSecret && config.dingtalk.corpId);
  }
  if (method === "feishu") {
    return Boolean(config.feishu.appId && config.feishu.appSecret);
  }
  // builtin（自建账号体系）：启用条件 = PostgreSQL 用户表可用（POSTGRES_HOST && POSTGRES_DB）。
  // 用户数据落库在 POSTGRES 的 users 表（registerBuiltinUser / verifyBuiltinPassword）。
  if (method === "builtin") return Boolean(process.env.POSTGRES_HOST && process.env.POSTGRES_DB);
  return false;
}

/** 判断当前配置是否至少有一个可用的真实登录方式。 */
export function isAuthEnabled(config: AuthConfig): boolean {
  return config.methods.some((m) => isMethodConfigured(config, m));
}
