import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 与 ota-server.ts 的 artifact() 保持一致的产物命名白名单（兼容旧式 win32-/darwin- 前缀与产品名前缀）
const VALID = /^[A-Za-z0-9][\w.-]*-\d+\.\d+\.\d+\.(?:exe|dmg)$/;
// 下载落地名白名单：字母、数字、空格、点、连字符、下划线，且必须以 .exe/.dmg 结尾
const VALID_NAME = /^[A-Za-z0-9 ._-]+\.(exe|dmg)$/;
// appId 白名单
const VALID_APP_ID = /^[a-z][a-z0-9_-]*$/;

const storageDir =
  process.env.OTA_STORAGE_DIR || path.join(process.cwd(), "ota-releases");
const defaultAppId = process.env.OTA_DEFAULT_APP || "agent";

// 解析多应用配置：与 updates/route.js 保持一致（默认通道 agent + launcher 通道）
function parseAppDirs() {
  const dirs = { [defaultAppId]: storageDir };
  if (defaultAppId !== "launcher") dirs.launcher = path.join(storageDir, "launcher");
  const env = process.env.OTA_APPS?.trim();
  if (env) {
    for (const pair of env.split(",")) {
      const [id] = pair.split(":").map((s) => s.trim());
      if (id && VALID_APP_ID.test(id) && id !== defaultAppId) {
        dirs[id] = path.join(storageDir, id);
      }
    }
  }
  return dirs;
}

// 网页下载专用：与 OTA 更新接口共用同一份产物文件，但把落地文件名
// 改写成友好名（如 Agent-Setup-0.1.4.exe），不动更新器依赖的内部名。
// 友好名由前端通过 ?name= 传入（已做格式校验），缺省回退到内部名。
// 通过 ?appId= 指定通道，未指定则使用默认通道。
export async function GET(request, { params }) {
  const { filename } = await params;
  if (!VALID.test(filename)) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const appId = url.searchParams.get("appId");
  const appDirs = parseAppDirs();
  let baseDir = appDirs[defaultAppId];
  // appId 提供但格式非法或未注册 → 404；未提供 → 默认通道（不静默回退）
  if (appId !== null && appId !== "") {
    if (!VALID_APP_ID.test(appId) || !appDirs[appId]) {
      return new Response("Not found", { status: 404 });
    }
    baseDir = appDirs[appId];
  }

  const full = path.join(baseDir, filename);
  // 双重保险：确保解析后仍落在 baseDir 内，杜绝路径穿越
  if (path.relative(baseDir, full).startsWith("..")) {
    return new Response("Not found", { status: 404 });
  }

  let stat;
  try {
    stat = await fs.promises.stat(full);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const wanted = url.searchParams.get("name");
  const dispName = wanted && VALID_NAME.test(wanted) ? wanted : filename;

  return new Response(Readable.toWeb(fs.createReadStream(full)), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(stat.size),
      // filename* 用 UTF-8 编码，兼容含空格的友好名；filename 作降级
      "Content-Disposition": `attachment; filename="${dispName}"; filename*=UTF-8''${encodeURIComponent(dispName)}`,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
