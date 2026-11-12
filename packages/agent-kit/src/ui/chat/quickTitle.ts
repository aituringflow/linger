/** Immediate placeholder while the model summarizes the first user message. */
export function quickSessionTitle(text: string): string {
  const original = text.trim();
  if (!original) return "";
  const cleaned = original
    .replace(/^\[附件\]\s*/, "")
    .replace(/^(帮我|请|麻烦|你好|嗨|hi|哈喽|hello)[，。!！？?\s、,]*/i, "");
  const base = (cleaned || original).replace(/[。！!？\s，,、;；]+$/g, "").trim();
  return base.length > 12 ? `${base.slice(0, 12)}…` : base;
}
