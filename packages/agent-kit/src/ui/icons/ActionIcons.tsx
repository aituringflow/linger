/** Shared action icons use the same 24px outline geometry as chat controls. */
export function EditIcon({ className }: { className?: string } = {}) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
  </svg>;
}

export function DeleteIcon({ className }: { className?: string } = {}) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" />
  </svg>;
}

/**
 * 「退出登录 / 登出」：左边半开的门框 + 指向门外的箭头。
 * 与侧边栏用户区（agent-navigation-logout）用的是同一套几何，宿主需要图标形态的登出入口时复用它，
 * 不要各画一份。
 */
export function LogoutIcon({ className }: { className?: string } = {}) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3" />
    <path d="M13 8l4 4-4 4M17 12H9" />
  </svg>;
}

/** 与消息菜单图标同尺寸的左弯撤回箭头。 */
export function RecallIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 5 4 10l5 5" />
    <path d="M4 10h9a7 7 0 0 1 7 7v2" />
  </svg>;
}

/** 「增强提示词」按钮：大四角星 + 右上小星（sparkles，与常见 AI 优化入口同语义）。 */
export function EnhanceIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10 5c.7 4.2 2.6 6.1 6.8 6.8-4.2.7-6.1 2.6-6.8 6.8-.7-4.2-2.6-6.1-6.8-6.8C7.4 11.1 9.3 9.2 10 5z" />
    <path d="M18.5 3.5v4M16.5 5.5h4" />
  </svg>;
}

/** 下载箭头（与更新按钮复用同一图形）。className 可控制尺寸/颜色。 */
export function DownloadIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 3v12m-4-4 4 4 4-4M4 17v3h16v-3" />
  </svg>;
}

/** 刷新 / 重来：两段半圆箭头。与产物面板的刷新按钮同一套图形，宿主需要复用时从这里取。 */
export function RefreshIcon({ className }: { className?: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
    <path d="M21 2v6h-6" />
    <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
    <path d="M3 22v-6h6" />
  </svg>;
}
