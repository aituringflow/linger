/**
 * agent-kit · 文件存储层（flat + 哈希分片；关系全在 agent_files 表）
 *
 * 设计要点（见 docs/file-storage-architecture.md）：
 *   - 物理层 flat：字节一律落到 <AGENT_DATA_DIR>/<hh>/<fileId>，路径本身无意义（只防单目录过胖）；
 *   - 读取一律按 fileId → 鉴权 → storage_key 取字节，用户永不传入任何路径，
 *     路径穿越在结构上不可能；
 *   - 元数据（owner / session / kind）全在 agent_files 表，本模块不表达任何归属关系。
 *
 * 本模块不依赖 artifacts.ts，避免与产物收集逻辑形成循环依赖；mime 由调用方传入。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  agentDataDir,
  newFileId,
  storageKey,
  storagePath,
  sanitizeFileId,
} from "./user-key.js";
import {
  createFile,
  getFileById,
  readAccessForFile,
  hardDeleteFile,
  type FileRow,
  type QueryRunner,
} from "./auth/db.js";

export interface StoredFile {
  fileId: string;
  storageKey: string;
}

/**
 * 写字节：生成（或指定）fileId → 落到 storage_key → 返回 {fileId, storageKey}。
 * 用临时文件 + rename 原子替换，避免并发读到半截文件。调用方负责登记 agent_files。
 */
export async function writeFileBytes(buf: Buffer, opts?: { id?: string; suggestedName?: string }): Promise<StoredFile> {
  const fileId = opts?.id && sanitizeFileId(opts.id) !== "unknown" ? sanitizeFileId(opts.id) : newFileId();
  const key = storageKey(fileId);
  const abs = storagePath(agentDataDir(), key);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${newFileId()}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, abs);
  return { fileId, storageKey: key };
}

/** 读字节：仅接受 fileId（绝不接受路径）。返回 null 表示文件不存在。 */
export async function readFileBytes(fileId: string): Promise<Buffer | null> {
  const key = storageKey(sanitizeFileId(fileId));
  const abs = storagePath(agentDataDir(), key);
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** 删字节（硬删）。软删只改 DB 的 deleted_at，不动此处。 */
export async function deleteFileBytes(fileId: string): Promise<void> {
  const key = storageKey(sanitizeFileId(fileId));
  const abs = storagePath(agentDataDir(), key);
  await fs.unlink(abs).catch(() => {});
}

/**
 * 读取文件（安全核心）：fileId → 鉴权（登录用户 ACL 或分享 token）→ storage_key 取字节。
 * 任一环节失败返回 null（前端收到 404）。绝不接受路径、不做目录扫描。
 */
export async function readFile(
  fileId: string,
  viewerSub: string | null,
  shareToken: string | null = null,
  client?: QueryRunner,
): Promise<{ buf: Buffer; mime: string | null; name: string; kind: FileRow["kind"]; size: number } | null> {
  const allowed = await readAccessForFile(fileId, viewerSub, shareToken, client);
  if (!allowed) return null;
  const row = await getFileById(fileId, client);
  if (!row) return null;
  const buf = await readFileBytes(fileId);
  if (!buf) return null;
  return { buf, mime: row.mime, name: row.name, kind: row.kind, size: row.size };
}

/** 把字节写盘 + 登记索引（一步到位）。返回 stored（含 fileId）；失败返回 null（不阻塞主流程）。 */
export async function recordFileToStore(
  opts: {
    buf: Buffer;
    kind: FileRow["kind"];
    name: string;
    ownerSub: string;
    sessionId?: string | null;
    mime?: string | null;
    folder?: string | null;
    /** 指定 id（用于幂等去重，如输入按 owner+session+name 派生）；不传则随机 */
    id?: string;
  },
  client?: QueryRunner,
): Promise<StoredFile | null> {
  try {
    const stored = await writeFileBytes(opts.buf, { id: opts.id, suggestedName: opts.name });
    const created = await createFile(
      {
        id: stored.fileId,
        ownerSub: opts.ownerSub,
        sessionId: opts.sessionId ?? null,
        kind: opts.kind,
        name: opts.name,
        mime: opts.mime ?? null,
        size: opts.buf.length,
        storageKey: stored.storageKey,
        folder: opts.folder ?? null,
      },
      client,
    );
    if (!created) return null;
    return stored;
  } catch (e) {
    console.error(`[agent-kit file-store] recordFileToStore 失败:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** 把磁盘已有文件（按绝对路径）复制进数据根并登记索引（迁移 / 产物登记用）。 */
export async function recordExistingFile(
  absPath: string,
  opts: {
    kind: FileRow["kind"];
    name: string;
    ownerSub: string;
    sessionId?: string | null;
    mime?: string | null;
    folder?: string | null;
    id?: string;
  },
  client?: QueryRunner,
): Promise<StoredFile | null> {
  try {
    const buf = await fs.readFile(absPath);
    return await recordFileToStore(
      { buf, kind: opts.kind, name: opts.name, ownerSub: opts.ownerSub, sessionId: opts.sessionId, mime: opts.mime, folder: opts.folder, id: opts.id },
      client,
    );
  } catch (e) {
    console.error(`[agent-kit file-store] recordExistingFile 失败:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/** 硬删：字节 + 索引 + 分享。 */
export async function deleteStoredFile(fileId: string, client?: QueryRunner): Promise<void> {
  await hardDeleteFile(fileId, client);
  await deleteFileBytes(fileId);
}

/**
 * 把磁盘已有文件（按绝对路径）登记进资料库索引，并按 (owner, session/folder, name, 内容哈希) 幂等去重。
 *
 * 去重策略（内容感知，见 docs/file-storage-architecture.md）：
 *   - 同一用户 + 同会话(或 folder) + 同名 + **内容完全相同**（含重复上传同一文件）→ 同一 fileId → 幂等去重（仅刷新元数据/字节）；
 *   - 同名但 **内容不同** → 不同 fileId → 在资料库保留为相互独立的版本（不再静默覆盖旧版本）。
 *
 * 用于：模型产物、用户上传附件、用户文件区文件。失败返回 null（不阻塞主流程）。
 */
export async function indexFile(opts: {
  ownerSub: string;
  kind: FileRow["kind"];
  absPath: string;
  name: string;
  sessionId?: string | null;
  mime?: string | null;
  folder?: string | null;
}, client?: QueryRunner): Promise<StoredFile | null> {
  try {
    const buf = await fs.readFile(opts.absPath);
    // 内容感知：把文件 sha256 并入派生键，使"同名不同内容"落不同 fileId（保留版本），
    // 而"内容完全一致"仍收敛到同一 id（幂等去重）。只多一次读取，与旧实现读取次数持平。
    const contentHash = createHash("sha256").update(buf).digest("hex");
    const seed = `${opts.ownerSub}\0${opts.sessionId ?? ""}\0${opts.folder ?? ""}\0${opts.name}\0${contentHash}`;
    const id = createHash("sha256").update(seed).digest("hex").slice(0, 32);
    return await recordFileToStore(
      {
        buf,
        kind: opts.kind,
        name: opts.name,
        ownerSub: opts.ownerSub,
        sessionId: opts.sessionId,
        mime: opts.mime,
        folder: opts.folder,
        id,
      },
      client,
    );
  } catch (e) {
    console.error(`[agent-kit file-store] indexFile 读取失败:`, e instanceof Error ? e.message : e);
    return null;
  }
}
