/**
 * agent-kit · 语音输入服务端（Next.js App Router 通用 handler）
 *
 * 短时令牌（HMAC-SHA256 签名，默认 10 分钟有效）+ ASR 转写。
 * 前端录音前先取 token，再带 Bearer token 调 transcribe 接口。
 * 录音上传转写接口已停用，语音输入统一使用腾讯云实时语音识别。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface VoiceUser {
  userId?: string;
  name?: string;
  sub?: string;
  nick?: string;
}

function tokenSecret() {
  return (
    process.env.AGENT_KIT_VOICE_TOKEN_SECRET ||
    process.env.HOTLINE_ASR_TOKEN_SECRET ||
    process.env.HOTLINE_SESSION_SECRET ||
    "agent-kit-2026"
  );
}

function sign(value: string) {
  return createHmac("sha256", tokenSecret()).update(value).digest("base64url");
}

export function createVoiceToken(user: VoiceUser, { ttlSeconds }: { ttlSeconds?: number } = {}) {
  const ttlMs = Math.min(DEFAULT_TTL_MS, Math.max(60_000, (Number(ttlSeconds) || 600) * 1000));
  const payload = Buffer.from(
    JSON.stringify({
      purpose: "agent-kit-voice",
      sub: user.userId || user.sub || "user",
      name: user.name || user.nick || "",
      exp: Date.now() + ttlMs,
    })
  ).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, tokenType: "Bearer", expiresAt: Date.now() + ttlMs };
}

export function verifyVoiceToken(token: string | null | undefined) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      purpose?: string;
      exp?: number;
    };
    if (data.purpose !== "agent-kit-voice") return null;
    if (typeof data.exp !== "number" || data.exp <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// 旧录音上传接口保留路由兼容性，但不再执行非实时 ASR。
export async function transcribeVoice({
  bytes: _bytes,
  mimeType: _mimeType,
  fileName: _fileName,
}: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}): Promise<{ text: string; provider: "tencent-realtime" }> {
  throw new Error("录音上传转写已停用，请使用腾讯云实时语音识别");
}
