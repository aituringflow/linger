import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import next from "next";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dev = !process.argv.includes("--production");
process.env.NODE_ENV = dev ? "development" : "production";

// 站点只做产品介绍与 launcher 后台，但 launcher 的 IM（群 AI、AI 伴聊、语音、终端）
// 的实时通道仍由这里承载：WebSocket 网关必须和 HTTP 侧 basePath 对齐，否则桌面端
// 连上来会被静默丢弃，表现为一直重连。
const basePath = (process.env.AUTH_COOKIE_PATH || "/linger").replace(/\/+$/, "");

// This custom Node server runs outside Next's module resolver. It loads the same
// agent-kit source entry as Next's aliases (dev and production alike), so the
// WebSocket gateways always use the SDK source. `tsx` is registered by
// the dev/start npm scripts to make the TypeScript entry loadable.
const kitEntry = pathToFileURL(
  path.join(dir, "../../packages/agent-kit/src/server/index.ts"),
).href;
const { installRealtimeGateway, installTerminalGateway, withPreviewHeaderStrip } = await import(kitEntry);
console.log("[web] agent-kit: source (packages/agent-kit/src)");
const port = Number(process.env.PORT || 3100);
const app = next({ dev, dir, hostname: "0.0.0.0", port });
await app.prepare();
const handler = app.getRequestHandler();
const https = process.argv.includes("--https");
let server;
const routeNextUpgrades = (before) => {
  for (const added of server.listeners("upgrade")) {
    if (before.has(added)) continue;
    server.removeListener("upgrade", added);
    server.on("upgrade", (upgradeRequest, socket, head) => {
      // kit 自有的 WebSocket（realtime / terminal）挂在 `<basePath>/api/` 下，由 kit 网关接管；
      // Next 的 HMR handler 不要再处理，否则会和对端 socket 抢同一份 upgrade，握手被搅坏。
      const upgradePath = new URL(upgradeRequest.url ?? "/", "http://localhost").pathname;
      if (upgradePath.startsWith(`${basePath}/api/`)) {
        // 交给 kit 网关；这里不转发给 Next，也不销毁 socket（由网关决定 401 或握手）。
        return;
      }
      void added(upgradeRequest, socket, head);
    });
  }
};
// kit 提供的预览跨站修复：内嵌 WebView 打开预览时，CSS/JS 请求携带
// Sec-Fetch-Mode:no-cors + Sec-Fetch-Site:cross-site（无 Origin/Referer），
// 会触发 Next dev 15.5+ 默认跨站保护（403，样式全失）；在进入 Next 前
// 剥离这些浏览器上下文头即可放行。
const listener = withPreviewHeaderStrip((request, response) => {
  const before = new Set(server.listeners("upgrade"));
  void Promise.resolve(handler(request, response)).then(
    () => routeNextUpgrades(before),
    error => { routeNextUpgrades(before); console.error("[web] request failed", error); },
  );
});
server = https
  ? createHttpsServer({ key: readFileSync(path.join(dir, "../../.cert/lan-key.pem")), cert: readFileSync(path.join(dir, "../../.cert/lan.pem")) }, listener)
  : createHttpServer(listener);
// OTA installers can take longer than Node's default 5-minute request timeout on slow connections.
server.requestTimeout = 60 * 60 * 1000;
await installRealtimeGateway(server);
await installTerminalGateway(server);
server.listen(port, "0.0.0.0", () => console.log(`[web] ${https ? "https" : "http"}://0.0.0.0:${port}`));
