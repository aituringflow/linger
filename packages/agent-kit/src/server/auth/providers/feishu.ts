/**
 * agent-kit · 飞书认证提供方
 *
 * 与钉钉对称实现，统一归一到 AuthUser：
 *   - 网页 OAuth：open.feishu.cn 授权 → app_access_token → OIDC user_access_token → user_info
 *   - 客户端内 JSSDK 免登：tt.requestAuthCode 拿到的 code 同样走 OIDC 换取（飞书 code 通用）
 * 默认域名 open.feishu.cn（中国区），可用 FS_BASE_URL 覆盖（国际版 app.feishu.com）。
 */
import type { AuthProvider, AuthProviderId, AuthUser } from "../types.js";

export interface FeishuProviderConfig {
  appId: string;
  appSecret: string;
  baseUrl: string;
}

export function createFeishuProvider(cfg: FeishuProviderConfig): AuthProvider {
  const id: AuthProviderId = "feishu";
  const base = cfg.baseUrl;

  function isConfigured(): boolean {
    return Boolean(cfg.appId && cfg.appSecret);
  }

  function getAuthorizeUrl(redirectUri: string, state: string): string {
    const url = new URL(`${base}/open-apis/authen/v1/authorize`);
    url.searchParams.set("app_id", cfg.appId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    // 空格分隔：im:message = 用户身份读取/发送消息（分享「以当前用户身份发消息」）；
    // offline_access = 换取 refresh_token（user_access_token 2h 过期后刷新续期）
    url.searchParams.set("scope", "im:message contact:user:search offline_access");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** 取企业内部应用 app_access_token（仅支持 internal；ISV 应用需 app_ticket 流程，未实现）。 */
  async function getAppAccessToken(): Promise<string> {
    const res = await fetch(`${base}/open-apis/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const token = (json.app_access_token as string) || (json.data as { app_access_token?: string })?.app_access_token;
    if (!res.ok || !token) {
      throw new Error(`飞书 app_access_token 换取失败 (${res.status})`);
    }
    return token;
  }

  /** OIDC：用 authorization_code 换 user_access_token（网页与客户端 code 通用）。 */
  async function exchangeOidcCode(code: string): Promise<AuthUser> {
    const appAccessToken = await getAppAccessToken();

    const tokenRes = await fetch(`${base}/open-apis/authen/v1/oidc/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        app_access_token: appAccessToken,
      }),
      cache: "no-store",
    });
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
    const data = (tokenJson.data as Record<string, unknown>) || tokenJson;
    const userAccessToken = (data.access_token as string) || (tokenJson.access_token as string);
    if (!tokenRes.ok || !userAccessToken) {
      // 附带飞书业务错误码/信息（HTTP 200 + JSON 错误），便于定位 20003 等
      const detail = tokenJson.code != null ? `code=${tokenJson.code} msg=${tokenJson.msg ?? ""}` : "";
      throw new Error(`飞书 user_access_token 换取失败 (${tokenRes.status}) ${detail}`.trim());
    }

    const infoRes = await fetch(`${base}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
      cache: "no-store",
    });
    const infoJson = (await infoRes.json().catch(() => ({}))) as Record<string, unknown>;
    const u = (infoJson.data as Record<string, unknown>) || infoJson;

    // 令牌随用户落库（oauthToken），供「以当前用户身份发消息」等服务端调用使用；
    // refresh_token 仅在申请了 offline_access scope 时返回
    const oauthToken = {
      accessToken: userAccessToken,
      refreshToken: (data.refresh_token as string) || undefined,
    };

    const unionId = String(u.union_id || u.unionId || "");
    const openId = String(u.open_id || u.openId || "");
    if (!infoRes.ok || (!unionId && !openId)) {
      console.warn("[feishu] user_info 不可读，仅以已验证身份继续登录");
      return {
        provider: id,
        unionId: unionId || `verified:${userAccessToken.slice(0, 16)}`,
        openId,
        name: "飞书用户",
        oauthToken,
        raw: { ...u, _verified: true },
      };
    }

    // 尝试补充部门名：users.get 返回 department_names（需「获取用户组织架构信息」权限，
    // 授权 URL 未含该 scope 时失败静默降级，不阻断登录）
    let deptName: string | undefined;
    try {
      const profileRes = await fetch(`${base}/open-apis/contact/v3/users/${encodeURIComponent(openId)}?user_id_type=open_id`, {
        headers: { Authorization: `Bearer ${userAccessToken}` },
        cache: "no-store",
      });
      const profileJson = (await profileRes.json().catch(() => ({}))) as Record<string, unknown>;
      const p = (profileJson.data as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined;
      const names = p?.department_names as unknown;
      if (Array.isArray(names) && names.length) deptName = String(names[0]);
    } catch {
      /* 部门不可读时忽略，仅展示组织名 */
    }

    return {
      provider: id,
      unionId,
      openId,
      userCode: String(u.employee_id || u.employeeId || ""),
      name: String(u.name || "飞书用户"),
      avatar: String(u.avatar_url || u.avatarUrl || ""),
      email: String(u.email || ""),
      mobile: String(u.mobile || ""),
      deptName,
      oauthToken,
      raw: u as Record<string, unknown>,
    };
  }

  return {
    id,
    supportsClientSso: true,
    isConfigured,
    getAuthorizeUrl,
    exchangeOAuthCode: exchangeOidcCode,
    exchangeClientCode: exchangeOidcCode,
  };
}
