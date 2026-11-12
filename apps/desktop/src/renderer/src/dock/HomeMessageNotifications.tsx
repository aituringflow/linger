import { useEffect } from "react";
import { summarizeForNotify } from "@turingflow/agent-kit/ui";
import { useLauncher } from "../state";
import { playLauncherNotificationSound } from "./notificationSound";

/** Keep the inbox subscribed even when every Home chat window is closed. */
export default function HomeMessageNotifications({ baseUrl, onMessage }: { baseUrl: string | null; onMessage: () => void }) {
  const { state } = useLauncher();
  const sound = state.launcher?.notificationSound ?? "system";
  useEffect(() => {
    if (!baseUrl) return;
    let active = true;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    const seen = new Map<string, number>();
    async function notify(sessionId: string, ownSub: string) {
      const result = await window.launcher.webChatApi("GET", `/api/sessions/${encodeURIComponent(sessionId)}/messages`);
      if (!active || result.status !== 200) return;
      const data = JSON.parse(result.body) as { messages?: Array<{ id: number; role: string; senderSub?: string; senderName?: string; content?: string; revokedAt?: string }> };
      const message = data.messages?.slice().reverse().find(item => !item.revokedAt);
      if (!message || (message.role !== "user" && message.role !== "assistant") || (message.role === "user" && message.senderSub === ownSub) || message.id <= (seen.get(sessionId) ?? 0)) return;
      seen.set(sessionId, message.id);
      const title = message.senderName?.trim() || (message.role === "assistant" ? "AI 助手" : "新消息");
      if (sound !== "system") playLauncherNotificationSound(sound, `launcher-primary-${sessionId}`);
      void window.launcher.showNotification({ windowId: "primary", sessionId, runId: `message-${message.id}`,
        title, body: summarizeForNotify(message.content || "[附件]"), silent: sound !== "system" });
    }
    async function connect() {
      if (!active) return;
      try {
        const user = await window.launcher.getWebSession();
        if (!user || !active) return;
        const ticket = await window.launcher.getDomainTicket();
        if (!ticket || !active) { retry = window.setTimeout(() => void connect(), 3000); return; }
        const url = new URL(`${baseUrl}/api/realtime`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(url, ["agent-realtime", `ticket.${ticket}`]);
        socket = ws;
        ws.onmessage = event => {
          try {
            const frame = JSON.parse(String(event.data)) as { op?: string; sessionId?: string };
            if (frame.op === "session_message" && frame.sessionId) {
              onMessage();
              void notify(frame.sessionId, user.sub);
            }
          } catch { /* Ignore malformed frames. */ }
        };
        ws.onclose = () => { if (active && socket === ws) { socket = null; retry = window.setTimeout(() => void connect(), 3000); } };
        ws.onerror = () => ws.close();
      } catch { if (active) retry = window.setTimeout(() => void connect(), 3000); }
    }
    void connect();
    const off = window.launcher.onWebSessionChanged(() => { socket?.close(); socket = null; if (retry) clearTimeout(retry); void connect(); });
    return () => { active = false; off(); if (retry) clearTimeout(retry); socket?.close(); };
  }, [baseUrl, onMessage, sound]);
  return null;
}
