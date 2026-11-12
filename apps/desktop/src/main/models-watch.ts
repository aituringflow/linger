/**
 * models.json 变更监视。
 *
 * 用户在应用运行期间手改 ~/.linger/models.json（比如 ollama pull 完新模型往里面加一条）时，
 * 输入框里的模型下拉不会自己更新——它来自启动时缓存的那一份。这里负责：
 *   1. 落盘记住「上次加载的 models.json 是哪个版本」（mtime + size 签名）；
 *   2. 轮询比对签名，发现变化就通知上层重新拉模型列表。
 */
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { modelsFileSignature, type ModelsFileSignature } from "@turingflow/agent-kit";

/** 落盘记录：上次「加载过」的 models.json 版本 */
export interface ModelsFileRecord {
  file: string | null;
  /** mtime + size 签名 */
  signature: string;
  /** models.json 自身的修改时间（毫秒），可直接用来展示「上次更新于」 */
  mtimeMs: number | null;
  /** 我们确认这个版本的时间（ISO 8601） */
  seenAt: string | null;
}

/** 2 秒一次 stat；文件很小，开销可忽略 */
const POLL_INTERVAL_MS = 2000;

function recordPath(): string {
  return path.join(app.getPath("userData"), "models-file-state.json");
}

/** 读上次记录；没有记录时（首次运行 / 记录损坏）返回 null */
export function readModelsFileRecord(): ModelsFileRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(recordPath(), "utf8")) as Partial<ModelsFileRecord>;
    if (typeof raw?.signature !== "string") return null;
    return {
      file: typeof raw.file === "string" ? raw.file : null,
      signature: raw.signature,
      mtimeMs: typeof raw.mtimeMs === "number" ? raw.mtimeMs : null,
      seenAt: typeof raw.seenAt === "string" ? raw.seenAt : null,
    };
  } catch {
    return null;
  }
}

function writeModelsFileRecord(state: ModelsFileSignature): void {
  const payload: ModelsFileRecord = { ...state, seenAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(recordPath()), { recursive: true });
    fs.writeFileSync(recordPath(), JSON.stringify(payload, null, 2));
  } catch (error) {
    console.warn("[launcher] 记录 models.json 状态失败：", error);
  }
}

/** 当前状态 + 上次记录，供 IPC 查询（设置页展示「上次更新于」） */
export function modelsFileStatus(): { current: ModelsFileSignature; record: ModelsFileRecord | null; changed: boolean } {
  const current = modelsFileSignature();
  const record = readModelsFileRecord();
  return { current, record, changed: Boolean(record) && record!.signature !== current.signature };
}

/**
 * 盯住 models.json，签名变化时回调一次。
 *
 * 用轮询而不是 fs.watch：编辑器保存普遍是「写临时文件再 rename」，
 * 文件级 watcher 会跟着 inode 一起失效；目录级 watcher 又要额外处理
 * 「目录不存在 / 目录被替换 / AGENT_MODELS_PATH 改指向」这几种情况。
 * 一次 statSync 只有微秒级开销，换来的是各平台一致的行为。
 */
export function watchModelsFile(onChange: (state: ModelsFileSignature) => void): () => void {
  // 启动即以当前版本为基线：此刻的模型列表本来就会按最新文件加载
  let last = modelsFileSignature();
  writeModelsFileRecord(last);

  const timer = setInterval(() => {
    const next = modelsFileSignature();
    if (next.signature === last.signature) return;
    last = next;
    writeModelsFileRecord(next);
    onChange(next);
  }, POLL_INTERVAL_MS);
  // 不要因为这个定时器拖住进程退出
  timer.unref?.();

  return () => clearInterval(timer);
}
