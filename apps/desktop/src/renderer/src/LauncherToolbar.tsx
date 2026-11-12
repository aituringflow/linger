import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SettingsIcon, useChatSession } from "@turingflow/agent-kit/ui";
import { useLauncher } from "./state";

/** Launcher owns its window controls; the toolbar shares the AgentWindow session state. */
export function LauncherToolbar({ conversationSettings }: { conversationSettings?: { open: boolean; label: string; title: string; toggle: () => void } } = {}) {
  const { title, sidebarOpen, toggleSidebar, rightShown, setRightOpen, setDiffView, setInputFilePreview, currentSessionTitle } = useChatSession();
  const { state, dispatch } = useLauncher();
  const anchor = useRef<HTMLSpanElement>(null);
  const [frame, setFrame] = useState<Element | null>(null);
  const domainPickerOpen = state.domainPickerOpen;
  /* 会话有自己的标题（不同于应用默认 title）才显示；新建会话默认名不显示。 */
  const displayTitle = conversationSettings?.title || currentSessionTitle;
  const showSessionTitle = conversationSettings ? Boolean(displayTitle) : Boolean(displayTitle && displayTitle !== title);

  useLayoutEffect(() => {
    setFrame(anchor.current?.closest(".quick-input")?.querySelector(".focus-topbar-wrap") ?? null);
  }, []);

  const toolbar = (
    <header className="chat-topbar launcher-toolbar">
      <div className="chat-topbar-left">
        <button type="button" className="chat-sidebar-toggle" aria-label="会话列表" aria-expanded={sidebarOpen} onClick={toggleSidebar}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3.5" y="3" width="17" height="18" rx="2.5" />
            <line x1="9.5" y1="3" x2="9.5" y2="21" />
            {/* 侧栏展开：把左半格填实（与 macOS 的 sidebar 图标一致），折叠时只剩描边 */}
            {sidebarOpen ? <path className="chat-sidebar-toggle-fill" d="M9.5 3H6a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 6 21h3.5z" /> : null}
          </svg>
        </button>
        {showSessionTitle ? <span className="chat-title chat-title--left" title={displayTitle}>{displayTitle}</span> : null}
      </div>
      <div className="chat-topbar-right">
        {conversationSettings ? <button type="button" className="chat-sidebar-toggle" aria-label={conversationSettings.label} title={conversationSettings.label} aria-expanded={conversationSettings.open} onClick={conversationSettings.toggle}>
          <SettingsIcon />
        </button> : null}
        {/* 「选择数域」现在是一扇独立窗口（WindowFrame，只有关闭按钮）：这里只负责开关它。 */}
        <button type="button" className="chat-sidebar-toggle" aria-label="选择数域" aria-expanded={domainPickerOpen}
          onClick={() => dispatch({ type: "SET_DOMAIN_PICKER", open: !domainPickerOpen })}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
        </button>
        <button type="button" className="chat-sidebar-toggle chat-right-panel-toggle" aria-label="右侧面板" aria-expanded={rightShown} onClick={() => {
          if (rightShown) { setRightOpen(false); setDiffView(null); setInputFilePreview(null); }
          else setRightOpen(true);
        }}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M15 3v18" />
            {/* 右栏展开：把右半格填实 */}
            {rightShown ? <path className="chat-sidebar-toggle-fill" d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4z" /> : null}
          </svg>
        </button>
      </div>
    </header>
  );

  return <><span ref={anchor} hidden />{frame ? createPortal(toolbar, frame) : toolbar}</>;
}
