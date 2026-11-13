import { useEffect } from "react";

/** One authenticated socket for Launcher domain notifications. The database remains the source of truth. */
export default function ContactsDomainChannel({ baseUrl, onPending }: { baseUrl: string | null; onPending: (count: number) => void }) {
  useEffect(() => {
    if (!baseUrl) return;
    let active = true;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let generation = 0;
    let pendingIds: Set<string> | null = null;
    let pendingKey: string | null = null;
    let refreshQueue = Promise.resolve();
    function refresh(): Promise<void> {
      const currentGeneration = generation;
      refreshQueue = refreshQueue.then(() => refreshNow(currentGeneration));
      return refreshQueue;
    }
    async function refreshNow(currentGeneration: number) {
      if (!pendingKey) return;
      try {
        const result = await window.launcher.contactsApi("GET", "");
        if (!active || currentGeneration !== generation || !result.ok) return;
        const incoming = Array.isArray(result.data.incoming) ? result.data.incoming as Array<{ id: string | number }> : [];
        const nextIds = new Set(incoming.map(invitation => String(invitation.id)));
        onPending(nextIds.size);
        if (pendingIds && incoming.some(invitation => !pendingIds!.has(String(invitation.id)))) {
          const shown = await window.launcher.showNotification({ windowId: "contacts", sessionId: "friend-invitation", title: "新的好友邀请", body: "打开联系人查看并处理", silent: false });
          if (!active || currentGeneration !== generation) return;
          if (!shown) return;
          window.dispatchEvent(new CustomEvent("launcher:contacts-event"));
        }
        pendingIds = nextIds;
        try { localStorage.setItem(pendingKey, JSON.stringify([...nextIds])); } catch { /* storage is optional */ }
      } catch (error) { console.warn("[contacts] 刷新好友邀请失败：", error); }
    }
    async function connect() {
      if (!active) return;
      const currentGeneration = generation;
      try {
        const user = await window.launcher.getWebSession();
        if (!active || currentGeneration !== generation) return;
        if (!user || user.provider !== "builtin") { onPending(0); return; }
        if (!pendingKey) {
          pendingKey = `launcher:pending-invitations:${user.sub}`;
          try {
            const saved = JSON.parse(localStorage.getItem(pendingKey) || "[]");
            pendingIds = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
          } catch { pendingIds = new Set(); }
        }
        await refresh();
        if (!active || currentGeneration !== generation) return;
        const ticket = await window.launcher.getDomainTicket();
        if (!active || currentGeneration !== generation) return;
        if (!ticket) { retry = window.setTimeout(() => void connect(), 3000); return; }
        const url = new URL(`${baseUrl}/api/realtime`);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(url.toString(), ["agent-realtime", `ticket.${ticket}`]);
        socket = ws;
        ws.onopen = () => { void refresh(); };
        ws.onmessage = event => {
          try {
            const frame = JSON.parse(event.data) as { op?: string; channel?: string; event?: string };
            if (frame.op !== "domain_event" || frame.channel !== "domain:contacts") return;
            window.dispatchEvent(new CustomEvent("launcher:contacts-event", { detail: frame }));
            void refresh();
          } catch { /* ignore malformed frame */ }
        };
        ws.onclose = () => { if (active && socket === ws) { socket = null; retry = window.setTimeout(() => void connect(), 3000); } };
        ws.onerror = () => ws.close();
      } catch { if (active) retry = window.setTimeout(() => void connect(), 3000); }
    }
    void connect();
    const off = window.launcher.onWebSessionChanged(() => { generation++; pendingIds = null; pendingKey = null; const old = socket; socket = null; old?.close(); if (retry) window.clearTimeout(retry); void connect(); });
    const poll = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { active = false; off(); window.clearInterval(poll); if (retry) window.clearTimeout(retry); socket?.close(); };
  }, [baseUrl, onPending]);
  return null;
}
