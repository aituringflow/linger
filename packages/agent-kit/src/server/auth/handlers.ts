/**
 * agent-kit · 登录路由工厂（Next.js App Router）
 *
 * 第三方 Next.js 工程一行引入即可获得完整登录能力，无需重写 OAuth / 回调 / 免登 / 会话 /
 * 登出逻辑：
 *
 *   // app/api/auth/login/route.js
 *   import { createLoginHandlers } from "agent-kit";
 *   export const runtime = "nodejs";
 *   export const { GET } = createLoginHandlers().login;
 *
 *   // app/api/auth/callback/route.js  -> .callback
 *   // app/api/auth/sso/route.js       -> .sso
 *   // app/api/auth/session/route.js   -> .session
 *   // app/api/auth/logout/route.js    -> .logout
 *
 * 设计要点：
 *   - 采用标准 Web Response + 手写 Set-Cookie，不依赖 next/server，保证 agent-kit 自包含、可复用；
 *   - 仅暴露 AuthProvider 抽象与归一化 AuthUser，不感知钉钉/飞书差异；
 *   - 数据库落库（users 表 upsert）在已配置 Postgres 时生效。
 */
import { getOrganizationName } from "./organization.js";
import { loadAuthConfig } from "./config.js";
import {
  createSessionToken,
  verifySessionToken,
  toSessionUser,
  generateState,
  sessionCookieOptions,
  stateCookieOptions,
} from "./session.js";
import { createProvider, createProviderFor } from "./providers/index.js";
import { resolveLoginOptions } from "./login-options.js";
import { upsertUser, touchLastLogin, isDbEnabled, findUserByProvider, updateUserProfile, deleteUserByProvider } from "./db.js";
import { registerBuiltinUser, verifyBuiltinPassword } from "./builtin.js";
import { userFilesRoot } from "../user-files.js";
import fs from "node:fs/promises";
import type { AuthConfig, AuthUser, SessionUser } from "./types.js";

const SESSION_COOKIE = "agent_session";
const STATE_COOKIE = "agent_oauth_state";
const NEXT_COOKIE = "agent_login_next";

// ----------------------------- Cookie 工具（手写，避免引入 next/server） -----------------------------

function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function setCookie(headers: Headers, name: string, value: string, opts: { path: string; secure: boolean; maxAge: number }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  headers.append("Set-Cookie", parts.join("; "));
}

function clearCookie(headers: Headers, name: string, path: string, secure = false) {
  const parts = [`${name}=`, `Path=${path}`, "Max-Age=0", "HttpOnly"];
  // 必须与下发时一致（secure 时 SameSite=None 才能匹配清除 Secure Cookie）
  parts.push(secure ? "SameSite=None" : "SameSite=Lax");
  if (secure) parts.push("Secure");
  headers.append("Set-Cookie", parts.join("; "));
}

/** 解析对外 origin：优先 env（APP_PUBLIC_URL），否则用请求头（x-forwarded-host / host）推断。
 *  注意：不能依赖 `new URL(request.url).origin`——Next.js dev 模式下 request.url 的 host 固定为
 *  localhost（忽略实际 Host header），会导致回调地址与真实访问地址不一致。 */
function publicOrigin(request: Request, config: AuthConfig): string {
  if (config.publicUrl) return config.publicUrl;
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (host) return `${proto}://${host}`;
  try {
    return new URL(request.url).origin;
  } catch {
    return `${proto}://localhost`;
  }
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

/** 小型 JSON 响应助手：错误分支统一带上中文 message（前端直接展示）。 */
function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function safeNext(value: string | undefined, config: AuthConfig): string {
  // 防止开放重定向：仅允许跳回本站 basePath 下的路径
  const prefix = config.cookiePath; // 通常等于 basePath
  // 兜底必须去尾斜杠再拼，避免 cookiePath="/" 时拼出 "//"（protocol-relative URL，
  // new URL("//", base) 抛 Invalid URL，导致登录成功后回跳失败）
  const fallback = `${prefix.replace(/\/+$/, "")}/`;
  return value && (value === prefix || value.startsWith(`${prefix.replace(/\/+$/, "")}/`)) && !value.startsWith("//") ? value : fallback;
}

function loginError(request: Request, config: AuthConfig, reason: string): Response {
  const url = new URL(`${publicOrigin(request, config)}${config.cookiePath.replace(/\/+$/, "")}/login`);
  url.searchParams.set("error", reason);
  return redirect(url.toString());
}

// ----------------------------- 会话读取 -----------------------------

/** 校验请求中的会话 Cookie，返回 SessionUser 或 null。 */
export function verifySession(request: Request, config: AuthConfig): SessionUser | null {
  return verifySessionToken(getCookie(request, SESSION_COOKIE), config.sessionSecret);
}

/** 便捷方法：自动读取认证配置并校验会话。 */
export function getSessionUser(request: Request): SessionUser | null {
  return verifySession(request, loadAuthConfig());
}

// ----------------------------- 登录后置：落库 + 写会话 -----------------------------

async function finalizeLogin(
  authUser: AuthUser,
  request: Request,
  config: AuthConfig,
  next: string,
): Promise<Response> {
  // 落库仅用于同步企业档案 / OAuth 令牌（users 表）；用户主体键一律用 provider 侧
  // 标识（sub = provider:unionId），不再把内部自增 id 写进会话。
  if (isDbEnabled()) {
    try {
      const dbUser = await upsertUser(authUser);
      if (dbUser) await touchLastLogin(dbUser.id);
    } catch (e) {
      console.error("[agent-kit auth] user upsert failed (login continues)", e instanceof Error ? e.message : e);
    }
  }

  const sessionUser = toSessionUser(authUser);
  const token = createSessionToken(sessionUser, config.sessionSecret);

  const headers = new Headers();
  setCookie(headers, SESSION_COOKIE, token, sessionCookieOptions(config.cookiePath, config.secureCookie));
  clearCookie(headers, STATE_COOKIE, config.cookiePath, config.secureCookie);
  clearCookie(headers, NEXT_COOKIE, config.cookiePath, config.secureCookie);

  // 客户端免登（sso）返回 JSON；网页 OAuth 回调返回重定向。
  // 注意：两个分支都必须携带同一组 headers（含会话 Set-Cookie）——直接复用 Headers 实例，
  // 不能用 Object.fromEntries 展开（多个 Set-Cookie 会被合并破坏）。
  const isSso = request.method === "POST";
  if (isSso) {
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ ok: true, next }), {
      status: 200,
      headers,
    });
  }
  headers.set("Location", new URL(next, publicOrigin(request, config)).toString());
  return new Response(null, { status: 302, headers });
}

// ----------------------------- 路由工厂 -----------------------------

export interface LoginHandlers {
  login: { GET: (request: Request) => Promise<Response> | Response; POST: (request: Request) => Promise<Response> };
  register: { POST: (request: Request) => Promise<Response> };
  callback: { GET: (request: Request) => Promise<Response> | Response };
  sso: { POST: (request: Request) => Promise<Response> | Response };
  session: { GET: (request: Request) => Promise<Response> | Response };
  logout: { POST: (request: Request) => Promise<Response> | Response };
  /** 修改自己的展示名 / 头像（user_code 不可改）。 */
  profile: { PATCH: (request: Request) => Promise<Response> | Response };
  /** 彻底删除自己的账号（数据不可恢复）。 */
  deleteAccount: { POST: (request: Request) => Promise<Response> | Response };
}

export interface LoginHandlersOptions {
  /** 覆盖从 env 读取的认证配置（测试注入用） */
  config?: AuthConfig;
}

export function createLoginHandlers(options: LoginHandlersOptions = {}): LoginHandlers {
  const config = options.config ?? loadAuthConfig();
  const mainProvider = createProvider(config);

  // 按指定方式执行登录：dingtalk/feishu → 跳 OAuth 授权页（dev 免登已移除）。
  // builtin（自建账号体系）留口子：登录系统尚未实现，这里直接返回 config 错误；
  // 后续实现时在此分支加入「校验用户名密码 → finalizeLogin」即可。
  function loginWith(request: Request, id: string): Promise<Response> | Response {
    if (id === "builtin" && builtinEnabled(request)) {
      const url = new URL(`${publicOrigin(request, config)}${config.cookiePath.replace(/\/+$/, "")}/login`);
      url.searchParams.set("next", safeNext(new URL(request.url).searchParams.get("next") || "", config));
      return redirect(url.toString());
    }
    if (id !== "dingtalk" && id !== "feishu") return loginError(request, config, "config");
    const provider = createProviderFor(config, id);
    if (!provider) return loginError(request, config, "config");

    const state = generateState();
    const origin = publicOrigin(request, config);
    // cookiePath 去尾斜杠再拼，避免 "/" 时拼出 "//api/auth/callback"
    const callbackBase = `${origin}${config.cookiePath.replace(/\/+$/, "")}/api/auth/callback`;
    const redirectUri =
      id === "dingtalk"
        ? config.dingtalk.redirectUri || callbackBase
        : config.feishu.redirectUri || callbackBase;

    const authUrl = provider.getAuthorizeUrl(redirectUri, state);
    // 诊断锚点：打印实际回调 URI，便于核对应用后台「重定向 URL」白名单是否包含它
    //（白名单不匹配是 OAuth code 换取失败的最常见原因：返回 200 + 无 access_token）
    console.log(`[agent-kit auth] ${id} login redirect redirect_uri=${redirectUri} clientId=${config.dingtalk.clientId || config.feishu.appId ? "set" : "missing"}`);

    const headers = new Headers();
    // state cookie 携带 provider 前缀（adaptive 模式回调时据此路由到对应平台）：
    //   值格式 `${id}:${state}`；旧格式（无前缀，单方式遗留 cookie）回调时回退 mainProvider
    setCookie(headers, STATE_COOKIE, `${id}:${state}`, stateCookieOptions(config.cookiePath, config.secureCookie));
    const next = safeNext(new URL(request.url).searchParams.get("next") || "", config);
    setCookie(headers, NEXT_COOKIE, next, stateCookieOptions(config.cookiePath, config.secureCookie));
    headers.set("Location", authUrl);
    return new Response(null, { status: 302, headers });
  }

  // builtin 可用性校验：必须与登录页用同一套解析（resolveLoginOptions），
  // 即「App 通过 ?providers= 传入的 env 优先；不传则仅 builtin」。
  // 否则登录页按 App 的清单显示了账号登录，这里却按 web 自身 AUTH_PROVIDER 拒绝 → "登录方式不可用"。
  function builtinEnabled(request: Request): boolean {
    const raw = new URL(request.url).searchParams.get("providers");
    return resolveLoginOptions(raw, config).providers.some(p => p.id === "builtin");
  }

  async function loginPOST(request: Request): Promise<Response> {
    if (!builtinEnabled(request)) return Response.json({ error: "登录方式不可用" }, { status: 404 });
    const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown; next?: unknown } | null;
    if (!body || typeof body.username !== "string" || typeof body.password !== "string" ||
        body.username.length > 128 || Buffer.byteLength(body.password) > 1024) {
      return Response.json({ error: "用户名或密码错误" }, { status: 401 });
    }
    try {
      const user = await verifyBuiltinPassword(body.username, body.password);
      if (!user) return Response.json({ error: "用户名或密码错误" }, { status: 401 });
      return finalizeLogin(user, request, config, safeNext(typeof body.next === "string" ? body.next : "", config));
    } catch (error) {
      console.error("[agent-kit auth] builtin login failed", error);
      return Response.json({ error: "登录暂不可用，请稍后重试" }, { status: 503 });
    }
  }

  async function registerPOST(request: Request): Promise<Response> {
    if (!builtinEnabled(request)) return Response.json({ error: "注册方式不可用" }, { status: 404 });
    const body = await request.json().catch(() => null) as { username?: unknown; password?: unknown; next?: unknown } | null;
    if (!body || typeof body.username !== "string" || typeof body.password !== "string" ||
        body.username.length > 128 || Buffer.byteLength(body.password) > 1024) {
      return Response.json({ error: "请填写有效的用户名和密码" }, { status: 400 });
    }
    try {
      const user = await registerBuiltinUser(body.username, body.password);
      return finalizeLogin(user, request, config, safeNext(typeof body.next === "string" ? body.next : "", config));
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return Response.json({ error: "用户名已被注册" }, { status: 409 });
      if (error instanceof Error && /用户名须|密码须/.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
      console.error("[agent-kit auth] builtin registration failed", error);
      return Response.json({ error: "注册暂不可用，请稍后重试" }, { status: 503 });
    }
  }

  // GET /api/auth/login：
  //   - ?provider=xxx：按指定方式（登录页选择器按钮发出）
  //   - 无 provider：AUTH_PROVIDER 只有一个真实方式 → 直接跳转；
  //     多个 → 返回清单（登录页渲染选择器）；无 → 配置错误
  function loginGET(request: Request): Promise<Response> | Response {
    // 历史记录中的登录端点被再次访问时，有效会话直接回业务页，避免重复 OAuth。
    if (verifySession(request, config)) {
      return redirect(new URL(safeNext(new URL(request.url).searchParams.get("next") || "", config), publicOrigin(request, config)).toString());
    }
    const requested = new URL(request.url).searchParams.get("provider")?.toLowerCase() || "";
    if (requested) return loginWith(request, requested);

    // 同样走 resolveLoginOptions：带 ?providers= 时按 App 的清单决策（与登录页一致）。
    const options = resolveLoginOptions(new URL(request.url).searchParams.get("providers"), config);
    const total = options.providers.length;
    if (total === 0) return loginError(request, config, "config");
    if (total === 1) {
      return loginWith(request, options.providers[0].id);
    }
    // 多登录方式：正常由登录页选择器带 ?provider= 请求；这里兜底返回清单
    return new Response(
      JSON.stringify({ message: "请选择登录方式", providers: options.providers }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // GET /api/auth/callback：OAuth 回跳，用 code 换用户 → 落库 → 写会话 → 重定向
  async function callbackGET(request: Request): Promise<Response> {
    // 返回键也可能重新请求 OAuth 回调；此时 state 已清除，但会话仍有效。
    if (verifySession(request, config)) {
      return redirect(new URL(safeNext(getCookie(request, NEXT_COOKIE), config), publicOrigin(request, config)).toString());
    }
    const url = new URL(request.url);
    const code = url.searchParams.get("authCode") || url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const expectedState = getCookie(request, STATE_COOKIE);
    if (!code || !state || !expectedState || state !== expectedState.split(":").slice(1).join(":")) {
      return loginError(request, config, "state");
    }
    try {
      // adaptive 模式：state cookie 带 `${provider}:` 前缀，据此路由到对应平台；
      // 旧格式（无前缀，单方式遗留 cookie）回退 mainProvider
      const prefix = expectedState.split(":")[0];
      const provider = prefix === "dingtalk" || prefix === "feishu" ? createProviderFor(config, prefix) : mainProvider;
      if (!provider) return loginError(request, config, "config");
      const authUser = await provider.exchangeOAuthCode(code);
      const next = safeNext(getCookie(request, NEXT_COOKIE), config);
      return await finalizeLogin(authUser, request, config, next);
    } catch (e) {
      console.error("[agent-kit auth] login callback failed", e);
      return loginError(request, config, "network");
    }
  }

  // POST /api/auth/sso：客户端内 JSAPI 免登（钉钉/飞书），body { code, next, provider? }
  async function ssoPOST(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { code?: string; next?: string; provider?: string };
    const requested = body.provider?.toLowerCase();
    const targetId =
      requested === "dingtalk" || requested === "feishu"
        ? requested
        : config.method === "dingtalk" || config.method === "feishu"
          ? config.method
          : null;
    const provider = targetId ? createProviderFor(config, targetId) : mainProvider;
    if (!provider || !provider.exchangeClientCode) {
      return new Response(JSON.stringify({ message: "当前认证方式不支持客户端免登" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (!body.code) {
      return new Response(JSON.stringify({ message: "缺少免登码" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    try {
      const authUser = await provider.exchangeClientCode(body.code);
      const next = safeNext(body.next || "", config);
      return await finalizeLogin(authUser, request, config, next);
    } catch (e) {
      console.error("[agent-kit auth] client SSO failed", e);
      return new Response(JSON.stringify({ message: "免登失败，请重试" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // GET /api/auth/session：返回当前会话状态
  async function sessionGET(request: Request): Promise<Response> {
    const user = verifySession(request, config);
    if (!user) {
      // 诊断锚点：未登录时区分「请求没带 cookie」与「cookie 无效（签名/过期/secret 变化）」
      const raw = getCookie(request, SESSION_COOKIE);
      console.log(
        `[agent-kit auth] session unauthenticated: cookie=${raw ? "present" : "absent"}` +
          (raw ? ` len=${raw.length}` : "") +
          ` origin=${request.headers.get("origin") ?? "same"} cookiePath=${config.cookiePath}`,
      );
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const organizationName = await getOrganizationName(user.provider, config);
    // cookie 只存登录当时的精简用户；部门 / user_code / 自定义名字与头像以 users 表为准
    // （用户在本机「个人资料」里改过名字或头像后，cookie 里仍是旧快照）。
    // DB 未启用或查询失败时，全部降级回 cookie 里的值。
    let dbUser = null;
    try {
      dbUser = await findUserByProvider(user.provider, user.unionId);
    } catch {
      /* 忽略：仅影响设置页展示与昵称显示 */
    }
    return new Response(
      JSON.stringify({
        authenticated: true,
        user: {
          name: dbUser?.name || user.name,
          avatar: dbUser?.avatar || user.avatar,
          provider: user.provider,
          organizationName,
          deptName: dbUser?.deptName ?? undefined,
          userCode: dbUser?.userCode ?? undefined,
          sub: user.sub,
          unionId: user.unionId,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // PATCH /api/auth/profile：修改自己的展示名 / 头像（user_code 属于身份主数据，不可改）
  async function profilePATCH(request: Request): Promise<Response> {
    const user = verifySession(request, config);
    if (!user) return jsonResponse({ error: "请先登录" }, 401);
    if (!isDbEnabled()) return jsonResponse({ error: "当前部署未启用用户资料存储" }, 503);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "请求格式不正确" }, 400);
    }
    if (!body || typeof body !== "object") return jsonResponse({ error: "请求格式不正确" }, 400);
    const input = body as { name?: unknown; avatar?: unknown };

    const patch: { name?: string; avatar?: string } = {};
    if ("name" in input) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) return jsonResponse({ error: "名字不能为空" }, 400);
      if (name.length > 24) return jsonResponse({ error: "名字最多 24 个字符" }, 400);
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(name)) return jsonResponse({ error: "名字包含不可用字符" }, 400);
      patch.name = name;
    }
    if ("avatar" in input) {
      const avatar = input.avatar;
      // 头像以 data URL 存进 users.avatar：桌面端选的文件无需再走附件存储，
      // 且 <img src> 直接可用。限制格式与体积，避免把大图塞进会话请求。
      if (typeof avatar !== "string" || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)) {
        return jsonResponse({ error: "只支持 PNG / JPEG / WebP 图片" }, 400);
      }
      const base64 = avatar.slice(avatar.indexOf(",") + 1);
      if (Buffer.byteLength(base64, "base64") > 256 * 1024) return jsonResponse({ error: "头像图片过大（上限 256KB）" }, 400);
      patch.avatar = avatar;
    }
    if (!patch.name && !patch.avatar) return jsonResponse({ error: "没有需要更新的内容" }, 400);

    try {
      const updated = await updateUserProfile({ provider: user.provider, unionId: user.unionId, ...patch });
      if (!updated) return jsonResponse({ error: "用户档案不存在" }, 404);
      // 重签会话 Cookie：网页端读 cookie 的地方（导航栏等）立刻拿到新值；
      // 桌面端主进程不依赖 cookie 快照（session 接口以 DB 为准），因此这里只是锦上添花。
      const headers = new Headers({ "Content-Type": "application/json" });
      const nextSession: SessionUser = { ...user, name: updated.name || user.name, avatar: updated.avatar || "" };
      setCookie(headers, SESSION_COOKIE, createSessionToken(nextSession, config.sessionSecret), sessionCookieOptions(config.cookiePath, config.secureCookie));
      return new Response(
        JSON.stringify({ ok: true, user: { name: nextSession.name, avatar: nextSession.avatar || undefined, userCode: updated.userCode ?? undefined } }),
        { status: 200, headers },
      );
    } catch (e) {
      console.error("[agent-kit auth] update profile failed", e instanceof Error ? e.message : e);
      return jsonResponse({ error: "保存失败，请稍后重试" }, 500);
    }
  }

  // POST /api/auth/logout：清除会话 Cookie
  async function logoutPOST(): Promise<Response> {
    const headers = new Headers();
    clearCookie(headers, SESSION_COOKIE, config.cookiePath);
    // Headers → 普通对象（forEach 兼容 undici-types 与 lib.dom 的 Headers 类型差异）
    const headerObj: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerObj[key] = value;
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...headerObj },
    });
  }

  // POST /api/auth/delete-account：彻底删除当前账号（不可恢复）
  //
  // 防误删两道闸（都在服务端兜底，客户端 UI 只是前置提醒）：
  //   1. 必须是已登录会话（cookie 验签），别人无法替当前用户删；
  //   2. body 必须带与界面一致的确认词 { confirm: "删除账号" }，脚本 / CSRF / 误触
  //      都不满足，直接 400。
  // 成功后清除会话 Cookie，账号数据（DB + 用户文件区磁盘目录）已删除，不可恢复。
  async function deleteAccountPOST(request: Request): Promise<Response> {
    const user = verifySession(request, config);
    if (!user) return jsonResponse({ error: "请先登录" }, 401);
    if (!isDbEnabled()) return jsonResponse({ error: "当前部署未启用用户数据存储" }, 503);
    let body: unknown = null;
    try {
      body = await request.json();
    } catch { /* 非 JSON / 空 body：走下方确认词校验 */ }
    if (!body || typeof body !== "object" || (body as { confirm?: unknown }).confirm !== "删除账号") {
      return jsonResponse({ error: "确认词不正确" }, 400);
    }
    try {
      const deleted = await deleteUserByProvider(user.provider, user.unionId);
      if (!deleted) return jsonResponse({ error: "用户数据不存在" }, 404);
      // 磁盘用户文件区（<产物根>/users/<userKey>/）：账号已删，目录里的资料一并清除。
      // 删目录失败不影响 DB 删除结果（孤儿目录无害），只记录告警。
      try {
        await fs.rm(userFilesRoot(user.sub), { recursive: true, force: true });
      } catch (e) {
        console.warn(`[agent-kit auth] user files cleanup failed for ${user.sub}`, e instanceof Error ? e.message : e);
      }
      const headers = new Headers();
      clearCookie(headers, SESSION_COOKIE, config.cookiePath);
      const headerObj: Record<string, string> = {};
      headers.forEach((value, key) => {
        headerObj[key] = value;
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...headerObj },
      });
    } catch (e) {
      console.error("[agent-kit auth] delete account failed", e instanceof Error ? e.message : e);
      return jsonResponse({ error: "删除失败，请稍后重试" }, 500);
    }
  }

  return {
    login: { GET: loginGET, POST: loginPOST },
    register: { POST: registerPOST },
    callback: { GET: callbackGET },
    sso: { POST: ssoPOST },
    session: { GET: sessionGET },
    logout: { POST: logoutPOST },
    profile: { PATCH: profilePATCH },
    deleteAccount: { POST: deleteAccountPOST },
  };
}
