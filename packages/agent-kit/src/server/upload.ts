/**
 * agent-kit · 附件上传端点（Next.js App Router 通用 handler）
 *
 * 默认把文件保存到 <cwd>/public/uploads/ 并返回可访问的相对 URL，
 * 与前端 AgentWindow 的「+ 上传 / 拖拽添加」流程对接。
 * 第三方 Next.js 工程只需在 app/api/upload/route.js 里：
 *   import { createUploadHandler } from "agent-kit";
 *   export const { POST } = createUploadHandler();
 */
import { mkdir, rename, unlink, stat } from "node:fs/promises";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import crypto from "node:crypto";
import { artifactRoot, uploadStorageDir } from "./artifacts.js";
import { assertSessionAccess } from "./session-access.js";
import { authorizeTemporaryChat } from "./temporary-chat.js";
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import { getFileById, isDbEnabled } from "./auth/db.js";
import { indexFile, readFile } from "./file-store.js";

export interface UploadOptions {
  /** 单文件大小上限字节（默认 1024MB） */
  maxBytes?: number;
  /** 允许的 MIME → 扩展名映射（默认覆盖图片/PDF/Office/文本/压缩包） */
  allowedTypes?: Record<string, string>;
}

const DEFAULT_ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "audio/flac": "flac",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel.sheet.macroenabled.12": "xlsm",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
  "application/zip": "zip",
};

function extFromName(name = "") {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** 文件名安全化：替换 Windows/URL 非法字符与空白，保留中文等可读字符，截断防超长 */
function safeName(name = "") {
  return path.basename(name).normalize("NFC").replace(/\p{White_Space}+/gu, " ")
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 180);
}

/** 从 content-type 中解析 multipart 边界（boundary） */
function parseBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!m) return null;
  return (m[1] || m[2] || "").trim();
}

class UploadSizeError extends Error {}

/**
 * 流式解析 multipart/form-data 请求体，把「第一个带 filename 的 part」直接落盘，
 * 全程不把整文件缓冲进内存（对比旧实现 Buffer.from(await file.arrayBuffer())，
 * 1GB 文件会一次性占用 ~2GB 内存 → 极易 OOM）。
 * - 边读边写，内存占用恒定（仅保留一个分界符长度的尾部缓冲）。
 * - 写入过程中实时累计字节，超过 maxBytes 立即中止并清理临时文件。
 * - 仅取首个文件 part；其余 part（普通字段）直接丢弃。
 */
async function streamMultipartFile(
  body: ReadableStream<Uint8Array>,
  boundary: string,
  maxBytes: number,
  targetPath: string,
): Promise<{ filename?: string; contentType?: string; size: number }> {
  const reader = body.getReader();
  const delim = Buffer.from(`--${boundary}`); // 不含前后 CRLF
  let buf = Buffer.alloc(0);
  let state: "preamble" | "headers" | "content" | "done" = "preamble";
  let currentIsFile = false;
  let filename: string | undefined;
  let contentType: string | undefined;
  let size = 0;

  // 写盘时处理背压（大文件 write 可能返回 false），并实时做大小围栏
  const writeStream: WriteStream = createWriteStream(targetPath);
  const writeChunk = async (c: Buffer) => {
    if (c.length === 0) return;
    size += c.length;
    if (size > maxBytes) {
      writeStream.destroy();
      throw new UploadSizeError();
    }
    const ok = writeStream.write(c);
    if (!ok) await new Promise<void>((res) => writeStream.once("drain", res));
  };

  const append = (b: Uint8Array) => {
    buf = Buffer.concat([buf, Buffer.from(b)]);
  };
  const consume = (n: number) => {
    buf = buf.subarray(n);
  };
  const readMore = async () => {
    const { done, value } = await reader.read();
    if (done) throw new Error("上传中断（请求体不完整）");
    if (value) append(value);
  };

  try {
    while (state !== "done") {
      if (buf.length === 0) {
        await readMore();
        if (buf.length === 0) continue;
      }

      if (state === "preamble") {
        const idx = buf.indexOf(delim);
        if (idx === -1) {
          // Keep a possible boundary prefix across network chunks.
          consume(Math.max(0, buf.length - delim.length + 1));
          await readMore();
          continue;
        }
        const after = idx + delim.length;
        if (buf.length < after + 2) {
          // 分界符可能跨块被截断，保留其前缀等下一包
          consume(idx);
          await readMore();
          continue;
        }
        if (buf[after] !== 0x0d || buf[after + 1] !== 0x0a) {
          consume(after);
          continue;
        }
        consume(after + 2);
        state = "headers";
      } else if (state === "headers") {
        const he = buf.indexOf("\r\n\r\n");
        if (he === -1) {
          if (buf.length > 64 * 1024) throw new Error("附件请求头过长");
          await readMore();
          continue;
        }
        const headerText = buf.subarray(0, he).toString("latin1");
        // RFC 5987 扩展名（filename*=UTF-8''...）优先
        const star = headerText.match(/filename\*=UTF-8''([^;\r\n]+)/i);
        if (star) {
          try {
            filename = decodeURIComponent(star[1]);
          } catch {
            filename = star[1];
          }
        } else {
          const disp =
            headerText.match(/filename="([^"]*)"/i) || headerText.match(/filename=([^;\r\n]+)/i);
          if (disp) {
            // latin1 1:1 映射原字节，再按 UTF-8 还原（中文文件名不乱码）
            filename = Buffer.from(disp[1].trim(), "latin1").toString("utf8");
          }
        }
        const ct = headerText.match(/Content-Type:\s*([^\r\n]+)/i);
        if (ct) contentType = ct[1].trim();
        currentIsFile = !!filename;
        consume(he + 4);
        state = "content";
      } else if (state === "content") {
        const idx = buf.indexOf(delim);
        if (idx === -1) {
          // 未遇到分界符：写出除尾部安全尾巴外的全部内容（保留尾巴防边界跨块），其余 part 直接丢弃
          const keep = delim.length + 2;
          const writable = buf.length > keep ? buf.length - keep : 0;
          if (writable > 0) {
            if (currentIsFile) await writeChunk(buf.subarray(0, writable));
            consume(writable);
          }
          // The retained boundary tail is non-empty. Explicitly read the next
          // chunk instead of spinning on that same tail indefinitely.
          await readMore();
          continue;
        }
        const after = idx + delim.length;
        if (buf.length < after + 2) {
          await readMore();
          continue;
        }
        // 内容结束于分界符前 2 字节（去掉紧跟 part 的 \r\n）
        const contentEnd = idx - 2;
        if (contentEnd > 0 && currentIsFile) await writeChunk(buf.subarray(0, contentEnd));
        const isClosing =
          buf.length >= after + 2 && buf[after] === 0x2d && buf[after + 1] === 0x2d;
        if (currentIsFile) {
          consume(after + (isClosing ? 2 : 0));
          state = "done"; // 仅取首个文件 part
        } else {
          consume(after + 2);
          state = isClosing ? "done" : "headers"; // 非文件 part 跳过，继续找下一个
        }
      }
    }

    await new Promise<void>((res, rej) =>
      writeStream.end((err?: Error | null) => (err ? rej(err) : res())),
    );
    // Drain unused parts without accumulating them. Cancelling a successful
    // request can destroy the IncomingMessage in the local HTTP adapter.
    while (!(await reader.read()).done) { /* discard */ }
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    writeStream.destroy();
    await unlink(targetPath).catch(() => {});
    throw err;
  }

  return { filename, contentType, size };
}

export function createUploadHandler(options: UploadOptions = {}) {
  const maxBytes = options.maxBytes ?? 1024 * 1024 * 1024; // 默认 1024MB
  const allowed = options.allowedTypes ?? DEFAULT_ALLOWED;
  const sessionDir = uploadStorageDir;
  const validSession = (session: string) => /^[a-zA-Z0-9_-]{1,128}$/.test(session);
  const validName = (name: string) => !!name && name === safeName(name) && name !== "." && name !== "..";

  async function POST(request: Request): Promise<Response> {
    const session = new URL(request.url).searchParams.get("session") || "";
    const accessAllowed = validSession(session) && (session.startsWith("side_")
      ? !authorizeTemporaryChat(request, session, true)
      : !!await assertSessionAccess(request, session));
    if (!accessAllowed) {
      return Response.json({ ok: false, error: "无权访问该会话" }, { status: 403 });
    }
    const dir = sessionDir(session);
    const boundary = parseBoundary(request.headers.get("content-type"));
    if (!boundary) {
      return Response.json(
        { ok: false, error: "请求格式错误（需 multipart/form-data）" },
        { status: 400 },
      );
    }
    if (!request.body) {
      return Response.json({ ok: false, error: "没有收到请求体" }, { status: 400 });
    }

    let tmpPath = "";
    let parsed: { filename?: string; contentType?: string; size: number };
    try {
      await mkdir(dir, { recursive: true });
      tmpPath = path.join(dir, `${crypto.randomUUID()}.part`);
      parsed = await streamMultipartFile(request.body, boundary, maxBytes, tmpPath);
      if (!parsed.filename) {
        await unlink(tmpPath).catch(() => {});
        return Response.json({ ok: false, error: "没有收到文件" }, { status: 400 });
      }
    } catch (err) {
      if (tmpPath) await unlink(tmpPath).catch(() => {});
      if (err instanceof UploadSizeError) {
        return Response.json(
          { ok: false, error: `文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB 上限` },
          { status: 400 },
        );
      }
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : "附件上传失败" },
        { status: 400 },
      );
    }

    const ext =
      allowed[String(parsed.contentType || "").toLowerCase()] || extFromName(parsed.filename);
    if (!ext) {
      await unlink(tmpPath).catch(() => {});
      return Response.json(
        { ok: false, error: "不支持的文件类型（支持图片/视频/音频/PDF/Office/文本/压缩包）" },
        { status: 400 },
      );
    }

    try {
      // 落盘到临时 .part 后按真实扩展名重命名，避免半截文件暴露为可访问 URL
      const filename = safeName(parsed.filename);
      if (!validName(filename)) throw new Error("无效文件名");
      const finalPath = path.join(dir, filename);
      await rename(tmpPath, finalPath);
      const ownerSub = verifySession(request, loadAuthConfig())?.sub;
      const indexed = ownerSub && isDbEnabled() && !session.startsWith("side_") ? await indexFile({ ownerSub, kind: "input", absPath: finalPath,
        name: filename, sessionId: session, mime: parsed.contentType || null }) : null;
      if (ownerSub && isDbEnabled() && !session.startsWith("side_") && !indexed) throw new Error("上传成功，但文件索引失败，请重试");
      return Response.json({
        ok: true,
        url: `/api/upload?session=${encodeURIComponent(session)}&name=${encodeURIComponent(filename)}${indexed?.fileId ? `&fileId=${encodeURIComponent(indexed.fileId)}` : ""}`,
        name: filename,
        size: parsed.size,
        mime: parsed.contentType || "",
        fileId: indexed?.fileId,
      });
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      return Response.json(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  }

  async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const session = url.searchParams.get("session") || "";
    const name = url.searchParams.get("name") || "";
    if (!validSession(session) || !validName(name) || !await assertSessionAccess(request, session)) {
      return new Response("Not Found", { status: 404 });
    }
    const privateFile = path.join(sessionDir(session), name);
    try {
      const info = await stat(privateFile);
      if (!info.isFile()) return new Response("Not Found", { status: 404 });
      const mimeByExt: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", pdf: "application/pdf", html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", txt: "text/plain; charset=utf-8", yml: "text/plain; charset=utf-8", yaml: "text/plain; charset=utf-8", json: "application/json",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsm: "application/vnd.ms-excel.sheet.macroenabled.12", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pptm: "application/vnd.ms-powerpoint.presentation.macroenabled.12", ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow" };
      const headers: Record<string, string> = { "Content-Type": mimeByExt[extFromName(name)] || "application/octet-stream", "Content-Length": String(info.size), "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
      headers["Content-Disposition"] = `${url.searchParams.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`;
      if (headers["Content-Type"].startsWith("text/html") && !url.searchParams.has("download")) headers["Content-Security-Policy"] = "sandbox";
      return new Response(Readable.toWeb(createReadStream(privateFile)) as ReadableStream, { headers });
    } catch {
      // The indexed copy is the durable source after upload staging is cleaned or moved.
      const fileId = url.searchParams.get("fileId") || "";
      const viewer = verifySession(request, loadAuthConfig())?.sub ?? null;
      if (!fileId || !viewer || !isDbEnabled()) return new Response("Not Found", { status: 404 });
      const row = await getFileById(fileId);
      if (!row || row.sessionId !== session || row.name !== name) return new Response("Not Found", { status: 404 });
      const stored = await readFile(fileId, viewer);
      if (!stored) return new Response("Not Found", { status: 404 });
      const headers: Record<string, string> = {
        "Content-Type": stored.mime || "application/octet-stream",
        "Content-Length": String(stored.buf.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(stored.name)}`,
      };
      if (headers["Content-Type"].startsWith("text/html") && !url.searchParams.has("download")) headers["Content-Security-Policy"] = "sandbox";
      return new Response(new Uint8Array(stored.buf), { headers });
    }
  }

  return { POST, GET };
}
