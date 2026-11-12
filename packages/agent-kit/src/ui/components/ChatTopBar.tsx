"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import { NavigationSidebarGlyph02 } from "../icons/PageIcons.tsx";

export interface ChatTopBarProps {
  title?: string;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenDomainPicker?: () => void;
}

/** The conversation top bar controls, available to embedded host layouts. */
export function ChatTopBar({ title, leftOpen, rightOpen, onToggleLeft, onToggleRight, onOpenDomainPicker }: ChatTopBarProps) {
  const t = useChatTranslation();
  return (
    <header className="chat-topbar">
      <div className="chat-topbar-left">
        <button type="button" className="chat-sidebar-toggle" onClick={onToggleLeft} aria-label={t("conversationList")} aria-expanded={leftOpen}>
          {/* 字形 y 跨度 3..21，与数域九宫格一致，保证图标内容顶部/底部对齐 */}
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3" width="17" height="18" rx="2.5" /><line x1="9.5" y1="3" x2="9.5" y2="21" /></svg>
        </button>
        {title && <span className="chat-title chat-title--left" title={title}>{title}</span>}
      </div>
      <div className="chat-topbar-right">
        {onOpenDomainPicker && (
          <button type="button" className="chat-sidebar-toggle chat-workbench-button" onClick={onOpenDomainPicker} aria-label={t("chooseDomain")}><NavigationSidebarGlyph02 /></button>
        )}
        <button type="button" className="chat-sidebar-toggle chat-right-panel-toggle" onClick={onToggleRight} aria-label={t("rightPanel")} aria-expanded={rightOpen}>
          {/* 字形 y 跨度 3..21，与数域九宫格一致 */}
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></svg>
        </button>
      </div>
    </header>
  );
}
