import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import chokidar, { type FSWatcher } from "chokidar";
import { KnowledgeStore } from "./store.js";
import { isSupportedFile, getFileType } from "./parser.js";
import { buildImagePlaceholders, estimateTokens, type Chunk, type ImagePair } from "./chunker.js";
import { getEmbeddingProvider } from "./embedding.js";
import { describeImage, describeModelName } from "./image-describer.js";
import { readImageMeta, EMPTY_META, metaLabel } from "./exif.js";
import { videoDuration, videoWindows, audioWindows, videoHasAudio, embedVideoWindow, embedAudioWindow, VideoWindowError } from "./video.js";
import type { ChunkStage } from "./store.js";
import { APP_HOME_DIR } from "../app-name.js";

/**
 * 索引调度器：异步分批处理，不阻塞主进程事件循环。
 *
 * 关键设计：
 * - 文件遍历用 fs.promises（异步）
 * - 每处理 N 个文件让出一次事件循环（setImmediate）
 * - 大文件 hash 计算异步分批
 * - 索引 worker 逐个处理，每处理完一个就 yield
 */

export interface IndexProgress {
  phase: "idle" | "scanning" | "indexing" | "embedding";
  scannedFiles: number;
  totalFiles: number;
  currentFile: string;
  indexedFiles: number;
  failedFiles: number;
  /** 还没处理完的文件数（含排队中 + 正在解析），用于窗口里显示「还剩 N 个」 */
  remainingFiles?: number;
  queuedChunks: number;
  error?: string;
  /** 当前文件的细分阶段（例如「大模型正在识别第 1/2 张图片…」） */
  detail?: string;
}

/** 图片片段的阶段进展，经 runtime worker → 主进程 → 渲染层广播 */
export interface ChunkStageEvent {
  fileId: number;
  fileTitle: string;
  stage: ChunkStage | "done";
  imageIndex: number;
  imageTotal: number;
  label: string;
}

export interface IndexedFolder {
  path: string;
  addedAt: string;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".DS_Store", "__pycache__",
  ".next", "dist", "build", ".idea", ".vscode", "venv", ".venv",
]);

/** 每处理多少个文件让出一次事件循环 */
const YIELD_EVERY = 10;

/**
 * 单文件解析硬超时。
 * 损坏/特殊构造的 PDF、卡在 OCR 里的图片都可能让解析子进程永远不返回；
 * 一个坏文件不能把整条索引队列拖死，超时后杀掉子进程、标记失败，继续下一个。
 */
const PARSE_TIMEOUT_MS = 10 * 60 * 1000;


/** 让出事件循环的工具 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export class KnowledgeIndexer {
  private store: KnowledgeStore;
  private watchers = new Map<string, FSWatcher>();
  private progress: IndexProgress = {
    phase: "idle",
    scannedFiles: 0,
    totalFiles: 0,
    currentFile: "",
    indexedFiles: 0,
    failedFiles: 0,
    queuedChunks: 0,
  };
  private isIndexing = false;
  private queueRequested = false;
  private generation = 0;
  private changing = false;
  /** 知识库窗口关闭 → 暂停索引（扫描/解析/嵌入全部停止）；重新打开 → 恢复 */
  private paused = false;
  /** 暂停时若打断了全量扫描，恢复时需要重扫一次，避免漏文件 */
  private scanInterrupted = false;
  private parseAbort: AbortController | null = null;
  private scans: Promise<void> = Promise.resolve();
  private progressCallback: ((p: IndexProgress) => void) | null = null;
  private stageCallback: ((e: ChunkStageEvent) => void) | null = null;
  private embeddingBatchSize = 16;

  constructor(store: KnowledgeStore, private ensureModel: () => Promise<void> = async () => {}, private modelAvailable: () => boolean = () => true, private settingsRoot?: string) {
    this.store = store;
  }

  onProgress(cb: (p: IndexProgress) => void): void {
    this.progressCallback = cb;
  }

  onStage(cb: (e: ChunkStageEvent) => void): void {
    this.stageCallback = cb;
  }

  private emitStage(event: ChunkStageEvent): void {
    this.stageCallback?.(event);
  }

  getProgress(): IndexProgress {
    return { ...this.progress };
  }

  // ─── 文件夹管理 ──────────────────────────────────────────

  listFolders(): IndexedFolder[] {
    const folder = this.store.getMeta("folder");
    return folder ? [{ path: folder, addedAt: "" }] : [];
  }

  async setFolder(folderPath: string | null): Promise<{ ok: boolean; error?: string }> {
    let real: string | null = null;
    if (folderPath) {
      try {
        real = await fsp.realpath(folderPath);
        if (!(await fsp.stat(real)).isDirectory()) return { ok: false, error: "不是有效文件夹" };
      } catch (e) { return { ok: false, error: String(e) }; }
    }
    const sameFolder = real !== null && real === this.store.getMeta("folder");
    this.changing = true;
    this.generation++;
    this.parseAbort?.abort();
    this.queueRequested = false;
    for (const watcher of this.watchers.values()) await watcher.close();
    this.watchers.clear();
    await this.scans;
    while (this.isIndexing) await new Promise((resolve) => setTimeout(resolve, 20));
    if (sameFolder) {
      this.store.recoverInterruptedFiles();
      this.retryFallbackOnce();
    }
    else {
      this.store.clearAll();
      this.store.setMeta("folder", real ?? "");
    }
    this.updateProgress({ phase: "idle", currentFile: "", scannedFiles: 0, totalFiles: 0, indexedFiles: 0, failedFiles: 0, queuedChunks: 0, error: undefined });
    this.changing = false;
    return real ? this.addFolder(real) : { ok: true };
  }

  resume(): void {
    this.store.recoverInterruptedFiles();
    this.retryFallbackOnce();
    const folder = this.store.getMeta("folder");
    if (folder) void this.addFolder(folder);
  }

  /**
   * 修复旧版把 OCR 回退当成成功结果的片段。这是迁移动作，只跑一次：
   * 它会把相关文件重新置为 pending，若每次刷新都执行，未变化的图片也会被重新解析、重新嵌入。
   */
  private retryFallbackOnce(): void {
    if (this.store.getMeta("fallbackRetry") === "v1") return;
    this.store.retryFallbackFiles();
    this.store.setMeta("fallbackRetry", "v1");
  }

  /**
   * 暂停/恢复索引：知识库窗口关闭时暂停（停止扫描、解析、嵌入），重新打开时恢复。
   * 暂停会终止正在解析的子进程；恢复时先把被打断的文件重置为 pending 重新入队，
   * 若扫描被暂停打断过则重新全量扫描一次，保证不漏文件。
   */
  setPaused(paused: boolean): void {
    if (this.paused === paused) {
      if (!paused) void this.processQueue().catch(console.error);
      return;
    }
    this.paused = paused;
    if (paused) {
      this.parseAbort?.abort();
      this.updateProgress({ phase: "idle", currentFile: "", error: undefined });
      return;
    }
    this.store.recoverInterruptedFiles();
    if (this.scanInterrupted) {
      this.scanInterrupted = false;
      const folder = this.store.getMeta("folder");
      if (folder) void this.addFolder(folder);
      return;
    }
    void this.processQueue().catch(console.error);
  }

  async addFolder(folderPath: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const real = await fsp.realpath(folderPath);
      const stat = await fsp.stat(real);
      if (!stat.isDirectory()) {
        return { ok: false, error: "不是有效文件夹" };
      }

      // 启动监听
      if (!this.watchers.has(real)) {
        const watcher = chokidar.watch(real, {
          ignored: (p: string) => {
            const base = path.basename(p);
            return SKIP_DIRS.has(base) || base.startsWith(".");
          },
          persistent: true,
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        });

        watcher.on("add", (filePath) => void this.onFileChanged(filePath));
        watcher.on("change", (filePath) => void this.onFileChanged(filePath));
        watcher.on("unlink", (filePath) => this.onFileDeleted(filePath));
        watcher.on("error", (err) => console.error("[kb] watcher 错误：", err));

        this.watchers.set(real, watcher);
      }

      // 全量扫描（异步，不阻塞）
      this.scans = this.scans.then(() => this.scanAndIndex(real));

      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 扫描 + 索引的完整流程（后台异步跑，不阻塞调用方） */
  private async scanAndIndex(folderPath: string): Promise<void> {
    const generation = this.generation;
    try {
      await this.scanFolder(folderPath, generation);
      if (generation !== this.generation) return;
      // 旧库文件先轻量回填一次 EXIF（只读文件头，不重新解析/嵌入）
      await this.backfillMeta(generation);
      // 孤儿清理只在每次全量扫描后做一次：它要遍历整库做 fs 检查，
      // 放在 processQueue 里会被 watcher 事件反复触发，上万文件时拖慢索引。
      await this.cleanOrphans(generation);
      if (generation === this.generation) await this.processQueue();
    } catch (e) {
      console.error("[kb] 扫描索引失败：", e);
    }
  }

  /** 轻量回填旧文件的 EXIF 元数据：读文件头解析后落库，不触发重新解析/嵌入。 */
  private async backfillMeta(generation: number): Promise<void> {
    if (this.store.getMeta("exifBackfilled") === "1") return;
    const BATCH = 20;
    let done = 0;
    for (;;) {
      if (generation !== this.generation || this.paused) return;
      const batch = this.store.listFilesMissingMeta(BATCH);
      if (batch.length === 0) break;
      for (const f of batch) {
        if (generation !== this.generation || this.paused) return;
        const meta = f.type === "image" ? await readImageMeta(f.path).catch(() => EMPTY_META) : EMPTY_META;
        this.store.markFileMetaScanned(f.id, meta);
        if (++done % BATCH === 0) await yieldToEventLoop();
      }
    }
    this.store.setMeta("exifBackfilled", "1");
  }

  removeFolder(folderPath: string): void {
    const watcher = this.watchers.get(folderPath);
    if (watcher) {
      watcher.close();
      this.watchers.delete(folderPath);
    }
    for (const f of this.store.listFilePaths()) {
      if (f.path.startsWith(folderPath + path.sep)) {
        this.store.deleteFile(f.path);
      }
    }
  }

  // ─── 扫描（异步遍历）─────────────────────────────────────

  private async scanFolder(folderPath: string, generation: number): Promise<number> {
    // 新一轮扫描从干净状态开始：若上次被暂停打断过，这次正常完成即视为补全
    this.scanInterrupted = false;
    this.updateProgress({ phase: "scanning", scannedFiles: 0, totalFiles: 0, currentFile: "", remainingFiles: 0 });
    let count = 0;
    let yieldedSinceLastYield = 0;

    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch { return; }

      for (const entry of entries) {
        if (generation !== this.generation) return;
        if (this.paused) { this.scanInterrupted = true; return; }
        const full = path.join(dir, entry.name);

        // 每 YIELD_EVERY 个条目让出一次事件循环
        if (++yieldedSinceLastYield >= YIELD_EVERY) {
          yieldedSinceLastYield = 0;
          await yieldToEventLoop();
        }

        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
            await walk(full);
            if (generation !== this.generation) return;
            if (this.paused) { this.scanInterrupted = true; return; }
          }
        } else if (entry.isFile() && isSupportedFile(full)) {
          if (this.store.isExcluded(full)) continue;
          try {
            const stat = await fsp.stat(full);
            const type = getFileType(full);
            const known = this.store.getFileByPath(full);
            // 刷新时先用 mtime + size 判断：两者都没变就复用已记录的哈希，不再整份重读。
            // 变了才重新算 hash，由 upsertFile 决定是否真的要重新分段/嵌入。
            const untouched = !!known && known.mtimeMs === stat.mtimeMs && known.size === stat.size;
            const hash = untouched && known ? known.sha256 : await this.hashFile(full);
            if (generation !== this.generation) return;
            if (this.paused) { this.scanInterrupted = true; return; }
            const title = path.basename(full, path.extname(full));
            // 重编码之前从原图读 EXIF；仅图片需要，且已扫描过的不再重复打开文件
            const meta = type !== "image"
              ? EMPTY_META
              : untouched && known?.metaScanned
                ? { dateTakenMs: known.dateTakenMs, lat: known.lat, lon: known.lon, camera: known.camera }
                : await readImageMeta(full).catch(() => EMPTY_META);
            this.store.upsertFile({
              path: full,
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              sha256: hash,
              type,
              title,
              ...meta,
            });
            count++;
            this.updateProgress({ scannedFiles: count });
          } catch (e) {
            console.error("[kb] 扫描文件失败：", full, e);
          }
        }
      }
    };

    await walk(folderPath);
    if (generation !== this.generation) return count;
    // 扫描被暂停打断过：总数和后续队列由恢复时的重扫收尾，这里不重复更新
    if (this.scanInterrupted) return count;
    this.updateProgress({ totalFiles: count, scannedFiles: count });
    return count;
  }

  /** 异步计算文件 sha256（流式，不阻塞） */
  private async hashFile(filePath: string): Promise<string> {
    // 小文件直接读（< 10MB）
    const stat = await fsp.stat(filePath);
    if (stat.size < 10 * 1024 * 1024) {
      const buf = await fsp.readFile(filePath);
      return createHash("sha256").update(buf).digest("hex");
    }
    // 大文件用流式 hash
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    });
  }

  private async onFileChanged(filePath: string): Promise<void> {
    if (!isSupportedFile(filePath) || this.changing || this.store.isExcluded(filePath)) return;
    const generation = this.generation;
    try {
      const stat = await fsp.stat(filePath);
      const hash = await this.hashFile(filePath);
      if (generation !== this.generation) return;
      const title = path.basename(filePath, path.extname(filePath));
      const type = getFileType(filePath);
      const meta = type === "image" ? await readImageMeta(filePath).catch(() => EMPTY_META) : EMPTY_META;
      this.store.upsertFile({
        path: filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        sha256: hash,
        type,
        title,
        ...meta,
      });
      // 触发索引（不阻塞 watcher 回调）
      void this.processQueue();
    } catch (e) {
      console.error("[kb] 监听文件变化失败：", filePath, e);
    }
  }

  private onFileDeleted(filePath: string): void {
    if (this.changing) return;
    this.store.deleteFile(filePath);
  }

  // ─── 索引 worker（异步逐个处理）──────────────────────────

  private async processQueue(): Promise<void> {
    if (this.changing) return;
    if (this.paused) return;
    if (this.isIndexing) { this.queueRequested = true; return; }
    this.isIndexing = true;
    const generation = this.generation;

    try {
      // 孤儿文件在每次扫描后统一清理；这里只处理待索引文件
      let pending = this.store.listPendingFiles();
      if (pending.length === 0) {
        // 没有待索引的文件，检查是否有待嵌入的 chunk
        const pendingChunks = this.store.getAllChunksForEmbedding();
        if (pendingChunks.length === 0) {
          this.updateProgress({ phase: "idle", currentFile: "", remainingFiles: 0 });
          return;
        }
      }

      this.updateProgress({
        phase: "indexing",
        totalFiles: pending.length,
        scannedFiles: 0,
        remainingFiles: pending.length,
        error: undefined,
      });

      let indexed = 0;
      let failed = 0;
      let processedSinceYield = 0;
      let embeddingFailed = false;

      for (const file of pending) {
        if (generation !== this.generation) return;
        if (this.paused) return;
        // 队列可能是几次扫描叠加的结果：真正开工前再核对一次，已经处理过或哈希变了的条目直接跳过，
        // 避免重复解析、重复分段、重复嵌入同一个文件。
        const snapshot = this.store.getFileByPath(file.path);
        if (!snapshot || snapshot.status !== "pending" || snapshot.sha256 !== file.sha256) continue;
        this.updateProgress({
          phase: "indexing",
          currentFile: path.basename(file.path),
          scannedFiles: indexed,
          indexedFiles: indexed,
          failedFiles: failed,
          remainingFiles: Math.max(0, pending.length - indexed - failed),
          detail: undefined,
        });

        try {
          this.store.updateFileStatus(file.id, "indexing");
          const controller = new AbortController();
          this.parseAbort = controller;
          if (file.type === "video") {
            try {
              const duration = await videoDuration(file.path, controller.signal);
              // 画面窗口：5 秒步长、10 秒跨度（原逻辑），用于「找视频里的画面」
              const visual = videoWindows(duration).map(({ start, end }) => ({ text: "", headingPath: `视频 ${start.toFixed(1)}s–${end.toFixed(1)}s`, tokenCount: 0, videoStart: start, videoEnd: end, modality: "video" as const }));
              // 音轨窗口：10 秒一段，单独过 audio_encoder；召回结果带同样的 videoStart/videoEnd，
              // 所以音频命中也能直接定位并播放原视频片段。
              const audio = (await videoHasAudio(file.path, controller.signal))
                ? audioWindows(duration).map(({ start, end }) => ({ text: "", headingPath: `音频 ${start.toFixed(1)}s–${end.toFixed(1)}s`, tokenCount: 0, videoStart: start, videoEnd: end, modality: "audio" as const }))
                : [];
              if (generation !== this.generation || this.paused) return;
              if (this.store.replaceChunks(file.id, [...visual, ...audio], file.sha256) < 0) { this.queueRequested = true; continue; }
              indexed++;
            } finally { if (this.parseAbort === controller) this.parseAbort = null; }
            continue;
          }
          if (file.type === "xlsx") {
            if (!this.store.beginChunks(file.id, [], file.sha256)) { this.queueRequested = true; continue; }
            await this.streamXlsxInProcess(file.path, file.id, file.sha256, controller.signal);
            if (generation !== this.generation || this.paused) return;
            if (await this.hashFile(file.path) !== file.sha256) throw new Error("文件在索引期间发生变化，请重新扫描");
            if (!this.store.finishIndexing(file.id, file.sha256)) { this.queueRequested = true; continue; }
            if (this.parseAbort === controller) this.parseAbort = null;
            this.emitStage({ fileId: file.id, fileTitle: path.basename(file.path), stage: "done", imageIndex: 0, imageTotal: 0, label: "" });
            this.updateProgress({ detail: undefined }); indexed++;
            continue;
          }
          let chunks: Chunk[];
          const parsed = await this.parseFileInProcess(file.path, file.sha256, controller.signal);
          chunks = parsed.chunks;
          if (generation !== this.generation) return;
          if (this.paused) return;

          // ① OCR 已随解析完成：先落占位片段，用户此刻就能看到「图片 OCR · N tokens」
          const { chunks: placeholders, pairs } = buildImagePlaceholders(chunks);
          // 把拍摄时间 / 机型 / 坐标作为前缀写进文字片段，让关键词与语义召回都能命中；文档不加
          const label = file.type === "image" ? metaLabel(file) : "";
          if (label) {
            for (const c of placeholders) {
              if (!c.imagePath) c.text = `${label}\n${c.text}`;
            }
          }
          const ids = this.store.beginChunks(file.id, placeholders, file.sha256);
          if (!ids) { this.queueRequested = true; continue; }

          // ② 逐张调用大模型描述：每完成一张就原地替换文字片段，并广播阶段进展
          if (pairs.length > 0) {
            await this.describeImageChunks(file.id, path.basename(file.path), ids, pairs, controller.signal, label);
            if (generation !== this.generation) return;
            if (this.paused) return;
          }

          if (this.parseAbort === controller) this.parseAbort = null;

          // ③ 文字定稿后才标记完成，占位片段不会被提前嵌入
          if (!this.store.finishIndexing(file.id, file.sha256, parsed.truncated ? "文件仅部分索引：内容超出当前页数、字数或 OCR 处理范围。" : undefined)) { this.queueRequested = true; continue; }
          this.emitStage({ fileId: file.id, fileTitle: path.basename(file.path), stage: "done", imageIndex: pairs.length, imageTotal: pairs.length, label: "" });
          this.updateProgress({ detail: undefined });
          indexed++;
        } catch (e) {
          this.parseAbort = null;
          if (generation !== this.generation) return;
          // 暂停导致解析被中断：保持 indexing 状态，恢复时 recoverInterruptedFiles 会重置为 pending 重新入队；
          // 若此时误标 failed，恢复逻辑不会回收该文件，会导致漏索引
          if (this.paused) return;
          const msg = e instanceof Error ? e.message : String(e);
          const current = this.store.getFileByPath(file.path);
          if (current?.sha256 === file.sha256 && current.status === "indexing") {
            this.store.updateFileStatus(file.id, "failed", msg);
            failed++;
          } else { this.queueRequested = true; }
          this.emitStage({ fileId: file.id, fileTitle: path.basename(file.path), stage: "done", imageIndex: 0, imageTotal: 0, label: "" });
          this.updateProgress({ detail: undefined });
          console.error("[kb] 索引文件失败：", file.path, e);
        }

        if (!embeddingFailed && this.modelAvailable() && generation === this.generation && !this.paused) {
          try { await this.embedPendingChunks(generation, 1); }
          catch (error) { embeddingFailed = true; this.updateProgress({ error: error instanceof Error ? error.message : String(error) }); }
        }

        // 每处理一个文件就让出一次事件循环，保持 UI 响应
        await yieldToEventLoop();

        // 每处理几个文件重新拉一次 pending（可能有新文件加入）。
        // 上万文件时每次都全量查询太浪费，25 个一批足够及时。
        if (++processedSinceYield >= 25) {
          processedSinceYield = 0;
          pending = this.store.listPendingFiles();
        }
      }

      // 嵌入所有待嵌入的 chunks
      if (generation !== this.generation) return;
      if (embeddingFailed) { this.updateProgress({ phase: "idle", currentFile: "" }); return; }
      try {
        const modelReady = this.ensureModel();
        await Promise.race([modelReady, new Promise<void>((resolve) => {
          const timer = setInterval(() => { if (generation !== this.generation) { clearInterval(timer); resolve(); } }, 100);
          void modelReady.finally(() => clearInterval(timer)).catch(() => {});
        })]);
      } catch {
        this.updateProgress({ phase: "idle", currentFile: "" });
        return;
      }
      if (generation !== this.generation) return;
      try { await this.embedPendingChunks(generation); }
      catch (error) { this.updateProgress({ phase: "idle", currentFile: "", error: error instanceof Error ? error.message : String(error) }); return; }

      this.updateProgress({
        phase: "idle",
        currentFile: "",
        indexedFiles: indexed,
        failedFiles: failed,
        totalFiles: indexed + failed,
        remainingFiles: 0,
      });
    } finally {
      this.isIndexing = false;
      if (this.queueRequested && !this.changing && !this.paused) {
        this.queueRequested = false;
        void this.processQueue().catch(console.error);
      }
    }
  }

  private streamXlsxInProcess(filePath: string, fileId: number, hash: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("解析已取消")); return; }
      const child = fork(fileURLToPath(new URL("./knowledge-parser.js", import.meta.url)), [], {
        execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let finished = false, count = 0;
      let timer: ReturnType<typeof setTimeout>;
      const settle = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
      const resetTimer = () => { clearTimeout(timer); timer = setTimeout(() => { child.kill(); settle(new Error("表格解析超过 10 分钟没有进展")); }, PARSE_TIMEOUT_MS); };
      const abort = () => { child.kill(); settle(new Error("解析已取消")); };
      signal.addEventListener("abort", abort, { once: true }); resetTimer();
      child.on("message", (message: { batch?: Chunk[]; done?: boolean; progress?: boolean; error?: string }) => {
        if (finished) return;
        if (message.error) { settle(new Error(message.error)); return; }
        if (message.done) { settle(); return; }
        if (message.progress) { resetTimer(); return; }
        if (!Array.isArray(message.batch)) { child.kill(); settle(new Error("表格解析返回无效结果")); return; }
        try {
          if (!this.store.appendChunks(fileId, message.batch, hash)) throw new Error("文件已更改或索引已取消");
          count += message.batch.length;
          this.updateProgress({ detail: `正在读取表格，已分段 ${count.toLocaleString("zh-CN")}` });
          resetTimer(); child.send({ ack: true });
        } catch (error) { child.kill(); settle(error instanceof Error ? error : new Error(String(error))); }
      });
      child.once("error", error => settle(error));
      child.once("exit", (code, exitSignal) => settle(new Error(`表格解析进程退出（${exitSignal ?? code}）`)));
      child.send({ path: filePath, streamXlsx: true }, error => { if (error) settle(error); });
    });
  }

  private parseFileInProcess(filePath: string, fileSha256: string, signal: AbortSignal): Promise<{ chunks: Chunk[]; truncated: boolean }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error("解析已取消")); return; }
      const child = fork(fileURLToPath(new URL("./knowledge-parser.js", import.meta.url)), [], {
        execPath: process.execPath,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LAUNCHER_KB_OCR_CACHE: path.join(this.settingsRoot ?? path.join(APP_HOME_DIR, "knowledge"), "ocr") },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settle = (error?: Error, result?: { chunks: Chunk[]; truncated: boolean }) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(result ?? { chunks: [], truncated: false });
      };
      const abort = () => { child.kill(); settle(new Error("解析已取消")); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* 子进程可能已退出 */ }
        settle(new Error(`解析超时（超过 ${PARSE_TIMEOUT_MS / 60000} 分钟），已跳过该文件`));
      }, PARSE_TIMEOUT_MS);
      child.once("message", (message: { chunks?: Chunk[]; truncated?: boolean; error?: string }) => {
        if (message.error) settle(new Error(message.error));
        else if (Array.isArray(message.chunks)) settle(undefined, { chunks: message.chunks, truncated: message.truncated === true });
        else settle(new Error("文件解析进程返回了无效结果"));
      });
      child.once("error", error => settle(error));
      child.once("exit", (code, exitSignal) => settle(new Error(`文件解析进程退出（${exitSignal ?? code}）`)));
      child.send({ path: filePath, assetDir: this.store.assetDirectory(), thumbKey: fileSha256 }, error => { if (error) settle(error); });
    });
  }

  /** 异步清理孤儿文件（批量 stat 检查，只取 id/path，每次扫描后跑一次） */
  private async cleanOrphans(generation: number): Promise<void> {
    let processed = 0;

    for (const f of this.store.listFilePaths()) {
      if (generation !== this.generation) return;
      if (this.paused) return;
      try {
        await fsp.access(f.path);
      } catch {
        this.store.deleteFile(f.path);
      }
      // 每 20 个文件让出一次
      if (++processed % 20 === 0) {
        await yieldToEventLoop();
      }
    }
  }

  /**
   * 逐张调用大模型生成文字描述，并把进展广播给 UI。
   *
   * 关键点：文字片段在 OCR 阶段就已落库，这里只做「原地升级」，
   * 因此用户能在片段右上角依次看到 OCR → 大模型识别中 → 最终文字描述，
   * 而不是等整个文件跑完才一次性看到结果。
   */
  private async describeImageChunks(
    fileId: number,
    fileTitle: string,
    ids: number[],
    pairs: ImagePair[],
    signal: AbortSignal,
    metaLabelText: string,
  ): Promise<void> {
    const total = pairs.length;
    const failures: string[] = [];
    // 先把「将用哪个模型」解析好：用户在这批图片开始识别时就能看到，不用等结果
    const plannedModel = describeModelName(this.settingsRoot);
    this.emitStage({ fileId, fileTitle, stage: "ocr", imageIndex: 0, imageTotal: total, label: `OCR 完成 · ${total} 张图片，准备用 ${plannedModel} 生成文字描述` });

    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new Error("解析已取消");
      const pair = pairs[i];
      const textChunkId = ids[pair.textIndex];

      this.store.updateChunk(textChunkId, { stage: "describing" });
      const working = `${plannedModel} 正在识别第 ${i + 1}/${total} 张图片…`;
      this.updateProgress({ phase: "indexing", detail: working });
      this.emitStage({ fileId, fileTitle, stage: "describing", imageIndex: i + 1, imageTotal: total, label: working });

      const result = await describeImage(pair.imagePath, pair.ocr, signal, this.settingsRoot);
      if (signal.aborted) throw new Error("解析已取消");
      if (result.source === "fallback") failures.push(`第 ${i + 1} 张图片：${result.error ?? "模型未生成描述"}`);
      const model = result.model ?? undefined;

      const text = result.description.trim();
      if (!text) {
        // OCR 和模型都没产出文字：删掉空占位，只留图片本体片段，避免空气泡
        this.store.deleteChunk(textChunkId);
      } else {
        // 模型定稿后把拍摄时间 / 机型 / 坐标前缀重新拼回文字，避免被描述覆盖掉
        const finalText = metaLabelText ? `${metaLabelText}\n${text}` : text;
        this.store.updateChunk(textChunkId, {
          text: finalText,
          headingPath: result.source === "model" ? "图片文字描述" : "图片 OCR（模型未生成描述）",
          tokenCount: estimateTokens(finalText),
          stage: result.source === "model" ? "described" : "fallback",
          describeModel: model,
        });
      }

      const label = result.source === "model"
        ? `已生成第 ${i + 1}/${total} 张图片的文字描述${model ? ` · ${model}` : ""}`
        : `第 ${i + 1}/${total} 张图片：${result.error ?? "模型未生成描述"}${model ? `（${model}）` : ""}，保留 OCR 原文`;
      this.updateProgress({ phase: "indexing", detail: label });
      this.emitStage({ fileId, fileTitle, stage: result.source === "model" ? "described" : "fallback", imageIndex: i + 1, imageTotal: total, label });
    }
    if (failures.length) {
      // 单张图片描述失败不应该把整份文件判为失败：文字片段已保留 OCR 原文（stage=fallback），
      // 文件仍然可检索。否则每次扫描都会把整份文档/整批图片重新描述一遍，越积越慢。
      console.warn(`[kb] ${fileTitle} 有 ${failures.length}/${total} 张图片未生成描述，保留 OCR 原文：${failures.join("；")}`);
    }
  }

  private async embedPendingChunks(generation: number, maxBatches = Infinity): Promise<void> {
    let batches = 0;
    let pending = this.store.getAllChunksForEmbedding(this.embeddingBatchSize);
    if (pending.length === 0) return;

    this.updateProgress({
      phase: "embedding",
      currentFile: `向量嵌入中（${pending.length} 块）`,
      queuedChunks: 0,
    });

    const provider = getEmbeddingProvider();
    let done = 0;

    while (pending.length && batches++ < maxBatches) {
      if (generation !== this.generation) return;
      if (this.paused) return;
      for (const chunk of pending) {
        if (generation !== this.generation || this.paused) return;
        try {
          let vector: Float32Array;
          if (chunk.modality === "audio" && chunk.videoStart !== undefined && chunk.videoEnd !== undefined) {
            const controller = new AbortController();
            this.parseAbort = controller;
            try { vector = await embedAudioWindow(provider, chunk.filePath, chunk.videoStart, chunk.videoEnd, controller.signal); }
            finally { if (this.parseAbort === controller) this.parseAbort = null; }
          } else if (chunk.videoStart !== undefined && chunk.videoEnd !== undefined) {
            const controller = new AbortController();
            this.parseAbort = controller;
            try { vector = await embedVideoWindow(provider, chunk.filePath, chunk.videoStart, chunk.videoEnd, path.join(this.settingsRoot ?? path.join(APP_HOME_DIR, "knowledge"), "tmp"), controller.signal); }
            finally { if (this.parseAbort === controller) this.parseAbort = null; }
          } else vector = chunk.imagePath ? await provider.embedImage(chunk.imagePath) : (await provider.embed([chunk.text]))[0];
          if (generation !== this.generation || this.paused) return;
          this.store.updateEmbedding(chunk.id, vector, chunk.fileHash);
          this.updateProgress({ queuedChunks: ++done });
        } catch (error) {
          if (generation !== this.generation || this.paused) return;
          if (!(error instanceof VideoWindowError)) throw error;
          this.store.recordEmbeddingFailure(chunk.id, chunk.fileHash, error.message, error.silent);
          if (!error.silent) console.warn("[kb] 跳过无法解码的视频片段：", chunk.filePath, chunk.videoStart, chunk.videoEnd, error.message);
          this.updateProgress({ queuedChunks: ++done });
        }
      }
      pending = this.store.getAllChunksForEmbedding(this.embeddingBatchSize);
      // 每批之间让出事件循环
      await yieldToEventLoop();
    }
  }

  // ─── 手动触发 ───────────────────────────────────────────

  resumePending(): void { void this.processQueue().catch(console.error); }

  reindexFile(fileId: number): void {
    const file = this.store.getFileById(fileId);
    if (!file) throw new Error("文件不存在");
    // 手动重新索引优先处理：否则一个视频/文档会被 9000 多张排队照片压在几天后
    this.store.setFilePriority(file.id, 1);
    this.store.updateFileStatus(file.id, "pending");
    void this.processQueue().catch(console.error);
  }

  async reindexAll(): Promise<void> {
    for (const file of this.store.listFilePaths()) {
      this.store.updateFileStatus(file.id, "pending");
    }
    await this.processQueue();
  }

  close(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }

  private updateProgress(patch: Partial<IndexProgress>): void {
    const next = { ...this.progress, ...patch };
    // 离开「解析中」阶段时清掉细分文案，避免窗口里残留上一张图片的进度
    if (patch.phase && patch.phase !== "indexing" && patch.detail === undefined) next.detail = undefined;
    this.progress = next;
    this.progressCallback?.(next);
  }
}
