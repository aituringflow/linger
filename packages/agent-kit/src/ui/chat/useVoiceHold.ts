"use client";
import { useEffect, useRef } from "react";

/**
 * 移动端「点按切按住说话模式 + 长按录音」共享手势派发。
 *
 * 第三位喇叭：短按（<300ms）= 点按（调用方切模式），长按（≥300ms）= 录音；
 * 模式内「按住说话」大钮：按住直接录音。
 * move/up/cancel 统一挂 window 全局监听，不依赖按钮是否被隐藏/卸载，避免
 * pointer capture 失效导致移出不变红、松开不结束（单聊/群聊共用）。
 *
 * 模式状态、录音状态、persist 发送链路由调用方持有，hook 只负责 300ms
 * 点按/长按区分、全局手势派发与红绿取消意图回调。
 */

export type VoiceHoldBounds = { left: number; top: number; right: number; bottom: number };

type Dictation = {
  state: string;
  start: () => Promise<void> | void;
  stop: () => void;
  cancel: () => void;
  setFinishIntent: (intent: "send" | "cancel") => void;
};

type Options = {
  dictation: Dictation;
  /** 长按成立（或大钮按下）开始录音；bounds 为取消判定区，x/y 为起始触点。 */
  onBegin: (bounds: VoiceHoldBounds, x: number, y: number) => void;
  /** 松开结束录音；cancel=true 移出取消，false 松开发送。 */
  onFinish: (cancel: boolean) => void;
  /** 红绿取消意图切换通知（调用方据此 setFinishIntent / 振动）。 */
  onIntent?: (cancel: boolean) => void;
  /** 非安全上下文等错误通知。 */
  onError?: (message: string) => void;
  /** 短按（未成立长按）回调，通常用于切换按住说话模式。 */
  onTap?: () => void;
};

const OUTSIDE = (b: VoiceHoldBounds, x: number, y: number) =>
  x < b.left || x > b.right || y < b.top || y > b.bottom;

function boundsOf(target: HTMLElement): VoiceHoldBounds {
  const rect = target.closest(".chat-composer")?.getBoundingClientRect() ?? target.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

export function useVoiceHold({ dictation, onBegin, onFinish, onIntent, onError, onTap }: Options) {
  const pressRef = useRef<{ id: number; timer: number; started: boolean; x: number; y: number } | null>(null);
  const recRef = useRef<{ id: number; bounds: VoiceHoldBounds; cancelArmed: boolean } | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);

  // 回调最新化，避免闭包捕获陈旧状态。
  const cbRef = useRef({ onBegin, onFinish, onIntent, onError, onTap });
  cbRef.current = { onBegin, onFinish, onIntent, onError, onTap };

  const clearListeners = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  };

  const register = (pointerId: number, bounds: VoiceHoldBounds, direct: boolean, x: number, y: number) => {
    const onMove = (e: PointerEvent) => {
      const press = pressRef.current;
      if (press && press.id === pointerId) { press.x = e.clientX; press.y = e.clientY; }
      const rec = recRef.current;
      if (!rec || rec.id !== pointerId) return;
      const cancel = OUTSIDE(rec.bounds, e.clientX, e.clientY);
      if (rec.cancelArmed === cancel) return;
      rec.cancelArmed = cancel;
      cbRef.current.onIntent?.(cancel);
      if (typeof navigator.vibrate === "function") navigator.vibrate(20);
    };
    const onUp = (e: PointerEvent) => {
      const press = pressRef.current;
      if (press && press.id === pointerId) {
        window.clearTimeout(press.timer);
        pressRef.current = null;
        if (press.started) {
          const rec = recRef.current;
          cbRef.current.onFinish(rec ? OUTSIDE(rec.bounds, e.clientX, e.clientY) : true);
        }
      } else if (direct) {
        const rec = recRef.current;
        cbRef.current.onFinish(rec ? OUTSIDE(rec.bounds, e.clientX, e.clientY) : true);
      }
      clearListeners();
    };
    const onCancel = () => {
      const press = pressRef.current;
      if (press && press.id === pointerId) {
        window.clearTimeout(press.timer);
        pressRef.current = null;
      }
      suppressClickRef.current = true;
      cbRef.current.onFinish(true);
      clearListeners();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    cleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };

    if (direct) {
      if (!window.isSecureContext) {
        cbRef.current.onError?.("当前局域网 HTTP 地址无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）");
        clearListeners();
        return;
      }
      recRef.current = { id: pointerId, bounds, cancelArmed: OUTSIDE(bounds, x, y) };
      cbRef.current.onBegin(bounds, x, y);
    } else {
      const timer = window.setTimeout(() => {
        const press = pressRef.current;
        if (!press || press.id !== pointerId) return;
        suppressClickRef.current = true;
        press.started = true;
        if (!window.isSecureContext) {
          cbRef.current.onError?.("当前局域网 HTTP 地址无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）");
          pressRef.current = null;
          clearListeners();
          return;
        }
        recRef.current = { id: pointerId, bounds, cancelArmed: OUTSIDE(bounds, press.x, press.y) };
        cbRef.current.onBegin(bounds, press.x, press.y);
      }, 300);
      pressRef.current = { id: pointerId, timer, started: false, x, y };
    }
  };

  const guard = (event: React.PointerEvent<HTMLElement>, direct: boolean) => {
    if (!event.isPrimary || event.button !== 0 || dictation.state !== "idle") return false;
    if (direct) event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
    return true;
  };

  /** 第三位喇叭：短按 onTap / 长按 onBegin。 */
  const speakerDown = (event: React.PointerEvent<HTMLElement>) => {
    suppressClickRef.current = false;
    if (!guard(event, false)) return;
    const bounds = boundsOf(event.currentTarget);
    register(event.pointerId, bounds, false, event.clientX, event.clientY);
  };

  const speakerClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    cbRef.current.onTap?.();
  };

  /** 模式内「按住说话」大钮：按住直接 onBegin。 */
  const holdAreaDown = (event: React.PointerEvent<HTMLElement>) => {
    if (!guard(event, true)) return;
    const bounds = boundsOf(event.currentTarget);
    register(event.pointerId, bounds, true, event.clientX, event.clientY);
  };

  useEffect(() => () => clearListeners(), []);

  return { speakerDown, speakerClick, holdAreaDown };
}
