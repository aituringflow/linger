import type { Server as HttpServer, IncomingMessage } from "node:http";
import type { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import type { PoolClient } from "pg";
import { createCoworkHandlers } from "./cowork.js";
import { createAgentApiRoute } from "./handlers.js";
import { ensureMigrated, getAgentSession, getPool } from "./auth/db.js";
import { verifyRealtimeTicket } from "./realtime-ticket.js";
import { createSessionToken, parseSessionKey } from "./auth/session.js";
import { loadAuthConfig } from "./auth/config.js";
import type { SessionUser } from "./auth/types.js";

type Channel = { cursor: number; busy: boolean; pending: boolean; checkedAt: number };
type Peer = { ws: WebSocket; sub: string; cookie: string; channels: Map<string, Channel>; alive: boolean };
type EventRow = { seq: string; session_id: string; event: string; data: unknown; run_id: string | null };
const MAX_CHANNELS = 256;
const MAX_BUFFERED = 1024 * 1024;

/** Mount on the same HTTP server as Next, before Next handles upgrade requests. */
export async function installRealtimeGateway(server: HttpServer): Promise<void> {
  await ensureMigrated();
  const pool = getPool();
  if (!pool) throw new Error("realtime requires PostgreSQL");
  // WS 路径挂在应用部署子路径下，与 HTTP 侧 basePath 保持一致（默认 /agent）。
  // 宿主改了 basePath 却没同步这里，upgrade 会被静默丢弃，前端只表现为一直重连。
  const basePath = (process.env.AUTH_COOKIE_PATH || "/linger").replace(/\/+$/, "");
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, handleProtocols: protocols => protocols.has("agent-realtime") ? "agent-realtime" : false });
  const peers = new Set<Peer>();
  let nextConnectionId = 0;
  const cowork = createCoworkHandlers(createAgentApiRoute({}));
  const send = (peer: Peer, data: unknown) => {
    if (peer.ws.readyState !== WebSocket.OPEN) return;
    if (peer.ws.bufferedAmount > MAX_BUFFERED) { peer.ws.close(1013, "slow client"); return; }
    peer.ws.send(JSON.stringify(data));
  };
  const drain = async (peer: Peer, sessionId: string, channel: Channel) => {
    if (channel.busy) { channel.pending = true; return; }
    channel.busy = true;
    try {
      do {
        channel.pending = false;
        while (peer.ws.readyState === WebSocket.OPEN && peer.channels.get(sessionId) === channel) {
          const result = await pool.query<EventRow>(
            "SELECT seq,session_id,event,data,run_id FROM realtime_events WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT 200",
            [sessionId, channel.cursor],
          );
          if (result.rows.length || Date.now() - channel.checkedAt > 30_000) {
            if (!await getAgentSession(peer.sub, sessionId)) {
              peer.channels.delete(sessionId);
              send(peer, { op: "error", channel: sessionId, code: "forbidden" });
              return;
            }
            channel.checkedAt = Date.now();
          }
          if (!result.rows.length) break;
          for (const row of result.rows) {
            const seq = Number(row.seq);
            const privateRecipient = row.event === "chatmate" ? (row.data as { userSub?: unknown } | null)?.userSub : null;
            if (row.event !== "chatmate" || privateRecipient === peer.sub)
              send(peer, { channel: sessionId, seq, event: row.event, data: row.data, runId: row.run_id });
            channel.cursor = seq;
          }
          if (result.rows.length < 200) break;
        }
      } while (channel.pending);
    } catch (error) {
      console.error("[realtime] replay failed", error);
      peer.ws.close(1011, "replay failed");
    } finally { channel.busy = false; }
  };
  const wake = (sessionId?: string) => { for (const peer of peers) for (const [id, channel] of peer.channels) {
    if (!sessionId || id === sessionId) void drain(peer, id, channel);
  } };
  // ---- 自愈的 PostgreSQL 通知监听器 ----
  // LISTEN 连接一旦丢失（网络闪断、NAT 空闲掐断、PG 重启等），实时推送会静默退化为 15s 兜底轮询。
  // 这里通过周期健康检查 + 断线自动重建 + 重新 LISTEN 保证通知通道始终可用。
  const NOTIFY_CHANNELS = ["agent_realtime", "agent_session_changes", "agent_domain_events"] as const;
  let listenerClient: PoolClient | null = null;
  let listenerRetryTimer: NodeJS.Timeout | null = null;
  let listenerHealthTimer: NodeJS.Timeout | null = null;
  let listenerStarting = false;
  let listenerAttempts = 0;
  let listenerStopped = false;

  const onNotification = (message: { channel?: string; payload?: string }) => {
    if (message.channel === "agent_domain_events") {
      try {
        const event = JSON.parse(message.payload ?? "{}") as { userSub?: string; domain?: string; type?: string; id?: string };
        if (!event.userSub || event.domain !== "contacts") return;
        for (const peer of peers) if (peer.sub === event.userSub)
          send(peer, { op: "domain_event", channel: `domain:${event.domain}`, event: event.type, id: event.id });
      } catch (error) { console.error("[realtime] invalid domain notification", error); }
      return;
    }
    if (message.channel === "agent_session_changes") {
      try {
        const payload = JSON.parse(message.payload ?? "{}") as { userSub?: string; sessionId?: string; type?: string };
        if (!payload.userSub || !payload.sessionId) return;
        // 新会话（成员加入）→ session_added；会话新消息 → session_message（前端即时刷新未读数）
        const op = payload.type === "message" ? "session_message" : "session_added";
        for (const peer of peers) if (peer.sub === payload.userSub) send(peer, { op, sessionId: payload.sessionId });
      } catch (error) { console.error("[realtime] invalid session notification", error); }
      return;
    }
    wake(message.payload);
  };

  const scheduleListenerRestart = (reason: string) => {
    if (listenerStopped || listenerRetryTimer) return;
    const delay = Math.min(15_000, 1_000 * 2 ** Math.min(listenerAttempts, 4)) * (0.8 + Math.random() * 0.4);
    console.warn(`[realtime] 通知监听连接异常（${reason}），${Math.round(delay)}ms 后重建`);
    listenerRetryTimer = setTimeout(() => {
      listenerRetryTimer = null;
      void startNotificationListener();
    }, delay);
  };

  /** 丢弃一条已经坏掉的 LISTEN 连接。
   *  ⚠️ 必须 release：LISTEN 客户端是 `pool.connect()` **借出**的，把 listenerClient 置 null
   *  只是忘了它，池里那个槽位仍然算被占用。远程 PG 抖一下就会重建一次监听，
   *  不归还的话每次漏 1 个连接，池 max=5 → 抖 5 次后池彻底空，本进程（自定义 server 里的
   *  实时 + 终端网关共用一个池）所有查询都要等到 connectionTimeoutMillis(20s) 才报错：
   *  表现就是「终端一直提示重连」「实时订阅超时」。 */
  const dropListenerClient = (client: PoolClient) => {
    try { (client as unknown as EventEmitter).removeAllListeners(); } catch { /* 忽略 */ }
    // release(true) = 直接销毁这条连接、不还回池（连接已坏）。
    // @types/pg 把 release 声明成无参，这里按运行时签名调用。
    try { (client as unknown as { release: (destroy?: boolean) => void }).release(true); } catch { /* 连接已断开时 release 可能抛错 */ }
  };

  const startNotificationListener = async () => {
    if (listenerStopped || listenerStarting) return;
    listenerStarting = true;
    // 兜底：万一还有一条没被清掉的旧监听连接，先丢弃再建新的，避免它继续占着池槽位。
    if (listenerClient) { const stale = listenerClient; listenerClient = null; dropListenerClient(stale); }
    let client: PoolClient | null = null;
    try {
      client = await pool.connect();
      for (const channelName of NOTIFY_CHANNELS) await client.query(`LISTEN ${channelName}`);
      listenerClient = client;
      listenerAttempts = 0;
      const emitter = client as unknown as EventEmitter;
      emitter.on("notification", onNotification);
      emitter.on("error", (error: Error) => {
        if (listenerClient === client) {
          listenerClient = null;
          console.error("[realtime] PostgreSQL listener failed", error);
          dropListenerClient(client!);
          scheduleListenerRestart("error");
        }
      });
      emitter.on("end", () => {
        if (listenerClient === client) {
          listenerClient = null;
          console.warn("[realtime] PostgreSQL listener connection ended");
          dropListenerClient(client!);
          scheduleListenerRestart("end");
        }
      });
      console.info("[realtime] 通知监听已建立（含数域事件）");
    } catch (error) {
      // 连接成功但 LISTEN 失败的客户端必须归还（且是丢弃：连接状态已不确定），
      // 否则重试会逐步耗尽连接池。
      if (client) { dropListenerClient(client); client = null; }
      console.error("[realtime] 通知监听建立失败", error);
      listenerAttempts += 1;
      scheduleListenerRestart("connect-failed");
    } finally {
      listenerStarting = false;
    }
  };

  // 周期健康检查：查询会产生连接流量（对抗 NAT 空闲掐断），并能及时发现连接假死与 LISTEN 状态丢失
  const checkListenerHealth = async () => {
    const client = listenerClient;
    if (!client || listenerStopped) return;
    try {
      const { rows } = await client.query("SELECT pg_listening_channels() AS ch");
      const channels = (rows[0]?.ch as string[] | null) ?? [];
      for (const channelName of NOTIFY_CHANNELS) {
        if (!channels.includes(channelName)) await client.query(`LISTEN ${channelName}`);
      }
    } catch (error) {
      if (listenerClient === client) {
        listenerClient = null;
        console.error("[realtime] 监听健康检查失败", error);
        dropListenerClient(client);
        scheduleListenerRestart("health-check-failed");
      }
    }
  };

  await startNotificationListener();
  listenerHealthTimer = setInterval(() => { void checkListenerHealth(); }, 20_000);
  // LISTEN is a latency optimization. This poll also recovers missed notifications.
  const poll = setInterval(() => wake(), 15_000);
  const cleanup = async () => {
    try {
      await pool.query(`WITH victims AS (
        SELECT seq FROM realtime_events WHERE created_at < now() - interval '7 days' ORDER BY seq LIMIT 5000
      ), expired AS (
        DELETE FROM realtime_events e USING victims v WHERE e.seq=v.seq RETURNING e.session_id,e.seq
      ), marks AS (
        SELECT session_id,max(seq) AS through_seq FROM expired GROUP BY session_id
      ) INSERT INTO realtime_watermarks(session_id,through_seq)
        SELECT session_id,through_seq FROM marks
        ON CONFLICT(session_id) DO UPDATE SET through_seq=GREATEST(realtime_watermarks.through_seq,excluded.through_seq)`);
    } catch (error) { console.error("[realtime] cleanup failed", error); }
  };
  const cleanupTimer = setInterval(() => void cleanup(), 60 * 60_000);
  void cleanup();
  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive) { peer.ws.terminate(); continue; }
      peer.alive = false;
      peer.ws.ping();
    }
  }, 25_000);
  server.on("close", () => {
    clearInterval(poll); clearInterval(cleanupTimer); clearInterval(heartbeat); clearInterval(listenerHealthTimer);
    listenerStopped = true;
    if (listenerRetryTimer) { clearTimeout(listenerRetryTimer); listenerRetryTimer = null; }
    if (listenerClient) { (listenerClient as unknown as EventEmitter).removeAllListeners(); listenerClient.release(); listenerClient = null; }
    wss.close();
  });
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== `${basePath}/api/realtime`) return;
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(item => item.trim());
    const token = protocols.find(item => item.startsWith("ticket."))?.slice(7);
    const identity = token ? verifyRealtimeTicket(token) : null;
    if (!identity) { console.warn("[realtime] upgrade rejected: invalid ticket"); socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      const connectionId = ++nextConnectionId;
      console.info(`[realtime] connected id=${connectionId}`);
      const { provider, unionId } = parseSessionKey(identity);
      const sessionUser = { sub: identity, provider, unionId, openId: "", name: "", exp: Math.floor(Date.now() / 1000) + 3600 } as SessionUser;
      const cookie = `agent_session=${createSessionToken(sessionUser, loadAuthConfig().sessionSecret)}`;
      const peer: Peer = { ws, sub: identity, cookie, channels: new Map(), alive: true };
      peers.add(peer);
      ws.on("pong", () => { peer.alive = true; });
      ws.on("close", (code, reason) => { console.info(`[realtime] closed id=${connectionId} code=${code} reason=${String(reason)}`); peers.delete(peer); peer.channels.clear(); });
      const expiry = setTimeout(() => ws.close(1000, "reauthenticate"), 55 * 60_000);
      ws.on("close", () => clearTimeout(expiry));
      ws.on("message", raw => {
        let frame: Record<string, unknown> = {};
        void (async () => {
          try { frame = JSON.parse(raw.toString()) as Record<string, unknown>; }
          catch { send(peer, { op: "error", code: "bad_frame" }); return; }
          const channelId = typeof frame.channel === "string" ? frame.channel : "";
          if (frame.op === "subscribe") {
            if (!channelId || peer.channels.size >= MAX_CHANNELS && !peer.channels.has(channelId)) { send(peer, { op: "error", channel: channelId, code: "too_many_channels" }); return; }
            if (!await getAgentSession(peer.sub, channelId)) { send(peer, { op: "error", channel: channelId, code: "forbidden" }); return; }
            const after = Number(frame.after);
            let cursor = Number.isSafeInteger(after) && after > 0 ? after : 0;
            const watermark = cursor ? await pool.query<{ through_seq: string }>(
              "SELECT through_seq FROM realtime_watermarks WHERE session_id=$1", [channelId]) : null;
            const resync = !!watermark?.rows[0] && cursor <= Number(watermark.rows[0].through_seq);
            if (!cursor || resync) {
              const latest = await pool.query<{ seq: string }>("SELECT COALESCE(max(seq),0)::text AS seq FROM realtime_events WHERE session_id=$1", [channelId]);
              cursor = Math.max(Number(latest.rows[0]?.seq ?? 0), Number(watermark?.rows[0]?.through_seq ?? 0));
            }
            const state: Channel = { cursor, busy: false, pending: false, checkedAt: Date.now() };
            peer.channels.set(channelId, state);
            send(peer, { op: "subscribed", channel: channelId, cursor, resync });
            await drain(peer, channelId, state);
            return;
          }
          if (frame.op === "unsubscribe") { peer.channels.delete(channelId); return; }
          if (frame.op === "ping") { send(peer, { op: "pong" }); return; }
          if (frame.op === "request") {
            const requestId = typeof frame.requestId === "string" ? frame.requestId : "";
            const action = frame.action;
            console.info(`[realtime] request id=${connectionId} action=${String(action)} channel=${channelId}`);
            if (!requestId || !channelId || !["send", "reaction", "settings"].includes(String(action))) { send(peer, { op: "response", requestId, ok: false, error: "invalid_request" }); return; }
            if (!await getAgentSession(peer.sub, channelId)) { send(peer, { op: "response", requestId, ok: false, error: "forbidden" }); return; }
            const method = action === "settings" ? "PATCH" : "POST";
            const data = frame.data && typeof frame.data === "object" && !Array.isArray(frame.data) ? frame.data as Record<string, unknown> : {};
            if (action === "send" && !data.clientMessageId) data.clientMessageId = requestId;
            const request = new Request(`http://localhost${basePath}/api/cowork/${encodeURIComponent(channelId)}/${action}`, {
              method, headers: { cookie: peer.cookie, "content-type": "application/json" }, body: JSON.stringify(data),
            });
            try {
              const response = action === "send" ? await cowork.send(request, channelId)
                : action === "reaction" ? await cowork.reaction(request, channelId) : await cowork.settings(request, channelId);
              const result = await response.json().catch(() => ({}));
              console.info(`[realtime] response id=${connectionId} action=${String(action)} status=${response.status}`);
              send(peer, { op: "response", requestId, ok: response.ok, data: result, error: response.ok ? undefined : (result as { error?: string }).error });
            } catch (error) {
              console.error("[realtime] action failed", error);
              send(peer, { op: "response", requestId, ok: false, error: "server_error" });
            }
          }
        })().catch(error => {
          console.error("[realtime] request failed", error);
          if (frame.op === "request" && typeof frame.requestId === "string") send(peer, { op: "response", requestId: frame.requestId, ok: false, error: "server_error" });
          else send(peer, { op: "error", code: "internal" });
        });
      });
    });
  });
}
