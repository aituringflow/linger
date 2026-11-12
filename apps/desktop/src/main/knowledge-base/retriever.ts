import { KnowledgeStore } from "./store.js";
import { getEmbeddingProvider } from "./embedding.js";
import { formatTakenDate } from "./exif.js";

/**
 * 检索引擎：双路召回 → RRF 融合。
 *
 * dense 路：query → embedding → 向量余弦相似度 top-N
 * keyword 路：query → FTS5 BM25 top-N
 * RRF 融合：score = Σ 1/(k + rank_i)，k=60（标准值）
 */

export interface RetrievalResult {
  imagePath?: string;
  fileType?: string;
  coverage?: "unknown" | "complete" | "partial";
  chunkId: number;
  videoStart?: number;
  videoEnd?: number;
  /** video=画面窗口，audio=音轨窗口；文本/图片为 null */
  modality?: "video" | "audio" | null;
  text: string;
  filePath: string;
  fileTitle: string;
  fileSha256: string;
  headingPath: string;
  score: number;
  source: "dense" | "keyword" | "both";
  dateTakenMs: number | null;
  mtimeMs: number;
  camera: string | null;
  lat: number | null;
  lon: number | null;
}

const RRF_K = 60;
const RECALL_TOP_N = 50;
const FINAL_TOP_K = 10;
export interface RetrievalOptions {
  limit?: number;
  minScore?: number;
  mode?: "hybrid" | "dense" | "keyword";
}

export class Retriever {
  constructor(private store: KnowledgeStore) {}

  async search(query: string, input: number | RetrievalOptions = FINAL_TOP_K): Promise<RetrievalResult[]> {
    const options = typeof input === "number" ? { limit: input } : (input ?? {});
    const limit = Math.max(1, Math.min(RECALL_TOP_N, Math.floor(Number(options.limit) || FINAL_TOP_K)));
    const minScore = Number.isFinite(options.minScore) ? Math.max(0, Math.min(2 / (RRF_K + 1), options.minScore!)) : 0;
    const mode = options.mode === "dense" || options.mode === "keyword" ? options.mode : "hybrid";
    const [denseResults, keywordResults] = await Promise.all([
      mode === "keyword" ? [] : this.searchDense(query),
      mode === "dense" ? [] : this.searchKeyword(query),
    ]);

    // RRF 融合
    const rrfScores = new Map<number, { score: number; sources: Set<string>; text: string }>();

    denseResults.forEach((r, rank) => {
      const existing = rrfScores.get(r.chunkId) ?? { score: 0, sources: new Set(), text: "" };
      existing.score += 1 / (RRF_K + rank + 1);
      existing.sources.add("dense");
      rrfScores.set(r.chunkId, existing);
    });

    keywordResults.forEach((r, rank) => {
      const existing = rrfScores.get(r.chunkId) ?? { score: 0, sources: new Set(), text: "" };
      existing.score += 1 / (RRF_K + rank + 1);
      existing.sources.add("keyword");
      if (!existing.text) existing.text = r.text ?? "";
      rrfScores.set(r.chunkId, existing);
    });

    // 按融合分数选取候选。
    const candidates = [...rrfScores.entries()].filter(([, meta]) => meta.score >= minScore).sort((a, b) => b[1].score - a[1].score).slice(0, Math.max(20, limit));

    const finalIds = candidates.slice(0, limit).map(([id]) => id);

    // 补全 chunk 详情
    const results: RetrievalResult[] = [];
    for (const chunkId of finalIds) {
      const chunk = this.store.getChunkById(chunkId);
      if (!chunk) continue;
      const meta = rrfScores.get(chunkId)!;
      results.push({
        chunkId,
        fileType: this.store.getFileByPath(chunk.filePath)?.type,
        coverage: chunk.coverage,
        videoStart: chunk.videoStart,
        videoEnd: chunk.videoEnd,
        modality: chunk.modality ?? null,
        imagePath: chunk.imagePath ?? this.store.getFileImagePath(chunk.fileId),
        text: chunk.text,
        filePath: chunk.filePath,
        fileTitle: chunk.fileTitle,
        fileSha256: chunk.fileSha256,
        headingPath: chunk.headingPath,
        score: meta.score,
        source: meta.sources.size > 1 ? "both" : (meta.sources.has("dense") ? "dense" : "keyword"),
        dateTakenMs: chunk.dateTakenMs,
        mtimeMs: chunk.mtimeMs,
        camera: chunk.camera,
        lat: chunk.lat,
        lon: chunk.lon,
      });
    }

    return results;
  }

  /**
   * 语音召回：录一段音频 → 音频查询向量 → 视频音轨窗口的余弦相似度 top-N。
   *
   * 只查 audio 模态（视频音轨）；结果带 filePath + videoStart/videoEnd，
   * 前端和 MCP 可以直接定位/播放原视频的对应片段。
   */
  async searchAudio(audio: Float32Array, input: number | RetrievalOptions = FINAL_TOP_K): Promise<RetrievalResult[]> {
    const options = typeof input === "number" ? { limit: input } : (input ?? {});
    const limit = Math.max(1, Math.min(RECALL_TOP_N, Math.floor(Number(options.limit) || FINAL_TOP_K)));
    const minScore = Number.isFinite(options.minScore) ? Math.max(0, Math.min(1, options.minScore!)) : 0;
    const provider = getEmbeddingProvider();
    const vector = await provider.embedAudio(audio);
    const hits = this.store.searchByVector(vector, Math.max(RECALL_TOP_N, limit), "audio").filter(hit => hit.score >= minScore);

    const results: RetrievalResult[] = [];
    for (const hit of hits.slice(0, limit)) {
      const chunk = this.store.getChunkById(hit.chunkId);
      if (!chunk) continue;
      results.push({
        chunkId: hit.chunkId,
        fileType: this.store.getFileByPath(chunk.filePath)?.type,
        coverage: chunk.coverage,
        videoStart: chunk.videoStart,
        videoEnd: chunk.videoEnd,
        modality: chunk.modality ?? "audio",
        text: chunk.text,
        filePath: chunk.filePath,
        fileTitle: chunk.fileTitle,
        fileSha256: chunk.fileSha256,
        headingPath: chunk.headingPath,
        score: hit.score,
        source: "dense",
        dateTakenMs: chunk.dateTakenMs,
        mtimeMs: chunk.mtimeMs,
        camera: chunk.camera,
        lat: chunk.lat,
        lon: chunk.lon,
      });
    }
    return results;
  }

  private async searchDense(query: string): Promise<Array<{ chunkId: number; score: number }>> {
    try {
      const provider = getEmbeddingProvider();
      const queryVec = await provider.embedOne(query);
      return this.store.searchByVector(queryVec, RECALL_TOP_N);
    } catch (e) {
      console.error("[kb] dense 检索失败：", e);
      return [];
    }
  }

  private searchKeyword(query: string): Array<{ chunkId: number; score: number; text: string }> {
    try {
      // FTS5 的 MATCH 查询：把空格转成 OR，让分词后的词都能命中
      // 简单处理：直接用原 query，FTS5 的 unicode61 对中文按单字切
      // 第一版直接用原 query，后续可以加 jieba 分词后再查询
      const ftsQuery = query
        .replace(/["']/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .join(" OR ");
      if (!ftsQuery) return [];
      return this.store.searchByKeyword(ftsQuery, RECALL_TOP_N);
    } catch (e) {
      console.error("[kb] keyword 检索失败：", e);
      return [];
    }
  }

  /** 组装给 LLM 的上下文（带引用标记） */
  buildContext(results: RetrievalResult[]): { context: string; citations: Array<{ index: number; filePath: string; fileTitle: string }> } {
    const citations: Array<{ index: number; filePath: string; fileTitle: string }> = [];
    const parts: string[] = [];

    results.forEach((r, i) => {
      const idx = i + 1;
      citations.push({ index: idx, filePath: r.filePath, fileTitle: r.fileTitle });
      const heading = r.headingPath ? `（${r.headingPath}）` : "";
      const metaParts: string[] = [];
      const date = formatTakenDate(r.dateTakenMs);
      if (date) metaParts.push(`拍摄于 ${date}`);
      if (r.camera) metaParts.push(r.camera);
      if (r.lat != null && r.lon != null && Number.isFinite(r.lat) && Number.isFinite(r.lon) && (r.lat !== 0 || r.lon !== 0)) {
        metaParts.push(`${r.lat.toFixed(5)},${r.lon.toFixed(5)}`);
      }
      const meta = metaParts.length ? `［${metaParts.join(" · ")}］` : "";
      parts.push(`[${idx}] 《${r.fileTitle}》${heading}${meta}\n${r.text}`);
    });

    return {
      context: parts.join("\n\n---\n\n"),
      citations,
    };
  }
}
