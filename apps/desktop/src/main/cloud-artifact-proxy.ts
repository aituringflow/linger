import http from "node:http";
import { Readable } from "node:stream";

/**
 * 云端产物转发（本机 agent 的 /artifact-cloud）。
 *
 * 背景：群聊 / 人聊这类会话跑在 Web 服务上，产物由服务端写在**服务端的存储根**里，
 * 桌面壳本机 agent 的 artifactRoot 下永远没有这些文件。渲染层如果直连云端的
 * `/api/artifact`，`<img>` / `<iframe>` / `<a download>` 这些浏览器原生请求带不上
 * 跨站 Cookie（SameSite=Lax 不随子资源发送）→ 预览 403、下载拿不到文件。
 *
 * 所以由本机服务做一层同源转发：渲染层仍请求 127.0.0.1（带本机令牌），
 * 主进程用登录态 Cookie 去取云端内容，并**流式**透传整包
 * （预览的 watch 是 SSE 长连接，不能整包缓冲后再返回）。
 */
export interface CloudArtifactDeps {
  /** Web 服务根地址（如 http://127.0.0.1:3100/linger）；未登录返回 null */
  baseUrl: () => string | null;
  /** 该 Web 服务的登录态 Cookie 头（`agent_session=...`） */
  cookie: () => Promise<string>;
}

function writeJson(response: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(body);
}

/** 与内容相关的响应头白名单：编码 / 连接类头原样复制会破坏 Node 与 undici 各自的处理 */
const PASSTHROUGH_HEADERS = [
  "content-type", "content-length", "content-range", "accept-ranges",
  "content-disposition", "cache-control", "etag", "last-modified",
] as const;

export async function proxyCloudArtifact(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  cloud: CloudArtifactDeps | undefined,
): Promise<void> {
  if (!cloud) { writeJson(response, 404, { error: "宿主未启用云端产物转发" }); return; }
  const base = cloud.baseUrl();
  if (!base) { writeJson(response, 503, { error: "尚未登录 Web 服务，无法读取云端产物" }); return; }
  const query = new URLSearchParams(url.searchParams);
  query.delete("token"); // 本机服务的访问令牌对云端没有意义，不外传
  const headers: Record<string, string> = {};
  const cookie = await cloud.cookie().catch(() => "");
  if (cookie) headers.cookie = cookie;
  const range = request.headers.range;
  if (typeof range === "string" && range) headers.range = range;
  let upstream: Response;
  try {
    upstream = await fetch(`${base.replace(/\/+$/, "")}/api/artifact?${query.toString()}`, { headers, cache: "no-store" });
  } catch {
    writeJson(response, 502, { error: "云端产物服务不可用" });
    return;
  }
  const outHeaders: Record<string, string> = {};
  for (const key of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(key);
    if (value) outHeaders[key] = value;
  }
  response.writeHead(upstream.status, outHeaders);
  if (!upstream.body) { response.end(); return; }
  const body = Readable.fromWeb(upstream.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  response.socket?.setNoDelay(true);
  body.on("error", () => response.destroy());
  // 浏览器端取消（切会话 / 关闭预览）时把上游读流一起断掉，避免 watch 长连接悬挂
  response.on("close", () => body.destroy());
  body.pipe(response);
}
