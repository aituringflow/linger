"use client";
import { useCallback, useMemo, useState } from "react";

/**
 * 移动端每 Tab 独立页面栈（纯内存，与浏览器 history 解耦）。
 *
 * 模型：每个 tab 持有自己的一条栈，栈底恒为该 tab 的首页（root），栈顶即当前可见页；
 * `activeTab` 决定当前显示哪条栈。切换 tab 只换 activeTab，不清空其它 tab 的栈
 * （切回去仍停留在之前压入的详情页）。
 *
 * 本 hook 只维护栈数据与 push/pop，不直接读写 URL / history；
 * URL 深链、刷新恢复、桌面端仍由 navigation.ts 的 location 机制负责，
 * 调用方在 push 时复用 writeAgentLocation，pop 由 popstate 回调驱动。
 */

/** 栈底：某个 tab 的首页（每条栈恰好一个 root，且恒在栈底） */
export interface NavRootEntry {
  type: "root";
  tab: string;
}

/** 会话详情（home 栈二级页） */
export interface NavSessionEntry {
  type: "session";
  sessionId: string;
}

/** 群设置全屏页（邀请成员并入此页，不单独建页） */
export interface NavSettingsEntry {
  type: "settings";
}

/** 查看产物全屏页（复用 PC 右栏 files tab） */
export interface NavArtifactsEntry {
  type: "artifacts";
}

/** 从产物列表打开的文件预览 */
export interface NavArtifactPreviewEntry {
  type: "artifact-preview";
  artifactId: string;
}

/** 伴聊 · Chatmate 全屏页（复用 PC 右栏 chatmate tab，仅群聊） */
export interface NavChatmateEntry {
  type: "chatmate";
}

/** AI 独白全屏页（复用 PC 右栏 monologue tab，仅群聊） */
export interface NavMonologueEntry {
  type: "monologue";
}

export type NavEntry =
  | NavRootEntry
  | NavSessionEntry
  | NavSettingsEntry
  | NavArtifactsEntry
  | NavArtifactPreviewEntry
  | NavChatmateEntry
  | NavMonologueEntry;

export interface NavStackState {
  /** 当前可见的 tab key */
  activeTab: string;
  /** tab key → 该 tab 自己的栈（数组末尾为栈顶） */
  stacks: Record<string, NavEntry[]>;
}

export interface UseNavStack {
  state: NavStackState;
  activeTab: string;
  /** 取指定 tab（默认当前 tab）的整条栈 */
  stackOf: (tab?: string) => NavEntry[];
  /** 取指定 tab（默认当前 tab）的栈顶条目 */
  top: (tab?: string) => NavEntry | undefined;
  /** 指定 tab（默认当前 tab）栈长度；root 栈底为 1 */
  depth: (tab?: string) => number;
  /** 切 tab：只换 activeTab，不改动任何栈 */
  switchTab: (tab: string) => void;
  /** 往当前 tab 栈顶压入一个页面 */
  push: (entry: NavEntry) => void;
  /**
   * 弹出当前 tab 栈顶。栈长 >1 时弹出并返回 true；
   * 已在栈底（root）时不做任何改动并返回 false（栈底返回停留首页）。
   */
  pop: () => boolean;
  /** 把指定 tab（默认当前 tab）的栈裁回只剩 root */
  resetRoot: (tab?: string) => void;
}

function buildInitialStacks(tabs: string[]): Record<string, NavEntry[]> {
  const stacks: Record<string, NavEntry[]> = {};
  for (const tab of tabs) stacks[tab] = [{ type: "root", tab }];
  return stacks;
}

export function useNavStack(tabs: string[], initialTab?: string): UseNavStack {
  const [state, setState] = useState<NavStackState>(() => ({
    activeTab: initialTab && tabs.includes(initialTab) ? initialTab : tabs[0],
    stacks: buildInitialStacks(tabs),
  }));

  const stackOf = useCallback(
    (tab?: string): NavEntry[] => {
      const key = tab ?? state.activeTab;
      return state.stacks[key] ?? [{ type: "root", tab: key }];
    },
    [state.activeTab, state.stacks],
  );

  const top = useCallback(
    (tab?: string): NavEntry | undefined => {
      const stack = stackOf(tab);
      return stack[stack.length - 1];
    },
    [stackOf],
  );

  const depth = useCallback(
    (tab?: string): number => stackOf(tab).length,
    [stackOf],
  );

  const switchTab = useCallback((tab: string) => {
    setState((prev) => ({ ...prev, activeTab: tab }));
  }, []);

  const push = useCallback((entry: NavEntry) => {
    setState((prev) => {
      const key = prev.activeTab;
      const stack = prev.stacks[key] ?? [{ type: "root", tab: key } as NavEntry];
      return {
        ...prev,
        stacks: { ...prev.stacks, [key]: [...stack, entry] },
      };
    });
  }, []);

  const pop = useCallback((): boolean => {
    let popped = false;
    setState((prev) => {
      const key = prev.activeTab;
      const stack = prev.stacks[key];
      if (!stack || stack.length <= 1) return prev; // 栈底：停留不动
      popped = true;
      return {
        ...prev,
        stacks: { ...prev.stacks, [key]: stack.slice(0, -1) },
      };
    });
    return popped;
  }, []);

  const resetRoot = useCallback((tab?: string) => {
    setState((prev) => {
      const key = tab ?? prev.activeTab;
      return {
        ...prev,
        stacks: { ...prev.stacks, [key]: [{ type: "root", tab: key }] },
      };
    });
  }, []);

  return useMemo(
    () => ({ state, activeTab: state.activeTab, stackOf, top, depth, switchTab, push, pop, resetRoot }),
    [state, stackOf, top, depth, switchTab, push, pop, resetRoot],
  );
}
