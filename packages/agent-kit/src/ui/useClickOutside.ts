import { useEffect, useRef, type RefObject } from "react";

/**
 * 统一「点击自身（弹层容器 / 触发器）之外的任意位置即关闭」的弹层行为。
 *
 * 此前各弹层各自手写 document.addEventListener（事件混用 mousedown/pointerdown、
 * 判据混用 closest/ref.contains/capture 阶段拦截），这里收敛为一个实现：
 *  - 统一监听 `pointerdown`（覆盖鼠标 / 触摸 / 笔，行为与 mousedown 等价且更早）；
 *  - 判据 = 命中任一 `refs` 容器（contains）或命中任一 `exceptSelectors`（closest）→ 视为「自身」，不关闭；
 *    其余任意位置按下 → 调用 onDismiss；
 *  - `capture` 打开时在捕获阶段拦截（用于弹层内容 stopPropagation / portal / 嵌套弹层的场景）；
 *  - `esc`（默认开）时按 Escape 也关闭。
 *
 * 只在 `enabled` 翻转为 true 时绑定一次监听，回调始终读取最新值，避免弹层开着时反复增删监听。
 */
export interface UseClickOutsideOptions {
  /** 弹层是否打开；只在打开期间绑定监听 */
  enabled: boolean;
  /** 点击这些元素内部视为「自身」，不关闭。弹层容器与触发器按钮都放这里 */
  refs?: ReadonlyArray<RefObject<HTMLElement | null>>;
  /** 点击匹配这些选择器的元素内部也视为「自身」（closest 语义）。
   *  用于触发器/锚点是动态列表项、不便持有 ref 的场景；也可放弹层容器自身的 class。 */
  exceptSelectors?: readonly string[];
  /** 是否在捕获阶段拦截（默认 false） */
  capture?: boolean;
  /** 按 Escape 是否也关闭（默认 true） */
  esc?: boolean;
  /** 判定为「点击了自身之外」时调用 */
  onDismiss: () => void;
}

export function useClickOutside({
  enabled,
  refs = [],
  exceptSelectors = [],
  capture = false,
  esc = true,
  onDismiss,
}: UseClickOutsideOptions) {
  const latest = useRef({ refs, exceptSelectors, onDismiss });
  latest.current = { refs, exceptSelectors, onDismiss };

  useEffect(() => {
    if (!enabled) return;
    // 归一化选择器：兼容调用方把多个选择器塞在一条逗号串里（拆开后去空再合并，避免 querySelector 语法错误）
    const selectors = latest.current.exceptSelectors
      .flatMap((selector) => selector.split(","))
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",");

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (latest.current.refs.some((ref) => ref.current?.contains(target))) return;
        if (selectors && target instanceof Element && target.closest(selectors)) return;
      }
      latest.current.onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") latest.current.onDismiss();
    };

    document.addEventListener("pointerdown", onPointerDown, capture);
    if (esc) document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, capture);
      if (esc) document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, capture, esc]);
}
