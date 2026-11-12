"use client";

import type { ReactNode } from "react";
import { FileIcon, ImageIcon, VideoIcon, AudioIcon } from "./SharedIcons.tsx";

/**
 * 文件类型图标：按扩展名/类型渲染对应的线性描边图形（黑白灰，随 currentColor/--ink-soft 变色），
 * word/ppt/excel/pdf/压缩包/文本 各有可区分的图形，图片/视频/音频复用线框图标，
 * 无法识别的兜底为通用文件图标。
 */

export type FileTypeKind =
  | "word" | "ppt" | "excel" | "pdf" | "archive" | "text"
  | "image" | "video" | "audio" | "other";

const WORD_EXTS = /\.(doc|docx|rtf|odt)$/i;
const PPT_EXTS = /\.(ppt|pptx|pptm|ppsx|potx)$/i;
const EXCEL_EXTS = /\.(xls|xlsx|xlsm|csv)$/i;
const ARCHIVE_EXTS = /\.(zip|rar|7z|tar|gz|gzip|bz2|xz)$/i;
const TEXT_EXTS = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|py|css|xml|ya?ml|toml|ini|sh|bash|bat|ps1|sql|java|go|rs|c|cpp|h|rb|php|vue|svelte|log)$/i;
const IMAGE_EXTS = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico|heic|heif|tif|tiff)$/i;
const VIDEO_EXTS = /\.(mp4|webm|mov|m4v|ogv|ogg|avi|mkv)$/i;
const AUDIO_EXTS = /\.(mp3|m4a|aac|wav|oga|flac|amr|opus|weba)$/i;

/** kind（ArtifactType）优先；否则按文件名扩展名推断类型。 */
export function fileTypeKind(name?: string, kind?: string): FileTypeKind {
  if (kind === "word" || kind === "ppt" || kind === "excel" || kind === "pdf") return kind;
  // 调用方直接给出归档/文本类型时按类型走，不再靠扩展名猜（kind 优先于文件名）。
  if (kind === "archive" || kind === "text" || kind === "other") return kind;
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  const n = name || "";
  if (WORD_EXTS.test(n)) return "word";
  if (PPT_EXTS.test(n)) return "ppt";
  if (EXCEL_EXTS.test(n)) return "excel";
  if (/\.pdf$/i.test(n)) return "pdf";
  if (ARCHIVE_EXTS.test(n)) return "archive";
  if (TEXT_EXTS.test(n)) return "text";
  if (IMAGE_EXTS.test(n)) return "image";
  if (VIDEO_EXTS.test(n)) return "video";
  if (AUDIO_EXTS.test(n)) return "audio";
  return "other";
}

/** 文档页轮廓（word/pdf/text 共用底座）。 */
function DocPage({ children }: { children?: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <polyline points="14 2 14 6 18 6" />
      {children}
    </svg>
  );
}

/** Word：文档页 + “W”。 */
function WordGlyph() {
  return <DocPage><path d="M7.5 10.5l1.2 5L11.5 11.5l1.8 4L14.5 10.5" /></DocPage>;
}

/** Excel：表格网格。 */
function ExcelGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15M15.5 4.5v15" />
    </svg>
  );
}

/** PPT：带支架的幻灯片屏。 */
function PptGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="12" rx="1.8" />
      <path d="M12 16v3.5M8.5 19.5h7M8.5 10.5h7M8.5 7.5h4" />
    </svg>
  );
}

/** PDF：文档页 + “PDF”。 */
function PdfGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <polyline points="14 2 14 6 18 6" />
      <text x="11" y="16" textAnchor="middle" textLength="11.6" lengthAdjust="spacingAndGlyphs" fontSize="5.6" fontWeight="700" fill="currentColor" stroke="none" fontFamily="Helvetica, Arial, sans-serif">PDF</text>
    </svg>
  );
}

/** 压缩包：纸箱 + 封口胶带。 */
function ArchiveGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="1.5" />
      <path d="M7 8V6.5A2.5 2.5 0 0 1 9.5 4h5A2.5 2.5 0 0 1 17 6.5V8" />
      <path d="M8.5 13.5h7" />
    </svg>
  );
}

/** 文本/代码：文档页 + 文字行。 */
function TextGlyph() {
  return <DocPage><path d="M8.5 12.5h7M8.5 16h5" /></DocPage>;
}

export default function FileTypeIcon({ name, kind }: { name?: string; kind?: string }) {
  const t = fileTypeKind(name, kind);
  if (t === "word") return <WordGlyph />;
  if (t === "ppt") return <PptGlyph />;
  if (t === "excel") return <ExcelGlyph />;
  if (t === "pdf") return <PdfGlyph />;
  if (t === "archive") return <ArchiveGlyph />;
  if (t === "text") return <TextGlyph />;
  if (t === "image") return <ImageIcon />;
  if (t === "video") return <VideoIcon />;
  if (t === "audio") return <AudioIcon />;
  return <FileIcon />;
}

/* 文件消息里的 Office/PDF 共用同一页形和尺寸；字母是可渲染的文本，不是图片资源。 */
const ATTACH_LABEL: Record<"word" | "excel" | "ppt" | "pdf", string> = {
  word: "W", excel: "X", ppt: "P", pdf: "PDF",
};

/** 是否为附件风格覆盖的 office/pdf 类型。 */
export function isOfficePdfKind(kind: FileTypeKind): boolean {
  return kind === "word" || kind === "excel" || kind === "ppt" || kind === "pdf";
}

/** 附件风格图标：office/pdf 用彩色虚线字母图标，其他类型回退到普通文件图标。 */
export function AttachmentFileIcon({ kind }: { kind?: FileTypeKind }) {
  if (!kind || !isOfficePdfKind(kind)) return <FileIcon />;
  const label = ATTACH_LABEL[kind as keyof typeof ATTACH_LABEL];
  return <span className={`attachment-file-glyph attachment-file-glyph--${kind}`}>
    <svg viewBox="0 0 36 40" focusable="false" aria-hidden="true">
      <path d="M8 2.5h15l7.5 7.5v24.5a3 3 0 0 1-3 3h-19a3 3 0 0 1-3-3v-29a3 3 0 0 1 3-3z" />
      <path d="M23 2.5V10h7.5" />
    </svg>
    <span className={`attachment-file-glyph-label${kind === "pdf" ? " attachment-file-glyph-label--pdf" : ""}`}>{label}</span>
  </span>;
}
