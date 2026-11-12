/**
 * Web 终端 WebSocket 网关：/linger/api/terminal。
 * 与 realtime.ts 同构——subprotocol 传 `ticket.<token>`（/api/realtime-ticket 签发），
 * 会话权限用 getAgentSession 校验（terminal-session 内完成，失败 close(1008)）。
 *
 * 宿主接入：与 installRealtimeGateway 一样在 HTTP server 上调用一次即可。
 */
import { WebSocketServer } from "ws";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { verifyRealtimeTicket } from "./realtime-ticket.js";
import { attachTerminal, startTerminalSweeper } from "./terminal-session.js";

export function installTerminalGateway(server: HttpServer): void {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    handleProtocols: protocols => (protocols.has("agent-realtime") ? "agent-realtime" : false),
  });
  const basePath = (process.env.AUTH_COOKIE_PATH || "/linger").replace(/\/+$/, "");
  const stopSweeper = startTerminalSweeper();
  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== `${basePath}/api/terminal`) return;
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(item => item.trim());
    const token = protocols.find(item => item.startsWith("ticket."))?.slice(7);
    const identity = token ? verifyRealtimeTicket(token) : null;
    if (!identity) {
      console.warn("[terminal] upgrade rejected: invalid ticket");
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("session") ?? "";
    const host = url.searchParams.get("host") ?? "";
    wss.handleUpgrade(request, socket, head, ws => {
      void attachTerminal(sessionId, identity, host, ws).catch(error => {
        console.error("[terminal] attach failed", error);
        // 把失败原因带进 close reason：否则前端只能看到「一直重连」，无从判断是
        // 容器没起来、还是数据库连接池取不到连接（曾出现：连接池被 LISTEN 泄漏打满
        // → 每次 attach 都等满 20s 超时，前端表现为无限重连）。
        // close reason 上限 123 字节，这里只保留 ASCII 并截断。
        const detail = String((error as Error)?.message ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 100);
        const reason = detail ? `attach_failed: ${detail}` : "attach_failed";
        if (ws.readyState === ws.OPEN) ws.close(1011, reason);
        else ws.terminate();
      });
    });
  });
  server.on("close", () => { stopSweeper(); wss.close(); });
}
