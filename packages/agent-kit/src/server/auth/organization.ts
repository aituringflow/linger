import type { AuthConfig, AuthProviderId } from "./types.js";
import { getDingTalkToken, getFeishuTenantToken } from "../oa.js";

const organizationCache = new Map<string, { name: string; expiresAt: number }>();

/** Best-effort organization label for the signed-in tenant. Never blocks session validation. */
export async function getOrganizationName(provider: AuthProviderId, config: AuthConfig): Promise<string> {
  if (provider !== "dingtalk" && provider !== "feishu") return "";
  const cacheKey = provider === "dingtalk" ? `dd:${config.dingtalk.corpId}` : `fs:${config.feishu.appId}`;
  const cached = organizationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.name;
  try {
    let name = "";
    if (provider === "dingtalk") {
      const token = await getDingTalkToken(config.dingtalk.clientId, config.dingtalk.clientSecret);
      const response = await fetch(`https://oapi.dingtalk.com/topapi/v2/department/get?access_token=${encodeURIComponent(token)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dept_id: 1 }), signal: AbortSignal.timeout(5000),
      });
      const data = await response.json();
      if (response.ok && data.errcode === 0) name = String(data.result?.name || "");
    } else {
      const token = await getFeishuTenantToken(config.feishu.appId, config.feishu.appSecret, config.feishu.baseUrl);
      const response = await fetch(`${config.feishu.baseUrl}/open-apis/tenant/v2/tenant/query`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
      });
      const data = await response.json();
      if (response.ok && data.code === 0) name = String(data.data?.tenant?.name || "");
    }
    organizationCache.set(cacheKey, { name, expiresAt: Date.now() + (name ? 60 * 60 * 1000 : 60 * 1000) });
    return name;
  } catch (error) {
    console.warn("[agent-kit auth] organization name unavailable", error instanceof Error ? error.message : error);
    return "";
  }
}
