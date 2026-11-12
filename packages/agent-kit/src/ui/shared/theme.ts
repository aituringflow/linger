"use client";

/**
 * agent-kit · 主题切换（系统 / 浅色 / 深色）
 *
 * 机制：<html data-theme="light|dark"> + CSS 变量（styles.css 的 :root[data-theme="dark"]）。
 * 持久化所选模式到 localStorage（key: agent-kit:theme）；默认 system，实时跟随 prefers-color-scheme。
 * 深色配色参考 WorkBuddy 桌面端深色主题（炭黑底 + 白字 + 品牌蓝点缀）。
 */
export type ThemeMode = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "agent-kit:theme";

/** 读取用户选择的模式；未设置时默认跟随系统。 */
export function readTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "system" || saved === "light" || saved === "dark") return saved;
  } catch {
    /* localStorage 不可用时仍跟随系统 */
  }
  return "system";
}

function resolvedTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; }
  catch { return "light"; }
}

let systemThemeListening = false;
let currentThemeMode: ThemeMode = "system";

function followSystemTheme(): void {
  if (systemThemeListening || typeof window === "undefined") return;
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (currentThemeMode === "system") document.documentElement.dataset.theme = resolvedTheme("system");
    });
    systemThemeListening = true;
  } catch { /* matchMedia 不可用时保留浅色兜底 */ }
}

/** 应用所选模式：data-theme 始终是已解析的 light/dark，存储仍保留 system。 */
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  currentThemeMode = mode;
  followSystemTheme();
  document.documentElement.dataset.theme = resolvedTheme(mode);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* 忽略：仅本次会话生效 */
  }
}

/** 尽早初始化，避免首屏浅色闪烁。 */
export function initTheme(): void {
  applyTheme(readTheme());
}
