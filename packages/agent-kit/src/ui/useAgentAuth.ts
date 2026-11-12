"use client";

/**
 * agent-kit · 登录态 hook
 *
 * 宿主页面一行接入：请求会话端点判断登录态（登录为唯一路径，无游客模式）。
 * 返回 { loading, user }：
 *   - loading：请求进行中（渲染加载占位）
 *   - user：已登录用户（{ name, avatar?, unionId? }），未登录为 null
 */
import { useEffect, useState } from "react";

export interface AuthState {
  loading: boolean;
  user: { name: string; avatar?: string; unionId?: string; provider?: string; organizationName?: string; deptName?: string; sub?: string } | null;
}

export function useAgentAuth(basePath: string, enabled = true): AuthState {
  const [state, setState] = useState<AuthState>({ loading: enabled, user: null });

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, user: null });
      return;
    }
    let active = true;
    const desktop = Boolean((window as Window & { agentHost?: unknown }).agentHost);
    const controller = new AbortController();
    const timeout = desktop ? window.setTimeout(() => controller.abort(), 5000) : null;
    // credentials: "include"：跨源（Electron renderer ↔ 引擎不同端口）时也必须携带登录 cookie
    fetch(`${basePath.replace(/\/+$/, "")}/api/auth/session`, { cache: "no-store", credentials: "include", signal: controller.signal })
      .then(async (res) => {
        if (!active) return;
        if (!res.ok) {
          if (desktop && res.status >= 500) throw new Error("auth service unavailable");
          setState({ loading: false, user: null });
          return;
        }
        const data = (await res.json()) as {
          authenticated?: boolean;
          user?: { name: string; avatar?: string; unionId?: string; provider?: string; organizationName?: string; deptName?: string; sub?: string };
        };
        const user = data.authenticated ? data.user ?? null : null;
        if (user && (window as Window & { agentHost?: unknown }).agentHost) {
          try { window.localStorage.setItem("agent-kit:desktop-user", JSON.stringify(user)); } catch { /* storage unavailable */ }
        } else if (!user && (window as Window & { agentHost?: unknown }).agentHost) {
          try { window.localStorage.removeItem("agent-kit:desktop-user"); } catch { /* ignore */ }
        }
        setState({
          loading: false,
          user,
        });
      })
      .catch(() => {
        if (!active) return;
        let user: AuthState["user"] = null;
        if ((window as Window & { agentHost?: unknown }).agentHost) {
          try {
            const cached = JSON.parse(window.localStorage.getItem("agent-kit:desktop-user") || "null") as AuthState["user"];
            if (cached && typeof cached.unionId === "string" && cached.unionId) user = cached;
          } catch { /* ignore invalid cache */ }
        }
        setState({ loading: false, user });
      })
      .finally(() => { if (timeout !== null) window.clearTimeout(timeout); });
    return () => {
      active = false;
      controller.abort();
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [basePath, enabled]);

  return state;
}
