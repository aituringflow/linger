/**
 * 知识库全局设置（`~/.linger/knowledge/settings.json`）。
 *
 * 两项：图片识别用哪个框架的哪个模型；知识库窗口关闭后是否继续在后台索引。
 * 放在知识库根而不是单个库里 —— 这是全局能力选择，跟具体库无关，
 * 用户改一次就该对所有库生效。
 *
 * 读方有三处：主进程（设置界面）、runtime worker（image-describer 每次识图前读一次，
 * 所以保存后立刻生效，不需要重启索引器）、渲染层（决定窗口卸载时是否暂停索引）。
 */
import fs from "node:fs";
import path from "node:path";
import { APP_HOME_DIR } from "../app-name.js";

export type KnowledgeFramework = "codebuddy" | "codex";

export interface KnowledgeImageModel {
  framework: KnowledgeFramework;
  /** codebuddy: models.json / SDK 的模型 id；codex: `${vendor}::${id}` 或原生 id */
  model: string;
}

export interface KnowledgeSettings {
  imageModel?: KnowledgeImageModel;
  /**
   * 知识库窗口关闭后继续在后台索引。默认开启：
   * 首次导入几万张照片要跑很久，只有开着窗口才索引的话永远跑不完。
   */
  backgroundIndexing: boolean;
}

export const FRAMEWORK_LABELS: Record<KnowledgeFramework, string> = {
  codebuddy: "WorkBuddy",
  codex: "Codex",
};

export function knowledgeRoot(userDataDir?: string): string {
  return userDataDir?.trim() || path.join(APP_HOME_DIR, "knowledge");
}

function settingsFile(userDataDir?: string): string {
  return path.join(knowledgeRoot(userDataDir), "settings.json");
}

function normalize(input: unknown): KnowledgeSettings {
  const raw = (input ?? {}) as { imageModel?: unknown; backgroundIndexing?: unknown };
  const next: KnowledgeSettings = { backgroundIndexing: raw.backgroundIndexing !== false };
  const candidate = raw.imageModel as { framework?: unknown; model?: unknown } | undefined | null;
  if (!candidate || typeof candidate !== "object") return next;
  const framework = candidate.framework;
  const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
  if ((framework !== "codebuddy" && framework !== "codex") || !model) return next;
  next.imageModel = { framework, model };
  return next;
}

export function readKnowledgeSettings(userDataDir?: string): KnowledgeSettings {
  try {
    return normalize(JSON.parse(fs.readFileSync(settingsFile(userDataDir), "utf8")));
  } catch {
    // 不存在 / 损坏都按「没配」处理，让调用方回退默认模型
    return normalize(null);
  }
}

/** 原子写入；`patch.imageModel = null` 表示清除选择（回退默认模型）。 */
export function writeKnowledgeSettings(patch: unknown, userDataDir?: string): KnowledgeSettings {
  const current = readKnowledgeSettings(userDataDir);
  const incoming = (patch ?? {}) as { imageModel?: unknown; backgroundIndexing?: unknown };
  const next: KnowledgeSettings = { ...current };
  if ("imageModel" in incoming) {
    if (incoming.imageModel === null) delete next.imageModel;
    else {
      const normalized = normalize({ imageModel: incoming.imageModel });
      if (normalized.imageModel) next.imageModel = normalized.imageModel;
    }
  }
  if ("backgroundIndexing" in incoming) next.backgroundIndexing = incoming.backgroundIndexing !== false;
  const file = settingsFile(userDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  return next;
}
