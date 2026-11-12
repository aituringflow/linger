import fs from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// Native image decoding must not run in an Electron worker thread: a decoder
// crash would otherwise terminate the entire application.
const pending = new Map<string, Promise<string>>();
let active = 0;
const waiters: Array<() => void> = [];

export function ensureThumbnail(source: string, destination: string, kind: "image" | "pdf" = "image"): Promise<string> {
  const existing = pending.get(destination);
  if (existing) return existing;
  const job = (async () => {
    const sourceStat = await fs.stat(source);
    try {
      const cached = await fs.stat(destination);
      if (cached.size > 0 && cached.mtimeMs >= sourceStat.mtimeMs) return destination;
    } catch { /* Generate a missing thumbnail in an isolated process. */ }
    if (active >= 2) await new Promise<void>(resolve => waiters.push(resolve));
    else active++;
    try {
      return await new Promise<string>((resolve, reject) => {
        const child = fork(fileURLToPath(new URL("./knowledge-parser.js", import.meta.url)), [], {
          execPath: process.execPath,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        let finished = false;
        const timer = setTimeout(() => { child.kill(); finish(new Error("缩略图生成超时")); }, 60_000);
        const finish = (error?: Error, result?: string) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve(result!);
        };
        child.once("message", (message: { thumbnail?: string; error?: string }) => {
          if (message.error) finish(new Error(message.error));
          else if (message.thumbnail === destination) finish(undefined, destination);
          else finish(new Error("缩略图进程返回了无效结果"));
        });
        child.once("error", error => finish(error));
        child.once("exit", (code, signal) => finish(new Error(`缩略图进程退出（${signal ?? code}）`)));
        child.send({ path: source, thumbnailDestination: destination, thumbnailKind: kind }, error => { if (error) finish(error); });
      });
    } finally {
      const next = waiters.shift();
      if (next) next(); else active--;
    }
  })();
  pending.set(destination, job);
  void job.finally(() => pending.delete(destination)).catch(() => {});
  return job;
}
