/**
 * 钉钉风格兜底头像文字：姓名 ≤2 字显示全名，否则取后两字（如「王明耀」→「明耀」），
 * 与钉钉默认头像一致（无头像时蓝底蓝字展示姓名后两字）。
 */
export function avatarInitials(name: string): string {
  const trimmed = (name || "").trim();
  return trimmed.length <= 2 ? trimmed : trimmed.slice(-2);
}

/**
 * 兜底头像（无图片时）附加的 class。
 * .avatar-fallback 统一负责蓝底蓝字 + 文字在圆内居中留白（字号按 --avatar-size 换算）；
 * 两字姓名追加 .is-two 让字号再小一档，避免文字撑满圆形、贴到圆边。
 */
export function avatarFallbackClass(initials: string): string {
  return `avatar-fallback${initials.length > 1 ? " is-two" : ""}`;
}
