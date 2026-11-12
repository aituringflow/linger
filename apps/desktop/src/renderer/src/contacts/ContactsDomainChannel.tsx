import { useEffect } from "react";

/** One authenticated socket for Launcher domain notifications. The database remains the source of truth. */
export default function ContactsDomainChannel({ baseUrl, onPending }: { baseUrl: string | null; onPending: (count: number) => void }) {
  useEffect(() => {
    if (!baseUrl) return;
    let active = true;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    async function refresh() {
      try {
        const result = await window.launcher.contactsApi("GET", "");
        if (active) onPending(result.ok ? Number(result.data.incoming?.length || 0) : 0);
      } catch { if (active) onPending(0); }
    }
    async function connect() {
      if (!active) return;
      try {
        const user = await window.launcher.getWebSession();
        if (!user || user.provider !== "builtin") { onPending(0); return; }
        await refresh();
        const ticket = await window.launcher.getDomainTicket();
        if (!ticket || !active) { if (active) retry = window.setTimeout(() => void connect(), 3000); return; }
        const url = new URL(`${baseUrl}/api/realtime`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(url.toString(), ["agent-realtime", `ticket.${ticket}`]);
        socket = ws;
        ws.onmessage = event => {
          try {
            const frame = JSON.parse(event.data) as { op?: string; channel?: string; event?: string };
            if (frame.op !== "domain_event" || frame.channel !== "domain:contacts") return;
            window.dispatchEvent(new CustomEvent("launcher:contacts-event", { detail: frame }));
            void refresh();
            if (frame.event === "friend_invitation") {
              void window.launcher.showNotification({ windowId: "contacts", sessionId: "friend-invitation", title: "新的好友邀请", body: "打开联系人查看并处理", silent: false });
            }
          } catch { /* ignore malformed frame */ }
        };
        ws.onclose = () => { if (active && socket === ws) { socket = null; retry = window.setTimeout(() => void connect(), 3000); } };
        ws.onerror = () => ws.close();
      } catch { if (active) retry = window.setTimeout(() => void connect(), 3000); }
    }
    void connect();
    const off = window.launcher.onWebSessionChanged(() => { const old = socket; socket = null; old?.close(); if (retry) window.clearTimeout(retry); void connect(); });
    const poll = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { active = false; off(); window.clearInterval(poll); if (retry) window.clearTimeout(retry); socket?.close(); };
  }, [baseUrl, onPending]);
  return null;
}
