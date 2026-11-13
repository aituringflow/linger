import { useEffect } from "react";
import { ASSISTANT_NAME, summarizeForNotify } from "@turingflow/agent-kit/ui";
import { LauncherApp } from "../LauncherApp";
import { localAgentUrl } from "../localAgentUrl";
import { playLauncherNotificationSound } from "../dock/notificationSound";
import { useLauncher } from "../state";

/** 全屏聊天工作区：由 kit AgentWindow（三栏）承担会话/聊天/产物，launcher 只保留返回桌面的外壳。 */
export default function Workspace() {
  const { state, dispatch } = useLauncher();
  const agentHost = state.agentHost;

  // 同 QuickInput：工作区实例卸载后不能再把旧计数留在 Dock 上。
  // 全屏工作区不占 openWindows（它是 Home 的另一种呈现），计数用独立 key 上报。
  useEffect(() => () => { dispatch({ type: "SET_RUNNING_SESSIONS", windowId: "workspace", sessions: [] }); }, [dispatch]);

  function backToDesktop() {
    dispatch({ type: "SET_VIEW", view: "desktop" });
  }

  return (
    <div className="workspace">
      <div className="ws-agent">
        {agentHost ? (
          <LauncherApp
            layoutMode="fixed"
            authMode="local-guest"
            basePath="/"
            chatEndpoint={localAgentUrl(agentHost.url, "/chat")}
            artifactEndpoint={localAgentUrl(agentHost.url, "/artifact")}
            scenes={null}
            models={state.models}
            voiceEnabled={true}
            showVoiceButton={state.launcher?.showVoiceButton ?? true}
            voiceTokenEndpoint={localAgentUrl(agentHost.url, "/api/voice/token")}
            voiceTranscribeEndpoint={localAgentUrl(agentHost.url, "/api/voice/transcribe")}
            showModel={state.launcher?.showModel ?? false}
            showContextUsage={state.launcher?.showContextUsage ?? false}
            onShowContextUsageChange={(show) => dispatch({ type: "SET_SHOW_CONTEXT_USAGE", show })}
            onReplyNotification={({ sessionId, title, text, runId }) => {
              const sound = state.launcher?.notificationSound ?? "system";
              playLauncherNotificationSound(sound, `launcher-workspace-${sessionId}`);
              void window.launcher.showNotification({
                windowId: "workspace",
                sessionId,
                runId,
                title: title || ASSISTANT_NAME,
                body: summarizeForNotify(text),
                silent: sound !== "system",
              }).catch((error) => console.warn("[launcher] 发送通知失败：", error));
            }}
            sessionRequest={state.sessionRequests.workspace}
            onSessionRequestHandled={(nonce) => {
              if (state.sessionRequests.workspace?.nonce !== nonce) return;
              dispatch({ type: "CLEAR_SESSION_REQUEST", windowId: "workspace", nonce });
            }}
            onRunningSessionsChange={(_count, sessions) => dispatch({ type: "SET_RUNNING_SESSIONS", windowId: "workspace", sessions })}
          />
        ) : null}
      </div>
      <div className="ws-return-bar">
        <button className="ws-return" onClick={backToDesktop}>← 返回桌面</button>
      </div>
    </div>
  );
}
