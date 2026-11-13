import { useTranslation } from "./i18n";
"use client";

import { useEffect, useMemo, useState } from "react";
import { AgentApp, ASSISTANT_NAME, type AgentAppProps } from "@turingflow/agent-kit/ui";
import { LauncherToolbar } from "./LauncherToolbar";
import { enabledComputeProviders, useLauncher } from "./state";
import { availableAgentModes, cacheProviders, readCachedProviders } from "./computeProviderAvailability";
import type { LauncherComputeProvider } from "../../shared/types";

export interface LauncherAppProps extends Omit<AgentAppProps, "authMode" | "className"> {
  /** Hover 预览与聚焦态共用同一个 AgentWindow 实例和草稿。 */
  preview?: boolean;
  /**
   * 是否挂载即开新会话。省略时跟随 preview（旧行为：仅 hover 预览开新会话）。
   * Home 主窗口显式传 true：无论是 hover 预览还是点击展开，都从同一「空输入框」开始，
   * 输入框底下的工具栏（含项目/文件夹选择）在两种形态下完全一致；点击 Home 不再自动恢复上次会话
   * （进行中的会话仍可在桌面「进行中」卡片里恢复）。
   */
  newChatOnMount?: boolean;
  /** 可显式使用登录模式；默认本地游客。 */
  authMode?: AgentAppProps["authMode"];
  /** 有未读消息时，打开聊天窗默认展开左侧会话列表面板（否则收起成纯空输入框）。 */
  keepSidebarOpenWhenUnread?: boolean;
  /** 点击「新建对话」后保持左侧会话列表面板不消失（Home 主窗口用；hover 预览不传，维持收起）。 */
  keepSidebarOnNewChat?: boolean;
}

/** Launcher 外壳入口；消息、会话、左右侧栏及工具均由完整 AgentWindow 承担。 */
export function LauncherApp({ preview = false, newChatOnMount, authMode = "local-guest", layoutMode = "grow", keepSidebarOpenWhenUnread = false, keepSidebarOnNewChat = false, ...props }: LauncherAppProps) {
  // 是否开新会话：显式传入优先，否则跟随 preview（hover 预览开新会话，展开后恢复上次会话）。
  // Home 主窗口固定传 true，保证 hover 预览与点击展开两种形态共用同一个「空输入框」、
  // 工具栏完全一致；数域窗口不传，沿用 preview（false，即恢复数域上次会话）的旧行为。
  const startNewChat = newChatOnMount ?? preview;
  // 有未读消息时不收起面板，让用户一眼看到会话列表；否则保持空白输入框的极简态。
  const closePanels = startNewChat && !keepSidebarOpenWhenUnread;
  // 有未读消息时：新会话挂载即展开左侧会话列表（不仅是"不收起"，而是强制展开），
  // 否则即使用户之前收起过侧栏，有未读时打开 chat 也能一眼看到未读会话。
  const openSidebar = startNewChat && keepSidebarOpenWhenUnread;
  // 系统设置里「算力提供商」的启用状态 → kit 的框架白名单。
  // 用 join 出来的 key 做 useMemo 依赖：AgentWindow 里这个数组进 effect 依赖，
  // 每次渲染新建数组会让它反复 setState。禁用某个提供商后聊天里的框架切换即时收起。
  const { state, dispatch } = useLauncher();
  const { locale, t } = useTranslation();
  const [providers, setProviders] = useState<LauncherComputeProvider[] | null>(readCachedProviders);
  useEffect(() => {
    let alive = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void window.launcher.getComputeProviders().then((items) => {
        if (alive && current === request) { setProviders(items); cacheProviders(items); }
      }).catch(() => { if (alive && current === request) setProviders((previous) => previous ?? []); });
    };
    refresh();
    const unsubscribe = window.launcher.onComputeProvidersChanged((changed) => {
      if (changed) setProviders((previous) => {
        if (!previous) return previous;
        const next = previous.map((provider) => provider.id === changed ? { ...provider, authenticated: false } : provider);
        cacheProviders(next);
        return next;
      });
      refresh();
    });
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => { alive = false; unsubscribe(); window.removeEventListener("focus", refresh); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const openComputeSettings = () => {
      sessionStorage.setItem("launcher:settings-section", "compute");
      dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: "settings" });
      queueMicrotask(() => window.dispatchEvent(new Event("launcher:select-compute-settings")));
    };
    window.addEventListener("launcher:open-compute-settings", openComputeSettings);
    return () => window.removeEventListener("launcher:open-compute-settings", openComputeSettings);
  }, [dispatch]);
  const modeKey = (props.agentModesPending ? [] : availableAgentModes(enabledComputeProviders(state.launcher), providers ?? [])).join(",");
  const agentModesOverride = useMemo(
    () => modeKey.split(",").filter((mode): mode is "codebuddy" | "codex" | "dsh" => mode === "codebuddy" || mode === "codex" || mode === "dsh"),
    [modeKey],
  );
  return <AgentApp {...props} title={props.title ?? ASSISTANT_NAME} locale={locale} voiceHoldEnabled={state.launcher?.rightCtrlVoice ?? true} agentModesOverride={agentModesOverride} agentModesPending={!providers || props.agentModesPending === true} toolbar={<LauncherToolbar />} renderCoworkToolbar={settings => <LauncherToolbar conversationSettings={settings} />} authMode={authMode} themeManagedByHost showNavigation={false} layoutMode={layoutMode} newChatOnMount={startNewChat} closePanelsOnNewChat={closePanels} keepSidebarOnNewChat={keepSidebarOnNewChat} openSidebarOnMount={openSidebar} defaultPermissionMode="full" permissionLocked permissionPreferenceKey="launcher:permission-mode" composerPlaceholder={t("chat.placeholder")} emptyMessage="" className={`is-launcher is-launcher-${preview ? "preview" : "focus"}`} />;
}
