/**
 * 向量化契约与相似度计算。
 *
 * 这里只定义"能算向量"的最小接口，不绑定推理后端：桌面端注入本地 ONNX 实现，
 * 服务端没有模型时不注入，检索自动退化为纯结构化（时间窗 + 实体），并在结果里
 * 如实标注 mode，不会假装做过语义排序。
 *
 * 为什么文档与查询分成两个方法，而不是一个 embed()：
 * EmbeddingGemma 是检索模型，训练时两侧用的提示前缀不同（文档侧约
 * "title: none | text: …"，查询侧约 "task: search result | query: …"），
 * 两侧必须各用各的。只给一个 embed() 时调用方很容易两侧用同一个前缀，
 * 结果向量仍然能算出来、仍然"看起来正常"，只是召回质量悄悄下降——
 * 这种错误不会报错，所以要在接口层面拦住。
 */
export interface MemoryEmbedder {
  /** 向量维度。写库前校验，避免把不同维度的向量混进同一列。 */
  readonly dim: number;
  /** 文档侧：入库的向量。 */
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  /** 查询侧：与 embedDocuments 用同一模型、对应侧的提示前缀。 */
  embedQuery(text: string): Promise<Float32Array>;
}

/** 向量已按约定做过 L2 归一化，余弦相似度即点积。 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < length; i += 1) dot += a[i] * b[i];
  return dot;
}

/** 把任意向量归一化；零向量原样返回，避免除零。 */
export function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (!norm || !Number.isFinite(norm)) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i] / norm;
  return out;
}

/** pg 的 real[] 参数接受普通数字数组，Float32Array 需要先摊平。 */
export function toRealArray(vector: ArrayLike<number>): number[] {
  return Array.from(vector, (value) => Number(value));
}
