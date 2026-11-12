/** Resolve stored root-relative attachment URLs under the host app's base path. */
export function resolveAttachmentUrl(url: string | undefined | null, basePath: string, fileId?: string): string {
  if (!url) return "";
  if (/^(?:https?:|data:|blob:)/i.test(url)) return url;
  if (!url.startsWith("/")) return url;

  const base = basePath.replace(/\/+$/, "");
  if (fileId && /^\/api\/upload(?:\?|$)/.test(url)) {
    return `${base}/api/file?fileId=${encodeURIComponent(fileId)}`;
  }
  if (!base || url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`)) return url;
  return `${base}${url}`;
}
