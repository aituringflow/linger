import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * 模型自动下载器。
 *
 * 知识库统一使用 EmbeddingGemma 2 的文本编码器。
 * 下载进度通过回调推送到 UI。
 */

export interface ModelFileInfo {
  name: string;
  url: string;
  dest: string;
  expectedSize?: number;
  sha256?: string;
}

export interface DownloadProgress {
  model: string;        // "embeddinggemma2"
  file: string;         // 文件名
  percent: number;      // 0-100
  downloadedMB: number;
  totalMB: number;
  phase: "checking" | "downloading" | "extracting" | "done" | "error";
  error?: string;
}

const MODEL_BASE_DIR = "models";

// EmbeddingGemma 2 ONNX INT8 text encoder.
const EMBEDDING_GEMMA2_FILES: Omit<ModelFileInfo, "dest">[] = [
  { name: "model_quantized.onnx", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=onnx%2Fmodel_quantized.onnx", expectedSize: 495165 },
  { name: "model_quantized.onnx_data", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=onnx%2Fmodel_quantized.onnx_data", expectedSize: 313724928 },
  { name: "vision_encoder_quantized.onnx", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=onnx%2Fvision_encoder_quantized.onnx", expectedSize: 162495 },
  { name: "vision_encoder_quantized.onnx_data", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=onnx%2Fvision_encoder_quantized.onnx_data", expectedSize: 195228672 },
  // 音频编码器（视频音轨 / 语音召回）：约 324MB，只有音轨索引和语音检索需要
  { name: "audio_encoder_quantized.onnx", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=onnx%2Faudio_encoder_quantized.onnx", expectedSize: 249330, sha256: "04a9a9094ba76fb169e4c69be45a4b621580188654d6be59eab860eadcd42d3c" },
  { name: "audio_encoder_quantized.onnx_data", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=onnx%2Faudio_encoder_quantized.onnx_data", expectedSize: 340058624, sha256: "aa6361d898e1f1d6303f8dd2b5fabf4fd3629e15fd709e9cb06ac5cb9416a030" },
  { name: "preprocessor_config.json", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=preprocessor_config.json", expectedSize: 560 },
  { name: "processor_config.json", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=processor_config.json", expectedSize: 1788 },
  { name: "tokenizer.json", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=tokenizer.json", expectedSize: 32170510 },
  { name: "config.json", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=config.json", expectedSize: 5031 },
  { name: "tokenizer_config.json", url: "https://modelscope.cn/api/v1/models/onnx-community/embeddinggemma-2-ONNX/repo?Revision=master&FilePath=tokenizer_config.json", expectedSize: 1599 },
];

export type ModelName = "embeddinggemma2";

const MODEL_FILES: Record<ModelName, Omit<ModelFileInfo, "dest">[]> = {
  embeddinggemma2: EMBEDDING_GEMMA2_FILES,
};

export class ModelDownloader {
  private downloads = new Map<string, Promise<void>>();

  constructor(private userDataDir: string) {}

  /** 获取模型目录 */
  private modelDir(modelName: string): string {
    return path.join(this.userDataDir, MODEL_BASE_DIR, modelName);
  }

  /** 检查模型是否已完整下载 */
  isModelReady(modelName: ModelName): boolean {
    return this.getModelInfo(modelName).files.every((file) => file.valid);
  }

  getModelInfo(modelName: ModelName) {
    const directory = this.modelDir(modelName);
    const entries = MODEL_FILES[modelName];
    const files = entries.map((f) => {
      let size = 0;
      try { size = fs.statSync(path.join(directory, f.name)).size; } catch { /* absent */ }
      const valid = size === f.expectedSize;
      return { name: f.name, size, expectedSize: f.expectedSize ?? 0, valid };
    });
    return { id: modelName, path: directory, files, size: files.reduce((n, f) => n + f.size, 0), ready: files.every((f) => f.valid) };
  }

  /** 下载单个文件（带进度回调） */
  private async downloadFile(
    info: ModelFileInfo,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<void> {
    const dir = path.dirname(info.dest);
    await fsp.mkdir(dir, { recursive: true });

    // 已存在且大小合理，跳过
    if (fs.existsSync(info.dest)) {
      const stat = await fsp.stat(info.dest);
      if (info.expectedSize && stat.size === info.expectedSize) {
        onProgress({
          model: path.basename(dir),
          file: info.name,
          percent: 100,
          downloadedMB: stat.size / 1024 / 1024,
          totalMB: (info.expectedSize ?? stat.size) / 1024 / 1024,
          phase: "done",
        });
        return;
      }
    }

    const tmpPath = info.dest + ".tmp";
    const modelName = path.basename(dir);

    const download = (url: string, redirects = 0): Promise<void> => new Promise((resolve, reject) => {
      if (redirects > 5) { reject(new Error("重定向次数过多")); return; }
      const req = https.get(url, { timeout: 30_000, headers: { "User-Agent": "Mozilla/5.0 (compatible; ModelScope/1.0; +https://modelscope.cn)" } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          res.resume();
          void download(new URL(res.headers.location, url).toString(), redirects + 1).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume(); reject(new Error(`下载失败：HTTP ${res.statusCode}`)); return;
        }
        const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
        if (contentType.includes("text/html")) { res.resume(); reject(new Error("下载地址返回了网页，而不是模型文件")); return; }
        const contentLength = Number(res.headers["content-length"]) || 0;
        if (contentLength && info.expectedSize && contentLength !== info.expectedSize) {
          res.resume(); reject(new Error(`模型文件大小不符：${contentLength} / ${info.expectedSize} 字节`)); return;
        }
        const hash = createHash("sha256");
        let downloaded = 0;
        let last = 0;
        const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          downloaded += chunk.length; hash.update(chunk);
          const now = Date.now();
          if (now - last >= 200) {
            last = now;
            onProgress({ model: modelName, file: info.name, percent: Math.min(99, downloaded / (info.expectedSize || contentLength || 1) * 100), downloadedMB: downloaded / 1048576, totalMB: (info.expectedSize || contentLength) / 1048576, phase: "downloading" });
          }
          callback(null, chunk);
        }});
        void (async () => {
          try {
            await pipeline(res, counter, fs.createWriteStream(tmpPath));
            if (info.expectedSize && downloaded !== info.expectedSize) throw new Error(`文件大小不符：${downloaded} / ${info.expectedSize} 字节`);
            if (info.sha256 && hash.digest("hex") !== info.sha256) throw new Error("模型文件 SHA-256 校验失败");
            await fsp.rename(tmpPath, info.dest);
            resolve();
          } catch (error) {
            await fsp.rm(tmpPath, { force: true }).catch(() => {});
            reject(error);
          }
        })();
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("下载超时")));
    });
    onProgress({ model: modelName, file: info.name, percent: 0, downloadedMB: 0, totalMB: (info.expectedSize ?? 0) / 1048576, phase: "downloading" });
    if (!info.url) throw new Error("此模型尚未配置可用的 ONNX 下载地址");
    await download(info.url);
  }

  /** 下载指定模型 */
  async downloadModel(
    modelName: ModelName,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<void> {
    if (this.isModelReady(modelName)) {
      onProgress({ model: modelName, file: "", percent: 100, downloadedMB: 0, totalMB: 0, phase: "done" });
      return;
    }

    // 防止重复下载
    if (this.downloads.has(modelName)) {
      return this.downloads.get(modelName)!;
    }

    const dir = this.modelDir(modelName);
    const files = MODEL_FILES[modelName];

    const promise = (async () => {
      try {
        for (const f of files) {
          const info: ModelFileInfo = { ...f, dest: path.join(dir, f.name) };
          await this.downloadFile(info, onProgress);
        }
        onProgress({ model: modelName, file: "", percent: 100, downloadedMB: 0, totalMB: 0, phase: "done" });
      } catch (e) {
        onProgress({
          model: modelName,
          file: "",
          percent: 0,
          downloadedMB: 0,
          totalMB: 0,
          phase: "error",
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      } finally {
        this.downloads.delete(modelName);
      }
    })();

    this.downloads.set(modelName, promise);
    return promise;
  }

  /** 获取模型目录路径 */
  getModelPath(modelName: string): string {
    return this.modelDir(modelName);
  }
}
