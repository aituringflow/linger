import { verifySession } from "../auth/handlers.js";
import { loadAuthConfig } from "../auth/config.js";
import { createMemoryStore } from "./store.js";

/**
 * POST /api/memory/recall —— 给对话侧用的只读召回入口。
 *
 * 只做读取：不写入、不修改、不返回内部列（record_id / confidence / status）。
 * 与 /api/memories 那套显式记忆（用户主动保存的条目）是两回事，别混用。
 *
 * 查询向量由调用方算好带进来：服务端只有数据库，没有推理环境。拿不到向量时
 * 仍然放行，退化成按时间取候选——召回质量下降，但比让这一轮对话报错好。
 */
export function createMemoryRecallHandler() {
  const ownerOf = (request: Request) => verifySession(request, loadAuthConfig())?.sub;

  return {
    POST: async (request: Request) => {
      const startedAt = performance.now();
      const el = (from: number) => Math.round(performance.now() - from);

      const owner = ownerOf(request);
      if (!owner) return Response.json({ error: "未登录" }, { status: 401 });

      const body = await request.json().catch(() => ({})) as {
        query?: unknown;
        vector?: unknown;
        limit?: unknown;
      };
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) return Response.json({ error: "query 不能为空" }, { status: 400 });

      // 维度不对的向量直接丢掉：不同模型算出的向量做余弦不会报错，只会悄悄排错。
      const vector = Array.isArray(body.vector) && body.vector.length === 768 && body.vector.every((item) => typeof item === "number")
        ? body.vector as number[]
        : undefined;
      const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(Math.floor(body.limit), 50) : 8;

      const store = createMemoryStore(owner);
      const countsAt = performance.now();
      const counts = await store.counts();
      const countsMs = el(countsAt);
      if (counts.facts === 0) {
        return Response.json({
          mode: "structured",
          facts: [],
          coverage: { withVector: 0, total: 0 },
          timings: { countsMs, totalMs: el(startedAt) },
        });
      }

      const searchAt = performance.now();
      const result = await store.search(query, { vector, limit });
      const searchMs = el(searchAt);

      // 事实只存实体 id，这里补上名字：模型需要知道"这条讲的是谁"，
      // 不然一堆数字 id 对回答没有任何帮助。未消歧、还没有名字的实体不返回——
      // "#27" 这种占位对模型是纯噪音，不如让它只看到能读的部分。
      const entitiesAt = performance.now();
      const entityIds = [...new Set(result.facts.flatMap((fact) => fact.entityIds))];
      const entities = await store.getEntities(entityIds);
      const entitiesMs = el(entitiesAt);
      const records = await store.getRecords([...new Set(result.facts.map((fact) => fact.recordId))]);
      const recordById = new Map(records.map((record) => [record.id, record]));
      const nameById = new Map(
        entities.filter((entity) => entity.name.trim()).map((entity) => [entity.id, entity.name.trim()]),
      );

      return Response.json({
        mode: result.mode,
        coverage: result.coverage,
        // 服务端内部耗时：客户端只测得到往返，分不清是网络慢还是查库慢。
        timings: { countsMs, searchMs, entitiesMs, totalMs: el(startedAt) },
        facts: result.facts.map((fact) => ({
          id: fact.id,
          entityIds: fact.entityIds,
          entityDetails: fact.entityIds.map(id => entities.find(entity => entity.id === id)).filter((entity): entity is NonNullable<typeof entity> => Boolean(entity)).map(entity => ({ id: entity.id, name: entity.name, type: entity.type })),
          description: fact.description,
          validFrom: fact.validFrom,
          validTo: fact.validTo,
          score: Number(fact.score.toFixed(4)),
          status: fact.status,
          confidence: fact.confidence,
          source: (() => { const record = recordById.get(fact.recordId); return record ? { id: record.id, source: record.source, type: record.type, happenedAt: record.happenedAt } : null; })(),
          entities: [...new Set(fact.entityIds.map((id) => nameById.get(id)).filter((name): name is string => Boolean(name)))],
        })),
      }, { headers: { "Cache-Control": "no-store" } });
    },
  };
}
