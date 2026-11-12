/**
 * agent-kit · 认证类型定义
 *
 * 抽象层核心：所有认证提供方（钉钉 / 飞书 / 自建 builtin）都归一化为 AuthUser；
 * 上层（会话、数据库、路由）只认 AuthUser，不关心来自哪个平台。
 */

export type AuthProviderId = "dingtalk" | "feishu" | "builtin";

/**
 * AUTH_PROVIDER 合法取值：OAuth 平台 + builtin（自建账号体系）+ adaptive + none 关闭。
 * builtin 目前仅留口子：类型 / 配置解析 / 登录页均认可该方式，
 * 但「自建登录系统（页面 + 用户名密码会话）」尚未实现——
 * isMethodConfigured("builtin") 暂恒 false，因此 builtin 暂不会出现在登录方式清单里。
 * adaptive：按客户端 UA 自动决定走钉钉还是飞书（钉钉 App → 钉钉免登/OAuth，飞书 App → 飞书 OAuth，
 * 其他浏览器 → 渲染登录方式选择器）。配置上要求至少一个 OAuth 平台 env 齐全才能启用。
 */
export type AuthMethod = AuthProviderId | "none" | "adaptive";

/** 归一化后的用户身份（跨提供方统一结构）。 */
export interface AuthUser {
  /** 来源平台 */
  provider: AuthProviderId;
  /** 跨应用唯一 ID（钉钉 unionid / 飞书 union_id）—— 数据库主匹配键 */
  unionId: string;
  /** 企业内唯一 ID（钉钉 openId / 飞书 open_id） */
  openId: string;
  /** 企业内部工号（钉钉 userid / 飞书 employee_id），可为空 */
  userCode?: string;
  /** 展示名 */
  name: string;
  /** 头像 URL */
  avatar?: string;
  /** 邮箱（提供方返回时才有） */
  email?: string;
  /** 手机号（提供方返回时才有） */
  mobile?: string;
  /** 部门名（钉钉通讯录可解析；飞书需额外权限） */
  deptName?: string;
  /** OAuth 令牌（不落 session，仅用于落库持久化：飞书用户身份发消息等场景） */
  oauthToken?: {
    accessToken: string;
    refreshToken?: string;
  };
  /** 提供方原始档案（落库到 raw_profile），便于扩展字段 */
  raw?: Record<string, unknown>;
}

/** 写入会话 Cookie 的精简用户（无敏感字段）。 */
export interface SessionUser {
  /** 用户主体键：${provider}:${unionId} —— 全链路（会话 / 归属 / 分享 / DB）以此为准 */
  sub: string;
  provider: AuthProviderId;
  unionId: string;
  openId: string;
  name: string;
  avatar?: string;
  exp: number;
}

/**
 * 认证提供方抽象接口。
 * 每个具体实现（钉钉 / 飞书）只需实现：构建网页 OAuth 授权 URL、用网页 code 换用户、
 * 以及可选的客户端内 JSAPI 免登 code 换用户。
 *
 * 注意：builtin（自建账号体系）不是 OAuth 平台，不实现本接口；
 * 其登录系统（页面 + 用户名密码校验 + 会话签发）后续单独实现，届时复用 finalizeLogin 落库与会话。
 */
export interface AuthProvider {
  /** 提供方标识 */
  readonly id: AuthProviderId;
  /** 是否支持客户端内 JSAPI 免登（钉钉/飞书均支持） */
  readonly supportsClientSso: boolean;
  /** 是否已配置完该方式所需的全部 env（未配置时不应启用） */
  isConfigured(): boolean;
  /** 构建网页 OAuth 授权 URL（用户扫码 / 授权页） */
  getAuthorizeUrl(redirectUri: string, state: string): string;
  /** 用网页 OAuth 的 auth code 换取归一化用户 */
  exchangeOAuthCode(code: string, redirectUri?: string): Promise<AuthUser>;
  /** 用客户端内 JSAPI 免登 code 换取归一化用户（可选） */
  exchangeClientCode?(code: string): Promise<AuthUser>;
}

/** 认证配置（由 env 解析，见 config.ts）。 */
export interface AuthConfig {
  /**
   * AUTH_PROVIDER 完整解析结果（按 `,` 或 `|` 分隔、去重、过滤非法值、忽略 none 与其它值共存时的 none）。
   * 可含 builtin / dingtalk / feishu；顺序即展示顺序。
   */
  methods: AuthMethod[];
  /**
   * 主认证方式（methods 中第一个非 none 的值；不存在时 "none"）。
   * 保留给单方式场景与历史逻辑：dingtalk | feishu | builtin | adaptive | none
   */
  method: "dingtalk" | "feishu" | "builtin" | "adaptive" | "none";
  /** 对外基础地址（拼接回调跳转用），如 http://localhost:3100 */
  publicUrl: string;
  /** 会话 Cookie 路径（需与 Next basePath 一致，如 /agent） */
  cookiePath: string;
  /** 会话签名密钥 */
  sessionSecret: string;
  /** Cookie 是否 secure */
  secureCookie: boolean;
  /** 钉钉配置（method=dingtalk 时必填） */
  dingtalk: {
    clientId: string;
    clientSecret: string;
    corpId: string;
    /** 企业内部应用微应用 AgentId（env DD_AGENT_ID）。H5 JSAPI 前端鉴权（分享到钉钉会话）必填 */
    agentId: string;
    /** 机器人 code（env DD_ROBOT_CODE，可选）。发送群消息用；未配置时默认用 clientId（企业内部应用机器人 code = AppKey） */
    robotCode?: string;
    /** 互动卡片模板 ID（env DD_CARD_TEMPLATE_ID）。用户身份发送分享（sendMessageToGroup）必填；在钉钉开发者后台「卡片平台」创建模板后获取 */
    cardTemplateId?: string;
    redirectUri?: string;
  };
  /** 飞书配置（method=feishu 时必填）。仅支持企业内部应用（isv 应用商店应用未实现） */
  feishu: {
    appId: string;
    appSecret: string;
    baseUrl: string;
    redirectUri?: string;
  };
}
