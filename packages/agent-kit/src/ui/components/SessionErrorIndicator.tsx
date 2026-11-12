"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { ErrorMarkIcon } from "../icons/SharedIcons.tsx";

export default function SessionErrorIndicator({ message, popupPosition }: { message: string; popupPosition?: { x: number; y: number } | null }) {
  const [iconPopupPosition, setIconPopupPosition] = useState<{ x: number; y: number } | null>(null);
  const position = popupPosition === undefined ? iconPopupPosition : popupPosition;
  return (
    <>
      <span
        className="chat-sidebar-item-error"
        role="img"
        aria-label={`会话错误：${message}`}
        onMouseEnter={popupPosition === undefined ? (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setIconPopupPosition({
            x: Math.max(8, Math.min(rect.right + 10, window.innerWidth - 316)),
            y: Math.max(8, Math.min(rect.top - 8, window.innerHeight - 110)),
          });
        } : undefined}
        onMouseLeave={popupPosition === undefined ? () => setIconPopupPosition(null) : undefined}
      ><ErrorMarkIcon /></span>
      {position && createPortal(
        <div className="chat-sidebar-error-popup" style={{ left: position.x, top: position.y }} role="tooltip">
          <span className="chat-sidebar-item-error" aria-hidden="true"><ErrorMarkIcon /></span>
          <span>{message}</span>
        </div>,
        document.body,
      )}
    </>
  );
}
