/**
 * Embedding 提供者（可插拔接口）。
 *
 * 当前实现：EmbeddingGemma 2 ONNX（768 维），完全本地运行。
 * 模型文件放在应用主目录 ~/.linger/knowledge/models/embeddinggemma2/ 下。
 *
 * 架构：主 worker 里加载真实 ONNX 模型，runtime worker 用 RemoteEmbeddingProvider 通过 IPC 调用，
 * 避免每个知识库都加载一份 500MB 模型导致内存爆炸和线程池冲突。
 */

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<Float32Array[]>;
  embedOne(text: string): Promise<Float32Array>;
  embedImage(imagePath: string): Promise<Float32Array>;
  embedVideo(framePaths: string[], duration: number): Promise<Float32Array>;
  /** 单声道 16kHz PCM 音频 → 同一向量空间（视频音轨 / 语音召回共用） */
  embedAudio(audio: Float32Array): Promise<Float32Array>;
}

/** 全局单例 */
let globalProvider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!globalProvider) {
    throw new Error("Embedding provider 未初始化，请先调用 setEmbeddingProvider()");
  }
  return globalProvider;
}

export function setEmbeddingProvider(provider: EmbeddingProvider): void {
  globalProvider = provider;
}

/**
 * 远程 Embedding Provider：runtime worker 用这个，通过 IPC 把 embed 请求发给主 worker。
 * 主 worker 里有真实的 ONNX 模型，只加载一份。
 */
export class RemoteEmbeddingProvider implements EmbeddingProvider {
  readonly name = "remote-embedding";
  readonly dim = 768;

  constructor(private send: (method: string, args: unknown[]) => Promise<unknown>) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    const results = await this.send("embed", [texts]) as Array<Array<number>>;
    return results.map((arr) => new Float32Array(arr));
  }

  async embedImage(imagePath: string): Promise<Float32Array> {
    return new Float32Array(await this.send("embedImage", [imagePath]) as number[]);
  }

  async embedVideo(framePaths: string[], duration: number): Promise<Float32Array> {
    return new Float32Array(await this.send("embedVideo", [framePaths, duration]) as number[]);
  }

  async embedAudio(audio: Float32Array): Promise<Float32Array> {
    // 结构化克隆会保留 Float32Array，避免 16k×10s 的采样点被展开成 JSON 数字数组
    return new Float32Array(await this.send("embedAudio", [audio]) as number[]);
  }

  async embedOne(text: string): Promise<Float32Array> {
    const result = await this.send("embedOne", [text]) as number[];
    return new Float32Array(result);
  }
}
