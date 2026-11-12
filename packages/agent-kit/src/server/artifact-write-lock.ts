import { getPool } from "./auth/db.js";

/** Serialize file-manager mutations for one session across web workers sharing PostgreSQL. */
const localQueues = new Map<string, Promise<void>>();

export async function withArtifactWriteLock<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
  const pool = getPool();
  if (pool) {
    const client = await pool.connect();
    let transaction = false;
    try {
      await client.query("BEGIN");
      transaction = true;
      await client.query("SET LOCAL lock_timeout = '30s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('artifact-file-manager'), hashtext($1))", [sessionId]);
      const result = await work();
      await client.query("COMMIT");
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // Local/no-DB deployments still serialize requests from concurrent users in this process.
  const previous = localQueues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => current);
  localQueues.set(sessionId, tail);
  await previous.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (localQueues.get(sessionId) === tail) localQueues.delete(sessionId);
  }
}
