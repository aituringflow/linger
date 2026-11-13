import type { Scene } from "./types.ts";

type SseData = Record<string, any>;

export const isImageFile = (att?: { file?: File; name?: string; url?: string; kind?: "file" | "folder" } | null): boolean => {
  if (!att || att.kind === "folder") return false;
  if (att.file && String(att.file.type || "").startsWith("image/")) return true;
  const ext = String(att.name || att.url || "").split(".").pop()?.toLowerCase() || "";
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"].includes(ext);
};

export const isVideoFile = (att?: { file?: File; name?: string; url?: string; kind?: "file" | "folder" } | null): boolean => {
  if (!att || att.kind === "folder") return false;
  if (att.file && String(att.file.type || "").startsWith("video/")) return true;
  const ext = String(att.name || att.url || "").split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";
  return ["mp4", "webm", "mov", "m4v", "ogv", "ogg", "avi", "mkv"].includes(ext);
};

export const isAudioFile = (att?: { file?: File; name?: string; url?: string; kind?: "file" | "folder" } | null): boolean => {
  if (!att || att.kind === "folder") return false;
  if (att.file && String(att.file.type || "").startsWith("audio/")) return true;
  const ext = String(att.name || att.url || "").split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";
  return ["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "amr", "opus", "weba"].includes(ext);
};

// 模型图片能力判断（尽力而为，只用于「发图前提醒」，不拦截发送）：
// 优先用模型列表下发的 meta.supportsImages（CLI / 云端能力字段是权威来源）；
// 只有拿不到该字段时，才按名字猜：命中已知「非视觉」模型（DeepSeek / Ling / Kimi 等）提示换模型，
// 已知「视觉」模型（hy3/hy4-preview/GLM-V 等）或未知模型一律不提示（宁缺毋滥）。
// 注意：不能只按名字前缀判——deepseek-v4.1-flash 等模型实际支持图片，前缀规则会误报。
const NON_VISION_MODEL_PATTERN = /^(deepseek|inclusionai|ling-|kimi-|hunyuan-chat$)/i;
const VISION_MODEL_PATTERN = /(^|[-\/])(hy3|hy3-x|hy4-preview)|(^|[-\/])glm-\d+(\.\d+)?v|(^|[-\/])[a-z0-9.-]*v[a-z0-9-]*$/i;
export function isLikelyNonVisionModel(
  modelId?: string | null,
  /** 模型列表声明的图片能力（meta.supportsImages）；有值时以它为准 */
  declaredSupportsImages?: boolean | null,
): boolean {
  // 显式能力声明优先：声明支持 → 不提示；声明不支持 → 提示。
  if (typeof declaredSupportsImages === "boolean") return !declaredSupportsImages;
  const id = String(modelId || "").trim().toLowerCase();
  if (!id) return false;
  // 明确命中视觉特征（含 hy3/hy4-preview/GLM-V 等）→ 视为支持图片
  if (VISION_MODEL_PATTERN.test(id)) return false;
  return NON_VISION_MODEL_PATTERN.test(id);
}

// 页面级会话 ID：每次组件挂载生成一个（刷新/重载即换新会话，记忆不跨刷新保留）。
// 配合后端 sessionId/resume 实现真正的多轮上下文续接。
export function generateSessionId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// 解析一个 SSE 帧（以空行分隔）：返回 { event, data }，data 为完整 JSON 对象。
export function parseSseFrame(frame: string): { event: string; data: SseData } | null {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return null;
  try {
    const parsed = JSON.parse(data);
    return { event, data: parsed && typeof parsed === "object" ? parsed : { text: "" } };
  } catch {
    return null;
  }
}

// 消息时间：今天只显示 HH:MM，不是今天显示 MM-DD HH:MM
export function formatMsgTime(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    if (sameDay) return `${hh}:${mm}`;
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
  } catch { return ""; }
}


// File → base64（去 data: 前缀）
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}


// 用户消息带附件时，附件名已由气泡上方的附件条（📎 文件名）展示；
// 内容首行的 "[附件] 文件名" 与附件条重复，仅在显示时去掉这行
//（内容本身原样保留：发给模型 / 存库均不受影响，服务端也会追加附件提示）。
export function stripAttachmentLine(content: string): string {
  return String(content).replace(/^(?:\[附件\] [^\n]*\n?)+/, "");
}

// 取附件文件名：attachment 兼容单个对象或对象数组（服务端存的是 [{url,name,size,fileId}]）；
// 数组按顺序取第一个有名字的项。
export function firstAttachmentName(attachment: unknown): string {
  const entry = firstAttachmentEntry(attachment);
  const name = entry?.name;
  return typeof name === "string" ? name.trim() : "";
}

// 取第一个有名字的附件项（用于类型判断，须与 firstAttachmentName 选中同一项）。
function firstAttachmentEntry(attachment: unknown): { name?: unknown; url?: unknown; file?: unknown } | null {
  const list = Array.isArray(attachment) ? attachment : attachment ? [attachment] : [];
  for (const item of list) {
    if (item && typeof item === "object") {
      const name = (item as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) return item as { name?: unknown; url?: unknown; file?: unknown };
    }
  }
  return null;
}

// 会话列表 / 通知的附件类型标签：图片 / 视频 / 音频 / 文件（与气泡渲染的 isImageFile/isVideoFile 判定一致）。
function attachmentKindLabel(entry: { name?: unknown; url?: unknown; file?: unknown } | null): string {
  if (isImageFile(entry as { file?: File; name?: string; url?: string } | null)) return "图片";
  if (isVideoFile(entry as { file?: File; name?: string; url?: string } | null)) return "视频";
  if (isAudioFile(entry as { file?: File; name?: string; url?: string } | null)) return "音频";
  return "文件";
}

// 会话列表 / 通知的消息摘要：纯文件消息显示类型；其他文件保留文件名。
export function messagePreviewText(content: string | null | undefined, attachment?: unknown): string {
  const raw = String(content ?? "").trim();
  if (raw === "[附件]") return "[文件] 文件";
  const entry = firstAttachmentEntry(attachment);
  const markerName = /^\[附件\]\s*([^\r\n]+)$/.exec(raw)?.[1]?.trim() || "";
  if (raw && !markerName) return raw.replace(/\s+/g, " ");
  const name = (entry && typeof entry.name === "string" ? entry.name.trim() : "") || markerName;
  if (!name) return attachment ? "[文件] 文件" : "";
  const kind = attachmentKindLabel(entry || { name });
  return kind === "文件" ? `[文件] ${name}` : kind;
}

/** Split a session-list file preview into a visual tag and its remaining text. */
export function sessionFilePreview(content: string | null | undefined): { label: string; details: string } | null {
  const raw = String(content ?? "").trim();
  const named = /^\[(图片|音频|视频|文件)\]\s*(.*)$/s.exec(raw);
  if (named) return { label: named[1], details: named[2].replace(/\s+/g, " ").trim() };
  if (raw === "图片" || raw === "音频" || raw === "视频") return { label: raw, details: "" };
  if (raw === "[附件]") return { label: "文件", details: "" };
  const lines = /^\[附件\]\s*([^\r\n]+)\r?\n([\s\S]*)$/.exec(raw);
  const oneLine = lines ? null : /^\[附件\]\s*(.+?\.[a-z0-9]{1,12})(?=\s|$)\s*(.*)$/i.exec(raw);
  const bare = lines || oneLine ? null : /^\[附件\]\s*(.+)$/.exec(raw);
  const name = (lines?.[1] || oneLine?.[1] || bare?.[1] || "").trim();
  if (!name) return null;
  const body = (lines?.[2] || oneLine?.[2] || "").replace(/\s+/g, " ").trim();
  const label = attachmentKindLabel({ name });
  return { label, details: `${name}${body}` };
}


// 时长格式化：<60 秒显示「x 秒」；>=60 秒显示「x 分 y 秒」（y=0 时省略为「x 分」）
export function formatDuration(secs?: number | null, locale: "zh-CN" | "en" = "zh-CN"): string {
  const s = Number(secs);
  if (!s || s <= 0) return "";
  const format = (value: number, unit: "minute" | "second") => locale === "zh-CN"
    ? `${new Intl.NumberFormat(locale).format(value)} ${unit === "minute" ? "分" : "秒"}`
    : new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(value);
  if (s < 60) return format(s, "second");
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? format(m, "minute") : `${format(m, "minute")} ${format(r, "second")}`;
}


// 折叠态常驻摘要：取思考文本末段 ~180 字（结论导向），按换行/句号边界向左裁剪避免半截句。
// 思考开头是「我需要先……」的铺垫，结尾才是该步的小结/结论，信息量最高。
export function summarizeThinking(text: string | undefined | null, max = 180): string {
  const t = (text || "").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const head = t.slice(-max);
  const m = head.search(/[\n。.!?！？；;]/);
  const cut = m >= 0 ? m + 1 : 0;
  const out = head.slice(cut).trim();
  // 裁剪点太靠后（几乎没裁）时退回整段，保证摘要非空且不丢失结论
  return out.length > 12 ? out : head.trim();
}


export function getScene(scenes: Scene[] | undefined | null, key: string | null | undefined): Scene | null {
  if (!scenes || scenes.length === 0) return null;
  return scenes.find((s) => s.key === key) || scenes[0];
}

