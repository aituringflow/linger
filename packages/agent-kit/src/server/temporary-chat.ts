import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import { closeSession } from "./session-store.js";
import { artifactRoot, artifactSessionDir, ARTIFACTS_DIR_NAME } from "./artifacts.js";

const chats = new Map<string, { owner: string; touchedAt: number }>();
const TTL = 30 * 60 * 1000;

export function isTemporaryChatId(id: string): boolean {
  return /^side_[a-zA-Z0-9_-]{8,120}$/.test(id);
}

function sweep() {
  const now = Date.now();
  for (const [id, chat] of chats) {
    const marker = path.join(artifactSessionDir(id), ".side-chat-owner");
    const touchedAt = fs.statSync(marker, { throwIfNoEntry: false })?.mtimeMs ?? chat.touchedAt;
    if (now - touchedAt <= TTL) continue;
    chats.delete(id);
    closeSession(id);
    void fs.promises.rm(artifactSessionDir(id), { recursive: true, force: true }).catch(() => {});
  }
}
async function sweepOrphans() {
  const root = path.join(artifactRoot(), ARTIFACTS_DIR_NAME);
  const now = Date.now();
  const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !isTemporaryChatId(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const marker = path.join(dir, ".side-chat-owner");
    const touchedAt = (await fs.promises.stat(marker).catch(() => null))?.mtimeMs
      ?? (await fs.promises.stat(dir).catch(() => null))?.mtimeMs ?? now;
    if (now - touchedAt <= TTL) continue;
    chats.delete(entry.name);
    closeSession(entry.name);
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
setInterval(() => { sweep(); void sweepOrphans().catch(() => {}); }, 60_000).unref?.();

/** The first chat or upload creates an owner-bound, nonpersistent session. */
export function authorizeTemporaryChat(request: Request, id: string, create: boolean): Response | null {
  const owner = verifySession(request, loadAuthConfig())?.sub;
  if (!owner) return Response.json({ error: "请先登录" }, { status: 401 });
  if (!isTemporaryChatId(id)) return Response.json({ error: "无效的临时会话 ID" }, { status: 400 });
  sweep();
  const chat = chats.get(id);
  if (chat && chat.owner !== owner) return Response.json({ error: "无权限访问该临时会话" }, { status: 403 });
  const dir = artifactSessionDir(id);
  const marker = path.join(dir, ".side-chat-owner");
  const digest = createHash("sha256").update(owner).digest("hex");
  if (!chat) {
    // The short-lived marker lets another server worker verify ownership without
    // creating a database session. An unmarked leftover directory is never claimed.
    let stored = "";
    try { stored = fs.readFileSync(marker, "utf8").trim(); } catch { /* new session */ }
    if (stored && stored !== digest) return Response.json({ error: "无权限访问该临时会话" }, { status: 403 });
    if (stored && Date.now() - fs.statSync(marker).mtimeMs > TTL) {
      void fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      return Response.json({ error: "临时会话已过期，请重新开始" }, { status: 410 });
    }
    if (!stored && (!create || fs.existsSync(dir))) {
      return Response.json({ error: "临时会话已过期，请重新开始" }, { status: 410 });
    }
    try {
      if (!stored) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(marker, digest, { flag: "wx", mode: 0o600 });
      }
    } catch {
      return Response.json({ error: "无法建立临时会话，请重试" }, { status: 503 });
    }
  }
  const touchedAt = Date.now();
  chats.set(id, { owner, touchedAt });
  try { fs.utimesSync(marker, new Date(touchedAt), new Date(touchedAt)); } catch { /* cleanup on expiry */ }
  return null;
}
