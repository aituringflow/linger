/**
 * agent-kit · 用户键与文件存储键
 *
 * 两个职责：
 *  1. 用户键（userKey）：把 `${provider}:${unionId}` 编码成**文件系统安全**的段。
 *     - 原始键含 `:`（Windows 路径非法字符）且 unionId 各 provider 字符集不一，
 *       不能直接当目录名；base64url 后确定、可逆、跨 OS 安全。
 *     - 这是「物理层要不要按用户分目录」时的安全落盘 key；即便决定 flat 存储，
 *       userKey 仍可用于调试/配额等场景。
 *  2. 文件存储键（storageKey）：flat + 哈希分片。flat 逻辑上无 user/session 层级
 *     （关系全在 agent_files 表），物理上仅按 fileId 哈希分 2 级目录，避免单目录
 *     百万文件拖垮文件系统。类比对象存储（S3/OSS）的 key，路径本身无意义。
 */

import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** 把 provider + unionId 编码为 URL-safe 的 userKey（无 padding）。 */
export function encodeUserKey(provider: string, unionId: string): string {
  const raw = `${provider}:${unionId}`;
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 解码 userKey 回 { provider, unionId }；非法返回 null。 */
export function decodeUserKey(key: string): { provider: string; unionId: string } | null {
  try {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(b64, "base64").toString("utf8");
    const i = raw.indexOf(":");
    if (i <= 0 || i === raw.length - 1) return null;
    return { provider: raw.slice(0, i), unionId: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

/** 仅保留文件系统安全字符（与 artifacts.ts 的 sanitizeSessionId 同口径）。
 *  fileId 由本模块生成（随机 UUID/ULID），此处仅作防御性清洗。 */
export function sanitizeFileId(id: string): string {
  const cleaned = String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "unknown";
}

/**
 * 计算文件的物理分片键：<2位hash>/<fileId>。
 *  逻辑上 fileId 是全局唯一句柄（URL/分享都用它），路径不含 user/session；
 *  物理上仅用 sha256(fileId) 前缀分 256 桶，防止单目录文件过多。
 *  fileId 本身应已随机均匀，sha256 进一步保证分片均衡、与内容无关。
 */
export function storageKey(fileId: string): string {
  const shard = createHash("sha256").update(fileId).digest("hex").slice(0, 2);
  return `${shard}/${sanitizeFileId(fileId)}`;
}

/** 由数据根目录 + 存储键解析真实磁盘路径（跨平台安全拼接）。 */
export function storagePath(dataDir: string, key: string): string {
  return path.join(dataDir, ...key.split("/").filter(Boolean).map((s) => sanitizeFileId(s)));
}

/**
 * 文件数据根：统一到单一可配置目录（决策：放弃按工作区散落，多用户 web 部署必须集中）。
 *  默认 <cwd>/data；可用 env AGENT_DATA_DIR 覆盖（建议指向独立磁盘/挂载）。
 */
export function agentDataDir(): string {
  return process.env.AGENT_DATA_DIR && process.env.AGENT_DATA_DIR.trim()
    ? path.resolve(process.env.AGENT_DATA_DIR.trim())
    : path.join(process.cwd(), "data");
}

/** 生成一个新 fileId（UUID v4，dash 保留；storageKey 内部会清洗）。 */
export function newFileId(): string {
  return randomUUID();
}
