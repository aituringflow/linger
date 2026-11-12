import { Worker } from "node:worker_threads";

// A native model runtime failure must not bring down the Launcher process.
// Keep the existing manager/runtime worker topology inside this child process.
const userDataDir = process.argv[2];
if (!userDataDir || !process.send) throw new Error("知识库进程启动参数无效");
const worker = new Worker(new URL("./knowledge-worker.js", import.meta.url), { workerData: { userDataDir } });
worker.on("message", message => { if (process.connected) process.send?.(message); });
worker.on("error", error => { console.error("[kb-host] 知识库 worker 失败：", error); process.exitCode = 1; void worker.terminate().finally(() => process.exit(1)); });
worker.on("exit", code => { process.exit(code || 1); });
process.on("message", message => worker.postMessage(message));
process.on("disconnect", () => { void worker.terminate().finally(() => process.exit(0)); });
