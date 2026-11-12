"use client";

/**
 * agent-kit · 一站式应用入口
 *
 * 宿主首页一行接入即可获得完整体验（必须登录，无游客模式）：
 *
 *   <AgentApp basePath="/linger" title="AI 助手" sidebarLogo="/linger/logo.png" />
 *
 * 内部职责：
 *   1. useAgentAuth：请求 /api/auth/session 判断登录态；
 *   2. 已登录 → 渲染 <AgentWindow>（继承 AgentWindowProps 全部参数）；
 *   3. 未登录 → 跳转 basePath/login，由服务端登录页按 AUTH_PROVIDER 决策
 *      （单方式直接 302 到 OAuth；多方式渲染登录方式选择器）；
 *   4. onLogout 默认实现：POST /api/auth/logout → 跳转登录页（宿主可覆盖）。
 */
import { useEffect, useLayoutEffect } from "react";
import { ChatLocaleProvider, useChatTranslation } from "./chat/i18n.tsx";
import { useAgentAuth } from "./useAgentAuth.js";
import AgentWindow from "./AgentWindow.tsx";
import { AgentAppToolbar } from "./components/AgentAppToolbar.tsx";
import type { ChatUser, AgentWindowProps } from "./AgentWindow.tsx";
import { initTheme } from "./shared/theme.ts";
import { localChatAvailable } from "./chat/localChatStore.ts";

export interface AgentAppProps extends AgentWindowProps {
  /** 加载占位的自定义内容 */
  loadingFallback?: React.ReactNode;
  /** 本地桌面游客：跳过网络登录，使用独立的本机会话身份。需要 localChat 桥。 */
  authMode?: "required" | "local-guest";
  localGuestUser?: { name: string; avatar?: string; provider: string; unionId: string };
}

export function AgentApp(props: AgentAppProps) {
  return <ChatLocaleProvider locale={props.locale}><AgentAppContent {...props} /></ChatLocaleProvider>;
}

function AgentAppContent({ loadingFallback, authMode = "required", localGuestUser, ...chat }: AgentAppProps) {
  const t = useChatTranslation();
  useLayoutEffect(() => { if (!chat.themeManagedByHost) initTheme(); }, [chat.themeManagedByHost]);
  const basePath = chat.basePath ?? "/";
  const root = basePath.replace(/\/+$/, "");
  // App 传入的登录方式（AUTH_PROVIDER）：拼到 /login?providers= 让 web 登录页优先采用，
  // 不传则登录页仅显示 builtin。
  const loginQuery = chat.loginProviders ? `?providers=${encodeURIComponent(chat.loginProviders)}` : "";
  const guest = authMode === "local-guest";
  const { loading, user: signedInUser } = useAgentAuth(basePath, !guest);
  const user: { name: string; avatar?: string; provider?: string; unionId?: string; organizationName?: string; deptName?: string } | null = guest ? localGuestUser ?? { name: t("guest"), provider: "local", unionId: "guest" } : signedInUser;

  // 退出登录：默认 POST /api/auth/logout 后跳登录页；宿主可通过 onLogout 覆盖
  const logout =
    chat.onLogout ??
    (async () => {
      try {
        await fetch(`${root}/api/auth/logout`, { method: "POST", credentials: "include" });
      } catch {
        /* 忽略网络错误，仍跳转 */
      }
      window.location.replace(`${root}/login${loginQuery}`);
    });

  // 未登录：交给服务端登录页。AUTH_PROVIDER 单方式 → 服务端直接 302 到 OAuth；
  // 多方式 → 服务端渲染 <LoginPage> 选择器。客户端不做重复判断。
  useEffect(() => {
    if (!guest && !loading && !user) {
      window.location.replace(`${root}/login${loginQuery}`);
    }
  }, [guest, loading, user, root, loginQuery]);

  if (loading) {
    // 首屏登录态探测占位：居中黑白灰 spinner（替代原来的左上角文字“加载中…”）
    return (
      loadingFallback ?? (
        <div className="agent-kit-loading" role="status" aria-label={t("loading")} />
      )
    );
  }

  if (!user) return null; // 即将跳转登录页
  if (guest && !localChatAvailable()) return <div role="alert">{t("localStorageUnavailable")}</div>;

  const initialUser: ChatUser = {
    name: user.name,
    avatar: user.avatar,
    unionId: user.unionId,
    provider: user.provider,
    organizationName: user.organizationName,
    department: user.deptName,
  };
  return <AgentWindow {...chat} toolbar={chat.toolbar ?? <AgentAppToolbar />} showNavigation={chat.showNavigation ?? true} basePath={basePath} initialUser={initialUser} localGuest={guest} onLogout={logout} />;
}
