/**
 * agent-kit · Office 正文提取（Excel .xlsx / PowerPoint .pptx）
 *
 * 定位：把 Office 文件变成「模型能读的纯文本」，与 pdf-text.ts 同一层（不涉及预览渲染）。
 * 预览由前端各自解析（Word → mammoth、Excel → SheetJS、PPT → 本表单的 zip/XML 逻辑）。
 *
 * 输出约定：
 *   - Excel：每张工作表一段 `## 工作表：名称（N 行）`，单元格按行用制表符连接（紧凑、保留列结构）；
 *   - PPT ：按页码一段 `## 第 N 页：标题`，正文按 a:pPr lvl 还原层级缩进，备注单独一行。
 *
 * 旧版二进制格式（.doc/.xls/.ppt）是 OLE 复合文档，不在支持范围（调用方按不支持处理）。
 */
import JSZip from "jszip";

type XlsxModule = typeof import("xlsx");

const MAX_XLSX_BYTES = 100 * 1024 * 1024;
const MAX_PPTX_BYTES = 200 * 1024 * 1024;
const MAX_SHEETS = 30;
const MAX_ROWS_PER_SHEET = 500;
const MAX_COLS_PER_ROW = 60;
const MAX_SLIDES = 400;

/** xlsx 只有 CommonJS 主入口（xlsx.js）：ESM 下动态 import 需手动取 .default。 */
async function loadXlsx(): Promise<XlsxModule> {
  const mod = await import("xlsx");
  return ((mod as unknown as { default?: XlsxModule }).default ?? mod) as XlsxModule;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 单元格值 → 展示文本：日期补零成一串可读字符串，浮点做精度收敛（避免 0.1+0.2 的长尾）。 */
function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    const day = `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
    const time = `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
    return value.getHours() || value.getMinutes() || value.getSeconds() ? `${day} ${time}` : day;
  }
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value).replace(/\s+/g, " ").trim();
}

/** 行尾空列一律裁掉（Excel 常用区域远比实际内容宽，留着全是空制表符） */
function trimTrailingCells(cells: string[]): string[] {
  const out = [...cells];
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

export interface ExtractedOfficeText {
  text: string;
  truncated: boolean;
}

export interface ExtractedSheetText extends ExtractedOfficeText {
  /** 纳入正文的工作表数量 */
  sheets: number;
}

export interface ExtractedDeckText extends ExtractedOfficeText {
  /** 纳入正文的幻灯片数量 */
  slides: number;
}

/**
 * 提取 Excel 正文（.xlsx / .xlsm）。
 * 公式单元格取缓存值（SheetJS 默认行为）；没有缓存值时为空单元格。
 */
export async function extractXlsxText(bytes: Buffer): Promise<ExtractedSheetText> {
  if (bytes.length > MAX_XLSX_BYTES) throw new Error("Excel 超过 100MB 正文提取上限");
  const XLSX = await loadXlsx();
  let wb: ReturnType<XlsxModule["read"]>;
  try {
    wb = XLSX.read(bytes, { type: "buffer", cellDates: true });
  } catch (error) {
    throw new Error(`Excel 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const allNames = wb.SheetNames ?? [];
  const sheetNames = allNames.slice(0, MAX_SHEETS);
  let truncated = allNames.length > sheetNames.length;
  const parts: string[] = [];
  for (const name of sheetNames) {
    const sheet = wb.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: false }) as unknown[][];
    const shown = rows.slice(0, MAX_ROWS_PER_SHEET);
    if (rows.length > shown.length) truncated = true;
    const lines: string[] = [];
    for (const row of shown) {
      const cells = trimTrailingCells((Array.isArray(row) ? row : []).slice(0, MAX_COLS_PER_ROW).map(cellText));
      if (!Array.isArray(row)) continue;
      if (row.length > MAX_COLS_PER_ROW) truncated = true;
      if (cells.length) lines.push(cells.join("\t"));
    }
    if (!lines.length) {
      parts.push(`## 工作表：${name}（空表）`);
      continue;
    }
    const head = `## 工作表：${name}（${rows.length} 行）${rows.length > shown.length ? `；此处仅列出前 ${MAX_ROWS_PER_SHEET} 行` : ""}`;
    parts.push(`${head}\n${lines.join("\n")}`);
  }
  if (!parts.length) throw new Error("表格中没有可提取的内容");
  return { text: parts.join("\n\n"), sheets: sheetNames.length, truncated };
}

/** XML 实体还原（a:t 里的文本，顺序不可颠倒：&amp; 必须最后） */
function unescapeXml(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/** 取一段 XML 内所有 <a:t> 的拼接文本（换行/制表符折叠为单空格，避免无意义折行）。
 *  <a:t> 可能带 xml:space 等属性，标签名后允许属性串；<a:br> 等换行标记按空格处理。 */
function runsToText(xml: string): string {
  const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1])).join("");
  return runs.replace(/\s+/g, " ").trim();
}

/** 段落数组（保底层级）：lvl 取自 a:pPr，缺省 0 */
function collectParagraphs(xml: string): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  for (const m of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    const block = m[1];
    const text = runsToText(block);
    if (!text) continue;
    const level = Number(/<a:pPr[^>]*\slvl="(\d+)"/.exec(block)?.[1] ?? 0) || 0;
    out.push({ level, text });
  }
  return out;
}

/** 标题：优先取占位符 type="title"/"ctrTitle" 的形状；没有则用首页第一个非空段落兜底。 */
function findTitle(xml: string, paragraphs: Array<{ level: number; text: string }>): string {
  for (const m of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    if (!/<p:ph[^>]*type="(?:ctr|)(?:title)"/.test(m[0])) continue;
    const title = runsToText(m[0]);
    if (title) return title;
  }
  return paragraphs[0]?.text ?? "";
}

/** 备注页（ppt/notesSlides/notesSlideN.xml）：跳过页码字段那一段 */
async function readNote(zip: JSZip, slideNo: number): Promise<string> {
  const file = zip.file(`ppt/notesSlides/notesSlide${slideNo}.xml`);
  if (!file) return "";
  const xml = await file.async("string");
  const lines: string[] = [];
  for (const m of xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    if (/type="slidenum"/.test(m[1])) continue;
    const text = runsToText(m[1]);
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

function slideNumber(entry: string): number {
  return Number(/slide(\d+)\.xml$/.exec(entry)?.[1] ?? 0) || 0;
}

/**
 * 提取 PPT 正文（.pptx / .pptm / .ppsx）。
 * 只取文字层（不含图形/图片/图表数据）：够模型做摘要与问答，也是预览同款取法。
 */
export async function extractPptxText(bytes: Buffer): Promise<ExtractedDeckText> {
  if (bytes.length > MAX_PPTX_BYTES) throw new Error("PPT 超过 200MB 正文提取上限");
  const zip = await JSZip.loadAsync(bytes);
  const allSlides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!allSlides.length) throw new Error("不是有效的 .pptx 文件（未找到幻灯片）");
  const slides = allSlides.slice(0, MAX_SLIDES);
  const parts: string[] = [];
  for (const entry of slides) {
    const file = zip.file(entry);
    if (!file) continue;
    const xml = await file.async("string");
    const paragraphs = collectParagraphs(xml);
    const title = findTitle(xml, paragraphs);
    // 标题占位符里的那段同时也是正文首个段落，命中时去重，避免重复出现两次
    const body = paragraphs.filter((item, index) => !(index === 0 && title && item.text === title));
    const index = slideNumber(entry);
    const head = `## 第 ${index} 页${title ? `：${title}` : ""}`;
    const lines: string[] = [];
    for (const item of body) lines.push(`${"  ".repeat(Math.min(item.level, 4))}- ${item.text}`);
    const note = await readNote(zip, index);
    if (note) lines.push(`备注：${note}`);
    if (!lines.length) {
      parts.push(`${head}\n（本页没有文字，可能是图片或图表）`);
      continue;
    }
    parts.push(`${head}\n${lines.join("\n")}`);
  }
  const text = parts.join("\n\n").trim();
  if (!text) throw new Error("PPT 中没有可提取的文字正文");
  return { text, slides: slides.length, truncated: allSlides.length > slides.length };
}
