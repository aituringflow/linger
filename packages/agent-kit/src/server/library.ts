/**
 * agent-kit · 资料库 / 文件 / 文件分享管理 的 HTTP 端点
 *
 * 挂载（见 kit-api.ts）：
 *   GET  /api/file?fileId=<id>&token=<可选分享token>   按 fileId 读取字节（结构上防路径穿越）
 *   GET  /api/files?session=&kind=&q=                 资料库列表（按登录用户列举全部产物/输入）
 *   GET  /api/shares/file/[fileId]                    列出某文件的所有分享（仅 owner）
 *   POST /api/shares/file/[fileId]                    撤销某分享 { token }（仅 owner）
 *   DELETE /api/shares/file/[fileId]?token=...        撤销某分享（仅 owner）
 *
 * 全部强制走「fileId → 鉴权 → storage_key 取字节」，用户永不传入路径。
 */
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import { readFile, recordFileToStore } from "./file-store.js";
import {
  listFilesByOwner,
  getFileById,
  listSharesForFile,
  revokeShare,
  softDeleteFile,
  softDeleteFilesByOwner,
  renameUserFile,
  isDbEnabled,
} from "./auth/db.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function currentUserSub(request: Request): string | null {
  const user = verifySession(request, loadAuthConfig());
  return user?.sub ?? null;
}

export interface FileHandlers {
  file: { GET: (request: Request) => Promise<Response> };
  files: { GET: (request: Request) => Promise<Response>; POST: (request: Request) => Promise<Response>; PATCH: (request: Request) => Promise<Response>; DELETE: (request: Request) => Promise<Response> };
  sharesFile: {
    GET: (request: Request, ctx: { params: { fileId: string } }) => Promise<Response>;
    POST: (request: Request, ctx: { params: { fileId: string } }) => Promise<Response>;
    DELETE: (request: Request, ctx: { params: { fileId: string } }) => Promise<Response>;
  };
}

export function createFileHandlers(): FileHandlers {
  /** GET /api/file：按 fileId 读取字节（登录用户 ACL 或分享 token）。 */
  async function fileGET(request: Request): Promise<Response> {
    if (!isDbEnabled()) return new Response("Not Found", { status: 404 });
    const url = new URL(request.url);
    const fileId = url.searchParams.get("fileId");
    if (!fileId) return new Response("Not Found", { status: 404 });
    const token = url.searchParams.get("token");
    const viewer = currentUserSub(request);
    const data = await readFile(fileId, viewer, token);
    if (!data) return new Response("Not Found", { status: 404 });
    const headers: Record<string, string> = {
      "Content-Type": data.mime || "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (data.mime?.startsWith("audio/")) {
      headers["Accept-Ranges"] = "bytes";
      const range = request.headers.get("range");
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        const size = data.buf.length;
        const first = match?.[1] ? Number(match[1]) : null;
        const last = match?.[2] ? Number(match[2]) : null;
        const start = first ?? (last != null ? Math.max(0, size - last) : -1);
        const end = first == null ? size - 1 : Math.min(last ?? size - 1, size - 1);
        if (!match || start < 0 || start >= size || end < start) {
          return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
        }
        const chunk = data.buf.subarray(start, end + 1);
        return new Response(new Uint8Array(chunk), {
          status: 206,
          headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(chunk.length) },
        });
      }
    }
    if (data.mime === "text/html") {
      // HTML 预览沙箱化，与分享页一致，杜绝内联脚本越权
      headers["Content-Security-Policy"] = "sandbox";
    }
    if (url.searchParams.get("download") !== null) {
      headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(data.name)}`;
    }
    return new Response(new Uint8Array(data.buf), { headers });
  }

  /** GET /api/files：资料库列表（按登录用户列举全部产物 + 输入 + 用户文件）。 */
  async function filesGET(request: Request): Promise<Response> {
    const user = currentUserSub(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!isDbEnabled()) return json({ files: [] });
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("session") ?? undefined;
    const kind = url.searchParams.get("kind") ?? undefined;
    const q = url.searchParams.get("q")?.trim().slice(0, 128) || undefined;
    const rows = await listFilesByOwner(user, { sessionId, kind, q, limit: q ? 500 : 200 });
    return json({
      files: rows.map((f) => ({
        id: f.id,
        name: f.name,
        kind: f.kind,
        mime: f.mime,
        size: f.size,
        sessionId: f.sessionId,
        folder: f.folder,
        sessionExists: f.sessionExists,
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      })),
    });
  }

  async function filesPOST(request: Request): Promise<Response> {
    const user = currentUserSub(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!isDbEnabled()) return json({ error: "database_unavailable" }, 503);
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") return json({ error: "missing_file" }, 400);
    if (file.size > 50 * 1024 * 1024) return json({ error: "file_too_large" }, 413);
    const name = file.name.trim().slice(0, 512);
    if (!name || /[\r\n\0]/.test(name)) return json({ error: "invalid_name" }, 400);
    const rawFolder = form?.get("folder");
    const folder = typeof rawFolder === "string" ? rawFolder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") : "";
    if (folder.length > 1024 || folder.split("/").some((part) => part === "." || part === ".." || !part || /[\r\n\0]/.test(part))) return json({ error: "invalid_folder" }, 400);
    const stored = await recordFileToStore({ buf: Buffer.from(await file.arrayBuffer()), kind: "userfile", name, ownerSub: user, mime: file.type || null, folder: folder || null });
    if (!stored) return json({ error: "save_failed" }, 500);
    return json({ ok: true, fileId: stored.fileId }, 201);
  }

  async function filesPATCH(request: Request): Promise<Response> {
    const user = currentUserSub(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!isDbEnabled()) return json({ error: "database_unavailable" }, 503);
    const body = (await request.json().catch(() => null)) as { fileId?: unknown; name?: unknown } | null;
    const fileId = typeof body?.fileId === "string" ? body.fileId : "";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!fileId || !name || name.length > 512 || /[\r\n\0]/.test(name)) return json({ error: "invalid_request" }, 400);
    const renamed = await renameUserFile(user, fileId, name);
    return renamed ? json({ ok: true }) : json({ error: "not_found" }, 404);
  }

  async function filesDELETE(request: Request): Promise<Response> {
    const user = currentUserSub(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!isDbEnabled()) return json({ error: "database_unavailable" }, 503);
    const body = (await request.json().catch(() => null)) as { fileIds?: unknown } | null;
    if (body?.fileIds !== undefined) {
      const ids = body.fileIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || ids.some((id) => typeof id !== "string" || !id || id.length > 128)) return json({ error: "invalid_file_ids" }, 400);
      const deletedIds = await softDeleteFilesByOwner(user, [...new Set(ids)]);
      return json({ ok: true, deletedIds });
    }
    const fileId = new URL(request.url).searchParams.get("fileId");
    if (!fileId) return json({ error: "missing_file_id" }, 400);
    const file = await getFileById(fileId);
    if (!file || file.ownerSub !== user) return json({ error: "not_found" }, 404);
    await softDeleteFile(fileId);
    return json({ ok: true });
  }

  async function sharesFileResolve(
    request: Request,
    fileId: string,
  ): Promise<{ fileId: string } | Response> {
    const user = currentUserSub(request);
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!isDbEnabled()) return json({ error: "database_unavailable" }, 503);
    const file = await getFileById(fileId);
    if (!file || file.ownerSub !== user) return json({ error: "not_found" }, 404);
    return { fileId };
  }

  async function sharesFileGET(
    request: Request,
    ctx: { params: { fileId: string } },
  ): Promise<Response> {
    const resolved = ctx.params instanceof Promise ? await ctx.params : ctx.params;
    const fileId = String(resolved.fileId || "");
    const r = await sharesFileResolve(request, fileId);
    if (r instanceof Response) return r;
    const shares = await listSharesForFile(fileId);
    return json({
      shares: shares.map((s) => ({
        token: s.token,
        scopeType: s.scopeType,
        scopeId: s.scopeId,
        permission: s.permission,
        granteeSub: s.granteeSub,
        expiresAt: s.expiresAt,
        revoked: s.revoked,
        createdAt: s.createdAt,
      })),
    });
  }

  async function sharesFileRevoke(
    request: Request,
    ctx: { params: { fileId: string } },
    tokenFrom: (url: URL, body: Record<string, unknown>) => string | null,
  ): Promise<Response> {
    const resolved = ctx.params instanceof Promise ? await ctx.params : ctx.params;
    const fileId = String(resolved.fileId || "");
    const r = await sharesFileResolve(request, fileId);
    if (r instanceof Response) return r;
    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const token = tokenFrom(url, body);
    if (!token) return json({ error: "missing_token" }, 400);
    const owner = currentUserSub(request);
    const ok = await revokeShare(token, owner!);
    if (!ok) return json({ error: "not_found" }, 404);
    return json({ ok: true });
  }

  return {
    file: { GET: fileGET },
    files: { GET: filesGET, POST: filesPOST, PATCH: filesPATCH, DELETE: filesDELETE },
    sharesFile: {
      GET: sharesFileGET,
      POST: (request, ctx) => sharesFileRevoke(request, ctx, (_url, body) => (typeof body.token === "string" ? body.token : null)),
      DELETE: (request, ctx) => sharesFileRevoke(request, ctx, (url) => url.searchParams.get("token")),
    },
  };
}
