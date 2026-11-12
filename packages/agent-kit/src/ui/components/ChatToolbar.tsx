"use client";

import type { ReactNode } from "react";

/** Shared three-part composer toolbar used by AgentWindow and embedded hosts. */
export function ChatToolbar({ children, className = "", compact }: { children: ReactNode; className?: string; compact?: number }) {
  return <div className={`chat-toolbar${className}`} data-compact={compact}>{children}</div>;
}
