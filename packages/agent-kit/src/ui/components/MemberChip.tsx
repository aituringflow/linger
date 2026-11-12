"use client";

/**
 * agent-kit · 可移除成员标签（统一「删人」体验）
 *
 * 抽象自「新建对话预选成员」（AgentWindow 空态 .chat-pending-member）：
 * 头像 + 名字竖排，右上角 16px 圆形 × / ✓ 钮（浅色黑底白×、深色白底黑×）。
 * 群设置批量移除成员（CoworkPanel）与新建对话预选成员共用此组件，保证体验一致。
 *
 * 两种交互（可同时/分开使用）：
 *  - onRemoveClick：× 钮可点击（新建对话直接移除该成员）；
 *  - onCardClick + selected：点击卡片切换选中（群设置批量移除，× 钮仅作状态指示）。
 * 选中态下 × 变红底 ✓；未选中显示 ✕。
 */
import { Avatar } from "../shared/AvatarView.tsx";

export default function MemberChip({
  name,
  avatar,
  size = 30,
  removable = true,
  selected = false,
  onCardClick,
  onRemoveClick,
  badge,
  actionLabel,
  onAction,
  actionDisabled,
}: {
  name: string;
  avatar?: string;
  /** 头像直径（px），默认 30；卡片宽度随之 = size + 20。 */
  size?: number;
  /** 显示右上角 ×/✓ 钮。 */
  removable?: boolean;
  /** 选中态：✓ 红底（多选场景）。 */
  selected?: boolean;
  /** 点击整张卡片（群设置多选切换）。 */
  onCardClick?: () => void;
  /** 点击 × 钮（新建对话直接移除）。 */
  onRemoveClick?: () => void;
  /** 角色徽章（群主 / 管理员），显示在名字下方。 */
  badge?: string;
  /** 卡片底部的次要操作钮（如 设为管理员 / 取消管理员）。 */
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  const interactive = Boolean(onCardClick || onRemoveClick);
  return (
    <div
      className={`member-chip${selected ? " is-selected" : ""}${interactive ? " is-interactive" : ""}`}
      role={onCardClick ? "button" : undefined}
      tabIndex={onCardClick ? 0 : undefined}
      title={name}
      onClick={onCardClick}
      onKeyDown={onCardClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onCardClick(); } } : undefined}
      style={{ width: size + 20 }}
    >
      {removable ? (
        <button
          type="button"
          className="member-chip-remove"
          aria-label={selected ? "取消选中" : `移除 ${name}`}
          title={selected ? "取消选中" : `移除 ${name}`}
          tabIndex={onRemoveClick ? 0 : -1}
          onClick={(e) => { e.stopPropagation(); if (onRemoveClick) onRemoveClick(); else onCardClick?.(); }}
        >
          {selected ? "✓" : "✕"}
        </button>
      ) : null}
      <Avatar name={name} src={avatar || undefined} size={size} className="member-chip-avatar" />
      <span className="member-chip-name">{name}</span>
      {badge ? <span className="member-chip-badge">{badge}</span> : null}
      {actionLabel && onAction ? (
        <button
          type="button"
          className="member-chip-action"
          disabled={actionDisabled}
          onClick={(e) => { e.stopPropagation(); onAction(); }}
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
