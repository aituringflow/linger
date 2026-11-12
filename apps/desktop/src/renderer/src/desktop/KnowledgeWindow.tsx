import { useCallback, useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import type * as React from "react";
import { createPortal } from "react-dom";
import { SettingsIcon, EditIcon, DeleteIcon, NavigationChevronIcon, FolderIcon, RefreshIcon } from "@turingflow/agent-kit/ui";
import { wallpaperSkinId } from "../wallpapers";
import { localFileUrl } from "../localFile";
import { useLauncher } from "../state";
import WindowFrame, { clearSavedWindowGeometry } from "../dock/WindowFrame";
import type { KnowledgeChunk, KnowledgeFileKind, KnowledgeFileListItem, KnowledgeFileSort, KnowledgeFileStatusFilter, KnowledgeFrameworkModels, KnowledgeImageModel, KnowledgeIndexProgress, KnowledgeModelStatus, KnowledgeModelInfo, KnowledgeSettings, KnowledgeStats, KnowledgeSearchResult } from "../../../shared/types";

type FileInfo = KnowledgeFileListItem;
const statusLabel: Record<string, string> = { indexed: "已解析", pending: "等待处理", indexing: "解析中", failed: "失败" };
const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const pad2 = (n: number) => n < 10 ? `0${n}` : String(n);
/** 格式化为 "YYYY-MM-DD HH:mm"；无效时间返回空串 */
function formatTakenDate(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 拍摄时间 · 机型 · 坐标；没有任何信息时返回空串（时间只取 EXIF 拍摄时间，不用拷贝/修改时间冒充） */
function metaLine(m: { dateTakenMs?: number | null; mtimeMs?: number; camera?: string | null; lat?: number | null; lon?: number | null }): string {
  const parts: string[] = [];
  const date = formatTakenDate(m.dateTakenMs);
  if (date) parts.push(`拍摄于 ${date}`);
  if (m.camera) parts.push(m.camera);
  if (m.lat != null && m.lon != null && Number.isFinite(m.lat) && Number.isFinite(m.lon) && (m.lat !== 0 || m.lon !== 0)) {
    parts.push(`${m.lat.toFixed(5)},${m.lon.toFixed(5)}`);
  }
  return parts.join(" · ");
}

/** 片段右上角的阶段文案：OCR 完成 → 大模型识别中 → 最终文字描述 */
function chunkStageInfo(c: KnowledgeChunk): { label: string; busy: boolean; accent: boolean } {
  const embedded = c.dimension ? `已嵌入 · ${c.dimension} 维` : "等待嵌入";
  // 生成描述用的模型：旧索引数据没记，此时不显示，避免误导成「模型未知」
  const by = c.describeModel ? ` · ${c.describeModel}` : "";
  if (c.videoStart !== undefined && c.videoEnd !== undefined) return { label: `${c.modality === "audio" ? "音频" : "视频"} ${c.videoStart.toFixed(1)}–${c.videoEnd.toFixed(1)} 秒 · ${embedded}`, busy: false, accent: false };
  if (c.imagePath) return { label: `图片原图 · ${embedded}`, busy: false, accent: false };
  switch (c.stage) {
    case "ocr": return { label: `图片 OCR · ${c.tokenCount} tokens · 等待大模型描述`, busy: false, accent: true };
    case "describing": return { label: `大模型识别中… · ${c.tokenCount} tokens（OCR 暂存）`, busy: true, accent: true };
    case "described": return { label: `大模型描述${by} · ${c.tokenCount} tokens · ${embedded}`, busy: false, accent: false };
    case "fallback": return { label: `未生成描述${by} · 保留 OCR · ${c.tokenCount} tokens · ${embedded}`, busy: false, accent: true };
    default: return { label: `${c.headingPath || "文本"} · ${c.tokenCount} tokens · ${embedded}`, busy: false, accent: false };
  }
}

/** 本地视频按需读取，文件不能解码时保留打开原文件的入口。 */
function VideoPreview({ filePath, onOpen, prepare, playClipRef, compact = false, posterPath }: { filePath: string; onOpen: () => void; prepare: (filePath: string, convert: boolean) => Promise<string>; playClipRef: MutableRefObject<((start: number, end: number) => void) | null>; compact?: boolean; posterPath?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [previewPath, setPreviewPath] = useState("");
  const [previewVersion, setPreviewVersion] = useState(() => Date.now());
  const [phase, setPhase] = useState<"original" | "converting" | "converted" | "failed">(/\.(mp4|m4v|mov|webm)$/i.test(filePath) ? "original" : "converting");
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playError, setPlayError] = useState("");
  const [clipRange, setClipRange] = useState<{ start: number; end: number } | null>(null);
  const clipRangeRef = useRef<{ start: number; end: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playAttempt = useRef(0);
  const recoveryAttempts = useRef(0);
  const resumeAfterReload = useRef<{ time: number; play: boolean } | null>(null);
  useEffect(() => () => { playAttempt.current++; }, []);
  useEffect(() => {
    if (phase !== "converting" && !(phase === "original" && !previewPath)) return;
    let active = true;
    const convert = phase === "converting";
    void prepare(filePath, convert).then(result => { if (active) { setPreviewPath(result); setPreviewVersion(Date.now()); setPhase(convert ? "converted" : "original"); } }).catch(error => { if (active) { setPlayError(error instanceof Error ? error.message : String(error)); setPhase("failed"); } });
    return () => { active = false; };
  }, [phase, filePath, prepare, previewPath]);
  const available = phase === "original" || phase === "converted";
  const formatTime = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
  useEffect(() => {
    playClipRef.current = (start, end) => {
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return;
      const range = { start, end };
      clipRangeRef.current = range;
      setClipRange(range);
      setPlayError("");
      const video = videoRef.current;
      if (!video) {
        resumeAfterReload.current = { time: start, play: true };
        if (phase === "failed") { recoveryAttempts.current = 0; setPreviewPath(""); setPhase("original"); }
        return;
      }
      video.scrollIntoView({ behavior: "smooth", block: "nearest" });
      if (video.readyState === 0) { resumeAfterReload.current = { time: start, play: true }; return; }
      video.currentTime = start;
      const attempt = ++playAttempt.current;
      void video.play().catch(error => {
        if (attempt !== playAttempt.current || videoRef.current !== video || error?.name === "AbortError") return;
        setPlayError("无法播放片段，请重试或打开原文件。");
      });
    };
    return () => { playClipRef.current = null; };
  }, [phase, playClipRef]);
  const togglePlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    const attempt = ++playAttempt.current;
    if (!video.paused) { video.pause(); return; }
    const clip = clipRangeRef.current;
    if (clip && (video.currentTime < clip.start || video.currentTime >= clip.end - 0.05)) video.currentTime = clip.start;
    else if (video.ended) video.currentTime = 0;
    setPlayError("");
    void video.play().catch(error => {
      // A pending play() can be interrupted by pause, seek, source replacement or unmount.
      if (attempt !== playAttempt.current || videoRef.current !== video || error?.name === "AbortError") return;
      setPlayError("无法播放视频，请重试或打开原文件。");
    });
  };
  return <div style={{ ...s.videoPreview, ...(compact && !expanded ? { width: "min(100%, 360px)" } : {}) }}>
    <strong style={s.videoTitle}>视频预览</strong>
    {(phase === "converting" || (phase === "original" && !previewPath)) ? compact ? <div style={s.videoLoadingFrame}>
      {posterPath && <img src={localFileUrl(posterPath)} alt="" style={s.videoLoadingImage} />}
      <span style={s.videoLoadingLabel}>正在准备视频…</span>
    </div> : <div style={s.videoFallback}>正在转换视频以供预览，较长视频可能需要一些时间…</div>
      : phase === "failed" ? <div style={s.videoFallback}>视频预览失败。{playError && <span>{playError} </span>}<button type="button" style={s.link} onClick={() => { playAttempt.current++; recoveryAttempts.current = 0; resumeAfterReload.current = null; setTime(0); setDuration(0); setPlayError(""); setPreviewPath(""); setPhase("original"); }}>重试</button><button type="button" style={s.link} onClick={onOpen}>打开原文件</button></div>
      : <>
        <video ref={videoRef} key={`${previewPath}:${previewVersion}`} aria-label="视频预览" preload="auto" playsInline poster={posterPath ? localFileUrl(posterPath) : undefined} src={`${previewPath}?preview=${previewVersion}`} style={s.videoPlayer}
          onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
          onTimeUpdate={event => {
            const video = event.currentTarget;
            const clip = clipRangeRef.current;
            if (clip && !video.seeking && video.currentTime >= clip.end) {
              video.pause();
              if (video.currentTime > clip.end) video.currentTime = clip.end;
            }
            setTime(video.currentTime);
          }}
          onLoadedMetadata={event => {
            const video = event.currentTarget;
            const value = video.duration;
            setDuration(Number.isFinite(value) ? value : 0);
            const resume = resumeAfterReload.current;
            if (!resume) return;
            resumeAfterReload.current = null;
            if (Number.isFinite(value) && value > 0) video.currentTime = Math.min(resume.time, Math.max(0, value - 0.05));
            if (resume.play) {
              const attempt = ++playAttempt.current;
              void video.play().catch(error => {
                if (attempt !== playAttempt.current || videoRef.current !== video || error?.name === "AbortError") return;
                setPlayError("无法继续播放，请重试或打开原文件。");
              });
            }
          }}
          onError={event => {
            const error = event.currentTarget.error;
            // 取消请求可发生在暂停、跳转或切换资源时，不应把可恢复的中断当成播放失败。
            if (!error || error.code === MediaError.MEDIA_ERR_ABORTED) return;
            const video = event.currentTarget;
            const shouldPlay = !video.paused || playing;
            playAttempt.current++;
            setPlaying(false);
            // Network/read errors are not codec failures; retry the original
            // source instead of transcoding an entire video on every failure.
            if (phase === "original" && error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
              const clip = clipRangeRef.current;
              resumeAfterReload.current = { time: clip?.start ?? video.currentTime ?? 0, play: shouldPlay || !!clip };
              setPreviewPath("");
              setPhase("converting");
              return;
            }
            if (recoveryAttempts.current < 2) {
              recoveryAttempts.current++;
              resumeAfterReload.current = { time: video.currentTime || 0, play: shouldPlay };
              setPreviewVersion(version => version + 1);
              return;
            }
            setPlayError(`媒体错误 ${error.code}${error.message ? `：${error.message}` : ""}`);
            setPhase("failed");
          }} />
        {clipRange && <div style={s.videoClipLabel}>片段 {clipRange.start.toFixed(1)}–{clipRange.end.toFixed(1)} 秒 <button type="button" style={s.link} onClick={() => { clipRangeRef.current = null; setClipRange(null); }}>播放完整视频</button></div>}
        <div style={s.videoControls}>
          <button type="button" aria-label={playing ? "暂停" : "播放"} title={playing ? "暂停" : "播放"} style={s.videoButton} onClick={togglePlayback} disabled={!available}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">{playing ? <path d="M7.5 5h3.4v14H7.5zM13.1 5h3.4v14h-3.4z" /> : <path d="M8.5 5.5v13l10.5-6.5z" />}</svg>
          </button>
          <span style={s.videoTime}>{formatTime(time)}</span>
          <input aria-label="视频播放进度" type="range" min={0} max={duration || 0} step="0.1" value={Math.min(time, duration)} disabled={!duration} className="kb-video-seek" style={{ ...s.videoSeek, background: `linear-gradient(to right, var(--send-bg, var(--ink)) ${duration ? Math.min(100, Math.max(0, time / duration * 100)) : 0}%, var(--surface-strong) 0)` }}
            onChange={event => { const next = Number(event.target.value); const clip = clipRangeRef.current; if (clip && (next < clip.start || next > clip.end)) { clipRangeRef.current = null; setClipRange(null); } if (videoRef.current) videoRef.current.currentTime = next; setTime(next); }} />
          <span style={s.videoTime}>{formatTime(duration)}</span>
          {compact && <button type="button" style={s.videoButton} aria-label={expanded ? "还原视频大小" : "放大视频"} title={expanded ? "还原视频大小" : "放大视频"} onClick={() => setExpanded(value => !value)}>
            <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{expanded ? <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}</svg>
          </button>}
        </div>
        {playError && <div role="alert" style={s.videoFallback}>{playError}<button type="button" style={s.link} onClick={onOpen}>打开原文件</button></div>}
      </>}
  </div>;
}

function RecallVideoThumbnail({ chunkId, getThumbnail, onPlay }: { chunkId: number; getThumbnail: (chunkId: number) => Promise<string>; onPlay: () => void }) {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setThumbnail(null); setFailed(false);
    void getThumbnail(chunkId).then(path => { if (active) setThumbnail(path); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [chunkId, getThumbnail]);
  return <div style={s.recallThumbnailGroup}>
    <button type="button" aria-label="播放召回片段" style={s.recallThumbnail} onClick={onPlay}>
      {thumbnail && !failed ? <img src={localFileUrl(thumbnail)} alt="召回片段首帧" style={s.recallThumbnailImage} onError={() => setFailed(true)} /> : <span style={s.recallThumbnailStatus}>{failed ? "预览画面不可用" : "正在加载片段画面…"}</span>}
      <span aria-hidden="true" style={s.recallThumbnailPlay}><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 5.5v13l10.5-6.5z" /></svg></span>
    </button>
    <button type="button" style={s.clipPlayButton} onClick={onPlay}>播放召回片段</button>
  </div>;
}

function RecallVideo({ result, prepare, getThumbnail, onOpen }: { result: KnowledgeSearchResult; prepare: (filePath: string, convert: boolean) => Promise<string>; getThumbnail: (chunkId: number) => Promise<string>; onOpen: () => void }) {
  const [posterPath, setPosterPath] = useState<string>();
  useEffect(() => { let active = true; void getThumbnail(result.chunkId).then(path => { if (active) setPosterPath(path); }).catch(() => {}); return () => { active = false; }; }, [getThumbnail, result.chunkId]);
  const playClipRef = useRef<((start: number, end: number) => void) | null>(null);
  useEffect(() => {
    if (result.videoStart !== undefined && result.videoEnd !== undefined) playClipRef.current?.(result.videoStart, result.videoEnd);
  }, [result.videoStart, result.videoEnd]);
  return <VideoPreview filePath={result.filePath} playClipRef={playClipRef} prepare={prepare} onOpen={onOpen} compact posterPath={posterPath} />;
}

type ModelOptionLike = { id: string; name?: string; custom?: boolean; supportsImages?: boolean };

/** 图片识别模型自绘下拉：原生 <select> 在 Windows 弹出层是系统控件、不读主题，
 *  这里用按钮 + 列表自绘，颜色全部走主题变量，深/浅色自动适配。
 *  菜单通过 Portal 渲染到 body、position:fixed 且向上展开，目的是脱离设置 dialog 的
 *  overflow 裁剪（dialog 设了 overflowY:auto + maxHeight），并盖在 dialog 之上。 */
function ImageModelPicker({
  models, currentId, current, disabled, onSelect,
}: {
  models: ModelOptionLike[];
  currentId: string;
  current: ModelOptionLike | undefined;
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ left: number; bottom: number; width: number } | null>(null);
  // 菜单是 portal 到 document.body，可能继承不到主题变量；打开时直接从 :root 读取实色背景，避免透明
  const [menuBg, setMenuBg] = useState<string>("");

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // 向上展开：菜单底边贴在触发按钮顶边上方 6px；宽度与按钮一致
    setCoords({ left: r.left, bottom: window.innerHeight - r.top + 6, width: r.width });
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--focus-body-bg").trim();
    setMenuBg(bg || (document.documentElement.dataset.appearance === "light" ? "#f6f6f5" : "#1a1a1a"));
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      if (triggerRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // 菜单内部滚动（overflow）不关闭；其它滚动（如设置 dialog 滚动使触发按钮移位）
    // 则按触发按钮当前位置重新定位菜单，避免 fixed 菜单错位，而不是一刀切关掉。
    const onScroll = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      place();
    };
    const onResize = () => place();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  const selectedLabel = current?.name || current?.id || "使用默认模型（不指定）";
  const optionList: ModelOptionLike[] = [{ id: "" }, ...models];

  return (
    <div className="kb-model-select" style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        className="kb-model-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={s.modelTrigger}
        onClick={() => setOpen(o => !o)}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedLabel}</span>
        <span aria-hidden style={{ flex: "none", marginLeft: 8, opacity: 0.6 }}>▴</span>
      </button>
      {open && coords && createPortal(
        <div
          ref={menuRef}
          className="kb-model-menu"
          role="listbox"
          style={{ ...s.modelMenu, background: menuBg || "var(--focus-body-bg)", position: "fixed", left: coords.left, bottom: coords.bottom, width: coords.width, top: "auto", zIndex: 10000 }}
        >
          {optionList.map(opt => {
            const isDefault = opt.id === "";
            const label = isDefault
              ? "使用默认模型（不指定）"
              : `${opt.name || opt.id}${opt.custom ? " · 自定义" : ""}${opt.supportsImages === false ? " · 不支持图片" : ""}`;
            return (
              <button
                key={opt.id}
                type="button"
                role="option"
                aria-selected={opt.id === currentId}
                className={`kb-model-option${opt.id === currentId ? " is-selected" : ""}`}
                disabled={disabled}
                style={s.modelOption}
                onClick={() => { setOpen(false); onSelect(opt.id); }}
              >
                {label}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

const FILE_PAGE_SIZE = 100;
const CHUNK_PAGE_SIZE = 20;
const FILE_VIEW_KEY = "kb-file-view";
const LIST_WIDTH_KEY = "kb-list-width";

/** 文件类型的中文标签（列表/详情/卡片共用） */
const TYPE_LABELS: Record<string, string> = {
  image: "图片", video: "视频", pdf: "PDF", docx: "Word", markdown: "Markdown",
  text: "文本", csv: "表格", xlsx: "Excel", pptx: "PPT", unknown: "文件",
};
const typeLabel = (type: string) => TYPE_LABELS[type] ?? type;
const fileBasename = (filePath: string) => filePath.split(/[\\/]/).pop() ?? filePath;
/** 只取日期部分：卡片/列表里空间有限，时间放在详情里 */
const formatDay = (ms?: number | null) => formatTakenDate(ms).slice(0, 10);

/**
 * 录音 Blob（webm/opus）→ 16kHz 单声道 Float32 PCM。
 * 音频编码器要求 16k 单声道；Chromium 能直接解码 MediaRecorder 产物，
 * 再用 OfflineAudioContext 一次性重采样，避免自己写重采样逻辑。
 */
async function decodeRecordingToPcm(blob: Blob): Promise<Float32Array> {
  const data = await blob.arrayBuffer();
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try { decoded = await context.decodeAudioData(data); }
  finally { void context.close(); }
  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, frames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0).slice();
}

function SearchGlyph() {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.4-3.4" /></svg>;
}

function GridViewGlyph() {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.2" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.2" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.2" /></svg>;
}

function ListViewGlyph() {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg>;
}

/** 没有缩略图时的类型占位图：图片 / 视频 / 文档 */
function FileTypeGlyph({ type, size = 22 }: { type: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (type === "image") return <svg {...common}><rect x="3" y="4.5" width="18" height="15" rx="2" /><circle cx="8.5" cy="10" r="1.4" /><path d="m4 17 5.2-5 4 3.6 2.8-2.4L20 17" /></svg>;
  if (type === "video") return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none" /></svg>;
  return <svg {...common}><path d="M6 3.5h7l5 5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" /><path d="M13 3.5V9h5M8.5 13h7M8.5 16.5h5" /></svg>;
}

export default function KnowledgeWindow({ layer = 101, minimized = false, focused = false }: { layer?: number; minimized?: boolean; focused?: boolean }) {
  const { state, dispatch } = useLauncher();
  const skinId = state.launcher?.wallpaper ? wallpaperSkinId(state.launcher.wallpaper) : "wp1";
  const api = window.launcher.knowledge;
  const [libraries, setLibraries] = useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [libraryStats, setLibraryStats] = useState<Record<string, KnowledgeStats | null>>({});
  const [hoveredCard, setHoveredCard] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [entering, setEntering] = useState(false);

  const refreshLibraries = useCallback(async () => {
    try {
      const list = await api.listLibraries();
      setLibraries(list);
      // stats 单独查，失败不影响列表显示
      try {
        const all = await api.listLibrariesStats?.() as Array<{ id: string; stats: KnowledgeStats | null }> | undefined;
        const stats: Record<string, KnowledgeStats | null> = {};
        if (all) for (const item of all) stats[item.id] = item.stats;
        setLibraryStats(stats);
      } catch { /* stats 失败不影响列表 */ }
    } catch (e) { setError(String(e)); }
  }, [api]);

  useEffect(() => { void refreshLibraries(); }, [refreshLibraries]);

  /** 保存图片识别模型；`null` = 清除选择、回退默认模型 */
  const saveImageModel = useCallback(async (next: KnowledgeImageModel | null) => {
    setSavingImageModel(true);
    try {
      const saved = await api.saveSettings({ imageModel: next });
      setKbSettings(saved);
    } catch (e) { setError(String(e)); } finally { setSavingImageModel(false); }
  }, [api]);

  /** 设置界面每次打开都重新问一次：登录/登出后可用模型会变 */
  const loadImageModels = useCallback(async () => {
    setFrameworks(null);
    try {
      const [current, list] = await Promise.all([api.getSettings(), api.listImageModels()]);
      setKbSettings(current);
      setFrameworks(list);
    } catch (e) { setFrameworks([]); setError(String(e)); }
  }, [api]);

  // ─── 文件浏览器状态 ────────────────────────────────────────
  const [folder, setFolder] = useState<string | null>(null);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [progress, setProgress] = useState<KnowledgeIndexProgress | null>(null);
  const [models, setModels] = useState<KnowledgeModelInfo[]>([]);
  const [model, setModel] = useState<KnowledgeModelStatus | null>(null);
  const [fileTotal, setFileTotal] = useState(0);
  const [fileGroups, setFileGroups] = useState<Array<{ year: string | null; count: number }>>([]);
  const [indexedFiles, setIndexedFiles] = useState<Record<number, FileInfo>>({});
  const [viewport, setViewport] = useState({ top: 0, width: 600, height: 500 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadedPagesRef = useRef(new Set<number>());
  const inFlightPagesRef = useRef(new Set<number>());
  const refreshInFlightRef = useRef(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [searchText, setSearchText] = useState("");
  const [kindFilter, setKindFilter] = useState<KnowledgeFileKind>("all");
  const [statusFilter, setStatusFilter] = useState<KnowledgeFileStatusFilter>("all");
  const [sort, setSort] = useState<KnowledgeFileSort>("date-desc");
  const [view, setView] = useState<"grid" | "list">(() => (localStorage.getItem(FILE_VIEW_KEY) === "list" ? "list" : "grid"));
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<FileInfo | null>(null);
  const [previewErrorPath, setPreviewErrorPath] = useState<string | null>(null);
  const [fileMenu, setFileMenu] = useState<{ file: FileInfo; x: number; y: number } | null>(null);
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [chunkLimit, setChunkLimit] = useState(CHUNK_PAGE_SIZE);
  const [chunkThumbs, setChunkThumbs] = useState<Record<number, string>>({});
  const [activeRecallVideo, setActiveRecallVideo] = useState<number | null>(null);
  const playVideoClipRef = useRef<((start: number, end: number) => void) | null>(null);
  const reloadChunksRef = useRef<() => void>(() => {});
  const [listWidth, setListWidth] = useState(() => {
    const saved = Number(localStorage.getItem(LIST_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 24 && saved <= 70 ? saved : 38;
  });

  const [settings, setSettings] = useState(false);
  /** 知识库全局设置（图片识别模型、后台索引）与可选框架/模型 */
  const [kbSettings, setKbSettings] = useState<KnowledgeSettings | null>(null);
  const [frameworks, setFrameworks] = useState<KnowledgeFrameworkModels[] | null>(null);
  const [savingImageModel, setSavingImageModel] = useState(false);
  const [savingBackground, setSavingBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshingFolder, setRefreshingFolder] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"files" | "recall">("files");
  const [recallQuery, setRecallQuery] = useState("");
  const [recallResults, setRecallResults] = useState<KnowledgeSearchResult[] | null>(null);
  const [recalling, setRecalling] = useState(false);
  const [recallError, setRecallError] = useState("");
  const [recallLimit, setRecallLimit] = useState("10");
  const [recallThreshold, setRecallThreshold] = useState("0.01");
  const [recallMode, setRecallMode] = useState<"hybrid" | "dense" | "keyword">("hybrid");
  const [recallElapsed, setRecallElapsed] = useState<number | null>(null);
  const [recallSource, setRecallSource] = useState<"text" | "audio">("text");
  // 语音召回：录音 → 16k PCM → 音频编码器 → 视频音轨相似度
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [audioBusy, setAudioBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recorderStreamRef = useRef<MediaStream | null>(null);
  const recorderChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);
  const recordSecondsRef = useRef(0);
  const recallRequestId = useRef(0);
  const folderOperationRef = useRef(false);
  const folderRevisionRef = useRef(0);
  const selectedId = selected?.id;
  useEffect(() => { setPreviewErrorPath(null); }, [selectedId, selected?.mtimeMs]);

  // 列表分页 / 轮询 / 缩略图请求的并发保护
  const listRequestRef = useRef(0);
  const scrollTopRef = useRef(0);
  const wantThumbsRef = useRef(new Set<number>());
  const wantChunkThumbsRef = useRef(new Set<number>());
  const backgroundIndexingRef = useRef(true);
  const listWidthRef = useRef(listWidth);
  listWidthRef.current = listWidth;
  const panesRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);

  // 搜索输入防抖：敲一个字就查一次数据库对 1 万文件不划算
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchText(searchInput.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const changeView = (next: "grid" | "list") => {
    setView(next);
    try { localStorage.setItem(FILE_VIEW_KEY, next); } catch { /* 隐私模式 */ }
  };

  useEffect(() => {
    if (!fileMenu) return;
    const dismiss = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest("[data-kb-file-menu]")) setFileMenu(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFileMenu(null); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [fileMenu]);

  const openFile = useCallback((filePath: string, report: (message: string) => void = setError) => {
    void api.openFile(filePath).then(result => { if (!result.ok) report(result.error || "无法打开原文件"); })
      .catch((e: unknown) => report(e instanceof Error ? e.message : String(e)));
  }, [api]);

  const removeFileFromKnowledge = async (file: FileInfo) => {
    setFileMenu(null);
    folderRevisionRef.current++;
    try {
      await api.excludeFile(file.id);
      void loadFiles("refresh");
      setSelected(previous => previous?.id === file.id ? null : previous);
      setRecallResults(previous => previous?.filter(item => item.filePath !== file.path) ?? null);
      setChunks(previous => selectedId === file.id ? [] : previous);
      void refreshLibraryMeta();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };

  /** 把源文件移到系统废纸篓（可从废纸篓恢复），成功后再从索引里移除 */
  const trashFile = async (file: FileInfo) => {
    setFileMenu(null);
    if (!window.confirm(`将「${fileBasename(file.path)}」移至废纸篓？\n\n文件会从知识库移除，可从系统废纸篓恢复。`)) return;
    folderRevisionRef.current++;
    try {
      await api.trashFile(file.id);
      void loadFiles("refresh");
      setSelected(previous => previous?.id === file.id ? null : previous);
      setRecallResults(previous => previous?.filter(item => item.filePath !== file.path) ?? null);
      setChunks(previous => selectedId === file.id ? [] : previous);
      wantThumbsRef.current.delete(file.id);
      void refreshLibraryMeta();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      // 废纸篓失败时文件还在，但索引可能已被外部改动，拉一次列表回到真实状态
      void loadFiles("refresh");
    }
  };

  /** 只刷新文件夹信息和统计（不动列表）：列表轮询由 loadFiles 负责 */
  const refreshLibraryMeta = useCallback(async () => {
    if (!libraryId || folderOperationRef.current) return;
    const revision = folderRevisionRef.current;
    try {
      const [folders, summary] = await Promise.all([api.listFolders(), api.stats()]);
      if (folderOperationRef.current || revision !== folderRevisionRef.current) return;
      setFolder(folders[0]?.path || null);
      setStats(summary);
    } catch (e) { setError(String(e)); }
  }, [api, libraryId]);

  // Pages are addressed by offset, allowing a scrollbar jump to fetch only nearby files.
  const loadPage = useCallback(async (offset: number, refresh = false, generation = listRequestRef.current) => {
    if (!libraryId || folderOperationRef.current) return;
    const pageOffset = Math.floor(offset / FILE_PAGE_SIZE) * FILE_PAGE_SIZE;
    if (!refresh && (loadedPagesRef.current.has(pageOffset) || inFlightPagesRef.current.has(pageOffset))) return;
    inFlightPagesRef.current.add(pageOffset);
    try {
      const page = await api.queryFiles({ offset: pageOffset, limit: FILE_PAGE_SIZE, search: searchText, kind: kindFilter, status: statusFilter, sort });
      if (generation !== listRequestRef.current) return;
      setFileTotal(page.total);
      setFileGroups(page.groups ?? []);
      setIndexedFiles(previous => {
        const next = { ...previous };
        for (let i = pageOffset; i < pageOffset + FILE_PAGE_SIZE; i++) delete next[i];
        page.items.forEach((file, i) => { next[pageOffset + i] = file; });
        return next;
      });
      loadedPagesRef.current.add(pageOffset);
    } catch (e) { if (generation === listRequestRef.current) setError(String(e)); }
    finally { if (generation === listRequestRef.current) { inFlightPagesRef.current.delete(pageOffset); setLoadingFiles(false); } }
  }, [api, libraryId, searchText, kindFilter, statusFilter, sort]);

  const loadFiles = useCallback(async (mode: "reset" | "more" | "refresh") => {
    if (mode === "reset") {
      const generation = ++listRequestRef.current;
      loadedPagesRef.current.clear(); inFlightPagesRef.current.clear();
      setIndexedFiles({}); setFileGroups([]); setFileTotal(0); setLoadingFiles(true);
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
      setViewport(previous => ({ ...previous, top: 0 }));
      await loadPage(0, true, generation);
    } else if (mode === "refresh") {
      if (!libraryId || folderOperationRef.current || refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      const generation = ++listRequestRef.current;
      const offsets = [...new Set([0, ...loadedPagesRef.current, ...inFlightPagesRef.current])];
      loadedPagesRef.current.clear(); inFlightPagesRef.current.clear();
      for (const offset of offsets) inFlightPagesRef.current.add(offset);
      try {
        const pages = await Promise.all(offsets.map(offset => api.queryFiles({
          offset, limit: FILE_PAGE_SIZE, search: searchText, kind: kindFilter, status: statusFilter, sort,
        })));
        if (generation !== listRequestRef.current) return;
        const first = pages[0];
        setFileTotal(first.total);
        setFileGroups(first.groups ?? []);
        setIndexedFiles(previous => {
          // Pages requested after the refresh started remain available too.
          const next = { ...previous };
          offsets.forEach((offset, pageIndex) => {
            for (let i = offset; i < offset + FILE_PAGE_SIZE; i++) delete next[i];
            pages[pageIndex].items.forEach((file, i) => { next[offset + i] = file; });
          });
          for (const key of Object.keys(next)) if (Number(key) >= first.total) delete next[Number(key)];
          return next;
        });
        for (const offset of offsets) loadedPagesRef.current.add(offset);
      } catch (e) {
        if (generation === listRequestRef.current) setError(String(e));
      } finally {
        if (generation === listRequestRef.current) for (const offset of offsets) inFlightPagesRef.current.delete(offset);
        refreshInFlightRef.current = false;
      }

    }
  }, [loadPage, api, libraryId, searchText, kindFilter, statusFilter, sort]);

  // 进库 / 换筛选条件都从第一页重来；换筛选时顺带收起详情，避免右侧还停着一条已经不在列表里的旧文件
  useEffect(() => {
    if (!libraryId) return;
    setSelected(null);
    setChunks([]);
    void loadFiles("reset");
  }, [libraryId, loadFiles]);

  // 换库时清空选中与缩略图缓存，避免把上一个库的 id 当成本库的
  useEffect(() => {
    setSelected(null);
    setChunks([]);
    setChunkLimit(CHUNK_PAGE_SIZE);
    setThumbs({});
    setChunkThumbs({});
    wantThumbsRef.current.clear();
    wantChunkThumbsRef.current.clear();
  }, [libraryId]);

  // 窗口打开 → 恢复索引；是否在关闭后继续索引由设置决定（默认继续）
  useEffect(() => {
    void api.setPaused(false);
    const timer = window.setTimeout(() => { void api.setPaused(false).catch(() => {}); }, 1000);
    return () => {
      window.clearTimeout(timer);
      if (!backgroundIndexingRef.current) void api.setPaused(true);
    };
  }, [api]);

  useEffect(() => {
    backgroundIndexingRef.current = kbSettings?.backgroundIndexing !== false;
  }, [kbSettings]);

  useEffect(() => {
    if (!libraryId) return;
    // 切换知识库时清空召回测试状态
    setRecallQuery("");
    setRecallResults(null);
    setRecalling(false);
    setRecallError("");
    setRecallElapsed(null);
    setActiveRecallVideo(null);
    void refreshLibraryMeta().finally(() => setEntering(false));
    void api.getProgress().then(setProgress);
    void api.getModelStatus("embeddinggemma2").then(setModel);
    void api.listModels().then(setModels);
    void api.getSettings().then(setKbSettings).catch(() => {});
    const offProgress = api.onProgress(setProgress);
    const offModel = api.onModelStatus(status => {
      setModel(status);
      if (status.phase === "done" || status.phase === "error") void api.listModels().then(setModels);
    });
    const timer = window.setInterval(() => {
      void refreshLibraryMeta();
      void api.listModels().then(setModels);
      // 兜底拉一次进度：即使某次阶段事件丢失（窗口刚打开/节流），4 秒内也能收敛
      void api.getProgress().then(setProgress);
      // 只有停在顶部时才同步第一页：用户滚到中间时不要打乱已经加载的内容
      if (scrollTopRef.current < 32) void loadFiles("refresh");
    }, 4000);
    return () => { recallRequestId.current++; offProgress(); offModel(); window.clearInterval(timer); };
  }, [api, libraryId, refreshLibraryMeta, loadFiles]);

  useEffect(() => {
    if (selectedId == null) { setChunks([]); reloadChunksRef.current = () => {}; return; }
    setChunkLimit(CHUNK_PAGE_SIZE);
    let active = true;
    const load = () => void api.getFileChunks(selectedId).then(data => { if (active) setChunks(data); }).catch(e => { if (active) setError(String(e)); });
    reloadChunksRef.current = load;
    load();
    const timer = window.setInterval(load, 3000);
    return () => { active = false; reloadChunksRef.current = () => {}; window.clearInterval(timer); };
  }, [api, selectedId]);

  // 图片描述阶段：只刷新片段；文件真正处理完才动列表（否则每张图都触发一次全页查询）
  useEffect(() => api.onChunkStage(event => {
    if (event.fileId === selectedId) reloadChunksRef.current();
    if (event.stage === "done") {
      void refreshLibraryMeta();
      void loadFiles("refresh");
    }
  }), [api, selectedId, refreshLibraryMeta, loadFiles]);

  // 详情/召回里的内嵌图片也走缩略图，避免一次解码几十张大图
  const recallImageChunkIds = (recallResults ?? []).filter(r => r.imagePath).slice(0, 40).map(r => r.chunkId);
  // 只给当前真正渲染出来的片段生成缩略图；超大 PDF 的几百张图不该一次性全做
  const visibleChunkIds = chunks.slice(0, chunkLimit).filter(c => c.imagePath).map(c => c.id);
  const wantedChunkIds = [...new Set([...visibleChunkIds, ...recallImageChunkIds])];
  useEffect(() => {
    const ids = wantedChunkIds.filter(id => !chunkThumbs[id] && !wantChunkThumbsRef.current.has(id)).slice(0, 40);
    if (!ids.length) return;
    for (const id of ids) wantChunkThumbsRef.current.add(id);
    void api.chunkThumbnails(ids).then(list => {
      if (!list.length) return;
      setChunkThumbs(previous => {
        const next = { ...previous };
        for (const item of list) next[item.chunkId] = item.path;
        return next;
      });
    }).catch(() => { for (const id of ids) wantChunkThumbsRef.current.delete(id); });
  }, [api, wantedChunkIds.join(","), chunkThumbs]);

  const changeFolder = async (clear = false) => {
    if (clear && !window.confirm("清空当前知识库索引并移除文件夹？原文件不会被删除。")) return;
    const path = clear ? null : await api.pickFolder();
    if (!clear && !path) return;
    const previousFolder = folder;
    folderOperationRef.current = true;
    folderRevisionRef.current++;
    setBusy(true); setError("");
    // Show the detail view immediately while the worker prepares the folder.
    if (path) {
      setFolder(path); setTab("files");
      setSelected(null); setChunks([]); setFileTotal(0); setStats(null); setProgress(null); setRecallResults(null);
    }
    try {
      const result = await api.setFolder(path);
      if (!result.ok) throw new Error(result.error || "文件夹设置失败");
      setFolder(path);
      setSelected(null); setChunks([]); setFileTotal(0); setRecallResults(null);
      setThumbs({}); wantThumbsRef.current.clear();
      await loadFiles("reset");
    } catch (e) {
      setFolder(previousFolder);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      folderOperationRef.current = false;
      setBusy(false);
      void refreshLibraryMeta();
    }
  };
  const refreshFolder = async () => {
    if (!folder || busy) return;
    folderOperationRef.current = true;
    folderRevisionRef.current++;
    setBusy(true); setRefreshingFolder(true); setError("");
    try {
      const result = await api.setFolder(folder);
      if (!result.ok) throw new Error(result.error || "刷新文件夹失败");
      setSelected(null); setChunks([]); setFileTotal(0); setRecallResults(null);
      setThumbs({}); wantThumbsRef.current.clear();
      await loadFiles("reset");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally {
      folderOperationRef.current = false;
      setBusy(false); setRefreshingFolder(false);
      void refreshLibraryMeta();
    }
  };
  const testRecall = async () => {
    if (!recallQuery.trim() || recalling) return;
    const limit = Number(recallLimit);
    const minScore = Number(recallThreshold);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) { setRecallError("召回数量请输入 1 到 50 的整数。"); return; }
    if (!recallThreshold.trim() || !Number.isFinite(minScore) || minScore < 0 || minScore > 2 / 61) { setRecallError("阈值请输入 0 到 0.03278 之间的数值。"); return; }
    const requestId = ++recallRequestId.current;
    setRecalling(true); setRecallError(""); setRecallResults(null); setRecallElapsed(null); setActiveRecallVideo(null); setRecallSource("text");
    const started = performance.now();
    try {
      const results = await api.search(recallQuery.trim(), { limit, minScore, mode: recallMode });
      if (requestId !== recallRequestId.current) return;
      setRecallElapsed(performance.now() - started);
      setRecallResults(results);
    } catch (e) { if (requestId === recallRequestId.current) setRecallError(e instanceof Error ? e.message : String(e)); }
    finally { if (requestId === recallRequestId.current) setRecalling(false); }
  };
  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  /** 录一段语音（≤15 秒），直接走音频编码器检索视频音轨；结果复用召回列表和视频播放器。 */
  const startRecording = async () => {
    if (recording || audioBusy) return;
    setRecallError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorderStreamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      recorderChunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size > 0) recorderChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        void (async () => {
          if (recordTimerRef.current !== null) { window.clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
          stream.getTracks().forEach(track => track.stop());
          recorderStreamRef.current = null;
          recorderRef.current = null;
          setRecording(false);
          const blob = new Blob(recorderChunksRef.current, { type: mimeType });
          recorderChunksRef.current = [];
          if (!blob.size) return;
          setAudioBusy(true);
          setRecallResults(null);
          setRecallElapsed(null);
          setActiveRecallVideo(null);
          const requestId = ++recallRequestId.current;
          const started = performance.now();
          try {
            const audio = await decodeRecordingToPcm(blob);
            if (!audio.length) throw new Error("录音为空，请重试");
            const results = await api.searchAudio(audio, { limit: Math.min(50, Math.max(1, Number(recallLimit) || 10)), minScore: 0 });
            if (requestId !== recallRequestId.current) return;
            setRecallResults(results);
            setRecallSource("audio");
            setRecallElapsed(performance.now() - started);
          } catch (error) {
            if (requestId === recallRequestId.current) setRecallError(error instanceof Error ? error.message : String(error));
          } finally {
            if (requestId === recallRequestId.current) setAudioBusy(false);
          }
        })();
      };
      recorder.start();
      recorderRef.current = recorder;
      recordSecondsRef.current = 0;
      setRecordSeconds(0);
      setRecording(true);
      recordTimerRef.current = window.setInterval(() => {
        recordSecondsRef.current += 1;
        setRecordSeconds(recordSecondsRef.current);
        if (recordSecondsRef.current >= 15 && recorder.state === "recording") recorder.stop();
      }, 1000);
    } catch (error) {
      setRecallError(`无法开始录音：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  useEffect(() => () => {
    if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
    recorderStreamRef.current?.getTracks().forEach(track => track.stop());
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  }, []);

  const saveBackgroundIndexing = async (next: boolean) => {
    setSavingBackground(true);
    try {
      const saved = await api.saveSettings({ backgroundIndexing: next });
      setKbSettings(saved);
      backgroundIndexingRef.current = saved.backgroundIndexing !== false;
    } catch (e) { setError(String(e)); } finally { setSavingBackground(false); }
  };

  const estimatedChunks = stats?.estimatedChunks ?? stats?.chunkCount ?? 0;
  const estimatedEmbedded = stats?.estimatedEmbeddedChunks ?? stats?.embeddedChunks ?? 0;
  const stillIndexing = (stats?.statusDistribution ?? []).some(item => (item.status === "pending" || item.status === "indexing") && item.count > 0) || (progress?.phase === "scanning" || progress?.phase === "indexing");
  const percent = estimatedChunks ? Math.min(stillIndexing ? 99 : 100, Math.floor(estimatedEmbedded / estimatedChunks * 100)) : 0;
  const current = Object.values(indexedFiles).find(f => f.id === selectedId) ?? selected;
  // 没选文件时让列表/画廊占满整窗（一屏能看更多照片或文件名）；选中后自动分成「列表 + 详情」。
  // 详情是「点开才出现」的，不再常驻一个空面板浪费 60% 宽度。
  const detailOpen = Boolean(current);
  const imageCount = stats?.typeDistribution.find(item => item.type === "image")?.count ?? 0;
  const videoCount = stats?.typeDistribution.find(item => item.type === "video")?.count ?? 0;
  const documentCount = Math.max(0, (stats?.fileCount ?? 0) - imageCount - videoCount);
  const pendingCount = stats?.pendingFiles ?? 0;
  const kindChips: Array<{ value: KnowledgeFileKind; label: string; count?: number }> = [
    { value: "all", label: "全部", count: stats?.fileCount },
    { value: "image", label: "图片", count: imageCount },
    { value: "document", label: "文档", count: documentCount },
    { value: "video", label: "视频", count: videoCount },
  ];
  const thumbFor = (file: FileInfo) => file.thumbPath ?? thumbs[file.id] ?? null;
  const imageChunk = current?.type === "image" ? chunks.find(chunk => chunk.imagePath) : undefined;
  const detailChunks = imageChunk ? chunks.filter(chunk => chunk.id !== imageChunk.id) : chunks;
  const visibleChunks = detailChunks.slice(0, chunkLimit);
  const dated = sort === "date-desc" || sort === "date-asc";
  const columns = view === "grid" ? Math.max(1, Math.floor((Math.max(0, viewport.width - 20) + 8) / 120)) : 1;
  const cardWidth = (Math.max(0, viewport.width - 20) - (columns - 1) * 8) / columns;
  const rowHeight = view === "grid" ? cardWidth + 61 : 66;
  const sections = dated ? fileGroups : [{ year: null, count: fileTotal }];
  let layoutTop = 0, fileIndex = 0;
  const virtualRows: Array<{ top: number; height: number; start: number; count: number; label?: string }> = [];
  for (const section of sections) {
    if (dated) { virtualRows.push({ top: layoutTop, height: 38, start: fileIndex, count: 0, label: section.year ? `${section.year} 年　${section.count}` : `未知日期　${section.count}` }); layoutTop += 38; }
    for (let n = 0; n < section.count; n += columns) {
      const count = Math.min(columns, section.count - n);
      virtualRows.push({ top: layoutTop, height: rowHeight, start: fileIndex + n, count });
      layoutTop += rowHeight;
    }
    fileIndex += section.count;
  }
  const shownRows = virtualRows.filter(row => row.top + row.height >= viewport.top - 350 && row.top <= viewport.top + viewport.height + 350);
  const wantedPages = [...new Set(shownRows.filter(row => row.count).flatMap(row => [Math.floor(row.start / FILE_PAGE_SIZE) * FILE_PAGE_SIZE, Math.floor((row.start + row.count - 1) / FILE_PAGE_SIZE) * FILE_PAGE_SIZE]))];
  const wantedPageKey = wantedPages.join(",");
  useEffect(() => { for (const offset of wantedPages) void loadPage(offset); }, [loadPage, wantedPageKey, fileTotal, indexedFiles]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () => setViewport({ top: element.scrollTop, width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, [libraryId, folder, tab, view, selectedId]);
  // 缩略图：本页里还没有缩略图的图片，批量找后台生成。
  // 未索引的照片也能直接从原图出缩略图，所以「待处理」不挡预览。
  useEffect(() => {
    if (!libraryId) return;
    const wanted = shownRows.flatMap(row => Array.from({ length: row.count }, (_, i) => indexedFiles[row.start + i]).filter((file): file is FileInfo => Boolean(file)))
      .filter(file => ["image", "pdf", "video"].includes(file.type) && !file.thumbPath && !thumbs[file.id] && !wantThumbsRef.current.has(file.id))
      .slice(0, 60);
    if (!wanted.length) return;
    const ids = wanted.map(file => file.id);
    for (const id of ids) wantThumbsRef.current.add(id);
    void api.fileThumbnails(ids).then(list => {
      if (!list.length) return;
      setThumbs(previous => {
        const next = { ...previous };
        for (const item of list) next[item.fileId] = item.path;
        return next;
      });
    }).catch(() => { for (const id of ids) wantThumbsRef.current.delete(id); });
  }, [api, indexedFiles, thumbs, libraryId, wantedPageKey, viewport.top, viewport.height]);


  const onListScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    scrollTopRef.current = element.scrollTop;
    setViewport({ top: element.scrollTop, width: element.clientWidth, height: element.clientHeight });
  };
  const openFileMenu = (event: React.MouseEvent, file: FileInfo) => {
    event.preventDefault(); event.stopPropagation();
    const rect = event.currentTarget.closest(".kb-window")?.getBoundingClientRect();
    if (!rect) return;
    setFileMenu({ file, x: Math.max(8, Math.min(event.clientX - rect.left, rect.width - 205)), y: Math.max(8, Math.min(event.clientY - rect.top, rect.height - 120)) });
  };
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const width = panesRef.current?.getBoundingClientRect().width;
    if (!width) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: listWidthRef.current, width };
    document.body.style.userSelect = "none";
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(70, Math.max(24, drag.startWidth + (event.clientX - drag.startX) / drag.width * 100));
    setListWidth(next);
  };
  const endResize = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.userSelect = "";
    try { localStorage.setItem(LIST_WIDTH_KEY, String(Math.round(listWidthRef.current))); } catch { /* 隐私模式 */ }
  };

  const renderRow = (file: FileInfo) => {
    const thumb = thumbFor(file);
    return <button key={file.id} type="button" style={{ ...s.file, ...(file.id === selectedId ? s.fileSelected : {}) }} onClick={() => setSelected(file)} onContextMenu={event => openFileMenu(event, file)}>
      <span style={s.rowThumb}>
        {thumb ? <img className="kb-row-img" src={localFileUrl(thumb)} alt="" loading="lazy" decoding="async" /> : <FileTypeGlyph type={file.type} size={18} />}
      </span>
      <span style={s.rowText}>
        <span style={s.fileName}>{fileBasename(file.path)}</span>
        <span style={s.fileSub}>{[typeLabel(file.type), statusLabel[file.status] ?? file.status, formatBytes(file.size), formatDay(file.dateTakenMs ?? file.mtimeMs)].filter(Boolean).join(" · ")}</span>
      </span>
      {file.status === "failed" && <span style={s.rowFailed} title={file.error ?? "处理失败"}>!</span>}
    </button>;
  };
  const renderCard = (file: FileInfo) => {
    const thumb = thumbFor(file);
    return <button key={file.id} type="button" className={`kb-card${file.id === selectedId ? " is-selected" : ""}`} style={s.fileCard} title={fileBasename(file.path)} onClick={() => setSelected(selected?.id === file.id ? null : file)} onContextMenu={event => openFileMenu(event, file)}>
      <span style={s.fileCardThumb}>
        {thumb ? <img className="kb-card-img" src={localFileUrl(thumb)} alt="" loading="lazy" decoding="async" /> : <span style={s.fileCardGlyph}><FileTypeGlyph type={file.type} size={26} /></span>}
        {file.type === "video" && <span style={s.badgePlay} aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8.5 5.5v13l10.5-6.5z" /></svg></span>}
        {file.status === "failed" ? <span style={s.badgeFailed}>失败</span>
          : file.status === "pending" || file.status === "indexing" ? <span style={s.badgePending}>待处理</span> : null}
      </span>
      <span style={s.fileCardName}>{fileBasename(file.path)}</span>
      <span style={s.fileCardMeta}>{[formatDay(file.dateTakenMs ?? file.mtimeMs), formatBytes(file.size)].filter(Boolean).join(" · ")}</span>
    </button>;
  };

  return <WindowFrame id="launcher-knowledge" className="focus-knowledge" skinId={skinId} style={{ zIndex: layer }} initialSize={{ width: Math.min(1120, window.innerWidth - 48) }} ariaLabel="本地知识库"
    header={<><strong className="window-frame-title">本地知识库</strong><button type="button" aria-label="知识库设置" className="kb-settings" style={s.settingsButton} onPointerDown={e => e.stopPropagation()} onClick={() => { setSettings(true); void loadImageModels(); /* 向量模型状态是库级的，没进库就拿不到，别让它挡住设置面板 */ void api.listModels().then(setModels).catch(() => setModels([])); }}><SettingsIcon width={17} height={17} /></button></>}
    headerAlign="center" onFocus={() => dispatch({ type: "FOCUS_CHAT_WINDOW", windowId: "knowledge" })}
    onClose={() => { clearSavedWindowGeometry("launcher-knowledge"); dispatch({ type: "CLOSE_CHAT", windowId: "knowledge" }); }}
    onMinimize={() => dispatch({ type: "MINIMIZE_CHAT", windowId: "knowledge" })} minimized={minimized} focused={focused}>
    <div className="kb-window" style={s.container}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } .kb-icon-btn svg { width: 13px; height: 13px; } .kb-folder-icon svg { fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
        /* 内联样式写不出 :hover，这里统一给按钮补悬停底色（主按钮单独走亮度，避免浅底浅字；筛选 chip 与文件卡片有独立样式） */
        .kb-window button:hover:not(:disabled):not([role="tab"]):not(.kb-chip) { background: var(--hover) !important; }
        .kb-window button:disabled { cursor: default; }
        .kb-window .kb-primary:hover:not(:disabled) { background: var(--send-bg, var(--ink)) !important; filter: brightness(1.12); }
        .kb-settings:hover:not(:disabled) { background: var(--hover) !important; }
        .kb-file-menu-icon { width: 15px; height: 15px; flex-shrink: 0; }
        .kb-video-seek { appearance: none; -webkit-appearance: none; height: 5px; border: 0; border-radius: 999px; outline: none; }
        .kb-video-seek::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 13px; height: 13px; border: 0; border-radius: 50%; background: var(--send-bg, var(--ink)); cursor: pointer; }
        .kb-video-seek:focus-visible { outline: 2px solid var(--send-bg, var(--ink)); outline-offset: 4px; }
        .kb-video-seek:disabled { opacity: .5; cursor: default; }
        .kb-thumb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; padding: 0 2px 2px; }
        .kb-window .kb-card { transition: border-color .12s ease, box-shadow .12s ease; }
        .kb-window .kb-card:hover:not(:disabled) { background: var(--surface-soft) !important; border-color: var(--ink-soft); }
        .kb-window .kb-card.is-selected { border-color: var(--send-bg, var(--ink)) !important; box-shadow: inset 0 0 0 1px var(--send-bg, var(--ink)); }
        .kb-card-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
        .kb-row-img { width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 5px; }
        .kb-window .kb-chip { transition: background .12s ease, color .12s ease, border-color .12s ease; }
        .kb-window .kb-chip:hover:not(:disabled) { background: var(--surface-strong) !important; }
        .kb-window .kb-chip.is-active { background: var(--send-bg, var(--ink)) !important; border-color: var(--send-bg, var(--ink)); color: var(--send-ink, var(--focus-body-bg)) !important; }
        .kb-window .kb-chip.is-active:hover:not(:disabled) { background: var(--send-bg, var(--ink)) !important; filter: brightness(1.1); }
        .kb-splitter:hover, .kb-splitter:active { background: var(--line); }
        .kb-mini-select:focus-visible, .kb-search:focus-visible { outline: 2px solid var(--send-bg, var(--ink)); outline-offset: 1px; }
        .kb-thumb-grid + .kb-thumb-grid { margin-top: 10px; }
      `}</style>
      {fileMenu && <div data-kb-file-menu role="menu" style={{ ...s.fileMenu, left: fileMenu.x, top: fileMenu.y }}>
        <button type="button" role="menuitem" style={s.fileMenuItem} onClick={() => void removeFileFromKnowledge(fileMenu.file)}><DeleteIcon className="kb-file-menu-icon" /> 从知识库移除</button>
        <div role="separator" style={s.fileMenuDivider} />
        <button type="button" role="menuitem" style={{ ...s.fileMenuItem, color: "#df4747" }} onClick={() => void trashFile(fileMenu.file)}>
          <svg className="kb-file-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6" /></svg>
          移至废纸篓
        </button>
      </div>}
      {error && <div role="alert" style={s.error}>{error} <button onClick={() => setError("")} style={s.link}>关闭</button></div>}
      {!libraryId ? <div style={s.listPage}>
        <h2 style={s.listTitle}>我的知识库</h2>
        <div style={s.grid}>
          {/* 创建卡片 */}
          <button style={s.createCard} onClick={() => setCreating(true)}>
            <span style={{ fontSize: 32, lineHeight: 1 }}>+</span>
            <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>创建知识库</span>
          </button>
          {/* 知识库卡片 */}
          {libraries.map(item => {
            const st = libraryStats[item.id];
            return <div
              key={item.id}
              style={{ ...s.libCard, opacity: item.enabled ? 1 : 0.6 }}
              onMouseEnter={() => setHoveredCard(item.id)}
              onMouseLeave={() => setHoveredCard(null)}
            >
              {/* 卡片内容 */}
              <button style={s.cardMain} onClick={() => {
                setEntering(true);
                void api.selectLibrary(item.id).then(() => {
                  setLibraryId(item.id); setFolder(null); setFileTotal(0); setSelected(null);
                }).catch(e => { setError(String(e)); setEntering(false); });
              }}>
                <div style={s.cardName}>{item.name}</div>
                <div style={{ ...s.cardStats, flexDirection: "column", gap: 3 }}>
                  <span>{st?.fileCount ?? 0} 个文件 · {formatBytes(st?.totalBytes ?? 0)} 原始数据</span>
                  <span>{st?.chunkCount ?? 0} 个片段 · {formatBytes(st?.dbBytes ?? 0)} 嵌入数据</span>
                </div>
              </button>
              {/* 底部行：开关 + 操作按钮 */}
              <div style={s.switchRow}>
                <label style={s.switch}>
                  <input type="checkbox" checked={item.enabled} onChange={e => void api.updateLibrary(item.id, { enabled: e.target.checked }).then(refreshLibraries)} style={{ display: "none" }} />
                  <span style={{ ...s.switchTrack, ...(item.enabled ? s.switchTrackOn : {}) }}>
                    <span style={{ ...s.switchThumb, ...(item.enabled ? s.switchThumbOn : {}) }} />
                  </span>
                </label>
                <span style={{ fontSize: 12, flex: 1 }}>{item.enabled ? "已启用" : "已停用"}</span>
                <div style={{ display: "flex", gap: 4, opacity: hoveredCard === item.id ? 1 : 0, transition: "opacity 0.15s" }}>
                  <button className="kb-icon-btn" style={s.iconBtn} aria-label="重命名" onClick={(e) => { e.stopPropagation(); setEditing({ id: item.id, name: item.name }); }}><EditIcon /></button>
                  <button className="kb-icon-btn" style={{ ...s.iconBtn, color: "#df4747" }} aria-label="删除" onClick={(e) => { e.stopPropagation(); if (window.confirm(`删除知识库「${item.name}」及索引？源文件会保留。`)) void api.deleteLibrary(item.id).then(refreshLibraries).catch(e => setError(String(e))); }}><DeleteIcon /></button>
                </div>
              </div>
            </div>;
          })}
        </div>
        {/* 创建对话框 */}
        {creating && <div style={s.overlay} onClick={() => setCreating(false)}>
          <div style={s.dialog} onClick={e => e.stopPropagation()}>
            <div style={s.dialogHead}><strong>创建新知识库</strong><button style={s.link} onClick={() => setCreating(false)}>✕</button></div>
            <form onSubmit={e => { e.preventDefault(); void api.createLibrary(newName.trim()).then(() => { setNewName(""); setCreating(false); return refreshLibraries(); }).catch(e => setError(String(e))); }}>
              <input style={s.createInput} autoFocus value={newName} onChange={e => setNewName(e.target.value)} placeholder="输入知识库名称" />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" style={s.link} onClick={() => setCreating(false)}>取消</button>
                <button type="submit" className="kb-primary" style={s.primary} disabled={!newName.trim()}>创建</button>
              </div>
            </form>
          </div>
        </div>}
        {/* 重命名对话框 */}
        {editing && <div style={s.overlay} onClick={() => setEditing(null)}>
          <div style={s.dialog} onClick={e => e.stopPropagation()}>
            <div style={s.dialogHead}><strong>重命名知识库</strong><button style={s.link} onClick={() => setEditing(null)}>✕</button></div>
            <form onSubmit={e => { e.preventDefault(); void api.updateLibrary(editing.id, { name: editing.name.trim() }).then(() => { setEditing(null); return refreshLibraries(); }).catch(e => setError(String(e))); }}>
              <input style={s.createInput} autoFocus value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="输入新名称" />
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button type="button" style={s.link} onClick={() => setEditing(null)}>取消</button>
                <button type="submit" className="kb-primary" style={s.primary} disabled={!editing.name.trim()}>保存</button>
              </div>
            </form>
          </div>
        </div>}
      </div> : <div style={s.detailPage}>
        <div style={s.topBar}>
          <button className="kb-icon-btn" style={s.backBtn} onClick={() => { setLibraryId(null); void refreshLibraries(); }}>
            <NavigationChevronIcon direction="left" />
          </button>
          <span style={s.topBarTitle}>{libraries.find(l => l.id === libraryId)?.name ?? "知识库"}</span>
          {folder && <>
            <span style={{ ...s.folderName, flex: 1, minWidth: 0, marginLeft: 8 }} title={folder}>{folder}</span>
            <button style={s.topAction} disabled={busy} onClick={() => void refreshFolder()}>刷新</button>
            <button style={s.topAction} disabled={busy} onClick={() => void changeFolder()}>更改</button>
            <button style={s.topAction} disabled={busy} onClick={() => void changeFolder(true)}>清空</button>
          </>}
        </div>
        {entering ? <div style={s.empty}>
        <div style={s.spinner} />
        <p style={{ color: "var(--ink-soft)", marginTop: 16 }}>正在加载知识库…</p>
      </div> : !folder ? <div style={s.empty}>
        <div style={{ fontSize: 32 }}>▣</div><h2 style={{ margin: "12px 0 6px" }}>选择知识库文件夹</h2>
        <p style={{ color: "var(--ink-soft)", margin: "0 0 20px", lineHeight: 1.7 }}>选择一个文件夹，系统将在后台解析并索引其中支持的文件。</p>
        <button className="kb-primary" style={s.primary} disabled={busy} onClick={() => void changeFolder()}>{busy ? "正在处理…" : "选择文件夹"}</button>
      </div> : <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {busy && <div style={s.note}>{refreshingFolder ? "正在重新扫描文件夹：只处理新增或内容变化的文件，未变化的复用已有索引…" : "正在准备文件夹并启动索引，请稍候…"}</div>}
        <div style={s.cards}>
          <div style={s.card}><strong style={s.cardValue}>{(stats?.fileCount ?? 0).toLocaleString("zh-CN")}</strong><span style={s.cardLabel}>文件总数</span><span style={s.cardSub}>· 已处理 {(stats?.indexedFiles ?? 0).toLocaleString("zh-CN")}</span></div>
          {[["片段", (stats?.chunkCount ?? 0).toLocaleString("zh-CN")], ["数据大小", formatBytes(stats?.totalBytes ?? 0)], ["向量嵌入（预估）", `${percent}%`]].map(([label, value]) => <div style={s.card} key={label}><strong style={s.cardValue}>{value}</strong><span style={s.cardLabel}>{label}</span></div>)}
        </div>
        {progress?.error && <div role="alert" style={s.error}>向量嵌入失败：{progress.error}</div>}
        {!!stats?.failedEmbeddingChunks && <div style={s.note} role="status">
          {stats.failedEmbeddingChunks} 个视频片段无法嵌入，已跳过并继续处理。可重新索引对应文件重试。
          <details><summary>查看最近失败片段</summary>{stats.embeddingFailures?.map(item => <div key={`${item.fileId}-${item.videoStart}-${item.videoEnd}`}>{fileBasename(item.path)} · {item.videoStart?.toFixed(1)}–{item.videoEnd?.toFixed(1)} 秒：{item.error} <button type="button" style={s.link} onClick={() => { void api.reindexFile(item.fileId).then(() => refreshLibraryMeta()).catch(e => setError(String(e))); }}>重新索引文件</button></div>)}</details>
        </div>}
        {model && model.phase !== "done" && <div style={s.note}>EmbeddingGemma 2 模型{model.phase === "error" ? "下载失败，请打开设置重试" : model.phase === "checking" ? "状态检查中" : "下载中，完成后开始向量嵌入"} <button style={s.link} onClick={() => setSettings(true)}>查看</button></div>}
        {/* 嵌入统计 / 索引进度与 tab 同排（靠右），不再单独占一行 */}
        <div style={s.tabRow}>
          <div role="tablist" aria-label="知识库视图" style={s.tabs}>
            <button role="tab" aria-selected={tab === "files"} style={{ ...s.tab, ...(tab === "files" ? s.tabActive : {}) }} onClick={() => setTab("files")}>文件数据</button>
            <button role="tab" aria-selected={tab === "recall"} style={{ ...s.tab, ...(tab === "recall" ? s.tabActive : {}) }} onClick={() => setTab("recall")}>召回测试</button>
          </div>
          {(() => {
            const active = !!progress && progress.phase !== "idle" && progress.phase !== "model-download";
            const failed = (active ? progress!.failedFiles : stats?.failedFiles ?? 0) ?? 0;
            const remaining = progress?.remainingFiles ?? pendingCount;
            const text = !active
              ? pendingCount > 0
                ? `待处理 ${pendingCount.toLocaleString("zh-CN")} 个文件 · 已处理 ${(stats?.indexedFiles ?? 0).toLocaleString("zh-CN")}`
                : `已嵌入 ${stats?.embeddedChunks ?? 0} / ${stats?.chunkCount ?? 0} 个片段`
              : progress!.phase === "scanning" ? `扫描文件中 · ${progress!.scannedFiles} 个`
              : progress!.phase === "indexing" ? `解析中 · ${progress!.currentFile}${progress!.detail ? ` · ${progress!.detail}` : ""}`
              : `向量嵌入中 · 本轮已处理 ${progress!.queuedChunks.toLocaleString("zh-CN")} 个片段`;
            return <div style={s.statusRow}>
              {active && <span style={s.stageSpinner} />}
              <span style={s.statusText} title={text}>{text}</span>
              {active && remaining > 0 && progress!.phase === "indexing" && <span style={s.statusText}>· 待解析 {remaining.toLocaleString("zh-CN")} 个文件</span>}
              {active && progress!.phase === "embedding" && stats && <span style={s.statusText}>· 已嵌入 {stats.embeddedChunks.toLocaleString("zh-CN")} / {stats.chunkCount.toLocaleString("zh-CN")} 个已生成片段</span>}
              {!active && pendingCount > 0 && kbSettings?.backgroundIndexing === false && <span style={s.statusText}>· 窗口关闭会暂停</span>}
              {failed > 0 && <span style={s.statusFailed}>{failed} 个失败</span>}
            </div>;
          })()}
        </div>
        {tab === "files" ? <>
          <div style={s.filterBar}>
            <div style={s.searchBox}>
              <span style={s.searchIcon}><SearchGlyph /></span>
              <input className="kb-search" aria-label="搜索文件" style={s.searchInput} value={searchInput} onChange={e => setSearchInput(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setSearchInput(""); }} placeholder="搜索文件名或路径…" />
              {searchInput && <button type="button" aria-label="清空搜索" style={s.searchClear} onClick={() => setSearchInput("")}>✕</button>}
            </div>
            <div style={s.chips} role="group" aria-label="文件类型">
              {kindChips.map(chip => <button key={chip.value} type="button" className={`kb-chip${kindFilter === chip.value ? " is-active" : ""}`} aria-pressed={kindFilter === chip.value} style={s.chip} onClick={() => setKindFilter(chip.value)}>
                {chip.label}{typeof chip.count === "number" && <span style={s.chipCount}>{chip.count.toLocaleString("zh-CN")}</span>}
              </button>)}
            </div>
            <select aria-label="按状态筛选" className="kb-mini-select" style={s.miniSelect} value={statusFilter} onChange={e => setStatusFilter(e.target.value as KnowledgeFileStatusFilter)}>
              <option value="all">全部状态</option><option value="queued">待处理</option><option value="failed">失败</option><option value="indexed">已完成</option>
            </select>
            <select aria-label="排序方式" title="按文件时间排序：有拍摄时间时使用拍摄时间，否则使用修改时间" className="kb-mini-select" style={{ ...s.miniSelect, ...s.sortSelect }} value={sort} onChange={e => setSort(e.target.value as KnowledgeFileSort)}>
              <option value="date-desc">文件时间（新→旧）</option>
              <option value="date-asc">文件时间（旧→新）</option>
              <option value="name-asc">文件名</option>
              <option value="size-desc">文件大小</option>
              <option value="added-desc">最近加入</option>
            </select>
            <div style={s.viewToggle} role="group" aria-label="视图">
              <button type="button" aria-label="网格视图" aria-pressed={view === "grid"} style={{ ...s.viewButton, ...(view === "grid" ? s.viewButtonOn : {}) }} onClick={() => changeView("grid")}><GridViewGlyph /></button>
              <button type="button" aria-label="列表视图" aria-pressed={view === "list"} style={{ ...s.viewButton, ...(view === "list" ? s.viewButtonOn : {}) }} onClick={() => changeView("list")}><ListViewGlyph /></button>
            </div>
          </div>
          <div style={s.panes} ref={panesRef}>
            <div style={{ ...s.listPane, width: detailOpen ? `${listWidth}%` : "100%" }}>
              <div ref={scrollRef} style={s.scroll} onScroll={onListScroll}>
                <div style={{ height: layoutTop, position: "relative" }} aria-label="文件列表" aria-busy={loadingFiles}>
                  {shownRows.map(row => row.label !== undefined
                    ? <div key={`header-${row.start}`} style={{ ...s.groupHeader, position: "absolute", top: row.top, left: 2, right: 2, height: row.height, boxSizing: "border-box" }}>{row.label}</div>
                    : <div key={`row-${row.start}`} style={{ position: "absolute", top: row.top, left: 2, right: 2, height: row.height - 8, display: "grid", gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap: 8 }}>
                      {Array.from({ length: row.count }, (_, i) => {
                        const file = indexedFiles[row.start + i];
                        return file ? (view === "grid" ? renderCard(file) : renderRow(file)) : <div key={`placeholder-${row.start + i}`} aria-label="正在加载文件" style={{ borderRadius: 8, background: "var(--surface-soft)", opacity: .65 }} />;
                      })}
                    </div>)}
                </div>
                {!fileTotal && !loadingFiles && <div style={s.emptyList}><FileTypeGlyph type="file" size={30} /><p style={s.emptyListText}>{searchText || kindFilter !== "all" || statusFilter !== "all" ? "没有匹配的文件，试试清空搜索或筛选。" : "正在等待文件扫描…"}</p></div>}
                {loadingFiles && !fileTotal && <div style={s.emptyList}><div style={s.spinner} /></div>}
              </div>
            </div>
            {detailOpen && <>
            <div role="separator" aria-orientation="vertical" aria-label="调整文件列表宽度" className="kb-splitter" style={s.splitter} onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize} onDoubleClick={() => setListWidth(38)} />
            <div style={s.detailPane}>{!current ? <div style={s.emptyDetail}>选择左侧文件，查看处理后的内容</div> : <>
              {current.status === "indexed" && current.coverage === "unknown" && <div role="status" style={{ padding: "8px 12px", color: "var(--ink-soft)" }}>旧索引的内容覆盖范围未知，可重新索引以检查。</div>}
              {current.status === "indexed" && current.error && <div role="status" style={{ padding: "8px 12px", color: "var(--ink-soft)" }}>{current.error}</div>}
              <div style={s.detailHeader}><div style={{ minWidth: 0 }}><strong style={s.fileName}>{fileBasename(current.path)}</strong><div style={s.fileSub}>{[typeLabel(current.type), formatBytes(current.size), `${current.chunkCount} 个片段`, metaLine(current)].filter(Boolean).join(" · ")}</div></div><div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <button type="button" className="kb-icon-btn kb-folder-icon" style={s.iconBtn} aria-label="打开原文件" onClick={() => openFile(current.path)}><FolderIcon /></button>
                <button type="button" className="kb-icon-btn" style={s.iconBtn} aria-label="重新分段和嵌入（优先处理）" title="重新分段和嵌入（优先处理）" onClick={() => { void api.reindexFile(current.id).then(() => refreshLibraryMeta()).catch(e => setError(String(e))); }}><RefreshIcon /></button>
                <button type="button" className="kb-icon-btn" style={s.iconBtn} aria-label="关闭详情" onClick={() => setSelected(null)}>✕</button>
              </div></div>
              {/* 进度文案只在顶部 tab 行显示，这里不再重复；仅在处理失败时给出原因 */}
              {current.status === "failed" && <div style={{ ...s.stageNote, ...s.stageFailed }}>
                <span style={s.statusText}>{`处理失败：${current.error ?? "未知错误"}`}</span>
              </div>}
              <div style={s.scroll}>{current.type === "video" && <VideoPreview key={current.path} filePath={current.path} playClipRef={playVideoClipRef} prepare={api.videoSource} onOpen={() => openFile(current.path)} />}
                {current.type === "image" && <figure style={s.previewFigure}>
                  {previewErrorPath === current.path
                    ? <div role="status" style={s.emptyDetail}>原图无法预览，文件可能已移动、删除或格式不受支持。<button type="button" style={s.link} onClick={() => openFile(current.path)}>用系统程序打开</button></div>
                    : <img key={current.path} src={localFileUrl(current.path)} alt={fileBasename(current.path)} decoding="async" style={s.previewImage} onError={() => setPreviewErrorPath(current.path)} onClick={() => openFile(current.path)} />}
                  <figcaption style={s.previewCaption}>{metaLine(current) || "点击图片用系统程序打开原图"}</figcaption>
                </figure>}
                {chunks.length === 0 && <div style={s.emptyDetail}>{current.status === "failed" ? "文件处理失败" : current.type === "image" ? "照片已进入索引队列，处理完成后这里会显示文字描述。" : "暂无片段，文件可能仍在处理中。"}</div>}
                {visibleChunks.map((c, i) => {
                  const info = chunkStageInfo(c);
                  const thumb = c.imagePath ? chunkThumbs[c.id] : undefined;
                  return <div style={s.chunk} key={c.id}>
                    <div style={s.chunkHead}>
                      <strong>片段 {i + 1}</strong>
                      <span style={info.accent ? { color: "#e8b25f" } : undefined}>{info.busy && <span style={s.stageSpinner} />}{info.label}</span>
                    </div>
                    {c.videoStart !== undefined && c.videoEnd !== undefined && <button type="button" style={s.clipPlayButton} aria-label={`播放片段 ${i + 1}`} onClick={() => playVideoClipRef.current?.(c.videoStart!, c.videoEnd!)}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.5 5.5v13l10.5-6.5z" /></svg> 播放片段
                    </button>}
                    {c.imagePath && <img src={localFileUrl(thumb ?? c.imagePath)} alt={c.headingPath || "文档原图"} loading="lazy" decoding="async" style={s.chunkImage} onClick={() => openFile(c.imagePath!)} />}
                    {c.imagePath || c.videoStart !== undefined ? null : c.text
                      ? <div style={s.chunkText}>{c.text}</div>
                      : <div style={s.chunkPlaceholder}>OCR 未识别到文字，等待大模型描述…</div>}
                  </div>;
                })}
                {detailChunks.length > chunkLimit && <button type="button" style={s.moreChunks} onClick={() => setChunkLimit(limit => limit + CHUNK_PAGE_SIZE)}>
                  显示更多片段（剩余 {(detailChunks.length - chunkLimit).toLocaleString("zh-CN")} 个）
                </button>}
              </div>
            </>}</div>
            </>}
          </div>
        </> : <div role="tabpanel" style={s.recallPanel}>
          <div style={s.recallForm}>
            <input aria-label="召回测试问题" style={s.recallInput} value={recallQuery} onChange={e => { recallRequestId.current++; setRecallQuery(e.target.value); setRecallResults(null); setRecallElapsed(null); setRecallError(""); setRecalling(false); setActiveRecallVideo(null); }} onKeyDown={e => { if (e.key === "Enter") void testRecall(); }} placeholder="输入查询内容，测试知识库能召回哪些片段" />
            <button className="kb-primary" style={s.primary} disabled={recalling || !recallQuery.trim()} onClick={() => void testRecall()}>{recalling ? "检索中…" : "开始测试"}</button>
          </div>
          <div style={s.audioRecall}>
            <button type="button" className={recording ? "kb-primary" : ""} style={recording ? s.primary : s.audioButton} disabled={audioBusy || recalling} onClick={() => { if (recording) stopRecording(); else void startRecording(); }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></svg>
              {audioBusy ? "语音检索中…" : recording ? `停止并检索（${recordSeconds}s）` : "录一段语音召回"}
            </button>
            <span style={s.muted}>{recording ? "正在录音，最长 15 秒，点按钮结束" : "录一段语音，直接检索视频里的音频片段"}</span>
          </div>
          <div style={s.recallOptions}>
            <label style={s.optionLabel}>召回数量 <input aria-label="召回数量" style={s.optionInput} type="number" min="1" max="50" step="1" value={recallLimit} onChange={e => setRecallLimit(e.target.value)} /></label>
            <label style={s.optionLabel}>分数阈值 <input aria-label="分数阈值" style={s.optionInput} type="number" min="0" max="0.03278" step="0.001" value={recallThreshold} onChange={e => setRecallThreshold(e.target.value)} /></label>
            <label style={s.optionLabel}>召回方式 <select aria-label="召回方式" style={s.optionSelect} value={recallMode} onChange={e => setRecallMode(e.target.value as "hybrid" | "dense" | "keyword")}><option value="hybrid">混合召回</option><option value="dense">语义召回</option><option value="keyword">关键词召回</option></select></label>
          </div>
          <div style={s.muted}>阈值按 RRF 排序分过滤（双路最高约 0.0328，单路最高约 0.0164），并非 0～1 相似度。{stats?.embeddedChunks === 0 && recallMode !== "keyword" ? "当前还没有可用向量，语义召回尚不可用。" : ""}</div>
          {recallElapsed !== null && <div style={s.recallMeta}>{recallSource === "audio" ? "语音召回" : "召回"} {recallResults?.length ?? 0} 条 · 耗时 {recallElapsed < 1000 ? `${Math.round(recallElapsed)} 毫秒` : `${(recallElapsed / 1000).toFixed(2)} 秒`}</div>}
          {recallError && <div role="alert" style={s.error}>{recallError}</div>}
          <div style={s.scroll}>
            {recallResults === null && !recalling && <div style={s.emptyDetail}>输入问题，查看匹配的文件和片段</div>}
            {recallResults?.length === 0 && <div style={s.emptyDetail}>没有召回结果，请尝试其他查询。</div>}
            {recallResults?.map((r, i) => <div style={s.chunk} key={r.chunkId}>
              <div style={s.chunkHead}><button type="button" style={s.recallTitle} onClick={() => openFile(r.filePath, setRecallError)}>#{i + 1} · {r.fileTitle}</button><span>{r.modality === "audio" ? "音频" : r.source === "both" ? "语义 + 关键词" : r.source === "dense" ? "语义" : "关键词"} · {r.score.toFixed(5)}</span></div>
              {r.headingPath && <div style={{ ...s.fileSub, whiteSpace: "normal", overflowWrap: "anywhere", marginBottom: 8 }}>{r.headingPath}</div>}
              {metaLine(r) && <div style={{ ...s.fileSub, whiteSpace: "normal", overflowWrap: "anywhere", marginBottom: 8 }}>{metaLine(r)}</div>}
              {r.videoStart !== undefined && r.videoEnd !== undefined && <div>
                <div style={s.fileSub}>{r.modality === "audio" ? "音频命中" : "视频画面命中"}：{r.videoStart.toFixed(1)}–{r.videoEnd.toFixed(1)} 秒{r.modality === "audio" ? "（音轨）" : "（画面采样）"}</div>
                {activeRecallVideo === r.chunkId ? <RecallVideo key={r.chunkId} result={r} prepare={api.videoSource} getThumbnail={api.videoThumbnail} onOpen={() => openFile(r.filePath, setRecallError)} />
                  : <RecallVideoThumbnail key={r.chunkId} chunkId={r.chunkId} getThumbnail={api.videoThumbnail} onPlay={() => setActiveRecallVideo(r.chunkId)} />}
              </div>}
              {r.imagePath && <img src={localFileUrl(chunkThumbs[r.chunkId] ?? r.imagePath)} alt={r.headingPath || "召回原图"} loading="lazy" decoding="async" style={s.chunkImage} onClick={() => openFile(r.imagePath!, setRecallError)} />}{r.text ? <div style={s.chunkText}>{r.text}</div> : null}
            </div>)}
          </div>
        </div>}
        </div>}
      </div>}
      {settings && <div style={s.overlay} onClick={() => setSettings(false)}><div role="dialog" aria-modal="true" aria-label="知识库设置" style={s.dialog} onClick={e => e.stopPropagation()}>
        <div style={s.dialogHead}><strong>知识库设置</strong><button style={s.link} aria-label="关闭设置" onClick={() => setSettings(false)}>✕</button></div>
        <div style={s.settingRow}>
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 14 }}>窗口关闭后继续索引</strong>
            <div style={s.muted}>首次导入大量照片/视频时建议开启：关掉知识库窗口后仍在后台解析，直到处理完或退出应用。</div>
          </div>
          <button type="button" role="switch" aria-checked={kbSettings?.backgroundIndexing !== false} aria-label="窗口关闭后继续索引" disabled={savingBackground} style={s.switchButton} onClick={() => void saveBackgroundIndexing(kbSettings?.backgroundIndexing === false)}>
            <span style={{ ...s.switchTrack, ...(kbSettings?.backgroundIndexing !== false ? s.switchTrackOn : {}) }}>
              <span style={{ ...s.switchThumb, ...(kbSettings?.backgroundIndexing !== false ? s.switchThumbOn : {}) }} />
            </span>
          </button>
        </div>
        {/* 向量模型是库级的（要读库目录），没进库时 models 为空，整块隐藏 */}
        {models.length > 0 && <>
        <div style={s.modelList}>{models.map(item => <section key={item.id} style={s.modelCard}>
          <div style={s.modelTitle}><strong>EmbeddingGemma 2 向量模型</strong><span style={item.ready ? s.good : s.muted}>{item.ready ? "已下载" : model?.phase === "downloading" ? "下载中" : "未就绪"}</span></div>
          <div style={s.modelPath}>{item.path}</div>
          <div style={s.modelTitle}><span style={s.muted}>本地大小：{formatBytes(item.size)}</span><button style={s.link} onClick={() => void api.openModelFolder(item.id).then(result => { if (!result.ok) setError(result.error || "无法打开文件夹"); })}>打开所在位置</button></div>
          {item.files.map(file => <div style={s.modelFile} key={file.name}><span>{file.name}</span><span>{formatBytes(file.size)} / {formatBytes(file.expectedSize)} {file.valid ? "✓" : "· 未完成"}</span></div>)}
          {!item.ready && (() => {
            const status = model;
            const downloading = status?.phase === "downloading";
            return <>
              {downloading && <><div style={s.note}>正在下载 {status.file || "模型"} {status.totalMB ? `· ${status.downloadedMB.toFixed(1)} / ${status.totalMB.toFixed(1)} MB` : ""}</div><div style={s.track}><div style={{ ...s.fill, width: `${Math.max(0, Math.min(100, status.percent))}%` }} /></div><div style={s.muted}>{Math.round(status.percent)}%（当前文件）</div></>}
              {status?.phase === "error" && <div style={s.error}>下载失败：{status.error}</div>}
              {!downloading && <button className="kb-primary" style={s.primary} onClick={() => void api.downloadModel(item.id).then(setModel)}>{status?.phase === "error" ? "重试下载" : "下载模型"}</button>}
            </>;
          })()}
        </section>)}</div>
        </>}
        <div style={s.imageModelSection}>
          <strong style={{ fontSize: 14 }}>图片识别模型</strong>
          {frameworks === null ? <div style={s.muted}>读取模型列表…</div> : (() => {
            const usable = frameworks.filter(f => f.models.length > 0);
            if (!usable.length) {
              const reasons = frameworks.map(f => f.error).filter(Boolean);
              return <div style={s.muted}>{reasons.length ? reasons.join("；") : "没有可用的模型"}</div>;
            }
            const active = usable.find(f => f.id === kbSettings?.imageModel?.framework) ?? usable[0];
            const selectedModel = kbSettings?.imageModel?.framework === active.id ? kbSettings.imageModel.model : "";
            const current = active.models.find(m => m.id === selectedModel);
            return <>
              {usable.length > 1 && <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {usable.map(f => <button
                  key={f.id}
                  type="button"
                  disabled={savingImageModel}
                  style={{ ...s.tabBtn, ...(f.id === active.id ? s.tabBtnOn : {}) }}
                  onClick={() => {
                    if (f.id === active.id || savingImageModel) return;
                    // 切框架要有可用模型：优先选一个「没被声明不支持图片」的
                    const first = f.models.find(m => m.supportsImages !== false) ?? f.models[0];
                    void saveImageModel({ framework: f.id, model: first.id });
                  }}
                >{f.name}</button>)}
              </div>}
              <ImageModelPicker
                models={active.models}
                currentId={selectedModel}
                current={current}
                disabled={savingImageModel}
                onSelect={model => void saveImageModel(model ? { framework: active.id, model } : null)}
              />
              <div style={s.muted}>
                {current ? `当前：${active.name} · ${current.name || current.id}` : "未选择，使用内置默认模型"}
                {savingImageModel ? " · 保存中…" : ""}
              </div>
            </>;
          })()}
        </div>
      </div></div>}
    </div>
  </WindowFrame>;
}

const s: Record<string, CSSProperties> = {
  listPage: { flex: 1, overflowY: "auto", padding: "8px 4px" },
  detailPage: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  // 标题行：固定 32px 高、无分割线，所有子项靠 flex 居中（不再被 padding 拉偏）
  topBar: { display: "flex", alignItems: "center", gap: 6, height: 32, padding: "0 4px", marginBottom: 10 },
  backBtn: { width: 28, height: 28, border: 0, borderRadius: 6, background: "transparent", color: "var(--ink)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 },
  topBarTitle: { fontSize: 15, fontWeight: 600, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  topAction: { background: "transparent", border: 0, borderRadius: 6, color: "var(--ink)", cursor: "pointer", whiteSpace: "nowrap", padding: "5px 8px", lineHeight: 1 },
  switch: { display: "inline-flex", alignItems: "center", cursor: "pointer" },
  switchTrack: { width: 32, height: 18, borderRadius: 9, background: "var(--line)", position: "relative", transition: "background 0.2s" },
  switchTrackOn: { background: "#3b82f6" },
  switchThumb: { position: "absolute", top: 2, left: 2, width: 14, height: 14, borderRadius: 7, background: "white", transition: "transform 0.2s" },
  switchThumbOn: { transform: "translateX(14px)" },
  listTitle: { margin: "0 0 16px", fontSize: 18, fontWeight: 600 },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 },
  createCard: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 110, border: "2px dashed var(--line)", borderRadius: 10, background: "transparent", color: "var(--ink)", cursor: "pointer", font: "inherit" },
  libCard: { position: "relative", display: "flex", flexDirection: "column", border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-soft)", overflow: "hidden", transition: "box-shadow .15s" },
  cardActions: { position: "absolute", bottom: 8, right: 8, display: "flex", gap: 4, zIndex: 2 },
  iconBtn: { width: 24, height: 24, border: 0, borderRadius: 6, background: "var(--focus-body-bg)", color: "var(--ink-soft)", cursor: "pointer", fontSize: 12, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px #0002" },
  cardMain: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4, padding: "14px 14px 10px", border: 0, background: "transparent", color: "var(--ink)", cursor: "pointer", font: "inherit", textAlign: "left", flex: 1, paddingBottom: 28 },
  cardName: { fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" },
  cardStats: { display: "flex", gap: 10, fontSize: 11, color: "var(--ink-soft)" },
  switchRow: { display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderTop: "1px solid var(--line)", fontSize: 11, color: "var(--ink-soft)", cursor: "default" },
  spinner: { width: 28, height: 28, border: "3px solid var(--line)", borderTopColor: "var(--ink)", borderRadius: "50%", animation: "spin 0.8s linear infinite" },
  createInput: { width: "100%", padding: "10px 12px", background: "var(--surface-soft)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--ink)", font: "inherit", boxSizing: "border-box" },
  container: { userSelect: "text", position: "relative", display: "flex", flexDirection: "column", flex: 1, minHeight: 0, padding: 16, gap: 12, background: "var(--focus-body-bg)", color: "var(--ink)", fontSize: 13 },
  settingsButton: { position: "absolute", right: 14, top: 4, width: 30, height: 30, border: 0, borderRadius: 6, background: "transparent", cursor: "pointer", color: "inherit", fontSize: 19, pointerEvents: "auto" },
  empty: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center" },
  primary: { border: 0, borderRadius: 8, background: "var(--send-bg, var(--ink))", color: "var(--send-ink, var(--focus-body-bg))", padding: "9px 18px", cursor: "pointer" },
  link: { background: "none", border: 0, borderRadius: 6, color: "var(--ink)", cursor: "pointer", whiteSpace: "nowrap", padding: "4px 6px" },
  folderBar: { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 9, background: "var(--surface)", marginBottom: 12 },
  folderName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 },
  cards: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 },
  // 卡片内容单行：数值 + 标签同一行，整体高度 ~30px
  card: { display: "flex", alignItems: "baseline", gap: 6, padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 9, background: "var(--surface)", overflow: "hidden" },
  cardValue: { fontSize: 15, fontWeight: 600, lineHeight: 1.2, whiteSpace: "nowrap" },
  cardLabel: { color: "var(--ink-soft)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  cardSub: { color: "var(--ink-soft)", fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  muted: { color: "var(--ink-soft)", fontSize: 12 }, note: { background: "var(--surface-soft)", borderRadius: 7, padding: "8px 10px", color: "var(--ink-soft)", fontSize: 12 },
  // 状态行与 tab 同排靠右：右侧长文本一律省略，不再单独占一行
  // tabRow 单独留出下间距：容器 gap(12) + 6 = 18，下划线不会贴住下面的面板
  tabRow: { display: "flex", alignItems: "center", gap: 12, marginTop: 8, marginBottom: 6 },
  statusRow: { marginLeft: "auto", minWidth: 0, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, overflow: "hidden", color: "var(--ink-soft)", fontSize: 12 },
  statusText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  statusFailed: { flexShrink: 0, color: "#df4747" },
  error: { background: "color-mix(in srgb, #df4747 15%, var(--focus-body-bg))", color: "var(--ink)", padding: "8px 10px", borderRadius: 7, overflowWrap: "anywhere" },
  // tab 不要底色/圆角：下划线要直，hover 也不铺底（CSS 里已排除 [role=tab]）
  tabs: { display: "flex", gap: 14, flexShrink: 0 },
  tab: { padding: "5px 2px", borderRadius: 0, border: 0, background: "transparent", color: "var(--ink-soft)", cursor: "pointer", font: "inherit" },
  tabActive: { color: "var(--ink)", borderBottom: "2px solid var(--ink)", fontWeight: 600 },
  recallPanel: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 10 },
  recallForm: { display: "flex", gap: 8 },
  audioRecall: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-soft)" },
  audioButton: { display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-strong)", color: "var(--ink)", padding: "7px 12px", cursor: "pointer", font: "inherit", fontSize: 12 },
  recallOptions: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px 16px" },
  optionLabel: { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ink-soft)", fontSize: 12 },
  optionInput: { width: 82, padding: "5px 7px", color: "var(--ink)", background: "var(--surface-soft)", border: "1px solid var(--line)", borderRadius: 6, font: "inherit" },
  optionSelect: { padding: "5px 7px", color: "var(--ink)", background: "var(--focus-body-bg)", border: "1px solid var(--line)", borderRadius: 6, font: "inherit" },
  recallTitle: { padding: 0, border: 0, background: "transparent", color: "var(--ink)", font: "inherit", fontWeight: 600, cursor: "pointer", textAlign: "left", textDecoration: "underline", textUnderlineOffset: 3 },
  recallMeta: { color: "var(--ink)", fontSize: 12, fontWeight: 600 },
  recallInput: { flex: 1, minWidth: 0, padding: "9px 12px", background: "var(--surface-soft)", color: "var(--ink)", border: "1px solid var(--line)", borderRadius: 8, font: "inherit", userSelect: "text" },
  panes: { display: "flex", flex: 1, minHeight: 0, gap: 12 },
  listPane: { width: "32%", minWidth: 180, border: "1px solid var(--line)", borderRadius: 9, display: "flex", flexDirection: "column", overflow: "hidden" },
  scroll: { overflowY: "auto", minHeight: 0, flex: 1, padding: "0 8px 8px" },
  file: { display: "flex", flexDirection: "column", gap: 4, width: "100%", padding: "10px", textAlign: "left", border: 0, borderRadius: 7, background: "transparent", cursor: "pointer", color: "var(--ink)" },
  fileSelected: { background: "var(--hover)", color: "var(--ink)" }, fileName: { userSelect: "text", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }, fileSub: { userSelect: "text", fontSize: 11, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" },
  detailPane: { flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", border: "1px solid var(--line)", borderRadius: 9, overflow: "hidden" },
  emptyDetail: { color: "var(--ink-soft)", textAlign: "center", margin: "auto", padding: 30 },
  detailHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 14px", borderBottom: "1px solid var(--line)" },
  videoPreview: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 },
  videoTitle: { color: "var(--ink)", fontSize: 12 },
  videoLoadingFrame: { position: "relative", width: "100%", aspectRatio: "16 / 9", overflow: "hidden", borderRadius: 8, background: "#000", display: "flex", alignItems: "center", justifyContent: "center" },
  videoLoadingImage: { width: "100%", height: "100%", objectFit: "contain" },
  videoLoadingLabel: { position: "absolute", bottom: 8, left: 8, padding: "4px 7px", borderRadius: 5, color: "white", background: "rgba(0,0,0,.7)", fontSize: 12 },
  videoPlayer: { display: "block", width: "100%", maxHeight: 360, aspectRatio: "16 / 9", objectFit: "contain", background: "#000", borderRadius: 8 },
  fileMenu: { position: "absolute", zIndex: 50, width: 195, padding: 5, border: "1px solid var(--line)", borderRadius: 8, background: "var(--focus-body-bg)", color: "var(--ink)", boxShadow: "0 8px 24px #0005" },
  fileMenuItem: { display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 8px", border: 0, borderRadius: 5, background: "transparent", color: "var(--ink)", cursor: "pointer", font: "inherit", textAlign: "left" },
  fileMenuDivider: { height: 1, margin: "4px 2px", background: "var(--line)" },
  recallThumbnailGroup: { display: "flex", alignItems: "flex-start", flexDirection: "column", gap: 8, marginTop: 8 },
  recallThumbnail: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "min(100%, 360px)", aspectRatio: "16 / 9", overflow: "hidden", padding: 0, border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-soft)", color: "var(--ink-soft)", cursor: "pointer" },
  recallThumbnailImage: { display: "block", width: "100%", height: "100%", objectFit: "contain", background: "#000" },
  recallThumbnailStatus: { fontSize: 12 },
  recallThumbnailPlay: { position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", display: "flex", justifyContent: "center", alignItems: "center", width: 42, height: 42, borderRadius: "50%", background: "rgba(0,0,0,.68)", color: "white", pointerEvents: "none" },
  videoClipLabel: { color: "var(--ink-soft)", fontSize: 12 },
  clipPlayButton: { display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid var(--line)", borderRadius: 6, padding: "5px 9px", background: "var(--surface-soft)", color: "var(--ink)", cursor: "pointer", font: "inherit", fontSize: 12 },
  videoControls: { display: "flex", alignItems: "center", gap: 8 },
  videoButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, flexShrink: 0, border: "1px solid var(--line)", borderRadius: 6, padding: 0, background: "var(--surface-soft)", color: "var(--ink)", cursor: "pointer" },
  videoSeek: { flex: 1, minWidth: 0, cursor: "pointer" },
  videoTime: { fontSize: 11, color: "var(--ink-soft)", fontVariantNumeric: "tabular-nums" },
  videoFallback: { color: "var(--ink-soft)", fontSize: 12, lineHeight: 1.6, padding: "12px", border: "1px solid var(--line)", borderRadius: 8 },
  chunk: { border: "1px solid var(--line)", borderRadius: 8, padding: 12, marginBottom: 8 }, chunkHead: { display: "flex", justifyContent: "space-between", gap: 8, color: "var(--ink-soft)", fontSize: 11, marginBottom: 8 }, chunkText: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.6, color: "var(--ink)" },
  chunkPlaceholder: { color: "var(--ink-soft)", fontSize: 12, fontStyle: "italic" },
  stageSpinner: { display: "inline-block", width: 9, height: 9, marginRight: 6, borderRadius: "50%", border: "2px solid var(--line)", borderTopColor: "var(--ink)", animation: "spin 0.8s linear infinite", verticalAlign: "-1px" },
  stageNote: { display: "flex", alignItems: "center", padding: "4px 14px 8px", color: "#e8b25f", fontSize: 12 },
  stageFailed: { color: "#df4747" },
  modelList: { display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", marginTop: 14 },
  modelCard: { border: "1px solid var(--line)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 7 },
  modelTitle: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  modelPath: { color: "var(--ink-soft)", fontSize: 12, overflowWrap: "anywhere", userSelect: "text" },
  modelFile: { display: "flex", justifyContent: "space-between", gap: 8, color: "var(--ink-soft)", fontSize: 11 },
  imageModelSection: { marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 8 },
  tabBtn: { padding: "5px 12px", borderRadius: 999, border: "1px solid var(--line)", background: "transparent", color: "var(--ink-soft)", cursor: "pointer", font: "inherit", fontSize: 12 },
  tabBtnOn: { background: "var(--surface-strong)", color: "var(--ink)" },
  select: { width: "100%", padding: "9px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-soft)", color: "var(--ink)", font: "inherit" },
  modelTrigger: { width: "100%", padding: "9px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-soft)", color: "var(--ink)", font: "inherit", display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left", cursor: "pointer", gap: 8 },
  modelMenu: { maxHeight: 260, overflowY: "auto", background: "var(--focus-body-bg)", border: "1px solid var(--line)", borderRadius: 8, boxShadow: "0 10px 30px rgba(0,0,0,.4)", padding: 4 },
  modelOption: { display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: 0, borderRadius: 6, background: "transparent", color: "var(--ink)", font: "inherit", fontSize: 13, cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  overlay: { position: "absolute", inset: 0, zIndex: 10, background: "rgba(20,18,28,.35)", display: "flex", alignItems: "center", justifyContent: "center" }, dialog: { userSelect: "text", width: "min(560px, 90%)", maxHeight: "90%", overflowY: "auto", display: "flex", flexDirection: "column", borderRadius: 12, padding: 22, background: "var(--focus-body-bg)", color: "var(--ink)", boxShadow: "0 16px 50px #0003" }, dialogHead: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 16 }, good: { color: "var(--ink)", background: "var(--surface-soft)", padding: 10, borderRadius: 7 }, track: { height: 6, background: "var(--surface-strong)", borderRadius: 4, overflow: "hidden", margin: "12px 0 6px" }, fill: { height: "100%", background: "var(--send-bg, var(--ink))", transition: "width .2s" },

  // ─── 文件浏览器：筛选栏 / 网格 / 列表 / 详情 ─────────────
  filterBar: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0, marginBottom: 12 },
  searchBox: { display: "flex", alignItems: "center", gap: 6, flex: "1 1 200px", minWidth: 160, maxWidth: 320, padding: "0 8px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-soft)", height: 30, boxSizing: "border-box" },
  searchIcon: { display: "flex", color: "var(--ink-soft)", flexShrink: 0 },
  searchInput: { flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", color: "var(--ink)", font: "inherit", fontSize: 12, height: "100%" },
  searchClear: { flexShrink: 0, border: 0, background: "transparent", color: "var(--ink-soft)", cursor: "pointer", fontSize: 11, padding: 2, lineHeight: 1 },
  chips: { display: "flex", alignItems: "center", gap: 4, flexShrink: 0 },
  chip: { display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 9px", border: "1px solid var(--line)", borderRadius: 999, background: "transparent", color: "var(--ink-soft)", cursor: "pointer", font: "inherit", fontSize: 12, lineHeight: 1.2 },
  chipCount: { fontSize: 10, opacity: 0.65, fontVariantNumeric: "tabular-nums" },
  miniSelect: { height: 30, maxWidth: 132, padding: "0 6px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-soft)", color: "var(--ink)", font: "inherit", fontSize: 12, cursor: "pointer" },
  sortSelect: { maxWidth: "100%", flexShrink: 0, paddingRight: 24 },
  viewToggle: { display: "flex", alignItems: "center", gap: 2, marginLeft: "auto", padding: 2, border: "1px solid var(--line)", borderRadius: 8, flexShrink: 0 },
  viewButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 26, height: 24, padding: 0, border: 0, borderRadius: 6, background: "transparent", color: "var(--ink-soft)", cursor: "pointer" },
  viewButtonOn: { background: "var(--surface-strong)", color: "var(--ink)" },
  group: { marginBottom: 12 },
  groupHeader: { display: "flex", alignItems: "baseline", gap: 8, padding: "10px 2px 8px", position: "sticky", top: 0, zIndex: 1, background: "var(--focus-body-bg)", color: "var(--ink)", fontSize: 12, fontWeight: 600 },
  groupCount: { color: "var(--ink-soft)", fontSize: 11, fontWeight: 400 },
  fileCard: { display: "flex", flexDirection: "column", alignItems: "stretch", gap: 4, width: "100%", minWidth: 0, padding: 6, border: "1px solid var(--line)", borderRadius: 9, background: "var(--surface)", color: "var(--ink)", cursor: "pointer", font: "inherit", textAlign: "left", overflow: "hidden" },
  fileCardThumb: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", aspectRatio: "1 / 1", overflow: "hidden", borderRadius: 6, background: "var(--surface-soft)", color: "var(--ink-soft)" },
  fileCardGlyph: { display: "flex", alignItems: "center", justifyContent: "center", opacity: 0.75 },
  fileCardName: { fontSize: 12, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" },
  fileCardMeta: { color: "var(--ink-soft)", fontSize: 10.5, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  badgePlay: { position: "absolute", left: 6, top: 6, display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, borderRadius: 11, background: "rgba(0,0,0,.62)", color: "white", pointerEvents: "none" },
  badgePending: { position: "absolute", right: 5, bottom: 5, padding: "2px 5px", borderRadius: 5, background: "rgba(20,18,28,.72)", color: "#fff", fontSize: 10, lineHeight: 1.2, pointerEvents: "none" },
  badgeFailed: { position: "absolute", right: 5, bottom: 5, padding: "2px 5px", borderRadius: 5, background: "#df4747", color: "#fff", fontSize: 10, lineHeight: 1.2, pointerEvents: "none" },
  rowThumb: { display: "flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, flexShrink: 0, overflow: "hidden", borderRadius: 6, background: "var(--surface-soft)", color: "var(--ink-soft)" },
  rowText: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 },
  rowFailed: { flexShrink: 0, width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, background: "#df4747", color: "#fff", fontSize: 11, fontWeight: 700 },
  emptyList: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 160, color: "var(--ink-soft)" },
  emptyListText: { margin: 0, fontSize: 12, lineHeight: 1.6, textAlign: "center" },
  listFooter: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 10px", borderTop: "1px solid var(--line)", color: "var(--ink-soft)", fontSize: 11, flexShrink: 0 },
  splitter: { flex: "0 0 8px", alignSelf: "stretch", margin: "0 -4px", borderRadius: 4, cursor: "col-resize", background: "transparent", touchAction: "none" },
  previewFigure: { margin: "0 0 14px", display: "flex", flexDirection: "column", gap: 6 },
  previewImage: { display: "block", width: "100%", maxHeight: "58vh", objectFit: "contain", borderRadius: 8, background: "var(--surface-soft)", cursor: "zoom-in" },
  thumbPreviewImage: { display: "block", maxWidth: "100%", maxHeight: 360, objectFit: "contain", borderRadius: 8, background: "var(--surface-soft)", cursor: "zoom-in" },
  previewCaption: { color: "var(--ink-soft)", fontSize: 11, userSelect: "text" },
  chunkImage: { display: "block", maxWidth: "100%", maxHeight: 320, objectFit: "contain", borderRadius: 6, cursor: "zoom-in", margin: "4px 0" },
  moreChunks: { width: "100%", padding: "8px 10px", marginBottom: 8, border: "1px dashed var(--line)", borderRadius: 8, background: "transparent", color: "var(--ink-soft)", cursor: "pointer", font: "inherit", fontSize: 12 },
  settingRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line)" },
  switchButton: { flexShrink: 0, display: "inline-flex", alignItems: "center", padding: 2, border: 0, background: "transparent", cursor: "pointer" },
};
