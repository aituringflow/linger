import fs from "node:fs";
import path from "node:path";
import type * as OrtNamespace from "onnxruntime-node";
import { Tokenizer } from "@huggingface/tokenizers";
import type { EmbeddingProvider } from "./embedding.js";
import { loadOnnxRuntime } from "./onnx-runtime.js";

type OrtModule = typeof import("onnxruntime-node");

let ortPromise: Promise<OrtModule> | null = null;

/**
 * onnxruntime-node 会在 require 时加载原生绑定，因此必须等知识库
 * 实际执行推理时再下载并加载，避免影响 worker 的其他功能。
 */
function loadOrt(userDataDir: string): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = loadOnnxRuntime(userDataDir);
    ortPromise.catch(() => { ortPromise = null; });
  }
  return ortPromise;
}

/** EmbeddingGemma 2 INT8 text inference, entirely local. */
const MODEL_DIR_NAME = "embeddinggemma2";
const MODEL_FILE = "model_quantized.onnx";
const TOKENIZER_FILE = "tokenizer.json";

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly name = "embeddinggemma2-onnx";
  readonly dim = 768;

  private session: OrtNamespace.InferenceSession | null = null;
  private tokenizer: Tokenizer | null = null;
  private initPromise: Promise<boolean> | null = null;
  private modelDir: string;
  private userDataDir: string;
  private processor: any = null;
  private visionSession: OrtNamespace.InferenceSession | null = null;
  private audioSession: OrtNamespace.InferenceSession | null = null;
  private inferenceQueue: Promise<unknown> = Promise.resolve();
  /** 最近一次初始化失败的原因，用于把真实原因透出到 UI */
  private lastError: string | null = null;

  constructor(userDataDir: string) {
    this.userDataDir = userDataDir;
    this.modelDir = path.join(userDataDir, "models", MODEL_DIR_NAME);
  }

  /** 检测模型文件是否存在 */
  isModelAvailable(): boolean {
    return fs.existsSync(path.join(this.modelDir, MODEL_FILE)) &&
           fs.existsSync(path.join(this.modelDir, TOKENIZER_FILE));
  }

  /** 加载 onnxruntime-node；平台没有原生绑定时给出可读错误，而不是 "Cannot find module"。 */
  private async ort(): Promise<OrtModule> {
    try {
      return await loadOrt(this.userDataDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`onnxruntime-node 原生绑定加载失败（${process.platform}/${process.arch}）：${detail}`);
    }
  }

  /** 初始化 ONNX session（懒加载） */
  private async init(): Promise<boolean> {
    if (this.session) return true;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        const modelPath = path.join(this.modelDir, MODEL_FILE);
        if (!fs.existsSync(modelPath)) {
          console.log("[kb] EmbeddingGemma 2 模型文件不存在");
          return false;
        }

        const ort = await this.ort();
        console.log("[kb] 加载 EmbeddingGemma 2 ONNX 模型…");
        const tokenizerJson = JSON.parse(await fs.promises.readFile(path.join(this.modelDir, TOKENIZER_FILE), "utf8"));
        const tokenizerConfig = JSON.parse(await fs.promises.readFile(path.join(this.modelDir, "tokenizer_config.json"), "utf8"));
        this.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
        this.session = await ort.InferenceSession.create(modelPath, {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
          // 限制线程数，避免多 worker 同时跑时线程池爆炸导致崩溃
          intraOpNumThreads: 2,
          interOpNumThreads: 1,
          enableCpuMemArena: false,
          enableMemPattern: false,
        });
        console.log("[kb] EmbeddingGemma 2 模型加载完成");
        return true;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        console.error("[kb] EmbeddingGemma 2 模型加载失败：", e);
        this.session = null;
        this.tokenizer = null;
        return false;
      }
    })();

    const ready = await this.initPromise;
    if (!ready) this.initPromise = null;
    return ready;
  }

  /** 文本/图片/视频/音频共用一个 processor（tokenizer + 各模态特征提取器）。 */
  private async ensureProcessor(): Promise<any> {
    if (this.processor) return this.processor;
    const { AutoProcessor } = await import("@huggingface/transformers");
    this.processor = await AutoProcessor.from_pretrained(this.modelDir, { local_files_only: true });
    this.processor.image_processor.max_soft_tokens = 70;
    return this.processor;
  }

  embedImage(imagePath: string): Promise<Float32Array> {
    const result = this.inferenceQueue.then(async () => {
      if (!await this.init() || !this.session) throw new Error("EmbeddingGemma 2 模型未就绪");
      const ort = await this.ort();
      const { RawImage } = await import("@huggingface/transformers");
      const processor = await this.ensureProcessor();
      if (!this.visionSession) this.visionSession = await ort.InferenceSession.create(path.join(this.modelDir, "vision_encoder_quantized.onnx"), {
        executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1,
        enableCpuMemArena: false, enableMemPattern: false,
      });
      const inputs = await processor(null, await RawImage.read(imagePath));
      const tensor = (value: any) => new ort.Tensor(value.type, value.data, value.dims);
      const vision = await this.visionSession.run({ pixel_values: tensor(inputs.pixel_values), pixel_position_ids: tensor(inputs.image_position_ids) }, ["image_features"]);
      const output = await this.session.run({
        input_ids: tensor(inputs.input_ids), attention_mask: tensor(inputs.attention_mask),
        image_features: vision.image_features,
        video_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
        audio_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
      }, ["sentence_embedding"]);
      const vector = new Float32Array(output.sentence_embedding.data as Float32Array);
      if (vector.length !== this.dim || !vector.every(Number.isFinite)) throw new Error("图片向量无效");
      const norm = Math.hypot(...vector) || 1;
      return vector.map(value => value / norm);
    });
    this.inferenceQueue = result.catch(() => {});
    return result;
  }

  /** A single native video embedding: ordered frames become video tokens in one model inference. */
  embedVideo(framePaths: string[], duration: number): Promise<Float32Array> {
    const result = this.inferenceQueue.then(async () => {
      if (!framePaths.length || framePaths.length > 32 || !Number.isFinite(duration) || duration <= 0) throw new Error("视频帧或时长无效");
      if (!await this.init() || !this.session) throw new Error("EmbeddingGemma 2 模型未就绪");
      const ort = await this.ort();
      const { RawImage, RawVideo, RawVideoFrame } = await import("@huggingface/transformers");
      const processor = await this.ensureProcessor();
      if (!this.visionSession) this.visionSession = await ort.InferenceSession.create(path.join(this.modelDir, "vision_encoder_quantized.onnx"), {
        executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1,
        enableCpuMemArena: false, enableMemPattern: false,
      });
      const frames = await Promise.all(framePaths.map(async (frame, i) => new RawVideoFrame(await RawImage.read(frame), Math.min(i, duration))));
      const inputs = await processor(null, null, null, new RawVideo(frames, duration));
      const tensor = (value: any) => new ort.Tensor(value.type, value.data, value.dims);
      const vision = await this.visionSession.run({ pixel_values: tensor(inputs.pixel_values_videos), pixel_position_ids: tensor(inputs.video_position_ids) }, ["image_features"]);
      const config = JSON.parse(await fs.promises.readFile(path.join(this.modelDir, "config.json"), "utf8")) as { video_token_id: number };
      const tokenCount = Array.from(inputs.input_ids.data as ArrayLike<bigint>).filter(id => Number(id) === config.video_token_id).length;
      if (vision.image_features.dims[0] !== tokenCount) throw new Error("视频帧特征与视频 token 数量不匹配");
      const output = await this.session.run({
        input_ids: tensor(inputs.input_ids), attention_mask: tensor(inputs.attention_mask),
        image_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
        video_features: vision.image_features,
        audio_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
      }, ["sentence_embedding"]);
      const vector = new Float32Array(output.sentence_embedding.data as Float32Array);
      if (vector.length !== this.dim || !vector.every(Number.isFinite)) throw new Error("视频向量无效");
      const norm = Math.hypot(...vector);
      if (!norm || !Number.isFinite(norm)) throw new Error("视频向量无效");
      return vector.map(value => value / norm);
    });
    this.inferenceQueue = result.catch(() => {});
    return result;
  }

  /**
   * 单声道 16kHz PCM → 768 维向量。
   *
   * 音频先过独立 audio_encoder（300M，约 324MB）得到 [tokens, 512] 特征，再和文本 token
   * 一起进主模型；因此语音查询和视频音轨落在同一个向量空间里，可以直接算相似度。
   */
  embedAudio(audio: Float32Array): Promise<Float32Array> {
    const result = this.inferenceQueue.then(async () => {
      if (!(audio instanceof Float32Array) || audio.length < 1600) throw new Error("音频片段太短");
      if (!await this.init() || !this.session) throw new Error("EmbeddingGemma 2 模型未就绪");
      const ort = await this.ort();
      const processor = await this.ensureProcessor();
      if (!this.audioSession) {
        const audioModel = path.join(this.modelDir, "audio_encoder_quantized.onnx");
        if (!fs.existsSync(audioModel)) throw new Error("音频编码器未下载，请打开知识库设置下载模型");
        this.audioSession = await ort.InferenceSession.create(audioModel, {
          executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1,
          enableCpuMemArena: false, enableMemPattern: false,
        });
      }
      const inputs = await processor(null, null, audio);
      const tensor = (value: any) => new ort.Tensor(value.type, value.data, value.dims);
      const encoded = await this.audioSession.run({
        input_features: tensor(inputs.input_features),
        input_features_mask: tensor(inputs.input_features_mask),
      }, ["audio_features"]);
      const output = await this.session.run({
        input_ids: tensor(inputs.input_ids), attention_mask: tensor(inputs.attention_mask),
        image_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
        video_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
        audio_features: encoded.audio_features,
      }, ["sentence_embedding"]);
      const vector = new Float32Array(output.sentence_embedding.data as Float32Array);
      if (vector.length !== this.dim || !vector.every(Number.isFinite)) throw new Error("音频向量无效");
      const norm = Math.hypot(...vector) || 1;
      return vector.map(value => value / norm);
    });
    this.inferenceQueue = result.catch(() => {});
    return result;
  }

  async embedOne(text: string): Promise<Float32Array> {
    const [vec] = await this.infer([`task: search result | query: ${text}`]);
    return vec;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return this.infer(texts.map(text => `title: none | text: ${text}`));
  }

  private infer(texts: string[]): Promise<Float32Array[]> {
    // All libraries and chat queries share one session and one bounded inference at a time.
    const result = this.inferenceQueue.then(() => this.runInference(texts));
    this.inferenceQueue = result.catch(() => {});
    return result;
  }

  private async runInference(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const ready = await this.init();
    if (!ready || !this.session || !this.tokenizer) {
      throw new Error(this.lastError ? `EmbeddingGemma 2 模型加载失败：${this.lastError}` : "EmbeddingGemma 2 模型加载失败");
    }
    const ort = await this.ort();

    try {
      // 真正的 batch 推理：一次性把所有文本 pad 到相同长度，一起喂给 ONNX
      const BATCH_MAX = 1; // Attention memory grows quadratically with sequence length.
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += BATCH_MAX) {
        const batch = texts.slice(i, i + BATCH_MAX);
        const encodedList = batch.map((t) => this.tokenizer!.encode(t));

        // 找到 batch 里最长的序列，全部 pad 到这个长度（上限 512）
        const maxLen = Math.min(512, Math.max(...encodedList.map((e) => e.ids.length)));

        const batchSize = batch.length;
        const inputIds = new BigInt64Array(batchSize * maxLen);
        const attentionMask = new BigInt64Array(batchSize * maxLen);

        for (let b = 0; b < batchSize; b++) {
          const ids = encodedList[b].ids.slice(0, maxLen);
          for (let j = 0; j < ids.length; j++) {
            inputIds[b * maxLen + j] = BigInt(ids[j]);
            attentionMask[b * maxLen + j] = 1n;
          }
        }

        const feeds: Record<string, OrtNamespace.Tensor> = {
          input_ids: new ort.Tensor("int64", inputIds, [batchSize, maxLen]),
          attention_mask: new ort.Tensor("int64", attentionMask, [batchSize, maxLen]),
          image_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
          video_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
          audio_features: new ort.Tensor("float32", new Float32Array(0), [0, 512]),
        };

        const output = await this.session!.run(feeds, ["sentence_embedding"]);
        const embedding = output.sentence_embedding;
        if (!embedding || embedding.dims.length !== 2 || embedding.dims[1] !== this.dim) throw new Error("EmbeddingGemma 2 返回了无效的 sentence_embedding");
        const data = embedding.data as Float32Array;
        const dim = embedding.dims[embedding.dims.length - 1];

        // 模型已经完成 mean pooling 和 projection，直接读取句向量。
        for (let b = 0; b < batchSize; b++) {
          const offset = b * dim;
          const vec = new Float32Array(data.slice(offset, offset + dim));

          // L2 归一化
          let norm = 0;
          for (let j = 0; j < dim; j++) norm += vec[j] * vec[j];
          norm = Math.sqrt(norm) || 1;
          for (let j = 0; j < dim; j++) vec[j] /= norm;

          results.push(vec);
        }
      }

      return results;
    } catch (e) {
      console.error("[kb] ONNX 推理失败：", e);
      throw e;
    }
  }

  /** 获取模型目录路径（供 UI 显示/下载用） */
  getModelDir(): string {
    return this.modelDir;
  }
}
