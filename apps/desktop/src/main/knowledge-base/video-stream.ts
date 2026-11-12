import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

/** Stream an original local video with HTTP byte ranges so Chromium can seek. */
export async function streamVideo(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
  try {
    const info = await fs.promises.stat(filePath);
    if (!info.isFile() || !info.size) { res.writeHead(404).end(); return; }
    const size = info.size;
    const raw = req.headers.range;
    const match = raw?.match(/^bytes=(\d*)-(\d*)$/);
    if (raw && (!match || (!match[1] && !match[2]))) { res.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return; }
    const suffix = match && !match[1] ? Number(match[2]) : 0;
    const start = match ? (match[1] ? Number(match[1]) : Math.max(0, size - suffix)) : 0;
    const end = match && match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (match && !match[1] && suffix <= 0) || start >= size || end < start) { res.writeHead(416, { "Content-Range": `bytes */${size}` }).end(); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers: Record<string, string> = { "Content-Type": ext === ".webm" ? "video/webm" : ext === ".mov" ? "video/quicktime" : "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Length": String(end - start + 1), "X-Content-Type-Options": "nosniff" };
    if (match) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(match ? 206 : 200, headers);
    if (req.method === "HEAD") { res.end(); return; }
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch { if (!res.headersSent) res.writeHead(404).end(); else res.destroy(); }
}
