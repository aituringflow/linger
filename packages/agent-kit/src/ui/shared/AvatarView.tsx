/**
 * 通用头像组件：统一封装「有图用图、无图用姓名兜底」逻辑，并交由调用方一处复用。
 *
 * 关键点（修复「头像文字贴圆边」的根因）：兜底字号必须由实际渲染直径换算，
 * 不能写死。组件用 `size` 同时驱动几何与兜底字号（圆内接矩形校验：单字 0.46×
 * 直径、两字 0.33× 直径，留出约 26%~30% 半径安全边距），并以内联样式落到
 * `--avatar-size` 与 `font-size`，故不受各变体 class 字面 font-size 的层叠干扰。
 *
 * 调用方只需负责「配色/几何尺寸」的变体 class（如 chat-sidebar-session-avatar），
 * 不再各自手写 fallback 逻辑，避免再次写死字号导致贴边。
 */
import { type CSSProperties, type ReactNode } from "react";
import { avatarFallbackClass, avatarInitials } from "./avatar.ts";
import { GroupAvatarIcon } from "./GroupAvatarIcon.tsx";

// 与 styles-base.css .avatar-fallback 同源校验：单字 / 两字 直径占比
const FONT_SINGLE = 0.46;
const FONT_TWO = 0.33;

export type AvatarProps = {
  /** 展示名：无头像时取姓名后两字（群聊取群名首字） */
  name: string;
  /** 头像图片地址；为空则用姓名兜底 */
  src?: string;
  /**
   * 直径（px）。传入时组件内联写入 --avatar-size 与兜底字号，彻底摆脱各变体 class
   * 字面 font-size 的层叠干扰（这是「文字贴圆边」的根因）。
   * 不传则由变体 class 自身的 --avatar-size / .avatar-fallback 换算负责（如联系人选人弹窗 32/40 双尺寸）。
   */
  size?: number;
  /** 变体 class：仅负责配色 / 几何尺寸（蓝底蓝字、灰底、方形群头等） */
  className?: string;
  /** 群聊：取群名首字（而非姓名后两字） */
  isGroup?: boolean;
  /** 非圆形（如方形群头像），默认圆形 */
  rounded?: boolean;
  title?: string;
  /** 不渲染任何原生 title tooltip（如会话列表里头像已可从列表标题识别，悬停再弹提示是噪音） */
  noTooltip?: boolean;
  style?: CSSProperties;
  ariaHidden?: boolean;
};

export function Avatar({
  name,
  src,
  size,
  className = "",
  isGroup = false,
  rounded = true,
  title,
  noTooltip = false,
  style,
  ariaHidden,
}: AvatarProps): ReactNode {
  const trimmed = (name || "").trim();
  const initials = isGroup ? (trimmed.slice(0, 1) || "群") : (avatarInitials(trimmed) || "人");
  const hasImg = Boolean(src);
  const fallbackCls = hasImg ? "" : isGroup ? "group-avatar-fallback" : `avatar-fallback ${avatarFallbackClass(initials)}`;
  const cls = ["avatar", rounded ? "" : "avatar--square", fallbackCls, className].filter(Boolean).join(" ");
  const styleMerged: CSSProperties = { ...style };
  if (size !== undefined) {
    const fontFactor = initials.length > 1 ? FONT_TWO : FONT_SINGLE;
    (styleMerged as Record<string, string | number>)["--avatar-size"] = `${size}px`;
    styleMerged.fontSize = `${Math.round(size * fontFactor)}px`;
  }
  return (
    <span className={cls} style={styleMerged} title={noTooltip ? undefined : title ?? name} aria-hidden={ariaHidden}>
      {hasImg ? <img src={src} alt="" referrerPolicy="no-referrer" /> : isGroup ? <GroupAvatarIcon /> : initials}
    </span>
  );
}
