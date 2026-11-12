"use client";

import { useEffect, useState } from "react";
import { agentNavigationAvailability, agentNavigationChangeEvent } from "../shared/navigation.ts";
import { DesktopHistoryControlsGlyph01, DesktopHistoryControlsGlyph02 } from "../icons/PageIcons.tsx";

/**
 * 仅由 Electron 聊天壳渲染；按钮与原生交通灯共用侧栏顶部的一行。
 *
 * 复用与 Web 完全相同的导航模型：视图切换由 navigation.ts 通过
 * window.history.pushState/replaceState 维护应用内 agentNav 索引，可用性直接读
 * window.history.state.agentNav.index；点击驱动 window.history.back()/forward()，
 * 由 AgentWindow 的 popstate 监听恢复对应会话/菜单视图。
 *
 * 不依赖 Electron 的 window.agentHost.navigation：该原生实现基于
 * webContents.navigationHistory 统计 session/view 条目，而 Electron 不会可靠地把
 * SPA 的 pushState 记录进 navigationHistory，导致 canGoBack/Forward 几乎恒为 false、
 * 按钮失效。Web 与本地统一走 window.history 路径即可规避此问题。
 */
export function DesktopHistoryControls({ onExitPreviewFull, previewFull = false }: { onExitPreviewFull?: () => void; previewFull?: boolean }) {
  const [navigation, setNavigation] = useState(() => agentNavigationAvailability());

  useEffect(() => {
    const update = () => setNavigation(agentNavigationAvailability());
    update();
    window.addEventListener("popstate", update);
    window.addEventListener(agentNavigationChangeEvent, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener(agentNavigationChangeEvent, update);
    };
  }, []);

  return (
    <nav className="desktop-history-controls" aria-label="页面导航">
      <button type="button" title="返回" aria-label="返回" disabled={!previewFull && !navigation.canGoBack} onClick={() => previewFull ? onExitPreviewFull?.() : window.history.back()}>
        <DesktopHistoryControlsGlyph01 />
      </button>
      <button type="button" title="前进" aria-label="前进" disabled={!navigation.canGoForward} onClick={() => window.history.forward()}>
        <DesktopHistoryControlsGlyph02 />
      </button>
    </nav>
  );
}
