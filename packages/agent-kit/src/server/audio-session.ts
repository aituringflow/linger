/**
 * agent-kit · 实时语音会话签发（腾讯云 ASR WebSocket）
 *
 * 链路：客户端（浏览器 / 桌面壳宿主）先 POST /api/audio/session 换取一个
 * 带签名的 wss://asr.cloud.tencent.com/asr/v2/{appId} URL（10 分钟有效），
 * 然后客户端**直连腾讯云**边录边推 PCM16、边收实时识别文本。
 *
 * 凭据（TENCENT_CLOUD_SECRET_ID / SECRET_KEY）只在本服务端使用，不下发客户端；
 * 客户端只拿到一个短时签名 URL，泄露窗口最多 10 分钟。
 *
 * 登录校验：复用 kit 的 verifySession，未登录直接 401。
 */
import crypto from "node:crypto";
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";

const HOST = "asr.cloud.tencent.com";

/**
 * 「服务未配置」这一类失败要单独成类，不能和「服务暂时不可用」混在同一个 503 里。
 *
 * 区别在于可操作性：凭据没配时每次录音都会失败，用户看到「稍后重试」也永远修不好。
 * 这里单独成类，前端可以明确告知「服务暂未开通」。
 */
export class MissingEnvError extends Error {
  constructor(readonly envName: string) {
    super(`未配置 ${envName}`);
    this.name = "MissingEnvError";
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new MissingEnvError(name);
  return value;
}

/** 缓存 CAM 拉到的 AppId：进程级一次即可，避免每次录音都打一次 CAM。 */
let cachedAppId = "";

/** 用 TC3-HMAC-SHA256 调 CAM GetUserAppId 拿当前账号 AppId（env 未直接配 AppId 时兜底）。 */
async function fetchAppIdFromCam(): Promise<string> {
  if (cachedAppId) return cachedAppId;
  const secretId = requiredEnv("TENCENT_CLOUD_SECRET_ID");
  const secretKey = requiredEnv("TENCENT_CLOUD_SECRET_KEY");
  const host = "cam.tencentcloudapi.com";
  const service = "cam";
  const action = "GetUserAppId";
  const version = "2019-01-16";
  const body = "{}";
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${crypto.createHash("sha256").update(body).digest("hex")}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const hmac = (key: Buffer | string, value: string) => crypto.createHmac("sha256", key).update(value).digest();
  const signingKey = hmac(hmac(hmac(`TC3${secretKey}`, date), service), "tc3_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization =
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(`https://${host}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Host: host,
      "X-TC-Action": action,
      "X-TC-Version": version,
      Authorization: authorization,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    Response?: { AppId?: number; Error?: { Code?: string; Message?: string } };
  };
  const appId = data?.Response?.AppId;
  if (!res.ok || !appId) {
    throw new Error(data?.Response?.Error?.Message || `CAM GetUserAppId 失败 (${res.status})`);
  }
  cachedAppId = String(appId);
  return cachedAppId;
}

async function resolveAppId(): Promise<string> {
  const direct = process.env.TENCENT_CLOUD_APP_ID?.trim();
  if (direct) return direct;
  return fetchAppIdFromCam();
}

/** 签一个腾讯云实时 ASR wss URL（HMAC-SHA1，老版签名）。 */
export async function createTencentRealtimeAsrUrl(): Promise<string> {
  const appId = await resolveAppId();
  const secretId = requiredEnv("TENCENT_CLOUD_SECRET_ID");
  const secretKey = requiredEnv("TENCENT_CLOUD_SECRET_KEY");
  const timestamp = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    convert_num_mode: "1",
    engine_model_type: process.env.TENCENT_ASR_ENGINE?.trim() || "16k_zh",
    expired: String(timestamp + 600),
    filter_dirty: "0",
    filter_modal: "0",
    filter_punc: "0",
    needvad: "1",
    nonce: String(crypto.randomInt(1, 2_000_000_000)),
    secretid: secretId,
    timestamp: String(timestamp),
    voice_format: "1", // 1 = PCM
    voice_id: crypto.randomUUID(),
  };
  const query = Object.keys(params)
    .sort()
    .map((key) => `${key}=${encodeURIComponent(params[key])}`)
    .join("&");
  const unsigned = `${HOST}/asr/v2/${appId}?${query}`;
  const signature = crypto.createHmac("sha1", secretKey).update(unsigned).digest("base64");
  return `wss://${unsigned}&signature=${encodeURIComponent(signature)}`;
}

/**
 * POST /api/audio/session：登录校验通过后签发实时语音服务连接地址。
 * 未登录 → 401（附 `code:"asr_unauthorized"`）；
 * 服务未配置 → 503 + `code:"asr_not_configured"`；
 * 其它失败 → 503 + `code:"asr_unavailable"`。
 */
export function createAudioSessionHandler() {
  return async function POST(request: Request): Promise<Response> {
    const user = verifySession(request, loadAuthConfig());
    if (!user?.sub) {
      return Response.json({ ok: false, code: "asr_unauthorized", error: "请先登录" }, { status: 401 });
    }
    try {
      const url = await createTencentRealtimeAsrUrl();
      return Response.json({ ok: true, connection: { url } });
    } catch (error) {
      console.error("[audio/session] 签发失败:", error instanceof Error ? error.message : error);
      if (error instanceof MissingEnvError) {
        return Response.json(
          {
            ok: false,
            code: "asr_not_configured",
            error: "语音服务暂未开通",
          },
          { status: 503 },
        );
      }
      return Response.json(
        { ok: false, code: "asr_unavailable", error: "语音服务暂时不可用，请稍后重试" },
        { status: 503 },
      );
    }
  };
}
