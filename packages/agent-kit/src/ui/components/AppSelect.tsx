"use client";

/**
 * agent-kit · 通用下拉选择组件（黑白灰系）
 *
 * 抽象自 ModelSelect 的交互骨架：触发按钮 + 圆角弹出菜单，无边框聚焦态，
 * 菜单项 hover / 选中态 / ✓ 勾选，与「模型选择」下拉体验完全一致，可全 app 复用。
 * 样式复用 .chat-model-picker-* 类（styles-conversation.css）；放进
 * .cowork-settings-field 等容器时会自动套用表单控件皮肤。
 *
 * 用法：
 *   <AppSelect
 *     options={[{ value: "balanced", label: "适时发言" }, ...]}
 *     value={replyPolicy}
 *     onChange={(v) => persistSettings({ replyPolicy: v })}
 *     disabled={!canConfigure}
 *   />
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useClickOutside } from "../useClickOutside.ts";
import { ModelSelectGlyph02 } from "../icons/PageIcons.tsx";

export interface AppSelectOption {
  value: string;
  label: string;
}

export default function AppSelect({
  options,
  value,
  onChange,
  title,
  disabled = false,
  placeholder = "",
  openOnHover = false,
  forceUp = false,
}: {
  options: AppSelectOption[];
  /** 当前选中的 value；未命中任一选项时按钮显示 placeholder。 */
  value: string;
  /** 回传被点选条目的 value。 */
  onChange: (value: string) => void;
  title?: string;
  disabled?: boolean;
  placeholder?: string;
  /** 折叠时鼠标悬停即展开选项，移出收起（配合向上弹出，选项面板贴按钮无间隙）。 */
  openOnHover?: boolean;
  /** 强制向上弹出（不做视口感知向下翻转）。 */
  forceUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState<"up" | "down">("up");
  const [menuMaxH, setMenuMaxH] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);

  const current = options.find((o) => o.value === value);
  const selectedIndex = current ? options.indexOf(current) : -1;

  /** 视口感知定位：展开时按触发按钮上下剩余空间决定向上/向下弹出，并把菜单高度限制在可视范围内。 */
  const positionPopup = useCallback(() => {
    if (forceUp) { setDir("up"); setMenuMaxH(undefined); return; }
    const btn = ref.current?.querySelector<HTMLElement>(".chat-model-picker-btn");
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const margin = 8;
    const spaceAbove = rect.top - margin;
    const spaceBelow = vh - rect.bottom - margin;
    const desired = 240;
    const useDown = spaceBelow >= spaceAbove && spaceBelow > desired * 0.4;
    setDir(useDown ? "down" : "up");
    const avail = Math.max(spaceAbove, spaceBelow);
    setMenuMaxH(Math.max(140, Math.min(desired, avail - margin)));
  }, [forceUp]);

  useEffect(() => {
    if (!open) return;
    positionPopup();
    const onReposition = () => positionPopup();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, positionPopup]);
  // 下拉菜单：点击组件（按钮+菜单）之外任意处或 Esc 关闭（捕获阶段拦截，避免菜单内事件被吞）
  useClickOutside({
    enabled: open,
    refs: [ref],
    capture: true,
    onDismiss: () => setOpen(false),
  });

  return (
    <div className={`chat-model-picker${openOnHover ? " is-hover-open" : ""}${forceUp ? " is-force-up" : ""}`} ref={ref}
      onMouseEnter={() => { if (!disabled) setOpen(true); }}
      onMouseLeave={() => { if (openOnHover) setOpen(false); }}>
      {open ? (
        <div className={`chat-model-picker-popup${dir === "down" ? " is-down" : ""}`}>
          <ul className="chat-model-picker-menu" role="listbox" style={menuMaxH != null ? { maxHeight: menuMaxH } : undefined}>
            {options.map((o, idx) => (
              <li key={o.value} role="option" aria-selected={idx === selectedIndex}
                className={`chat-model-picker-item${idx === selectedIndex ? " selected" : ""}`}
                tabIndex={0}
                onClick={() => { onChange(o.value); setOpen(false); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onChange(o.value); setOpen(false); } }}>
                <span className="chat-model-picker-item-text">
                  <span className="chat-model-picker-item-name">{o.label}</span>
                </span>
                <span className="chat-model-picker-item-extra">
                  <span className="chat-model-picker-item-selected" aria-hidden="true">{idx === selectedIndex ? "✓" : ""}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        className={`chat-model-picker-btn${open ? " open" : ""}`}
        onClick={() => setOpen((v) => openOnHover ? true : !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={title}
      >
        <span className="chat-model-picker-name">{current?.label ?? placeholder}</span>
        <ModelSelectGlyph02 />
      </button>
    </div>
  );
}
