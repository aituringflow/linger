// 统一 API 请求：始终携带登录 cookie（credentials: "include"）。
// 同源时与默认行为一致；Electron 桌面端 renderer 与引擎跨源（127.0.0.1 不同端口，same-site），
// 不带 credentials 时 cookie 不随跨源请求发送，导致每次启动都重新登录。
//
// 顺带向全局连接状态上报网络层成败（见 connectionStatus.ts）：
// 请求成功送达（含 4xx/5xx）→ 服务器可达；fetch 网络层失败（Failed to fetch）→ 标记离线。
// 仅做旁路上报，不吞错误、不改返回值，原 Promise 链完全不受影响。
import { markConnectionResult } from "./connectionStatus.ts";

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const cloud = globalThis as typeof globalThis & { __agentKitCloudBase?: string; launcher?: { webChatApi(method: string, path: string, body?: string): Promise<{ status: number; contentType: string; body: string }> } };
  const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const cloudBase = cloud.__agentKitCloudBase;
  const cloudPath = cloudBase && target.startsWith(`${cloudBase}/api/`) ? target.slice(cloudBase.length) : null;
  const request = cloudPath && cloud.launcher?.webChatApi && !init?.signal?.aborted
    ? cloud.launcher.webChatApi(init?.method || "GET", cloudPath, typeof init?.body === "string" ? init.body : undefined)
        .then(result => new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: { "content-type": result.contentType } }))
    : globalThis.fetch(input, { ...init, credentials: "include" });
  request.then(
    () => markConnectionResult(true),
    () => markConnectionResult(false),
  );
  return request;
}
