"use client";

import type { ReactNode } from "react";

/** 应用主内容区域的轻量容器；按激活的侧栏 key 取对应内容。 */
export interface ContentPanelProps {
  /** 当前激活的侧栏 key（内置或自定义） */
  active: string;
  /** key → 内容。缺失的 key 渲染为空。 */
  views: Record<string, ReactNode>;
}

export function ContentPanel({ active, views }: ContentPanelProps) {
  return <>{views[active] ?? null}</>;
}

/** kit 内置的简单页面框架；宿主可以在 body 内放自己的控件。 */
export function ContentPage({ title, children }: { title: string; children?: ReactNode }) {
  return <main className="agent-navigation-page">
    <header className="agent-navigation-page-head">{title}</header>
    <div className="agent-navigation-page-body">{children}</div>
  </main>;
}