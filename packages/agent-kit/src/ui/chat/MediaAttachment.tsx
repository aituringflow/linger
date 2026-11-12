"use client";

import { useChatTranslation } from "./i18n.tsx";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClickOutside } from "../useClickOutside.ts";
import type { UiAttachment } from "./types.ts";
import { isAudioFile, isImageFile, isVideoFile } from "./messageUtils.ts";
import { AudioIcon, NavigationChevronIcon } from "../icons/SharedIcons.tsx";
import { DownloadIcon } from "../icons/ActionIcons.tsx";

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
const ZOOM_STEP = 1.25;
export type ImageGalleryItem = { key: string; name: string; url: string };

/** 音频播放控制图标（消息内播放按钮用，实心描边风格） */
function AudioPlayIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5v13l10.5-6.5z" /></svg>;
}
function AudioPauseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5h3.4v14H7.5zM13.1 5h3.4v14h-3.4z" /></svg>;
}
function AudioStopIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.6" /></svg>;
}

export default function MediaAttachment({ file, url, onUnavailable, gallery, galleryKey }: { file: UiAttachment; url: string; onUnavailable?: () => void; gallery?: ImageGalleryItem[]; galleryKey?: string }) {
  const t = useChatTranslation();
  const video = isVideoFile(file);
  const image = isImageFile(file);
  const audio = isAudioFile(file);
  const [open, setOpen] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  /** 音频：播放/暂停/停止控制状态（初始只有播放按钮，播放中出现停止按钮） */
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioStarted, setAudioStarted] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const zoomRef = useRef(1);
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);
  zoomRef.current = zoom;
  // 图片右键菜单：点击菜单之外任意处或 Esc 关闭（菜单内点击不关闭，项各自处理）
  useClickOutside({
    enabled: menu !== null,
    exceptSelectors: [".msg-media-context-menu"],
    onDismiss: () => setMenu(null),
  });
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", close);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", close); document.body.style.overflow = previous; };
  }, [open]);
  // 图片预览：滚轮以鼠标位置为锚点缩放
  useEffect(() => {
    if (!open || !image) return;
    const el = contentRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const prev = zoomRef.current;
      // 把 wheel 事件归一化为"格"：行模式(deltaMode=1)按滚轮格计（通常每格 3），
      // 像素模式按 100px 一格，触控板平滑滚动则按比例取极小步长，避免一次手势直接打满。
      const amount = event.deltaMode === 1 ? event.deltaY / 3 : event.deltaY / 100;
      // 向上滚（deltaY<0）放大、向下滚缩小；负号用于抵消 deltaY 的符号
      const factor = Math.pow(ZOOM_STEP, -amount);
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * factor));
      if (next === prev) return;
      const rect = el.getBoundingClientRect();
      const x = rect.width > 0 ? ((event.clientX - rect.left) / rect.width) * 100 : 50;
      const y = rect.height > 0 ? ((event.clientY - rect.top) / rect.height) * 100 : 50;
      const img = el.querySelector("img");
      const w0 = img?.clientWidth ?? 0;
      const h0 = img?.clientHeight ?? 0;
      const ox = ((x - 50) / 100) * w0;
      const oy = ((y - 50) / 100) * h0;
      setOrigin({ x, y });
      setPan(p => ({ x: p.x + ox * (prev - next), y: p.y + oy * (prev - next) }));
      setZoom(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open, image]);
  if (!image && !video && !audio) return null;
  const galleryIndex = gallery?.findIndex(item => item.key === (selectedKey ?? galleryKey)) ?? -1;
  const selectedImage = image && galleryIndex >= 0 ? gallery![galleryIndex] : { name: file.name, url };
  const downloadTarget = open && image ? selectedImage : { name: file.name, url };
  const downloadUrl = `${downloadTarget.url}${downloadTarget.url.includes("?") ? "&" : "?"}download=1`;
  const downloadFile = (event: React.MouseEvent<HTMLAnchorElement>) => {
    const desktop = (window as Window & { agentHost?: { download?: (url: string, name: string) => Promise<unknown> } }).agentHost;
    if (desktop?.download) { event.preventDefault(); void desktop.download(downloadUrl, downloadTarget.name); }
  };
  // 音频：消息内内联播放。初始只有播放按钮；点击播放后按钮变暂停图标并出现停止按钮；
  // 暂停后再点播放继续，停止后回到初始态。下载入口在消息「更多」菜单里，这里不放额外按钮。
  if (audio) {
    const toggleAudio = () => {
      const el = audioRef.current;
      if (!el || onUnavailable) return;
      if (audioPlaying) el.pause();
      else void el.play().catch(() => {});
    };
    const stopAudio = () => {
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      el.currentTime = 0;
      setAudioPlaying(false);
      setAudioStarted(false);
    };
    return <div className="msg-audio" title={file.name}>
      <span className="msg-audio-icon" aria-hidden="true"><AudioIcon /></span>
      <span className="msg-audio-name">{file.name}</span>
      {onUnavailable
        ? <span className="msg-audio-unavailable" role="note">{t("unavailable")}</span>
        : <span className="msg-audio-controls">
            <button type="button" className="msg-audio-play" aria-label={t(audioPlaying ? "pauseNamed" : "playNamed", { name: file.name })} onClick={toggleAudio}>
              {audioPlaying ? <AudioPauseIcon /> : <AudioPlayIcon />}
            </button>
            {audioStarted ? <button type="button" className="msg-audio-stop" aria-label={t("stopNamed", { name: file.name })} onClick={stopAudio}><AudioStopIcon /></button> : null}
          </span>}
      <audio ref={audioRef} src={url} preload="metadata"
        onPlay={() => { setAudioPlaying(true); setAudioStarted(true); }}
        onPause={() => setAudioPlaying(false)}
        onEnded={() => { setAudioPlaying(false); setAudioStarted(false); }} />
    </div>;
  }
  const zoomBy = (factor: number) => {
    const prev = zoomRef.current;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev * factor));
    if (next === prev) return;
    setZoom(next);
  };
  const resetView = () => { setZoom(1); setOrigin({ x: 50, y: 50 }); setPan({ x: 0, y: 0 }); };
  const openLightbox = () => { resetView(); setSelectedKey(galleryKey ?? null); setOpen(true); };
  const selectImage = (offset: number) => {
    const next = gallery?.[galleryIndex + offset];
    if (!next) return;
    resetView();
    setSelectedKey(next.key);
  };
  const onPointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startY: event.clientY, panX: pan.x, panY: pan.y };
    setDragging(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPan({ x: drag.panX + event.clientX - drag.startX, y: drag.panY + event.clientY - drag.startY });
  };
  const endDrag = () => { dragRef.current = null; setDragging(false); };
  return <>
    <button type="button" className="msg-media" aria-label={t(video ? "previewVideo" : "previewImage", { name: file.name })} title={file.name}
      onContextMenu={image ? event => { event.preventDefault(); setMenu({ x: Math.min(event.clientX, window.innerWidth - 180), y: Math.min(event.clientY, window.innerHeight - 56) }); } : undefined}
      onClick={() => { if (onUnavailable) onUnavailable(); else openLightbox(); }}>
      {video ? <video src={url} preload="metadata" muted playsInline aria-hidden="true" /> : <img src={url} alt="" loading="lazy" />}
      {video ? <span className="msg-media-play" aria-hidden="true">▶</span> : null}
    </button>
    {menu ? createPortal(<div className="msg-media-context-menu" role="menu" style={{ left: Math.max(8, menu.x), top: Math.max(8, menu.y) }}>
      <a role="menuitem" href={downloadUrl} download={file.name} onClick={downloadFile}>{t("downloadOriginal")}</a>
    </div>, document.body) : null}
    {open ? createPortal(<div className="msg-media-lightbox" role="dialog" aria-modal="true" aria-label={selectedImage.name} onClick={() => setOpen(false)}>
      <div className="msg-media-lightbox-bar" onClick={event => event.stopPropagation()}>
        <div className="msg-media-lightbox-navigation">
          {image && gallery && gallery.length > 1 ? <>
            <button type="button" className="msg-media-lightbox-zoom msg-media-lightbox-nav" title={t("previousShort")} aria-label={t("previousImage")} disabled={galleryIndex <= 0} onClick={() => selectImage(-1)}><NavigationChevronIcon direction="left" /></button>
            <button type="button" className="msg-media-lightbox-zoom msg-media-lightbox-nav" title={t("nextShort")} aria-label={t("nextImage")} disabled={galleryIndex >= gallery.length - 1} onClick={() => selectImage(1)}><NavigationChevronIcon direction="right" /></button>
          </> : null}
        </div>
        <div className="msg-media-lightbox-tools">
          {image ? <>
          <button type="button" className="msg-media-lightbox-zoom" title={t("zoomOut")} aria-label={t("zoomOut")} onClick={() => zoomBy(1 / ZOOM_STEP)}>−</button>
          <button type="button" className="msg-media-lightbox-zoom msg-media-lightbox-zoom-label" title={t("resetZoom")} aria-label={t("zoomCurrent", { percent: Math.round(zoom * 100) })} onClick={resetView}>{Math.round(zoom * 100)}%</button>
          <button type="button" className="msg-media-lightbox-zoom" title={t("zoomIn")} aria-label={t("zoomIn")} onClick={() => zoomBy(ZOOM_STEP)}>+</button>
          </> : null}
        </div>
        <div className="msg-media-lightbox-actions">
          {image ?
          <a className="msg-media-lightbox-download" href={downloadUrl} download={selectedImage.name} onClick={downloadFile} aria-label={t("downloadImage")} title={t("download")}><DownloadIcon /></a>
          : null}
          <button type="button" className="msg-media-lightbox-close" onClick={() => setOpen(false)} aria-label={t("closePreview")}>×</button>
        </div>
      </div>
      <div className="msg-media-lightbox-content" ref={contentRef} onClick={event => event.stopPropagation()}>
        {video ? <video src={url} controls autoPlay playsInline /> : <img src={selectedImage.url} alt={selectedImage.name} draggable={false}
          className={dragging ? "msg-media-lightbox-img msg-media-lightbox-dragging" : "msg-media-lightbox-img"}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: `${origin.x}% ${origin.y}%` }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
          onDoubleClick={resetView} />}
      </div>
    </div>, document.body) : null}
  </>;
}
