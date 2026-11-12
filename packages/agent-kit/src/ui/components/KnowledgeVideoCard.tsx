import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type VideoReference = { libraryId: string; chunkId: number; hash: string; startMs: number; endMs: number };
type VideoResult = { path?: string; bytes?: Uint8Array; start: number; end: number; title: string };
type Playback = { url: string; start: number; end: number; title: string };
type KnowledgeVideoApi = { chatVideo(libraryId: string, chunkId: number, hash: string, startMs: number, endMs: number, kind: "thumbnail" | "play"): Promise<VideoResult> };

/** Only the application's reserved identifier is interpreted as a local video card. */
export function parseKnowledgeVideoReference(href?: string): VideoReference | null {
  const match = /^https:\/\/local-knowledge\.invalid\/v1\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d+)\/([0-9a-f]{64})\/(\d+)\/(\d+)$/i.exec(href ?? "");
  if (!match) return null;
  const chunkId = Number(match[2]), startMs = Number(match[4]), endMs = Number(match[5]);
  if (!Number.isSafeInteger(chunkId) || chunkId < 1 || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) return null;
  return { libraryId: match[1], chunkId, hash: match[3], startMs, endMs };
}

function localFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return `local-file://${encodeURI(normalized.startsWith("/") ? normalized : `/${normalized}`).replace(/[?#]/g, c => c === "?" ? "%3F" : "%23")}`;
}

/** A validated knowledge reference resolves on demand; messages never embed filesystem paths. */
export function KnowledgeVideoCard({ reference, references = [reference] }: { reference: VideoReference; references?: VideoReference[]; children: ReactNode }) {
  const api = typeof window === "undefined" ? undefined : (window as Window & { launcher?: { knowledge?: KnowledgeVideoApi } }).launcher?.knowledge;
  const { libraryId, chunkId, hash, startMs, endMs } = reference;
  const [thumbnail, setThumbnail] = useState<string>();
  const [video, setVideo] = useState<Playback>();
  const [pending, setPending] = useState(false);
  const [activeChunk, setActiveChunk] = useState<number>();
  const [error, setError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setThumbnail(undefined); setVideo(undefined); setError(""); setPending(false);
    if (api?.chatVideo) void api.chatVideo(libraryId, chunkId, hash, startMs, endMs, "thumbnail").then(result => { if (generation.current === current) setThumbnail(result.path); }).catch(() => {});
    return () => { generation.current++; };
  }, [api, libraryId, chunkId, hash, startMs, endMs]);
  useEffect(() => () => { if (video) URL.revokeObjectURL(video.url); }, [video]);
  const start = async (selected: VideoReference) => {
    if (!api?.chatVideo || pending) return;
    const current = generation.current;
    setPending(true); setError("");
    try {
      const result = await api.chatVideo(selected.libraryId, selected.chunkId, selected.hash, selected.startMs, selected.endMs, "play");
      if (generation.current === current) {
        if (!result.bytes?.length) throw new Error("视频片段为空");
        const bytes = Uint8Array.from(result.bytes);
        setActiveChunk(selected.chunkId);
        setVideo({ url: URL.createObjectURL(new Blob([bytes.buffer], { type: "video/webm" })), start: result.start, end: result.end, title: result.title });
      }
    } catch (e) { if (generation.current === current) setError(e instanceof Error ? e.message : String(e)); }
    finally { if (generation.current === current) setPending(false); }
  };
  const style: Record<string, CSSProperties> = {
    card: { display: "inline-flex", flexDirection: "column", gap: 6, width: "min(100%, 360px)", maxWidth: "100%", margin: "6px 0", verticalAlign: "top" },
    frame: { position: "relative", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", aspectRatio: "16 / 9", overflow: "hidden", padding: 0, border: "1px solid var(--line, #777)", borderRadius: 8, background: "#151515", color: "white", cursor: "pointer" },
    image: { width: "100%", height: "100%", objectFit: "contain" },
    icon: { position: "absolute", display: "flex", alignItems: "center", justifyContent: "center", width: 42, height: 42, borderRadius: "50%", background: "rgba(0,0,0,.7)", color: "white" },
    caption: { color: "var(--ink-soft, #777)", fontSize: 12, lineHeight: 1.4 },
    video: { display: "block", width: "100%", aspectRatio: "16 / 9", objectFit: "contain", borderRadius: 8, background: "#000" },
  };
  return <span style={style.card}>
    {video ? <video ref={videoRef} style={style.video} src={video.url} poster={thumbnail ? localFileUrl(thumbnail) : undefined} controls playsInline preload="metadata"
      onLoadedMetadata={event => { const player = event.currentTarget; player.currentTime = 0; void player.play().catch(() => {}); }}
      onPlay={event => { const player = event.currentTarget; if (player.ended) player.currentTime = 0; }}
      onError={event => { const e = event.currentTarget.error; setVideo(undefined); setError(`视频无法播放（${e?.code ?? "未知"}${e?.message ? `：${e.message}` : ""}），请重试。`); }} />
      : <button type="button" aria-label="播放知识库视频片段" disabled={pending || !api?.chatVideo} style={style.frame} onClick={() => void start(reference)}>
        {thumbnail && <img src={localFileUrl(thumbnail)} style={style.image} alt="" />}
        <span aria-hidden="true" style={style.icon}>{pending ? "…" : "▶"}</span>
      </button>}
    <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }} aria-label="召回片段">
      {references.map((item, index) => <button key={`${item.chunkId}-${item.startMs}-${item.endMs}`} type="button" disabled={pending || !api?.chatVideo} aria-pressed={activeChunk === item.chunkId} onClick={() => void start(item)} style={{ color: "var(--ink, inherit)", background: activeChunk === item.chunkId ? "var(--surface-hover, rgba(128,128,128,.2))" : "transparent", border: "1px solid var(--line, #777)", borderRadius: 6, padding: "5px 8px", cursor: "pointer" }}>▶ 片段 {index + 1}　{formatTime(item.startMs)}–{formatTime(item.endMs)}</button>)}
    </span>
    {pending && <span style={style.caption}>正在准备视频…</span>}
    {error && <span role="alert" style={style.caption}>{error}</span>}
  </span>;
}

function formatTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
