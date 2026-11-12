/**
 * agent-kit · 用户文件区（User Files）：以登录用户 id 为目录名的**用户可操作区**
 *
 * 背景：产物（artifact）是「模型写给用户看的」，落<产物根>/<会话id>/，随会话隔离。
 * 但用户往往需要一块**自己能改**的地方：上传原始资料、下载成品、清理中间件、
 * 沉淀跨会话复用的资料。这类需求此前没有落点——模型只能写会话目录，用户只能看。
 *
 * 目录：<产物根>/users/<userKey>/，userKey = 由主体键 sub（`provider:unionId`）派生：
 *   - 同一用户跨会话共享同一份文件（不按会话再分层，避免会话堆积导致文件失联）；
 *   - 用户之间天然隔离：目录名由服务端从登录态派生，**不接受前端传入**。
 *
 * 权限边界（本模块是"放开"的口子，必须收紧）：
 *   - 入口必须登录，且目录名只从 verifySession 的 sub 派生（伪造不了他人目录）；
 *   - 所有路径经 safeUserFilePath 归一 + 边界复核，`..`、绝对路径、符号链接一律拒绝；
 *   - 只在本模块自己的 users/ 子树内活动，够不到会话产物、服务端代码、其他用户数据；
 *   - 不与模型沙箱混用：模型的可写 allowRoots 不包含用户目录（除非显式开启），
 *     用户对自己目录的操作也不经过模型，因此与「防模型乱改服务」的目标不冲突。
 *
 * 端点（挂载见 kit-api.ts 的 /api/user-files/*）：
 *   GET    /api/user-files?path=<相对路径>   列目录（path 为空 = 根）
 *   POST   /api/user-files                  上传（multipart，字段名 file；可选 path 指定子目录）
 *   GET    /api/user-files/raw?path=<相对>   下载 / 预览单个文件内容
 *   DELETE /api/user-files?path=<相对>       删除文件或空目录
 *   POST   /api/user-files/mkdir            新建子目录 { path }
 *   POST   /api/user-files/rename           重命名/移动 { from, to }
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { artifactRoot, mimeFor, sanitizeArtifactName } from "./artifacts.js";
import { indexFile } from "./file-store.js";
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";

/** 用户文件区在产物根下的目录名（点开头 = 中间产物，不会被产物收集扫到） */
export const USER_FILES_DIR_NAME = "users";

/** 单文件上传上限（默认 50MB，比附件的 20MB 宽：这里放的是资料/成品，不是聊天图） */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** 目录名派生：sub（provider:unionId）→ 安全的单层目录名。
 *  ':' 在 Windows 非法 → 换成 '_'；再叠 8 位 hash 防不同 sub 清洗后撞名。 */
export function userKeyFor(sub: string): string {
  const cleaned = String(sub || "").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  let h = 5381;
  for (let i = 0; i < sub.length; i++) h = ((h << 5) + h + sub.charCodeAt(i)) | 0;
  const hash = (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
  return cleaned ? `${cleaned}_${hash}` : `user_${hash}`;
}

/** 用户文件区根目录：<产物根>/users/<userKey>/ */
export function userFilesRoot(sub: string): string {
  return path.join(artifactRoot(), USER_FILES_DIR_NAME, userKeyFor(sub));
}

/**
 * 把用户传入的相对路径解析为绝对路径，并强制落在 root 内。
 * 返回 null 表示非法（穿越 / 绝对路径 / 空路径 / 越界）。
 * 与产物读取同一套思路：先清洗再复核，不信任任何客户端输入。
 */
export function safeUserFilePath(root: string, rel: unknown): string | null {
  const raw = String(rel ?? "").trim();
  // 绝对路径、盘符、UNC 一律拒绝——用户区只接受相对路径
  if (!raw) return root;
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.includes("\0")) return null;
  const cleaned = sanitizeArtifactName(raw.replace(/\\/g, "/"));
  const abs = path.resolve(root, cleaned);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

/** 拒绝用户目录中的符号链接，避免已有链接绕过词法路径边界。 */
async function hasSymlink(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }
  return false;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const err = (msg: string, status: number) => json({ error: msg }, status);

/** 当前请求者：登录用户 sub（主体键）。未登录返回 null。
 *  目录名只由此派生，前端无法指定他人目录。 */
export function currentUserSub(request: Request): string | null {
  const user = verifySession(request, loadAuthConfig());
  return user?.sub ?? null;
}

export interface UserFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/** 列目录（不递归）。path 为空返回根。 */
async function listDir(root: string, rel: string): Promise<{ entries: UserFileEntry[] } | { error: string; status: number }> {
  const dir = safeUserFilePath(root, rel);
  if (!dir) return { error: "非法路径", status: 400 };
  if (await hasSymlink(root, dir)) return { error: "非法路径", status: 400 };
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { entries: [] };
    if (code === "ENOTDIR") return { error: "不是目录", status: 400 };
    return { error: "读取目录失败", status: 500 };
  }
  const entries: UserFileEntry[] = [];
  for (const d of dirents) {
    // 隐藏项（点开头）不对用户暴露，避免与内部元数据混淆
    if (d.name.startsWith(".")) continue;
    const abs = path.join(dir, d.name);
    try {
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) continue;
      entries.push({
        name: d.name,
        path: path.relative(root, abs).split(path.sep).join("/"),
        isDir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* 并发删除等：跳过该条 */
    }
  }
  // 目录在前；同类按名称自然序
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return { entries };
}

export function createUserFilesHandlers() {
  /** 取 root + 校验登录；未登录返回 401 */
  async function resolve(request: Request): Promise<{ root: string; sub: string } | Response> {
    const sub = currentUserSub(request);
    if (!sub) return err("未登录", 401);
    const root = userFilesRoot(sub);
    try {
      await fs.mkdir(root, { recursive: true });
    } catch {
      return err("用户目录不可用", 500);
    }
    return { root, sub };
  }

  async function GET(request: Request): Promise<Response> {
    const ctx = await resolve(request);
    if (ctx instanceof Response) return ctx;
    const url = new URL(request.url);
    const raw = url.searchParams.get("path") ?? "";
    // /raw = 下载/预览单个文件
    if (url.searchParams.get("raw") !== null) {
      const abs = safeUserFilePath(ctx.root, raw);
      if (!abs) return err("非法路径", 400);
      if (await hasSymlink(ctx.root, abs)) return err("非法路径", 400);
      let st: import("node:fs").Stats;
      try {
        st = await fs.stat(abs);
      } catch {
        return err("文件不存在", 404);
      }
      if (st.isDirectory()) return err("目标是目录", 400);
      const buf = await fs.readFile(abs).catch(() => null);
      if (!buf) return err("读取失败", 500);
      const headers: Record<string, string> = {
        "Content-Type": mimeFor(raw),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      };
      if (url.searchParams.get("download") !== null) {
        headers["Content-Disposition"] =
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`;
      } else if (mimeFor(raw).startsWith("text/html")) {
        // HTML 预览沙箱化，与产物预览一致
        headers["Content-Security-Policy"] = "sandbox";
      }
      return new Response(new Uint8Array(buf), { headers });
    }
    const res = await listDir(ctx.root, raw);
    if ("error" in res) return err(res.error, res.status);
    return json({ path: sanitizeArtifactName(raw.replace(/\\/g, "/")), entries: res.entries });
  }

  async function POST(request: Request): Promise<Response> {
    const ctx = await resolve(request);
    if (ctx instanceof Response) return ctx;
    const url = new URL(request.url);
    const op = url.pathname.endsWith("/mkdir") ? "mkdir" : url.pathname.endsWith("/rename") ? "rename" : "upload";

    if (op === "mkdir" || op === "rename") {
      let body: { path?: unknown; from?: unknown; to?: unknown };
      try {
        body = await request.json();
      } catch {
        return err("请求格式错误", 400);
      }
      if (op === "mkdir") {
        const abs = safeUserFilePath(ctx.root, body.path);
        if (!abs) return err("非法路径", 400);
        if (await hasSymlink(ctx.root, abs)) return err("非法路径", 400);
        if (abs === path.resolve(ctx.root)) return err("不能创建根目录", 400);
        try {
          await fs.mkdir(abs, { recursive: false });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") return err("同名目录已存在", 409);
          if (code === "ENOENT") return err("父目录不存在", 404);
          return err("创建失败", 500);
        }
        return json({ ok: true, path: path.relative(ctx.root, abs).split(path.sep).join("/") });
      }
      // rename：from/to 都要在自己的目录内，且目标不存在（不做隐式覆盖）
      const from = safeUserFilePath(ctx.root, body.from);
      const to = safeUserFilePath(ctx.root, body.to);
      if (!from || !to) return err("非法路径", 400);
      if (await hasSymlink(ctx.root, from) || await hasSymlink(ctx.root, to)) return err("非法路径", 400);
      if (from === path.resolve(ctx.root) || to === path.resolve(ctx.root)) return err("不能重命名根目录", 400);
      const toStat = await fs.stat(to).catch(() => null);
      if (toStat) return err("目标已存在", 409);
      try {
        await fs.rename(from, to);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return err("源不存在", 404);
        return err("重命名失败", 500);
      }
      return json({ ok: true, path: path.relative(ctx.root, to).split(path.sep).join("/") });
    }

    // upload：multipart，字段名 file；可选 query path = 目标子目录
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return err("请求格式错误", 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return err("没有收到文件", 400);
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_UPLOAD_BYTES) {
      return err(`文件超过 ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB 上限`, 400);
    }
    const dir = safeUserFilePath(ctx.root, url.searchParams.get("path") ?? "");
    if (!dir) return err("非法路径", 400);
    if (await hasSymlink(ctx.root, dir)) return err("非法路径", 400);
    // 保留原文件名（去路径成分 + 清洗），同名自动加 (n) 后缀，不静默覆盖
    const rawName = path.basename(String((file as File).name || "file")).replace(/[\\/:*?"<>|\s]+/g, "_");
    const base = sanitizeArtifactName(rawName);
    let name = base;
    for (let i = 1; i < 1000; i++) {
      const exists = await fs.stat(path.join(dir, name)).then(() => true).catch(() => false);
      if (!exists) break;
      const dot = base.lastIndexOf(".");
      name = dot > 0 ? `${base.slice(0, dot)}(${i})${base.slice(dot)}` : `${base}(${i})`;
    }
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), buf);
    } catch {
      return err("保存失败", 500);
    }
    // 资料库索引：把用户文件区上传登记进 agent_files（kind=userfile）；非致命。
    const folder = path.relative(ctx.root, dir).split(path.sep).join("/");
    await indexFile({
      ownerSub: ctx.sub,
      kind: "userfile",
      absPath: path.join(dir, name),
      name,
      sessionId: null,
      mime: mimeFor(rawName),
      folder: folder || null,
    }).catch(() => {});
    return json({
      ok: true,
      name,
      size: buf.length,
      path: path.relative(ctx.root, path.join(dir, name)).split(path.sep).join("/"),
    });
  }

  async function DELETE(request: Request): Promise<Response> {
    const ctx = await resolve(request);
    if (ctx instanceof Response) return ctx;
    const url = new URL(request.url);
    const abs = safeUserFilePath(ctx.root, url.searchParams.get("path") ?? "");
    if (!abs) return err("非法路径", 400);
    if (await hasSymlink(ctx.root, abs)) return err("非法路径", 400);
    if (abs === path.resolve(ctx.root)) return err("不能删除根目录", 400);
    let st: import("node:fs").Stats;
    try {
      st = await fs.stat(abs);
    } catch {
      return err("目标不存在", 404);
    }
    try {
      // 目录必须为空才删——递归删除风险太高，宁可让用户自己一层层清
      if (st.isDirectory()) await fs.rmdir(abs);
      else await fs.unlink(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (["ENOTEMPTY", "EEXIST"].includes(code ?? "")) return err("目录非空，请先清空", 409);
      return err("删除失败", 500);
    }
    return json({ ok: true });
  }

  return { GET, POST, DELETE };
}
