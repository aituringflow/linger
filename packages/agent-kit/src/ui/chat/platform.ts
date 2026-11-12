import { localFilesApi } from "../shared/localFiles.ts";
import { readAgentLocation, writeAgentLocation } from "../shared/navigation.ts";
import { playNotificationSound, readNotificationSound } from "../shared/notificationSound.ts";
import type { SessionItem } from "./types.ts";

// ------------------------- 顶栏工具：OA 客户端 JSAPI -------------------------

/** 钉钉 JS SDK（dd.chooseConversationByCorpId 等 JSAPI 依赖）。
 *  注意：2.10.4 版本路径已在 CDN 失效（404），3.1.0 与 DingTalkAutoLogin.tsx 统一。 */
export const DD_SDK_URL = "https://g.alicdn.com/dingding/dingtalk-jsapi/3.1.0/dingtalk.open.js";
/** 飞书 H5 JS SDK（window.h5sdk，chooseChat 等 JSAPI 依赖）。 */
export const FEISHU_SDK_URL = "https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.48.js";

/** 分享链接状态（openShare 创建后持有）。 */
export interface ShareState {
  url: string;
  token: string;
  /** 当前登录方式：dingtalk | feishu | builtin | ""（builtin 暂无 OA 发送能力） */
  provider: string;
  /** 互动卡片（钉钉用户身份发送）展示用标题/正文 */
  title?: string;
  text?: string;
  /** 聊天摘要（最近 5 条消息），与飞书分享卡片同口径，钉钉分享面板正文复用 */
  summary?: string;
  /** 飞书分享成功后的目标会话 openChatId（oc_ 开头；供「查看已分享的会话」跳转） */
  chatId?: string;
  oa?: { dingtalk?: { agentId: string; corpId: string } };
}

/** 用户取消选择会话（正常行为，不是错误——上层检测到后静默，不展示"发送失败"）。 */
export class ShareCancelledError extends Error {
  constructor() {
    super("选择会话已取消");
    this.name = "ShareCancelledError";
  }
}

/** 动态加载脚本，已加载过直接 resolve。 */
export function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-src="${CSS.escape(src)}"]`);
    if (existing) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.dataset.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`SDK 加载失败：${src}`));
    document.head.appendChild(s);
  });
}

/** 是否运行在钉钉客户端内。 */
export function isInDingTalk(): boolean {
  return typeof navigator !== "undefined" && /DingTalk/i.test(navigator.userAgent);
}
/** 是否运行在飞书客户端内。 */
export function isInFeishu(): boolean {
  return typeof navigator !== "undefined" && /Lark|Feishu/i.test(navigator.userAgent);
}

// ------------------------- 回复完成通知（桌面 / 浏览器） -------------------------
// 桌面壳使用 HTML5 Notification；Web 优先由 service worker 显示系统通知：
//   - 桌面壳（local，window.agentHost 由 preload 注入）：渲染进程的
//     HTML5 Notification 自动映射为系统通知（Windows 通知中心 / macOS 通知中心），
//     权限视为已授予，无需站点授权——系统通知开关由用户在系统设置里管理；
//   - Web：依赖浏览器通知权限（需要 https 或 localhost），首次发消息时请求，
//     被拒绝后展示引导条（打开浏览器站点设置）。

/** 是否运行在 Electron 桌面壳内（preload 暴露 window.agentHost）。 */
export function isDesktopApp(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as unknown as { agentHost?: unknown }).agentHost)
  );
}

/** 钉钉内置 WebView 不使用浏览器站点通知设置页。 */
export function isDingTalkNotificationWebView(): boolean {
  return isInDingTalk();
}

/** 通知正文：去代码块/符号/换行后截断。 */
export function summarizeForNotify(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, "（代码块）")
    .replace(/[#>*_`~\-|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned || "AI 已回复";
}

/** 浏览器通知设置页 URL（按 UA 判断浏览器）；移动端/桌面壳返回空（用文案引导）。 */
export function notifySettingsUrl(): string {
  if (isDingTalkNotificationWebView()) return "";
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Edg\//i.test(ua)) return "edge://settings/content/notifications";
  if (/Chrome\//i.test(ua) && !/Mobile/i.test(ua)) return "chrome://settings/content/notifications";
  if (/Firefox\//i.test(ua)) return "about:preferences#privacy";
  if (/Mobile/i.test(ua)) return "";
  return "chrome://settings/content/notifications";
}

export type AgentNotification = { kind: "new-message" | "ai-reply" | "session-invite"; sessionId: string; notifyWhileViewing?: boolean };

/** 与会话列表一致：单聊用对方姓名，群聊用群名。 */
export function isGroupSession(session: SessionItem): boolean {
  return Boolean(session.coworkEverGroup) || (session.memberCount ?? 0) > 1
    || Boolean(session.workflows?.length && (session.memberCount ?? 0) > 0);
}

export function notificationTitleForSession(session: SessionItem | undefined, senderName?: string): string {
  if (!session) return senderName || "新消息";
  return (isGroupSession(session) ? session.title : session.peerName || senderName || session.title)?.trim() || "新消息";
}

function showPageNotification(title: string, body: string, tag: string, target?: AgentNotification, basePath = ""): void {
  try {
    const n = new Notification(title, { body, tag, silent: readNotificationSound() !== "system" });
    playNotificationSound(basePath, tag);
    n.onclick = () => {
      const desktop = (window as Window & { agentHost?: { showWindow?: () => Promise<boolean> } }).agentHost;
      void desktop?.showWindow?.();
      try { window.focus(); } catch { /* 聚焦失败不影响 */ }
      if (target?.sessionId) {
        const current = readAgentLocation();
        if (current?.view !== "session" || current.sessionId !== target.sessionId)
          writeAgentLocation({ view: "session", sessionId: target.sessionId });
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
      n.close();
    };
  } catch { /* 权限竞态等环境异常：通知失败不影响对话 */ }
}

/** 发送通知。桌面壳或 Web 已授权才真正弹；否则静默跳过。 */
export function showNotification(title: string, body: string, tag: string, target?: AgentNotification, basePath = ""): void {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (target?.sessionId && !target.notifyWhileViewing && !document.hidden && document.hasFocus()) {
    const location = readAgentLocation();
    if (location?.view === "session" && location.sessionId === target.sessionId) return;
  }
  if (!isDesktopApp() && isDingTalkNotificationWebView()) return;
  if (!isDesktopApp() && Notification.permission !== "granted") return;
  if (!isDesktopApp() && "serviceWorker" in navigator) {
    void (async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) { showPageNotification(title, body, tag, target, basePath); return; }
      const url = new URL(window.location.href);
      url.searchParams.delete("view");
      url.searchParams.delete("draft");
      if (target?.sessionId) url.searchParams.set("session", target.sessionId);
      await registration.showNotification(title, { body, tag, silent: readNotificationSound() !== "system", data: { kind: target?.kind, url: url.href } });
      playNotificationSound(basePath, tag);
    })().catch(error => { console.error("[web-push] notification failed", error); showPageNotification(title, body, tag, target, basePath); });
    return;
  }
  showPageNotification(title, body, tag, target, basePath);
}

/** 当前环境是否已具备通知能力（桌面壳恒可用；Web 需 granted）。 */
export function canNotify(): boolean {
  if (typeof window === "undefined" || typeof Notification === "undefined") return false;
  if (isDesktopApp()) return true;
  if (isDingTalkNotificationWebView()) return false;
  return Notification.permission === "granted";
}


// Electron 环境检测：Electron 内核的 backdrop-filter 合成会把覆盖区内容一起糊掉
//（浏览器正常），因此 Electron 下关闭毛玻璃 blur，仅保留渐变渐隐。
// 检测优先用 preload 注入的 window.agentHost（local 权威标记）——
// 新版 Electron 的 UA 已不保证包含 "Electron" 标识（指纹收敛），UA 正则只作兜底。
export const IS_ELECTRON =
  (typeof window !== "undefined" && Boolean((window as { agentHost?: unknown }).agentHost)) ||
  (typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    /electron/i.test(navigator.userAgent));

/** 桌面壳（local preload）暴露的本地能力；浏览器（web）下不存在 */
export interface AgentHostApi {
  platform?: string;
  showWindow?: () => Promise<boolean>;
  setUnreadBadgeCount?: (count: number, iconDataUrl?: string) => Promise<boolean>;
  /** 弹系统目录选择框，返回绝对路径；取消返回 null */
  pickDirectory?: (defaultPath?: string) => Promise<string | null>;
  openPath?: (path: string) => Promise<{ ok: boolean; error?: string }>;
  localFiles?: ReturnType<typeof localFilesApi>;
  /** 本机会话落盘桥（仅桌面壳）：替代云端 /api/sessions、/messages；owner 用于按用户隔离 */
  localChat?: {
    list: (owner: string) => Promise<Record<string, unknown>[]>;
    get: (owner: string, id: string) => Promise<{ meta: Record<string, unknown>; messages: unknown[]; updatedAt: string } | null>;
    save: (owner: string, id: string, meta: Record<string, unknown>, messages: unknown[]) => Promise<boolean>;
    patch: (owner: string, id: string, patch: Record<string, unknown>) => Promise<boolean>;
    remove: (owner: string, id: string) => Promise<boolean>;
  };
}
export const AGENT_HOST: AgentHostApi | null =
  typeof window !== "undefined" ? ((window as { agentHost?: AgentHostApi }).agentHost ?? null) : null;
/** 工作目录选择仅在桌面宿主可用（web 版无系统目录选择能力） */
export const canPickWorkspace = Boolean(AGENT_HOST?.pickDirectory);

