import path from "node:path";
import { createOtaReleaseHandlers } from "@turingflow/agent-kit/ota/server";
import { parseOtaApps, OTA_DEFAULT_APP_ID } from "../../../lib/ota-apps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 应用通道配置与 /api/updates/[filename] 共用 src/lib/ota-apps.js；
// 两处必须一致，否则会出现「清单能列出某个通道、产物下载却 404」的错位。
const handlers = createOtaReleaseHandlers({
  storageDir: process.env.OTA_STORAGE_DIR || path.join(process.cwd(), "ota-releases"),
  uploadToken: process.env.OTA_UPLOAD_TOKEN,
  basePath: "/linger",
  apps: parseOtaApps(),
  defaultAppId: OTA_DEFAULT_APP_ID,
});

export async function GET(request) {
  const url = new URL(request.url);
  // ?apps=1 返回可用通道列表
  if (url.searchParams.has("apps")) return handlers.apps();
  return url.searchParams.has("list") ? handlers.list(request) : handlers.latest(request);
}

export const POST = handlers.upload;
export const DELETE = handlers.remove;
export const PATCH = handlers.toggle;
