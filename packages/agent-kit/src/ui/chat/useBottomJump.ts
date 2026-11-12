"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 「回到底部」悬浮按钮的公共逻辑，供聊天、群 AI 思考记录、伴聊等长列表视图复用：
 *
 * - 进入视图 / 选中项变化 / 内容版本变化时：用户贴底则自动跟随滚动到底；
 *   用户已离开底部则不打扰，仅把 live 置真（按钮边框小动画，提示“下方有新输出”）。
 * - 手动向上滚动离开底部超过阈值 → 显示悬浮按钮；点击按钮回到底部后按钮消失。
 *
 * 同一滚动容器被多个视图共用时，务必用 enabled 区分：只有激活的视图接管滚动容器。
 * 按钮的样式复用现有 .chat-bottom-btn / .is-live / .chat-body-fade（聊天区同款）。
 */
export type BottomJumpOptions = {
  /** 视图是否激活：只有激活的视图才接管滚动容器（同一容器被多个视图共用时必须有此开关）。 */
  enabled: boolean;
  /** 视图“入口”标识：进入视图或入口变化（如切换选中项）时强制回到底部。 */
  entryKey: string;
  /** 内容版本：变化即视为“有新输出”。仅当用户离开底部时点亮按钮边框动画，不打扰阅读。 */
  version: string;
  /** 返回滚动容器元素。 */
  getScroller: () => HTMLElement | null;
  /** 返回需要观察尺寸变化的内容元素（内容长高时保持贴底跟随）；缺省观察滚动容器自身。 */
  getContent?: () => Element | null;
  /** 判定“离开底部”的剩余像素阈值，默认 40。 */
  threshold?: number;
};

export function useBottomJump({ enabled, entryKey, version, getScroller, getContent, threshold = 40 }: BottomJumpOptions): {
  showJump: boolean;
  live: boolean;
  jumpToBottom: () => void;
} {
  const followBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [live, setLive] = useState(false);

  // 进入视图 / 入口变化：回到贴底跟随状态并滚到底（“刚点进来要看到最新内容”）。
  useLayoutEffect(() => {
    if (!enabled) return;
    followBottom.current = true;
    setShowJump(false);
    setLive(false);
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [enabled, entryKey, getScroller]);

  // 内容版本变化：贴底 → 滚到底；已离开底部且确实有新内容在下方 → 点亮边框动画。
  useLayoutEffect(() => {
    if (!enabled) return;
    const scroller = getScroller();
    if (!scroller) return;
    if (followBottom.current) {
      scroller.scrollTop = scroller.scrollHeight;
      setLive(false);
    } else if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop > threshold) {
      setLive(true);
    }
  }, [enabled, version, threshold, getScroller]);

  // 滚动监听 + 内容尺寸监听：维护“是否贴底”与“是否显示按钮”。
  useEffect(() => {
    if (!enabled) return;
    const scroller = getScroller();
    if (!scroller) return;
    const update = () => {
      const remaining = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
      followBottom.current = remaining < 32;
      const away = remaining > threshold;
      setShowJump(away);
      if (!away) setLive(false);
    };
    const observer = new ResizeObserver(() => {
      if (followBottom.current) scroller.scrollTop = scroller.scrollHeight;
      update();
    });
    const content = getContent?.() ?? scroller;
    observer.observe(content);
    scroller.addEventListener("scroll", update, { passive: true });
    update();
    return () => { observer.disconnect(); scroller.removeEventListener("scroll", update); };
  }, [enabled, threshold, getScroller, getContent]);

  const jumpToBottom = useCallback(() => {
    followBottom.current = true;
    setShowJump(false);
    setLive(false);
    const scroller = getScroller();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [getScroller]);

  return { showJump, live, jumpToBottom };
}
