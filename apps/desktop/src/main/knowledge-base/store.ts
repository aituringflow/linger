import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { assetThumbPath, fileThumbPath } from "./assets.js";

/**
 * 知识库 SQLite 数据层。
 *
 * 每个知识库独立数据库，放在应用主目录 ~/.linger/knowledge/libraries/<ID>/kb.db。
 * 五张表：files / chunks / vec_chunks / fts_chunks / index_meta。
 *
 * 向量存储：第一版用 BLOB 存 float32 数组（EmbeddingGemma 2 维度 768），
 * 相似度计算在 JS 层做（点积/余弦）。后续可无缝切换 sqlite-vec HNSW 扩展。
 */

export type FileStatus = "pending" | "indexing" | "indexed" | "failed" | "removed";

export interface KbFile {
  id: number;
  path: string;
  mtimeMs: number;
  size: number;
  sha256: string;
  type: string;
  title: string;
  status: FileStatus;
  indexedAt: string | null;
  coverage: "unknown" | "complete" | "partial";
  error?: string | null;
  /** 拍摄时间（EXIF DateTimeOriginal，epoch ms）；无 EXIF 为 null，展示时回退 mtimeMs */
  dateTakenMs: number | null;
  /** GPS 纬度（南纬为负）；无定位为 null */
  lat: number | null;
  /** GPS 经度（西经为负）；无定位为 null */
  lon: number | null;
  /** 机型（Make + Model）；无信息为 null */
  camera: string | null;
  /** 元数据是否已扫描过（避免无 EXIF 的文件每次启动重复解析） */
  metaScanned: number;
}

/** 片段处理阶段，见 shared/types.ts 的 KnowledgeChunkStage */
export type ChunkStage = "ocr" | "describing" | "described" | "fallback" | "ready";
/** 视频/音频窗口的模态：video=画面嵌入，audio=音轨嵌入；文本/图片为 null */
export type ChunkModality = "video" | "audio";

export interface StoredChunkInput {
  text: string;
  headingPath: string;
  tokenCount: number;
  imagePath?: string;
  stage?: ChunkStage;
  /** 生成这条文字描述所用的大模型 id（仅图片描述片段有值） */
  describeModel?: string;
  videoStart?: number;
  videoEnd?: number;
  /** 视频画面窗口 / 视频音轨窗口；普通文本和图片为空 */
  modality?: ChunkModality;
}

export interface KbChunk {
  id: number;
  fileId: number;
  seq: number;
  text: string;
  headingPath: string;
  tokenCount: number;
  sha256: string;
  imagePath?: string;
  stage: ChunkStage;
  describeModel?: string;
  videoStart?: number;
  videoEnd?: number;
  modality?: ChunkModality | null;
}

export interface KbFileWithStats extends KbFile {
  chunkCount: number;
}

/** 文件浏览器的筛选条件（IPC 层做参数校验后原样传进来） */
export type FileKindFilter = "all" | "image" | "video" | "document";
export type FileStatusFilter = "all" | "queued" | "failed" | "indexed";
export type FileSortOrder = "date-desc" | "date-asc" | "name-asc" | "size-desc" | "added-desc";

export interface FileQuery {
  offset?: number;
  limit?: number;
  search?: string;
  kind?: FileKindFilter;
  status?: FileStatusFilter;
  sort?: FileSortOrder;
}

export interface FileQueryResult {
  items: Array<KbFileWithStats & { imagePath: string | null }>;
  total: number;
  groups: Array<{ year: string | null; count: number }>;
}

/** 排序表达式：图片优先用 EXIF 拍摄时间，缺失时回退文件 mtime（展示层也是这个口径）。 */
const SORT_SQL: Record<FileSortOrder, string> = {
  "date-desc": "COALESCE(f.dateTakenMs, f.mtimeMs) DESC, f.id DESC",
  "date-asc": "COALESCE(f.dateTakenMs, f.mtimeMs) ASC, f.id ASC",
  "name-asc": "f.title COLLATE NOCASE ASC, f.id ASC",
  "size-desc": "f.size DESC, f.id DESC",
  "added-desc": "f.id DESC",
};

const KIND_SQL: Record<FileKindFilter, string> = {
  all: "",
  image: "f.type = 'image'",
  video: "f.type = 'video'",
  document: "f.type NOT IN ('image', 'video')",
};

const STATUS_SQL: Record<FileStatusFilter, string> = {
  all: "",
  // 「待处理」把排队中和正在解析的算在一起：用户关心的是「还没好」
  queued: "f.status IN ('pending', 'indexing')",
  failed: "f.status = 'failed'",
  indexed: "f.status = 'indexed'",
};

const DB_VERSION = 1;

export class KnowledgeStore {
  private db: Database.Database;
  private dbPath: string;

  constructor(userDataDir: string) {
    const dir = userDataDir;
    fs.mkdirSync(dir, { recursive: true });
    this.dbPath = path.join(dir, "kb.db");
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS excluded_files (path TEXT PRIMARY KEY);

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        mtimeMs REAL NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        indexedAt TEXT,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fileId INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        text TEXT NOT NULL,
        headingPath TEXT NOT NULL DEFAULT '',
        tokenCount INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL,
        imagePath TEXT,
        stage TEXT NOT NULL DEFAULT 'ready',
        describeModel TEXT,
        videoStart REAL,
        videoEnd REAL,
        modality TEXT,
        UNIQUE(fileId, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(fileId);

      -- 向量存储：float32 BLOB，第一版在 JS 层算余弦相似度
      CREATE TABLE IF NOT EXISTS vec_chunks (
        chunkId INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        dim INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embedding_failures (
        chunkId INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        error TEXT NOT NULL,
        failedAt TEXT NOT NULL,
        silent INTEGER NOT NULL DEFAULT 0
      );

      -- FTS5 全文索引（中文用 jieba 预分词后写入，空格分隔）
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
        tokenized_text,
        content_rowid='id'
      );
    `);

    if (!(this.db.pragma("table_info(embedding_failures)") as any[]).some(c => c.name === "silent")) {
      this.db.exec("ALTER TABLE embedding_failures ADD COLUMN silent INTEGER NOT NULL DEFAULT 0");
    }

    // Existing indexes have no recorded coverage; never assume they are complete.
    if (!(this.db.pragma("table_info(files)") as any[]).some(c => c.name === "coverage")) {
      this.db.exec("ALTER TABLE files ADD COLUMN coverage TEXT NOT NULL DEFAULT 'unknown'");
    }
    if (!(this.db.pragma("table_info(chunks)") as any[]).some(c => c.name === "imagePath")) {
      this.db.exec("ALTER TABLE chunks ADD COLUMN imagePath TEXT; UPDATE files SET status = 'pending', error = NULL WHERE status != 'removed'");
    }
    if (!(this.db.pragma("table_info(chunks)") as any[]).some(c => c.name === "stage")) {
      // 只补一列存阶段状态；不改动任何已有片段、不重跑任何已索引文件。
      // 旧片段缺省视为已完成（ready），只有新索引的文件才会展示阶段进展。
      this.db.exec("ALTER TABLE chunks ADD COLUMN stage TEXT NOT NULL DEFAULT 'ready'");
    }
    if (!(this.db.pragma("table_info(chunks)") as any[]).some(c => c.name === "describeModel")) {
      // 记录生成图片文字描述所用的模型 id。旧片段为 NULL（当时没记录），
      // 不触发重索引——重新索引该文件时会补上。
      this.db.exec("ALTER TABLE chunks ADD COLUMN describeModel TEXT");
    }

    for (const column of ["videoStart", "videoEnd"]) {
      if (!(this.db.pragma("table_info(chunks)") as any[]).some(c => c.name === column)) this.db.exec(`ALTER TABLE chunks ADD COLUMN ${column} REAL`);
    }
    if (!(this.db.pragma("table_info(chunks)") as any[]).some(c => c.name === "modality")) {
      // 旧数据的视频窗口都是画面嵌入；音频窗口是新增模态，之后由重新索引补齐
      this.db.exec("ALTER TABLE chunks ADD COLUMN modality TEXT; UPDATE chunks SET modality = 'video' WHERE videoStart IS NOT NULL");
    }
    // 图片 EXIF 元数据：拍摄时间 / 经纬度 / 机型；metaScanned 标记是否已扫描过原文件
    for (const [col, ddl] of [
      ["dateTakenMs", "REAL"],
      ["lat", "REAL"],
      ["lon", "REAL"],
      ["camera", "TEXT"],
      ["metaScanned", "INTEGER NOT NULL DEFAULT 0"],
      // 手动「重新索引」的文件优先处理（不被几万张排队照片压在后面）
      ["priority", "INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!(this.db.pragma("table_info(files)") as any[]).some(c => c.name === col)) {
        this.db.exec(`ALTER TABLE files ADD COLUMN ${col} ${ddl}`);
      }
    }

    // Rebuild the older external-content FTS table, whose column did not exist on chunks.
    const fts = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'fts_chunks'").get() as { sql: string } | undefined;
    if (fts?.sql && /content\s*=\s*['"]chunks['"]/i.test(fts.sql)) {
      this.db.transaction(() => {
        this.db.exec("DROP TABLE fts_chunks; CREATE VIRTUAL TABLE fts_chunks USING fts5(tokenized_text)");
        this.db.exec("INSERT INTO fts_chunks(rowid, tokenized_text) SELECT id, text FROM chunks");
      })();
    }

    // 文件浏览器的筛选 / 排序走这些索引。上万文件时过滤「只看图片」「只看失败」
    // 不至于全表扫；索引很小，老库升级时一次建好即可。
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_files_type ON files(type);
      CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
      CREATE INDEX IF NOT EXISTS idx_files_title ON files(title COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_files_date ON files(dateTakenMs, mtimeMs);
    `);

    // Invalidate only video vectors created by the old per-frame averaging algorithm.
    // Keep chunks and locators intact; pending vectors are rebuilt by the normal queue.
    this.db.transaction(() => {
      const version = this.db.prepare("SELECT value FROM index_meta WHERE key = 'video_embedding_version'").get() as { value: string } | undefined;
      if (version?.value === "native-video-v1") return;
      this.db.prepare("UPDATE vec_chunks SET embedding = ?, dim = 0 WHERE chunkId IN (SELECT id FROM chunks WHERE videoStart IS NOT NULL AND videoEnd IS NOT NULL)").run(Buffer.alloc(0));
      this.db.prepare("INSERT INTO index_meta(key, value) VALUES('video_embedding_version', 'native-video-v1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    })();

    // Merge legacy sub-second tails without re-indexing entire videos. Existing
    // visual windows overlap; audio predecessors must be extended and re-embedded.
    this.db.transaction(() => {
      if (this.getMeta("short_video_tail_migration") === "v1") return;
      const tails = this.db.prepare(`SELECT c.id, c.fileId, c.videoStart, c.videoEnd, c.modality
        FROM chunks c JOIN files f ON f.id = c.fileId
        WHERE f.type = 'video' AND c.modality IN ('video', 'audio')
          AND c.videoStart IS NOT NULL AND c.videoEnd > c.videoStart
          AND c.videoEnd - c.videoStart < 1
          AND NOT EXISTS (SELECT 1 FROM chunks n WHERE n.fileId = c.fileId AND n.modality = c.modality AND n.videoStart > c.videoStart)
        ORDER BY c.fileId, c.modality`).all() as Array<{ id: number; fileId: number; videoStart: number; videoEnd: number; modality: "video" | "audio" }>;
      const previous = this.db.prepare(`SELECT id, videoStart, videoEnd FROM chunks
        WHERE fileId = ? AND modality = ? AND videoStart < ? ORDER BY videoStart DESC LIMIT 1`);
      for (const tail of tails) {
        const prior = previous.get(tail.fileId, tail.modality, tail.videoStart) as { id: number; videoStart: number; videoEnd: number } | undefined;
        // Only merge contiguous/overlapping windows; preserve standalone short videos.
        if (!prior || prior.videoEnd < tail.videoStart - 0.000001) continue;
        if (prior.videoEnd < tail.videoEnd) {
          const label = `${tail.modality === "audio" ? "音频" : "视频"} ${prior.videoStart.toFixed(1)}s–${tail.videoEnd.toFixed(1)}s`;
          this.db.prepare("UPDATE chunks SET videoEnd = ?, headingPath = ? WHERE id = ?").run(tail.videoEnd, label, prior.id);
          this.db.prepare("UPDATE vec_chunks SET embedding = ?, dim = 0 WHERE chunkId = ?").run(Buffer.alloc(0), prior.id);
          this.db.prepare("DELETE FROM embedding_failures WHERE chunkId = ?").run(prior.id);
        }
        this.db.prepare("DELETE FROM fts_chunks WHERE rowid = ?").run(tail.id);
        this.db.prepare("DELETE FROM chunks WHERE id = ?").run(tail.id);
      }
      this.db.prepare("INSERT INTO index_meta(key, value) VALUES('short_video_tail_migration', 'v1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    })();

    // 记录 schema 版本
    const row = this.db.prepare("SELECT value FROM index_meta WHERE key = 'version'").get() as { value: string } | undefined;
    if (!row) {
      this.db.prepare("INSERT INTO index_meta(key, value) VALUES('version', ?)").run(String(DB_VERSION));
    }
  }

  // ─── files ────────────────────────────────────────────────

  upsertFile(input: {
    path: string;
    mtimeMs: number;
    size: number;
    sha256: string;
    type: string;
    title: string;
    dateTakenMs?: number | null;
    lat?: number | null;
    lon?: number | null;
    camera?: string | null;
  }): { id: number; isNew: boolean; needsReindex: boolean } {
    if (this.isExcluded(input.path)) return { id: -1, isNew: false, needsReindex: false };
    const existing = this.db.prepare("SELECT id, mtimeMs, size, sha256, status FROM files WHERE path = ?").get(input.path) as
      | { id: number; mtimeMs: number; size: number; sha256: string; status: string }
      | undefined;

    if (existing) {
      // mtime can change without changing the contents; only the hash invalidates
      // an existing index. Failed files remain eligible for retry.
      const needsReindex = existing.sha256 !== input.sha256 || existing.status === "failed";
      if (needsReindex) {
        this.db.prepare(`UPDATE files SET mtimeMs = ?, size = ?, sha256 = ?, type = ?, title = ?,
          dateTakenMs = ?, lat = ?, lon = ?, camera = ?, metaScanned = 1, status = 'pending', error = NULL
          WHERE id = ?`)
          .run(input.mtimeMs, input.size, input.sha256, input.type, input.title,
            input.dateTakenMs ?? null, input.lat ?? null, input.lon ?? null, input.camera ?? null, existing.id);
      } else if (existing.mtimeMs !== input.mtimeMs || existing.size !== input.size) {
        this.db.prepare(`UPDATE files SET mtimeMs = ?, size = ?, type = ?, title = ?,
          dateTakenMs = ?, lat = ?, lon = ?, camera = ?, metaScanned = 1 WHERE id = ?`)
          .run(input.mtimeMs, input.size, input.type, input.title,
            input.dateTakenMs ?? null, input.lat ?? null, input.lon ?? null, input.camera ?? null, existing.id);
      }
      return { id: existing.id, isNew: false, needsReindex };
    }

    const result = this.db
      .prepare(`INSERT INTO files(path, mtimeMs, size, sha256, type, title, status,
        dateTakenMs, lat, lon, camera, metaScanned) VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, 1)`)
      .run(input.path, input.mtimeMs, input.size, input.sha256, input.type, input.title,
        input.dateTakenMs ?? null, input.lat ?? null, input.lon ?? null, input.camera ?? null);
    return { id: Number(result.lastInsertRowid), isNew: true, needsReindex: true };
  }

  isExcluded(filePath: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM excluded_files WHERE path = ?").get(filePath);
  }

  /** Remove derived records and remember the exclusion without modifying the source file. */
  excludeFile(fileId: number): boolean {
    const assets: string[] = [];
    let sha256 = "";
    const removed = this.db.transaction(() => {
      const file = this.db.prepare("SELECT path, sha256 FROM files WHERE id = ?").get(fileId) as { path: string; sha256: string } | undefined;
      if (!file) return false;
      sha256 = file.sha256;
      // 先记下这个文件用到的图片副本，删完记录后再判断是否还有别的片段引用
      for (const row of this.db.prepare("SELECT DISTINCT imagePath FROM chunks WHERE fileId = ? AND imagePath IS NOT NULL").all(fileId) as Array<{ imagePath: string }>) {
        assets.push(row.imagePath);
      }
      this.db.prepare("INSERT OR IGNORE INTO excluded_files(path) VALUES (?)").run(file.path);
      this.db.prepare("DELETE FROM fts_chunks WHERE rowid IN (SELECT id FROM chunks WHERE fileId = ?)").run(fileId);
      this.db.prepare("DELETE FROM files WHERE id = ?").run(fileId);
      return true;
    })();
    if (removed) {
      this.removeUnreferencedAssets(assets);
      this.removeFileThumbnails([sha256]);
    }
    return removed;
  }

  /**
   * 删除不再被任何片段引用的图片副本和缩略图。
   * 图片按内容哈希命名、可能被多个文件共用（同一张插图出现在多份文档里），
   * 所以必须先确认没有别的片段还指着它。
   */
  private removeUnreferencedAssets(assets: string[]): void {
    for (const asset of new Set(assets)) {
      if (!asset) continue;
      // Only derived assets inside this library may be removed. A chunk can
      // reference a user-owned original, which must never be unlinked here.
      const assetRoot = path.resolve(this.assetDirectory());
      const resolved = path.resolve(asset);
      if (!resolved.startsWith(assetRoot + path.sep)) continue;
      if (this.db.prepare("SELECT 1 FROM chunks WHERE imagePath = ? LIMIT 1").get(asset)) continue;
      try { fs.unlinkSync(asset); } catch { /* 文件已不存在 */ }
      try { fs.unlinkSync(assetThumbPath(asset)); } catch { /* 缩略图可能没生成过 */ }
    }
  }

  /** 删除独立图片按原文件 sha256 命名的缩略图（同一个 sha 还被别的记录引用时保留）。 */
  private removeFileThumbnails(shas: string[]): void {
    for (const sha of new Set(shas)) {
      if (!sha) continue;
      if (this.db.prepare("SELECT 1 FROM files WHERE sha256 = ? LIMIT 1").get(sha)) continue;
      try { fs.unlinkSync(fileThumbPath(path.dirname(this.thumbnailDirectory()), sha)); } catch { /* 没生成过 */ }
    }
  }

  /** 回填元数据：读取原文件 EXIF 后落库，并标记已扫描（无 EXIF 也不再重复读）。 */
  markFileMetaScanned(id: number, meta: { dateTakenMs: number | null; lat: number | null; lon: number | null; camera: string | null }): void {
    this.db.prepare(`UPDATE files SET dateTakenMs = ?, lat = ?, lon = ?, camera = ?, metaScanned = 1 WHERE id = ?`)
      .run(meta.dateTakenMs, meta.lat, meta.lon, meta.camera, id);
  }

  /** 尚未扫描过元数据的文件（启动后做一次轻量回填，不触发重新解析/嵌入）。 */
  listFilesMissingMeta(limit: number): Array<{ id: number; path: string; type: string }> {
    return this.db
      .prepare("SELECT id, path, type FROM files WHERE metaScanned = 0 AND status != 'removed' LIMIT ?")
      .all(limit) as Array<{ id: number; path: string; type: string }>;
  }

  getFileByPath(filePath: string): KbFile | null {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(filePath) as any;
    return row ? this.rowToFile(row) : null;
  }

  /** 按 id 取单个文件：重索引 / 缩略图这类单文件操作不该把整库读进内存。 */
  getFileById(id: number): KbFile | null {
    const row = this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as any;
    return row ? this.rowToFile(row) : null;
  }

  /**
   * 文件浏览器的查询入口：搜索 / 类型 / 状态 / 排序 / 分页。
   *
   * 只对当前页做 chunkCount 和 imagePath 子查询 —— 一万个文件时按需取一页，
   * 比把整库 rows（每个还带 COUNT 子查询）拉出来再前端筛选快一个量级。
   */
  queryFiles(query: FileQuery = {}): FileQueryResult {
    const where: string[] = ["f.status != 'removed'"];
    const params: Array<string | number> = [];

    const search = typeof query.search === "string" ? query.search.trim() : "";
    if (search) {
      // 转义 LIKE 通配符：否则搜「100%」会被当成通配模式
      const escaped = search.replace(/[\\%_]/g, (char) => `\\${char}`);
      where.push("(f.title LIKE ? ESCAPE '\\' OR f.path LIKE ? ESCAPE '\\')");
      params.push(`%${escaped}%`, `%${escaped}%`);
    }
    const has = (table: Record<string, string>, key: unknown): key is string => typeof key === "string" && Object.prototype.hasOwnProperty.call(table, key);
    const kind: FileKindFilter = has(KIND_SQL, query.kind) ? (query.kind as FileKindFilter) : "all";
    if (KIND_SQL[kind]) where.push(KIND_SQL[kind]);
    const status: FileStatusFilter = has(STATUS_SQL, query.status) ? (query.status as FileStatusFilter) : "all";
    if (STATUS_SQL[status]) where.push(STATUS_SQL[status]);
    const sort: FileSortOrder = has(SORT_SQL, query.sort) ? (query.sort as FileSortOrder) : "date-desc";
    const limit = Number.isSafeInteger(query.limit) ? Math.min(500, Math.max(1, query.limit as number)) : 100;
    const offset = Number.isSafeInteger(query.offset) ? Math.max(0, query.offset as number) : 0;
    const clause = where.join(" AND ");

    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM files f WHERE ${clause}`).get(...params) as { n: number }).n;
    const groups = sort === "date-desc" || sort === "date-asc"
      ? this.db.prepare(`SELECT strftime('%Y', COALESCE(f.dateTakenMs, f.mtimeMs) / 1000, 'unixepoch', 'localtime') AS year, COUNT(*) AS count FROM files f WHERE ${clause} GROUP BY year ORDER BY year ${sort === "date-desc" ? "DESC" : "ASC"}`).all(...params) as Array<{ year: string | null; count: number }>
      : [];
    const rows = this.db
      .prepare(`
        SELECT f.*,
          (SELECT COUNT(*) FROM chunks c WHERE c.fileId = f.id) AS chunkCount,
          (SELECT c.imagePath FROM chunks c WHERE c.fileId = f.id AND c.imagePath IS NOT NULL LIMIT 1) AS imagePath
        FROM files f
        WHERE ${clause}
        ORDER BY ${SORT_SQL[sort]}
        LIMIT ? OFFSET ?
      `)
      .all(...params, limit, offset) as any[];
    return { total, groups, items: rows.map((r) => ({ ...this.rowToFile(r), chunkCount: r.chunkCount, imagePath: r.imagePath ?? null })) };
  }

  listFiles(limit = -1, offset = 0): KbFileWithStats[] {
    const rows = this.db
      .prepare(`
        SELECT f.*, (SELECT COUNT(*) FROM chunks c WHERE c.fileId = f.id) AS chunkCount
        FROM files f
        ORDER BY f.id ASC
        LIMIT ? OFFSET ?
      `)
      .all(limit, offset) as any[];
    return rows.map((r) => ({ ...this.rowToFile(r), chunkCount: r.chunkCount }));
  }

  /**
   * 轻量文件清单（只要 id + 路径）。
   * 孤儿清理只需要路径，别为了干净检查把每行的 chunkCount 都算一遍。
   */
  listFilePaths(): Array<{ id: number; path: string }> {
    return this.db.prepare("SELECT id, path FROM files WHERE status != 'removed'").all() as Array<{ id: number; path: string }>;
  }

  recoverInterruptedFiles(): void {
    this.db.prepare("UPDATE files SET status = 'pending', error = NULL WHERE status = 'indexing' OR (status = 'failed' AND error = ?)").run("Cannot use 'in' operator to search for 'families' in undefined");
  }

  /** 刷新时修复旧版当作成功保存的 OCR 回退和工具调用文本。 */
  retryFallbackFiles(): void {
    this.db.prepare(`UPDATE files SET status = 'pending', error = NULL WHERE status = 'indexed' AND id IN (
      SELECT fileId FROM chunks WHERE stage = 'fallback' OR (stage = 'described' AND
        (lower(text) LIKE '%<tool_call:%' OR lower(text) LIKE '%<tool_calls:%' OR lower(text) LIKE '%<tool_call %' OR lower(text) LIKE '%<tool_call>%'))
    )`).run();
  }

  listPendingFiles(): KbFile[] {
    // 新照片先索引：用户更关心「最近拍了什么」，老照片可以慢慢补。
    // 手动触发重新索引的文件（priority=1）插到最前面，避免被几万张照片压在后面。
    // 排序口径与列表一致（EXIF 拍摄时间，缺失回退 mtime）。
    const rows = this.db.prepare("SELECT * FROM files WHERE status = 'pending' ORDER BY priority DESC, COALESCE(dateTakenMs, mtimeMs) DESC, id DESC").all() as any[];
    return rows.map((r) => this.rowToFile(r));
  }

  /** 手动重新索引时把文件提到队首（视频音频这类新能力尤其需要立刻验证）。 */
  setFilePriority(id: number, priority: number): void {
    this.db.prepare("UPDATE files SET priority = ? WHERE id = ?").run(priority, id);
  }

  updateFileStatus(id: number, status: FileStatus, error?: string): void {
    if (status === "indexed") {
      this.db.prepare("UPDATE files SET status = ?, indexedAt = ?, error = ? WHERE id = ?").run(status, new Date().toISOString(), error ?? null, id);
    } else {
      this.db.prepare("UPDATE files SET status = ?, error = ? WHERE id = ?").run(status, error ?? null, id);
    }
  }

  markFileRemoved(filePath: string): void {
    this.db.prepare("UPDATE files SET status = 'removed' WHERE path = ?").run(filePath);
  }

  deleteFile(filePath: string): void {
    // chunks 和 vec_chunks 通过 ON DELETE CASCADE 级联删除
    // FTS5 外链表需要手动同步
    const file = this.getFileByPath(filePath);
    if (file) {
      const assets = (this.db.prepare("SELECT DISTINCT imagePath FROM chunks WHERE fileId = ? AND imagePath IS NOT NULL").all(file.id) as Array<{ imagePath: string }>).map((row) => row.imagePath);
      this.db.prepare("DELETE FROM fts_chunks WHERE rowid IN (SELECT id FROM chunks WHERE fileId = ?)").run(file.id);
      this.db.prepare("DELETE FROM files WHERE id = ?").run(file.id);
      this.removeUnreferencedAssets(assets);
      this.removeFileThumbnails([file.sha256]);
    }
  }

  cleanOrphans(): number {
    // 清理物理上已不存在的文件及其 chunks；只取 id/path，避免为上万个文件算 chunkCount
    let removed = 0;
    for (const file of this.listFilePaths()) {
      if (!fs.existsSync(file.path)) {
        this.deleteFile(file.path);
        removed++;
      }
    }
    return removed;
  }

  // ─── chunks ──────────────────────────────────────────────

  /** 写入一批片段（先清空该文件的旧片段），返回新片段 id（顺序与入参一致） */
  private writeChunks(fileId: number, chunks: StoredChunkInput[]): number[] {
    // 重新索引前先快照旧片段的向量：内容没变的片段直接复用，避免「改一行就整篇重嵌入」。
    // 图片按内容哈希命名，路径相同即图片相同；视频窗口的语义随文件内容变化，不能跨版本复用。
    const reusable = new Map<string, { embedding: Buffer; dim: number }>();
    const old = this.db.prepare(`
      SELECT c.sha256, c.imagePath, c.videoStart, v.embedding, v.dim
      FROM chunks c JOIN vec_chunks v ON v.chunkId = c.id
      WHERE c.fileId = ? AND v.dim > 0
    `).all(fileId) as Array<{ sha256: string; imagePath: string | null; videoStart: number | null; embedding: Buffer; dim: number }>;
    for (const row of old) {
      if (row.videoStart !== null) continue;
      const key = row.imagePath ? `img:${row.imagePath}` : `txt:${row.sha256}`;
      if (!reusable.has(key)) reusable.set(key, { embedding: row.embedding, dim: row.dim });
    }

    this.db.prepare("DELETE FROM fts_chunks WHERE rowid IN (SELECT id FROM chunks WHERE fileId = ?)").run(fileId);
    this.db.prepare("DELETE FROM chunks WHERE fileId = ?").run(fileId);

    const insertChunk = this.db.prepare(
      "INSERT INTO chunks(fileId, seq, text, headingPath, tokenCount, sha256, imagePath, stage, videoStart, videoEnd, modality) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertFts = this.db.prepare("INSERT INTO fts_chunks(rowid, tokenized_text) VALUES(?, ?)");
    const insertVec = this.db.prepare("INSERT INTO vec_chunks(chunkId, embedding, dim) VALUES(?, ?, ?)");
    const ids: number[] = [];

    chunks.forEach((chunk, idx) => {
      const hash = createHash("sha256").update(chunk.text).digest("hex");
      const reuseKey = chunk.videoStart != null || chunk.videoEnd != null
        ? null
        : chunk.imagePath ? `img:${chunk.imagePath}` : `txt:${hash}`;
      const reused = reuseKey ? reusable.get(reuseKey) : undefined;
      // 旧调用没有 modality：带视频时间范围的默认是画面窗口
      const modality = chunk.modality ?? (chunk.videoStart != null || chunk.videoEnd != null ? "video" : null);
      const result = insertChunk.run(fileId, idx, chunk.text, chunk.headingPath, chunk.tokenCount, hash, chunk.imagePath ?? null, chunk.stage ?? "ready", chunk.videoStart ?? null, chunk.videoEnd ?? null, modality);
      const chunkId = Number(result.lastInsertRowid);
      ids.push(chunkId);
      insertFts.run(chunkId, chunk.text);
      // 向量占位：没命中复用的才等待 embedding 模块回填
      insertVec.run(chunkId, reused?.embedding ?? Buffer.alloc(0), reused?.dim ?? 0);
    });
    return ids;
  }

  replaceChunks(fileId: number, chunks: StoredChunkInput[], expectedHash?: string): number {
    const tx = this.db.transaction(() => {
      if (expectedHash !== undefined) {
        const file = this.db.prepare("SELECT sha256, status FROM files WHERE id = ?").get(fileId) as { sha256: string; status: string } | undefined;
        if (!file || file.sha256 !== expectedHash || file.status !== "indexing") return false;
      }
      this.writeChunks(fileId, chunks);
      if (expectedHash !== undefined) this.updateFileStatus(fileId, "indexed");
      return true;
    });
    return tx() ? chunks.length : -1;
  }

  /**
   * 两阶段索引的第一步：先把「OCR 完成」的占位片段落库，让 UI 立刻可见。
   * 文件保持 indexing 状态，等大模型描述写完再由 finishIndexing 收尾。
   */
  beginChunks(fileId: number, chunks: StoredChunkInput[], expectedHash: string): number[] | null {
    const tx = this.db.transaction(() => {
      const file = this.db.prepare("SELECT sha256, status FROM files WHERE id = ?").get(fileId) as { sha256: string; status: string } | undefined;
      if (!file || file.sha256 !== expectedHash || file.status !== "indexing") return null;
      return this.writeChunks(fileId, chunks);
    });
    return tx();
  }

  /** Append a bounded batch while a file is indexing. Partial files remain unsearchable. */
  appendChunks(fileId: number, chunks: StoredChunkInput[], expectedHash: string): boolean {
    return this.db.transaction(() => {
      const file = this.db.prepare("SELECT sha256, status FROM files WHERE id = ?").get(fileId) as { sha256: string; status: string } | undefined;
      if (!file || file.sha256 !== expectedHash || file.status !== "indexing") return false;
      let seq = (this.db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM chunks WHERE fileId = ?").get(fileId) as { n: number }).n;
      const insert = this.db.prepare("INSERT INTO chunks(fileId, seq, text, headingPath, tokenCount, sha256, stage) VALUES(?, ?, ?, ?, ?, ?, 'ready')");
      const fts = this.db.prepare("INSERT INTO fts_chunks(rowid, tokenized_text) VALUES(?, ?)");
      const vec = this.db.prepare("INSERT INTO vec_chunks(chunkId, embedding, dim) VALUES(?, ?, 0)");
      for (const chunk of chunks) {
        const hash = createHash("sha256").update(chunk.text).digest("hex");
        const id = Number(insert.run(fileId, seq++, chunk.text, chunk.headingPath, chunk.tokenCount, hash).lastInsertRowid);
        fts.run(id, chunk.text); vec.run(id, Buffer.alloc(0));
      }
      return true;
    })();
  }

  /** 两阶段索引的第二步：确认文件没被改动后置为 indexed */
  finishIndexing(fileId: number, expectedHash: string, warning?: string): boolean {
    const tx = this.db.transaction(() => {
      const file = this.db.prepare("SELECT sha256, status, type FROM files WHERE id = ?").get(fileId) as { sha256: string; status: string; type: string } | undefined;
      if (!file || file.sha256 !== expectedHash || file.status !== "indexing") return false;
      this.updateFileStatus(fileId, "indexed", warning);
      // A missing truncation flag does not establish complete coverage for
      // complex formats (e.g. image-only pages or unsupported embedded objects).
      this.db.prepare("UPDATE files SET coverage = ? WHERE id = ?").run(warning ? "partial" : ["text", "csv"].includes(file.type) ? "complete" : "unknown", fileId);
      return true;
    });
    return tx();
  }

  /**
   * 就地更新一个片段（大模型描述返回后把 OCR 占位替换成最终文字）。
   * 同步 FTS 与向量占位：文字变了，旧向量必须作废重新嵌入。
   */
  updateChunk(chunkId: number, patch: Partial<Pick<StoredChunkInput, "text" | "headingPath" | "tokenCount" | "stage" | "describeModel">>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ["text", "headingPath", "tokenCount", "stage", "describeModel"] as const) {
      if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(patch[key]); }
    }
    this.db.transaction(() => {
      if (fields.length) this.db.prepare(`UPDATE chunks SET ${fields.join(", ")} WHERE id = ?`).run(...values, chunkId);
      if (patch.text !== undefined) {
        this.db.prepare("DELETE FROM fts_chunks WHERE rowid = ?").run(chunkId);
        this.db.prepare("INSERT INTO fts_chunks(rowid, tokenized_text) VALUES(?, ?)").run(chunkId, patch.text);
        this.db.prepare("UPDATE vec_chunks SET embedding = ?, dim = 0 WHERE chunkId = ?").run(Buffer.alloc(0), chunkId);
      }
    })();
  }

  /** OCR 与模型都没产出文字时，删掉空的文字占位片段，避免出现空气泡 */
  deleteChunk(chunkId: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM fts_chunks WHERE rowid = ?").run(chunkId);
      this.db.prepare("DELETE FROM chunks WHERE id = ?").run(chunkId);
    })();
  }

  getChunksByFileId(fileId: number): Array<KbChunk & { dimension: number }> {
    const rows = this.db.prepare("SELECT c.*, COALESCE(v.dim, 0) AS dimension FROM chunks c LEFT JOIN vec_chunks v ON v.chunkId = c.id WHERE c.fileId = ? ORDER BY c.seq").all(fileId) as any[];
    return rows.map((r) => ({ ...this.rowToChunk(r), dimension: r.dimension }));
  }

  getAllChunksForEmbedding(limit = -1): Array<{ id: number; text: string; imagePath?: string; videoStart?: number; videoEnd?: number; modality?: ChunkModality | null; filePath: string; fileHash: string }> {
    // 取所有还没有向量的 chunks（dim = 0 表示待嵌入）
    const rows = this.db
      .prepare(`
        SELECT c.id, c.text, c.imagePath, c.videoStart, c.videoEnd, c.modality, f.path AS filePath, f.sha256 AS fileHash FROM chunks c
        JOIN files f ON f.id = c.fileId
        JOIN vec_chunks v ON v.chunkId = c.id
        WHERE v.dim = 0 AND f.status = 'indexed'
          AND NOT EXISTS (SELECT 1 FROM embedding_failures e WHERE e.chunkId = c.id)
          -- OCR 占位 / 大模型描述中的文字片段还没定稿，不能提前嵌入
          AND COALESCE(c.stage, 'ready') NOT IN ('ocr', 'describing')
        ORDER BY c.id LIMIT ?
      `)
      .all(limit) as any[];
    return rows.map((r) => ({ id: r.id, text: r.text, imagePath: r.imagePath ?? undefined, videoStart: r.videoStart ?? undefined, videoEnd: r.videoEnd ?? undefined, modality: (r.modality ?? null) as ChunkModality | null, filePath: r.filePath, fileHash: r.fileHash }));
  }

  updateEmbedding(chunkId: number, embedding: Float32Array, expectedFileHash?: string): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.prepare("UPDATE vec_chunks SET embedding = ?, dim = ? WHERE chunkId = ? AND (? IS NULL OR EXISTS (SELECT 1 FROM chunks c JOIN files f ON f.id = c.fileId WHERE c.id = vec_chunks.chunkId AND f.status = 'indexed' AND f.sha256 = ?))").run(buf, embedding.length, chunkId, expectedFileHash ?? null, expectedFileHash ?? null);
  }

  recordEmbeddingFailure(chunkId: number, expectedFileHash: string, error: string, silent = false): void {
    this.db.prepare(`INSERT INTO embedding_failures(chunkId, error, failedAt, silent)
      SELECT c.id, ?, ?, ? FROM chunks c JOIN files f ON f.id = c.fileId
      JOIN vec_chunks v ON v.chunkId = c.id
      WHERE c.id = ? AND f.sha256 = ? AND f.status = 'indexed' AND v.dim = 0
      ON CONFLICT(chunkId) DO UPDATE SET error = excluded.error, failedAt = excluded.failedAt, silent = excluded.silent`)
      .run(error.slice(0, 1000), new Date().toISOString(), silent ? 1 : 0, chunkId, expectedFileHash);
  }

  getEmbedding(chunkId: number): Float32Array | null {
    const row = this.db.prepare("SELECT embedding, dim FROM vec_chunks WHERE chunkId = ?").get(chunkId) as
      | { embedding: Buffer; dim: number }
      | undefined;
    if (!row || row.dim === 0) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dim);
  }

  // ─── 检索 ────────────────────────────────────────────────

  /** FTS5 BM25 关键词检索 */
  searchByKeyword(query: string, limit = 50): Array<{ chunkId: number; score: number; text: string }> {
    // 用 BM25 排序：fts5 内置 bm25() 函数，值越小越相关（取负号转成越大越相关）
    const rows = this.db
      .prepare(
        `
        SELECT c.id AS chunkId, c.text, bm25(fts_chunks) AS rank
        FROM fts_chunks
        JOIN chunks c ON c.id = fts_chunks.rowid
        JOIN files f ON f.id = c.fileId
        WHERE f.status = 'indexed' AND fts_chunks MATCH ?
        ORDER BY rank
        LIMIT ?
      `
      )
      .all(query, limit) as any[];
    return rows.map((r) => ({ chunkId: r.chunkId, score: -r.rank, text: r.text }));
  }

  /** 向量相似度检索（JS 层余弦相似度，第一版）；可按模态过滤（语音召回只看音频窗口）。 */
  searchByVector(queryVec: Float32Array, limit = 50, modality?: ChunkModality): Array<{ chunkId: number; score: number }> {
    const rows = this.db
      .prepare(`SELECT v.chunkId, v.embedding, v.dim FROM vec_chunks v JOIN chunks c ON c.id = v.chunkId JOIN files f ON f.id = c.fileId WHERE v.dim > 0 AND f.status = 'indexed'${modality ? " AND c.modality = ?" : ""}`)
      .all(...(modality ? [modality] : [])) as Array<{ chunkId: number; embedding: Buffer; dim: number }>;

    const queryNorm = Math.sqrt(queryVec.reduce((s, v) => s + v * v, 0));
    if (queryNorm === 0) return [];

    const scored = rows.map((row) => {
      const vec = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dim);
      let dot = 0;
      let norm = 0;
      for (let i = 0; i < row.dim; i++) {
        dot += queryVec[i] * vec[i];
        norm += vec[i] * vec[i];
      }
      const cosine = dot / (queryNorm * Math.sqrt(norm) + 1e-10);
      return { chunkId: row.chunkId, score: cosine };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  getChunkById(chunkId: number): (KbChunk & { filePath: string; fileTitle: string; fileSha256: string; coverage: KbFile["coverage"] } & Pick<KbFile, "dateTakenMs" | "lat" | "lon" | "camera" | "mtimeMs">) | null {
    const row = this.db
      .prepare(`
        SELECT c.*, f.path AS filePath, f.title AS fileTitle, f.sha256 AS fileSha256, f.coverage AS coverage,
               f.dateTakenMs AS dateTakenMs, f.lat AS lat, f.lon AS lon, f.camera AS camera, f.mtimeMs AS mtimeMs
        FROM chunks c
        JOIN files f ON f.id = c.fileId
        WHERE c.id = ?
      `)
      .get(chunkId) as any;
    if (!row) return null;
    return {
      ...this.rowToChunk(row),
      filePath: row.filePath,
      fileTitle: row.fileTitle,
      fileSha256: row.fileSha256,
      coverage: row.coverage ?? "unknown",
      dateTakenMs: row.dateTakenMs ?? null,
      lat: row.lat ?? null,
      lon: row.lon ?? null,
      camera: row.camera ?? null,
      mtimeMs: row.mtimeMs,
    };
  }

  /**
   * 图片文件的「原图」落盘路径。
   *
   * 独立的图片文件会切成一对片段：文字描述片段（用于文字召回）+ 原图片段（imagePath，用于图片嵌入）。
   * 语义检索命中的通常是**描述片段**，它的 imagePath 是 NULL，于是上层拿不到可访问的图片地址。
   * 这里按 fileId 反查同文件的原图片段兜底；只在 f.type='image' 时返回，
   * 避免文档的正文片段被误配上文档里第一张插图的路径。
   */
  getFileImagePath(fileId: number): string | undefined {
    const row = this.db
      .prepare(`
        SELECT c.imagePath
        FROM chunks c
        JOIN files f ON f.id = c.fileId
        WHERE c.fileId = ? AND c.imagePath IS NOT NULL AND f.type = 'image'
        LIMIT 1
      `)
      .get(fileId) as { imagePath: string | null } | undefined;
    return row?.imagePath ?? undefined;
  }

  // ─── meta ─────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO index_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  stats(): {
    fileCount: number;
    indexedFiles: number;
    chunkCount: number;
    pendingFiles: number;
    failedFiles: number;
    totalBytes: number;
    /** kb.db（含 WAL/SHM）实际占用的磁盘大小 */
    dbBytes: number;
    typeDistribution: Array<{ type: string; count: number; bytes: number }>;
    statusDistribution: Array<{ status: string; count: number }>;
    embeddedChunks: number;
    failedEmbeddingChunks: number;
    embeddingFailures: Array<{ fileId: number; path: string; videoStart: number | null; videoEnd: number | null; error: string }>;
    estimatedChunks: number;
    estimatedEmbeddedChunks: number;
    avgChunksPerFile: number;
  } {
    const row = this.db
      .prepare(`
        SELECT
          COUNT(*) AS fileCount,
          SUM(CASE WHEN status = 'indexed' THEN 1 ELSE 0 END) AS indexedFiles,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingFiles,
          SUM(CASE WHEN status = 'indexing' THEN 1 ELSE 0 END) AS indexingFiles,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedFiles,
          COALESCE(SUM(size), 0) AS totalBytes
        FROM files
      `)
      .get() as any;
    const chunkRow = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
    const embeddedRow = this.db.prepare("SELECT COUNT(*) AS n FROM vec_chunks WHERE dim > 0").get() as { n: number };
    // Pending/indexing files may still hold old or provisional chunks. Count
    // them as unfinished, using at least two estimated chunks per file.
    const unfinished = this.db.prepare(`
      SELECT COALESCE(SUM(MAX(2, (SELECT COUNT(*) FROM chunks c WHERE c.fileId = f.id))), 0) AS estimated,
             COALESCE(SUM((SELECT COUNT(*) FROM chunks c WHERE c.fileId = f.id)), 0) AS chunks,
             COALESCE(SUM((SELECT COUNT(*) FROM chunks c JOIN vec_chunks v ON v.chunkId = c.id WHERE c.fileId = f.id AND v.dim > 0)), 0) AS embedded
      FROM files f WHERE f.status IN ('pending', 'indexing')
    `).get() as { estimated: number; chunks: number; embedded: number };
    const typeDist = this.db
      .prepare(`SELECT type, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files GROUP BY type ORDER BY count DESC`)
      .all() as Array<{ type: string; count: number; bytes: number }>;

    const avgChunksPerFile = row.indexedFiles > 0 ? Math.round((chunkRow.n / row.indexedFiles) * 10) / 10 : 0;

    return {
      fileCount: row.fileCount ?? 0,
      indexedFiles: row.indexedFiles ?? 0,
      pendingFiles: row.pendingFiles ?? 0,
      failedFiles: row.failedFiles ?? 0,
      totalBytes: row.totalBytes ?? 0,
      chunkCount: chunkRow.n ?? 0,
      embeddedChunks: embeddedRow.n ?? 0,
      failedEmbeddingChunks: (this.db.prepare("SELECT COUNT(*) AS n FROM embedding_failures WHERE silent = 0").get() as { n: number }).n,
      embeddingFailures: this.db.prepare(`SELECT f.id AS fileId, f.path, c.videoStart, c.videoEnd, e.error
        FROM embedding_failures e JOIN chunks c ON c.id = e.chunkId JOIN files f ON f.id = c.fileId
        WHERE e.silent = 0 ORDER BY e.failedAt DESC LIMIT 10`).all() as Array<{ fileId: number; path: string; videoStart: number | null; videoEnd: number | null; error: string }>,
      estimatedChunks: Math.max(0, chunkRow.n - unfinished.chunks) + unfinished.estimated,
      estimatedEmbeddedChunks: Math.max(0, embeddedRow.n - unfinished.embedded),
      dbBytes: this.databaseBytes(),
      avgChunksPerFile,
      typeDistribution: typeDist,
      statusDistribution: [
        { status: "indexed", count: row.indexedFiles ?? 0 },
        { status: "pending", count: row.pendingFiles ?? 0 },
        { status: "indexing", count: row.indexingFiles ?? 0 },
        { status: "failed", count: row.failedFiles ?? 0 },
      ],
    };
  }

  /** kb.db 真实磁盘占用：WAL 模式下未 checkpoint 的数据在 -wal 里，一并算上 */
  private databaseBytes(): number {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { total += fs.statSync(this.dbPath + suffix).size; } catch { /* 文件不存在 */ }
    }
    return total;
  }

  assetDirectory(): string { return path.join(path.dirname(this.dbPath), "images"); }

  thumbnailDirectory(): string { return path.join(path.dirname(this.dbPath), "thumbs"); }

  close(): void {
    this.db.close();
  }

  /**
   * 清空所有索引数据（不删原文件，只删数据库里的记录和派生的图片副本）。
   *
   * 图片副本/缩略图都是解析时生成的可再生数据，且老实现清空后从不清目录，
   * 换一次文件夹就永久留下上 GB 的孤儿图片。这里一并删掉。
   */
  clearAll(): { files: number; chunks: number } {
    const fileCount = (this.db.prepare("SELECT COUNT(*) AS n FROM files").get() as { n: number }).n;
    const chunkCount = (this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    this.db.exec(`
      DELETE FROM fts_chunks;
      DELETE FROM vec_chunks;
      DELETE FROM chunks;
      DELETE FROM files;
      DELETE FROM excluded_files;
      -- 重置 sqlite 自增 ID
      DELETE FROM sqlite_sequence WHERE name IN ('files', 'chunks');
    `);
    for (const directory of [this.assetDirectory(), this.thumbnailDirectory()]) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* 目录不存在 */ }
    }
    // VACUUM 回收磁盘空间
    this.db.exec("VACUUM");
    return { files: fileCount, chunks: chunkCount };
  }

  // ─── helpers ─────────────────────────────────────────────

  private rowToFile(r: any): KbFile {
    return {
      id: r.id,
      path: r.path,
      mtimeMs: r.mtimeMs,
      size: r.size,
      sha256: r.sha256,
      type: r.type,
      title: r.title,
      status: r.status,
      indexedAt: r.indexedAt,
      coverage: r.coverage ?? "unknown",
      error: r.error,
      dateTakenMs: r.dateTakenMs ?? null,
      lat: r.lat ?? null,
      lon: r.lon ?? null,
      camera: r.camera ?? null,
      metaScanned: r.metaScanned ?? 0,
    };
  }

  private rowToChunk(r: any): KbChunk {
    return {
      id: r.id,
      fileId: r.fileId,
      seq: r.seq,
      text: r.text,
      headingPath: r.headingPath,
      tokenCount: r.tokenCount,
      sha256: r.sha256,
      imagePath: r.imagePath ?? undefined,
      stage: (r.stage ?? "ready") as ChunkStage,
      describeModel: r.describeModel ?? undefined,
      videoStart: r.videoStart ?? undefined,
      videoEnd: r.videoEnd ?? undefined,
      modality: (r.modality ?? null) as ChunkModality | null,
    };
  }
}
