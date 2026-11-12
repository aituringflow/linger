import fs from "node:fs";
import path from "node:path";
import { appHomePath } from "./app-home.js";

/**
 * 应用可用 AGENT_MODELS_PATH 指定 models.json 文件或其所在目录，首个存在的文件即为唯一来源。
 * 未指定时读取应用主目录 `~/.<应用名>/models.json`（未声明应用名时为 `~/.agent/models.json`）。
 */
export function resolveModelsFile(): string | null {
  const specified = process.env.AGENT_MODELS_PATH?.trim();
  const candidates = [
    ...(specified ? [specified.endsWith(".json") ? specified : path.join(specified, "models.json")] : []),
    appHomePath("models.json"),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

export interface ModelsFileSignature {
  /** 命中的 models.json；没有任何候选文件时为 null */
  file: string | null;
  /** mtime + size 组成的签名，文件不存在或读不到为空串 */
  signature: string;
  mtimeMs: number | null;
}

/**
 * models.json 的变化签名，供宿主判断是否需要重新拉模型列表。
 * 只 stat 不读内容：轮询开销可以忽略，且足够覆盖用户手改配置文件这类编辑。
 * 用 mtime + size 而不是 hash：小文件被编辑器原子写时 mtime 一定变。
 */
export function modelsFileSignature(): ModelsFileSignature {
  const file = resolveModelsFile();
  if (!file) return { file: null, signature: "", mtimeMs: null };
  try {
    const stat = fs.statSync(file);
    return { file, signature: `${stat.mtimeMs}:${stat.size}`, mtimeMs: stat.mtimeMs };
  } catch {
    return { file, signature: "", mtimeMs: null };
  }
}
