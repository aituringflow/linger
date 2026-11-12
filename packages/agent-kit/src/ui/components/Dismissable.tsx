import type { ReactNode } from "react";
import { useClickOutside, type UseClickOutsideOptions } from "../useClickOutside.ts";

export interface DismissableProps extends Omit<UseClickOutsideOptions, "enabled"> {
  /** 弹层是否打开；打开期间点击自身之外任意位置即关闭 */
  open: boolean;
  children?: ReactNode;
}

/**
 * 统一点击外部关闭的弹层外壳组件（useClickOutside 的组件形态）。
 * 只负责 dismiss 行为，不干预定位/样式：把弹层内容放进 children，
 * 通过 refs / exceptSelectors 声明「自身」（弹层容器 + 触发器按钮）。
 */
export function Dismissable({ open, children, ...rest }: DismissableProps) {
  useClickOutside({ enabled: open, ...rest });
  return <>{children}</>;
}
