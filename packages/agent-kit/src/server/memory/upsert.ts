import { z } from "zod";
import { ensureMigrated, getAgentSession, getPool } from "../auth/db.js";
import { verifySession } from "../auth/handlers.js";
import { loadAuthConfig } from "../auth/config.js";

const inputSchema = z.object({
  operationId: z.string().uuid(),
  source: z.string().trim().min(1).max(10000),
  description: z.string().trim().min(1).max(4000),
  entityIds: z.array(z.number().int().positive()).max(20),
  newEntities: z.array(z.object({ name: z.string().trim().min(1).max(256), type: z.enum(["person", "org", "location", "thing", "event"]), aliases: z.array(z.string().trim().min(1).max(256)).max(20).optional(), embedding: z.array(z.number().finite()).length(768) })).max(20).default([]),
  replacesFactId: z.number().int().positive().optional(),
  expectedDescription: z.string().trim().min(1).max(4000).optional(),
  embedding: z.array(z.number().finite()).length(768),
  groupMessage: z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), messageId: z.number().int().positive() }).optional(),
}).refine(v => v.entityIds.length + v.newEntities.length > 0, "at least one entity is required").refine(v => Boolean(v.replacesFactId) === Boolean(v.expectedDescription), "replacement requires the original fact description");

/** Atomic, idempotent correction. Identity is scoped by the authenticated owner. */
export function createMemoryUpsertHandler() {
  return async (request: Request): Promise<Response> => {
    const owner = verifySession(request, loadAuthConfig())?.sub;
    if (!owner) return Response.json({ error: "未登录" }, { status: 401 });
    const input = inputSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ error: "Invalid memory upsert input" }, { status: 400 });
    const v = input.data;
    await ensureMigrated();
    const pool = getPool();
    if (!pool) return Response.json({ error: "Database unavailable" }, { status: 503 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize retries for this user and operation before inspecting the fingerprint.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [owner, v.operationId]);
      if (v.groupMessage) {
        // Never trust a renderer-supplied group message or use the group's owner as the personal owner.
        if (!await getAgentSession(owner, v.groupMessage.sessionId, client)) throw new Error("No access to group");
        const group = await client.query("SELECT 1 FROM agent_session_members WHERE session_id=$1 LIMIT 1", [v.groupMessage.sessionId]);
        if (!group.rowCount) throw new Error("Session is not a group");
        const original = await client.query("SELECT content, sender_sub FROM agent_messages WHERE session_id=$1 AND id=$2 AND role='user' AND revoked_at IS NULL AND id > COALESCE((SELECT deleted_through_id FROM agent_session_reads WHERE session_id=$1 AND user_sub=$3),0) FOR SHARE", [v.groupMessage.sessionId, v.groupMessage.messageId, owner]);
        if (!original.rowCount || original.rows[0].content !== v.source) throw new Error("Group message is unavailable or changed");
      }
      const fingerprint = `memory-upsert:${v.operationId}`;
      const existing = await client.query("SELECT id, raw FROM memory_records WHERE owner_sub=$1 AND fingerprint=$2", [owner, fingerprint]);
      if (existing.rowCount) {
        const prior = (existing.rows[0].raw as { result?: Record<string, unknown> } | null)?.result;
        if (!prior) {
          const legacy = await client.query("SELECT id, description, entity_ids, status FROM memory_facts WHERE owner_sub=$1 AND record_id=$2", [owner, existing.rows[0].id]);
          if (!legacy.rowCount) throw new Error("Previous operation result is no longer available");
          await client.query("COMMIT");
          return Response.json({ recordId: existing.rows[0].id, facts: legacy.rows, replayed: true });
        }
        await client.query("COMMIT");
        return Response.json({ ...prior, replayed: true });
      }
      const ids = [...new Set(v.entityIds)];
      const entities = await client.query("SELECT id FROM memory_entities WHERE owner_sub=$1 AND id=ANY($2::int[]) AND status <> 'merged'", [owner, ids]);
      if (entities.rowCount !== ids.length) throw new Error("Entity not found for current owner");
      for (const entity of v.newEntities) {
        const created = await client.query("INSERT INTO memory_entities (owner_sub,type,name,aliases,status,embedding) VALUES ($1,$2,$3,$4::jsonb,'unresolved',$5::real[]) RETURNING id", [owner, entity.type, entity.name, JSON.stringify([...new Set([entity.name, ...(entity.aliases ?? [])])]), entity.embedding]);
        ids.push(Number(created.rows[0].id));
      }
      if (v.replacesFactId) {
        const old = await client.query("SELECT description, status FROM memory_facts WHERE owner_sub=$1 AND id=$2 FOR UPDATE", [owner, v.replacesFactId]);
        if (!old.rowCount || old.rows[0].description !== v.expectedDescription) throw new Error("Original fact changed or is unavailable; search again");
      }
      const record = await client.query("INSERT INTO memory_records (owner_sub,source,type,content,raw,fingerprint) VALUES ($1,$5,$6,$2,$3::jsonb,$4) RETURNING id", [owner, v.source, JSON.stringify({ replacesFactId: v.replacesFactId ?? null, ...(v.groupMessage ? { groupMessage: v.groupMessage } : {}) }), fingerprint, v.groupMessage ? "group-chat" : "chat", v.groupMessage ? "group-extraction" : "explicit-upsert"]);
      let fact;
      if (v.replacesFactId) {
        // Preserve already-linked entities, valid period and the same fact identity.
        fact = await client.query(`UPDATE memory_facts SET description=$3,
          entity_ids=ARRAY(SELECT DISTINCT unnest(entity_ids || $4::int[])), record_id=$5,
          status='confirmed', confidence=1, embedding=$6::real[]
          WHERE owner_sub=$1 AND id=$2 RETURNING id,description,entity_ids,status`,
          [owner, v.replacesFactId, v.description, ids, record.rows[0].id, v.embedding]);
      } else {
        fact = await client.query("INSERT INTO memory_facts (owner_sub,entity_ids,description,record_id,status,confidence,embedding) VALUES ($1,$2::int[],$3,$4,'confirmed',1,$5::real[]) RETURNING id,description,entity_ids,status", [owner, ids, v.description, record.rows[0].id, v.embedding]);
      }
      const result = { recordId: record.rows[0].id, facts: fact.rows, createdEntities: v.newEntities.length, updatedFactId: v.replacesFactId ?? null };
      await client.query("UPDATE memory_records SET raw = raw || $3::jsonb WHERE owner_sub=$1 AND id=$2", [owner, record.rows[0].id, JSON.stringify({ result })]);
      await client.query("COMMIT");
      return Response.json({ ...result, replayed: false });
    } catch (error) {
      await client.query("ROLLBACK");
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
    } finally { client.release(); }
  };
}



