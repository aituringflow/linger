import path from "node:path";
import { createOtaReleaseHandlers } from "@turingflow/agent-kit/ota/server";
import { parseOtaApps, OTA_DEFAULT_APP_ID } from "../../../../lib/ota-apps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handlers = createOtaReleaseHandlers({
  storageDir: process.env.OTA_STORAGE_DIR || path.join(process.cwd(), "ota-releases"),
  uploadToken: process.env.OTA_UPLOAD_TOKEN,
  basePath: "/linger",
  // 与 /api/updates 共用同一注册表：否则未配置 OTA_APPS 时只剩默认通道 agent，
  // 桌面端以 ?appId=launcher 请求产物会被判定为未知通道，直接返回 404。
  apps: parseOtaApps(),
  defaultAppId: OTA_DEFAULT_APP_ID,
});

export async function GET(request, { params }) {
  return handlers.artifact(request, (await params).filename);
}
