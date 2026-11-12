import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import type { EmbeddingProvider } from "./embedding.js";

const exec = promisify(execFile);
const ffmpeg = (ffmpegPath || "").replace(/\.asar([/\\])/, ".asar.unpacked$1");
export const VIDEO_SEGMENT_SECONDS = 5;

/** A failure specific to a video or audio window, rather than the embedding model. */
export class VideoWindowError extends Error {
  constructor(message: string, readonly silent = false) { super(message); this.name = "VideoWindowError"; }
}

/** Probe with the same packaged FFmpeg used for frame extraction. */
export async function videoDuration(file: string, signal?: AbortSignal): Promise<number> {
  if (!ffmpeg) throw new Error("FFmpeg 不支持当前平台");
  const { stderr } = await exec(ffmpeg, ["-hide_banner", "-i", file, "-t", "0", "-f", "null", "-"], { signal, maxBuffer: 1024 * 1024 });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const duration = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频时长");
  if (!/Stream #.*Video:/.test(stderr)) throw new Error("文件没有可用的视频轨道");
  return duration;
}

export function videoWindows(duration: number): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < duration; start += VIDEO_SEGMENT_SECONDS) {
    windows.push({ start, end: Math.min(duration, start + 10) });
  }
  // The preceding overlapping visual window already covers a sub-second tail.
  if (windows.length > 1 && duration - windows[windows.length - 1].start < 1) windows.pop();
  return windows;
}

/** Decode a 1 fps sequence and embed the complete window through the model's video input. */
export async function embedVideoWindow(provider: EmbeddingProvider, file: string, start: number, end: number, tempRoot: string, signal?: AbortSignal): Promise<Float32Array> {
  await fs.mkdir(tempRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(tempRoot, "video-"));
  try {
    const frames: string[] = [];
    for (let t = start; t < end; t += 1) {
      const frame = path.join(dir, `${frames.length}.jpg`);
      const at = t;
      try { await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(at), "-i", file, "-frames:v", "1", "-y", frame], { signal, maxBuffer: 1024 * 1024 }); }
      catch (error) {
        if (signal?.aborted) throw error;
        // Launch failures indicate a broken FFmpeg installation, not a bad clip.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || /no space left|disk quota|read-only file system|permission denied/i.test(String((error as { stderr?: string }).stderr || error))) throw error;
        throw new VideoWindowError(`视频画面解码失败：${String((error as { stderr?: string }).stderr || error).slice(0, 500)}`);
      }
      // FFmpeg can exit successfully without writing a frame near the end of a
      // video. Do not pass a nonexistent path to RawImage.read (reported as 404).
      let frameSize: number;
      try { frameSize = (await fs.stat(frame)).size; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        break;
      }
      if (!frameSize) break;
      frames.push(frame);
    }
    if (!frames.length) throw new VideoWindowError("视频窗口没有可用画面");
    if (signal?.aborted) throw new Error("视频索引已取消");
    return await provider.embedVideo(frames, end - start);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** 音轨窗口：10 秒一段、不重叠；一个窗口对应一条音频向量。 */
export const AUDIO_WINDOW_SECONDS = 10;

export function audioWindows(duration: number): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < duration; start += AUDIO_WINDOW_SECONDS) {
    windows.push({ start, end: Math.min(duration, start + AUDIO_WINDOW_SECONDS) });
  }
  // Audio windows do not overlap: extend the preceding one to retain the tail.
  if (windows.length > 1 && duration - windows[windows.length - 1].start < 1) {
    windows.pop();
    windows[windows.length - 1].end = duration;
  }
  return windows;
}

/** 视频是否带音轨（ffmpeg 把流信息写 stderr；没有 Audio 流就跳过音频索引）。 */
export async function videoHasAudio(file: string, signal?: AbortSignal): Promise<boolean> {
  if (!ffmpeg) throw new Error("FFmpeg 不支持当前平台");
  try {
    const { stderr } = await exec(ffmpeg, ["-hide_banner", "-i", file], { signal, maxBuffer: 4 * 1024 * 1024 });
    return /Stream #.*Audio:/.test(stderr);
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    return /Stream #.*Audio:/.test(String(stderr ?? ""));
  }
}

/** 解码一段音轨为单声道 16kHz Float32 PCM（音频编码器要求的输入格式）。 */
export async function extractAudioWindow(file: string, start: number, end: number, signal?: AbortSignal): Promise<Float32Array> {
  if (!ffmpeg) throw new Error("FFmpeg 不支持当前平台");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("音频窗口时间无效");
  const duration = Math.max(0.2, end - start);
  let stdout: Buffer | string;
  try {
    ({ stdout } = await exec(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-ss", String(start), "-t", String(duration), "-i", file,
      "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-",
    ], { signal, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" }));
  } catch (error) {
    if (signal?.aborted || (error as NodeJS.ErrnoException).code === "ENOENT" || /no space left|disk quota|read-only file system|permission denied/i.test(String((error as { stderr?: string }).stderr || error))) throw error;
    throw new VideoWindowError(`视频音轨解码失败：${String((error as { stderr?: string }).stderr || error).slice(0, 500)}`);
  }
  const buffer = stdout as unknown as Buffer;
  const samples = new Float32Array(Math.floor(buffer.length / 4));
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readFloatLE(i * 4);
  return samples;
}

/** 音频窗口 → 768 维向量（与文本/图片/视频同一向量空间）。 */
export async function embedAudioWindow(provider: EmbeddingProvider, file: string, start: number, end: number, signal?: AbortSignal): Promise<Float32Array> {
  const audio = await extractAudioWindow(file, start, end, signal);
  // The audio encoder requires at least 0.1 seconds at 16 kHz.
  if (audio.length < 1600) throw new VideoWindowError("音频片段太短", true);
  return provider.embedAudio(audio);
}

/** Create a browser-compatible preview only when the original cannot be decoded. */
const previews = new Map<string, Promise<string>>();
export async function makeVideoPreview(file: string, cacheDir: string, contentHash: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/i.test(contentHash)) throw new Error("视频尚未完成索引，请稍后重试");
  const source = await fs.stat(file);
  const cacheKey = createHash("sha256").update(`${contentHash}:${source.size}:${source.mtimeMs}`).digest("hex");
  const destination = path.join(cacheDir, `${cacheKey}.webm`);
  const pending = previews.get(destination);
  if (pending) return pending;
  const job = (async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    const original = source;
    try { if ((await fs.stat(destination)).size > 0) return destination; } catch { /* cache miss */ }
    const temp = path.join(cacheDir, `${contentHash}-${randomUUID()}.tmp.webm`);
    try {
      await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='min(1280,iw)':-2", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "6", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-y", temp], { maxBuffer: 1024 * 1024 });
      const current = await fs.stat(file);
      if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) throw new Error("视频已更改，请重新预览");
      await fs.rename(temp, destination);
      return destination;
    } finally { await fs.rm(temp, { force: true }); }
  })();
  previews.set(destination, job);
  try { return await job; } finally { previews.delete(destination); }
}

// Bound concurrent FFmpeg processes when many recall results appear at once.
let thumbnailSlots = 0;
const thumbnailWaiters: Array<() => void> = [];
const thumbnails = new Map<string, Promise<string>>();
async function thumbnailSlot<T>(work: () => Promise<T>): Promise<T> {
  if (thumbnailSlots >= 2) await new Promise<void>(resolve => thumbnailWaiters.push(resolve));
  else thumbnailSlots++;
  try { return await work(); }
  finally {
    const next = thumbnailWaiters.shift();
    if (next) next(); else thumbnailSlots--;
  }
}

/** First decoded frame at or after the indexed segment's start time. */
export async function makeVideoThumbnail(file: string, cacheDir: string, contentHash: string, start: number): Promise<string> {
  if (!/^[a-f0-9]{64}$/i.test(contentHash) || !Number.isFinite(start) || start < 0) throw new Error("视频片段无效");
  const source = await fs.stat(file);
  const key = createHash("sha256").update(`v1:${contentHash}:${source.size}:${source.mtimeMs}:${start}`).digest("hex");
  const destination = path.join(cacheDir, `${key}.jpg`);
  const existing = thumbnails.get(destination);
  if (existing) return existing;
  const job = thumbnailSlot(async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    try { if ((await fs.stat(destination)).size > 0) return destination; } catch { /* cache miss */ }
    const temporary = path.join(cacheDir, `${key}-${randomUUID()}.tmp.jpg`);
    try {
      await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(start), "-i", file, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2", "-y", temporary], { maxBuffer: 1024 * 1024 });
      if (!(await fs.stat(temporary)).size) throw new Error("未找到片段画面");
      const current = await fs.stat(file);
      if (current.size !== source.size || current.mtimeMs !== source.mtimeMs) throw new Error("视频已更改，请重新索引");
      await fs.rename(temporary, destination);
      return destination;
    } finally { await fs.rm(temporary, { force: true }); }
  });
  thumbnails.set(destination, job);
  try { return await job; } finally { thumbnails.delete(destination); }
}

/** Produce a bounded, browser-compatible clip for an inline chat response. */
const chatClips = new Map<string, Promise<string>>();
export async function makeChatVideoClip(file: string, cacheDir: string, contentHash: string, start: number, end: number): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(contentHash) || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 60) throw new Error("视频片段时间无效");
  const source = await fs.stat(file);
  const key = createHash("sha256").update(`chat-clip-v1:${contentHash}:${source.size}:${source.mtimeMs}:${start}:${end}`).digest("hex");
  const destination = path.join(cacheDir, `${key}.webm`);
  const existing = chatClips.get(destination);
  if (existing) return existing;
  const job = (async () => {
    await fs.mkdir(cacheDir, { recursive: true });
    try { if ((await fs.stat(destination)).size > 0) return destination; } catch { /* cache miss */ }
    const temporary = path.join(cacheDir, `${key}-${randomUUID()}.tmp.webm`);
    try {
      await exec(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(start), "-i", file, "-t", String(end - start), "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale='min(1280,iw)':-2", "-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "6", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-y", temporary], { maxBuffer: 1024 * 1024 });
      const output = await fs.stat(temporary);
      if (!output.size || output.size > 64 * 1024 * 1024) throw new Error("视频片段为空或过大，无法在聊天中播放");
      const current = await fs.stat(file);
      if (current.size !== source.size || current.mtimeMs !== source.mtimeMs) throw new Error("视频已更改，请重新索引");
      await fs.rename(temporary, destination);
      return destination;
    } finally { await fs.rm(temporary, { force: true }); }
  })();
  chatClips.set(destination, job);
  try { return await job; } finally { chatClips.delete(destination); }
}
