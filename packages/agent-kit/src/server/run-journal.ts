/** A run survives a lost HTTP reader. The run id is an idempotency key, and
 * numbered SSE frames let a new reader resume without replaying tool events. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appHomePath, declaredAppName } from "./app-home.js";

export type RunStatus = "running" | "completed" | "failed" | "cancelled";
type RunState = { sessionId: string; runId: string; status: RunStatus; updatedAt: number; error?: string };
type ActiveRun = { abort: AbortController; heartbeat: ReturnType<typeof setInterval> };

const encoder = new TextEncoder();
const active = new Map<string, ActiveRun>();
const STALE_MS = 45_000;
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

function pruneOldJournals(root: string): void {
  if (Date.now() - lastPruneAt < 24 * 60 * 60 * 1000) return;
  lastPruneAt = Date.now();
  void (async () => {
    for (const bucket of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!bucket.isDirectory()) continue;
      for (const entry of await fs.readdir(path.join(root, bucket.name), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || active.has(entry.name)) continue;
        const dir = path.join(root, bucket.name, entry.name);
        try {
          const state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")) as RunState;
          if (state.status !== "running" && Date.now() - state.updatedAt > RETAIN_MS) {
            await fs.rm(dir, { recursive: true, force: true });
          }
        } catch { /* ignore incomplete journals */ }
      }
    }
  })().catch((error) => console.warn("[agent-kit] journal pruning failed:", error));
}

export function validRunId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function paths(sessionId: string, runId: string) {
  const key = createHash("sha256").update(`${sessionId}\0${runId}`).digest("hex");
  // 任务事件日志属于「本机临时数据」：app 层声明了名字就进应用主目录（~/.<name>/run-journal），
  // 未声明时沿用共享的 ~/.agent-kit/run-journal（多进程 web 部署可继续用 env 指定共享目录）。
  const root = process.env.AGENT_KIT_RUN_JOURNAL_ROOT
    || (declaredAppName() ? appHomePath("run-journal") : path.join(os.homedir(), ".agent-kit", "run-journal"));
  const dir = path.join(root, key.slice(0, 2), key);
  return { key, dir, state: path.join(dir, "state.json"), events: path.join(dir, "events.ndjson") };
}

async function readState(sessionId: string, runId: string): Promise<RunState | null> {
  try {
    const value = JSON.parse(await fs.readFile(paths(sessionId, runId).state, "utf8")) as RunState;
    return value.sessionId === sessionId && value.runId === runId ? value : null;
  } catch { return null; }
}

async function writeState(file: string, value: RunState): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  // Windows 上 rename 覆盖已存在文件需要目标句柄允许 FILE_SHARE_DELETE；
  // 同进程的 SSE 读者每 250ms 用 readFile 打开 state.json（不含 delete 共享），
  // 或外部进程/索引器短暂持有时会触发 EPERM/共享冲突。锁通常只持几毫秒，
  // 退避重试即可成功，避免心跳因此失败。
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 5 && (code === "EPERM" || code === "EBUSY")) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        continue;
      }
      await fs.rm(temporary, { force: true }).catch(() => {}); // 避免 tmp 文件泄漏
      throw error;
    }
  }
}

async function appendFrame(eventsFile: string, seq: number, frame: string): Promise<void> {
  await fs.appendFile(eventsFile, `${JSON.stringify({ seq, frame })}\n`, { mode: 0o600 });
}

async function recoverStale(sessionId: string, runId: string, state: RunState): Promise<RunState> {
  const p = paths(sessionId, runId);
  if (state.status !== "running" || active.has(p.key) || Date.now() - state.updatedAt < STALE_MS) return state;
  // Never restart an uncertain run: it may have already changed files or sent a tool call.
  const lock = path.join(p.dir, "recovery.lock");
  try {
    const handle = await fs.open(lock, "wx", 0o600);
    await handle.close();
  } catch { return (await readState(sessionId, runId)) ?? state; }
  const latest = (await readState(sessionId, runId)) ?? state;
  if (latest.status !== "running" || Date.now() - latest.updatedAt < STALE_MS) return latest;
  const error = "任务执行进程已中断，执行结果无法确认。请检查已有内容和产物后手动重试。";
  const raw = await fs.readFile(p.events, "utf8").catch(() => "");
  const seq = raw.trim() ? raw.trim().split("\n").length + 1 : 1;
  await appendFrame(p.events, seq, `event: error\ndata: ${JSON.stringify({ text: error })}`);
  const failed: RunState = { ...latest, status: "failed", updatedAt: Date.now(), error };
  await writeState(p.state, failed);
  return failed;
}

export async function hasResumableRun(sessionId: string, runId: string): Promise<boolean> {
  return (await readState(sessionId, runId)) !== null;
}

export async function attachResumableRun(sessionId: string, runId: string, after = 0): Promise<Response> {
  const p = paths(sessionId, runId);
  if (!await readState(sessionId, runId)) return Response.json({ error: "run_not_found" }, { status: 404 });
  let stopped = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let offset = 0;
      let remainder = "";
      let errored = false;
      let emptyTerminalReads = 0;
      const decoder = new TextDecoder();
      try {
        while (!stopped) {
          const current = await readState(sessionId, runId);
          if (!current) throw new Error("任务记录已丢失");
          const state = await recoverStale(sessionId, runId, current);
          const file = await fs.open(p.events, "r").catch(() => null);
          if (file) {
            try {
              const { size } = await file.stat();
              while (size > offset) {
                const bytes = Buffer.alloc(Math.min(size - offset, 64 * 1024));
                const { bytesRead } = await file.read(bytes, 0, bytes.length, offset);
                if (!bytesRead) break;
                offset += bytesRead;
                const lines = (remainder + decoder.decode(bytes.subarray(0, bytesRead), { stream: true })).split("\n");
                remainder = lines.pop() ?? "";
                for (const line of lines) {
                  if (!line) continue;
                  const item = JSON.parse(line) as { seq: number; frame: string };
                  if (item.seq > after) controller.enqueue(encoder.encode(`id: ${item.seq}\n${item.frame}\n\n`));
                }
              }
            } finally { await file.close(); }
          }
          if (state.status !== "running") {
            if (offset > 0 || ++emptyTerminalReads >= 4) break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } catch (error) {
        if (!stopped) { errored = true; controller.error(error); }
      } finally {
        if (!stopped && !errored) controller.close();
      }
    },
    cancel() { stopped = true; },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

export async function startResumableRun(
  sessionId: string,
  runId: string,
  createStream: (signal: AbortSignal) => ReadableStream<Uint8Array>,
): Promise<Response> {
  const p = paths(sessionId, runId);
  pruneOldJournals(path.dirname(path.dirname(p.dir)));
  await fs.mkdir(p.dir, { recursive: true, mode: 0o700 });
  const initial: RunState = { sessionId, runId, status: "running", updatedAt: Date.now() };
  try {
    await fs.writeFile(p.state, JSON.stringify(initial), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return attachResumableRun(sessionId, runId);
  }
  await fs.writeFile(p.events, "", { flag: "wx", mode: 0o600 });
  const abort = new AbortController();
  let heartbeatWrite = Promise.resolve();
  const heartbeat = setInterval(() => {
    void fs.access(path.join(p.dir, "cancel")).then(() => abort.abort()).catch(() => {});
    heartbeatWrite = heartbeatWrite.then(() => writeState(p.state, { ...initial, updatedAt: Date.now() }))
      .catch((error) => console.error("[agent-kit] run heartbeat failed:", error));
  }, 5_000);
  active.set(p.key, { abort, heartbeat });
  void (async () => {
    let seq = 0;
    let buffer = "";
    let terminal: RunStatus | null = null;
    let failure = "";
    try {
      if (await fs.access(path.join(p.dir, "cancel")).then(() => true).catch(() => false)) abort.abort();
      if (abort.signal.aborted) { terminal = "cancelled"; return; }
      const reader = createStream(abort.signal).getReader();
      try {
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (!frame.trim()) continue;
            const kind = frame.match(/^event: (.+)$/m)?.[1];
            if (kind === "error") { terminal = "failed"; failure = frame.match(/^data: (.+)$/m)?.[1] ?? ""; }
            if (kind === "done" && terminal !== "failed") terminal = "completed";
            await appendFrame(p.events, ++seq, frame);
          }
        }
      } finally { reader.releaseLock(); }
      if (abort.signal.aborted) terminal = "cancelled";
      if (!terminal) {
        terminal = "failed";
        failure = "任务流意外结束，执行结果无法确认。";
        await appendFrame(p.events, ++seq, `event: error\ndata: ${JSON.stringify({ text: failure })}`);
      }
    } catch (error) {
      terminal = abort.signal.aborted ? "cancelled" : "failed";
      failure = error instanceof Error ? error.message : String(error);
      if (terminal === "failed") await appendFrame(p.events, ++seq, `event: error\ndata: ${JSON.stringify({ text: failure })}`).catch(() => {});
    } finally {
      clearInterval(heartbeat);
      active.delete(p.key);
      if (terminal === "cancelled") await appendFrame(p.events, ++seq, `event: cancelled\ndata: {}`).catch(() => {});
      await heartbeatWrite;
      await writeState(p.state, { ...initial, status: terminal ?? "failed", updatedAt: Date.now(), ...(failure ? { error: failure } : {}) });
    }
  })().catch((error) => console.error("[agent-kit] run journal finalization failed:", error));
  return attachResumableRun(sessionId, runId);
}

export async function cancelResumableRun(sessionId: string, runId: string): Promise<boolean> {
  const p = paths(sessionId, runId);
  const state = await readState(sessionId, runId);
  if (state && state.status !== "running") return false;
  await fs.mkdir(p.dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(p.dir, "cancel"), "", { mode: 0o600 });
  const run = active.get(p.key);
  if (run) run.abort.abort();
  if (!state) {
    try {
      const cancelled: RunState = { sessionId, runId, status: "cancelled", updatedAt: Date.now() };
      await fs.writeFile(p.state, JSON.stringify(cancelled), { flag: "wx", mode: 0o600 });
      await fs.writeFile(p.events, `${JSON.stringify({ seq: 1, frame: "event: cancelled\ndata: {}" })}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return true;
}
