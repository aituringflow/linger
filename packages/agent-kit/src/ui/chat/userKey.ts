/**
 * 用户键（UI 版）
 *
 * 与 `server/user-key.ts` 的 `encodeUserKey` **完全同口径**：`base64url("<provider>:<unionId>")`
 * （去掉 padding，`+`→`-`、`/`→`_`）。两端必须一致，否则渲染层算出的目录名和服务端/历史数据对不上。
 *
 * 为什么不在 UI 里直接复用服务端那份：`server/` 依赖 node:crypto / Buffer，不能进浏览器包。
 * 改动任一侧时务必同步另一侧（值一旦变了，老目录就读不到了）。
 */

/** provider/unionId 任一缺失 → 返回空串，表示"没有可用用户"，调用方应视为不可用（不要兜底成全局）。 */
export function encodeUserKey(provider?: string | null, unionId?: string | null): string {
  if (!provider || !unionId) return "";
  const bytes = new TextEncoder().encode(`${provider}:${unionId}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
