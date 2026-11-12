"use client";

/**
 * agent-kit · 界面显示偏好（用户菜单开关）
 *
 * 两个布尔偏好可持久化到 localStorage；模型显示默认值可由宿主设置：
 *   - agent-kit:show-context-usage  是否显示输入框右侧的上下文使用量环形指示
 *   - agent-kit:show-model          是否显示输入框右侧的模型下拉
 * 缺省（未保存过 / localStorage 不可用）按 defaultOn 返回。
 */

export const SHOW_CONTEXT_USAGE_KEY = "agent-kit:show-context-usage";
export const SHOW_MODEL_KEY = "agent-kit:show-model";
export const MULTI_FRAMEWORK_KEY = "agent-kit:multi-framework";
export const RIGHT_CTRL_VOICE_KEY = "agent-kit:right-ctrl-voice";
const UI_PREFS_CHANGED_EVENT = "agent-kit:ui-prefs-changed";
type UiPrefKey = typeof SHOW_CONTEXT_USAGE_KEY | typeof SHOW_MODEL_KEY | typeof MULTI_FRAMEWORK_KEY | typeof RIGHT_CTRL_VOICE_KEY;
/** 上次打开的会话 id：刷新/重开后优先恢复该会话；会话被删则清除并回首页 */
export const LAST_SESSION_KEY = "agent-kit:last-session";

/** 读取布尔偏好：localStorage 优先，未保存/不可用返回 defaultOn（SSR 亦返回 defaultOn） */
function readBool(key: string, defaultOn: boolean): boolean {
  if (typeof window === "undefined") return defaultOn;
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    /* localStorage 不可用（隐私模式/禁用）→ 默认值 */
  }
  return defaultOn;
}

/** 写入布尔偏好："1"/"0"；localStorage 不可用时静默忽略（仅本次会话生效） */
function writeBool(key: UiPrefKey, on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const next = on ? "1" : "0";
    if (window.localStorage.getItem(key) === next) return;
    window.localStorage.setItem(key, next);
  } catch {
    /* localStorage 不可用时仍通知同页的其他聊天窗 */
  }
  window.dispatchEvent(new CustomEvent(UI_PREFS_CHANGED_EVENT, { detail: { key, value: on } }));
}

/** 同页多个 AgentWindow 共用显示偏好；storage 事件补上其他标签页的修改。 */
export function subscribeUiPrefs(onChange: (key: UiPrefKey, value: boolean | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const keys: readonly string[] = [SHOW_CONTEXT_USAGE_KEY, SHOW_MODEL_KEY, MULTI_FRAMEWORK_KEY, RIGHT_CTRL_VOICE_KEY];
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ key: UiPrefKey; value: boolean }>).detail;
    if (detail && keys.includes(detail.key)) onChange(detail.key, detail.value);
  };
  const onStorage = (event: StorageEvent) => {
    if (keys.includes(event.key ?? "")) onChange(event.key as UiPrefKey, event.newValue === null ? null : event.newValue === "1");
  };
  window.addEventListener(UI_PREFS_CHANGED_EVENT, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(UI_PREFS_CHANGED_EVENT, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** 显示上下文使用量：默认开启 */
export const readShowContextUsage = (): boolean => readBool(SHOW_CONTEXT_USAGE_KEY, true);
export const writeShowContextUsage = (on: boolean): void => writeBool(SHOW_CONTEXT_USAGE_KEY, on);

/** 显示模型：用户已保存的选择优先；否则采用宿主提供的默认值。 */
export const readShowModel = (defaultOn = true): boolean => readBool(SHOW_MODEL_KEY, defaultOn);
export const writeShowModel = (on: boolean): void => writeBool(SHOW_MODEL_KEY, on);
/** 多框架（输入框的框架下拉 / 分屏对比）：默认关闭，未设置时按关闭处理。 */
export const readMultiFramework = (): boolean => readBool(MULTI_FRAMEWORK_KEY, false);
export const writeMultiFramework = (on: boolean): void => writeBool(MULTI_FRAMEWORK_KEY, on);
/** 输入框聚焦时按住语音键启动语音转写（Windows=右侧 Alt，macOS=Option，左右均可）：默认开启。 */
export const readRightCtrlVoice = (): boolean => readBool(RIGHT_CTRL_VOICE_KEY, true);
export const writeRightCtrlVoice = (on: boolean): void => writeBool(RIGHT_CTRL_VOICE_KEY, on);

/** 读取上次打开的会话 id（localStorage 不可用/未保存返回 null） */
export function readLastSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}
/** 写入上次打开的会话 id */
export function writeLastSession(id: string): void {
  try {
    window.localStorage.setItem(LAST_SESSION_KEY, id);
  } catch {
    /* 忽略 */
  }
}
/** 清除上次打开的会话记录（会话被删 / 新建任务回首页时调用） */
export function clearLastSession(): void {
  try {
    window.localStorage.removeItem(LAST_SESSION_KEY);
  } catch {
    /* 忽略 */
  }
}
