"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { DesktopUpdateControl } from "./DesktopUpdateControl.tsx";
import { NavigationSidebarGlyph01, NavigationSidebarGlyph02 } from "../icons/PageIcons.tsx";
import { NavigationContactsIcon, NavigationHomeIcon, NavigationLibraryIcon } from "../icons/DynamicIcons.tsx";

/** kit 内置侧栏 key。宿主可以只用这些，也可以追加任意自定义 key。 */
export type SidebarItem = "home" | "library" | "timer" | "workbench" | "contacts";

/** 自定义图标可按选中态渲染。 */
export interface SidebarIconState {
  selected: boolean;
}

/** 宿主传给 agent-kit 的一个侧栏项。key 决定URL ?view=、激活态与内容索引。 */
export interface SidebarEntry {
  /** 唯一标识。内置 key 有默认文案/图标/页面；自定义 key 需自己给 label、icon、render。 */
  key: SidebarItem | (string & {});
  /** 导航文字与无障碍名。内置 key（包括 home）省略时用默认文案。 */
  label?: string;
  /** 图标节点或渲染函数。内置 key 省略时用默认图标。 */
  icon?: ReactNode | ((state: SidebarIconState) => ReactNode);
  /** 内容区。省略时内置 key 走 kit 默认页面，自定义 key 无内容（点击后中栏留空）。 */
  render?: () => ReactNode;
}

const builtinLabels: Record<SidebarItem, string> = {
  home: "对话", library: "资料库", timer: "定时任务", workbench: "工作台", contacts: "通讯录",
};

function builtinIcon(key: SidebarItem, selected: boolean): ReactNode {
  if (key === "home") return <NavigationHomeIcon selected={selected} />;
  if (key === "library") return <NavigationLibraryIcon selected={selected} />;
  if (key === "contacts") return <NavigationContactsIcon selected={selected} />;
  if (key === "timer") return <NavigationSidebarGlyph01 />;
  return <NavigationSidebarGlyph02 />;
}

/** key 是否为内置项（自定义 key 走宿主提供的 label/icon/render）。 */
function isBuiltin(key: string): key is SidebarItem {
  return key in builtinLabels;
}

/** CSS 修饰类后缀：自定义 key 可能含非法字符，净化后仍保留 --home / --library 等内置钩子。 */
function classSuffix(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** 归一化宿主配置：去重、剔除空 key、补全内置项默认文案与图标。 */
export function resolveSidebar(entries?: readonly SidebarEntry[] | null): SidebarEntry[] {
  const seen = new Set<string>();
  const resolved: SidebarEntry[] = [];
  for (const entry of entries ?? []) {
    const key = entry?.key?.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (!isBuiltin(key)) { resolved.push({ ...entry, key }); continue; }
    resolved.push({
      ...entry,
      key,
      label: entry.label ?? builtinLabels[key],
      icon: entry.icon ?? ((state: SidebarIconState) => builtinIcon(key, state.selected)),
    });
  }
  return resolved;
}

/** 只有 home（或为空）时不显示导航栏。 */
export function hasSidebar(entries: readonly SidebarEntry[]): boolean {
  return entries.length > 0 && !(entries.length === 1 && entries[0].key === "home");
}

/** 取出某个 key 的内容渲染器。 */
export function sidebarEntry(entries: readonly SidebarEntry[], key: string): SidebarEntry | undefined {
  return entries.find((entry) => entry.key === key);
}

export function NavigationSidebar({ entries, expanded = false, width, active, onSelect, onHomeHoverStart, onHomeHoverEnd, onHomeContextMenu, homeUnread = false, userMenu, navDragging = false, onNavResizeStart, onNavResizeMove, onNavResizeEnd }: {
  entries: readonly SidebarEntry[];
  expanded?: boolean;
  width?: number;
  active: string | null;
  onSelect: (key: string) => void;
  onHomeHoverStart?: () => void;
  onHomeHoverEnd?: () => void;
  /** home 项右键（浏览器菜单已阻止）：宿主据此弹出「全部已读」等菜单，参数为视口坐标 */
  onHomeContextMenu?: (x: number, y: number) => void;
  homeUnread?: boolean;
  userMenu?: ReactNode;
  /** 是否正在拖拽右缘（拖拽中让手柄竖条常显） */
  navDragging?: boolean;
  onNavResizeStart?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onNavResizeMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onNavResizeEnd?: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const t = useChatTranslation();
  const style = expanded && typeof width === "number" && Number.isFinite(width) && width > 0
    ? { "--navigation-sidebar-width": `${width}px` } as CSSProperties
    : undefined;
  return <nav className={`agent-navigation-sidebar${expanded ? " is-expanded" : ""}${navDragging ? " is-nav-dragging" : ""}`} style={style} aria-label={t("mainNavigation")}>
    {entries.map((entry) => {
      const { key } = entry;
      const keys = { home: "navHome", library: "navLibrary", timer: "navTimer", workbench: "navWorkbench", contacts: "navContacts" } as const;
      const label = isBuiltin(key) && entry.label === builtinLabels[key] ? t(keys[key]) : entry.label;
      const selected = active === key;
      const icon = typeof entry.icon === "function"
        ? (entry.icon as (state: SidebarIconState) => ReactNode)({ selected })
        : entry.icon;
      return <button key={key} type="button" className={`agent-navigation-item agent-navigation-item--${classSuffix(key)}${selected ? " is-active" : ""}`}
        onMouseEnter={key === "home" && selected ? onHomeHoverStart : undefined}
        onMouseLeave={key === "home" ? onHomeHoverEnd : undefined}
        onContextMenu={key === "home" && onHomeContextMenu ? (e) => { e.preventDefault(); onHomeContextMenu(e.clientX, e.clientY); } : undefined}
        onClick={() => onSelect(key)} aria-label={label} aria-current={selected ? "page" : undefined}>
        <span className="agent-navigation-icon">{icon}{key === "home" && homeUnread ? <span className="agent-navigation-unread-dot" aria-label={t("unread")} /> : null}</span>
        <span className="agent-navigation-label">{label}</span>
      </button>;
    })}
    <DesktopUpdateControl compact />
    {userMenu}
    {onNavResizeStart ? (
      <div
        className="agent-navigation-resizer"
        onPointerDown={onNavResizeStart}
        onPointerMove={onNavResizeMove}
        onPointerUp={onNavResizeEnd}
        onPointerCancel={onNavResizeEnd}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("resizeNav")}
      />
    ) : null}
  </nav>;
}
