/**
 * agent-kit · 钉钉认证提供方
 *
 * 参考 D:\Project\hotline 的钉钉登录实现，提炼为与框架无关的纯逻辑：
 *   - 网页 OAuth：login.dingtalk.com 授权 → 用 authCode 换 userAccessToken → 读 contact/users/me
 *   - 客户端内 JSAPI 免登：dd.requestAuthCode 拿到 code → 用企业凭证换 app token →
 *     getuserinfo 拿 userid → topapi/v2/user/get 拿档案
 * 全部归一化为 AuthUser，具体路由接线在 app 侧。
 */
import type { AuthProvider, AuthProviderId, AuthUser } from "../types.js";

export interface DingTalkProviderConfig {
  clientId: string;
  clientSecret: string;
  corpId: string;
}

const OAUTH_AUTHORIZE = "https://login.dingtalk.com/oauth2/auth";
const API = "https://api.dingtalk.com";
const OAPI = "https://oapi.dingtalk.com";

export function createDingTalkProvider(cfg: DingTalkProviderConfig): AuthProvider {
  const id: AuthProviderId = "dingtalk";

  function isConfigured(): boolean {
    return Boolean(cfg.clientId && cfg.clientSecret && cfg.corpId);
  }

  function getAuthorizeUrl(redirectUri: string, state: string): string {
    const url = new URL(OAUTH_AUTHORIZE);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("scope", "openid");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    return url.toString();
  }

  /** 网页 OAuth：authCode → userAccessToken → 通讯录个人信息（contact/users/me）。 */
  async function exchangeOAuthCode(code: string): Promise<AuthUser> {
    const tokenRes = await fetch(`${API}/v1.0/oauth2/userAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        code,
        grantType: "authorization_code",
      }),
      cache: "no-store",
    });
    const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
      accessToken?: string;
      corpId?: string;
    };
    if (!tokenRes.ok || !tokenJson.accessToken) {
      throw new Error(`钉钉 userAccessToken 换取失败 (${tokenRes.status})`);
    }

    // 校验登录归属组织（防止非本企业账号登录）
    if (cfg.corpId && tokenJson.corpId && tokenJson.corpId !== cfg.corpId) {
      throw new Error("当前钉钉账号不属于本企业组织");
    }

    const profileRes = await fetch(`${API}/v1.0/contact/users/me`, {
      headers: { "x-acs-dingtalk-access-token": tokenJson.accessToken },
      cache: "no-store",
    });
    const p = (await profileRes.json().catch(() => ({}))) as {
      unionId?: string;
      openId?: string;
      nick?: string;
      name?: string;
      avatarUrl?: string;
      mobile?: string;
      email?: string;
    };

    const unionId = p.unionId || "";
    const openId = p.openId || "";
    // OAuth 路径的 /v1.0/contact/users/me 只返回 unionId/openId，不返回企业内 userid；
    // 发送到钉钉会话（message/send_to_conversation 的 sender）必须用 userid，这里用
    // unionId 经 getbyunionid 实时解析并写入 userCode，避免用户表 user_code 为空导致分享失败。
    let userCode = "";
    let appToken = "";
    if (unionId) {
      try {
        appToken = await getAppToken();
        userCode = await resolveUserIdByUnionId(appToken, unionId);
      } catch {
        // 解析失败不阻断登录；发送链路还有 unionId 兜底
      }
    }
    if (!profileRes.ok || (!unionId && !openId)) {
      // OAuth code + accessToken 已证明钉钉身份，缺通讯录权限不应让合法登录失败
      console.warn("[dingtalk] profile 不可读，仅以已验证身份继续登录");
      return {
        provider: id,
        unionId: unionId || `verified:${tokenJson.accessToken.slice(0, 16)}`,
        openId,
        userCode,
        name: "钉钉用户",
        raw: { ...p, _verified: true },
      };
    }

    return {
      provider: id,
      unionId,
      openId,
      userCode,
      name: p.nick || p.name || "钉钉用户",
      avatar: p.avatarUrl || "",
      mobile: p.mobile || "",
      email: p.email || "",
      deptName: userCode ? await resolveDeptName(appToken, userCode) : undefined,
      raw: p,
    };
  }

  /** 企业应用 app token（client_credentials）。 */
  async function getAppToken(): Promise<string> {
    const appTokenRes = await fetch(`${API}/v1.0/oauth2/${encodeURIComponent(cfg.corpId)}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    });
    const appTokenJson = (await appTokenRes.json().catch(() => ({}))) as { access_token?: string };
    if (!appTokenRes.ok || !appTokenJson.access_token) {
      throw new Error(`钉钉 app token 换取失败 (${appTokenRes.status})`);
    }
    return appTokenJson.access_token as string;
  }

  /** 根据 unionId 解析企业内 userid（POST /topapi/v2/user/getbyunionid；旧路径 /topapi/user/getbyunionid 自动回退）。 */
  async function resolveUserIdByUnionId(appToken: string, unionId: string): Promise<string> {
    const body = JSON.stringify({ unionid: unionId });
    for (const path of ["topapi/v2/user/getbyunionid", "topapi/user/getbyunionid"]) {
      try {
        const res = await fetch(`${OAPI}/${path}?access_token=${encodeURIComponent(appToken)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          cache: "no-store",
        });
        const json = (await res.json().catch(() => ({}))) as { errcode?: number; result?: { userid?: string } };
        if (res.ok && json.errcode === 0 && json.result?.userid) return json.result.userid;
      } catch {
        // 换路径重试
      }
    }
    return "";
  }

  /** 用部门 id 反查部门名（取第一个；缺权限/失败时降级 undefined，不阻断登录）。 */
  async function deptNameFromIds(appToken: string, deptIds: unknown): Promise<string | undefined> {
    if (!Array.isArray(deptIds) || !deptIds.length) return undefined;
    const deptId = String(deptIds[0]);
    if (!deptId) return undefined;
    try {
      const deptRes = await fetch(`${OAPI}/topapi/v2/department/get?access_token=${encodeURIComponent(appToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dept_id: deptId, language: "zh_CN" }),
        cache: "no-store",
      });
      const deptJson = (await deptRes.json().catch(() => ({}))) as { errcode?: number; result?: { name?: string } };
      if (deptRes.ok && deptJson.errcode === 0 && deptJson.result?.name) return deptJson.result.name;
    } catch {
      /* 忽略 */
    }
    return undefined;
  }

  /** 解析钉钉用户部门：userid → user/get(dept_id_list) → department/get(name)。 */
  async function resolveDeptName(appToken: string, userId: string): Promise<string | undefined> {
    try {
      const profileRes = await fetch(`${OAPI}/topapi/v2/user/get?access_token=${encodeURIComponent(appToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userid: userId, language: "zh_CN" }),
        cache: "no-store",
      });
      const json = (await profileRes.json().catch(() => ({}))) as { errcode?: number; result?: { dept_id_list?: unknown } };
      if (profileRes.ok && json.errcode === 0) return deptNameFromIds(appToken, json.result?.dept_id_list);
    } catch {
      /* 忽略 */
    }
    return undefined;
  }

  /** 客户端内 JSAPI 免登：code → app token → getuserinfo(userid) → user/get(档案)。 */
  async function exchangeClientCode(code: string): Promise<AuthUser> {    const accessToken = await getAppToken();

    const infoRes = await fetch(
      `${OAPI}/topapi/v2/user/getuserinfo?access_token=${encodeURIComponent(accessToken)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
        cache: "no-store",
      },
    );
    const infoJson = (await infoRes.json().catch(() => ({}))) as {
      errcode?: number;
      result?: { userid?: string };
    };
    const userId = infoJson.result?.userid;
    if (!infoRes.ok || infoJson.errcode !== 0 || !userId) {
      throw new Error(`钉钉免登码验证失败 (${infoJson.errcode})`);
    }

    // 拉通讯录档案（缺权限时降级，不阻断登录）
    let profile: Record<string, unknown> = {};
    try {
      const profileRes = await fetch(
        `${OAPI}/topapi/v2/user/get?access_token=${encodeURIComponent(accessToken)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userid: userId, language: "zh_CN" }),
          cache: "no-store",
        },
      );
      const profileJson = (await profileRes.json().catch(() => ({}))) as {
        errcode?: number;
        result?: Record<string, unknown>;
      };
      if (profileRes.ok && profileJson.errcode === 0 && profileJson.result) {
        profile = profileJson.result;
      } else {
        console.warn("[dingtalk] 免登档案读取不可用，仅以 userid 建会话");
      }
    } catch (e) {
      console.warn("[dingtalk] 免登档案读取异常", e instanceof Error ? e.message : e);
    }

    return {
      provider: id,
      unionId: String(profile.unionid || userId),
      openId: "",
      userCode: userId,
      name: String(profile.name || "钉钉用户"),
      avatar: String(profile.avatar || ""),
      mobile: String(profile.mobile || ""),
      deptName: await deptNameFromIds(accessToken, profile.dept_id_list),
      raw: profile,
    };
  }

  return {
    id,
    supportsClientSso: true,
    isConfigured,
    getAuthorizeUrl,
    exchangeOAuthCode,
    exchangeClientCode,
  };
}
