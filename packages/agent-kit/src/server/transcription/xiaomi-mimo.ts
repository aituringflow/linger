/**
 * agent-kit · 小米 MiMo 语音识别 —— 复用 @summersmile/voice-dictation SDK 通道。
 * 真正的识别与留痕/运营都在 BrandAgent 平台侧完成。
 *
 * 链路：本 provider 仅作为 SDK 的 VoiceTranscriber 通道，把音频经
 *   POST <AGENT_KIT_ASR_HOST>/api/external/asr/transcribe（multipart file）
 * 递交到平台；平台负责 ffmpeg 归一化 + mimo 主源 + 兜底链 + 留痕。
 * 令牌由 <AGENT_KIT_ASR_HOST>/api/external/asr/token 用长期 ASR_API_KEY 换取，
 * 短时有效（默认 600s），401 时 SDK 会自动强刷重试。
 *
 * 环境变量（兼容旧名 BRANDAGENT_*）：
 *   AGENT_KIT_ASR_HOST       平台地址，如 https://your-asr-host.example.com
 *   AGENT_KIT_ASR_API_KEY    长期密钥
 */
import { createDictationTranscriber } from "@summersmile/voice-dictation";

const REQUEST_TIMEOUT_MS = 120_000;
const ASR_SOURCE = "asr_xiaomi_mimo";

function brandAgentHost() {
  const v = process.env.AGENT_KIT_ASR_HOST?.trim() || process.env.BRANDAGENT_ASR_HOST?.trim();
  const clean = v?.replace(/\/$/, "");
  if (!clean) throw new Error("未配置 AGENT_KIT_ASR_HOST / BRANDAGENT_ASR_HOST（ASR 平台地址）");
  return clean;
}
function brandAgentApiKey() {
  const v = process.env.AGENT_KIT_ASR_API_KEY?.trim() || process.env.BRANDAGENT_ASR_API_KEY?.trim();
  if (!v) throw new Error("未配置 AGENT_KIT_ASR_API_KEY / BRANDAGENT_ASR_API_KEY（ASR 长期密钥）");
  return v;
}

// 短时令牌缓存：平台令牌默认 600s，留 30s 余量再刷新
let tokenCache: { token: string | null; expiresAt: number } = { token: null, expiresAt: 0 };

async function getPlatformToken({ forceRefresh }: { forceRefresh?: boolean } = {}) {
  if (!forceRefresh && tokenCache.token && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.token;
  }
  const host = brandAgentHost();
  const apiKey = brandAgentApiKey();
  const res = await fetch(`${host}/api/external/asr/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ttlSeconds: 600 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`BrandAgent 转写令牌获取失败 (${res.status})`);
  }
  const j = (await res.json().catch(() => ({}))) as { token?: string; expiresAt?: number };
  if (!j?.token) throw new Error("BrandAgent 转写令牌响应异常");
  tokenCache = { token: j.token, expiresAt: j.expiresAt || Date.now() + 600_000 };
  return j.token;
}

// 懒加载：避免缺少环境变量时模块加载即抛错
type Transcriber = ReturnType<typeof createDictationTranscriber>;
let _transcriber: Transcriber | null = null;
function getTranscriber(): Transcriber {
  if (!_transcriber) {
    _transcriber = createDictationTranscriber({
      endpoint: `${brandAgentHost()}/api/external/asr/transcribe`,
      getToken: getPlatformToken,
    });
  }
  return _transcriber;
}

export async function transcribeWithXiaomiMimo({ bytes, mimeType, fileName }: {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}) {
  try {
    const blob = new Blob([Uint8Array.from(bytes)], { type: mimeType || "audio/wav" });
    const ext = (fileName || "").split(".").pop()?.toLowerCase() || "wav";
    const text = await getTranscriber()(blob, {
      filename: fileName || "audio.wav",
      extension: ext,
      mime: mimeType || "audio/wav",
    });
    const clean = typeof text === "string" ? text.trim() : "";
    if (!clean) {
      throw new Error("未检测到说话内容");
    }
    return { text: clean, provider: "xiaomi-mimo" };
  } catch (e) {
    console.error(`[${ASR_SOURCE}] 转写异常:`, e instanceof Error ? e.message : e);
    throw e;
  }
}
