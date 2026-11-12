/**
 * agent-kit · OA 开放平台客户端（钉钉 / 飞书）
 *
 * 用途：会话分享「发送到 OA」链路。
 *   - 钉钉：前端在钉钉客户端内用 JSAPI 选择会话（chooseConversationByCorpId）拿到一次性 cid，
 *     服务端用企业内部应用 access_token 调「发送普通消息」message/send_to_conversation；
 *   - 飞书：前端在飞书客户端内用 H5 JSAPI chooseChat 拿到 open_chat_id，
 *     服务端用 tenant_access_token 调 im/v1/messages 发送文本。
 *
 * 凭证来自认证 env（DD_CLIENT_ID/DD_CLIENT_SECRET、FS_APP_ID/FS_APP_SECRET），
 * access_token / jsapi_ticket 进程级内存缓存（接近过期时提前 5 分钟刷新）。
 *
 * 签名：钉钉/飞书 H5 JSAPI 前端鉴权均为
 *   signature = sha1(jsapi_ticket + nonceStr + timeStamp + url)
 * （拼接顺序固定，见两家开放平台 JSAPI 鉴权文档）。
 */
import { createHash } from "node:crypto";

// ----------------------------- 内存缓存 -----------------------------

const CACHE_TTL_MS = 100 * 60 * 1000; // 100 分钟（token/ticket 有效期 2 小时，提前 20 分钟刷新）
const cache = new Map<string, { value: string; expiresAt: number }>();

function cacheGet(key: string): string | null {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() >= item.expiresAt) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key: string, value: string, ttlMs = CACHE_TTL_MS): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** 简单 JSON 请求封装：非 2xx 抛错（带响应体摘要）。 */
async function apiFetchJson(url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`OA 接口返回非 JSON（${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const msg =
      (data && (data.message || data.msg || data.errmsg)) || `HTTP ${res.status}`;
    throw new Error(`OA 接口错误：${msg}`);
  }
  return data;
}

// ----------------------------- 钉钉 -----------------------------

/** 钉钉企业内部应用 access_token（gettoken）。 */
export async function getDingTalkToken(
  appKey: string,
  appSecret: string,
): Promise<string> {
  const key = `dd:token:${appKey}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await apiFetchJson(
    `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(appKey)}&appsecret=${encodeURIComponent(appSecret)}`,
    { method: "GET" },
  );
  if (!data.access_token) throw new Error(`钉钉 gettoken 失败：${data.errmsg || "无 access_token"}`);
  cacheSet(key, data.access_token);
  return data.access_token as string;
}

/** 钉钉 jsapi_ticket（H5 JSAPI 前端鉴权用）。 */
export async function getDingTalkJsapiTicket(appKey: string, appSecret: string): Promise<string> {
  const key = `dd:ticket:${appKey}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const token = await getDingTalkToken(appKey, appSecret);
  const data = await apiFetchJson(
    `https://oapi.dingtalk.com/get_jsapi_ticket?access_token=${encodeURIComponent(token)}`,
    { method: "GET" },
  );
  if (!data.ticket) throw new Error(`钉钉 get_jsapi_ticket 失败：${data.errmsg || "无 ticket"}`);
  cacheSet(key, data.ticket);
  return data.ticket as string;
}

/**
 * 根据 unionId 解析企业内 userid（OAuth 登录未落 user_code 时，分享发送链路兜底用）。
 * 接口：POST /topapi/v2/user/getbyunionid（文档另列旧路径 /topapi/user/getbyunionid，失败自动回退）。
 * 权限：成员信息读权限；缺权限或解析失败返回空串，由调用方决定如何报错。
 */
export async function resolveDingTalkUserIdByUnionId(
  appKey: string,
  appSecret: string,
  unionId: string,
): Promise<string> {
  if (!unionId) return "";
  const token = await getDingTalkToken(appKey, appSecret);
  const body = JSON.stringify({ unionid: unionId });
  for (const path of ["topapi/v2/user/getbyunionid", "topapi/user/getbyunionid"]) {
    try {
      const data = await apiFetchJson(`https://oapi.dingtalk.com/${path}?access_token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const code = String(data.errcode ?? data.errcode);
      if (code === "0" || code === "0.0") {
        const userid = (data.result as { userid?: unknown } | undefined)?.userid;
        if (typeof userid === "string" && userid) return userid;
      }
    } catch {
      // 换路径重试
    }
  }
  return "";
}

/** 钉钉 H5 JSAPI dd.config 签名参数（企业内部应用 · 官方新版算法）。
 *
 * 重要（2025+ 新版网页应用/H5 微应用，见开放平台《JSAPI鉴权》/《开发网页应用前端》）：
 *   plain = "jsapi_ticket=" + ticket + "&noncestr=" + nonceStr + "&timestamp=" + timeStamp + "&url=" + decodeUrl(url)
 *   signature = SHA256(plain)
 * 旧版微应用是 sha1(ticket+nonceStr+timeStamp+url) 纯拼接，新版必须用上面的键值对 + SHA-256，
 * 否则钉钉端重算签名不一致 → dd.config 报 errorCode 9「签名校验失败」（参数全一致也会失败）。
 */
export async function dingTalkJsapiConfig(
  appKey: string,
  appSecret: string,
  corpId: string,
  agentId: string,
  url: string,
): Promise<{ agentId: string; corpId: string; timeStamp: string; nonceStr: string; signature: string }> {
  const ticket = await getDingTalkJsapiTicket(appKey, appSecret);
  const timeStamp = String(Date.now());
  const nonceStr = randomStr(16);
  const plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timeStamp}&url=${decodeUrl(url)}`;
  // 诊断日志：钉钉 dd.config 报「签名校验失败」时，用这里的参数与钉钉报错逐字段比对
  //（重点看 url 是否与钉钉记录的页面 url 完全一致——大小写/末尾斜杠/query/端口）
  console.log(
    `[agent-kit oa] dingtalk jsapi-sign: ticket=${ticket.slice(0, 8)}… nonce=${nonceStr} ` +
      `timestamp=${timeStamp} url=${url} agentId=${agentId} corpId=${corpId.slice(0, 8)}…`,
  );
  return {
    agentId,
    corpId,
    timeStamp,
    nonceStr,
    signature: sha256(plain),
  };
}

/**
 * 官方 decodeUrl：iOS 端传入的 url 是 encode 过的、Android 是原始 url，
 * 统一按「协议 + 主机 + 路径 + (query 做 URL 解码)」重建，避免编码不一致导致签名校验失败。
 * 与官方 Java 示例（URL.getProtocol/getAuthority/getPath/getQuery + URLDecoder）等价。
 */
function decodeUrl(url: string): string {
  try {
    const u = new URL(url);
    let out = `${u.protocol}//${u.host}${u.pathname}`;
    if (u.search) out += `?${decodeURIComponent(u.search.slice(1))}`;
    return out;
  } catch {
    return url;
  }
}

/**
 * 钉钉「发送普通消息」：向 JSAPI 选中的一次性会话 cid 发消息。
 * opts.url 提供时发 markdown 消息（title + 链接），钉钉客户端渲染为带预览的链接卡片；
 * 否则回退纯文本（兼容旧调用）。
 */
export async function sendDingTalkMessage(
  appKey: string,
  appSecret: string,
  cid: string,
  sender: string,
  text: string,
  opts?: { title?: string; url?: string },
): Promise<void> {
  const token = await getDingTalkToken(appKey, appSecret);
  let msg: Record<string, unknown>;
  if (opts?.url) {
    // markdown 消息：title 显示为消息头部，正文里的 [text](url) 是点击即打开的链接（带预览）
    msg = {
      msgtype: "markdown",
      markdown: {
        title: (opts.title || "AI 对话分享").slice(0, 60),
        text: `### ${opts.title || "AI 对话分享"}\n${text.slice(0, 1500)}\n\n[打开对话](${opts.url})`,
      },
    };
  } else {
    msg = { msgtype: "text", text: { content: text.slice(0, 2000) } };
  }
  const data = await apiFetchJson(
    `https://oapi.dingtalk.com/message/send_to_conversation?access_token=${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, cid, msg }),
    },
  );
  // 该接口成功时 errcode 可能为字符串 "0"
  const code = String(data.errcode ?? data.errcode);
  if (code !== "0" && code !== "0.0") {
    throw new Error(`钉钉发送失败：${data.errmsg || data.message || JSON.stringify(data).slice(0, 200)}`);
  }
}

// ----------------------------- 飞书 -----------------------------

/** 飞书 tenant_access_token（企业内部应用）。 */
export async function getFeishuTenantToken(
  appId: string,
  appSecret: string,
  baseUrl: string,
): Promise<string> {
  const key = `fs:token:${appId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await apiFetchJson(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!data.tenant_access_token) throw new Error(`飞书 tenant_access_token 失败：${data.msg || "无 token"}`);
  const expireSec = Number(data.expire || 7200);
  cacheSet(key, data.tenant_access_token, (expireSec - 300) * 1000);
  return data.tenant_access_token as string;
}

/** 飞书 jsapi_ticket（H5 JSAPI 前端鉴权用）。 */
export async function getFeishuJsapiTicket(
  appId: string,
  appSecret: string,
  baseUrl: string,
): Promise<string> {
  const key = `fs:ticket:${appId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const token = await getFeishuTenantToken(appId, appSecret, baseUrl);
  const data = await apiFetchJson(`${baseUrl}/open-apis/jssdk/ticket/get`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  // 兼容两种返回结构：官方为 { code, msg, data: { ticket, expire_in } }，部分网关可能平铺到顶层
  const ticket =
    (data?.data && typeof data.data.ticket === "string" && data.data.ticket) ||
    (typeof data.ticket === "string" ? data.ticket : "");
  if (!ticket) throw new Error(`飞书 jssdk ticket 失败：${data.msg || "无 ticket"}`);
  cacheSet(key, ticket);
  return ticket as string;
}

/** 飞书 H5 JSAPI（window.h5sdk.config）签名参数。 */
export async function feishuJsapiConfig(
  appId: string,
  appSecret: string,
  baseUrl: string,
  url: string,
): Promise<{ appId: string; timestamp: number; nonceStr: string; signature: string }> {
  const ticket = await getFeishuJsapiTicket(appId, appSecret, baseUrl);
  const timestamp = Date.now();
  const nonceStr = randomStr(16);
  // 飞书拼接规则（与钉钉不同！）：key=value& 键值对格式，字段名小写，
  // 顺序固定 jsapi_ticket → noncestr → timestamp → url，url 不含 # 后部分（保留 query）。
  const plain = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  return { appId, timestamp, nonceStr, signature: sha1(plain) };
}

/**
 * 飞书「发送消息」到会话（chat_id）。
 * opts.url 提供时发 link 消息（title/text/message_link），飞书客户端渲染为链接卡片预览；
 * 否则回退文本消息（兼容旧调用）。
 */
export async function sendFeishuMessage(
  appId: string,
  appSecret: string,
  baseUrl: string,
  chatId: string,
  text: string,
  opts?: { title?: string; url?: string },
): Promise<void> {
  const token = await getFeishuTenantToken(appId, appSecret, baseUrl);
  let msgType: string;
  let content: string;
  if (opts?.url) {
    msgType = "link";
    content = JSON.stringify({
      title: (opts.title || "AI 对话分享").slice(0, 120),
      text: text.slice(0, 500),
      message_link: opts.url,
    });
  } else {
    msgType = "text";
    content = JSON.stringify({ text: text.slice(0, 2000) });
  }
  const data = await apiFetchJson(
    `${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content,
      }),
    },
  );
  // 成功时 code 恒为数字 0；缺失或非 0 视为失败（不能用 !data.code：!0 === true）
  if (data.code !== 0) {
    throw new Error(`飞书发送失败：${data.msg || JSON.stringify(data).slice(0, 200)}`);
  }
}

/**
 * 飞书「以当前用户身份」发送消息（user_access_token）。
 * 不要求应用机器人加入目标会话（用户本就在自己的会话里）；
 * 需应用开通 im:message + im:message.send_as_user（用户身份读发消息）且 OAuth 授权 scope 含 im:message。
 * 注意：im/v1/messages 不支持 msg_type=link（历史 API 才有），带链接时发 interactive 卡片：
 * 大卡片 + 标题竖线 + 直接展示聊天摘要 + 整卡点击跳转（豆包分享同款样式）。
 */
export async function sendFeishuMessageAsUser(
  userAccessToken: string,
  baseUrl: string,
  chatId: string,
  text: string,
  opts?: { title?: string; url?: string; chatSummary?: string },
): Promise<void> {
  let msgType: string;
  let content: string;
  if (opts?.url) {
    msgType = "interactive";
    const summary = escapeCardMarkdown(opts.chatSummary || text.slice(0, 500));
    const title = escapeCardMarkdown((opts.title || "AI 对话分享").slice(0, 60));
    // 卡片 JSON 1.0：card_link 是「卡片整体点击跳转链接」（官方能力，1.0/2.0 均支持），
    // 点击卡片任意区域即跳转分享页；div 元素的 url 属性在部分客户端不生效，不再使用
    const card = {
      config: { wide_screen_mode: true },
      card_link: { url: opts.url },
      elements: [
        // 标题：左侧竖线 + 加粗标题（豆包分享同款 border-left 样式）
        { tag: "div", text: { tag: "lark_md", content: `**▎${title}**` } },
        // 聊天摘要：直接展示会话内容
        { tag: "div", text: { tag: "lark_md", content: summary.slice(0, 1500) } },
        // 底部提示（非链接样式）：点击卡片任意处跳转
        { tag: "div", text: { tag: "lark_md", content: "— 点击查看完整对话 —" } },
      ],
    };
    content = JSON.stringify(card);
  } else {
    msgType = "text";
    content = JSON.stringify({ text: text.slice(0, 2000) });
  }
  const data = await apiFetchJson(
    `${baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userAccessToken}`,
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: msgType,
        content,
      }),
    },
  );
  if (data.code !== 0) {
    throw new Error(`飞书发送失败：${data.msg || JSON.stringify(data).slice(0, 200)}`);
  }
}

/**
 * 飞书 user_access_token 刷新（OAuth offline_access scope）。
 * 返回 { accessToken, refreshToken }；refreshToken 为空时表示飞书未返回新刷新令牌（保留旧值）。
 */
export async function refreshFeishuUserToken(
  appId: string,
  appSecret: string,
  baseUrl: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const appAccessToken = await getFeishuAppAccessToken(appId, appSecret, baseUrl);
  const data = await apiFetchJson(`${baseUrl}/open-apis/authen/v1/refresh_access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      app_access_token: appAccessToken,
    }),
  });
  if (data.code !== 0 || !data.data?.access_token) {
    throw new Error(`飞书 user_access_token 刷新失败：${data.msg || JSON.stringify(data).slice(0, 200)}`);
  }
  return {
    accessToken: String(data.data.access_token),
    refreshToken: typeof data.data.refresh_token === "string" ? data.data.refresh_token : null,
  };
}

/** 飞书 app_access_token（内部应用；OAuth token 刷新等场景用）。 */
export async function getFeishuAppAccessToken(
  appId: string,
  appSecret: string,
  baseUrl: string,
): Promise<string> {
  const key = `fs:app-token:${appId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await apiFetchJson(`${baseUrl}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const token = data.app_access_token || data.data?.app_access_token;
  if (!token) throw new Error(`飞书 app_access_token 失败：${data.msg || "无 token"}`);
  cacheSet(key, token as string, 6900_000);
  return token as string;
}

/**
 * 钉钉机器人发送群聊消息（企业内部应用机器人）。
 * POST /v1.0/robot/groupMessages/send —— 接受 chooseChat 选会话返回的 openConversationId（旧接口
 * send_to_conversation 只认旧格式 cid 且"不再支持新应用接入"，故改用本接口）。
 * 前置条件：应用已申请「企业内机器人发送消息权限」，且机器人已加入目标群。
 * robotCode 未显式配置时用应用 AppKey（企业内部应用机器人 code = AppKey）。
 */
export async function sendDingTalkRobotGroupMessage(
  appKey: string,
  appSecret: string,
  robotCode: string,
  openConversationId: string,
  markdown: { title: string; text: string },
): Promise<void> {
  const token = await getDingTalkToken(appKey, appSecret);
  await apiFetchJson(`https://api.dingtalk.com/v1.0/robot/groupMessages/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": token,
    },
    body: JSON.stringify({
      msgKey: "sampleMarkdown",
      msgParam: JSON.stringify(markdown),
      openConversationId,
      robotCode,
    }),
  });
}

// ----------------------------- 工具 -----------------------------

function randomStr(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const bytes = createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest();
  for (let i = 0; i < len; i++) out += chars[bytes[i % bytes.length] % chars.length];
  return out;
}

/** 转义卡片 markdown 里的特殊字符，避免聊天内容破坏卡片渲染。 */
function escapeCardMarkdown(input: string): string {
  return input.replace(/([\\`*_[\]()#~|>+\-!])/g, "\\$1");
}

function sha1(input: string): string {
  return createHash("sha1").update(input, "utf8").digest("hex");
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
