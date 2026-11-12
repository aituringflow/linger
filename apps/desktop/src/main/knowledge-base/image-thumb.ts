import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCanvas, loadImage, type Canvas } from "@napi-rs/canvas";
import { assetThumbPath } from "./assets.js";
import { isTiff, isTiffFile, isTiffPath } from "./tiff.js";

/**
 * 图片缩略图。
 *
 * 列表/网格一屏可能有上百张图：直接 <img src="原图"> 会把几十 MB 的 PNG 全解码进显存，
 * 滚动就卡死。所有预览统一走 384px 的 WebP 缩略图（约 10–30KB），点开才看原图。
 *
 * 新索引的图片在解析子进程里顺手生成（见 parser.ts），老库的图在首次用到时按需生成
 * （ensureThumbnail），生成结果落在 libraries/<id>/thumbs/ 下，之后直接命中缓存。
 */

export const THUMB_MAX_SIDE = 384;
const THUMB_QUALITY = 78;

/** 把画布等比缩到最长边不超过 maxSide；本来就够小则原样返回。 */
export function fitCanvas(source: Canvas, maxSide: number): Canvas {
  const longest = Math.max(source.width, source.height);
  const scale = longest > maxSide ? maxSide / longest : 1;
  if (scale >= 1) return source;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const target = createCanvas(width, height);
  const context = target.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  return target;
}

/** 生成缩略图字节（WebP）。 */
export function thumbnailFromCanvas(source: Canvas): Buffer {
  return fitCanvas(source, THUMB_MAX_SIDE).toBuffer("image/webp", THUMB_QUALITY);
}

/** 解码任意图片格式到画布（缩略图 / 索引落盘共用）。 */
export async function decodeToCanvas(input: string | Buffer): Promise<Canvas> {
  // TIFF 走纯 JS 解码：Skia 不认 TIFF，交给原生 loadImage 会 SIGSEGV 整个进程
  const tiff = typeof input === "string" ? isTiffPath(input) || (await isTiffFile(input)) : isTiff(input);
  if (tiff) {
    const { decodeTiff, tiffToCanvas } = await import("./tiff.js");
    if (typeof input === "string") return tiffToCanvas(input);
    return decodeTiff(input);
  }
  const image = await loadImage(input);
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext("2d").drawImage(image, 0, 0);
  return canvas;
}

// 缩略图是 CPU 密集操作（解码 + 缩放 + 编码），一次请求一屏时限制并发，
// 避免把知识库 worker 的其它 RPC（索引进度、检索）长时间挤住。
let slots = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (slots >= 2) await new Promise<void>((resolve) => waiters.push(resolve));
  else slots++;
  try { return await work(); } finally {
    const next = waiters.shift();
    if (next) next(); else slots--;
  }
}

const pending = new Map<string, Promise<string>>();

/**
 * 确保某个图片副本有缩略图；返回缩略图绝对路径。已存在且不比原图旧时直接复用。
 * `destination` 可覆盖落盘位置（独立图片按原文件 sha256 命名，见 assets.fileThumbPath）。
 */
export function ensureThumbnail(sourcePath: string, destination = assetThumbPath(sourcePath)): Promise<string> {
  const existing = pending.get(destination);
  if (existing) return existing;
  const job = withSlot(async () => {
    const source = await fs.stat(sourcePath);
    try {
      const cached = await fs.stat(destination);
      if (cached.size > 0 && cached.mtimeMs >= source.mtimeMs) return destination;
    } catch { /* 缓存不存在 */ }
    const canvas = await decodeToCanvas(sourcePath);
    const data = thumbnailFromCanvas(canvas);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const temporary = path.join(path.dirname(destination), `${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, data);
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return destination;
  });
  pending.set(destination, job);
  return job.finally(() => { pending.delete(destination); });
}
