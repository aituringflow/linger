import { useEffect, useMemo, useRef } from "react";
import type { UiAttachment } from "@turingflow/agent-kit/ui";
import { LauncherApp } from "../LauncherApp";
import { localAgentUrl } from "../localAgentUrl";
import { useLauncher } from "../state";

/**
 * 后台发送器：桌面把文件拖到会话卡片后，由这个隐藏实例把消息发出去。
 *
 * 桌面本身没有输入框，真正发消息的是 kit 的 AgentWindow ——
 * 所以挂一个看不见的 LauncherApp，用宿主协议 sendRequest 驱动它：
 * 切到目标会话 → 发一条只带附件的用户消息 → 跑完这一轮后回调宿主卸载自己。
 *
 * 和 DesktopRefreshRunner 是同一套模式（后台动作都在隐藏实例里跑）。
 */
export default function DesktopSendRunner({ sessionId, nonce, text, attachments, onFinished }: {
  sessionId: string;
  /** 每次请求的唯一号：宿主重复挂载时靠它区分是不是同一次请求。 */
  nonce: number;
  /** 正文；本场景留空 —— 消息只有附件。 */
  text: string;
  attachments: UiAttachment[];
  onFinished: (sessionId: string, error?: string) => void;
}) {
  const { state, dispatch } = useLauncher();
  const started = useRef(false);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const windowId = `desktop-send-${nonce}`;
  const sendRequest = useMemo(() => ({ sessionId, nonce, text, attachments }), [sessionId, nonce, text, attachments]);

  useEffect(() => () => {
    if (finishTimer.current) clearTimeout(finishTimer.current);
    dispatch({ type: "SET_SESSION_CARDS", windowId, cards: [] });
    // 卸载时把自己上报的运行中会话清掉：桌面「进行中」角标不该留着已结束的计数。
    dispatch({ type: "SET_RUNNING_SESSIONS", windowId, sessions: [] });
  }, [dispatch, windowId]);
  useEffect(() => {
    const timer = setTimeout(() => { if (!started.current) finishedRef.current(sessionId, "发送启动超时"); }, 20000);
    return () => clearTimeout(timer);
  }, [sessionId, nonce]);

  /* 账号身份必须和真实聊天窗一致：
   * 本机会话按 owner 分目录（<userData>/chats/<base64url(provider:unionId)>），
   * 隐藏实例不传身份就会落到访客目录 local:guest，读不到目标会话，
   * kit 会直接回「会话不存在或不支持发送」。 */
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
      sendRequest={sendRequest}
      onSendRequestHandled={(_handledNonce, error) => { if (error) finishedRef.current(sessionId, error); }}
      /* 把这一轮的运行状态报回宿主状态（Dock 上的任务数角标）与桌面卡片（转圈）：
       * 桌面拖文件时真正跑这轮的是这个隐藏实例，不报的话 Home 上永远看不到「1 个任务在跑」。
       * 卸载/结束时自己归零，与真实聊天窗的上报按会话 id 去重，不会把一轮算成两个。 */
      onRunningSessionsChange={(count, sessions) => {
        dispatch({ type: "SET_RUNNING_SESSIONS", windowId, sessions: sessions.filter((sid) => sid === sessionId) });
        if (count > 0) { started.current = true; if (finishTimer.current) clearTimeout(finishTimer.current); return; }
        if (started.current && !finishTimer.current) finishTimer.current = setTimeout(() => finishedRef.current(sessionId), 800);
      }}
      /* 把这一轮的运行状态报回桌面：卡片据此转圈（和「刷新」用的是同一套机制）。 */
      onSessionSnapshotsChange={(cards) => dispatch({ type: "SET_SESSION_CARDS", windowId, cards: cards.filter((card) => card.sessionId === sessionId) })} />
  </div>;
}
