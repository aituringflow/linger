"use client";

/**
 * agent-kit · 宿主平台检测与语音按住键
 *
 * 桌面壳（local Electron）在 <html data-desktop-platform> 上写入真实平台
 * （win32 / darwin / linux），浏览器（web）无此标记，回退到 User-Agent 判断。
 * 平台在会话内不变，检测结果做模块级缓存（SSR 下不缓存）。
 */

export type HostPlatform = "windows" | "mac" | "other";

let cachedPlatform: HostPlatform | null = null;

/** 当前宿主平台：优先 Electron 的 data-desktop-platform 标记，其次 User-Agent。 */
export function detectHostPlatform(): HostPlatform {
  if (cachedPlatform) return cachedPlatform;
  if (typeof window === "undefined") return "other";
  const attr = document.documentElement.dataset.desktopPlatform;
  if (attr === "win32") { cachedPlatform = "windows"; return cachedPlatform; }
  if (attr === "darwin") { cachedPlatform = "mac"; return cachedPlatform; }
  if (attr) { cachedPlatform = "other"; return cachedPlatform; }
  const ua = navigator.userAgent || "";
  const p = navigator.platform || "";
  if (/Windows|Win(32|64)/i.test(ua) || /^Win/i.test(p)) { cachedPlatform = "windows"; return cachedPlatform; }
  if (/Mac|Darwin|Macintosh|Mac OS X/i.test(ua) || /^Mac/i.test(p)) { cachedPlatform = "mac"; return cachedPlatform; }
  cachedPlatform = "other";
  return cachedPlatform;
}

export const isWindowsHost = (): boolean => detectHostPlatform() === "windows";
export const isMacHost = (): boolean => detectHostPlatform() === "mac";

/**
 * 语音按住键判断（平台相关）：
 *   - Windows/其他：右侧 Alt（AltRight / location 2）
 *   - macOS：Option 键（左右均可，key 均为 "Alt"，code 为 AltLeft / AltRight）
 */
export function isVoiceHoldKey(event: Pick<globalThis.KeyboardEvent, "key" | "code" | "location">): boolean {
  if (isMacHost()) {
    return event.key === "Alt" || event.code === "AltLeft" || event.code === "AltRight";
  }
  return event.code === "AltRight" || ((event.key === "Alt" || event.key === "AltGraph") && event.location === 2);
}

/** 设置界面展示的按键名：Windows=右侧 Alt，macOS=⌥（Option 键的典型图标）。 */
export function voiceHoldKeyLabel(): string {
  return isMacHost() ? " ⌥ " : "右侧 Alt ";
}

/** 设置界面无障碍/可读文案用的按键名（读屏器读不到 ⌥ 图标）。 */
export function voiceHoldKeyAriaLabel(): string {
  return isMacHost() ? " Option 键" : "右侧 Alt ";
}
