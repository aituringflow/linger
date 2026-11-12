/**
 * agent-kit · 会话与 Cookie 工具
 *
 * 会话采用「无状态签名 token」：payload 经 base64url 编码，再用 HMAC-SHA256 签名，
 * 写入 httpOnly Cookie。验证时不查库即可确认身份未被篡改，过期由 exp 字段控制。
 * 与 hotline 思路一致，但全部参数化（密钥 / Cookie 名 / 路径由调用方传入），
 * 不写死任何项目专属常量，便于多 app 复用。
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthUser, SessionUser } from "./types.js";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 天

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

function sign(value: string, secret: string): string {
  return base64UrlEncode(createHmac("sha256", secret).update(value).digest());
}

/** 生成一次性 state（防 CSRF），用于 OAuth 授权跳转。 */
export function generateState(): string {
  return randomUUID();
}

/** 由归一化用户构造会话用户（sub = provider:unionId，作为全链路用户主体键）。 */
export function toSessionUser(user: AuthUser): SessionUser {
  return {
    sub: `${user.provider}:${user.unionId}`,
    provider: user.provider,
    unionId: user.unionId,
    openId: user.openId,
    name: user.name || "用户",
    avatar: user.avatar || "",
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * 解析主体键 `${provider}:${unionId}` → { provider, unionId }。
 * unionId 自身可能含 `:`，故只按**第一个** `:` 切分。
 * 非法（缺 `:`）时返回 provider=""、unionId=原串，交由调用方决定是否视为未登录。
 */
export function parseSessionKey(sub: string): { provider: string; unionId: string } {
  const idx = sub.indexOf(":");
  if (idx < 0) return { provider: "", unionId: sub };
  return { provider: sub.slice(0, idx), unionId: sub.slice(idx + 1) };
}

/** 签发会话 token。 */
export function createSessionToken(sessionUser: SessionUser, secret: string): string {
  // Profile photos may be stored as data URLs in users.avatar. Keep them in the
  // database response, not the cookie: browsers reject cookies over ~4 KB.
  const compactUser = sessionUser.avatar && sessionUser.avatar.length > 1024
    ? { ...sessionUser, avatar: "" }
    : sessionUser;
  const payload = base64UrlEncode(JSON.stringify(compactUser));
  return `${payload}.${sign(payload, secret)}`;
}

/** 验证并解析会话 token；失效 / 篡改 / 过期均返回 null。 */
export function verifySessionToken(token: string | undefined | null, secret: string): SessionUser | null {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const user = JSON.parse(base64UrlDecode(payload).toString("utf8")) as SessionUser;
    if (!user.sub || !user.exp || user.exp <= Math.floor(Date.now() / 1000)) return null;
    return user;
  } catch {
    return null;
  }
}

export interface CookieOptions {
  path: string;
  secure: boolean;
  maxAgeSeconds?: number;
}

/**
 * 标准会话 Cookie 选项。
 * - secure=false（本地 http / 同 site 场景，如桌面端 dev）：SameSite=Lax，无 Secure。
 *   桌面端正确姿势：主进程把页面 host 统一为 127.0.0.1（与引擎同 site），Lax cookie 随
 *   fetch 正常携带。
 * - secure=true：SameSite=None + Secure。注意：Chromium 的 Secure cookie 例外仅限
 *   localhost 主机名，**不含 127.0.0.1**——在 http://127.0.0.1 上 Secure cookie 会被浏览器
 *   拒绝发送（存储有、请求不带，表现为"每次启动都要重新登录"），因此本地 http 引擎
 *   绝不能开 secure。
 */
export function sessionCookieOptions(cookiePath: string, secure: boolean, maxAgeSeconds = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    secure,
    path: cookiePath,
    maxAge: maxAgeSeconds,
  };
}

/** 短期（10 分钟）state Cookie 选项，用于 OAuth 往返校验（同会话策略）。 */
export function stateCookieOptions(cookiePath: string, secure: boolean, maxAgeSeconds = 10 * 60) {
  return {
    httpOnly: true,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    secure,
    path: cookiePath,
    maxAge: maxAgeSeconds,
  };
}
