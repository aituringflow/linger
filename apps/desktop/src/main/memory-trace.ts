/** Local JSONL traces for memory storage and retrieval. Events may contain
 * private source text and are retained locally under the supplied log root.
 */

import fs from "node:fs";
import path from "node:path";

export type MemoryTrace = (event: Record<string, unknown>) => void;

function dayStamp(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function createMemoryTrace(logRoot: string, kind: "store" | "retrieval" = "retrieval"): MemoryTrace {
  const logDir = path.join(logRoot, "memory");
  let ready: Promise<void> | null = null;
  // 串行写，避免同一毫秒的几十条事件互相覆盖（appendFile 并发下顺序不保证）。
  let queue: Promise<void> = Promise.resolve();

  const ensureDir = () => {
    if (!ready) ready = fs.promises.mkdir(logDir, { recursive: true, mode: 0o700 }).then(() => undefined).catch(() => undefined);
    return ready;
  };

  return (event) => {
    let line: string;
    try {
      line = JSON.stringify({ t: new Date().toISOString(), ...event }) + "\n";
    } catch {
      return; // 有循环引用之类的问题就算了，日志不能反过来影响召回
    }
    queue = queue
      .then(ensureDir)
      .then(() => fs.promises.appendFile(path.join(logDir, `${kind}-${dayStamp()}.jsonl`), line, { encoding: "utf8", mode: 0o600 }))
      .catch(() => { /* 写不进去也绝不影响对话 */ });
  };
}
