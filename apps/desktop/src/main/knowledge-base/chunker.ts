/**
 * 章节感知分块器。
 *
 * 策略：
 * 1. 先按 Markdown 标题（# / ## / ###）和 PDF 页码（=== 第 N 页 ===）切分大节
 * 2. 每节内按段落边界（空行）切分
 * 3. 段落合并到目标大小（约 400 token ≈ 中文 600 字），超出则硬切
 * 4. 相邻块保留约 80 token（中文 120 字）的重叠
 * 5. 代码块（```...```）整体保留，不跨块拆分
 */

export interface Chunk {
  imagePath?: string;
  text: string;
  headingPath: string;
  tokenCount: number;
}

/** 片段的处理阶段（与 store.ts / shared/types.ts 中的定义一致） */
export type ChunkStage = "ocr" | "describing" | "described" | "fallback" | "ready";
export interface StagedChunk {
  imagePath?: string;
  text: string;
  headingPath: string;
  tokenCount: number;
  stage?: ChunkStage;
}

/** 一张图片拆出的「文字占位 + 图片本体」在片段数组中的下标 */
export interface ImagePair {
  textIndex: number;
  imageIndex: number;
  imagePath: string;
  ocr: string;
}

/**
 * 把解析结果转成待落库的片段：每张图片恰好 2 个片段。
 * - 文字片段：先放 OCR 原文（stage=ocr），大模型返回后原地替换成描述（described）
 * - 图片片段：保留 imagePath，走图片向量嵌入（stage=ready）
 * OCR 只是模型输入，不再单独产生第三个文本片段。
 */
export function buildImagePlaceholders(chunks: Chunk[]): { chunks: StagedChunk[]; pairs: ImagePair[] } {
  const result: StagedChunk[] = [];
  const pairs: ImagePair[] = [];
  for (const chunk of chunks) {
    if (!chunk.imagePath) {
      result.push({ text: chunk.text, headingPath: chunk.headingPath, tokenCount: chunk.tokenCount, stage: "ready" });
      continue;
    }
    const ocr = chunk.text.trim();
    const textIndex = result.length;
    result.push({ text: ocr, headingPath: "图片 OCR", tokenCount: estimateTokens(ocr), stage: "ocr" });
    const imageIndex = result.length;
    result.push({
      text: "图片原图",
      headingPath: chunk.headingPath || "图片",
      tokenCount: 0,
      imagePath: chunk.imagePath,
      stage: "ready",
    });
    pairs.push({ textIndex, imageIndex, imagePath: chunk.imagePath, ocr });
  }
  return { chunks: result, pairs };
}

export interface ParsedImage {
  data: Buffer;
  location: string;
  ocr: string;
}

const TARGET_CHARS = 600; // 目标块大小（中文约 600 字 ≈ 400 token）
const OVERLAP_CHARS = 120; // 重叠（中文约 120 字 ≈ 80 token）
const MIN_CHUNK_CHARS = 80; // 最小块大小，太小的合并到相邻块

/** 粗略 token 估算：中文 1.5 字/token，英文 4 字符/token */
export function estimateTokens(text: string): number {
  const chinese = (text.match(/[一-鿿]/g) || []).length;
  const other = text.length - chinese;
  return Math.round(chinese / 1.5 + other / 4);
}

/**
 * 把解析出来的图片数组转成独立的 image chunks。
 * 每个图片产生一个 chunk：text 是图片描述 + OCR 内容，imagePath 后续由 indexer 写入磁盘路径。
 */
export function imageChunks(images: ParsedImage[], headingPath = ""): Chunk[] {
  return images.map((img, i) => {
    const desc = img.ocr?.trim() || img.location || `图片 ${i + 1}`;
    return {
      text: `[图片] ${desc}`,
      headingPath,
      tokenCount: estimateTokens(desc),
      // imagePath 暂不设置，由 indexer 保存图片到磁盘后写入
    };
  });
}

interface Section {
  heading: string;
  headingPath: string;
  content: string;
}

export function chunkDocument(text: string): Chunk[] {
  const sections = splitByHeadings(text);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    const sectionChunks = splitSection(section.content, section.headingPath);
    chunks.push(...sectionChunks);
  }

  // 合并太小的块（和前一块合并）
  const merged: Chunk[] = [];
  for (const chunk of chunks) {
    if (merged.length > 0 && chunk.headingPath === merged[merged.length - 1].headingPath && chunk.text.length < MIN_CHUNK_CHARS) {
      const prev = merged[merged.length - 1];
      prev.text = prev.text + "\n\n" + chunk.text;
      prev.tokenCount = estimateTokens(prev.text);
    } else {
      merged.push({ ...chunk });
    }
  }

  return merged;
}

/** 按标题和页码切分大节 */
function splitByHeadings(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  const headingStack: string[] = [];
  let currentHeading = "";
  let currentContent: string[] = [];

  const flush = () => {
    if (currentContent.length > 0) {
      const headingPath = headingStack.filter(Boolean).join(" > ");
      sections.push({
        heading: currentHeading,
        headingPath,
        content: currentContent.join("\n").trim(),
      });
    }
    currentContent = [];
  };

  for (const line of lines) {
    // Markdown 标题
    const mdMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    // PDF 页码标记：=== 第 N 页 ===
    const pageMatch = /^=== 第 (\d+) 页(（OCR）)?\s*===$/.exec(line);
    const imageOcr = /^=== 图片 OCR ===$/.test(line);
    // Excel 工作表标题：## 工作表：名称
    const sheetMatch = /^## 工作表：(.+)$/.exec(line);

    if (mdMatch) {
      flush();
      const level = mdMatch[1].length;
      const title = mdMatch[2].trim();
      headingStack.length = Math.min(headingStack.length, level - 1);
      headingStack[level - 1] = title;
      currentHeading = title;
    } else if (pageMatch) {
      flush();
      const title = `第 ${pageMatch[1]} 页${pageMatch[2] ?? ""}`;
      headingStack.length = 0;
      headingStack[0] = title;
      currentHeading = title;
    } else if (imageOcr) {
      flush();
      headingStack.length = 0;
      headingStack[0] = "图片 OCR";
      currentHeading = "图片 OCR";
    } else if (sheetMatch) {
      flush();
      const title = `工作表：${sheetMatch[1]}`;
      headingStack.length = 0;
      headingStack[0] = title;
      currentHeading = title;
    } else {
      currentContent.push(line);
    }
  }
  flush();

  // 如果没有任何标题，整个文档算一个节
  if (sections.length === 0 && text.trim()) {
    sections.push({ heading: "", headingPath: "", content: text.trim() });
  }

  return sections.filter((s) => s.content.length > 0);
}

/** 把一个节切成多个目标大小的块 */
function splitSection(content: string, headingPath: string): Chunk[] {
  // 先按代码块拆分，代码块整体保留
  const segments = splitByCodeBlocks(content);
  const chunks: Chunk[] = [];
  let buffer = "";

  const flushBuffer = () => {
    if (!buffer.trim()) return;
    // buffer 可能还是很长，按段落再切
    const paraChunks = splitByParagraphs(buffer, headingPath);
    chunks.push(...paraChunks);
    buffer = "";
  };

  for (const seg of segments) {
    if (seg.isCode) {
      // 代码块先把 buffer 冲掉
      flushBuffer();
      // 代码块整体作为一个 chunk（如果太长就硬切，但保留 ``` 标记）
      if (seg.text.length <= TARGET_CHARS * 2) {
        chunks.push({
          text: seg.text,
          headingPath,
          tokenCount: estimateTokens(seg.text),
        });
      } else {
        // 超长代码块硬切
        const parts = hardSplit(seg.text);
        parts.forEach((p) =>
          chunks.push({ text: p, headingPath, tokenCount: estimateTokens(p) })
        );
      }
    } else {
      // 普通文本，累积到 buffer
      if (buffer.length + seg.text.length > TARGET_CHARS && buffer.length > MIN_CHUNK_CHARS) {
        flushBuffer();
      }
      buffer += (buffer ? "\n\n" : "") + seg.text;
    }
  }
  flushBuffer();

  // 给相邻块加重叠
  return addOverlap(chunks);
}

/** 按代码块（```）拆分文本 */
function splitByCodeBlocks(text: string): Array<{ text: string; isCode: boolean }> {
  const parts: Array<{ text: string; isCode: boolean }> = [];
  const regex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), isCode: false });
    }
    parts.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isCode: false });
  }
  return parts;
}

/** 按段落（空行分隔）切分并合并到目标大小 */
function splitByParagraphs(text: string, headingPath: string): Chunk[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: Chunk[] = [];
  let buffer = "";

  const pushBuffer = () => {
    if (!buffer.trim()) return;
    if (buffer.length <= TARGET_CHARS * 1.5) {
      chunks.push({ text: buffer.trim(), headingPath, tokenCount: estimateTokens(buffer) });
    } else {
      // buffer 还是太长，硬切
      const parts = hardSplit(buffer);
      parts.forEach((p) =>
        chunks.push({ text: p, headingPath, tokenCount: estimateTokens(p) })
      );
    }
    buffer = "";
  };

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 > TARGET_CHARS && buffer.length > 0) {
      pushBuffer();
    }
    buffer += (buffer ? "\n\n" : "") + para;
  }
  pushBuffer();

  return chunks;
}

/** 硬切：按句子边界切，尽量不在句中切断 */
function hardSplit(text: string): string[] {
  const result: string[] = [];
  let remaining = text;

  while (remaining.length > TARGET_CHARS) {
    // 在目标位置附近找句子结束符（。！？.!?\n）
    const windowStart = Math.floor(TARGET_CHARS * 0.7);
    const windowEnd = Math.ceil(TARGET_CHARS * 1.3);
    let cutPos = -1;
    for (let i = Math.min(windowEnd, remaining.length) - 1; i >= windowStart; i--) {
      if (/[。！？.!?\n]/.test(remaining[i])) {
        cutPos = i + 1;
        break;
      }
    }
    if (cutPos === -1) cutPos = TARGET_CHARS;
    result.push(remaining.slice(0, cutPos).trim());
    remaining = remaining.slice(cutPos).trim();
  }
  if (remaining) result.push(remaining);
  return result;
}

/** 给相邻块加重叠：后一块开头取前一块结尾的一小段 */
function addOverlap(chunks: Chunk[]): Chunk[] {
  if (chunks.length <= 1) return chunks;
  const result: Chunk[] = [chunks[0]];

  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1].text;
    const overlap = prev.slice(-OVERLAP_CHARS);
    const current = chunks[i];
    // 避免重复加已经包含的重叠
    if (!current.text.startsWith(overlap.slice(-50))) {
      result.push({
        ...current,
        text: overlap + (overlap.endsWith("\n") ? "" : "\n") + current.text,
        tokenCount: estimateTokens(overlap + current.text),
      });
    } else {
      result.push(current);
    }
  }
  return result;
}
