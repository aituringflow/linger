import path from "node:path";
import { readMemoryFile } from "./memory.js";
import { extractPdfText } from "./pdf-text.js";

/** MIME 判定兜底：部分浏览器上传 xlsx/pptx 时给的是 octet-stream，这里补一道 */
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX_EXTS = new Set([".xlsx", ".xlsm"]);
const PPTX_EXTS = new Set([".pptx", ".pptm", ".ppsx"]);

/** 从已保存的快照读正文，不依赖来源会话目录或原始上传文件。 */
export async function extractDocumentText(bytes: Buffer, name: string, mime?: string | null): Promise<{ text: string; truncated: boolean }> {
  const extension = path.extname(name).toLowerCase();
  let text = "";
  let extractionTruncated = false;
  if (mime === "application/pdf" || extension === ".pdf") {
    const pdf = await extractPdfText(bytes, { maxPages: 50, maxCharacters: 40_000 });
    if (!pdf.characters) throw new Error("文件中没有可提取的文字正文");
    text = pdf.text;
    extractionTruncated = pdf.truncated;
  } else if (extension === ".docx") {
    const mammoth = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer: bytes })).value;
  } else if (XLSX_EXTS.has(extension) || mime === XLSX_MIME) {
    // Excel：每张工作表一段，单元格按行制表符连接（见 office-text.ts 输出约定）
    const { extractXlsxText } = await import("./office-text.js");
    const sheet = await extractXlsxText(bytes);
    if (!sheet.text.trim()) throw new Error("表格中没有可提取的内容");
    text = sheet.text;
    extractionTruncated = sheet.truncated;
  } else if (PPTX_EXTS.has(extension) || mime === PPTX_MIME) {
    // PPT：按页/标题/层级要点展开，备注附在该页末尾
    const { extractPptxText } = await import("./office-text.js");
    const deck = await extractPptxText(bytes);
    if (!deck.text.trim()) throw new Error("幻灯片中没有可提取的文字正文");
    text = deck.text;
    extractionTruncated = deck.truncated;
  } else if (/^(?:text\/|application\/(?:json|xml))/.test(mime ?? "") || [".txt", ".md", ".csv", ".json", ".xml"].includes(extension)) {
    text = bytes.toString("utf8");
  } else {
    throw new Error("该文件类型没有可提取的文字正文");
  }
  const cleaned = text.trim();
  if (!cleaned) throw new Error("文件中没有可提取的文字正文");
  const max = 40_000;
  return { text: cleaned.slice(0, max), truncated: extractionTruncated || cleaned.length > max };
}

export async function readMemoryFileText(owner: string, memoryId: string, fileId: string): Promise<{ text: string; truncated: boolean }> {
  const file = await readMemoryFile(owner, memoryId, fileId);
  if (!file) throw new Error("记忆文件不存在或无权访问");
  return extractDocumentText(file.bytes, file.name, file.mime);
}
