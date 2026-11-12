import type { CompositionEvent, KeyboardEvent } from "react";

// macOS 输入法可能先触发 compositionend，再派发用于确认候选词的 Enter。
const stateByElement = new WeakMap<Element, { composing: boolean; endedAt: number }>();

export function imeCompositionStart(e: CompositionEvent<HTMLElement>) {
  stateByElement.set(e.currentTarget, { composing: true, endedAt: 0 });
}

export function imeCompositionEnd(e: CompositionEvent<HTMLElement>) {
  stateByElement.set(e.currentTarget, { composing: false, endedAt: performance.now() });
}

export function isImeConfirmKey(e: KeyboardEvent<HTMLElement>): boolean {
  const state = stateByElement.get(e.currentTarget);
  return e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || !!state?.composing ||
    (e.key === "Enter" && !!state?.endedAt && performance.now() - state.endedAt < 100);
}
