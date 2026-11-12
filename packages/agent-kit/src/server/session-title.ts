/** Reject upstream error text accidentally returned as a generated conversation title. */
export function isInvalidAutoTitle(value: string): boolean {
  const title = value.trim();
  return !title || /^(?:[45]\d\d)(?:\s|:|\b)/.test(title) ||
    /(?:this model is unavailable|model.*not found|model.*unavailable|rate limit|unauthorized|forbidden|internal server error|bad gateway|service unavailable)/i.test(title);
}

export function quickSessionTitle(text: string): string {
  const original = text.trim();
  if (!original) return "";
  const cleaned = original
    .replace(/^\[附件\]\s*/, "")
    .replace(/^(帮我|请|麻烦|你好|嗨|hi|哈喽|hello)[，。!！？?\s、,]*/i, "");
  const base = (cleaned || original).replace(/[。！!？\s，,、;；]+$/g, "").trim();
  return base.length > 12 ? `${base.slice(0, 12)}…` : base;
}
