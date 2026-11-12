import { apiFetch } from "./apiFetch.ts";
import { markWsState } from "./connectionStatus.ts";

export type RealtimeFrame = { channel: string; seq: number; event: string; data: Record<string, unknown>; runId?: string | null };
type Listener = { onEvent: (frame: RealtimeFrame) => void; onConnect?: () => void };
const clients = new Map<string, RealtimeClient>();

class RealtimeClient {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private inboxListeners = new Set<{ onSessionAdded: (sessionId: string) => void; onSessionMessage?: (sessionId: string) => void; onConnect?: () => void }>();
  private pending = new Map<string, { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void; timer: number }>();
  private reconnectTimer: number | null = null;
  private attempts = 0;
  private connecting = false;
  private closed = false;
  constructor(private basePath: string) {
    const resume = () => {
      if (!this.listeners.size && !this.inboxListeners.size || this.socket?.readyState === WebSocket.OPEN) return;
      if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      void this.connect();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
  }

  private cursorKey(channel: string) { return `agent-realtime:${channel}`; }
  private cursor(channel: string): number {
    const n = Number(sessionStorage.getItem(this.cursorKey(channel)) || 0);
    return Number.isSafeInteger(n) && n > 0 ? n : 0;
  }
  private send(data: unknown) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(data)); }
  isConnected() { return this.socket?.readyState === WebSocket.OPEN; }
  /** 汇总实时通道对「全局在线状态」的贡献：有订阅时必须能连上；无订阅视为可达。 */
  private wsStatus() {
    const expected = this.listeners.size > 0 || this.inboxListeners.size > 0;
    const ok = !expected || this.connecting || (this.socket !== null && this.socket.readyState <= WebSocket.OPEN);
    return { expected, ok };
  }
  private notifyStatus() { markWsState(this.wsStatus()); }
  /** 手动重试：清掉退避定时器立即重连；已在连接中/已连接/已永久关闭时忽略。 */
  retryNow() {
    if (this.closed || this.connecting) return;
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    void this.connect();
  }
  private async connect() {
    if (this.closed || this.connecting || this.socket && this.socket.readyState <= WebSocket.OPEN) return;
    this.connecting = true;
    try {
      const response = await apiFetch(`${this.basePath}/api/realtime-ticket`, { cache: "no-store" });
      if (!response.ok) throw new Error("realtime authentication failed");
      const { ticket } = await response.json() as { ticket: string };
      const url = new URL(`${this.basePath}/api/realtime`, window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url, ["agent-realtime", `ticket.${ticket}`]);
      this.socket = socket;
      this.connecting = false;
      socket.onopen = () => {
        this.attempts = 0;
        for (const listener of this.inboxListeners) listener.onConnect?.();
        for (const [channel, listeners] of this.listeners) {
          this.send({ op: "subscribe", channel, after: this.cursor(channel) });
        }
        this.notifyStatus();
      };
      socket.onmessage = event => {
        try {
          const frame = JSON.parse(String(event.data)) as RealtimeFrame & { op?: string; requestId?: string; ok?: boolean; error?: string; cursor?: number; sessionId?: string };
          if (frame.op === "subscribed" && frame.channel) {
            if (Number.isSafeInteger(frame.cursor)) sessionStorage.setItem(this.cursorKey(frame.channel), String(frame.cursor));
            for (const listener of this.listeners.get(frame.channel) ?? []) listener.onConnect?.();
            return;
          }
          if (frame.op === "response" && frame.requestId) {
            const pending = this.pending.get(frame.requestId);
            if (!pending) return;
            clearTimeout(pending.timer); this.pending.delete(frame.requestId);
            if (frame.ok) pending.resolve(frame.data);
            else pending.reject(new Error(frame.error || "请求失败"));
            return;
          }
          if (frame.op === "session_added" && typeof frame.sessionId === "string") {
            for (const listener of this.inboxListeners) listener.onSessionAdded(frame.sessionId);
            return;
          }
          if (frame.op === "session_message" && typeof frame.sessionId === "string") {
            for (const listener of this.inboxListeners) listener.onSessionMessage?.(frame.sessionId);
            return;
          }
          if (!frame.channel || !frame.event || !Number.isSafeInteger(frame.seq)) return;
          if (frame.seq <= this.cursor(frame.channel)) return;
          for (const listener of this.listeners.get(frame.channel) ?? []) listener.onEvent(frame);
          sessionStorage.setItem(this.cursorKey(frame.channel), String(frame.seq));
        } catch (error) { console.error("[realtime] invalid event", error); }
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(new Error("连接中断，请重试")); this.pending.delete(id); }
        this.notifyStatus();
        this.scheduleReconnect();
      };
      socket.onerror = () => socket.close();
    } catch { this.connecting = false; this.scheduleReconnect(); this.notifyStatus(); }
  }
  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer !== null || !this.listeners.size && !this.inboxListeners.size) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempts++, 6)) * (0.8 + Math.random() * 0.4);
    this.reconnectTimer = window.setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
  }
  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    const first = !set;
    if (!set) { set = new Set(); this.listeners.set(channel, set); }
    set.add(listener);
    if (this.socket?.readyState === WebSocket.OPEN) { if (first) this.send({ op: "subscribe", channel, after: this.cursor(channel) }); else listener.onConnect?.(); }
    else void this.connect();
    this.notifyStatus();
    return () => {
      set!.delete(listener);
      if (!set!.size) { this.listeners.delete(channel); this.send({ op: "unsubscribe", channel }); }
      if (!this.listeners.size && !this.inboxListeners.size) { this.socket?.close(); this.socket = null; }
      this.notifyStatus();
    };
  }
  subscribeInbox(listener: { onSessionAdded: (sessionId: string) => void; onSessionMessage?: (sessionId: string) => void; onConnect?: () => void }): () => void {
    this.inboxListeners.add(listener);
    if (this.socket?.readyState === WebSocket.OPEN) listener.onConnect?.();
    else void this.connect();
    this.notifyStatus();
    return () => {
      this.inboxListeners.delete(listener);
      if (!this.listeners.size && !this.inboxListeners.size) { this.socket?.close(); this.socket = null; }
      this.notifyStatus();
    };
  }
  request(channel: string, action: "send" | "reaction" | "settings", data: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      void this.connect();
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const wait = () => {
          if (this.socket?.readyState === WebSocket.OPEN) { void this.request(channel, action, data).then(resolve, reject); return; }
          if (Date.now() - started > 10_000) { reject(new Error("连接中断，请重试")); return; }
          window.setTimeout(wait, 100);
        };
        wait();
      });
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(requestId); reject(new Error("请求超时，请重试")); }, 20_000);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ op: "request", requestId, channel, action, data });
    });
  }
}

/** Compatibility adapter for the existing cowork UI event handlers. */
export function coworkRealtimeSource(basePath: string, channel: string): {
  onopen: (() => void | Promise<void>) | null; onerror: (() => void) | null;
  addEventListener: (type: string, handler: (event: MessageEvent) => void) => void;
  close: () => void;
} {
  const handlers = new Map<string, Set<(event: MessageEvent) => void>>();
  let ready = false;
  const queued: RealtimeFrame[] = [];
  const dispatch = (frame: RealtimeFrame) => {
    const ai = ["text", "thinking", "tool", "tool_result", "ask_question", "artifact", "error", "done"].includes(frame.event);
    const type = ai ? "agent" : frame.event;
    const data = ai ? { runId: frame.runId, event: frame.event, data: frame.data } : frame.data;
    const event = { data: JSON.stringify(data) } as MessageEvent;
    for (const handler of handlers.get(type) ?? []) handler(event);
  };
  const source = {
    onopen: null as (() => void | Promise<void>) | null,
    onerror: null as (() => void) | null,
    addEventListener(type: string, handler: (event: MessageEvent) => void) {
      let set = handlers.get(type);
      if (!set) { set = new Set(); handlers.set(type, set); }
      set.add(handler);
    },
    close: () => unsubscribe(),
  };
  const unsubscribe = realtimeClient(basePath).subscribe(channel, {
    onConnect: () => queueMicrotask(() => {
      ready = false;
      void Promise.resolve(source.onopen?.()).then(() => {
        ready = true;
        for (const frame of queued.splice(0)) dispatch(frame);
      }).catch(() => { ready = true; for (const frame of queued.splice(0)) dispatch(frame); });
    }),
    onEvent: frame => {
      if (ready) dispatch(frame);
      else queued.push(frame);
    },
  });
  return source;
}

export function realtimeClient(basePath: string): RealtimeClient {
  let client = clients.get(basePath);
  if (!client) { client = new RealtimeClient(basePath); clients.set(basePath, client); }
  return client;
}
