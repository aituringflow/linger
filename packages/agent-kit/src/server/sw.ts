/**
 * agent-kit 自带的 Service Worker 脚本。
 *
 * 设计要点：
 *   - 不写死任何 basePath：所有路径都从 `self.registration.scope` 推导，
 *     因此同一份脚本在 basePath 为 /agent、/si、/ 等任意部署下都能正确工作。
 *   - 由 `createAgentKitApi` 的 `/api/sw` 端点以 application/javascript + 正确的
 *     `Service-Worker-Allowed` 头返回，宿主无需再在 public/ 里塞一份 sw.js，
 *     从而彻底消除「Failed to register a ServiceWorker … 404」。
 *
 * 该字符串会被当作 SW 文件整体返回，注意保持合法 JS（不要用模板插值破坏语法）。
 */
export const SERVICE_WORKER_SOURCE = `const scopePath = new URL(self.registration.scope).pathname;
const root = self.registration.scope;

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    if (!event.data) return;
    let data;
    try { data = event.data.json(); } catch { return; }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const targetUrl = typeof data.url === "string" && new URL(data.url, self.location.origin).pathname.startsWith(scopePath) ? data.url : root;
    const targetSession = new URL(targetUrl, self.location.origin).searchParams.get("session");
    if (targetSession && windows.some(client => client.focused && client.visibilityState === "visible" && new URL(client.url).searchParams.get("session") === targetSession)) return;
    const active = await Promise.race([
      Promise.any(windows.map(windowClient => new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = message => message.data === "active" ? resolve(true) : reject(new Error("inactive"));
        windowClient.postMessage({ type: "agent-push-probe" }, [channel.port2]);
      }))).catch(() => false),
      new Promise(resolve => setTimeout(() => resolve(false), 700)),
    ]);
    if (active) return;
    const url = targetUrl;
    let sound = "off";
    try {
      const cache = await caches.open("agent-notification-prefs");
      const saved = await cache.match(new URL("notification-sound-pref", self.registration.scope));
      if (saved) sound = await saved.text();
    } catch { }
    const tag = String(data.tag || "agent-im");
    await self.registration.showNotification(String(data.title || "新消息"), {
      body: String(data.body || "收到一条新消息"), tag, silent: sound !== "system", data: { kind: data.kind || "new-message", url },
    });
    if (["bright", "calm", "playful"].includes(sound)) {
      const client = windows.find(item => item.visibilityState === "visible") || windows[0];
      client && client.postMessage({ type: "agent-notification-sound", tag });
    }
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data && event.notification.data.url ? event.notification.data.url : root, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const windowClient of windows) {
      if (new URL(windowClient.url).pathname.startsWith(scopePath)) {
        await windowClient.navigate(url);
        return windowClient.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
`;

/**
 * 返回自带 Service Worker 脚本。
 *
 * 脚本落在 `${basePath}/api/sw`，但其注册 scope 是 `${basePath}/`（更浅）。
 * 脚本自身路径 `/api/sw` 自然 scope 为 `/api/`，必须以 `Service-Worker-Allowed`
 * 显式放开到 basePath 才能让 scope 提升到 `${basePath}/`，覆盖整个应用。
 *
 * @param basePath 应用部署子路径（默认 "/linger"），取 auth 配置的 cookiePath
 */
export function serveServiceWorker(basePath: string): Response {
  const allowed = basePath && basePath !== "/" ? basePath : "/";
  return new Response(SERVICE_WORKER_SOURCE, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Service-Worker-Allowed": allowed,
      "Cache-Control": "no-store",
    },
  });
}
