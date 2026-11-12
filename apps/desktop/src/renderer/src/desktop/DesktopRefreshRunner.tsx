import { useEffect, useMemo, useRef } from "react";
import { LauncherApp } from "../LauncherApp";
import { localAgentUrl } from "../localAgentUrl";
import { useLauncher } from "../state";

/** Keeps the normal kit session runtime alive while the user stays on the desktop. */
export default function DesktopRefreshRunner({ sessionId, nonce, onFinished }: {
  sessionId: string;
  nonce: number;
  onFinished: (sessionId: string, error?: string) => void;
}) {
  const { state, dispatch } = useLauncher();
  const started = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const windowId = `desktop-refresh-${nonce}`;
  const rerunRequest = useMemo(() => ({ sessionId, nonce }), [sessionId, nonce]);

  useEffect(() => () => {
    if (finishTimer.current) clearTimeout(finishTimer.current);
    dispatch({ type: "SET_SESSION_CARDS", windowId, cards: [] });
    dispatch({ type: "SET_RUNNING_SESSIONS", windowId, sessions: [] });
  }, [dispatch, windowId]);
  useEffect(() => {
    const timer = setTimeout(() => { if (!started.current) finishedRef.current(sessionId, "刷新启动超时"); }, 20000);
    return () => clearTimeout(timer);
  }, [sessionId, nonce]);

  /* 账号身份必须和真实聊天窗一致（本机会话按 owner 分目录），否则读不到目标会话。 */
  const webUser = state.webUser;
  const cloudBase = state.webAuth?.url ?? "";
  useEffect(() => {
    (globalThis as typeof globalThis & { __agentKitCloudBase?: string }).__agentKitCloudBase = webUser && cloudBase ? cloudBase : undefined;
  }, [webUser, cloudBase]);

  /* 身份没解析完先别挂 —— 挂早了会以访客身份跑一遍，白白失败一次。 */
  if (!state.agentHost || !state.webUserResolved) return null;
  return <div className="desktop-refresh-runner" aria-hidden="true">
    <LauncherApp authMode="local-guest" basePath={cloudBase || "/"} localGuestUser={webUser ?? undefined} cloudEnabled={Boolean(webUser)} scenes={null} models={state.models}
      chatEndpoint={localAgentUrl(state.agentHost.url, "/chat")}
      artifactEndpoint={localAgentUrl(state.agentHost.url, "/artifact")}
      backgroundMode shortcutsActive={false} renderPanels={() => null}
      rerunRequest={rerunRequest}
      onRerunRequestHandled={(_handledNonce, error) => { if (error) onFinished(sessionId, error); }}
      /* 同 DesktopSendRunner：这一轮跑在隐藏实例里，运行态要报回宿主（Dock 任务数角标）。 */
      onRunningSessionsChange={(count, sessions) => {
        dispatch({ type: "SET_RUNNING_SESSIONS", windowId, sessions: sessions.filter((sid) => sid === sessionId) });
        if (count > 0) { started.current = true; if (finishTimer.current) clearTimeout(finishTimer.current); return; }
        if (started.current && !finishTimer.current) finishTimer.current = setTimeout(() => onFinished(sessionId), 800);
      }}
      onSessionSnapshotsChange={(cards) => dispatch({ type: "SET_SESSION_CARDS", windowId, cards: cards.filter((card) => card.sessionId === sessionId) })} />
  </div>;
}
