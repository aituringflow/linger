import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * ── 预览资源跨站保护修复（custom server 接入点）─────────────────────────
 *
 * 背景：Next.js 15.5+ 的 dev server 对 /_next 静态资源默认启用跨站保护
 * （blockCrossSiteDEV，无关闭开关）。内嵌 WebView（豆包客户端等）加载
 * 预览页面时，CSS/JS 请求携带 Sec-Fetch-Mode:no-cors + Sec-Fetch-Site:cross-site
 * （跨站 no-cors 请求通常不带 Origin/Referer）→ 命中保护 → 403 →
 * 预览页面有 HTML 但样式/交互资源全部加载失败，表现为「样式不对」。
 *
 * 这些头只描述浏览器请求上下文，对预览渲染无意义。在请求进入 Next
 * （route handler / dev router）之前把它们剥离，Next 对无源请求一律放行。
 * 容器侧不受影响：kit 的预览代理（cowork preview handler）转发时本就只带
 * 白名单头，浏览器上下文头不会到达容器。
 *
 * 用法（应用层 custom server，必须在调用 Next handler 之前包装）：
 * ```js
 * import { withPreviewHeaderStrip } from "@turingflow/agent-kit";
 * const handler = app.getRequestHandler();
 * const server = createServer(withPreviewHeaderStrip((req, res) => {
 *   void Promise.resolve(handler(req, res));
 * }));
 * ```
 *
 * 幂等：重复包装安全。非预览路径请求原样透传。
 * 若应用层 basePath 不是 /agent（默认前缀之外），传入 prefixes 覆盖：
 * ```js
 * withPreviewHeaderStrip(listener, { prefixes: ["/my-preview/"] })
 * ```
 */
export interface PreviewHeaderStripOptions {
  /** 预览公开挂载路径前缀（含 basePath），默认覆盖 /linger/preview/ 与 /preview/ */
  prefixes?: string[];
}

const DEFAULT_PREVIEW_PREFIXES = ["/linger/preview/", "/preview/"];

export function withPreviewHeaderStrip(
  listener: (request: IncomingMessage, response: ServerResponse) => void,
  options?: PreviewHeaderStripOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const prefixes = options?.prefixes?.length ? options.prefixes : DEFAULT_PREVIEW_PREFIXES;
  return (request, response) => {
    const url = request.url ?? "";
    if (prefixes.some((prefix) => url.startsWith(prefix))) {
      // 剥离浏览器上下文头：Sec-Fetch-* 关闭 no-cors+cross-site 拦截分支，
      // Origin/Referer 关闭源校验分支（WorkBuddy 等 WebView 可能携带 app:// 等
      // 非白名单源）。无源请求 Next dev 默认放行。
      delete request.headers["sec-fetch-mode"];
      delete request.headers["sec-fetch-site"];
      delete request.headers["origin"];
      delete request.headers["referer"];
    }
    return listener(request, response);
  };
}
