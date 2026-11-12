"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Dispatch, type MouseEvent, type PointerEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useBottomJump } from "../chat/useBottomJump.ts";
import { useClickOutside } from "../useClickOutside.ts";
import { FolderIcon, RevealInFolderIcon, SettingsIcon, BrowserGlobeIcon } from "../icons/SharedIcons.tsx";
import { EnhanceIcon } from "../icons/ActionIcons.tsx";
import FileTypeIcon from "../icons/FileTypeIcons.tsx";
import { ArtifactDiffPanel, type ArtifactChange } from "../components/ArtifactDiff.tsx";
import { LoadingState } from "../components/LoadingState.tsx";
import ArtifactFileManager from "../components/artifact-file-manager/ArtifactFileManager.tsx";
import TerminalPanel from "../components/TerminalPanel.tsx";
import CoworkAgentsManager from "../components/CoworkAgentsManager.tsx";
import type { ArtifactMeta, ArtifactType, UiAttachment } from "../AgentWindow.tsx";
import Markdown from "../components/Markdown.tsx";
import AiResponse from "../chat/AiResponse.tsx";
import type { CoworkMonologue } from "../components/CoworkPanel.tsx";
import { relativeTime } from "../shared/relativeTime.ts";
import { apiFetch } from "../shared/apiFetch.ts";
import { CHATMATE_ADOPT_EVENT, COWORK_COMPOSER_TEXT_EVENT, readChatDraft } from "../shared/drafts.ts";
import type { UiStep } from "../chat/types.ts";
import { parsePptx, PptxSlideView, type PptxDeck } from "../chat/PptxSlideView.tsx";
import { realtimeClient } from "../shared/realtime.ts";
import type { WorkPanelSurface } from "../chat/workPanel.ts";
import { isLocalReference } from "../shared/localFiles.ts";

export const CHAT_LINK_OPEN_EVENT = "agent:open-chat-link";

type MiniWebview = HTMLElement & {
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
};
import mammoth from "mammoth";
import Prism from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-markup-templating";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-css";
import "prismjs/components/prism-python";
import "prismjs/components/prism-java";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-php";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-ini";
import { SparkleOutlineIcon, ChatmateBubbleIcon, ChatPanelGlyph04, ChatPanelGlyph21, ChatPanelGlyph34, OperationPanelGlyph01, OperationPanelGlyph02, OperationPanelGlyph03, OperationPanelGlyph04, OperationPanelGlyph07, OperationPanelGlyph08, OperationPanelGlyph09, OperationPanelGlyph10, OperationPanelGlyph11, OperationPanelGlyph12, LocateGlyph, UploadIcon } from "../icons/PageIcons.tsx";

function RefreshIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
    <path d="M21 2v6h-6" />
    <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
    <path d="M3 22v-6h6" />
  </svg>;
}



// 产物类型 → 图标（描边由 .artifact-card-icon svg 控制）
export function ArtifactIcon({ type, name }: { type: ArtifactType; name?: string }): ReactNode {
  if (type === "text")
    return (
      <OperationPanelGlyph01 />
    );
  if (type === "html")
    return (
      <OperationPanelGlyph02 />
    );
  if (type === "markdown")
    return (
      <OperationPanelGlyph03 />
    );
  if (type === "image")
    return (
      <OperationPanelGlyph04 />
    );
  if (type === "audio" || type === "video") return <FileTypeIcon kind={type} />;
  // word/ppt/excel/pdf 用品牌色徽标（与消息气泡里的文件图标一致）
  if (type === "pdf" || type === "word" || type === "excel" || type === "ppt")
    return <FileTypeIcon kind={type} />;
  // 兜底：按文件名再判一次（压缩包这类 ArtifactType 里没有的类型靠扩展名出对图标）
  return <FileTypeIcon name={name} />;
}

// 文件大小格式化：<1KB 显示 B，其余 KB/MB 保留 1 位小数
export function formatFileSize(bytes?: number | null): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// 产物修改时间：直接显示具体时间而非"x 分钟前"。今天 → HH:mm；今年 → M月D日 HH:mm；跨年 → YYYY年M月D日 HH:mm
export function formatArtifactMtime(mtimeMs?: number | null): string {
  if (mtimeMs == null || !Number.isFinite(mtimeMs)) return "";
  const d = new Date(mtimeMs);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

// 上传附件按扩展名推断展示类型（ArtifactIcon 图标用）
/** 文本/代码扩展名（other 兜底：服务端类型未及时更新时，按文件名也能走 TextArtifact 预览） */
const TEXT_PREVIEW_RE =
  /\.(txt|json|css|js|mjs|cjs|ts|tsx|jsx|py|csv|xml|ya?ml|toml|ini|sh|bash|bat|ps1|sql|java|go|rs|c|cpp|h|rb|php|vue|svelte|md|markdown|log)$/i;
const DOTFILE_TEXT_PREVIEW_RE = /^\.(?:env(?:\..+)?|gitignore|gitattributes|gitconfig|npmrc|nvmrc|editorconfig|prettierrc|eslintrc|zshrc|bashrc|profile)$/i;
export function fileArtifactType(f: UiAttachment): ArtifactType {
  const n = (f.name || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(n)) return "image";
  if (/\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|weba)$/.test(n)) return "audio";
  if (/\.(mp4|m4v|webm|mov|ogv|avi|mkv)$/.test(n)) return "video";
  if (/\.html?$/.test(n)) return "html";
  if (/\.(md|markdown)$/.test(n)) return "markdown";
  if (/\.pdf$/.test(n)) return "pdf";
  if (/\.docx$/.test(n)) return "word";
  if (/\.(xlsx|xlsm)$/.test(n)) return "excel";
  if (/\.(pptx|pptm|ppsx)$/.test(n)) return "ppt";
  if (/\.(txt|json|css|js|mjs|cjs|ts|tsx|jsx|py|csv|xml|ya?ml|toml|ini|sh|bash|bat|ps1|sql|java|go|rs|c|cpp|h|rb|php|vue|svelte)$/.test(n))
    return "text";
  return "other";
}


// Markdown 产物预览：拉取文本后用已有的 Markdown 组件渲染（原始 HTML 经 rehype-sanitize 白名单净化）
function MarkdownArtifact({ url }: { url: string }): ReactNode {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setText("");
    setErr("");
    apiFetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("加载失败（" + r.status + "）"))))
      .then((t) => {
        if (alive) setText(t);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      alive = false;
    };
  }, [url]);
  if (err) return <div className="artifact-err">{err}</div>;
  if (!text) return <div className="artifact-loading" />;
  return (
    <div className="artifact-md">
      <Markdown content={text} />
    </div>
  );
}

// 文本/代码文件预览（js/ts/json/css 等大模型产物）：拉取原文后用 <pre> 等宽渲染，
// 不做 Markdown 解析（代码里的 < > 等不应被当成标记）
// 文本/代码预览语言映射（Prism 语法高亮）：扩展名 → prism 语言 id；不支持的走 plain（纯文本转义）
const EXT_TO_PRISM: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  ts: "typescript", tsx: "tsx", json: "json",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",
  md: "markdown", markdown: "markdown",
  css: "css", scss: "css", less: "css",
  py: "python", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
  go: "go", rs: "rust", rb: "ruby", php: "php",
  sql: "sql", sh: "bash", bash: "bash", zsh: "bash", bat: "bash", cmd: "bash",
  ps1: "powershell", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  txt: "plain", log: "plain", csv: "plain", tsv: "plain",
};
const ARTIFACT_EXT_RE = /\.([a-z0-9]+)$/i;

function TextArtifact({ url, name = "" }: { url: string; name?: string }): ReactNode {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setText("");
    setErr("");
    apiFetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("加载失败（" + r.status + "）"))))
      .then((t) => {
        if (alive) setText(t);
      })
      .catch((e) => {
        if (alive) setErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      alive = false;
    };
  }, [url]);
  if (err) return <div className="artifact-err">{err}</div>;
  if (!text) return <div className="artifact-loading" />;
  // 语法高亮（Prism）：按文件名扩展名选语言；不支持时用 plain 纯文本（同样转义，安全）
  const m = ARTIFACT_EXT_RE.exec(name);
  const lang = (m ? EXT_TO_PRISM[m[1].toLowerCase()] : undefined) || "plain";
  const grammar = Prism.languages[lang] || Prism.languages.plain;
  return (
    <div className="artifact-md">
      <pre
        className="artifact-pre"
        data-lang={lang}
        dangerouslySetInnerHTML={{ __html: Prism.highlight(text, grammar, lang) }}
      />
    </div>
  );
}

// HTML 产物预览：先探测可读性再渲染 iframe。
// 若直接渲染 iframe，服务端 readArtifact 404 时会露出 Chromium 默认错误页
// （跟随系统深色主题显示为大片黑底白字）。先 fetch 探测，失败时统一用主题化的
// .artifact-err 呈现，与左侧消息区风格一致。
function HtmlArtifact({ url, name }: { url: string; name: string }): ReactNode {
  const t = useChatTranslation();
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    setOk(null);
    apiFetch(url)
      .then((r) => {
        if (alive) setOk(r.ok);
      })
      .catch(() => {
        if (alive) setOk(false);
      });
    return () => {
      alive = false;
    };
  }, [url]);
  if (ok === null) return <div className="artifact-loading" />;
  if (!ok) return <div className="artifact-err">{t("fileMissing")}</div>;
  return <iframe className="artifact-frame" src={url} sandbox="" title={name} />;
}

/** 轻量白名单清洗：mammoth 输出为受控结构，主要剥离 docx 可能内嵌的脚本类标签与事件属性 */
function sanitizeWordHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[\s\S]*?>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

// Word(.docx) 内嵌预览：mammoth(浏览器版) 转 HTML 渲染（标题/段落/表格）。
// 输入/产物统一 fetch 原文件（服务端返回原始 docx，不预转换），前端转换，无需服务端特殊处理。
function WordArtifact({ url }: { url: string }): ReactNode {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    setHtml(null);
    setErr("");
    apiFetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`文件请求失败（HTTP ${r.status}）`))))
      // Mammoth 的浏览器入口读取 arrayBuffer，Node 入口读取 buffer。
      // 两者都传入，避免桌面端打包解析到 Node 入口时误报文件损坏。
      .then((buf) => mammoth.convertToHtml({ arrayBuffer: buf, buffer: new Uint8Array(buf) } as unknown as Parameters<typeof mammoth.convertToHtml>[0]))
      .then((res) => {
        if (alive) setHtml(res.value);
      })
      .catch((error: unknown) => {
        if (alive) setErr(error instanceof Error ? error.message : "未知错误");
      });
    return () => {
      alive = false;
    };
  }, [url]);
  if (err)
    return (
      <div className="artifact-other-hint">
        Word 文件预览失败：{err}。可使用右上角下载按钮获取文件。
      </div>
    );
  if (html == null) return <div className="artifact-loading" />;
  return <div className="artifact-word" dangerouslySetInnerHTML={{ __html: sanitizeWordHtml(html) }} />;
}

/* ===== 通用小工具：日期/数值 → 展示串（与服务端 office-text.ts 同口径） ===== */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function officeCellText(value: unknown): string {
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

// Excel(.xlsx) 内嵌预览：SheetJS 读原文件 → 工作表标签 + 表格。
// 与 Word 同一套路：服务端返回原始二进制，前端自己解析；xlsx 体积大，用动态 import 拆包不进主 bundle。
const EXCEL_MAX_SHEETS = 30;
const EXCEL_MAX_ROWS = 200;
const EXCEL_MAX_COLS = 40;
type ExcelSheetTable = { name: string; rows: string[][]; total: number };

function ExcelArtifact({ url }: { url: string }): ReactNode {
  const [sheets, setSheets] = useState<ExcelSheetTable[] | null>(null);
  const [active, setActive] = useState(0);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setSheets(null);
    setActive(0);
    setErr(false);
    void (async () => {
      try {
        const res = await apiFetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        const mod = await import("xlsx");
        const XLSX = ((mod as unknown as { default?: typeof mod }).default ?? mod) as typeof import("xlsx");
        const wb = XLSX.read(buf, { type: "array", cellDates: true });
        const tables: ExcelSheetTable[] = [];
        for (const name of (wb.SheetNames ?? []).slice(0, EXCEL_MAX_SHEETS)) {
          const sheet = wb.Sheets[name];
          if (!sheet) continue;
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: false }) as unknown[][];
          const cells = rows.slice(0, EXCEL_MAX_ROWS).map((row) => {
            const list = Array.isArray(row) ? row.slice(0, EXCEL_MAX_COLS).map(officeCellText) : [];
            while (list.length && !list[list.length - 1]) list.pop();
            return list;
          });
          tables.push({ name, rows: cells, total: rows.length });
        }
        if (alive) setSheets(tables);
      } catch {
        if (alive) setErr(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);
  if (err) return <div className="artifact-other-hint">Excel 预览失败，请使用右上角下载按钮获取文件。</div>;
  if (!sheets) return <div className="artifact-loading" />;
  const index = Math.min(active, sheets.length - 1);
  const current = sheets[index] ?? { name: "", rows: [], total: 0 };
  // 首行当表头（Excel 惯例，仅多行的表才这么判），其余为数据行；宽度按最宽行补齐，避免行尾缺格子样式
  const header = current.rows.length > 1 ? current.rows[0] : [];
  const width = Math.max(header.length, ...current.rows.map((row) => row.length), 0);
  return (
    <div className="artifact-excel">
      {sheets.length > 1 ? (
        <div className="artifact-sheet-tabs" role="tablist">
          {sheets.map((sheet, i) => (
            <button
              key={`${sheet.name}-${i}`}
              type="button"
              role="tab"
              aria-selected={i === index}
              className={`artifact-sheet-tab${i === index ? " is-active" : ""}`}
              title={sheet.name}
              onClick={() => setActive(i)}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="artifact-sheet-wrap">
        <table className="artifact-sheet">
          {header.length ? (
            <thead>
              <tr>{header.map((cell, i) => <th key={i}>{cell}</th>)}</tr>
            </thead>
          ) : null}
          <tbody>
            {current.rows.slice(header.length ? 1 : 0).map((row, r) => (
              <tr key={r}>{Array.from({ length: width }, (_, c) => <td key={c}>{row[c] ?? ""}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {current.total > EXCEL_MAX_ROWS ? (
        <div className="artifact-sheet-note">共 {current.total} 行，此处显示前 {EXCEL_MAX_ROWS} 行；完整数据请用右上角下载。</div>
      ) : null}
    </div>
  );
}

// PPT(.pptx) 内嵌预览：JSZip 解包 + DOMParser 解析，按 PPT 的 EMU 坐标把每一页渲染成
// 真实的幻灯片页面（文本/图片/底色/分组/表格/备注），见 chat/PptxSlideView.tsx。
// 与 Word 同一套路：服务端返回原始二进制，前端自己解析；jszip 用动态 import 拆包不进主 bundle。
function PptxArtifact({ url }: { url: string }): ReactNode {
  const [deck, setDeck] = useState<PptxDeck | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    setDeck(null);
    setErr(false);
    void (async () => {
      try {
        const res = await apiFetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        const parsed = await parsePptx(buf);
        if (alive) setDeck(parsed);
      } catch {
        if (alive) setErr(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [url]);
  if (err) return <div className="artifact-other-hint">PPT 预览失败，请使用右上角下载按钮获取文件。</div>;
  if (!deck) return <div className="artifact-loading" />;
  return <PptxSlideView deck={deck} />;
}

function MediaArtifact({ url, name, kind }: { url: string; name: string; kind: "audio" | "video" }): ReactNode {
  const t = useChatTranslation();
  const [error, setError] = useState(false);
  if (error) return <div className="artifact-other-hint">{name}<br />{t("mediaUnavailable")}</div>;
  return <div className={`artifact-media artifact-media--${kind}`}>
    {kind === "audio"
      ? <audio src={url} controls preload="metadata" aria-label={name} onError={() => setError(true)} />
      : <video src={url} controls preload="metadata" playsInline aria-label={name} onError={() => setError(true)} />}
  </div>;
}

/** 供会话产物与资料库共用的文件预览。以文件名判断代码类型，避免依赖上传时的 MIME。 */
export function FilePreviewContent({ url, name, type }: { url: string; name: string; type?: ArtifactType }): ReactNode {
  const t = useChatTranslation();
  const resolved = type && type !== "other" ? type : fileArtifactType({ url, name });
  if (resolved === "html") return <HtmlArtifact url={url} name={name} />;
  if (resolved === "markdown") return <MarkdownArtifact url={url} />;
  if (resolved === "text" || TEXT_PREVIEW_RE.test(name) || DOTFILE_TEXT_PREVIEW_RE.test(name.split("/").pop() || name)) return <TextArtifact url={url} name={name} />;
  if (resolved === "image") return <div className="artifact-image-preview"><img className="artifact-img" src={url} alt={name} /></div>;
  if (resolved === "audio") return <MediaArtifact key={url} url={url} name={name} kind="audio" />;
  if (resolved === "video") return <MediaArtifact key={url} url={url} name={name} kind="video" />;
  if (resolved === "pdf") return <iframe className="artifact-frame" src={url} title={name} />;
  if (resolved === "word" || /\.docx$/i.test(name)) return <WordArtifact url={url} />;
  if (resolved === "excel" || /\.(xlsx|xlsm)$/i.test(name)) return <ExcelArtifact url={url} />;
  if (resolved === "ppt" || /\.(pptx|pptm|ppsx)$/i.test(name)) return <PptxArtifact url={url} />;
  // 旧版二进制格式（OLE 复合文档）服务端与浏览器都解不开：给一句可操作的提示，而不是笼统的"无法显示"
  const legacyOffice = /\.(doc|xls|ppt)$/i.exec(name)?.[1]?.toLowerCase();
  if (legacyOffice)
    return (
      <div className="artifact-other-hint">
        {name}
        <br />
        {t("legacyOffice", { format: legacyOffice })}
      </div>
    );
  return <div className="artifact-other-hint">{name}<br />{t("previewUnavailable")}</div>;
}


type Preview = { sid: string; meta: ArtifactMeta } | null;
type DiffView = { sid: string; activeId: string } | null;
type InputPreview = { url: string; name: string; type: ArtifactType } | null;
function ArtifactsFolderIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2.1 2.2h6.9A2.5 2.5 0 0 1 21 9.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5z" /><path d="M3 9.7h18" /></svg>;
}
function TerminalIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2" /><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4" /></svg>;
}
function fastThoughtText(item: CoworkMonologue): string {
  if (item.status === "steered") return item.content;
  if (item.status === "review_initial" && !item.content) return "初步判断已进入复核；这条旧记录未保存初判原文。";
  if (item.status === "error") return item.content;
  let decision = "";
  let answer = "";
  try {
    const parsed = JSON.parse(item.content) as { decision?: string; answer?: string };
    decision = parsed.decision || "";
    answer = parsed.answer || "";
  } catch {
    decision = /"decision"\s*:\s*"(silent|reply|delegate)"/.exec(item.content)?.[1] || "";
    const rawAnswer = /"answer"\s*:\s*"((?:\\.|[^"\\])*)/.exec(item.content)?.[1] || "";
    try { answer = JSON.parse(`"${rawAnswer.replace(/\\$/, "")}"`) as string; } catch { answer = rawAnswer; }
  }
  if (item.status === "reviewing") return "我再核对一下，这轮是否该由我发言…";
  if (decision === "review") return "初步判断还不确定，我再想想。";
  if (decision === "reply") return answer || "我来回应一下。";
  if (decision === "slow_reply") return "复核后决定回应，接下来继续处理。";
  if (decision === "silent") return "这轮我先不插话。";
  if (decision === "delegate") return item.status === "review_initial" ? "初步判断需要深入处理，我再确认是否应该接手。" : "这件事需要深入处理，我继续完成。";
  return item.status === "running" || item.status === "reviewing" ? "我正在判断是否需要回应…" : item.content;
}
function fastThoughtTag(item: CoworkMonologue): string {
  if (item.status === "steered") return "被新消息引导";
  if (item.status === "error") return "处理失败";
  if (item.status === "review_initial" || item.status === "reviewing") return "让我想想";
  const decision = /"decision"\s*:\s*"(silent|reply|delegate|slow_reply)"/.exec(item.content)?.[1];
  if (decision === "slow_reply") return "思考后答复";
  if (decision === "reply") return item.id.endsWith(":review") ? "思考后答复" : "直接答复";
  if (decision === "delegate") return "三思而行";
  if (decision === "silent") return "保持沉默";
  return "思考中";
}
type WorkTab =
  | { key: string; sid: string; kind: "files"; title: string }
  | { key: string; sid: string; kind: "inputs"; title: string }
  | { key: string; sid: string; kind: "artifact"; title: string; meta: ArtifactMeta }
  | { key: string; sid: string; kind: "input"; title: string; file: NonNullable<InputPreview> }
  | { key: string; sid: string; kind: "changes"; title: string; activeId: string }
  | { key: string; sid: string; kind: "monologue"; title: string }
  | { key: string; sid: string; kind: "chatmate"; title: string }
  | { key: string; sid: string; kind: "terminal"; title: string }
  | { key: string; sid: string; kind: "surface"; title: string; surface: WorkPanelSurface; history: string[]; historyIndex: number; reloadKey: number };

function sameSurfacePath(left?: string, right?: string): boolean {
  if (!left || !right) return false;
  try {
    const a = new URL(left);
    const b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch { return false; }
}

const RIGHT_TABS_STORAGE_KEY = "agent-kit:right-tabs:v1";
/** 每个会话各自记住「当前激活的 tab」（key 存入 activeBySid[sid]），切换会话再切回来时自动恢复；tabs 列表本身也持久化。 */
function readStoredTabs(): { tabs: WorkTab[]; activeBySid: Record<string, string>; historyBySid: Record<string, string[]> } {
  if (typeof window === "undefined") return { tabs: [], activeBySid: {}, historyBySid: {} };
  try {
    const stored = JSON.parse(window.localStorage.getItem(RIGHT_TABS_STORAGE_KEY) || "null") as { tabs?: unknown; activeBySid?: unknown; activeTabKey?: unknown; historyBySid?: unknown } | null;
    const tabs = Array.isArray(stored?.tabs) ? stored.tabs.filter((tab): tab is WorkTab => {
      if (!tab || typeof tab !== "object" || typeof tab.key !== "string" || typeof tab.sid !== "string" || typeof tab.title !== "string") return false;
      if (tab.kind === "files" || tab.kind === "monologue" || tab.kind === "chatmate" || tab.kind === "terminal") return true;
      if (tab.kind === "artifact") return tab.meta && typeof tab.meta.id === "string" && typeof tab.meta.name === "string" && typeof tab.meta.type === "string";
      if (tab.kind === "input") return tab.file && typeof tab.file.url === "string" && typeof tab.file.name === "string";
      if (tab.kind === "changes") return typeof tab.activeId === "string";
      return tab.kind === "surface" && tab.surface && (tab.surface.kind === "website" || tab.surface.kind === "app") && typeof tab.surface.id === "string" && typeof tab.surface.title === "string" && Array.isArray(tab.history) && tab.history.every((url: unknown) => typeof url === "string") && Number.isInteger(tab.historyIndex) && Number.isInteger(tab.reloadKey);
    }).slice(-100) : [];
    const activeBySid: Record<string, string> = {};
    const raw = stored?.activeBySid;
    if (raw && typeof raw === "object") {
      for (const [sid, key] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof key === "string" && tabs.some(tab => tab.sid === sid && tab.key === key)) activeBySid[sid] = key;
      }
    }
    // 兼容旧版单值 activeTabKey：迁移为所属会话的激活 tab
    const legacy = typeof stored?.activeTabKey === "string" ? stored.activeTabKey : null;
    if (legacy) {
      const owner = tabs.find(tab => tab.key === legacy);
      if (owner && !activeBySid[owner.sid]) activeBySid[owner.sid] = owner.key;
    }
    const historyBySid: Record<string, string[]> = {};
    if (stored?.historyBySid && typeof stored.historyBySid === "object") {
      for (const [sid, keys] of Object.entries(stored.historyBySid as Record<string, unknown>)) {
        if (Array.isArray(keys)) historyBySid[sid] = keys.filter((key): key is string => typeof key === "string" && tabs.some(tab => tab.sid === sid && tab.key === key));
      }
    }
    for (const [sid, key] of Object.entries(activeBySid)) {
      historyBySid[sid] = [...(historyBySid[sid] ?? []).filter(item => item !== key), key];
    }
    return { tabs, activeBySid, historyBySid };
  } catch { return { tabs: [], activeBySid: {}, historyBySid: {} }; }
}

export interface OperationPanelProps {
  rightShown: boolean;
  rightDragging: boolean;
  rightW: number | null;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeMove: (event: PointerEvent<HTMLDivElement>) => void;
  onResizeEnd: () => void;
  inputFiles: (UiAttachment & { messageId?: number | null })[];
  /** 点击「定位到消息」：跳转到上传该文件的消息并高亮（复用搜索定位的 jumpTarget 机制）。 */
  onJumpToMessage?: (messageId: number) => void;
  preview: Preview;
  diffView: DiffView;
  inputFilePreview: InputPreview;
  workSurface: WorkPanelSurface | null;
  /** 按 surface.id 渲染宿主侧栏项提供的页面（url 为空的内嵌 app 用）。 */
  renderApp?: (id: string) => ReactNode;
  closeWorkSurface: () => void;
  resolveFileUrl: (url: string | undefined | null, fileId?: string) => string;
  desktopApp: boolean;
  openInputFile: (file: UiAttachment) => void;
  desktopDownload: (file: UiAttachment) => boolean;
  revealInputFile: (file: UiAttachment) => void;
  activeSid: string;
  /** 新建会话空态暂不显示输入/输出文件入口。 */
  hideFileChoices?: boolean;
  sessionChanges: ArtifactChange[];
  artifactLists: Record<string, ArtifactMeta[]>;
  artifactLoadErrors: Record<string, boolean>;
  rightBodyRef: RefObject<HTMLDivElement | null>;
  setDiffView: Dispatch<SetStateAction<DiffView>>;
  setInputFilePreview: Dispatch<SetStateAction<InputPreview>>;
  setPreview: Dispatch<SetStateAction<Preview>>;
  previewFull: boolean;
  setPreviewFull: Dispatch<SetStateAction<boolean>>;
  buildArtifactUrl: (id: string) => string;
  browserShot: string | null;
  cdpPort: number;
  handleBrowserShotClick: (event: MouseEvent<HTMLImageElement>) => void;
  refreshArtifactList: (sid: string, ensureFresh?: boolean) => Promise<void>;
  artifactMenuId: string | null;
  setArtifactMenuId: Dispatch<SetStateAction<string | null>>;
  openArtifactFileDir: (dir: string) => Promise<void>;
  onZipFolder: (rel: string) => void;
  onRenameArtifact: (rel: string, newName: string, isDir: boolean) => Promise<boolean>;
  onMoveArtifact: (rel: string, destination: string, isDir: boolean) => Promise<boolean>;
  onDeleteArtifact: (rel: string, isDir: boolean) => Promise<boolean>;
  onCreateFolder: (rel: string, name: string) => Promise<"ok" | "exists" | "error">;
  coworkMonologues?: CoworkMonologue[];
  coworkMode?: "group";
  /** 终端提示符里的主机名：群聊=群名，1v1=对方名字。 */
  terminalHost?: string;
  mobilePage?: "artifacts" | "chatmate" | "monologue" | null;
  mobileArtifactPreviewActive?: boolean;
  onMobileBack?: () => void;
  onMobileArtifactPreview?: (artifactId: string) => void;
  onShareArtifact: (meta: ArtifactMeta) => void;
  basePath: string;
}

type ChatmateSuggestion = { id: string; messageId: number; senderName?: string | null; status: string; content: string; reasoning?: string | null; draftText?: string | null; tasks?: Array<{ title: string; status: string; result?: string; error?: string }>; blocker?: { decision: "ask_group" | "stop"; reason: string; question?: string } | null; reaction?: { messageId: number; emoji: string } | null; steps?: UiStep[]; elapsedSecs?: number | null; error?: string | null; startedAt: string };

/** 移动端提供独立页面顶栏；下方内容与桌面右栏复用同一套节点。 */
function MobileWorkPageContainer({ page, previewTitle, onBack, children }: {
  page?: "artifacts" | "chatmate" | "monologue" | null;
  previewTitle?: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  if (!page) return <>{children}</>;
  const title = page === "artifacts" ? previewTitle || "查看产物" : page === "chatmate" ? "伴聊 · Chatmate" : "群 AI";
  return <>
    <header className="chat-mobile-work-head">
      <button type="button" onClick={onBack} aria-label={previewTitle ? "返回产物列表" : "返回聊天详情"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 5-7 7 7 7" /></svg>
      </button>
      <span className="chat-title">{title}</span>
    </header>
    {children}
  </>;
}

export default function OperationPanel(props: OperationPanelProps) {
  const t = useChatTranslation();
  const {
    rightShown, rightDragging, rightW, onResizeStart, onResizeMove, onResizeEnd,
    inputFiles, preview, diffView, inputFilePreview, workSurface, renderApp, closeWorkSurface, resolveFileUrl, desktopApp, revealInputFile,
    openInputFile, desktopDownload,
    activeSid, hideFileChoices, sessionChanges, artifactLists, artifactLoadErrors, rightBodyRef,
    setDiffView, setInputFilePreview, setPreview, previewFull, setPreviewFull,
    buildArtifactUrl, browserShot, cdpPort, handleBrowserShotClick,
    refreshArtifactList, openArtifactFileDir,
    onZipFolder, onRenameArtifact, onMoveArtifact, onDeleteArtifact, onCreateFolder, onShareArtifact,
    coworkMonologues, coworkMode, terminalHost, mobilePage, mobileArtifactPreviewActive, onMobileBack, onMobileArtifactPreview, basePath, onJumpToMessage,
  } = props;
  const [previewHeadShown, setPreviewHeadShown] = useState(false);
  // 产物预览刷新：讨论中 AI 可能已更新了文件版本，点击刷新按钮重挂预览组件并加 cache-buster 重新拉取
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const [storedTabs] = useState(readStoredTabs);
  const [tabs, setTabs] = useState<WorkTab[]>(storedTabs.tabs);
  const [fileDirsBySid, setFileDirsBySid] = useState<Record<string, string>>({});
  const tabStripRef = useRef<HTMLDivElement>(null);
  const draggedTabKey = useRef<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  // 每个会话各自的激活 tab 记忆：切会话/刷新后按会话恢复（空值表示该会话显示选择器）
  const [activeBySid, setActiveBySid] = useState<Record<string, string>>(storedTabs.activeBySid);
  const [historyBySid, setHistoryBySid] = useState<Record<string, string[]>>(storedTabs.historyBySid);
  const activeTabKey = activeBySid[activeSid] || null;
  const setActiveTabKey = (key: string | null) => {
    if (key) setHistoryBySid(current => ({ ...current, [activeSid]: [...(current[activeSid] ?? []).filter(item => item !== key), key] }));
    setActiveBySid(current => {
      if (!key) {
        if (!(activeSid in current)) return current;
        const next = { ...current };
        delete next[activeSid];
        return next;
      }
      if (current[activeSid] === key) return current;
      return { ...current, [activeSid]: key };
    });
  };
  useEffect(() => {
    if (mobilePage === "artifacts" && !mobileArtifactPreviewActive) setActiveTabKey(`files:${activeSid}`);
  }, [mobilePage, mobileArtifactPreviewActive, activeSid]);
  const [addressDrafts, setAddressDrafts] = useState<Record<string, string>>({});
  const [addressError, setAddressError] = useState<string | null>(null);
  const browserViews = useRef<Record<string, MiniWebview>>({});
  const boundBrowserViews = useRef(new WeakSet<MiniWebview>());
  const [browserStates, setBrowserStates] = useState<Record<string, { url: string; loading: boolean; back: boolean; forward: boolean; error?: string }>>({});
  const bindBrowserView = (key: string, element: HTMLWebViewElement | null) => {
    if (!element) { delete browserViews.current[key]; return; }
    const view = element as MiniWebview;
    browserViews.current[key] = view;
    if (boundBrowserViews.current.has(view)) return;
    boundBrowserViews.current.add(view);
    const sync = (patch: Partial<{ loading: boolean; error: string }>) => {
      const url = view.getURL?.() || "";
      setBrowserStates((current) => ({ ...current, [key]: {
        url: url || current[key]?.url || "", loading: patch.loading ?? current[key]?.loading ?? false,
        back: view.canGoBack?.() ?? false, forward: view.canGoForward?.() ?? false,
        error: patch.error ?? (patch.loading ? "" : current[key]?.error),
      } }));
      if (url) setAddressDrafts((current) => ({ ...current, [key]: url }));
    };
    view.addEventListener("did-start-loading", () => sync({ loading: true, error: "" }));
    view.addEventListener("did-stop-loading", () => sync({ loading: false }));
    const onNavigate = () => {
      sync({ error: "" });
      const url = view.getURL?.();
      if (url) {
        try {
          const title = new URL(url).hostname;
          setTabs((current) => current.map((tab) => tab.key === key ? { ...tab, title } : tab));
        } catch { /* keep the existing tab title */ }
      }
    };
    view.addEventListener("did-navigate", onNavigate);
    view.addEventListener("did-navigate-in-page", onNavigate);
    view.addEventListener("did-fail-load", (event) => {
      const failure = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      if (failure.errorCode !== -3 && failure.isMainFrame !== false) sync({ loading: false, error: failure.errorDescription || "页面加载失败" });
    });
  };
  const [savedMonologues, setSavedMonologues] = useState<{ sid: string; items: CoworkMonologue[] } | null>(null);
  const [monologueError, setMonologueError] = useState("");
  const [chatmateState, setChatmateState] = useState<{ sid: string; enabled: boolean; autoReply: boolean; customPrompt: string | null; defaultPrompt: string; items: ChatmateSuggestion[] } | null>(null);
  const [chatmateError, setChatmateError] = useState("");
  const [chatmateBrowserAnswer, setChatmateBrowserAnswer] = useState("");
  // 群 AI 思考记录当前选中的 agent（切换 AI = 重新进入，滚动回底部）；null = 列表视图。
  const [monologueAgentId, setMonologueAgentId] = useState<string | null>(null);
  // 伴聊设置弹层：状态（左上）+ 设置按钮（右上），弹层内含「启动伴聊」「自动回复」开关与自定义伴聊提示词，默认关闭。
  const [chatmateSettingsOpen, setChatmateSettingsOpen] = useState(false);
  // 自定义伴聊提示词草稿（textarea 本地编辑态）；customPrompt 为已保存值（null=用内置默认），defaultPrompt 为内置全文。
  const [chatmatePromptDraft, setChatmatePromptDraft] = useState("");
  const [chatmatePromptSaving, setChatmatePromptSaving] = useState(false);
  const [chatmatePromptSaved, setChatmatePromptSaved] = useState(false);
  // 伴聊增强草稿：记录群聊输入框当前文本（CoworkPanel 广播），有输入时点击增强按钮走全文审视，无输入时触发一次完整伴聊。
  const [chatmateEnhanceBusy, setChatmateEnhanceBusy] = useState(false);
  const [chatmateEnhanceError, setChatmateEnhanceError] = useState("");
  const [composerTextBySid, setComposerTextBySid] = useState<Record<string, string>>({});
  const chatmateRunning = (chatmateState?.sid === activeSid ? chatmateState.items : []).some(item => item.status === "running");
  useEffect(() => {
    const onComposerText = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string }>).detail;
      if (!detail) return;
      setComposerTextBySid(prev => ({ ...prev, [detail.sessionId]: detail.text ?? "" }));
    };
    window.addEventListener(COWORK_COMPOSER_TEXT_EVENT, onComposerText);
    return () => window.removeEventListener(COWORK_COMPOSER_TEXT_EVENT, onComposerText);
  }, []);
  // 兜底：右栏刚挂载/切换会话时，广播事件可能没收到（输入发生在组件挂载前），从本地草稿读取当前输入框文本。
  useEffect(() => {
    setComposerTextBySid(prev => ({ ...prev, [activeSid]: readChatDraft(activeSid).text }));
  }, [activeSid]);
  async function handleChatmateEnhance() {
    if (chatmateEnhanceBusy || chatmateRunning) return;
    setChatmateEnhanceBusy(true);
    setChatmateEnhanceError("");
    const text = (composerTextBySid[activeSid] ?? "").trim();
    try {
      const response = await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(activeSid)}/chatmate/act`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; text?: string; runId?: string; error?: string; message?: string };
      if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
      if (data.text) {
        // 有输入：把结合全文上下文审视后的改进文本填回群聊输入框
        window.dispatchEvent(new CustomEvent(CHATMATE_ADOPT_EVENT, { detail: { sessionId: activeSid, text: data.text } }));
      }
      // 无输入：已触发一次完整伴聊（建议会出现在本面板列表中）
    } catch (error) {
      console.warn("[agent-kit] 伴聊草稿审视失败:", error);
      setChatmateEnhanceError(error instanceof Error && error.message ? `处理失败：${error.message}` : "处理失败，请重试");
    } finally {
      setChatmateEnhanceBusy(false);
    }
  }
  const chatmateAutoReply = chatmateState?.sid === activeSid && chatmateState.autoReply;
  /** 设置联动：打开自动回复时自动打开伴聊；关闭伴聊时必定关闭自动回复。 */
  const toggleChatmateEnabled = () => {
    const next = !(chatmateState?.sid === activeSid && chatmateState.enabled);
    void setChatmateEnabled(next);
  };
  const toggleChatmateAutoReply = () => {
    const next = !chatmateAutoReply;
    void setChatmateSettings({ autoReply: next });
  };
  // Chatmate 设置弹层：点击弹层/按钮之外任意处或 Esc 关闭
  useClickOutside({
    enabled: chatmateSettingsOpen,
    exceptSelectors: [".chatmate-settings-popup", ".chatmate-settings-btn"],
    onDismiss: () => setChatmateSettingsOpen(false),
  });
  // 打开设置弹层时，把提示词草稿初始化为已保存自定义值；未保存则填入内置默认全文
  useEffect(() => {
    if (!chatmateSettingsOpen) return;
    const saved = chatmateState?.sid === activeSid ? chatmateState.customPrompt : null;
    setChatmatePromptDraft(saved ?? chatmateState?.defaultPrompt ?? "");
    setChatmatePromptSaved(false);
  }, [chatmateSettingsOpen, activeSid, chatmateState?.customPrompt, chatmateState?.defaultPrompt]);
  const nextTabId = useRef(Math.max(0, ...storedTabs.tabs.map(tab => Number(tab.key.match(/:(\d+)$/)?.[1] || 0))));
  useEffect(() => {
    try { window.localStorage.setItem(RIGHT_TABS_STORAGE_KEY, JSON.stringify({ tabs, activeBySid, historyBySid })); } catch { /* storage unavailable */ }
  }, [tabs, activeBySid, historyBySid]);
  const lastIncoming = useRef<{ artifact?: Preview; input?: InputPreview; changes?: DiffView; surface?: WorkPanelSurface }>({});
  const addTab = (tab: WorkTab, reuse = true, focus = true) => {
    setTabs((current) => {
      const existing = reuse ? current.find((item) => item.sid === tab.sid && item.key === tab.key) : null;
      if (existing) return current.map((item) => item === existing ? tab : item);
      return [...current, tab];
    });
    if (focus) setActiveTabKey(tab.key);
  };
  useEffect(() => {
    if (!mobilePage) return;
    const kind = mobilePage === "artifacts" ? "files" : mobilePage;
    const title = kind === "files" ? "产物" : kind === "chatmate" ? "伴聊 · Chatmate" : "群 AI";
    addTab({ key: `${kind}:${activeSid}`, sid: activeSid, kind, title } as WorkTab);
  }, [mobilePage, activeSid]);
  useEffect(() => {
    if (preview && preview !== lastIncoming.current.artifact) {
      lastIncoming.current.artifact = preview;
      const key = preview.meta.type === "browser" ? `browser:${preview.sid}` : `artifact:${preview.sid}:${preview.meta.id}`;
      addTab({ key, sid: preview.sid, kind: "artifact", title: preview.meta.name, meta: preview.meta }, true, preview.meta.type !== "browser" || !tabs.some((tab) => tab.key === key));
    } else if (!preview) lastIncoming.current.artifact = null;
  }, [preview]);
  useEffect(() => {
    if (inputFilePreview && inputFilePreview !== lastIncoming.current.input) {
      lastIncoming.current.input = inputFilePreview;
      addTab({ key: `input:${activeSid}:${inputFilePreview.url}`, sid: activeSid, kind: "input", title: inputFilePreview.name, file: inputFilePreview });
    } else if (!inputFilePreview) lastIncoming.current.input = null;
  }, [inputFilePreview, activeSid]);
  useEffect(() => {
    if (diffView && diffView !== lastIncoming.current.changes) {
      lastIncoming.current.changes = diffView;
      addTab({ key: `changes:${diffView.sid}`, sid: diffView.sid, kind: "changes", title: "文件变更", activeId: diffView.activeId });
    } else if (!diffView) lastIncoming.current.changes = null;
  }, [diffView]);
  useEffect(() => {
    if (workSurface && workSurface !== lastIncoming.current.surface) {
      lastIncoming.current.surface = workSurface;
      const sid = workSurface.sessionId || activeSid;
      const reusableUrls = [workSurface.url, ...(workSurface.reusePaths ?? []).map((path) => {
        try { return new URL(path, workSurface.url).href; } catch { return undefined; }
      })];
      const existing = tabs.find((tab) => tab.sid === sid && tab.kind === "surface" &&
        (tab.surface.id === workSurface.id || (workSurface.reusePath && reusableUrls.some((url) => sameSurfacePath(tab.surface.url, url)))));
      const key = existing?.key || `surface:${sid}:${workSurface.id}`;
      const urlChanged = existing?.kind === "surface" && existing.surface.url !== workSurface.url;
      setTabs((current) => {
        const next: WorkTab = { key, sid, kind: "surface", title: workSurface.title, surface: workSurface,
          history: workSurface.url ? [workSurface.url] : [], historyIndex: workSurface.url ? 0 : -1,
          reloadKey: existing?.kind === "surface" ? existing.reloadKey + (urlChanged || workSurface.reload ? 1 : 0) : 0 };
        return current.some((tab) => tab.key === key)
          ? current.map((tab) => tab.key === key ? next : tab)
          : [...current, next];
      });
      if (urlChanged) setAddressDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setActiveBySid((current) => current[sid] === key ? current : { ...current, [sid]: key });
    } else if (!workSurface) lastIncoming.current.surface = undefined;
  }, [workSurface, activeSid]);
  const sessionTabs = tabs.filter((tab) => tab.sid === activeSid);
  const selectedTab = sessionTabs.find((tab) => tab.key === activeTabKey) || null;
  // 工作区 tab 菜单（右键/⋯）：点击菜单之外任意处或 Esc 关闭
  useClickOutside({
    enabled: tabMenu !== null,
    exceptSelectors: [".work-panel-tab-menu"],
    onDismiss: () => setTabMenu(null),
  });
  useLayoutEffect(() => {
    if (!rightShown || !selectedTab) return;
    const strip = tabStripRef.current;
    const active = strip?.querySelector<HTMLElement>(".work-panel-tab-wrap.is-active");
    if (!strip || !active) return;
    const stripRect = strip.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    if (activeRect.right > stripRect.right) strip.scrollLeft += activeRect.right - stripRect.right;
    else if (activeRect.left < stripRect.left) strip.scrollLeft += activeRect.left - stripRect.left;
  }, [activeSid, activeTabKey, rightShown, sessionTabs.length]);
  useEffect(() => {
    if (selectedTab?.kind !== "monologue") return;
    let cancelled = false;
    let loading = false;
    setMonologueError("");
    const source = new EventSource(`${basePath}/api/cowork/${encodeURIComponent(activeSid)}/stream`, { withCredentials: true });
    source.addEventListener("fast", event => {
      try {
        const next = JSON.parse((event as MessageEvent).data) as CoworkMonologue & { runId: string; phase?: "initial" | "review" };
        const itemId = next.phase === "review" ? `${next.runId}:review` : next.runId;
        setSavedMonologues(current => {
          const items = current?.sid === activeSid ? current.items : [];
          return { sid: activeSid, items: [...items.filter(item => item.id !== itemId),
            { id: itemId, content: next.content, status: next.status, steps: next.steps, elapsedSecs: next.elapsedSecs,
              startedAt: items.find(item => item.id === itemId)?.startedAt || new Date().toISOString() }] };
        });
      } catch { /* 忽略坏帧 */ }
    });
    const loadHistory = () => {
      if (loading) return Promise.resolve();
      loading = true;
      return apiFetch(`${basePath}/api/cowork/${encodeURIComponent(activeSid)}/monologues`, { cache: "no-store" })
      .then(response => response.ok ? response.json() : Promise.reject(new Error(`加载失败（${response.status}）`)))
      .then((data: { monologues?: CoworkMonologue[] }) => {
        if (!cancelled) {
          setMonologueError("");
          setSavedMonologues(current => {
          const live = current?.sid === activeSid ? current.items : [];
          const items = new Map((Array.isArray(data.monologues) ? data.monologues : []).map(item => [item.id, item]));
          for (const item of live) {
            const saved = items.get(item.id);
            if (!saved || (item.status === saved.status && (item.status === "running" || item.status === "reviewing"))) items.set(item.id, item);
          }
          return { sid: activeSid, items: [...items.values()] };
          });
        }
      })
      .catch(error => { if (!cancelled) setMonologueError(error instanceof Error ? error.message : "加载失败"); })
      .finally(() => { loading = false; });
    };
    void loadHistory();
    source.onopen = () => { if (!cancelled) void loadHistory(); };
    source.onerror = () => { if (!cancelled) void loadHistory(); };
    const onVisibility = () => { if (!document.hidden && !cancelled) void loadHistory(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; source.close(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [selectedTab?.key, activeSid, basePath]);
  useEffect(() => {
    if (selectedTab?.kind !== "chatmate") return;
    let cancelled = false;
    const pushed = new Map<string, ChatmateSuggestion>();
    const load = async () => {
      try {
        const response = await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(activeSid)}/chatmate`, { cache: "no-store" });
        if (!response.ok) throw new Error(`加载失败（${response.status}）`);
        const data = await response.json() as { enabled?: boolean; autoReply?: boolean; customPrompt?: string | null; defaultPrompt?: string; suggestions?: ChatmateSuggestion[] };
        if (!cancelled) {
          const items = new Map((data.suggestions ?? []).map(item => [item.id, item]));
          for (const [id, item] of pushed) items.set(id, item);
          const customPrompt = typeof data.customPrompt === "string" ? data.customPrompt : null;
          const defaultPrompt = typeof data.defaultPrompt === "string" ? data.defaultPrompt : "";
          setChatmateState({ sid: activeSid, enabled: data.enabled === true, autoReply: data.autoReply === true, customPrompt, defaultPrompt, items: [...items.values()].sort((a, b) => a.messageId - b.messageId) });
          setChatmateError("");
        }
      } catch (error) { if (!cancelled) setChatmateError(error instanceof Error ? error.message : "加载失败"); }
    };
    void load();
    const unsubscribe = realtimeClient(basePath).subscribe(activeSid, {
      onEvent: frame => {
        if (cancelled || frame.event !== "chatmate") return;
        const item = frame.data.suggestion as ChatmateSuggestion | undefined;
        if (!item?.id) return;
        pushed.set(item.id, item);
        setChatmateState(current => {
          if (current?.sid !== activeSid) return current;
          return { ...current, enabled: typeof frame.data.enabled === "boolean" ? frame.data.enabled : current.enabled,
            autoReply: typeof frame.data.autoReply === "boolean" ? frame.data.autoReply : current.autoReply,
            items: [...current.items.filter(existing => existing.id !== item.id), item]
            .sort((a, b) => a.messageId - b.messageId) };
        });
      },
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [selectedTab?.key, activeSid, basePath]);
  const setChatmateSettings = async (settings: { enabled?: boolean; autoReply?: boolean; customPrompt?: string | null }) => {
    const response = await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(activeSid)}/chatmate`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(settings),
    });
    if (!response.ok) { setChatmateError(`设置伴聊失败（${response.status}）`); return false; }
    const updated = await response.json() as { enabled?: boolean; autoReply?: boolean; customPrompt?: string | null; defaultPrompt?: string };
    setChatmateState(current => {
      const base = current?.sid === activeSid ? current : { sid: activeSid, enabled: false, autoReply: false, customPrompt: null as string | null, defaultPrompt: "", items: [] as ChatmateSuggestion[] };
      return {
        ...base,
        enabled: updated.enabled ?? base.enabled,
        autoReply: updated.autoReply ?? base.autoReply,
        customPrompt: typeof updated.customPrompt === "string" || updated.customPrompt === null ? (updated.customPrompt ?? null) : base.customPrompt,
        defaultPrompt: typeof updated.defaultPrompt === "string" ? updated.defaultPrompt : base.defaultPrompt,
      };
    });
    setChatmateError("");
    return true;
  };
  /** 保存自定义伴聊提示词；空草稿 = 恢复内置默认。 */
  const saveChatmatePrompt = async () => {
    if (chatmatePromptSaving) return;
    setChatmatePromptSaving(true);
    setChatmatePromptSaved(false);
    const trimmed = chatmatePromptDraft.trim();
    const ok = await setChatmateSettings({ customPrompt: trimmed ? trimmed : null });
    setChatmatePromptSaving(false);
    if (ok) {
      setChatmatePromptSaved(true);
      window.setTimeout(() => setChatmatePromptSaved(false), 2000);
    }
  };
  /** 恢复内置默认：草稿填回内置全文并清空已保存自定义值。 */
  const resetChatmatePrompt = () => {
    const fallback = chatmateState?.defaultPrompt ?? "";
    setChatmatePromptDraft(fallback);
    void setChatmateSettings({ customPrompt: null });
  };
  const setChatmateEnabled = (enabled: boolean) => setChatmateSettings({ enabled });
  const stopChatmate = async (id: string) => {
    const response = await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(activeSid)}/chatmate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }),
    });
    if (!response.ok) { setChatmateError(`停止伴聊失败（${response.status}）`); return; }
    setChatmateState(current => current?.sid === activeSid ? { ...current, items: current.items.map(item => item.id === id ? { ...item, status: "stopped" } : item) } : current);
    setChatmateError("");
  };
  /** 停止某个群 AI 的全部执行会话（快思考/复核/慢思考）。 */
  const stopCoworkAgent = async (agentId: string) => {
    await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(activeSid)}/stop`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId }),
    }).catch(() => undefined);
    setSavedMonologues(current => current?.sid === activeSid
      ? { ...current, items: current.items.map(item => ((item.agentId ?? `${activeSid}:default`) === agentId && (item.status === "running" || item.status === "reviewing")) ? { ...item, status: "stopped" } : item) }
      : current);
  };
  const openChatmate = () => {
    addTab({ key: `chatmate:${activeSid}`, sid: activeSid, kind: "chatmate", title: "伴聊 · Chatmate" });
  };
  // 群容器（开启容器）开关：决定「打开终端」是否可见。仅群会话下查询。
  const [containerEnabled, setContainerEnabled] = useState(false);
  useEffect(() => {
    if (coworkMode !== "group") { setContainerEnabled(false); return; }
    // 先清零再查：避免上一个群的开关状态在请求回来前短暂串到本群。
    setContainerEnabled(false);
    let cancelled = false;
    apiFetch(`${basePath}/api/cowork/${encodeURIComponent(activeSid)}/container`, { method: "GET" })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (!cancelled && data) setContainerEnabled(Boolean(data.containerEnabled)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [basePath, activeSid, coworkMode]);
  const mergedMonologues = [...new Map([...(coworkMonologues ?? []), ...(savedMonologues?.sid === activeSid ? savedMonologues.items : [])].map(item => [item.id, item])).values()];
  const monologueItems = mergedMonologues
    .sort((a, b) => new Date(a.startedAt ?? 0).getTime() - new Date(b.startedAt ?? 0).getTime());
  /** 正在执行（快思考/复核/慢思考）的群 AI：详情页据此显示停止按钮。 */
  const runningAgentIds = new Set(
    monologueItems
      .filter(item => item.status === "running" || item.status === "reviewing")
      .map(item => item.agentId ?? `${activeSid}:default`),
  );
  const latestMonologue = monologueItems.at(-1);
  const monologueScrollVersion = `${monologueItems.length}:${latestMonologue?.id ?? ""}:${latestMonologue?.status ?? ""}:${latestMonologue?.content ?? ""}:${JSON.stringify(latestMonologue?.steps ?? [])}`;
  // 「回到底部」悬浮按钮：群 AI 思考记录与伴聊共用同一滚动容器，用 enabled 区分接管视图。
  // entryKey 跟随当前选中的 agent：切换 AI 视为重新进入，滚动回底部。
  const getRightScroller = useCallback(() => rightBodyRef.current, [rightBodyRef]);
  const getRightContent = useCallback(() => rightBodyRef.current?.querySelector(".cowork-monologues") ?? null, [rightBodyRef]);
  const chatmateJump = useBottomJump({
    enabled: selectedTab?.kind === "chatmate",
    entryKey: selectedTab?.kind === "chatmate" ? selectedTab.key : "",
    version: JSON.stringify(chatmateState?.items ?? []),
    getScroller: getRightScroller,
    getContent: getRightContent,
  });
  const monologueJump = useBottomJump({
    enabled: selectedTab?.kind === "monologue",
    entryKey: monologueAgentId ?? "",
    version: monologueScrollVersion,
    getScroller: getRightScroller,
    getContent: getRightContent,
  });
  const activeSurface = selectedTab?.kind === "surface" ? selectedTab.surface : null;
  const shownPreview = selectedTab?.kind === "artifact" ? { sid: selectedTab.sid, meta: selectedTab.meta } : null;
  const watchedArtifactUrl = rightShown && shownPreview && shownPreview.meta.type !== "browser" && shownPreview.sid === activeSid
    ? `${buildArtifactUrl(shownPreview.meta.id)}&watch=1` : null;
  useEffect(() => {
    if (!watchedArtifactUrl) return;
    const source = new EventSource(watchedArtifactUrl, { withCredentials: true });
    source.addEventListener("change", () => {
      setPreviewReloadKey((key) => key + 1);
      void refreshArtifactList(activeSid, true);
    });
    return () => source.close();
    // URL uniquely identifies the selected file; callback identity changes on each parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedArtifactUrl]);
  const shownInput = selectedTab?.kind === "input" ? selectedTab.file : null;
  const shownDiff = selectedTab?.kind === "changes" ? { sid: selectedTab.sid, activeId: selectedTab.activeId } : null;
  const activeJob = selectedTab?.kind || "chooser";
  // 终端常驻：只要存在终端标签页就保持挂载（切到别的 tab / 切到别的会话都只隐藏、不卸载），
  // 否则每次都要销毁 xterm 缓冲 + 断开 WS，回来时滚屏/输出全丢。
  const terminalTabs = tabs.filter((tab) => tab.kind === "terminal");
  const closeTabs = (keys: string[]) => {
    const removed = new Set(keys);
    const closing = tabs.filter((tab) => removed.has(tab.key));
    if (mobilePage === "artifacts" && closing.some(tab => tab.kind === "artifact" && tab.key === activeTabKey)) onMobileBack?.();
    const remaining = tabs.filter((tab) => !removed.has(tab.key));
    setTabs(remaining);
    const sessionRemaining = remaining.filter(tab => tab.sid === activeSid);
    const nextHistory = (historyBySid[activeSid] ?? []).filter(key => !removed.has(key));
    setHistoryBySid(current => ({ ...current, [activeSid]: (current[activeSid] ?? []).filter(key => !removed.has(key)) }));
    if (activeTabKey && removed.has(activeTabKey)) {
      const next = mobilePage === "artifacts" ? sessionRemaining.find(tab => tab.kind === "files")?.key :
        [...nextHistory].reverse().find(key => sessionRemaining.some(tab => tab.key === key));
      setActiveTabKey(next ?? sessionRemaining.at(-1)?.key ?? null);
      setPreviewFull(false);
    }
    if (closing.some(tab => tab.kind === "artifact" && preview?.sid === tab.sid && preview.meta.id === tab.meta.id)) setPreview(null);
    if (closing.some(tab => tab.kind === "input" && inputFilePreview?.url === tab.file.url)) setInputFilePreview(null);
    if (closing.some(tab => tab.kind === "changes" && diffView?.sid === tab.sid)) setDiffView(null);
    if (closing.some(tab => tab.kind === "surface" && workSurface === tab.surface)) closeWorkSurface();
    setTabMenu(null);
  };
  const closeTab = (key: string) => closeTabs([key]);
  const openArtifactTab = (meta: ArtifactMeta) => {
    addTab({ key: `artifact:${activeSid}:${meta.id}`, sid: activeSid, kind: "artifact", title: meta.name.split("/").pop() || meta.name, meta });
    setPreviewFull(false);
  };
  const moveTab = (sourceKey: string, targetKey: string) => {
    if (sourceKey === targetKey) return;
    setTabs(current => {
      const source = current.findIndex(tab => tab.key === sourceKey && tab.sid === activeSid);
      const target = current.findIndex(tab => tab.key === targetKey && tab.sid === activeSid);
      if (source < 0 || target < 0) return current;
      const next = [...current];
      const [moved] = next.splice(source, 1);
      next.splice(target, 0, moved);
      return next;
    });
  };
  const openBrowser = () => addTab({ key: `browser-page:${activeSid}:${++nextTabId.current}`, sid: activeSid, kind: "surface", title: "浏览器", surface: { kind: "website", id: `browser-page:${nextTabId.current}`, title: "浏览器", sessionId: activeSid }, history: [], historyIndex: -1, reloadKey: 0 }, false);
  useEffect(() => {
    if (!desktopApp) return;
    const onOpenChatLink = (event: Event) => {
      const { url, sid } = (event as CustomEvent<{ url: string; sid: string }>).detail ?? {};
      if (!url || sid !== activeSid) return;
      const existing = tabs.find((tab) => tab.sid === sid && tab.kind === "surface" && tab.surface.kind === "website" && (tab.surface.url === url || browserStates[tab.key]?.url === url));
      if (existing) { setActiveTabKey(existing.key); return; }
      const id = ++nextTabId.current;
      const title = new URL(url).hostname;
      const key = `browser-page:${sid}:${id}`;
      addTab({ key, sid, kind: "surface", title, surface: { kind: "website", id: `browser-page:${id}`, title, sessionId: sid, url }, history: [url], historyIndex: 0, reloadKey: 0 });
      setAddressDrafts((current) => ({ ...current, [key]: url }));
    };
    window.addEventListener(CHAT_LINK_OPEN_EVENT, onOpenChatLink);
    return () => window.removeEventListener(CHAT_LINK_OPEN_EVENT, onOpenChatLink);
  }, [activeSid, desktopApp, tabs, browserStates]);
  const navigateBrowser = (tab: Extract<WorkTab, { kind: "surface" }>) => {
    const raw = (addressDrafts[tab.key] ?? tab.surface.url ?? "").trim();
    let url: URL;
    try { url = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { setAddressError(tab.key); return; }
    if (!["http:", "https:"].includes(url.protocol)) { setAddressError(tab.key); return; }
    setTabs((current) => current.map((item) => item.key === tab.key && item.kind === "surface" ? { ...item, title: url.hostname, surface: { ...item.surface, url: url.href, title: url.hostname }, history: [...item.history.slice(0, item.historyIndex + 1), url.href], historyIndex: item.historyIndex + 1 } : item));
    setAddressDrafts((current) => ({ ...current, [tab.key]: url.href }));
    setAddressError(null);
  };
  const moveBrowser = (tab: Extract<WorkTab, { kind: "surface" }>, index: number) => {
    const url = tab.history[index];
    if (!url) return;
    setTabs((current) => current.map((item) => item.key === tab.key && item.kind === "surface" ? { ...item, title: new URL(url).hostname, surface: { ...item.surface, url, title: new URL(url).hostname }, historyIndex: index } : item));
    setAddressDrafts((current) => ({ ...current, [tab.key]: url }));
  };
  // 右栏按 CSS order 显示输出产物和输入文件；状态与请求由 AgentWindow 管理。
  return (<>
      <aside
        className={`chat-right chat-pane-right${rightShown ? " is-open" : ""}${rightDragging ? " is-dragging" : ""}${previewHeadShown ? " is-top-hover" : ""}`}
        onMouseMove={(event) => { if (previewFull) { const y = event.clientY - event.currentTarget.getBoundingClientRect().top; if (y <= 12) setPreviewHeadShown(true); else if (y > 70) setPreviewHeadShown(false); } }}
        onMouseLeave={() => setPreviewHeadShown(false)}
        aria-hidden={!rightShown}
        style={rightW ? ({ "--right-w": `${rightW}px` } as React.CSSProperties) : undefined}
      >
        {/* 中/右栏之间的拖拽 resizer：hover 时 dim-in 显现，拖动实时改宽 */}
        {rightShown ? (
          <div
            className="chat-resizer"
            onPointerDown={onResizeStart}
            onPointerMove={onResizeMove}
            onPointerUp={onResizeEnd}
            onPointerCancel={onResizeEnd}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("resizeRight")}
          />
        ) : null}
        <div className="chat-right-inner">
          <MobileWorkPageContainer page={mobilePage} previewTitle={mobileArtifactPreviewActive ? selectedTab?.title : undefined} onBack={onMobileBack}>
          <div className="work-panel-tabs" role="tablist" aria-label={t("workTabs")} ref={tabStripRef}>
            {sessionTabs.map((tab) => <div className={`work-panel-tab-wrap${selectedTab?.key === tab.key ? " is-active" : ""}`} key={tab.key}
              draggable
              onDragStart={(event) => { draggedTabKey.current = tab.key; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", tab.key); }}
              onDragOver={(event) => { if (draggedTabKey.current && draggedTabKey.current !== tab.key) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
              onDrop={(event) => { event.preventDefault(); if (draggedTabKey.current) moveTab(draggedTabKey.current, tab.key); draggedTabKey.current = null; }}
              onDragEnd={() => { draggedTabKey.current = null; }}
              onContextMenu={(event) => { event.preventDefault(); setTabMenu({ key: tab.key, x: event.clientX, y: event.clientY }); }}>
              <button type="button" role="tab" aria-selected={selectedTab?.key === tab.key} className="work-panel-tab" title={tab.title} onClick={() => { setActiveTabKey(tab.key); setPreviewFull(false); }} onDoubleClick={() => { setActiveTabKey(tab.key); setPreviewHeadShown(false); setPreviewFull((v) => !v); }}><span className="work-panel-tab-icon" aria-hidden="true">{tab.kind === "surface" && tab.surface.presentation === "app" && tab.surface.iconUrl ? <img src={tab.surface.iconUrl} alt="" /> : tab.kind === "surface" && tab.surface.kind === "website" && tab.surface.presentation !== "app" || tab.kind === "artifact" && tab.meta.type === "browser" ? <BrowserGlobeIcon /> : tab.kind === "files" ? <ArtifactsFolderIcon /> : tab.kind === "inputs" ? <UploadIcon /> : tab.kind === "chatmate" ? <ChatmateBubbleIcon /> : tab.kind === "monologue" ? <SparkleOutlineIcon /> : tab.kind === "artifact" ? <ArtifactIcon type={tab.meta.type} /> : tab.kind === "input" ? <FileTypeIcon name={tab.file?.name ?? tab.title} kind={tab.file?.type} /> : tab.kind === "terminal" ? <TerminalIcon /> : tab.kind === "changes" ? "±" : "▧"}</span>{tab.title}</button>
              <button type="button" className="work-panel-tab-close" onClick={() => closeTab(tab.key)} aria-label={t("closeTabNamed", { title: tab.title })} title={t("closeTab")}>×</button>
            </div>)}
            <button type="button" className="work-panel-add" aria-label={t("newWork")} title={t("newWork")} onClick={() => { setActiveTabKey(null); setPreviewFull(false); }}>+</button>
          </div>
          {tabMenu && sessionTabs.some(tab => tab.key === tabMenu.key) ? createPortal(
            <div className="work-panel-tab-menu" role="menu" style={{ left: Math.min(tabMenu.x, window.innerWidth - 160), top: Math.min(tabMenu.y, window.innerHeight - 120) }}>
              <button type="button" role="menuitem" onClick={() => closeTabs(sessionTabs.map(tab => tab.key))}>{t("closeAll")}</button>
              <button type="button" role="menuitem" onClick={() => closeTabs(sessionTabs.filter(tab => tab.key !== tabMenu.key).map(tab => tab.key))}>{t("closeOthers")}</button>
              <button type="button" role="menuitem" onClick={() => { const index = sessionTabs.findIndex(tab => tab.key === tabMenu.key); closeTabs(sessionTabs.slice(index + 1).map(tab => tab.key)); }}>{t("closeRight")}</button>
            </div>, document.body) : null}
          {activeJob === "inputs" ? (
            <section className="chat-right-section chat-right-section--inputs">
              {/* 无标题栏：列表直接从顶部开始排 */}
              <div className="chat-right-section-body">
                {inputFiles.length === 0 ? <div className="chat-right-empty">{t("noUploads")}</div> : inputFiles.map((f) => (
                  <div className="chat-right-file" key={f.url}>
                    <a
                      className="chat-right-file-main"
                      href={desktopApp ? undefined : resolveFileUrl(f.url, f.fileId)}
                      target={desktopApp ? undefined : "_blank"}
                      rel="noreferrer"
                      title={f.name}
                      onClick={(e) => {
                        // Web 与 Electron 统一：左键点击都走应用内处理（md/html 右栏预览、图片全屏预览、其余下载）
                        e.preventDefault();
                        openInputFile(f);
                      }}
                    >
                      <span className="artifact-card-icon" aria-hidden="true">
                        {f.kind === "folder" ? <FolderIcon /> : <ArtifactIcon type={fileArtifactType(f)} />}
                      </span>
                      <span className="chat-right-file-info">
                        <span className="chat-right-file-name">{f.name}</span>
                        <span className="chat-right-file-meta">
                          {f.kind === "folder" ? "文件夹" : f.size != null ? formatFileSize(f.size) : ""}
                        </span>
                      </span>
                    </a>
                    {typeof f.messageId === "number" ? (
                      <button
                        type="button"
                        className="chat-right-file-locate"
                        title={t("locateUpload")}
                        aria-label={t("locateUpload")}
                        onClick={() => { if (typeof f.messageId === "number") onJumpToMessage?.(f.messageId); }}
                      >
                        <LocateGlyph />
                      </button>
                    ) : null}
                    {desktopApp ? isLocalReference(f.url) ? (
                      <button type="button" className="chat-right-file-dl" title={t("revealFolder")} aria-label={t("revealNamed", { name: f.name })} onClick={() => revealInputFile(f)}>
                        <RevealInFolderIcon />
                      </button>
                    ) : null : (
                      <a className="chat-right-file-dl" href={`${resolveFileUrl(f.url, f.fileId)}&download=1`} download={f.name} title={t("download")} aria-label={t("download")}>
                        <OperationPanelGlyph08 />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
          {/* 上传文件与输出产物已拆成两个标签页，二者互斥渲染：
              查看上传文件（activeJob === "inputs"）时不渲染产物区，避免同屏上下分段 */}
          {activeJob !== "inputs" ? (
          <section className={`chat-right-section chat-right-section--outputs is-work-content${activeJob === "chatmate" ? " is-chatmate" : ""}${activeJob === "terminal" ? " is-hidden" : ""}`}>
            <div className="chat-right-section-body" ref={rightBodyRef}>
              {sessionTabs.filter((tab): tab is Extract<WorkTab, { kind: "surface" }> => tab.kind === "surface").map((tab) => (
                <div className="chat-right-preview" key={tab.key} style={{ display: selectedTab?.key === tab.key ? undefined : "none" }}>
                  {tab.surface.kind === "website" && tab.surface.presentation !== "app" ? <form className="work-browser-toolbar" onSubmit={(event) => { event.preventDefault(); navigateBrowser(tab); }}>
                    <button type="button" aria-label={t("back")} title={t("back")} disabled={desktopApp ? !browserStates[tab.key]?.back : tab.historyIndex <= 0} onClick={() => desktopApp ? browserViews.current[tab.key]?.goBack() : moveBrowser(tab, tab.historyIndex - 1)}>‹</button>
                    <button type="button" aria-label={t("forward")} title={t("forward")} disabled={desktopApp ? !browserStates[tab.key]?.forward : tab.historyIndex >= tab.history.length - 1} onClick={() => desktopApp ? browserViews.current[tab.key]?.goForward() : moveBrowser(tab, tab.historyIndex + 1)}>›</button>
                    {desktopApp && browserStates[tab.key]?.loading ? <span className="work-browser-loading" role="status" aria-label={t("loadingNow")} /> : null}
                    <input aria-label={t("webAddress")} aria-invalid={addressError === tab.key} placeholder={t("enterAddress")} value={addressDrafts[tab.key] ?? tab.surface.url ?? ""} onChange={(event) => { setAddressDrafts((current) => ({ ...current, [tab.key]: event.target.value })); setAddressError(null); }} />
                    <button type="button" aria-label={desktopApp && browserStates[tab.key]?.loading ? "停止加载" : "刷新"} title={desktopApp && browserStates[tab.key]?.loading ? "停止加载" : "刷新"} disabled={!tab.surface.url} onClick={() => desktopApp ? browserStates[tab.key]?.loading ? browserViews.current[tab.key]?.stop() : browserViews.current[tab.key]?.reload() : setTabs((current) => current.map((item) => item.key === tab.key && item.kind === "surface" ? { ...item, reloadKey: item.reloadKey + 1 } : item))}>{desktopApp && browserStates[tab.key]?.loading ? "×" : <RefreshIcon />}</button>
                    {tab.surface.url ? <a href={desktopApp ? browserStates[tab.key]?.url || tab.surface.url : tab.surface.url} target="_blank" rel="noopener noreferrer" title={t("openNewWindow")} aria-label={t("openNewWindow")}>↗</a> : null}
                  </form> : null}
                  <div className="chat-right-preview-frame">
                    {tab.surface.url ? desktopApp && tab.surface.kind === "website" && tab.surface.presentation !== "app"
                      ? <webview key={`${tab.key}:${tab.reloadKey}`} ref={(element) => bindBrowserView(tab.key, element)} className="artifact-frame mini-browser-webview" src={tab.surface.url} title={tab.title} />
                      : <iframe key={`${tab.key}:${tab.reloadKey}`} className="artifact-frame" src={tab.surface.url} title={tab.title} referrerPolicy="strict-origin-when-cross-origin" allow="clipboard-read; clipboard-write" /> : tab.surface.kind === "app" ? renderApp?.(tab.surface.id) : null}
                    {desktopApp && browserStates[tab.key]?.error ? <div className="work-browser-error" role="alert">无法打开网页：{browserStates[tab.key].error}</div> : null}
                  </div>
                </div>
              ))}
              {/* 群 AI 管理器常驻挂载：切到产物等其他 tab 再切回时保留详情/设置状态，不退回列表；仅群聊挂载 */}
              {coworkMode === "group" ? (
              <div className={selectedTab?.kind === "monologue" ? "cowork-persist" : "cowork-persist is-hidden"}>
                <CoworkAgentsManager basePath={basePath} sessionId={activeSid} onAgentChange={setMonologueAgentId} runningAgentIds={runningAgentIds} onStopAgent={stopCoworkAgent} renderMonologues={agentId => <div className="cowork-monologues" aria-live="polite">
                  {monologueItems.filter(item => (item.agentId ?? `${activeSid}:default`) === agentId).length ? monologueItems.filter(item => (item.agentId ?? `${activeSid}:default`) === agentId).map(item => <div className="cowork-monologue" key={item.id}>
                    <div className="cowork-monologue-head"><span className="cowork-monologue-tag">{fastThoughtTag(item)}</span><time dateTime={item.startedAt} title={item.startedAt ? new Date(item.startedAt).toLocaleString() : undefined}>{relativeTime(item.startedAt)}</time></div>
                    <div className="msg bot"><AiResponse scene="group" steps={item.steps} elapsedSecs={item.elapsedSecs} startedAt={item.startedAt} running={item.status === "running" || item.status === "reviewing"} basePath={basePath} content={fastThoughtText(item)} /></div>
                    {item.error ? <div className="artifact-err">{item.error}</div> : null}
                  </div>) : <div className="chat-right-empty">{monologueError || "暂无群 AI 记录"}</div>}
                </div>} />
              </div>
              ) : null}
              {activeSurface ? null : shownInput ? (
                <div className="chat-right-preview">
                  <div className="artifact-menu-bar chat-right-preview-head">
                    <span className="artifact-drawer-title">{shownInput.name}</span>
                    <div className="artifact-menu-actions">
                      <button
                        type="button"
                        className="artifact-drawer-full"
                        onClick={() => { setPreviewHeadShown(false); setPreviewFull((v) => !v); }}
                        title={previewFull ? "退出全屏预览" : "全屏预览"}
                        aria-label={previewFull ? "退出全屏预览" : "全屏预览"}
                      >
                        {previewFull ? (
                          /* 退出全屏：右上、左下两角向内收 */
                          <OperationPanelGlyph10 />
                        ) : (
                          /* 全屏：右上、左下两角向外展开 */
                          <OperationPanelGlyph11 />
                        )}
                      </button>
                      <a className="artifact-drawer-close" href={`${shownInput.url}${shownInput.url.includes("?") ? "&" : "?"}download=1`} download={shownInput.name}
                        title={t("downloadFile")} aria-label={t("downloadFile")} onClick={desktopApp ? event => { event.preventDefault(); desktopDownload(shownInput); } : undefined}>
                        <OperationPanelGlyph08 />
                      </a>
                      <button
                        type="button"
                        className="artifact-drawer-close"
                        onClick={() => selectedTab && closeTab(selectedTab.key)}
                        aria-label={t("closeInputPreview")}
                      >
                        <OperationPanelGlyph09 />
                      </button>
                    </div>
                  </div>
                  <div className="chat-right-preview-frame">
                    {/* url 必须经 resolveFileUrl 解析（拼 basePath 指向文件服务路由）：
                        直接 fetch f.url 的相对路径会被宿主 SPA fallback 拦成应用入口 HTML */}
                    <FilePreviewContent url={resolveFileUrl(shownInput.url)} name={shownInput.name} type={shownInput.type} />
                  </div>
                </div>
              ) : /* 变更 diff 视图（「查看所有变更」按钮打开）：优先于单文件预览与产物列表 */
              shownDiff ? (
                <ArtifactDiffPanel
                  changes={sessionChanges}
                  activeId={shownDiff.activeId}
                  onSelect={(id) => { setTabs((current) => current.map((tab) => tab.key === selectedTab?.key && tab.kind === "changes" ? { ...tab, activeId: id } : tab)); setDiffView((d) => (d ? { ...d, activeId: id } : d)); }}
                  onClose={() => selectedTab && closeTab(selectedTab.key)}
                />
              ) : /* 预览绑定会话：preview.sid 与当前会话不一致时（切换会话后残留）不渲染、不发请求 */
              shownPreview ? (
                <div className="chat-right-preview">
                  <div className="artifact-menu-bar chat-right-preview-head">
                    <span className="artifact-drawer-title">{shownPreview.meta.name}</span>
                    <div className="artifact-menu-actions">
                      {shownPreview.meta.type === "browser" ? null : <button type="button" className="artifact-drawer-full" title={t("share")} aria-label={t("shareArtifact")} onClick={() => onShareArtifact(shownPreview.meta)}><ChatPanelGlyph04 /></button>}
                      <button
                        type="button"
                        className="artifact-drawer-full"
                        onClick={() => setPreviewReloadKey((k) => k + 1)}
                        title={t("refreshLatest")}
                        aria-label={t("refreshPreview")}
                      >
                        <RefreshIcon />
                      </button>
                      <button
                        type="button"
                        className="artifact-drawer-full"
                        onClick={() => { setPreviewHeadShown(false); setPreviewFull((v) => !v); }}
                        title={previewFull ? "退出全屏预览" : "全屏预览"}
                        aria-label={previewFull ? "退出全屏预览" : "全屏预览"}
                      >
                        {previewFull ? (
                          /* 退出全屏：右上、左下两角向内收 */
                          <OperationPanelGlyph10 />
                        ) : (
                          /* 全屏：右上、左下两角向外展开 */
                          <OperationPanelGlyph11 />
                        )}
                      </button>
                      {shownPreview.meta.type === "browser" ? null : (
                        <a
                          className="artifact-menu-dl"
                          href={`${buildArtifactUrl(shownPreview.meta.id)}&download=1`}
                          title={t("download")}
                          aria-label={t("download")}
                        >
                          <OperationPanelGlyph08 />
                        </a>
                      )}
                      <button
                        type="button"
                        className="artifact-drawer-close"
                        onClick={() => selectedTab && closeTab(selectedTab.key)}
                        aria-label={t("closePreview")}
                      >
                        <OperationPanelGlyph09 />
                      </button>
                    </div>
                  </div>
                  <div className="chat-right-preview-frame">
                    {shownPreview.meta.type === "browser" ? (
                      browserShot ? (
                        <div className="artifact-browser-live">
                          <img
                            className="artifact-img artifact-img--clickable"
                            src={`data:image/jpeg;base64,${browserShot}`}
                            alt={shownPreview.meta.name}
                            onClick={handleBrowserShotClick}
                            title={cdpPort ? "点击画面 = 在 AI 操作的浏览器里点击该位置" : "浏览器预览（等待 CDP 连接…）"}
                          />
                          <span className="artifact-browser-tip">
                            {cdpPort ? "实时联动：点击画面即可操控 AI 正在操作的浏览器" : "浏览器运行中…"}
                          </span>
                        </div>
                      ) : (
                        <div className="artifact-other-hint">{t("browserPreviewHint")}</div>
                      )
                    ) : <FilePreviewContent key={previewReloadKey} url={`${buildArtifactUrl(shownPreview.meta.id)}&t=${previewReloadKey}`} name={shownPreview.meta.name} type={shownPreview.meta.type} />}
                  </div>
                </div>
              ) : selectedTab?.kind === "chatmate" ? (
                <div className="cowork-monologues" aria-live="polite">
                  <div className="chatmate-controls">
                    <span className="chatmate-status">
                      <span>{chatmateState?.sid === activeSid && chatmateState.enabled ? (chatmateAutoReply ? t("chatmateEnabledAuto") : t("chatmateEnabled")) : t("chatmateDisabled")}</span>
                      {chatmateAutoReply ? (
                        <span className="chatmate-status-warn msg-menu-tip" role="img" aria-label={t("autoReplyWarning")} tabIndex={0} data-tooltip={t("autoReplyTooltip")}>!</span>
                      ) : null}
                    </span>
                    <div className="chatmate-controls-right">
                      <button
                        type="button"
                        className="chat-tool msg-menu-tip chatmate-enhance-btn"
                        onClick={() => void handleChatmateEnhance()}
                        disabled={chatmateEnhanceBusy || chatmateRunning}
                        data-tooltip={chatmateEnhanceBusy ? t("busy") : chatmateRunning ? t("chatmateBusy") : t("chatmateEnhance")}
                        aria-label={t("enhancePrompt")}
                        aria-busy={chatmateEnhanceBusy}
                      >
                        {chatmateEnhanceBusy ? <span className="chat-voice-spinner" aria-hidden="true" /> : <EnhanceIcon />}
                      </button>
                      <button type="button" className="chatmate-settings-btn" aria-label={t("chatmateSettings")} title={t("chatmateSettings")} aria-expanded={chatmateSettingsOpen} onClick={() => setChatmateSettingsOpen(current => !current)}><SettingsIcon /></button>
                      {chatmateSettingsOpen ? (
                        <div className="chatmate-settings-popup" role="dialog" aria-label={t("chatmateSettings")}>
                          <div className="chatmate-settings-title">{t("chatmateSettings")}</div>
                          <div className="chatmate-settings-item">
                            <span className="chatmate-settings-label">
                              <span>{t("enableChatmate")}</span>
                              <span className="chatmate-settings-hint">{t("chatmateDescription")}</span>
                            </span>
                            <button type="button" className="chatmate-switch" role="switch" aria-label={t("enableChatmate")} aria-checked={chatmateState?.sid === activeSid && chatmateState.enabled} onClick={toggleChatmateEnabled}><span className="chatmate-switch-thumb" /></button>
                          </div>
                          <div className="chatmate-settings-item">
                            <span className="chatmate-settings-label">
                              <span>{t("autoReply")}</span>
                              <span className="chatmate-settings-hint">{t("autoReplyDescription")}</span>
                            </span>
                            <button type="button" className="chatmate-switch" role="switch" aria-label={t("autoReply")} aria-checked={chatmateAutoReply} onClick={toggleChatmateAutoReply}><span className="chatmate-switch-thumb" /></button>
                          </div>
                          <div className="chatmate-prompt-block">
                            <div className="chatmate-prompt-head">
                              <span className="chatmate-prompt-title">{t("chatmatePrompt")}</span>
                              <span className="chatmate-prompt-hint">自定义伴聊的人设、语气与发言规则，按本群×你独立保存；留空保存即恢复内置默认。可用 ${'${name}'} 代表你自己。</span>
                            </div>
                            <textarea
                              className="chatmate-prompt-textarea"
                              aria-label={t("chatmatePrompt")}
                              value={chatmatePromptDraft}
                              onChange={event => setChatmatePromptDraft(event.target.value)}
                              placeholder={t("enterChatmatePrompt")}
                              spellCheck={false}
                            />
                            <div className="chatmate-prompt-actions">
                              <button type="button" className="chatmate-prompt-btn chatmate-prompt-btn--reset" onClick={resetChatmatePrompt} disabled={chatmatePromptSaving}>{t("resetDefaults")}</button>
                              <button type="button" className="chatmate-prompt-btn chatmate-prompt-btn--save" onClick={() => void saveChatmatePrompt()} disabled={chatmatePromptSaving}>
                                {chatmatePromptSaving ? "保存中…" : "保存"}
                              </button>
                            </div>
                            {chatmatePromptSaved ? <div className="chatmate-prompt-saved" role="status">{t("saved")}</div> : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {chatmateEnhanceError ? <p className="artifact-err" role="alert">{chatmateEnhanceError}</p> : null}
                  {(chatmateState?.sid === activeSid ? chatmateState.items : []).length ? chatmateState!.items.map(item => <div className="cowork-monologue" key={item.id}>
                    <div className="cowork-monologue-head"><span className="cowork-monologue-tag">{item.senderName || t("member")}</span><time dateTime={item.startedAt}>{relativeTime(item.startedAt)}</time>{item.status === "running" ? <button type="button" className="chat-send chat-send--stop chatmate-stop" aria-label={t("stopChatmate")} title={t("stopGeneration")} onClick={() => void stopChatmate(item.id)}><ChatPanelGlyph34 /></button> : item.status === "stopped" ? <span className="chatmate-stopped">{t("stopped")}</span> : null}</div>
                    {item.status !== "error" || item.reasoning || item.steps?.length ? <div className="msg bot"><AiResponse scene="direct" steps={item.steps?.map(step => ({ ...step, text: "" }))} elapsedSecs={item.elapsedSecs} startedAt={item.startedAt} running={item.status === "running"} basePath={basePath} content=""
                      browserAskText={chatmateBrowserAnswer} onBrowserAskText={setChatmateBrowserAnswer}
                      onBrowserAnswer={(browserId, text) => { void apiFetch(`${basePath}/api/chat/browser-answer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: browserId, text, chatSessionId: activeSid }) }); }} /></div> : null}
                    {item.status === "done" && item.reasoning?.trim() ? <div className="chatmate-reasoning-text">{item.reasoning}</div> : null}
                    {item.tasks?.length ? <div className="chatmate-reasoning-text">{item.tasks.map((task, index) => <div key={`${item.id}:${index}`}>{index + 1}. {task.title} · {task.status === "done" ? "已完成" : task.status === "running" ? "进行中" : task.status === "error" ? "失败" : task.status === "blocked" ? "信息不足，已停止" : task.status === "skipped" ? "已跳过" : "待处理"}{task.result ? <div>{task.result}</div> : null}{task.error ? <div>{task.error}</div> : null}</div>)}</div> : null}
                    {item.status === "done" && item.blocker ? <div className="chatmate-reasoning-text">{item.blocker.decision === "ask_group" ? "需要群内补充信息，本轮任务已暂停。" : "现有信息不足，已停止本轮任务。"} {item.blocker.reason}</div> : null}
                    {item.status === "done" && item.reaction && !chatmateAutoReply ? <div className="chatmate-actions"><button type="button" onClick={() => void realtimeClient(basePath).request(activeSid, "reaction", { messageId: item.reaction!.messageId, emoji: item.reaction!.emoji })}>给对方消息回应 {item.reaction.emoji}</button></div> : null}
                    {item.status === "done" && item.draftText?.trim() ? <div className="chatmate-reply"><div className="chatmate-reply-text">{item.draftText}</div>{chatmateAutoReply ? null : <div className="chatmate-actions"><button type="button" onClick={() => window.dispatchEvent(new CustomEvent(CHATMATE_ADOPT_EVENT, { detail: { sessionId: activeSid, text: item.draftText } }))}>{t("adopt")}</button></div>}</div> : null}
                    {item.status === "error" ? <div className="artifact-err">{item.error || "伴聊生成中断"}</div> : null}
                  </div>) : <div className="chat-right-empty">{chatmateError || (chatmateState?.sid === activeSid && chatmateState.enabled ? "已开启，等待群内新消息" : "开启后，伴聊会根据新消息提供私密回复建议")}</div>}
                </div>
              ) : selectedTab?.kind === "monologue" ? (
                /* 群 AI 管理器常驻挂载在上方（切 tab 不卸载、保留详情状态），这里不再重复渲染 */
                null
              ) : !selectedTab ? (
                <div className="work-panel-chooser">
                  {!hideFileChoices ? <>
                    <button type="button" className="work-panel-choice" onClick={() => addTab({ key: `files:${activeSid}`, sid: activeSid, kind: "files", title: "输出产物" })}><span className="work-panel-choice-icon"><ArtifactsFolderIcon /></span><span>{t("viewOutputs")}</span></button>
                    <button type="button" className="work-panel-choice" onClick={() => addTab({ key: `inputs:${activeSid}`, sid: activeSid, kind: "inputs", title: "上传文件" })}><span className="work-panel-choice-icon"><UploadIcon /></span><span>{t("viewUploads")}</span></button>
                  </> : null}
                  <button type="button" className="work-panel-choice" onClick={openBrowser}><span className="work-panel-choice-icon"><BrowserGlobeIcon /></span><span>{t("openBrowserTool")}</span></button>
                  {coworkMode && containerEnabled ? <button type="button" className="work-panel-choice" onClick={() => addTab({ key: `terminal:${activeSid}`, sid: activeSid, kind: "terminal", title: "终端" })}><span className="work-panel-choice-icon"><TerminalIcon /></span><span>{t("openTerminal")}</span></button> : null}
                  {coworkMode ? <button type="button" className="work-panel-choice" onClick={() => addTab({ key: `monologue:${activeSid}`, sid: activeSid, kind: "monologue", title: "群 AI" })}><span className="work-panel-choice-icon"><SparkleOutlineIcon /></span><span>{t("groupAi")}</span></button> : null}
                  {coworkMode ? <button type="button" className="work-panel-choice" onClick={openChatmate}><span className="work-panel-choice-icon"><ChatmateBubbleIcon /></span><span>{t("chatmate")}</span></button> : null}
                </div>
              ) : activeJob === "files" ? (              <ArtifactFileManager
                artifacts={artifactLists[activeSid] ?? []}
                loading={!Array.isArray(artifactLists[activeSid])}
                error={Boolean(artifactLoadErrors[activeSid] && !artifactLists[activeSid]?.length)}
                onRetry={() => refreshArtifactList(activeSid)}
                onRefresh={() => refreshArtifactList(activeSid, true)}
                buildUrl={buildArtifactUrl}
                previewFull={previewFull}
                onToggleFullscreen={() => setPreviewFull((v) => !v)}
                desktopApp={desktopApp}
                onOpenDir={(dir) => void openArtifactFileDir(dir)}
                onShareArtifact={onShareArtifact}
                onZipFolder={onZipFolder}
                onRenameArtifact={onRenameArtifact}
                onMoveArtifact={onMoveArtifact}
                onDeleteArtifact={onDeleteArtifact}
                onCreateFolder={onCreateFolder}
                sessionId={activeSid}
                initialDir={fileDirsBySid[activeSid] ?? ""}
                onDirectoryChange={(dir) => setFileDirsBySid(current => current[activeSid] === dir ? current : { ...current, [activeSid]: dir })}
                onMobilePreview={onMobileArtifactPreview}
                onOpenFile={openArtifactTab}
                mobilePage={mobilePage}
              />
              ) : null}
            </div>
            {selectedTab?.kind === "chatmate" && chatmateJump.showJump ? <div className="chatmate-bottom-overlay">
              <div className="chat-body-fade" aria-hidden="true" />
              <button type="button" className={`chat-bottom-btn${chatmateJump.live ? " is-live" : ""}`} aria-label={t("backToBottom")} onClick={chatmateJump.jumpToBottom}><ChatPanelGlyph21 /></button>
            </div> : null}
            {selectedTab?.kind === "monologue" && monologueJump.showJump ? <div className="chatmate-bottom-overlay">
              <div className="chat-body-fade" aria-hidden="true" />
              <button type="button" className={`chat-bottom-btn${monologueJump.live ? " is-live" : ""}`} aria-label={t("backToBottom")} onClick={monologueJump.jumpToBottom}><ChatPanelGlyph21 /></button>
            </div> : null}
          </section>
          ) : null}
          {/* 终端常驻挂载：切到其他 tab（含"上传文件"这类会整块替换的 tab）、甚至切到别的会话，
              都只隐藏、不卸载，从而保住 xterm 的滚屏缓冲与后端 PTY 连接；只有关掉终端标签页才会销毁。 */}
          {terminalTabs.map((tab) => {
            const isActive = selectedTab?.key === tab.key;
            return (
              <div key={tab.key} className={isActive ? "terminal-persist" : "terminal-persist is-hidden"}>
                <TerminalPanel basePath={basePath} sessionId={tab.sid} hostLabel={terminalHost} active={isActive} />
              </div>
            );
          })}
          </MobileWorkPageContainer>
        </div>
      </aside>
  </>);
}
