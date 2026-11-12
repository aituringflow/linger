import type { Memory } from "./memory.js";

export type ResolvedMemoryFile = { memoryId: string; fileId: string; name: string; mime: string | null };

/** 只处理明确索取已保存文件、且能唯一指向文件类型或名称的短请求。 */
export function resolveMemoryFileRequest(text: string, memories: Memory[], includeContentRequests = false): ResolvedMemoryFile[] {
  if (!/(?:发|给|取|找|拿|下载|展示|打开|看看|看下|提供|发送|show|send|download)/i.test(text)) return [];
  if (!includeContentRequests && /(?:总结|分析|解释|提取|修改|翻译|正文|文字内容|写|概括|内容是什么)/i.test(text)) return [];

  const target = text.toLowerCase()
    .replace(/请|麻烦|帮我|把|将|我的|我|之前|曾经|已经|保存的|记住的|存的|文件|附件|给我|发给我|发我|发过来|发送|发|给|取出来|拿出来|取|找|下载|展示|打开|看看|看下|一下|那个|那份|提供|正文|文字内容|内容|全文/gi, "")
    .trim();
  const terms = target.split(/和|与|及|、|,|，|\s+/).map((term) => term.trim()).filter((term) => term.length >= 2);
  if (!terms.length) return [];

  const candidates = memories.flatMap((memory) => memory.files.map((file) => ({
    memoryId: memory.id, fileId: file.id, name: file.name, mime: file.mime,
    context: memory.content.toLowerCase(),
  })));
  const selected: ResolvedMemoryFile[] = [];
  for (const term of terms) {
    const mediaHint = /^(?:头像|照片|图片|图像|相片|photo|image|picture)$/.test(term) ? "image/"
      : /^(?:pdf)$/.test(term) ? "application/pdf" : "";
    const scores = candidates.map((file) => {
      const name = file.name.toLowerCase();
      const stem = name.replace(/\.[^.]+$/, "");
      const nameMatch = stem.includes(term) || name.includes(term);
      const contextMatch = file.context.includes(term);
      const mediaMatch = Boolean(mediaHint && file.mime?.startsWith(mediaHint));
      return { file, score: (nameMatch ? 100 : 0) + (contextMatch ? 10 : 0) + (mediaMatch ? 30 : 0) };
    }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score);
    if (!scores.length) return [];
    const best = scores[0];
    if (scores[1]?.score === best.score && scores[1].file.name !== best.file.name) return [];
    if (!selected.some((file) => file.fileId === best.file.fileId)) selected.push(best.file);
  }
  return selected;
}
