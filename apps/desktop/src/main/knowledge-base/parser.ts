import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createWorker } from "tesseract.js";
import type { Canvas } from "@napi-rs/canvas";
import { tiffToPng } from "./tiff.js";
import { APP_HOME_DIR } from "../app-name.js";

/**
 * 文档解析器：把各种格式的本地文件抽成纯文本。
 *
 * 支持：PDF(文本层) / Word(.docx) / Markdown / TXT / CSV / Excel(.xlsx) / PPT(.pptx)
 * 不支持：扫描件 OCR（P1）、老版二进制 .doc/.xls/.ppt
 */

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 256 * 1024 * 1024;

/**
 * 落盘图片副本的最长边。
 *
 * 原文件始终留在用户磁盘上（「打开原文件」看的就是它），这里只是给知识库用的副本：
 * 展示最大 480px、向量模型还会再缩放，存 6000px 的 PNG 纯属浪费。
 * 缩到 2048 后一张 12MP 照片从 ~20MB 降到 ~1.5MB，几万张照片是几十 GB 的差别。
 */
const IMAGE_MAX_SIDE = 2048;

export interface ParsedImage { data: Buffer; thumb: Buffer; ext: string; location: string; ocr: string }
export interface ParsedDocument {
  images?: ParsedImage[];
  text: string;
  title: string;
  type: string;
  truncated: boolean;
}

const EXT_MAP: Record<string, string> = {
  ".mp4": "video",
  ".mov": "video",
  ".m4v": "video",
  ".webm": "video",
  ".mkv": "video",
  ".avi": "video",
  ".pdf": "pdf",
  ".docx": "docx",
  ".md": "markdown",
  ".markdown": "markdown",
  ".txt": "text",
  ".csv": "csv",
  ".tsv": "csv",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".pptx": "pptx",
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".tif": "image",
  ".tiff": "image",
  ".bmp": "image",
};

export function getSupportedTypes(): string[] {
  return [...new Set(Object.values(EXT_MAP))];
}

export function isSupportedFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() in EXT_MAP;
}

export function getFileType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MAP[ext] ?? "unknown";
}

export async function parseFile(filePath: string): Promise<ParsedDocument> {
  const stat = await fsp.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const maxBytes = getFileType(filePath) === "image" ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  if (stat.size > maxBytes) {
    throw new Error(`文件超过 ${maxBytes / 1024 / 1024} MiB 上限（${(stat.size / 1024 / 1024).toFixed(1)} MiB），请拆分后再索引`);
  }
  const title = path.basename(filePath, ext);
  const buf = await fsp.readFile(filePath);

  switch (ext) {
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".webp":
    case ".tif":
    case ".tiff":
    case ".bmp": {
      // OCR 用原图（不降采样，小字更准）；落盘副本再压到 2048 存 JPEG/PNG。
      // TIFF 先转 PNG：tesseract 与 Skia 都不认 TIFF，直接喂会解析失败甚至崩进程。
      const source = ext === ".tif" || ext === ".tiff" ? tiffToPng(buf) : buf;
      const sourceExt = ext === ".tif" || ext === ".tiff" ? "png" : ext.replace(".", "");
      const ocrText = await ocrImage(source);
      const prepared = await prepareImage(source, sourceExt);
      return { text: "", images: [{ ...prepared, location: title, ocr: ocrText }], title, type: "image", truncated: false };
    }
    case ".pdf":
      return { ...(await parsePdf(buf)), title, type: "pdf" };
    case ".docx":
      return { ...(await parseDocx(buf)), title, type: "docx" };
    case ".md":
    case ".markdown":
      {
        const text = buf.toString("utf8");
        const images: ParsedImage[] = [];
        for (const match of text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
          const reference = match[1].trim().replace(/^<|>$/g, "");
          if (/^[a-z]+:/i.test(reference)) continue;
          const source = await fsp.readFile(path.resolve(path.dirname(filePath), reference));
          const prepared = await prepareImage(source, path.extname(reference).slice(1).toLowerCase());
          images.push({ ...prepared, location: reference, ocr: await ocrImage(source) });
        }
        // OCR 只作为图片描述模型的输入，不再拼进正文：否则同一段图片文字会被切成两个片段
        return { text, images, title, type: "markdown", truncated: false };
      }
    case ".txt":
      return { text: buf.toString("utf8"), title, type: "text", truncated: false };
    case ".csv":
    case ".tsv":
      return { text: buf.toString("utf8"), title, type: "csv", truncated: false };
    case ".xlsx":
    case ".xlsm":
      return { ...(await parseXlsx(buf)), title, type: "xlsx" };
    case ".pptx":
      return { ...(await parsePptx(buf)), title, type: "pptx" };
    default:
      throw new Error(`不支持的文件类型：${ext}`);
  }
}

// ─── OCR（扫描件）─────────────────────────────────────────

let ocrWorker: Awaited<ReturnType<typeof createWorker>> | null = null;
let ocrInitPromise: ReturnType<typeof createWorker> | null = null;

/** 懒加载 OCR worker（首次调用时初始化，下载中文语言包） */
async function getOcrWorker(): ReturnType<typeof createWorker> {
  if (ocrWorker) return ocrWorker;
  if (ocrInitPromise) return ocrInitPromise;

  ocrInitPromise = (async () => {
    // OCR 语言包由所有知识库共享，不能写入进程当前工作目录。
    const cachePath = process.env.LAUNCHER_KB_OCR_CACHE || path.join(APP_HOME_DIR, "knowledge", "ocr");
    await fsp.mkdir(cachePath, { recursive: true });
    const worker = await createWorker(["chi_sim", "eng"], undefined, { cachePath });
    ocrWorker = worker;
    return worker;
  })();

  return ocrInitPromise;
}

/** 对图片 buffer 做 OCR，返回提取的文字 */
async function ocrImage(buf: Buffer): Promise<string> {
  try {
    const worker = await getOcrWorker();
    const { data: { text } } = await worker.recognize(buf);
    return text.trim();
  } catch (e) {
    console.error("[kb] OCR 失败：", e);
    throw e;
  }
}

// ─── PDF ─────────────────────────────────────────────────

async function parsePdf(buf: Buffer): Promise<{ text: string; truncated: boolean; images: ParsedImage[] }> {
  const images: ParsedImage[] = [];
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]);
  Object.assign(globalThis, { pdfjsWorker: worker });
  const document = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, disableFontFace: true }).promise;

  const sections: string[] = [];
  let truncated = false;
  let sparsePages: number[] = [];
  let hasExtractedText = false;

  try {
    for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
      const page = await document.getPage(pageNo);
      const operations = await page.getOperatorList();
      for (let op = 0; op < operations.fnArray.length; op++) {
        const fn = operations.fnArray[op];
        if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintInlineImageXObject) continue;
        const args = operations.argsArray[op];
        const source: any = fn === pdfjs.OPS.paintInlineImageXObject ? args[0] : await resolvePdfImage(page, args[0]);
        if (!source) { truncated = true; continue; }
        const { createCanvas, ImageData } = await import("@napi-rs/canvas");
        const canvas = createCanvas(source.width, source.height);
        const context = canvas.getContext("2d");
        if (source.bitmap) context.drawImage(source.bitmap, 0, 0);
        else if (source.data) {
          const rgba = new Uint8ClampedArray(source.width * source.height * 4);
          for (let pixel = 0; pixel < source.width * source.height; pixel++) {
            if (source.kind === 3) rgba.set(source.data.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
            else if (source.kind === 2) { rgba.set(source.data.subarray(pixel * 3, pixel * 3 + 3), pixel * 4); rgba[pixel * 4 + 3] = 255; }
            else { const value = (source.data[Math.floor(pixel / source.width) * Math.ceil(source.width / 8) + Math.floor(pixel % source.width / 8)] >> (7 - pixel % source.width % 8)) & 1 ? 255 : 0; rgba.set([value, value, value, 255], pixel * 4); }
          }
          context.putImageData(new ImageData(rgba, source.width, source.height), 0, 0);
        } else throw new Error(`第 ${pageNo} 页图片无法解码`);
        const prepared = await encodeCanvasImage(canvas);
        const ocr = await ocrImage(prepared.data);
        // 图片 OCR 交给 indexer 走「OCR → 大模型描述」，不再写入 PDF 文本层
        images.push({ ...prepared, location: `第 ${pageNo} 页 · 图片 ${images.length + 1}`, ocr });
      }
      const content = await page.getTextContent();
      const body = content.items.map((item: any) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").replace(/\u0000/g, "").trim();
      if (body.length < 80) sparsePages.push(pageNo);
      if (body) hasExtractedText = true;
      const section = `=== 第 ${pageNo} 页 ===\n${body}`;
      sections.push(section);
    }

    // OCR every sparse page, including scanned pages in mixed PDFs.
    const totalPages = document.numPages;
    if (sparsePages.length > 0) {
      console.log(`[kb] 检测到扫描件 PDF（${sparsePages.length}/${totalPages} 页无文本），开始 OCR…`);
      const ocrSections: string[] = [];
      const ocrPages = sparsePages;

      // 动态加载 canvas（避免非扫描件也加载这个大依赖）
      const canvasMod = await import("@napi-rs/canvas");

      for (const pageNo of ocrPages) {
        try {
          const page = await document.getPage(pageNo);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = canvasMod.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          await page.render({
            canvasContext: canvas.getContext("2d") as any,
            viewport,
          }).promise;
          const imgBuf = canvas.toBuffer("image/png");
          const ocrText = await ocrImage(imgBuf);
          if (ocrText) ocrSections.push(`=== 第 ${pageNo} 页（OCR）===\n${ocrText}`);
        } catch (e) {
          console.error(`[kb] OCR 第 ${pageNo} 页失败：`, e);
          throw new Error(`第 ${pageNo} 页 OCR 失败：${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 把 OCR 结果合并进去（替换原来的"没有可提取文字"）
      if (ocrSections.length > 0) {
        return { text: sections.join("\n\n") + "\n\n" + ocrSections.join("\n\n"), images, truncated };
      }
      if (!hasExtractedText) throw new Error("无法从 PDF 提取文字，OCR 未识别到内容或处理失败");
    }

    return { text: sections.join("\n\n"), images, truncated };
  } finally {
    await document.destroy();
  }
}

/**
 * 取 PDF 页面里的图片对象。
 *
 * pdf.js 的图片不一定在 `page.objs` 里已解析：少数 PDF 的图片位于 Form Group 内
 * （对象 id 形如 `g_d0_img_*`），`has()` 为 false 且 `get(id, cb)` 的回调永远不会触发。
 * 原实现无条件 await 这个回调，遇到这种文件会永久卡住整条索引队列。
 * 这里只等 2 秒，等不到就跳过这张图（文字和其它图仍会正常索引）。
 */
async function resolvePdfImage(page: any, id: unknown): Promise<any | null> {
  try {
    if (page.objs.has(id)) return page.objs.get(id);
    if (page.commonObjs?.has?.(id)) return page.commonObjs.get(id);
  } catch { /* 落到下面的等待分支 */ }
  return await Promise.race([
    new Promise((resolve) => { try { page.objs.get(id, resolve); } catch { resolve(null); } }),
    new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
  ]);
}

// ─── Word (.docx) ─────────────────────────────────────────

async function parseDocx(buf: Buffer): Promise<{ text: string; truncated: boolean; images: ParsedImage[] }> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: buf });
  // mammoth 的 messages 里可能有警告（比如图片无法解析），忽略
  const images = await extractOfficeImages(buf, "word/media/");
  return { text: result.value, images, truncated: false };
}

// ─── Excel (.xlsx) ───────────────────────────────────────

async function parseXlsx(buf: Buffer): Promise<{ text: string; truncated: boolean }> {
  const mod = await import("xlsx");
  const XLSX = ((mod as any).default ?? mod) as typeof import("xlsx");
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });

  const MAX_SHEETS = 30;
  const MAX_ROWS = 500;
  const MAX_COLS = 60;
  const sheetNames = wb.SheetNames.slice(0, MAX_SHEETS);
  let truncated = wb.SheetNames.length > sheetNames.length;
  const parts: string[] = [];

  for (const name of sheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: false }) as unknown[][];
    const shown = rows.slice(0, MAX_ROWS);
    if (shown.some(row => Array.isArray(row) && row.length > MAX_COLS)) truncated = true;
    if (rows.length > shown.length) truncated = true;
    const lines = shown
      .map((row) =>
        (Array.isArray(row) ? row.slice(0, MAX_COLS) : [])
          .map((v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim()))
          .join("\t")
      )
      .filter((line) => line.trim());
    parts.push(`## 工作表：${name}\n${lines.join("\n")}`);
  }

  return { text: parts.join("\n\n"), truncated };
}

// ─── PowerPoint (.pptx) ──────────────────────────────────

async function parsePptx(buf: Buffer): Promise<{ text: string; truncated: boolean; images: ParsedImage[] }> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buf);

  const slideEntries = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNum(a) - slideNum(b));
  const slides = slideEntries;
  const truncated = false;
  const parts: string[] = [];

  for (const entry of slides) {
    const file = zip.file(entry);
    if (!file) continue;
    const xml = await file.async("string");
    const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((m) => m[1])
      .map((block) => {
        const text = [...block.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
          .map((m) => m[1])
          .join("")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim();
        const level = Number(/<a:pPr[^>]*\slvl="(\d+)"/.exec(block)?.[1] ?? 0) || 0;
        return { level, text };
      })
      .filter((p) => p.text);

    const slideNo = slideNum(entry);
    const title = paragraphs[0]?.text ?? "";
    const body = paragraphs.filter((_, i) => !(i === 0 && title));
    const lines = body.map((p) => `${"  ".repeat(Math.min(p.level, 4))}- ${p.text}`);
    parts.push(`## 第 ${slideNo} 页${title ? `：${title}` : ""}\n${lines.join("\n") || "（本页没有文字）"}`);
  }

  const images = await extractOfficeImages(buf, "ppt/media/");
  return { text: parts.join("\n\n"), images, truncated };
}

function slideNum(entry: string): number {
  return Number(/slide(\d+)\.xml$/.exec(entry)?.[1] ?? 0) || 0;
}

/** OCR 用的图片编码：加载一次画布，同时产出落盘副本和缩略图，避免重复解码。 */
async function prepareImage(input: Buffer, sourceExt: string): Promise<{ data: Buffer; thumb: Buffer; ext: string }> {
  const { decodeToCanvas, fitCanvas, thumbnailFromCanvas } = await import("./image-thumb.js");
  const canvas = fitCanvas(await decodeToCanvas(input), IMAGE_MAX_SIDE);
  // JPEG 原图继续用 JPEG（照片体积远小于 PNG）；其它格式保持 PNG，避免丢透明通道
  const ext = sourceExt === "jpg" || sourceExt === "jpeg" ? "jpg" : "png";
  return {
    data: ext === "jpg" ? canvas.toBuffer("image/jpeg", 88) : canvas.toBuffer("image/png"),
    thumb: thumbnailFromCanvas(canvas),
    ext,
  };
}

/** PDF / Office 内嵌图片已经是画布（原始像素），直接缩放编码。 */
async function encodeCanvasImage(canvas: Canvas): Promise<{ data: Buffer; thumb: Buffer; ext: string }> {
  const { fitCanvas, thumbnailFromCanvas } = await import("./image-thumb.js");
  const fitted = fitCanvas(canvas, IMAGE_MAX_SIDE);
  return { data: fitted.toBuffer("image/png"), thumb: thumbnailFromCanvas(fitted), ext: "png" };
}

async function extractOfficeImages(buffer: Buffer, prefix: string): Promise<ParsedImage[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const images: ParsedImage[] = [];
  for (const entry of Object.values(zip.files).filter(f => f.name.startsWith(prefix) && /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(f.name))) {
    const prepared = await prepareImage(await entry.async("nodebuffer"), path.extname(entry.name).slice(1).toLowerCase());
    images.push({ ...prepared, location: entry.name, ocr: await ocrImage(prepared.data) });
  }
  return images;
}
