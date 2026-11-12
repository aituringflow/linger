import { parentPort, workerData } from "node:worker_threads";
import fsSync from "node:fs";
import path from "node:path";
import { KnowledgeStore, type FileQuery } from "./store.js";
import { KnowledgeIndexer } from "./indexer.js";
import { makeVideoPreview, makeVideoThumbnail, makeChatVideoClip } from "./video.js";
import { Retriever } from "./retriever.js";
import { setEmbeddingProvider, RemoteEmbeddingProvider } from "./embedding.js";
import { ModelDownloader, type DownloadProgress } from "./model-downloader.js";
import { readKnowledgeSettings } from "./settings.js";
import { assetThumbPath, fileThumbPath } from "./assets.js";
import { ensureThumbnail } from "./thumbnail-process.js";

const port = parentPort!;
const downloader = new ModelDownloader(workerData.modelDir ?? workerData.userDataDir);

// 远程 embedding：通过 IPC 把 embed 请求发给主 worker，主 worker 里有唯一一份 ONNX 模型
let embedRequestId = 0;
const embedPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const remoteEmbedding = new RemoteEmbeddingProvider(async (method, args) => {
  const id = --embedRequestId;
  return new Promise((resolve, reject) => {
    embedPending.set(id, { resolve, reject });
    port.postMessage({ id, method, args });
  });
});
setEmbeddingProvider(remoteEmbedding);
const store = new KnowledgeStore(workerData.userDataDir);
type ModelState = { id: "embeddinggemma2"; phase: "checking" | "downloading" | "done" | "error"; file: string; percent: number; downloadedMB: number; totalMB: number; error?: string };
let modelState: ModelState = downloader.isModelReady("embeddinggemma2")
  ? { id: "embeddinggemma2", phase: "done", file: "", percent: 100, downloadedMB: 0, totalMB: 0 }
  : { id: "embeddinggemma2", phase: "checking", file: "", percent: 0, downloadedMB: 0, totalMB: 0 };
let modelDownload: Promise<void> | null = null;
function ensureModel(): Promise<void> {
  if (downloader.isModelReady("embeddinggemma2")) return Promise.resolve();
  if (modelDownload) return modelDownload;
  modelState = { id: "embeddinggemma2", phase: "downloading", file: "", percent: 0, downloadedMB: 0, totalMB: 0 };
  const promise = downloader.downloadModel("embeddinggemma2", (p: DownloadProgress) => {
    // A file completing is not the same as the complete model being ready.
    modelState = { id: "embeddinggemma2", phase: p.phase === "error" ? "error" : "downloading", file: p.file, percent: p.percent, downloadedMB: p.downloadedMB, totalMB: p.totalMB, error: p.error };
    port.postMessage({ modelState });
  }).then(() => {
    modelState = { id: "embeddinggemma2", phase: "done", file: "", percent: 100, downloadedMB: 0, totalMB: 0 };
    port.postMessage({ modelState });
    indexer.resumePending();
  }).catch((error) => {
    modelState = { ...modelState, phase: "error", error: error instanceof Error ? error.message : String(error) };
    port.postMessage({ modelState });
    throw error;
  }).finally(() => { modelDownload = null; });
  modelDownload = promise;
  return promise;
}
// settingsRoot：知识库根目录（workerData.modelDir），settings.json 里的图片识别模型选择存在这里
const indexer = new KnowledgeIndexer(store, ensureModel, () => downloader.isModelReady("embeddinggemma2"), workerData.modelDir ?? workerData.userDataDir);
const retriever = new Retriever(store);
let folderChange: Promise<unknown> = Promise.resolve();
// 用户关掉「窗口关闭后继续索引」时，应用刚启动也不该偷偷跑索引：
// 等知识库窗口打开（渲染层 setPaused(false)）再开始。
if (readKnowledgeSettings(workerData.modelDir ?? workerData.userDataDir).backgroundIndexing === false) indexer.setPaused(true);
indexer.resume();
void ensureModel().catch(() => {});
let lastProgress = 0;
let lastPhase = "";
indexer.onProgress((progress) => {
  const now = Date.now();
  // 阶段切换必须立刻发：扫描→解析的切换如果被 200ms 节流吞掉，
  // 界面会一直停在「扫描文件中」，看起来像卡死。
  if (progress.phase !== lastPhase || progress.phase === "idle" || now - lastProgress >= 200) {
    lastPhase = progress.phase;
    lastProgress = now;
    port.postMessage({ progress });
  }
});
// 图片 OCR → 大模型描述的分阶段事件不做节流：每个阶段都要立刻让 UI 看到
indexer.onStage((chunkStage) => { port.postMessage({ chunkStage }); });

port.on("message", async (message) => {
  // 先处理 embed 请求的回复（负数 id 是我们发出去的远程请求）
  if (!message.method && typeof message.id === "number" && message.id < 0) {
    const pending = embedPending.get(message.id);
    if (pending) {
      embedPending.delete(message.id);
      message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
      return;
    }
  }
  const { id, method, args } = message;
  try {
    let result: unknown;
    switch (method) {
      case "addFolder": result = await indexer.addFolder(args[0]); break;
      case "removeFolder": indexer.removeFolder(args[0]); result = { ok: true }; break;
      case "listFolders": result = indexer.listFolders(); break;
      case "setFolder": {
        const next = folderChange.then(() => indexer.setFolder(args[0] ?? null));
        folderChange = next.catch(() => {});
        result = await next; break;
      }
      case "setPaused": indexer.setPaused(args[0] === true); result = { ok: true }; break;
      case "listFiles": result = store.listFiles(100, Math.max(0, Number(args[0]) || 0)); break;
      case "queryFiles": {
        // 列表页：搜索 / 类型 / 状态 / 排序都在数据库里做完，只回一页。
        const page = store.queryFiles((args[0] ?? {}) as FileQuery);
        result = {
          total: page.total,
          groups: page.groups,
          items: page.items.map(({ imagePath, ...file }) => {
            // 独立图片的缩略图按原文件 sha256 命名：pending 的照片也能直接显示画面，
            // 不用等解析完成。文档插图的缩略图仍按图片副本哈希走 chunkThumbnails。
            const thumb = (file.type === "image" || file.type === "pdf") ? fileThumbPath(path.dirname(store.thumbnailDirectory()), file.sha256) : "";
            return { ...file, thumbPath: thumb && fsSync.existsSync(thumb) ? thumb : null };
          }),
        };
        break;
      }
      case "fileThumbnails": {
        const ids = Array.isArray(args[0]) ? args[0].slice(0, 200) : [];
        const thumbnails: Array<{ fileId: number; path: string }> = [];
        for (const value of ids) {
          const fileId = Number(value);
          if (!Number.isSafeInteger(fileId) || fileId <= 0) continue;
          const file = store.getFileById(fileId);
          if (!file || !["image", "pdf", "video"].includes(file.type) || file.status === "removed") continue;
          // 已索引的有 2048px 副本（解码更快），未索引的直接读原图
          const source = file.type === "image" ? (store.getFileImagePath(fileId) ?? file.path) : file.path;
          try {
            const thumb = file.type === "video"
              ? await makeVideoThumbnail(source, path.join(workerData.userDataDir, "video-thumbnails"), file.sha256, 0)
              : await ensureThumbnail(source, fileThumbPath(path.dirname(store.thumbnailDirectory()), file.sha256), file.type === "pdf" ? "pdf" : "image");
            thumbnails.push({ fileId, path: thumb });
          } catch (error) {
            console.error("[kb] 生成缩略图失败：", source, error);
          }
          if (thumbnails.length % 8 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
        result = thumbnails;
        break;
      }
      case "chunkThumbnails": {
        const ids = Array.isArray(args[0]) ? args[0].slice(0, 120) : [];
        const thumbnails: Array<{ chunkId: number; path: string }> = [];
        for (const value of ids) {
          const chunkId = Number(value);
          if (!Number.isSafeInteger(chunkId) || chunkId <= 0) continue;
          const chunk = store.getChunkById(chunkId);
          if (!chunk?.imagePath) continue;
          // 独立图片的详情预览复用按原文件 sha256 命名的缩略图；文档插图按副本哈希
          const file = store.getFileById(chunk.fileId);
          const source = chunk.imagePath;
          const destination = file?.type === "image"
            ? fileThumbPath(path.dirname(store.thumbnailDirectory()), file.sha256)
            : assetThumbPath(chunk.imagePath);
          try {
            thumbnails.push({ chunkId, path: await ensureThumbnail(source, destination) });
          } catch (error) {
            console.error("[kb] 生成片段缩略图失败：", source, error);
          }
          if (thumbnails.length % 8 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
        result = thumbnails;
        break;
      }
      case "resolveVideoSource": {
        const file = typeof args[0] === "string" ? store.getFileByPath(args[0]) : null;
        if (!file || file.type !== "video" || file.status === "removed") throw new Error("视频不在当前知识库中");
        result = file.path;
        break;
      }
      case "prepareVideoPreview": {
        const file = typeof args[0] === "string" ? store.getFileByPath(args[0]) : null;
        if (!file || file.type !== "video" || file.status === "removed") throw new Error("视频不在当前知识库中");
        result = await makeVideoPreview(file.path, path.join(workerData.userDataDir, "video-previews"), file.sha256);
        break;
      }
      case "videoThumbnail": {
        const chunkId = Number(args[0]);
        if (!Number.isSafeInteger(chunkId) || chunkId <= 0) throw new Error("视频片段无效");
        const chunk = store.getChunkById(chunkId);
        if (!chunk || chunk.videoStart === undefined || chunk.videoEnd === undefined) throw new Error("视频片段不存在");
        const file = store.getFileByPath(chunk.filePath);
        if (!file || file.type !== "video" || file.status !== "indexed") throw new Error("视频不在当前知识库中");
        const thumbnail = await makeVideoThumbnail(file.path, path.join(workerData.userDataDir, "video-thumbnails"), file.sha256, chunk.videoStart);
        const current = store.getChunkById(chunkId);
        if (!current || current.filePath !== file.path || store.getFileByPath(file.path)?.sha256 !== file.sha256) throw new Error("视频片段已更新");
        result = thumbnail; break;
      }
      case "resolveDocument": {
        const [chunkId, hash] = args;
        if (!Number.isSafeInteger(chunkId) || chunkId <= 0 || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("文档引用无效");
        const chunk = store.getChunkById(chunkId);
        const file = chunk && store.getFileByPath(chunk.filePath);
        if (!chunk || !file || (file.type === "image" || file.type === "video") || file.status !== "indexed" || chunk.fileSha256 !== hash || file.sha256 !== hash) throw new Error("文档已移除或更新");
        result = file.path; break;
      }
      case "chatVideo": {
        const [chunkId, hash, startMs, endMs, kind] = args;
        if (!Number.isSafeInteger(chunkId) || chunkId <= 0 || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || (kind !== "thumbnail" && kind !== "play")) throw new Error("视频引用无效");
        const lookup = () => {
          const chunk = store.getChunkById(chunkId);
          if (!chunk || chunk.videoStart === undefined || chunk.videoEnd === undefined || chunk.fileSha256 !== hash || Math.round(chunk.videoStart * 1000) !== startMs || Math.round(chunk.videoEnd * 1000) !== endMs) throw new Error("视频片段已移除或更新");
          const file = store.getFileByPath(chunk.filePath);
          if (!file || file.type !== "video" || file.status !== "indexed" || file.sha256 !== hash) throw new Error("视频片段不可用");
          return { chunk, file };
        };
        const { chunk, file } = lookup();
        const stat = await import("node:fs/promises").then(fs => fs.stat(file.path));
        if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) throw new Error("原视频已更改，请等待重新索引");
        const output = kind === "thumbnail"
          ? await makeVideoThumbnail(file.path, path.join(workerData.userDataDir, "video-thumbnails"), hash, chunk.videoStart!)
          : await makeChatVideoClip(file.path, path.join(workerData.userDataDir, "chat-video-clips"), hash, chunk.videoStart!, chunk.videoEnd!);
        lookup();
        if (kind === "thumbnail") result = { path: output, start: chunk.videoStart, end: chunk.videoEnd, title: file.title };
        else {
          const fs = await import("node:fs/promises");
          const stat = await fs.stat(output);
          if (!stat.size || stat.size > 64 * 1024 * 1024) throw new Error("视频片段为空或过大，无法在聊天中播放");
          const bytes = await fs.readFile(output);
          lookup();
          result = { bytes, start: chunk.videoStart, end: chunk.videoEnd, title: file.title };
        }
        break;
      }
      case "excludeFile": {
        const fileId = Number(args[0]);
        if (!Number.isSafeInteger(fileId) || fileId <= 0 || !store.excludeFile(fileId)) throw new Error("文件不在当前知识库中");
        result = { ok: true }; break;
      }
      case "getFileForTrash": {
        // 移到废纸篓由主进程做（shell.trashItem 只能在主进程调用），
        // 这里只负责确认这个 id 确实是本库的文件，并把真实路径交出去。
        const fileId = Number(args[0]);
        if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error("文件不存在");
        const file = store.getFileById(fileId);
        if (!file || file.status === "removed") throw new Error("文件不在当前知识库中");
        result = { path: file.path, sha256: file.sha256 };
        break;
      }
      case "removeFile": {
        // 废纸篓成功后清索引。注意不能走 excludeFile：那会把路径记进 excluded_files，
        // 用户从废纸篓还原后就再也不会被重新索引了。
        const fileId = Number(args[0]);
        const expectedPath = typeof args[1] === "string" ? args[1] : null;
        if (!Number.isSafeInteger(fileId) || fileId <= 0) throw new Error("文件不存在");
        const file = store.getFileById(fileId);
        // watcher 的 unlink 回调可能已经先把记录删了，这时视为成功
        if (!file) { result = { ok: true }; break; }
        if (expectedPath && file.path !== expectedPath) throw new Error("文件已变化，请刷新后再试");
        store.deleteFile(file.path);
        result = { ok: true };
        break;
      }
      case "getFileChunks": result = store.getChunksByFileId(Number(args[0])); break;
      case "getModelStatus": result = modelState; break;
      case "listModels": result = [downloader.getModelInfo("embeddinggemma2")]; break;
      case "downloadModel": void ensureModel().catch(() => {}); result = modelState; break;
      case "stats": result = store.stats(); break;
      case "getProgress": result = indexer.getProgress(); break;
      case "reindex": void indexer.reindexAll().catch(console.error); result = { ok: true }; break;
      case "reindexFile": indexer.reindexFile(Number(args[0])); result = { ok: true }; break;
      case "clearAll": result = { ok: true, ...store.clearAll() }; break;
      case "search": result = await retriever.search(args[0], args[1]); break;
      case "searchAudio": {
        // 渲染层录的 16kHz 单声道 PCM（Float32Array）经 IPC/worker 结构化克隆传进来
        const raw = args[0];
        const audio = raw instanceof Float32Array ? raw : raw ? new Float32Array(raw as ArrayLike<number>) : null;
        if (!audio || audio.length < 1600) throw new Error("音频片段无效或太短");
        result = await retriever.searchAudio(audio, (args[1] ?? {}) as { limit?: number; minScore?: number });
        break;
      }
      case "buildContext": result = retriever.buildContext(await retriever.search(args[0], 10)); break;
      default: throw new Error(`Unknown knowledge method: ${method}`);
    }
    port.postMessage({ id, result });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
