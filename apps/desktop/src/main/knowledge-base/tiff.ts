import fs from "node:fs/promises";
import path from "node:path";
import UTIF from "utif";
import { createCanvas, ImageData, type Canvas } from "@napi-rs/canvas";

/**
 * TIFF 解码。
 *
 * Skia 没有 TIFF 编解码器：把 .tif 直接交给 @napi-rs/canvas 的 loadImage 会在原生层
 * 抛出 Napi::Error 并 SIGSEGV 整个解析子进程（日志里就是「文件解析进程退出（SIGSEGV）」）。
 * 所以先按文件头识别 TIFF，用纯 JS 的 UTIF 解出 RGBA，再交给画布；绕过原生解码路径。
 */

/** TIFF 文件头：小端 II*\0 或大端 MM\0*。 */
export function isTiff(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  const little = buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00;
  const big = buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a;
  return little || big;
}

/** 多页 TIFF 最多取前 8 页，避免扫描件把内存吃光。 */
const MAX_PAGES = 8;

/** 按文件头判断（后缀不可信时用）。 */
export async function isTiffFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    return isTiff(head);
  } finally {
    await handle.close();
  }
}

export function decodeTiff(buf: Buffer): Canvas {
  const view = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const pages = UTIF.decode(view).slice(0, MAX_PAGES);
  if (!pages.length) throw new Error("TIFF 里没有可解码的图像");
  const decoded = pages.map((page) => {
    UTIF.decodeImage(view, page);
    const rgba = UTIF.toRGBA8(page);
    return { width: page.width as number, height: page.height as number, rgba };
  });
  const width = decoded.reduce((max, page) => Math.max(max, page.width), 1);
  const height = decoded.reduce((sum, page) => sum + page.height, 0);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  // 扫描件常带透明底，先铺白再压页面，避免缩略图一片黑
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  let top = 0;
  for (const page of decoded) {
    context.putImageData(new ImageData(new Uint8ClampedArray(page.rgba), page.width, page.height), 0, top);
    top += page.height;
  }
  return canvas;
}

/** 从路径解 TIFF（后缀判断，避免读不到文件头就交给原生解码）。 */
export async function tiffToCanvas(filePath: string): Promise<Canvas> {
  return decodeTiff(await fs.readFile(filePath));
}

export function isTiffPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".tif" || ext === ".tiff";
}

/** TIFF → PNG 字节（OCR 只吃常见位图格式）。 */
export function tiffToPng(buf: Buffer): Buffer {
  return decodeTiff(buf).toBuffer("image/png");
}
