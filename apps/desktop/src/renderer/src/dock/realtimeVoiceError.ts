/**
 * 把「实时语音转写失败」的各种来源归一成一句用户能看懂的话。
 *
 * 失败可能来自三层，报错口径必须统一（否则用户只会看到一句「语音输入暂时不可用」，
 * 完全不知道该去配环境变量、去登录、还是去开麦克风权限）：
 *   1. 签发会话（POST /api/audio/session）—— 未登录 401 / 凭据没配 503；
 *   2. 连腾讯云 wss —— 握手失败、超时、中途断开；
 *   3. 本机麦克风 —— 权限被拒 / 没有设备。
 *
 * 服务端错误体约定（agent-kit audio-session.ts）：
 *   { ok:false, code:"asr_unauthorized" | "asr_not_configured" | "asr_unavailable", error, missing? }
 */

/** 浮层里的一行标题 + 一行补充说明；detail 为空时只显示标题。 */
export interface VoiceFailure {
  message: string;
  detail?: string;
  /** 需要用户执行的动作：目前只有 "login"（显示登录按钮）。 */
  action?: "login";
}

/** 服务端返回体里我们关心的字段。 */
interface SessionErrorBody {
  code?: unknown;
  error?: unknown;
  missing?: unknown;
}

function readBody(body: string): SessionErrorBody | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" ? parsed as SessionErrorBody : null;
  } catch {
    return null;
  }
}

/** 服务端 return 的通用兜底文案；客户端不要把它同时塞进 message 和 detail（会重复一遍）。 */
const UNAVAILABLE = "语音服务暂时不可用，请稍后重试";

/**
 * 主进程 `launcher:web-chat-api` 的兜底响应体用的是英文 slug（unavailable / forbidden…），
 * 直接显示出来等于没解释。这里翻成人话。
 */
const PIPE_SLUGS: Record<string, VoiceFailure> = {
  unavailable: { message: "语音服务暂时连不上", detail: "请检查网络连接后重试" },
  unauthorized: { message: "使用语音需要先登录", detail: "登录后即可使用语音转写功能", action: "login" },
  forbidden: { message: "暂无语音使用权限", detail: "请联系管理员开通权限" },
  invalid_request: { message: "语音请求失败", detail: "请稍后重试" },
};

/**
 * 解析 `/api/audio/session` 的失败响应。
 *
 * 注意「凭据没配」和「服务临时不可用」都是 503，必须靠 body.code 区分：
 * 前者是我们自己部署没配好（改 .env 就能修），后者才是真的可以「稍后重试」。
 */
export function describeSessionFailure(status: number, body: string): VoiceFailure {
  const payload = readBody(body);
  const serverMessage = typeof payload?.error === "string" ? payload.error : "";
  const code = typeof payload?.code === "string" ? payload.code : "";

  if (status === 401 || code === "asr_unauthorized") {
    return {
      message: "使用语音需要先登录",
      detail: "登录后即可使用语音转写功能",
      action: "login",
    };
  }
  if (code === "asr_not_configured") {
    return {
      message: "语音服务暂未开通",
      detail: "请联系管理员完成语音服务配置",
    };
  }
  if (status === 0) {
    return { message: "语音服务暂时连不上", detail: "请检查网络连接后重试" };
  }
  // 主进程兜底的英文 slug 优先翻掉，否则 503 + {"error":"unavailable"} 会原样显示成「unavailable」。
  if (!code && serverMessage && PIPE_SLUGS[serverMessage]) return PIPE_SLUGS[serverMessage];
  if (status === 503) {
    return {
      message: "语音服务暂时不可用",
      detail: "请稍后重试",
    };
  }
  return {
    message: "语音转写启动失败",
    detail: "请稍后重试",
  };
}

/**
 * 连服务器 / 开麦克风阶段的失败：错误对象本身由 recorder 抛（消息已经是中文口径），
 * 这里只负责给它配一句「下一步该干什么」的说明。
 */
export function describeRecorderFailure(error: unknown): VoiceFailure {
  const message = error instanceof Error && error.message ? error.message : "语音转写启动失败";
  if (/麦克风|Microphone|Permission|NotAllowed|NotFound/i.test(message)) {
    return { message, detail: "请在系统设置中允许使用麦克风后重试" };
  }
  return {
    message: "语音服务连接失败",
    detail: "请检查网络连接后重试",
  };
}
