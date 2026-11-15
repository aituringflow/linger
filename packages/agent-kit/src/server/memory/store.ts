/**
 * agent-kit · 个人时空上下文存储（三张表）
 *
 * 表结构见 ../auth/schema.sql 末尾的「个人时空上下文 · 三张表」段：
 *   memory_records   原始记录（原文 + happened_at / captured_at）
 *   memory_entities  实体（含别名与消歧状态）
 *   memory_facts     事实（一句自足描述 + 涉及实体数组 + 有效区间 + 出处）
 *
 * 这一层不做抽取：把一句话拆成实体与事实由模型完成，本层负责落库、
 * 引用校验、消歧收敛、时间窗过滤与邻域展开。
 *
 * 检索模型（本文件的核心）
 * ------------------------
 * 实体与事实构成二部图：事实连着它提到的实体，实体连着提到它的事实。
 * 一次检索从种子实体出发，沿这张图逐跳展开：
 *
 *   种子实体 --第 0 跳--> 直接涉及它们的事实
 *            --第 1 跳--> 这些事实里新出现的实体 --> 涉及这些实体的事实
 *            --第 2 跳--> ...
 *
 * 只取第 0 跳会答不上"我在哪"这类问题：事实里往往只有同行者，没有地点，
 * 地点要经由同行者所在的机构、机构所在的城市，跳两三次才到达。展开必须设
 * 代数上限与事实预算，两跳通常够用，再多就是在读整个库。
 */
import type { Pool } from "pg";
import { getPool } from "../auth/db.js";
import { toRealArray, type MemoryEmbedder } from "./embedding.js";

export type EntityType = "person" | "org" | "location" | "thing" | "event";
export type EntityStatus = "confirmed" | "unresolved" | "pending_name" | "merged";
export type FactStatus = "confirmed" | "pending" | "disputed";

const ENTITY_TYPES: readonly EntityType[] = ["person", "org", "location", "thing", "event"];

export interface MemoryRecord {
  ownerSub: string;
  /** 自增整数，由数据库分配；没有语义，只做行标识。 */
  id: number;
  source: string;
  type: string;
  content: string;
  happenedAt: Date | null;
  capturedAt: Date;
  raw: Record<string, unknown>;
  fingerprint: string | null;
  createdAt: Date;
}

export interface MemoryEntity {
  ownerSub: string;
  id: number;
  type: EntityType;
  name: string;
  aliases: string[];
  meta: Record<string, unknown>;
  firstSeenAt: Date | null;
  status: EntityStatus;
  mergedInto: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * 带语义分数的实体，用于按查询向量挑种子实体。
 *
 * MemoryEntity 是读模型，刻意不含 embedding：向量只在库内参与打分，不跟着名字
 * 一起回进程。想知道有多少实体还没算向量，用 counts().entitiesWithoutVector。
 */
export interface ScoredEntity extends MemoryEntity {
  score: number;
}

export interface SearchEntityOptions {
  /** 调用方算好的查询向量；不传且注入了 embedder 时本地算。 */
  vector?: number[];
  /** 返回条数，默认 8。 */
  limit?: number;
  /** 是否包含已并入他人的旧壳（默认排除，种子应该是 canonical 实体）。 */
  includeMerged?: boolean;
}

export interface SearchEntityResult {
  mode: "vector" | "structured";
  entities: ScoredEntity[];
  /** 可参与打分的实体数 / 全部候选实体数。 */
  coverage: { withVector: number; total: number };
}

export interface MemoryFact {
  ownerSub: string;
  id: number;
  entityIds: number[];
  description: string;
  recordId: number;
  validFrom: Date | null;
  validTo: Date | null;
  status: FactStatus;
  confidence: number;
  createdAt: Date;
}

/** 展开时带上的跳数：0 = 直接涉及种子实体，n = 经 n 跳才被牵出来。 */
export interface FactHit extends MemoryFact {
  hop: number;
}

/** 写入类入参都不带 id：id 由数据库分配，从返回值里取。 */
export interface RecordInput {
  source: string;
  type: string;
  content: string;
  happenedAt?: string | Date | null;
  capturedAt?: string | Date | null;
  raw?: Record<string, unknown>;
  /** 同一份原文的指纹，用于跨来源去重（唯一索引 uq_memory_records_fingerprint）。 */
  fingerprint?: string | null;
}

export interface EntityInput {
  type: EntityType;
  name?: string;
  aliases?: string[];
  meta?: Record<string, unknown>;
  firstSeenAt?: string | Date | null;
  status?: EntityStatus;
  mergedInto?: number | null;
  /** 已经算好的实体向量；不传则由 embedPendingEntities() 批量补。 */
  embedding?: number[] | null;
}

export interface FactInput {
  entityIds: number[];
  description: string;
  recordId: number;
  validFrom?: string | Date | null;
  validTo?: string | Date | null;
  status?: FactStatus;
  confidence?: number;
  /** 已经算好的向量；不传则在使用方注入了 embedder 时自动计算。 */
  embedding?: number[] | null;
}

/** 时间窗；任一端为 null 表示该端取 ±无穷 */
export interface TimeWindow {
  from?: string | Date | null;
  to?: string | Date | null;
}

export interface ExpandOptions {
  /** 展开代数上限，默认 2；0 表示只取直接涉及种子实体的事实 */
  depth?: number;
  /** 本次最多带回多少条事实，默认 60 */
  budget?: number;
  window?: TimeWindow;
}

export interface Neighborhood {
  facts: FactHit[];
  entities: MemoryEntity[];
}

/** 带语义分数的命中。score 是余弦相似度（两侧都已 L2 归一化，等价于点积）。 */
export interface ScoredFact extends MemoryFact {
  score: number;
}

/** 展开后再按语义重排的命中：hop 说明它是怎么被牵进来的，score 说明它有多贴题。 */
export interface ScoredHit extends FactHit {
  score: number;
}

export interface SearchOptions {
  /** 只看落在该时间窗内的事实。 */
  window?: TimeWindow;
  /** 限定只搜涉及这些实体的事实（邻域展开的结果可以直接拿来当作用域）。 */
  entityIds?: number[];
  /** 返回条数，默认 20。 */
  limit?: number;
  /**
   * @deprecated 语义排序已下推到数据库，不再需要"先搬一批候选回进程"。
   *
   * 旧实现按 valid_from DESC 取最近 2000 条、把向量搬回应用层再算余弦：既慢
   * （2000×768 个 real 走 PG 数组文本协议约 16 MB），又让事实数超过 2000 后
   * 老事实永远进不了语义排序，越搜越漏且不报错。现在对全部符合过滤条件的事实
   * 在库内精确打分排序，零截断。保留字段只为兼容既有调用方，传入值会被忽略。
   */
  candidates?: number;
  /**
   * 已经算好的查询向量（调用方本地模型算的）。
   *
   * 服务端不一定装着推理环境：桌面端有 EmbeddingGemma，服务端只有数据库。
   * 给了向量就跳过本地的 embedQuery。向量必须来自同一个模型、同一个维度——
   * 不同模型的向量算出来的相似度没有意义，且不会报错；维度不一致时本次检索
   * 会如实退化为 structured，而不是拿部分点积假装排过序。
   */
  vector?: number[];
}

export interface SearchResult {
  /**
   * vector      = 真的用向量排了序
   * structured  = 没有查询向量，或参与打分的事实一条都没有，只按时间返回
   * 两种模式的 score 含义不同，调用方要据此决定是否把 score 当相关性展示。
   */
  mode: "vector" | "structured";
  facts: ScoredFact[];
  /** 符合结构过滤条件的事实里有多少条带向量。覆盖率低时要跑 embedPending() 补算。 */
  coverage: { withVector: number; total: number };
}

export interface RecallOptions extends ExpandOptions {
  /** 展开的种子实体：一次查询先解析出的候选实体。 */
  seeds: number[];
  /** 最终返回条数，默认 20。 */
  limit?: number;
  /** 与 SearchOptions.vector 同口径：调用方算好的查询向量，服务端可以不装推理环境。 */
  vector?: number[];
}

export interface MemoryStoreOptions {
  /** Optional host-owned trace sink; contains private memory data. */
  trace?: (event: Record<string, unknown>) => void;
  /**
   * 向量化实现。不传则该 store 只做结构化检索——服务端没有模型时就是这样，
   * 检索照常可用，只是没有语义排序。
   */
  embedder?: MemoryEmbedder | null;
}

type Row = Record<string, unknown>;

const toDate = (value: string | Date | null | undefined): Date | null =>
  value === null || value === undefined ? null : value instanceof Date ? value : new Date(value);

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const str = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

function rowToRecord(row: Row): MemoryRecord {
  return {
    ownerSub: str(row.owner_sub),
    id: num(row.id),
    source: str(row.source),
    type: str(row.type),
    content: str(row.content),
    happenedAt: (row.happened_at as Date | null) ?? null,
    capturedAt: row.captured_at as Date,
    raw: (row.raw as Record<string, unknown>) ?? {},
    fingerprint: (row.fingerprint as string | null) ?? null,
    createdAt: row.created_at as Date,
  };
}

const toId = (value: unknown): number => Number(value);
const toIdOrNull = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const toIdArray = (value: unknown): number[] =>
  Array.isArray(value) ? (value as unknown[]).map(Number) : [];

function rowToEntity(row: Row): MemoryEntity {
  return {
    ownerSub: str(row.owner_sub),
    id: num(row.id),
    type: str(row.type) as EntityType,
    name: str(row.name),
    aliases: Array.isArray(row.aliases) ? (row.aliases as string[]) : [],
    meta: (row.meta as Record<string, unknown>) ?? {},
    firstSeenAt: (row.first_seen_at as Date | null) ?? null,
    status: str(row.status) as EntityStatus,
    mergedInto: toIdOrNull(row.merged_into),
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

function rowToFact(row: Row): MemoryFact {
  return {
    ownerSub: str(row.owner_sub),
    id: num(row.id),
    entityIds: toIdArray(row.entity_ids),
    description: str(row.description),
    recordId: toId(row.record_id),
    validFrom: (row.valid_from as Date | null) ?? null,
    validTo: (row.valid_to as Date | null) ?? null,
    status: str(row.status) as FactStatus,
    confidence: num(row.confidence),
    createdAt: row.created_at as Date,
  };
}

/**
 * 实体没有 description 列，向量化的对象是「名字 + 别名 + 与它相关的事实」拼成的
 * 语义快照。只用名字不够：两个都叫「妈」的人向量几乎一样，消歧就失去依据；把各自
 * 出现的事实拼进来，王秀兰（转账 / 老家）和张桂芳（岳母 / 住院陪护）才会落到
 * 向量空间的不同位置。事实最多取最近 8 条，避免超出模型输入长度被静默截断。
 */
function entityDocument(row: Row): string {
  const aliases = Array.isArray(row.aliases)
    ? (row.aliases as string[]).filter(Boolean)
    : [];
  const label = str(row.name).trim() || aliases[0] || str(row.type);
  const parts = [`${label}（${str(row.type)}）`];
  if (aliases.length) parts.push(`别名：${aliases.join("、")}`);
  const descriptions = Array.isArray(row.descriptions)
    ? (row.descriptions as string[]).filter(Boolean)
    : [];
  if (descriptions.length) parts.push(`相关事实：${descriptions.join("；")}`);
  return parts.join("。");
}

/**
 * 读取实体时一律不取 embedding：向量只在库内参与打分，不该跟着名字一起回进程
 * （real[] 是文本协议，一行 768 维约 8 KB）。补名字这类调用不该为此付传输代价。
 */
const ENTITY_COLUMNS = `owner_sub, id, type, name, aliases, meta, first_seen_at,
                        status, merged_into, created_at, updated_at`;

/** 读事实时同样不取 embedding：expand() 每跳都会调 factsTouching，白搬向量很贵。 */
const FACT_READ_COLUMNS = `owner_sub, id, entity_ids, description, record_id, valid_from,
                           valid_to, status, confidence, created_at`;

/** 补算实体向量时要带出的列：相关子查询把该实体最近 8 条事实描述聚成数组。 */
const ENTITY_DOCUMENT_COLUMNS = `e.id, e.type, e.name, e.aliases,
  ARRAY(
    SELECT f.description
      FROM memory_facts f
     WHERE f.owner_sub = e.owner_sub AND e.id = ANY(f.entity_ids)
     ORDER BY COALESCE(f.valid_from, '-infinity') DESC, f.id DESC
     LIMIT 8
  ) AS descriptions`;

/**
 * 区间相交，NULL 视为无穷。
 *
 * 用闭区间 []，不用半开区间 [)。因为 valid_from = valid_to 表示"瞬时事件"
 * （一条消息、一次转账就发生在那一刻），半开区间下 [t, t) 是空集，与任何窗口
 * 都不相交——这类事实会在检索里彻底消失，而且不报错。
 * 代价是相邻区间在边界上算作重叠，对个人记忆库可以接受。
 *
 * 时间窗在两条查询里的参数序号不同，所以位置由调用方指定，而不是写死 $3/$4。
 */
const windowClause = (from: string, to: string): string => `
  tstzrange(COALESCE(valid_from, '-infinity'), COALESCE(valid_to, 'infinity'), '[]')
    && tstzrange(COALESCE(${from}::timestamptz, '-infinity'), COALESCE(${to}::timestamptz, 'infinity'), '[]')`;

// ---------------------------------------------------------------- 库内打分 SQL
//
// 语义排序下推到数据库：real[] 不需要任何扩展，点积在库内算完只回 topK 行。
// 旧版把 2000×768 个 real 当 PG 数组文本传回进程，单行约 8 KB、一次约 16 MB，
// 实测在这条链路上要 21s；库内算完只回 8 行是 0.02s。瓶颈从来不是余弦本身
// （JS 里 2000×768 只要 5~25 ms），是传输。

const FACT_COLUMNS = `f.id, f.entity_ids, f.description, f.record_id, f.valid_from,
                      f.valid_to, f.status, f.confidence, f.created_at`;

/**
 * 点积即余弦：写入前向量已做 L2 归一化（见 embedding.ts）。
 *
 * CASE 护栏不是可选的。unnest(a, b) 两个数组长度不等时 PG 会用 NULL 补齐，
 * sum 悄悄忽略 NULL，算出"前 N 维的部分点积"——分数看起来完全正常、排序却是
 * 错的，且不报任何错。所以维度不等的行必须显式给 NULL，不参与打分。
 * 参数为 NULL（结构化模式）时整列都是 NULL。
 */
const scoreColumn = (p: string, alias = "f"): string => `
  CASE WHEN ${p}::real[] IS NOT NULL
        AND ${alias}.embedding IS NOT NULL
        AND cardinality(${alias}.embedding) = cardinality(${p}::real[])
       THEN (SELECT sum(u.x * u.y) FROM unnest(${alias}.embedding, ${p}::real[]) AS u(x, y))
  END AS score`;

/**
 * 窗口函数在 LIMIT 之前计算，所以每一行都带着"全量符合条件"的统计：取回 8 行
 * 也能知道整个作用域的向量覆盖率。cov_scored 是真正能参与本次打分的行数（维度
 * 也要匹配），用来决定 mode，不对外暴露。
 */
const coverageColumns = (p: string, alias = "f"): string => `
  count(*) FILTER (WHERE ${alias}.embedding IS NOT NULL) OVER () AS cov_with_vector,
  count(*) FILTER (
    WHERE ${p}::real[] IS NOT NULL
      AND ${alias}.embedding IS NOT NULL
      AND cardinality(${alias}.embedding) = cardinality(${p}::real[])
  ) OVER () AS cov_scored,
  count(*) OVER () AS cov_total`;

/**
 * 建一个绑定到某个用户的读写器。所有语句都带 owner_sub，跨用户不可见。
 *
 * 传入 embedder 后，embedPending() 可补算向量、检索也能本地算查询向量；不传时
 * 仍可由调用方经 options.vector 传入查询向量做语义排序——服务端没有推理环境时
 * 就是这种常态。两处都拿不到向量才退化为 mode='structured'。
 */
export function createMemoryStore(ownerSub: string, options: MemoryStoreOptions = {}) {
  if (!ownerSub) throw new Error("[memory] ownerSub 不能为空");
  const owner = ownerSub;
  const embedder = options.embedder ?? null;
  const trace = (event: Record<string, unknown>) => {
    try { options.trace?.({ owner, ...event }); } catch { /* tracing must not affect writes */ }
  };

  function pool(): Pool {
    const p = getPool();
    if (!p) throw new Error("[memory] 未配置 Postgres（POSTGRES_HOST / POSTGRES_DB），无法读写记忆库。");
    return p;
  }

  // ---------------------------------------------------------------- 写入

  /**
   * 落一条原文。id 由数据库分配。
   *
   * 带 fingerprint 时按 (owner_sub, fingerprint) 幂等：同一份材料从两个渠道送来只落一行。
   * 不带 fingerprint 就是纯插入，重复导入由调用方控制（例如先 reset）。
   */
  async function addRecord(input: RecordInput): Promise<MemoryRecord> {
    const result = await pool().query(
      `INSERT INTO memory_records (owner_sub, source, type, content, happened_at, captured_at, raw, fingerprint)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), COALESCE($6::timestamptz, now()), $7::jsonb, $8)
       ON CONFLICT (owner_sub, fingerprint) WHERE fingerprint IS NOT NULL DO UPDATE
         SET source = EXCLUDED.source,
             type = EXCLUDED.type,
             content = EXCLUDED.content,
             happened_at = EXCLUDED.happened_at,
             captured_at = EXCLUDED.captured_at,
             raw = EXCLUDED.raw
       RETURNING *`,
      [
        owner,
        input.source,
        input.type,
        input.content,
        toDate(input.happenedAt),
        toDate(input.capturedAt),
        JSON.stringify(input.raw ?? {}),
        input.fingerprint ?? null,
      ],
    );
    const record = rowToRecord(result.rows[0] as Row);
    trace({ event: "record_stored", record });
    return record;
  }

  /**
   * 建一个实体。id 由数据库分配。
   *
   * 不按名字自动去重：同名可能对应不同的人，去重是消歧决策。调用方应先按别名查
   * （findEntitiesByAlias）再决定"复用还是新建"，把判断留在抽取层，不写在写入层猜。
   */
  async function addEntity(input: EntityInput): Promise<MemoryEntity> {
    if (!ENTITY_TYPES.includes(input.type)) throw new Error(`[memory] 未知实体类型：${input.type}`);
    const result = await pool().query(
      `INSERT INTO memory_entities (owner_sub, type, name, aliases, meta, first_seen_at, status, merged_into, embedding)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz, $7, $8, $9::real[])
       RETURNING ${ENTITY_COLUMNS}`,
      [
        owner,
        input.type,
        input.name ?? "",
        JSON.stringify(input.aliases ?? []),
        JSON.stringify(input.meta ?? {}),
        toDate(input.firstSeenAt),
        input.status ?? "confirmed",
        input.mergedInto ?? null,
        input.embedding ?? null,
      ],
    );
    const entity = rowToEntity(result.rows[0] as Row);
    trace({ event: "entity_stored", entity });
    return entity;
  }

  /**
   * 把一个实体并入另一个，落消歧结论。
   *
   * 保留旧行而不是删掉：历史事实的 entity_ids 里还引用着它，删了证据链就断。
   * 指向不存在的实体由复合外键拦下（会报 23503），不会留下悬空引用。
   */
  async function mergeEntity(
    fromId: number,
    intoId: number,
    meta: Record<string, unknown> = {},
  ): Promise<MemoryEntity> {
    if (fromId === intoId) throw new Error("[memory] 不能把实体并到它自己");
    const result = await pool().query(
      `UPDATE memory_entities
          SET status = 'merged', merged_into = $3, meta = meta || $4::jsonb, updated_at = now()
        WHERE owner_sub = $1 AND id = $2
        RETURNING ${ENTITY_COLUMNS}`,
      [owner, fromId, intoId, JSON.stringify(meta)],
    );
    if (!result.rowCount) throw new Error(`[memory] 实体不存在：${fromId}`);
    return rowToEntity(result.rows[0] as Row);
  }

  /**
   * 写一条事实。entity_ids 是数组，没有外键可以挡错，所以在这里校验：
   * 每个 id 必须存在且属于同一 owner。宁可写入失败，也不要留下指向别人的引用。
   *
   * 这里不顺手算向量。推理要几百毫秒，写在写入路径上会把接口拖慢；向量是可重建的
   * 派生数据，交给 embedPending() 批量补，写入只负责落文本。
   */
  async function addFact(input: FactInput): Promise<MemoryFact> {
    const entityIds = [...new Set(input.entityIds.filter(Boolean))];
    if (entityIds.length === 0) throw new Error("[memory] 事实至少要涉及一个实体");
    const description = input.description.trim();
    if (!description) throw new Error("[memory] 事实描述不能为空");

    const existing = await pool().query(
      `SELECT id FROM memory_entities WHERE owner_sub = $1 AND id = ANY($2::int[])`,
      [owner, entityIds],
    );
    const known = new Set(existing.rows.map((row) => num((row as Row).id)));
    const missing = entityIds.filter((id) => !known.has(id));
    if (missing.length) throw new Error(`[memory] 事实引用了不存在的实体：${missing.join(", ")}`);

    const result = await pool().query(
      `INSERT INTO memory_facts
         (owner_sub, entity_ids, description, record_id, valid_from, valid_to,
          status, confidence, embedding)
       VALUES ($1, $2::int[], $3, $4, $5::timestamptz, $6::timestamptz, $7, $8, $9::real[])
       RETURNING ${FACT_READ_COLUMNS}`,
      [
        owner,
        entityIds,
        description,
        input.recordId,
        toDate(input.validFrom),
        toDate(input.validTo),
        input.status ?? "confirmed",
        input.confidence ?? 1,
        input.embedding ?? null,
      ],
    );
    const fact = rowToFact(result.rows[0] as Row);
    trace({ event: "fact_stored", fact });
    return fact;
  }

  /**
   * 给还没有向量的事实补算（历史数据、后接的模型、换端之后都会遇到）。
   * 一次一批，返回已补条数与剩余条数，调用方可以循环到 remaining = 0。
   */
  async function embedPending(limit = 64): Promise<{ embedded: number; remaining: number }> {
    if (!embedder) throw new Error("[memory] 未注入向量化实现，无法补算向量");

    const pending = await pool().query(
      `SELECT id, description FROM memory_facts
        WHERE owner_sub = $1 AND embedding IS NULL
        ORDER BY COALESCE(valid_from, '-infinity') DESC, id
        LIMIT $2`,
      [owner, Math.max(1, limit)],
    );
    const rows = pending.rows as Row[];
    if (rows.length) {
      const vectors = await embedder.embedDocuments(rows.map((row) => str(row.description)));
      for (let i = 0; i < rows.length; i += 1) {
        const vector = vectors[i];
        if (!vector || vector.length !== embedder.dim) {
          throw new Error(
            `[memory] 向量维度不符：期望 ${embedder.dim}，得到 ${vector?.length ?? 0}`,
          );
        }
        await pool().query(
          `UPDATE memory_facts SET embedding = $3::real[] WHERE owner_sub = $1 AND id = $2`,
          [owner, num(rows[i].id), toRealArray(vector)],
        );
      }
    }

    const rest = await pool().query(
      `SELECT count(*)::int AS n FROM memory_facts WHERE owner_sub = $1 AND embedding IS NULL`,
      [owner],
    );
    return { embedded: rows.length, remaining: num((rest.rows[0] as Row).n) };
  }

  /** 实体向量补算的公共落库段：文档侧前缀、维度校验、逐行写回。 */
  async function embedEntityBatch(rows: Row[]): Promise<void> {
    const model = embedder;
    if (!model) throw new Error("[memory] 未注入向量化实现，无法补算实体向量");
    if (rows.length === 0) return;
    const vectors = await model.embedDocuments(rows.map(entityDocument));
    for (let i = 0; i < rows.length; i += 1) {
      const vector = vectors[i];
      if (!vector || vector.length !== model.dim) {
        throw new Error(
          `[memory] 实体向量维度不符：期望 ${model.dim}，得到 ${vector?.length ?? 0}`,
        );
      }
      await pool().query(
        `UPDATE memory_entities SET embedding = $3::real[] WHERE owner_sub = $1 AND id = $2`,
        [owner, num(rows[i].id), toRealArray(vector)],
      );
    }
  }

  /**
   * 给还没有向量的实体补算。和 embedPending() 分开而不合并，是因为两者的
   * remaining 终止条件不同——塞进同一个返回值会让 seed 脚本的循环判断失准。
   */
  async function embedPendingEntities(limit = 64): Promise<{ embedded: number; remaining: number }> {
    if (!embedder) throw new Error("[memory] 未注入向量化实现，无法补算实体向量");
    const pending = await pool().query(
      `SELECT ${ENTITY_DOCUMENT_COLUMNS}
         FROM memory_entities e
        WHERE e.owner_sub = $1 AND e.embedding IS NULL
        ORDER BY e.id
        LIMIT $2`,
      [owner, Math.max(1, limit)],
    );
    const rows = pending.rows as Row[];
    await embedEntityBatch(rows);
    const rest = await pool().query(
      `SELECT count(*)::int AS n FROM memory_entities WHERE owner_sub = $1 AND embedding IS NULL`,
      [owner],
    );
    return { embedded: rows.length, remaining: num((rest.rows[0] as Row).n) };
  }

  /**
   * 实体向量是事实的语义快照，事实增删改后不会自动变。抽完一轮新事实、或做了
   * 消歧合并之后显式刷新：不传 ids 重算全部，传了只重算指定实体。
   */
  async function refreshEntityEmbeddings(ids?: number[]): Promise<number> {
    if (!embedder) throw new Error("[memory] 未注入向量化实现，无法刷新实体向量");
    const result = await pool().query(
      `SELECT ${ENTITY_DOCUMENT_COLUMNS}
         FROM memory_entities e
        WHERE e.owner_sub = $1
          AND ($2::int[] IS NULL OR e.id = ANY($2::int[]))
        ORDER BY e.id`,
      [owner, ids?.length ? ids : null],
    );
    const rows = result.rows as Row[];
    await embedEntityBatch(rows);
    return rows.length;
  }

  // ---------------------------------------------------------------- 实体

  /** 按别名精确命中（aliases @> ["..."]），包含已并入他人的旧实体，便于展示消歧过程。 */
  async function findEntitiesByAlias(alias: string): Promise<MemoryEntity[]> {
    const result = await pool().query(
      `SELECT ${ENTITY_COLUMNS} FROM memory_entities
        WHERE owner_sub = $1 AND aliases @> jsonb_build_array($2::text)
        ORDER BY created_at, id`,
      [owner, alias],
    );
    return result.rows.map((row) => rowToEntity(row as Row));
  }

  async function getEntity(id: number): Promise<MemoryEntity | null> {
    const result = await pool().query(
      `SELECT ${ENTITY_COLUMNS} FROM memory_entities WHERE owner_sub = $1 AND id = $2`,
      [owner, id],
    );
    return result.rowCount ? rowToEntity(result.rows[0] as Row) : null;
  }

  async function getEntities(ids: number[]): Promise<MemoryEntity[]> {
    if (ids.length === 0) return [];
    const result = await pool().query(
      `SELECT ${ENTITY_COLUMNS} FROM memory_entities WHERE owner_sub = $1 AND id = ANY($2::int[]) ORDER BY first_seen_at NULLS LAST, id`,
      [owner, ids],
    );
    return result.rows.map((row) => rowToEntity(row as Row));
  }

  /** 顺着 merged_into 走到最终实体（带环保护）。消歧后的引用一律用它收敛。 */
  async function canonicalEntity(id: number): Promise<MemoryEntity | null> {
    let current = await getEntity(id);
    const seen = new Set<number>();
    while (current && current.mergedInto && !seen.has(current.id)) {
      seen.add(current.id);
      const next: MemoryEntity | null = await getEntity(current.mergedInto);
      if (!next) break;
      current = next;
    }
    return current;
  }

  /** 别名 → 去重后的实体列表。同一称呼指向多个对象时，诚实地全部返回。 */
  async function resolveAlias(alias: string): Promise<{ hits: MemoryEntity[]; resolved: MemoryEntity[] }> {
    const hits = await findEntitiesByAlias(alias);
    const resolved: MemoryEntity[] = [];
    for (const hit of hits) {
      const canonical = await canonicalEntity(hit.id);
      if (canonical && !resolved.some((item) => item.id === canonical.id)) resolved.push(canonical);
    }
    return { hits, resolved };
  }

  /**
   * resolveAlias() 的语义版：别名是精确匹配，换个说法（「母亲」「岳母」「那家医院」）
   * 就一个都命中不了，后面整条图展开都无从起步。这里用实体快照向量在库内打分，
   * 拿 topK 当 recall() 的种子，专治「说法不在别名表里」。
   *
   * 打分同样下推到数据库、只回 topK；维度护栏与 search() 共用同一份 scoreColumn。
   * 默认排除已合并的旧壳，种子应该是 canonical 实体（它们的向量才是最新的）。
   */
  async function searchEntities(
    query: string,
    options: SearchEntityOptions = {},
  ): Promise<SearchEntityResult> {
    const text = query.trim();
    if (!text) throw new Error("[memory] 查询不能为空");
    const limit = Math.max(1, options.limit ?? 8);
    const vector = await queryVectorOf(text, options.vector);
    const orderBy = vector
      ? "score DESC NULLS LAST, e.id"
      : "COALESCE(e.first_seen_at, '-infinity') DESC, e.id";

    const result = await pool().query(
      `SELECT e.owner_sub, e.id, e.type, e.name, e.aliases, e.meta, e.first_seen_at,
              e.status, e.merged_into, e.created_at, e.updated_at,
              ${scoreColumn("$2", "e")}, ${coverageColumns("$2", "e")}
         FROM memory_entities e
        WHERE e.owner_sub = $1
          AND ($3::boolean OR e.status <> 'merged')
        ORDER BY ${orderBy}
        LIMIT $4`,
      [owner, vector, options.includeMerged ?? false, limit],
    );

    const rows = result.rows as Row[];
    const coverage = rows.length
      ? { withVector: num(rows[0].cov_with_vector), total: num(rows[0].cov_total) }
      : { withVector: 0, total: 0 };
    const mode: SearchEntityResult["mode"] =
      vector && (rows.length ? num(rows[0].cov_scored) : 0) > 0 ? "vector" : "structured";
    const hits = mode === "vector"
      ? rows.filter((row) => row.score !== null && row.score !== undefined)
      : rows;
    const entities: ScoredEntity[] = hits.slice(0, limit).map((row) => ({
      ...rowToEntity(row),
      score: mode === "vector" ? num(row.score) : 0,
    }));

    return { mode, entities, coverage };
  }

  async function getRecords(ids: number[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) return [];
    const result = await pool().query(
      `SELECT * FROM memory_records WHERE owner_sub = $1 AND id = ANY($2::int[]) ORDER BY happened_at NULLS LAST, id`,
      [owner, ids],
    );
    return result.rows.map((row) => rowToRecord(row as Row));
  }

  // ---------------------------------------------------------------- 检索

  /**
   * 取一批实体的"直接事实"：entity_ids 与这批实体相交，且落在时间窗内。
   * $2 = 目标实体，$3/$4 = 时间窗，$5 = 已取过的事实，$6 = 条数上限。
   */
  async function factsTouching(
    entityIds: number[],
    window: TimeWindow | undefined,
    excludeIds: number[],
    limit: number,
  ): Promise<MemoryFact[]> {
    if (entityIds.length === 0 || limit <= 0) return [];
    const result = await pool().query(
      `SELECT ${FACT_READ_COLUMNS} FROM memory_facts
        WHERE owner_sub = $1
          AND entity_ids && $2::int[]
          AND NOT (id = ANY($5::int[]))
          AND ${windowClause("$3", "$4")}
        ORDER BY COALESCE(valid_from, '-infinity') DESC, id
        LIMIT $6`,
      [owner, entityIds, toDate(window?.from), toDate(window?.to), excludeIds, limit],
    );
    return result.rows.map((row) => rowToFact(row as Row));
  }

  /**
   * 邻域展开：从种子实体出发，逐跳把"事实里新出现的实体"加入前沿，直到代数或预算用尽。
   *
   * 返回的 facts 带 hop：0 是直接命中，越大越外围。排序按 hop 升序、时间降序，
   * 调用方可以据此做截断（例如只把 hop<=1 交给模型），或按 hop 折算权重再和
   * 向量相似度合并排序。
   *
   * 注意两件事：
   * - 度数极高的实体（例如库里那个"本人"）会把它连的一切拉进来，靠 budget 兜住；
   *   真到了百万级事实，要在前沿上加快照/热度裁剪，而不是把代数调大。
   * - 同一个实体在种子集合里出现时不重复展开（visited 去重）。
   */
  async function expand(seedEntityIds: number[], options: ExpandOptions = {}): Promise<Neighborhood> {
    const depth = Math.max(0, options.depth ?? 2);
    const budget = Math.max(1, options.budget ?? 60);
    const seeds = [...new Set(seedEntityIds.filter(Boolean))];
    if (seeds.length === 0) return { facts: [], entities: [] };

    const collected = new Map<number, FactHit>();
    const visited = new Set<number>(seeds);
    let frontier = seeds;

    for (let hop = 0; hop <= depth && frontier.length > 0 && collected.size < budget; hop += 1) {
      const rows = await factsTouching(frontier, options.window, [...collected.keys()], budget - collected.size);
      if (rows.length === 0) break;
      const next: number[] = [];
      for (const fact of rows) {
        collected.set(fact.id, { ...fact, hop });
        for (const id of fact.entityIds) {
          if (visited.has(id)) continue;
          visited.add(id);
          next.push(id);
        }
      }
      frontier = [...new Set(next)];
    }

    const facts = [...collected.values()].sort((a, b) => {
      if (a.hop !== b.hop) return a.hop - b.hop;
      return (b.validFrom?.getTime() ?? -Infinity) - (a.validFrom?.getTime() ?? -Infinity);
    });
    const entities = await getEntities([...new Set(facts.flatMap((fact) => fact.entityIds))]);
    return { facts, entities };
  }

  /**
   * 语义检索：结构过滤 + 库内点积排序，只把 topK 行取回来。
   *
   * 顺序仍是"先过滤再打分"，但过滤只有 owner / 实体 / 时间窗，不再有按时间截断
   * 的候选池。旧实现先取最近 2000 条再排序，事实超过 2000 条后老事实被永久挡在
   * 语义排序之外——而且不报错，只是越搜越漏。现在对全部符合过滤条件的事实在库内
   * 精确打分，零截断。精确排序是 O(N×768)：实测 2000 条约 0.2s，N 到十万级会撞上
   * db.ts 的 15s statement_timeout，那时才该上 pgvector + HNSW，且带 WHERE 的
   * ANN 要开 iterative_scan，否则过滤条件会重新把召回切掉。
   */
  async function search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const text = query.trim();
    if (!text) throw new Error("[memory] 查询不能为空");

    const limit = Math.max(1, options.limit ?? 20);
    const scope = (options.entityIds ?? []).filter(Boolean);
    const vector = await queryVectorOf(text, options.vector);
    // 没有查询向量时按时间返回；有时按库内 score，NULL（无向量/维度不符）垫底。
    const orderBy = vector
      ? "score DESC NULLS LAST, f.id"
      : "COALESCE(f.valid_from, '-infinity') DESC, f.id";

    const result = await pool().query(
      `SELECT ${FACT_COLUMNS}, ${scoreColumn("$5")}, ${coverageColumns("$5")}
         FROM memory_facts f
        WHERE f.owner_sub = $1
          AND ($2::int[] IS NULL OR f.entity_ids && $2::int[])
          AND ${windowClause("$3", "$4")}
        ORDER BY ${orderBy}
        LIMIT $6`,
      [
        owner,
        scope.length ? scope : null,
        toDate(options.window?.from),
        toDate(options.window?.to),
        vector,
        limit,
      ],
    );

    const rows = result.rows as Row[];
    // 结果为空时窗口列无从读取；空作用域的覆盖率就是 0/0。
    const coverage = rows.length
      ? { withVector: num(rows[0].cov_with_vector), total: num(rows[0].cov_total) }
      : { withVector: 0, total: 0 };
    const mode: SearchResult["mode"] =
      vector && (rows.length ? num(rows[0].cov_scored) : 0) > 0 ? "vector" : "structured";

    // vector 模式下无向量 / 维度不符的行 score 为 NULL，排在末尾，不应混进结果。
    const hits = mode === "vector"
      ? rows.filter((row) => row.score !== null && row.score !== undefined)
      : rows;
    const facts: ScoredFact[] = hits.slice(0, limit).map((row) => ({
      ...rowToFact(row),
      score: mode === "vector" ? num(row.score) : 0,
    }));

    return { mode, facts, coverage };
  }

  /**
   * 展开 + 语义重排：先用种子实体沿二部图捞邻域（结构化召回，负责"不漏"），
   * 再用查询向量给邻域打分（负责"排序"）。
   *
   * 这两件事解决的是不同问题，缺一个都不行：只展开不排序，最相关的事实可能
   * 被预算截断在末尾；只排序不展开，问"我在哪"时地点根本不在候选里——事实里
   * 往往只有同行者，地点要顺机构所在的城市跳两跳才到。
   *
   * 打分同样在库内完成：邻域最多 budget 条（默认 60），这里只回 id + 分数，
   * 不把向量搬回进程。与 search() 共用同一份维度护栏，避免两处逻辑漂移。
   */
  async function recall(
    query: string,
    options: RecallOptions,
  ): Promise<{ mode: SearchResult["mode"]; facts: ScoredHit[]; entities: MemoryEntity[]; coverage: SearchResult["coverage"] }> {
    const text = query.trim();
    if (!text) throw new Error("[memory] 查询不能为空");
    const limit = Math.max(1, options.limit ?? 20);

    const neighborhood = await expand(options.seeds, {
      depth: options.depth,
      budget: options.budget,
      window: options.window,
    });
    if (neighborhood.facts.length === 0) {
      return { mode: "structured", facts: [], entities: [], coverage: { withVector: 0, total: 0 } };
    }

    const vector = await queryVectorOf(text, options.vector);
    const vectorRows = await pool().query(
      `SELECT f.id, ${scoreColumn("$3")}
         FROM memory_facts f
        WHERE f.owner_sub = $1
          AND f.id = ANY($2::int[])
          AND f.embedding IS NOT NULL
          AND ($3::real[] IS NULL OR cardinality(f.embedding) = cardinality($3::real[]))`,
      [owner, neighborhood.facts.map((fact) => fact.id), vector],
    );

    // null 表示"这条带向量但没参与打分"；structured 模式下所有值都是 null。
    const scoreById = new Map<number, number | null>();
    for (const row of vectorRows.rows as Row[]) {
      scoreById.set(
        num(row.id),
        row.score === null || row.score === undefined ? null : num(row.score),
      );
    }
    const coverage = { withVector: scoreById.size, total: neighborhood.facts.length };
    const scored = [...scoreById.values()].filter((score) => score !== null).length;
    const mode: SearchResult["mode"] = vector && scored > 0 ? "vector" : "structured";

    if (mode === "structured") {
      return {
        mode,
        facts: neighborhood.facts.slice(0, limit).map((fact) => ({ ...fact, score: 0 })),
        entities: neighborhood.entities,
        coverage,
      };
    }

    // 稳定排序：同分时保留展开阶段的 hop 升序、时间降序，无向量的命中自然排在后面。
    const facts = neighborhood.facts
      .map((fact) => ({ ...fact, score: scoreById.get(fact.id) ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return { mode, facts, entities: neighborhood.entities, coverage };
  }

  /**
   * 查询向量统一在这里摊平成 pg 的 real[] 参数并校验维度，避免两个入口各自漏校验。
   * 服务端通常不注入 embedder（没有推理环境），拿不到向量就返回 null，由检索方
   * 如实退化成结构化模式，而不是报错或假装排过序。
   */
  async function queryVectorOf(text: string, supplied?: number[]): Promise<number[] | null> {
    if (supplied?.length) return toRealArray(supplied);
    if (!embedder) return null;
    const vector = await embedder.embedQuery(text);
    if (vector.length !== embedder.dim) {
      throw new Error(`[memory] 查询向量维度不符：期望 ${embedder.dim}，得到 ${vector.length}`);
    }
    return toRealArray(vector);
  }

  /** 整张二部图（实体 + 事实）。个人库体量小，一次取回即可；大库再分页。 */
  async function graph(): Promise<{ entities: MemoryEntity[]; facts: MemoryFact[] }> {
    const [entities, facts] = await Promise.all([
      pool().query(`SELECT ${ENTITY_COLUMNS} FROM memory_entities WHERE owner_sub = $1 ORDER BY first_seen_at NULLS LAST, id`, [owner]),
      pool().query(
        `SELECT ${FACT_READ_COLUMNS} FROM memory_facts WHERE owner_sub = $1 ORDER BY COALESCE(valid_from, '-infinity'), id`,
        [owner],
      ),
    ]);
    return {
      entities: entities.rows.map((row) => rowToEntity(row as Row)),
      facts: facts.rows.map((row) => rowToFact(row as Row)),
    };
  }

  /** 清空本用户的全部数据（测试/重放用）。按 事实 → 记录 → 实体 顺序删，避开外键。 */
  async function reset(): Promise<void> {
    const p = pool();
    await p.query(`DELETE FROM memory_facts WHERE owner_sub = $1`, [owner]);
    await p.query(`DELETE FROM memory_records WHERE owner_sub = $1`, [owner]);
    await p.query(`DELETE FROM memory_entities WHERE owner_sub = $1`, [owner]);
  }

  async function counts(): Promise<{
    records: number;
    entities: number;
    facts: number;
    factsWithoutVector: number;
    entitiesWithoutVector: number;
  }> {
    const result = await pool().query(
      `SELECT (SELECT count(*) FROM memory_records WHERE owner_sub = $1)::int AS records,
              (SELECT count(*) FROM memory_entities WHERE owner_sub = $1)::int AS entities,
              (SELECT count(*) FROM memory_facts WHERE owner_sub = $1)::int AS facts,
              (SELECT count(*) FROM memory_facts WHERE owner_sub = $1 AND embedding IS NULL)::int AS bare,
              (SELECT count(*) FROM memory_entities WHERE owner_sub = $1 AND embedding IS NULL)::int AS bare_entities`,
      [owner],
    );
    const row = result.rows[0] as Row;
    return {
      records: num(row.records),
      entities: num(row.entities),
      facts: num(row.facts),
      factsWithoutVector: num(row.bare),
      entitiesWithoutVector: num(row.bare_entities),
    };
  }

  return {
    ownerSub: owner,
    addRecord,
    addEntity,
    mergeEntity,
    addFact,
    embedPending,
    embedPendingEntities,
    refreshEntityEmbeddings,
    findEntitiesByAlias,
    getEntity,
    getEntities,
    canonicalEntity,
    resolveAlias,
    searchEntities,
    getRecords,
    factsTouching,
    expand,
    search,
    recall,
    graph,
    counts,
    reset,
  };
}

export type MemoryStore = ReturnType<typeof createMemoryStore>;
