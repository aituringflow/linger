import fs from "node:fs/promises";

/**
 * 图片 EXIF 元数据读取（纯 JS，无原生依赖）。
 *
 * 只解析 JPEG APP1 里的 TIFF IFD：拍摄时间（0x9003 DateTimeOriginal）、
 * 机型（0x010F Make + 0x0110 Model）、GPS IFD（0x8825）经纬度。
 * PNG / WEBP / 截图 / 无 APP1 的文件读不到时各字段返回 null，
 * 由上层用文件系统 mtimeMs 兜底时间，坐标留空、不猜。
 *
 * 注意：必须在 canvas 重编码之前从原图读取——重编码成 PNG 后 EXIF 会被剥掉。
 */

export interface ImageMeta {
  /** 拍摄时间（DateTimeOriginal），epoch ms；无 EXIF 时为 null */
  dateTakenMs: number | null;
  /** GPS 纬度（南纬为负）；无定位时为 null */
  lat: number | null;
  /** GPS 经度（西经为负）；无定位时为 null */
  lon: number | null;
  /** 机型（Make + Model 去重）；无信息时为 null */
  camera: string | null;
}

export const EMPTY_META: ImageMeta = { dateTakenMs: null, lat: null, lon: null, camera: null };

/** EXIF 数据类型 → 单元素字节数 */
const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

interface TiffData {
  ifd0: Record<number, unknown>;
  exif: Record<number, unknown>;
  gps: Record<number, unknown>;
}

function parseTiff(buf: Buffer, tiffStart: number): TiffData | null {
  const endian = buf.toString("ascii", tiffStart, tiffStart + 2);
  if (endian !== "II" && endian !== "MM") return null;
  const le = endian === "II";
  const u16 = (p: number) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
  const u32 = (p: number) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
  const i32 = (p: number) => (le ? buf.readInt32LE(p) : buf.readInt32BE(p));

  const readValue = (type: number, count: number, valOff: number): unknown => {
    const size = TYPE_SIZE[type] ?? 1;
    // EXIF 偏移相对 TIFF 头；内联值（≤4 字节）直接在值字段里，越界值才是指针
    const dataOff = count * size > 4 ? tiffStart + u32(valOff) : valOff;
    if (dataOff < tiffStart || dataOff + count * size > buf.length) return null;
    switch (type) {
      case 2:
        return buf.toString("ascii", dataOff, dataOff + count).replace(/\0+$/, "").trim();
      case 3:
        return count === 1 ? u16(dataOff) : [...Array(count)].map((_, k) => u16(dataOff + k * 2));
      case 4:
        return count === 1 ? u32(dataOff) : [...Array(count)].map((_, k) => u32(dataOff + k * 4));
      case 9:
        return count === 1 ? i32(dataOff) : [...Array(count)].map((_, k) => i32(dataOff + k * 4));
      case 5:
        return [...Array(count)].map((_, k) => u32(dataOff + k * 8) / u32(dataOff + k * 8 + 4));
      case 10:
        return [...Array(count)].map((_, k) => i32(dataOff + k * 8) / u32(dataOff + k * 8 + 4));
      default:
        return null;
    }
  };

  const readIfd = (ifd: number): Record<number, unknown> => {
    const n = u16(tiffStart + ifd);
    const out: Record<number, unknown> = {};
    let p = tiffStart + ifd + 2;
    for (let i = 0; i < n; i++) {
      const tag = u16(p);
      const type = u16(p + 2);
      const count = u32(p + 4);
      out[tag] = readValue(type, count, p + 8);
      p += 12;
    }
    return out;
  };

  const ifd0 = readIfd(u32(tiffStart + 4));
  const exifPtr = ifd0[0x8769];
  const gpsPtr = ifd0[0x8825];
  const exif = typeof exifPtr === "number" ? readIfd(exifPtr) : {};
  const gps = typeof gpsPtr === "number" ? readIfd(gpsPtr) : {};
  return { ifd0, exif, gps };
}

/** 解析 "YYYY:MM:DD HH:mm:ss" 为本地时间 epoch ms；失败返回 null */
function parseExifDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]),
  );
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function dms(value: unknown, ref: unknown): number | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [deg, min, sec] = value.map(Number);
  if (![deg, min, sec].every(Number.isFinite)) return null;
  let out = deg + min / 60 + sec / 3600;
  const r = toText(ref);
  if (r === "S" || r === "W") out = -out;
  return out;
}

function cameraName(make: unknown, model: unknown): string | null {
  const m = toText(make) ?? "";
  const md = toText(model) ?? "";
  if (!m && !md) return null;
  if (m && md && md.toUpperCase().includes(m.toUpperCase())) return md;
  return [m, md].filter(Boolean).join(" ").trim() || null;
}

/** 只读文件头（128KB 足够覆盖 APP1 内的 IFD 与指针），避免为读元数据整图入内存。 */
async function readHead(filePath: string, length: number): Promise<Buffer | null> {
  try {
    const fd = await fs.open(filePath, "r");
    const head = Buffer.alloc(length);
    const { bytesRead } = await fd.read(head, 0, length, 0);
    await fd.close();
    return head.subarray(0, bytesRead);
  } catch {
    return null;
  }
}

/** 读取图片元数据；读不到的字段为 null（时间兜底由上层用 mtimeMs 处理）。 */
export async function readImageMeta(filePath: string): Promise<ImageMeta> {
  const buf = await readHead(filePath, 128 * 1024);
  if (!buf || buf.length < 4) return EMPTY_META;
  // 非 JPEG（PNG/WEBP/BMP 等）：v1 不解析其元数据，留空由上层兜底
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return EMPTY_META;

  let off = 2;
  let app1 = -1;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) break;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1) { app1 = off; break; }
    off += 2 + len;
  }
  if (app1 < 0) return EMPTY_META;
  if (buf.toString("ascii", app1 + 4, app1 + 10) !== "Exif\0\0") return EMPTY_META;

  const tiff = parseTiff(buf, app1 + 10);
  if (!tiff) return EMPTY_META;

  const { ifd0, exif, gps } = tiff;
  const dateTakenMs =
    parseExifDate(exif[0x9003]) ?? parseExifDate(exif[0x9004]) ?? parseExifDate(ifd0[0x0132]);
  const lat = dms(gps[0x0002], gps[0x0001]);
  const lon = dms(gps[0x0004], gps[0x0003]);
  // 有些相机把 GPS 写成 0,0（几内亚湾「空定位」）；当作没有定位，别在 UI/检索文本里显示
  const hasLocation = lat !== null && lon !== null && (lat !== 0 || lon !== 0);
  return {
    dateTakenMs,
    lat: hasLocation ? lat : null,
    lon: hasLocation ? lon : null,
    camera: cameraName(ifd0[0x010f], ifd0[0x0110]),
  };
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 格式化为 "YYYY-MM-DD HH:mm"；无效时间返回空串 */
export function formatTakenDate(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 拼成给检索文本/界面用的一行元信息：
 * "拍摄于 2013-09-15 12:51 · SAMSUNG SHV-E300S · 22.49329,113.91065"
 * 时间只取 EXIF 拍摄时间，不用文件拷贝/修改时间冒充；没有任何可用信息时返回空串。
 */
export function metaLabel(meta: ImageMeta): string {
  const date = formatTakenDate(meta.dateTakenMs);
  const parts: string[] = [];
  if (date) parts.push(`拍摄于 ${date}`);
  if (meta.camera) parts.push(meta.camera);
  if (meta.lat != null && meta.lon != null && Number.isFinite(meta.lat) && Number.isFinite(meta.lon) && (meta.lat !== 0 || meta.lon !== 0)) {
    parts.push(`${meta.lat.toFixed(5)},${meta.lon.toFixed(5)}`);
  }
  return parts.join(" · ");
}
