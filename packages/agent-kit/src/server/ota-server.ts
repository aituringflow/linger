import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AI_DISPLAY_NAME } from "./names.js";

export interface OtaAppConfig {
  productName: string;
}

export interface OtaReleaseServerOptions {
  storageDir: string;
  uploadToken?: string;
  basePath?: string;
  /**
   * 兼容旧版：单一产品名。当 apps 未配置时作为唯一产品使用。
   */
  productName?: string;
  /**
   * 多应用通道配置：appId → 应用信息。
   * 例如 `{ chat: { productName: "Chat" }, desktop: { productName: "Desktop" } }`。
   * 未配置时退化为单应用模式（等价于 { [defaultAppId]: { productName } }）。
   */
  apps?: Record<string, OtaAppConfig>;
  /**
   * 默认 appId。请求未显式携带 appId 时使用此通道。
   * 默认通道的安装包与索引文件直接存放在 storageDir 根目录，
   * 其余通道存放在 storageDir/<appId>/ 子目录，实现零迁移兼容。
   */
  defaultAppId?: string;
}

const validVersion = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
const validPlatform = (value: unknown): value is "win32" | "darwin" => value === "win32" || value === "darwin";
// 安装包文件名白名单：允许旧式 win32-/darwin- 前缀，也允许产品名前缀（如 Agent-0.1.6.exe）
const VALID_FILENAME = /^[A-Za-z0-9][\w.-]*-\d+\.\d+\.\d+\.(?:exe|dmg)$/;
// appId 白名单：小写字母开头，仅含小写字母、数字、连字符、下划线
const VALID_APP_ID = /^[a-z][a-z0-9_-]*$/;
// 平台由扩展名判定（.dmg 为 macOS，其余为 Windows），不再依赖文件名前缀
const platformOfFilename = (filename: string): "win32" | "darwin" =>
  filename.toLowerCase().endsWith(".dmg") ? "darwin" : "win32";
const compareVersion = (a: string, b: string): number => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (pa[i] !== pb[i]) return pa[i] - pb[i]; }
  return 0;
};

export interface StoredRelease {
  platform: string;
  version: string;
  filename: string;
  size: number;
  sha256: string;
  url: string;
  appId?: string;
  uploadedAt?: string; // ISO 时间戳，记录安装包上传时间
  disabled?: boolean;
}

export function createOtaReleaseHandlers(options: OtaReleaseServerOptions) {
  const root = path.resolve(options.storageDir);

  // ---- 应用通道注册表 ----
  const configuredApps = options.apps ?? {};
  const defaultAppId = (typeof options.defaultAppId === "string" && VALID_APP_ID.test(options.defaultAppId))
    ? options.defaultAppId
    : "agent";
  // 确保默认通道始终存在
  if (!configuredApps[defaultAppId]) {
    const fallbackName = (typeof options.productName === "string" && /^[A-Za-z0-9][\w.-]*$/.test(options.productName))
      ? options.productName : AI_DISPLAY_NAME;
    configuredApps[defaultAppId] = { productName: fallbackName };
  }
  const appIds = Object.keys(configuredApps);

  /**
   * 解析 appId：未提供（null/undefined/空串）时用默认通道；
   * 提供了但格式非法或不在注册表 → 返回 null，调用方必须报错，绝不静默回退。
   */
  const resolveAppId = (raw: unknown): string | null => {
    if (raw === null || raw === undefined || raw === "") return defaultAppId;
    if (typeof raw === "string" && VALID_APP_ID.test(raw) && configuredApps[raw]) return raw;
    return null;
  };

  /** 某通道的存储根目录：默认通道用 root，其余用 root/<appId>/ */
  const appDir = (appId: string): string =>
    appId === defaultAppId ? root : path.join(root, appId);

  const metadataPath = (appId: string, platform: string) => path.join(appDir(appId), `${platform}.json`);

  const productNameOf = (appId: string): string =>
    configuredApps[appId]?.productName ?? AI_DISPLAY_NAME;

  const authorized = (request: Request) => {
    const secret = options.uploadToken;
    const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
    return !!secret && Buffer.byteLength(supplied) === Buffer.byteLength(secret) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(secret));
  };

  const readIndex = async (appId: string, platform: string): Promise<{ releases: StoredRelease[] }> => {
    try {
      const raw = JSON.parse(await fs.promises.readFile(metadataPath(appId, platform), "utf8"));
      if (Array.isArray(raw?.releases)) return raw;
      if (raw && typeof raw.version === "string") return { releases: [raw as StoredRelease] };
      return { releases: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { releases: [] };
      throw error;
    }
  };

  const writeIndex = async (appId: string, platform: string, index: { releases: StoredRelease[] }): Promise<void> => {
    const target = metadataPath(appId, platform);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(`${target}.tmp`, JSON.stringify(index));
    await fs.promises.rename(`${target}.tmp`, target);
  };

  /** 构造产物下载 URL（携带 appId 以便下载路由定位通道） */
  const artifactUrl = (appId: string, filename: string): string => {
    const basePath = (options.basePath ?? "").replace(/\/$/, "");
    const base = `${basePath}/api/updates/${encodeURIComponent(filename)}`;
    return appId === defaultAppId ? base : `${base}?appId=${encodeURIComponent(appId)}`;
  };

  const saveRelease = async (
    appId: string, platform: "win32" | "darwin", version: string,
    temporary: string, size: number, sha256: string,
  ): Promise<Response> => {
    const extension = platform === "win32" ? ".exe" : ".dmg";
    const filename = `${productNameOf(appId)}-${version}${extension}`;
    await fs.promises.mkdir(appDir(appId), { recursive: true });
    await fs.promises.rename(temporary, path.join(appDir(appId), filename));
    const release: StoredRelease = {
      platform, version, filename, size, sha256,
      url: artifactUrl(appId, filename),
      appId,
      disabled: false,
      uploadedAt: new Date().toISOString(),
    };
    const index = await readIndex(appId, platform);
    const existing = index.releases.findIndex((r) => r.version === version);
    if (existing >= 0) index.releases[existing] = release; else index.releases.push(release);
    await writeIndex(appId, platform, index);
    return Response.json(release, { status: 201 });
  };

  return {
    /** 列出所有已配置的应用通道 */
    apps(): Response {
      const list = appIds.map((id) => ({
        appId: id,
        productName: configuredApps[id].productName,
        isDefault: id === defaultAppId,
      }));
      return Response.json({ apps: list }, { headers: { "Cache-Control": "no-store" } });
    },

    async latest(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const platform = url.searchParams.get("platform");
      const appId = resolveAppId(url.searchParams.get("appId"));
      if (appId === null) return Response.json({ error: `unknown appId: ${url.searchParams.get("appId")}` }, { status: 400 });
      if (!validPlatform(platform)) return Response.json({ error: "platform must be win32 or darwin" }, { status: 400 });
      try {
        const index = await readIndex(appId, platform);
        const enabled = index.releases.filter((r) => !r.disabled).sort((a, b) => compareVersion(b.version, a.version));
        const release = enabled[0] ?? null;
        return Response.json(release ?? { release: null }, { headers: { "Cache-Control": "no-store" } });
      } catch {
        return Response.json({ error: "Cannot read release" }, { status: 500 });
      }
    },

    async list(request: Request): Promise<Response> {
      if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const url = new URL(request.url);
      const platform = url.searchParams.get("platform");
      const appIdParam = url.searchParams.get("appId");
      let targetAppIds: string[];
      if (appIdParam === null || appIdParam === "") {
        targetAppIds = appIds;
      } else {
        const aid = resolveAppId(appIdParam);
        if (aid === null) return Response.json({ error: `unknown appId: ${appIdParam}` }, { status: 400 });
        targetAppIds = [aid];
      }
      const platforms = validPlatform(platform) ? [platform] : (["win32", "darwin"] as const);

      let releases: StoredRelease[] = [];
      for (const aid of targetAppIds) {
        for (const p of platforms) {
          const idx = await readIndex(aid, p);
          releases = releases.concat(idx.releases);
        }
      }
      releases = await Promise.all(releases.map(async (r) => {
        if (r.uploadedAt) return r;
        const aid = r.appId ?? defaultAppId;
        try {
          const stat = await fs.promises.stat(path.join(appDir(aid), r.filename));
          return { ...r, uploadedAt: stat.mtime.toISOString() };
        } catch { return r; }
      }));
      releases.sort((a, b) => compareVersion(b.version, a.version));
      return Response.json({ releases }, { headers: { "Cache-Control": "no-store" } });
    },

    async upload(request: Request): Promise<Response> {
      if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const url = new URL(request.url);
      const appId = resolveAppId(url.searchParams.get("appId"));
      if (appId === null) return Response.json({ error: `unknown appId: ${url.searchParams.get("appId")}` }, { status: 400 });

      if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/octet-stream") {
        const params = url.searchParams;
        const platform = params.get("platform"), version = params.get("version"), originalName = params.get("filename");
        if (!validPlatform(platform) || !validVersion(version) || !originalName || !request.body)
          return Response.json({ error: "platform, version and filename are required" }, { status: 400 });
        const extension = platform === "win32" ? ".exe" : ".dmg";
        if (!originalName.toLowerCase().endsWith(extension))
          return Response.json({ error: `Expected ${extension} artifact` }, { status: 400 });
        const maxSize = 1024 * 1024 * 1024;
        const declaredSize = Number(request.headers.get("content-length"));
        if (declaredSize > maxSize) return Response.json({ error: "Artifact exceeds 1 GB" }, { status: 413 });
        await fs.promises.mkdir(appDir(appId), { recursive: true });
        const temporary = path.join(appDir(appId), `${productNameOf(appId)}-${version}${extension}.${randomUUID()}.tmp`);
        const hash = createHash("sha256");
        let size = 0;
        try {
          const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > maxSize) return callback(new Error("Artifact exceeds 1 GB"));
            hash.update(chunk);
            callback(null, chunk);
          } });
          await pipeline(Readable.fromWeb(request.body as import("node:stream/web").ReadableStream), meter, fs.createWriteStream(temporary));
          if (size < 1024) return Response.json({ error: "Artifact is too small" }, { status: 400 });
          return await saveRelease(appId, platform, version, temporary, size, hash.digest("hex"));
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : "Upload failed" }, { status: size > maxSize ? 413 : 500 });
        } finally {
          await fs.promises.rm(temporary, { force: true }).catch(() => {});
        }
      }

      let form: FormData;
      try { form = await request.formData(); }
      catch { return Response.json({ error: "Invalid multipart form" }, { status: 400 }); }
      const platform = form.get("platform"), version = form.get("version"), artifact = form.get("file");
      if (!validPlatform(platform) || !validVersion(version) || !(artifact instanceof File))
        return Response.json({ error: "platform, version and file are required" }, { status: 400 });
      const extension = platform === "win32" ? ".exe" : ".dmg";
      if (!artifact.name.toLowerCase().endsWith(extension) || artifact.size < 1024 || artifact.size > 1024 * 1024 * 1024)
        return Response.json({ error: `Expected ${extension} artifact up to 1 GB` }, { status: 400 });
      await fs.promises.mkdir(appDir(appId), { recursive: true });
      const temporary = path.join(appDir(appId), `${productNameOf(appId)}-${version}${extension}.${randomUUID()}.tmp`);
      const bytes = Buffer.from(await artifact.arrayBuffer());
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      try {
        await fs.promises.writeFile(temporary, bytes);
        return await saveRelease(appId, platform, version, temporary, bytes.length, sha256);
      } finally {
        await fs.promises.rm(temporary, { force: true }).catch(() => {});
      }
    },

    async remove(request: Request): Promise<Response> {
      if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      let body: { filename?: string; appId?: string };
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
      const filename = body.filename;
      const appId = resolveAppId(body.appId);
      if (appId === null) return Response.json({ error: `unknown appId: ${String(body.appId)}` }, { status: 400 });
      if (typeof filename !== "string" || !VALID_FILENAME.test(filename))
        return Response.json({ error: "filename is required" }, { status: 400 });
      const platform = platformOfFilename(filename);
      const index = await readIndex(appId, platform);
      const target = index.releases.find((r) => r.filename === filename);
      if (!target) return Response.json({ error: "Not found" }, { status: 404 });
      index.releases = index.releases.filter((r) => r.filename !== filename);
      await writeIndex(appId, platform, index);
      await fs.promises.rm(path.join(appDir(appId), filename), { force: true });
      return Response.json({ ok: true }, { status: 200 });
    },

    async toggle(request: Request): Promise<Response> {
      if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
      let body: { filename?: string; disabled?: boolean; appId?: string };
      try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON body" }, { status: 400 }); }
      const filename = body.filename;
      const appId = resolveAppId(body.appId);
      if (appId === null) return Response.json({ error: `unknown appId: ${String(body.appId)}` }, { status: 400 });
      const disabled = body.disabled === true;
      if (typeof filename !== "string" || !VALID_FILENAME.test(filename))
        return Response.json({ error: "filename is required" }, { status: 400 });
      const platform = platformOfFilename(filename);
      const index = await readIndex(appId, platform);
      const target = index.releases.find((r) => r.filename === filename);
      if (!target) return Response.json({ error: "Not found" }, { status: 404 });
      target.disabled = disabled;
      await writeIndex(appId, platform, index);
      return Response.json({ ok: true, release: target }, { status: 200 });
    },

    async artifact(request: Request, filename: string): Promise<Response> {
      if (!VALID_FILENAME.test(filename)) return new Response("Not found", { status: 404 });
      const appId = resolveAppId(new URL(request.url).searchParams.get("appId"));
      if (appId === null) return new Response("Not found", { status: 404 });
      const full = path.join(appDir(appId), filename);
      // 双重保险：确保解析后仍落在 appDir 内，杜绝路径穿越
      if (path.relative(appDir(appId), full).startsWith("..")) {
        return new Response("Not found", { status: 404 });
      }
      try {
        const stat = await fs.promises.stat(full);
        return new Response(Readable.toWeb(fs.createReadStream(full)) as ReadableStream, { headers: {
          "Content-Type": "application/octet-stream", "Content-Length": String(stat.size),
          "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "public, max-age=31536000, immutable",
        } });
      } catch { return new Response("Not found", { status: 404 }); }
    },
  };
}
