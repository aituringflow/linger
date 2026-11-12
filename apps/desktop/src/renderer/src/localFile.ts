/**
 * 把本机绝对路径转成 `local-file://` 协议 URL，交给主进程协议处理器读取。
 *
 * 主进程用 `new URL(request.url).pathname` 取回路径，因此文件部分必须落在
 * pathname 里。macOS 路径以 `/` 开头天然没问题；但 Windows 的盘符路径
 * （如 `C:\Users\a.png`）若直接拼成 `local-file://C:\...`，`C:` 会被 URL
 * 解析当成 host，pathname 变成空，导致图片/文件读不到。这里统一把反斜杠
 * 换成斜杠并补一个前导 `/`，得到 `local-file:///C:/Users/a.png`，
 * 主进程 pathname 即可正确拿到 `/C:/Users/a.png`（Node 在 Windows 上认这种形式）。
 */
export function localFileUrl(absPath: string, query = ""): string {
  const normalized = absPath.replace(/\\/g, "/");
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `local-file://${encodeURI(withLeadingSlash).replace(/[?#]/g, char => char === "?" ? "%3F" : "%23")}${query}`;
}
