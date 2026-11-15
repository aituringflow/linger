import { parentPort, workerData, Worker } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OnnxEmbeddingProvider } from "./onnx-embedding.js";
import { ModelDownloader, type DownloadProgress } from "./model-downloader.js";
import { setEmbeddingProvider } from "./embedding.js";

const port = parentPort!;
const registry = path.join(workerData.userDataDir, "libraries.json");
type Library = { id: string; name: string; enabled: boolean };
let libraries: Library[] = fs.existsSync(registry) ? JSON.parse(fs.readFileSync(registry, "utf8")) : [];
const save = () => fs.writeFileSync(registry, JSON.stringify(libraries, null, 2));
save();
let selected = libraries[0]?.id;
let internalId = -1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
const workers = new Map<string, Worker>();

// 主 worker 里加载唯一一份 ONNX 模型，所有 runtime worker 共享
const mainEmbedding = new OnnxEmbeddingProvider(workerData.userDataDir);
setEmbeddingProvider(mainEmbedding);

/**
 * 文本向量化的模型状态与下载，由 manager 自己管。
 *
 * 不能复用 runtime 那一套：runtime 是按知识库实例创建的，没有知识库时它根本不存在，
 * 而长期记忆的召回跟知识库无关——用户可能从没建过库。这里独立维护一份，
 * 目录是同一个，下载逻辑幂等。
 */
const memoryDownloader = new ModelDownloader(workerData.userDataDir);
type MemoryModelState = {
  id: "embeddinggemma2";
  phase: "checking" | "downloading" | "done" | "error";
  file: string;
  percent: number;
  downloadedMB: number;
  totalMB: number;
  error?: string;
};
let memoryModelState: MemoryModelState = {
  id: "embeddinggemma2",
  phase: memoryDownloader.isTextModelReady("embeddinggemma2") ? "done" : "checking",
  file: "",
  percent: memoryDownloader.isTextModelReady("embeddinggemma2") ? 100 : 0,
  downloadedMB: 0,
  totalMB: 0,
};
let memoryDownload: Promise<void> | null = null;
function ensureMemoryModel(): Promise<void> {
  if (memoryDownloader.isTextModelReady("embeddinggemma2")) {
    if (memoryModelState.phase !== "done") {
      memoryModelState = { ...memoryModelState, phase: "done", percent: 100 };
      port.postMessage({ modelState: memoryModelState });
    }
    return Promise.resolve();
  }
  if (memoryDownload) return memoryDownload;
  memoryModelState = { ...memoryModelState, phase: "downloading", percent: 0 };
  port.postMessage({ modelState: memoryModelState });
  const promise = memoryDownloader.downloadModel("embeddinggemma2", (p: DownloadProgress) => {
    memoryModelState = {
      ...memoryModelState,
      phase: p.phase === "error" ? "error" : "downloading",
      file: p.file,
      percent: p.percent,
      downloadedMB: p.downloadedMB,
      totalMB: p.totalMB,
      error: p.error,
    };
    port.postMessage({ modelState: memoryModelState });
  }).then(() => {
    memoryModelState = { ...memoryModelState, phase: "done", file: "", percent: 100 };
    port.postMessage({ modelState: memoryModelState });
  }).catch((error) => {
    memoryModelState = { ...memoryModelState, phase: "error", error: error instanceof Error ? error.message : String(error) };
    port.postMessage({ modelState: memoryModelState });
    throw error;
  }).finally(() => { memoryDownload = null; });
  memoryDownload = promise;
  return promise;
}

function runtime(id: string) {
  let worker = workers.get(id);
  if (!worker) {
    const directory = path.join(workerData.userDataDir, "libraries", id);
    worker = new Worker(new URL("./knowledge-runtime.js", import.meta.url), { workerData: { userDataDir: directory, modelDir: workerData.userDataDir } });
    const child = worker;
    worker.on("message", async message => {
      // Child requests have their own IDs; never match them against manager RPC replies.
      if (message.method === "embed" || message.method === "embedOne" || message.method === "embedImage" || message.method === "embedVideo" || message.method === "embedAudio") {
        try {
          const result = message.method === "embedAudio" ? Array.from(await mainEmbedding.embedAudio(message.args[0]))
            : message.method === "embedVideo" ? Array.from(await mainEmbedding.embedVideo(message.args[0], message.args[1]))
            : message.method === "embedImage" ? Array.from(await mainEmbedding.embedImage(message.args[0]))
            : message.method === "embedOne" ? Array.from(await mainEmbedding.embedOne(message.args[0]))
            : (await mainEmbedding.embed(message.args[0])).map(vector => Array.from(vector));
          child.postMessage({ id: message.id, result });
        } catch (error) { child.postMessage({ id: message.id, error: String(error) }); }
        return;
      }
      const request = pending.get(message.id); if (request) { pending.delete(message.id); message.error ? request.reject(new Error(message.error)) : request.resolve(message.result); return; } if (message.id != null || selected === id) port.postMessage(message); });
    worker.on("error", error => port.postMessage({ progress: { phase: "idle", error: String(error) } }));
    workers.set(id, worker);
  }
  return worker;
}
// 应用启动就拉起当前选中库的 runtime：
// 否则 runtime 要等第一次 knowledge IPC（通常来自打开知识库窗口）才创建，
// 窗口没打开 / 重启后没恢复窗口时，「关掉窗口继续后台索引」就形同虚设。
if (selected) runtime(selected);
port.on("message", async message => {
  const { id, method, args } = message;
  try {
    let result: unknown;
    if (method === "embed") {
      // runtime worker 的 embedding 请求，主 worker 用共享模型推理
      const texts = args[0] as string[];
      const vectors = await mainEmbedding.embed(texts);
      result = vectors.map((v) => Array.from(v));
    } else if (method === "embedMemoryDocument") {
      await ensureMemoryModel();
      result = Array.from((await mainEmbedding.embed([String(args[0] ?? "")]))[0]);
    } else if (method === "embedText") {
      // 长期记忆的查询向量：与知识库无关，没有库也要能用。顺带确保模型就位。
      await ensureMemoryModel();
      result = Array.from(await mainEmbedding.embedOne(String(args[0] ?? "")));
    } else if (method === "warmEmbedding") {
      // 只把模型加载到内存，不推理：记忆召回有超时预算，冷启动不能算在它头上。
      await ensureMemoryModel();
      result = await mainEmbedding.warm();
    } else if (method === "getModelStatus") {
      // 有知识库时以 runtime 的状态为准（它还会触发索引恢复），否则用 manager 自己的。
      result = selected
        ? await new Promise((resolve, reject) => { const requestId = internalId--; pending.set(requestId, { resolve, reject }); runtime(selected).postMessage({ id: requestId, method: "getModelStatus", args: [] }); })
        : memoryModelState;
    } else if (method === "downloadModel") {
      if (selected) {
        result = await new Promise((resolve, reject) => { const requestId = internalId--; pending.set(requestId, { resolve, reject }); runtime(selected).postMessage({ id: requestId, method: "downloadModel", args: [] }); });
      } else {
        void ensureMemoryModel().catch(() => {});
        result = memoryModelState;
      }
    } else if (method === "searchEnabled") {
      const results = [];
      for (const library of libraries.filter(item => item.enabled)) {
        const response = await new Promise<any[]>((resolve, reject) => { const requestId = internalId--; pending.set(requestId, { resolve, reject }); runtime(library.id).postMessage({ id: requestId, method: "search", args }); });
        results.push(...response.map(item => ({ ...item, libraryId: library.id, libraryName: library.name })));
      }
      result = results.sort((a, b) => b.score - a.score).slice(0, 10);
    } else if (method === "chatVideo" || method === "resolveDocument") {
      const [libraryId, ...rest] = args;
      if (typeof libraryId !== "string" || !libraries.some(item => item.id === libraryId && item.enabled)) throw new Error("知识库不可用或已停用");
      result = await new Promise((resolve, reject) => { const requestId = internalId--; pending.set(requestId, { resolve, reject }); runtime(libraryId).postMessage({ id: requestId, method, args: rest }); });
    } else if (method === "listLibraries") result = libraries;
    else if (method === "createLibrary") {
      const name = String(args[0] ?? "").trim();
      if (!name) throw new Error("请输入知识库名称");
      if (libraries.some(item => item.name === name)) throw new Error(`知识库「${name}」已存在`);
      const library = { id: randomUUID(), name, enabled: true };
      libraries.push(library); save(); result = library;
    } else if (method === "selectLibrary") {
      if (!libraries.some(item => item.id === args[0])) throw new Error("知识库不存在");
      selected = args[0]; result = { ok: true };
    } else if (method === "listLibrariesStats") {
      result = await Promise.all(libraries.map(async (lib) => {
        try {
          const s = await new Promise<any>((resolve, reject) => {
            const reqId = internalId--;
            pending.set(reqId, { resolve, reject });
            runtime(lib.id).postMessage({ id: reqId, method: "stats", args: [] });
          });
          return { id: lib.id, name: lib.name, enabled: lib.enabled, stats: s };
        } catch {
          return { id: lib.id, name: lib.name, enabled: lib.enabled, stats: null };
        }
      }));
    } else if (method === "updateLibrary") {
      const library = libraries.find(item => item.id === args[0]);
      if (!library) throw new Error("知识库不存在");
      if (typeof args[1]?.name === "string") { const name = args[1].name.trim(); if (!name) throw new Error("请输入名称"); library.name = name; }
      if (typeof args[1]?.enabled === "boolean") library.enabled = args[1].enabled;
      save(); result = library;
    } else if (method === "deleteLibrary") {
      const library = libraries.find(item => item.id === args[0]);
      if (!library) throw new Error("知识库不存在");
      await workers.get(library.id)?.terminate(); workers.delete(library.id);
      const directory = path.join(workerData.userDataDir, "libraries", library.id);
      fs.rmSync(directory, { recursive: true, force: true });
      libraries = libraries.filter(item => item.id !== library.id); save();
      if (selected === library.id) selected = libraries[0]?.id;
      result = { ok: true };
    } else {
      if (!selected) throw new Error("请先创建知识库");
      runtime(selected).postMessage(message); return;
    }
    port.postMessage({ id, result });
  } catch (error) { port.postMessage({ id, error: String(error) }); }
});
