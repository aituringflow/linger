/**
 * agent-kit · 产物（Artifact）管理
 *
 * 问题背景：模型用 Write 工具生成的 HTML / Markdown / 图片等「供用户查看的文件」，
 * 原来会落到任意磁盘位置（如 apps/web/），且模型常在回复里复述真实路径，
 * 既泄露服务器目录结构，前端也无法直接渲染。
 *
 * 文件存储采用「输入 / 输出」两个平级命名空间：
 *   <存储根>/uploads/<sessionId>/    用户上传的输入文件（AI 只读，用户删除/撤回时清理）
 *   <存储根>/artifacts/<sessionId>/  AI 产出的输出文件（AI 读写）
 *   <存储根>/.registry/              产物登记表（内部状态，不进入产物列表）
 * 存储根：用户主目录下的应用主目录（`~/.<AGENT_APP_NAME>`，未声明应用名时为 `~/.agent-files`），
 * 与工作区无关。
 * 选了本地项目时，交付文件由模型直接写进项目（用户指定位置，或模型按项目结构自定），
 * 模型在项目里写出的业务文件经登记/扫描成为产物，不复制进产物存储根，也绝不在项目里
 * 新建 output/ 之类的专用目录；只有中间草稿（_drafts）留在产物存储根里。
 *
 * 本模块提供：
 *   - 会话隔离目录：每个会话只能看到自己的产出；
 *   - 模型只接触虚拟路径 /agent-output/<sessionId>/...，真实目录永不进入模型上下文；
 *   - 产物登记表（registry）：模型按用户指示写到「任意位置」（如用户指定目录）的文件，
 *     在执行层登记真实路径后即成为本会话产物——原位置即产物，不复制、不搬移进存储根；
 *     用户未指定位置时仍默认落 artifacts/<sessionId>（见 buildArtifactPrompt）；
 *   - 基线/增量扫描：一轮对话后找出新文件，作为产物推给前端；
 *   - 安全读取：readArtifact 严格限制在 session 目录内与已登记的产物路径上，任何穿越尝试返回 null；
 *   - 脱敏：redactOutputPaths 抹掉模型可能复述的 /agent-output 标记。
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import JSZip from "jszip";
import { indexFile } from "./file-store.js";
import { getOwnerSubBySession } from "./auth/db.js";
import { declaredAppName } from "./app-home.js";

/** 输入（上传）命名空间目录名：<存储根>/uploads/<sessionId>/ */
export const UPLOADS_DIR_NAME = "uploads";
/** 输出（产物）命名空间目录名：<存储根>/artifacts/<sessionId>/ */
export const ARTIFACTS_DIR_NAME = "artifacts";

/** 真实磁盘存储根目录名（隐藏目录，统一放在用户主目录 ~ 下），靠 .gitignore 排除。
 * 解析顺序：
 *   1. env AGENT_ARTIFACT_DIR_NAME（显式指定优先）；
 *   2. 宿主声明的应用名（AGENT_APP_NAME）→ `.${应用名}`，与应用主目录同名；
 *   3. 未声明应用名 → `.agent-files`，与其他本机数据目录区分。
 * 必须是单级目录名，不能含路径分隔符（/ \）或取 "." / ".."，非法值按未指定处理。 */
export function getArtifactDirName(): string {
  const raw = process.env.AGENT_ARTIFACT_DIR_NAME?.trim();
  if (raw && raw.length > 0 && !/[\/\\]/.test(raw) && raw !== "." && raw !== "..") return raw;
  const appName = declaredAppName();
  if (appName) return `.${appName}`;
  return ".agent-files";
}
/** 模型上下文里的虚拟输出根：模型写文件用 /agent-output/<sessionId>/<name>（保持稳定，不改） */
export const ARTIFACT_VIRTUAL_ROOT = "/agent-output";

/** 存储根目录（真实磁盘位置，宿主侧）：统一放用户主目录 ~/<目录名>，与工作区无关 */
export function artifactRoot(): string {
  return path.join(os.homedir(), getArtifactDirName());
}

/** Uploads stay outside the CLI's per-session cwd until a chat message attaches them. */
export function uploadStorageDir(sessionId: string): string {
  return path.join(artifactRoot(), UPLOADS_DIR_NAME, sanitizeSessionId(sessionId));
}

/** 某会话的产物（输出）目录：<存储根>/artifacts/<sessionId>/。
 *  session id 统一按「基 id」归一（见 baseSessionId）：编辑重发/重新生成等 SDK 分叉
 *  transcript 不再产生分叉目录，产物始终归入同一会话目录；临时 run（快思考/复核/研究）
 *  保留自身目录（展示侧已按 TEMP_RUN_DIR_RE 过滤，不向用户展示）。 */
export function artifactSessionDir(sessionId: string, workspaceDir?: string): string {
  const s = isTempRunPath(sessionId) ? sessionId : baseSessionId(sessionId);
  return path.join(artifactRootFor(workspaceDir), ARTIFACTS_DIR_NAME, sanitizeSessionId(s));
}

/** 解析会话附件在磁盘上的真实路径：优先新路径 <root>/.uploads/<session>，
 * 回退旧路径 <root>/<session>/attachments（兼容历史消息与尚未迁移的文件）。 */
export async function resolveUploadPath(sessionId: string, name: string): Promise<string | null> {
  if (!name || name !== path.basename(name) || name.includes("\\")) return null;
  const candidates = [
    path.join(uploadStorageDir(sessionId), name),
  ];
  for (const candidate of candidates) {
    try {
      const info = await fs.stat(candidate);
      if (info.isFile()) return candidate;
    } catch { /* 继续尝试下一个候选路径 */ }
  }
  return null;
}

/** Move old uploads/staged copies out of the model-readable session directory. */
export async function quarantineLegacyUploads(sessionId: string): Promise<void> {
  const legacy = path.join(artifactRoot(), sessionId, "attachments");
  const entries = await fs.readdir(legacy, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (!entries.length) return;
  const privateDir = uploadStorageDir(sessionId);
  await fs.mkdir(privateDir, { recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const source = path.join(legacy, entry.name);
    const target = path.join(privateDir, entry.name);
    try { await fs.access(target); await fs.unlink(source); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.rename(source, target);
    }
  }
}

/** Remove only this session's model-readable attachment staging directory before a new turn. */
export async function clearSessionStagedAttachments(directory: string, sessionId: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("Invalid session id");
  const root = path.resolve(directory);
  const target = path.resolve(root, "attachments", sessionId);
  if (!target.startsWith(`${path.resolve(root, "attachments")}${path.sep}`)) throw new Error("Invalid attachment staging path");
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * CodeBuddy CLI 沙箱项目根：<homedir>/.codebuddy/projects/<cwd转写>/。
 * 模型用 Bash/Python 等工具写文件时，默认落在沙箱会话目录 <project>/<sessionId>/（而非宿主 .agent），
 * 因此产物收集与读取必须同时覆盖两个位置。转写规则：X:\a\b → x-a-b。
 * cwdOverride：工作区模式下传工作目录（CLI cwd 已是工作目录，沙箱根随 cwd 变化）；
 * 目录不存在时返回 null（非 CodeBuddy CLI 环境不启用）。
 */
export function sandboxProjectRoot(cwdOverride?: string): string | null {
  try {
    const cwd = cwdOverride && cwdOverride.trim() ? cwdOverride.trim() : process.cwd();
    const m = cwd.match(/^([A-Za-z]):\\(.*)$/);
    if (!m) return null;
    const proj = m[1].toLowerCase() + "-" + m[2].split("\\").join("-");
    const root = path.join(os.homedir(), ".codebuddy", "projects", proj);
    return existsSync(root) ? root : null;
  } catch {
    return null;
  }
}

/** 产物存储根：恒为用户主目录下的应用主目录（`~/.<AGENT_APP_NAME>`，未声明应用名时 `~/.agent-files`），
 *  不往用户项目里建 output/ 子目录。
 *
 * 本地项目会话的产出策略（应用数据与用户项目彻底分离）：
 *   - 会话元数据 → 应用主目录 `chats/<sid>.json`（`~/.<AGENT_APP_NAME>`，未声明时 `~/.agent`）；
 *   - 交付文件   → 直接写进用户所选项目（位置由用户指定，未指定时由模型按项目结构自定），
 *                  经 registry / 工作目录扫描登记成产物（原位置即产物，不复制、不搬移）；
 *   - 中间草稿   → 产物存储根 `artifacts/<sid>/_drafts/`（不在项目内，不展示）。
 * artifactRootFor 保留 workspaceDir 入参（调用点语义不变），但不据它改落点，
 * 否则每次开对话/刷新产物列表都会在项目根凭空生成 output/artifacts/<sid> 空目录。 */
export function artifactRootFor(_workspaceDir?: string): string {
  return artifactRoot();
}

/** 某会话的候选产物目录：存储根/artifacts/<sid> + 沙箱 <project>/<sid>（存在时），产物根优先 */
export function sessionDirCandidates(sessionId: string, workspaceDir?: string): string[] {
  const s = sanitizeSessionId(sessionId);
  const list = [artifactSessionDir(sessionId, workspaceDir)];
  const sb = sandboxProjectRoot(workspaceDir);
  if (sb) list.push(path.join(sb, s));
  return list;
}

/**
 * 取会话「基 id」：编辑重发/重新生成时，前端会把发给服务端的 SDK transcript id
 * 换成 `${sid}_${uuid}`（让 CLI 不加载旧 transcript，见 AgentWindow 的 rt.sdkSid），
 * 产物目录因此跟着换成一个「分叉目录」。但产物**归属仍是原会话**——前端卡片与
 * 预览请求一律带基 sid（activeSid）。会话 id 是 UUID 本身不含 '_'，故 '_' 前段即基 id。
 * 例外：临时会话 id（side_<uuid>）自身含 '_'，不属于 SDK 分叉，保持原样不截断。
 */
export function baseSessionId(sessionId: string): string {
  const s = String(sessionId || "");
  if (s.startsWith("side_")) return s;
  const i = s.indexOf("_");
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * 同源分叉目录列表（沙箱根）。
 *
 * 宿主侧已不再产生分叉目录：artifactSessionDir 统一按「基 id」归一（见 baseSessionId），
 * 编辑重发/重新生成等 SDK 分叉 transcript 的文件都写回同一会话目录，无需再按前缀扫描。
 * 仅 CodeBuddy CLI 沙箱根仍可能残留分叉会话目录（CLI 内部按 transcript 建目录），保留扫描兜底，
 * 否则「卡片在、点开 404」的错觉（文件明明在磁盘上）。
 */
export async function forkSessionDirs(sessionId: string, workspaceDir?: string): Promise<string[]> {
  const base = sanitizeSessionId(baseSessionId(sessionId));
  const prefix = `${base}_`;
  const sb = sandboxProjectRoot(workspaceDir);
  if (!sb) return [];
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sb, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith(prefix)) out.push(path.join(sb, e.name));
  }
  return out;
}

/** 临时 run 目录特征：群聊快思考/复核/研究任务的中间过程目录（<基sid>_cowork_fast|review|task_<runId>），
 *  这些是模型做决策用的临时产物，不是交付给用户的文件，不展示。
 *  慢思考（_cowork_slow_）是交付轮，保留扫描（兼容历史遗留产物；新产物已统一落会话根目录）。 */
export const TEMP_RUN_DIR_RE = /_cowork_(?:fast|review|task)_/;

/** 路径是否命中临时 run 目录（posix 化后测试任意路径段） */
export function isTempRunPath(absOrPosix: string): boolean {
  return TEMP_RUN_DIR_RE.test(String(absOrPosix).replace(/\\/g, "/"));
}

/** 读取用：基目录候选 + 全部分叉目录（去重，保持「宿主根优先」的既有次序）。
 *  临时 run 目录（快思考/复核/研究任务）过滤掉：只展示交付轮产物。
 *  传入带后缀的会话（群聊 slow run / 编辑重发分叉）时，追加其基会话目录：
 *  模型本轮可能写当前 run 目录（旧行为）或统一写基会话根目录（新规范），两者都要能读到；
 *  当前 run 目录排最前 → 本轮新写入文件优先被扫描，不被其他目录的同名旧副本遮蔽。 */
export async function readDirCandidates(sessionId: string, workspaceDir?: string): Promise<string[]> {
  const out: string[] = [];
  const own = sessionDirCandidates(sessionId, workspaceDir);
  const base = sanitizeSessionId(baseSessionId(sessionId));
  const baseDirs = base !== sanitizeSessionId(sessionId) ? sessionDirCandidates(base, workspaceDir) : [];
  for (const d of [...own, ...baseDirs, ...(await forkSessionDirs(sessionId, workspaceDir))]) {
    if (out.includes(d)) continue;
    if (TEMP_RUN_DIR_RE.test(path.basename(d))) continue;
    out.push(d);
  }
  return out;
}

/** 只允许会话 ID 使用安全字符，杜绝路径穿越 */
export function sanitizeSessionId(s: string): string {
  const cleaned = String(s || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return cleaned || "unknown";
}

/** 清洗文件名：去除前导分隔符、去除 . 与 .. 段，防穿越；过长截断 */
export function sanitizeArtifactName(name: string): string {
  const parts = String(name)
    .split(/[\\/]+/)
    .filter((p) => p && p !== "." && p !== "..");
  return parts.join("/").slice(0, 200) || "file";
}

/**
 * 中间产物目录名（相对会话目录的**第一段**命中即视为中间产物，不向用户展示）：
 *  - _drafts / _intermediate / _tmp：模型写草稿 / 临时 / 半成品文件的约定目录（见 buildArtifactPrompt）；
 *  - tool-results：CodeBuddy CLI 沙箱会话目录里的内部工具执行记录（chatcmpl-tool-*-render.txt、
 *    mcp-web-fetch-*.txt 等），不是用户可见产物；
 *  - subagents：CLI 子代理（subagent）的 transcript / 结果目录（位于会话目录内 subagents/<id>/），
 *    同样属于 SDK 内部文件，不是用户交互产物；
 *  - attachments：**用户上传附件的 staging 目录**（服务端把用户文件复制到 CLI cwd 的
 *    attachments/<rel>，见 handlers.ts stageVirtualCopy）。用户的文件永远不是模型生成的产物，
 *    收集/列表必须整体跳过——否则用户截图会出现在「产物」面板里。
 * 只有会话目录根下（及非保留子目录）的文件才是「最终产物」。
 * 点开头（隐藏文件/目录）同样视为中间产物，避免 .DS_Store/.gitkeep 之类进入产物列表。
 */
export const INTERMEDIATE_DIR_NAMES: ReadonlySet<string> = new Set(["_drafts", "_intermediate", "_tmp", "tool-results", "subagents", "attachments"]);

/** 依赖/构建产物目录：任意路径段命中即视为中间产物，不进入产物清单。
 *  node_modules/.venv 等会随工程递归扫入成千上万个文件（元数据+文本内容内联），
 *  单条消息 artifacts 可膨胀到几十 MB，直接拖垮会话消息读取。 */
const DEPENDENCY_DIR_NAMES: ReadonlySet<string> = new Set(["node_modules", ".venv", "venv", "site-packages"]);

/** 判断一个相对路径是否属于中间产物：第一段命中保留目录名 / 以点开头；
 *  或**任意路径段**命中 CodeBuddy CLI 内部目录（tool-results / subagents / .codebuddy）——
 *  subagents/<id>/tool-results/xxx 这类 SDK 内部文件即使不在第一段也必须过滤。 */
export function isIntermediateRel(rel: string): boolean {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  const first = parts[0] || "";
  if (first.startsWith(".") || INTERMEDIATE_DIR_NAMES.has(first)) return true;
  return parts.some((p) => p === "tool-results" || p === "subagents" || p === ".codebuddy" || DEPENDENCY_DIR_NAMES.has(p));
}

/** CLI 内部绝对路径判定（registry 登记条目用）：路径任意段命中 tool-results/subagents/.codebuddy
 *  → CodeBuddy SDK 内部文件，不是用户交互产物，不展示。 */
export function isCliInternalAbsPath(abs: string): boolean {
  return String(abs)
    .split(/[\\/]+/)
    .some((p) => p === "tool-results" || p === "subagents" || p === ".codebuddy");
}

/* ======================= 产物登记表（registry） =======================
 * 策略：只要模型创建了文件，无论落在哪个目录都是本会话的输出物，原位置直接展示，
 * 不复制、不搬移进 .agent。执行层（sdk.ts withArtifactRegistration）在写文件工具
 * （Write/Edit/MultiEdit/NotebookEdit）获准执行时登记目标真实路径；Bash/Python 等
 * shell 写入无法可靠解析路径，由工作目录根扫描兜底登记（见 collectWorkFiles）。
 * 登记条目持久化在 <产物根>/.registry/<sid>.json（点开头隐藏目录，永远不会被
 * isIntermediateRel / collectArtifacts 当作产物收集）。 */

/** 登记表目录名（在产物根下，点开头 = 中间产物，不进入产物清单） */
const REGISTRY_DIR_NAME = ".registry";

/** 登记条目：absPath 是唯一权威路径，lastSeen/戳 用于 added/modified/deleted 判定 */
export interface RegistryEntry {
  /** 稳定唯一 id：会话目录内 = 相对路径（与扫描产物一致）；工作目录根 = 文件名（兼容历史）；
   *  其他任意路径（用户指定目录）= ext-<hash8>-<basename> */
  id: string;
  /** 展示名（文件 basename） */
  name: string;
  /** 真实绝对路径（原位置，不复制） */
  absPath: string;
  type: ArtifactType;
  /** 上次收集时的 mtimeNs（bigint 转字符串）；从未成功收集则无 */
  mtimeNs?: string;
  /** 上次收集时的文件字节数 */
  size?: number;
  /** 登记来源：model=模型工具写的真产物；scan=列表兜底扫描顺带的工程文件（需再判定） */
  origin?: RegistryOrigin;
  /** 登记时刻 ms（scan 条目用它：登记之后没被改写过 = 本来就存在的工程文件 → 不展示） */
  registeredAt?: number;
  /** 上次收集时文件是否存在于磁盘（false 且仍不存在 → 登记但写入失败，不报 deleted） */
  lastSeen: boolean;
  /** 首次写入前不存在才是本会话产出；编辑已有文件只进入变更列表。 */
  createdBySession?: boolean;
}

/** 登记表固定落在全局产物根 ~/<目录名>/.registry，与工作区无关：
 *  它是内部隐藏状态（产物/变更登记），绝不写进用户项目目录。workspaceDir 仅为兼容
 *  既有调用签名保留，不再参与路径计算。 */
function registryFileFor(sessionId: string, _workspaceDir?: string): string {
  return path.join(artifactRoot(), REGISTRY_DIR_NAME, sanitizeSessionId(sessionId) + ".json");
}

/** 读取会话登记表（损坏/不存在 → 空数组）。
 *  含编辑重发/重新生成产生的分叉登记表（`<base>_<uuid>`）：模型那一轮写的是分叉
 *  transcript id，登记项落在分叉登记表里，而读取一律按基会话走 → 必须合并，
 *  否则「模型写到用户指定目录」的文件会出现同样的卡片 404。 */
export async function loadRegistry(sessionId: string, workspaceDir?: string): Promise<RegistryEntry[]> {
  const names = [sanitizeSessionId(sessionId)];
  const base = sanitizeSessionId(baseSessionId(sessionId));
  if (base !== names[0]) {
    // 分叉登记表：<base>_<uuid>.json（uuid 段含 '-'，sanitize 后仍保持唯一）
    const regDir = path.join(artifactRoot(), REGISTRY_DIR_NAME);
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(regDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (e.isFile() && e.name.startsWith(`${base}_`) && e.name.endsWith(".json")) names.push(e.name.slice(0, -5));
    }
  }
  const merged: RegistryEntry[] = [];
  const seenAbs = new Set<string>();
  const seenId = new Set<string>();
  for (const n of names) {
    let arr: unknown;
    try {
      arr = JSON.parse(await fs.readFile(registryFileFor(n, workspaceDir), "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const e of arr) {
      if (
        !e || typeof e !== "object" ||
        typeof (e as RegistryEntry).id !== "string" ||
        typeof (e as RegistryEntry).name !== "string" ||
        typeof (e as RegistryEntry).absPath !== "string"
      ) continue;
      // 同一路径/同一 id 只保留首个（基会话登记表优先，保持原有语义）
      if (seenAbs.has(e.absPath) || seenId.has(e.id)) continue;
      seenAbs.add(e.absPath);
      seenId.add(e.id);
      merged.push(e as RegistryEntry);
    }
  }
  return merged;
}

/** 只读本会话自己的登记表文件（不合并分叉）：读-改-写与落盘必须用本，避免把
 *  「基 + 全部分叉」的合并结果写回某一个分叉文件，造成登记项跨文件漂移。 */
async function loadOwnRegistry(sessionId: string, workspaceDir?: string): Promise<RegistryEntry[]> {
  try {
    const raw = await fs.readFile(registryFileFor(sessionId, workspaceDir), "utf8");
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (e): e is RegistryEntry =>
        !!e && typeof e === "object" &&
        typeof (e as RegistryEntry).id === "string" &&
        typeof (e as RegistryEntry).name === "string" &&
        typeof (e as RegistryEntry).absPath === "string",
    );
  } catch {
    return [];
  }
}

/** 同一会话的读-改-写串行化，避免并行工具登记时覆盖其他文件。 */
const registryMutations = new Map<string, Promise<void>>();
async function mutateRegistry(
  sessionId: string,
  workspaceDir: string | undefined,
  update: (entries: RegistryEntry[]) => void | Promise<void>,
): Promise<void> {
  const key = registryFileFor(sessionId, workspaceDir);
  const previous = registryMutations.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const entries = await loadOwnRegistry(sessionId, workspaceDir);
    await update(entries);
    await saveRegistry(sessionId, entries, workspaceDir);
  });
  registryMutations.set(key, operation);
  try {
    await operation;
  } finally {
    if (registryMutations.get(key) === operation) registryMutations.delete(key);
  }
}

/** 原子替换登记表，读取列表不会看到半截 JSON。 */
export async function saveRegistry(sessionId: string, entries: RegistryEntry[], workspaceDir?: string): Promise<void> {
  let temporary: string | undefined;
  try {
    const f = registryFileFor(sessionId, workspaceDir);
    await fs.mkdir(path.dirname(f), { recursive: true });
    temporary = `${f}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entries), "utf8");
    await fs.rename(temporary, f);
  } catch {
    /* 登记失败不阻塞主流程（产物仅少一次展示机会） */
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
  }
}

/** 把模型工具入参里的路径归一化为真实绝对路径：
 *  - /agent-output/<sid>/x → <产物根>/<sid>/x（与 pathAliases 同一映射，登记层拿原始入参时自行解析）
 *  - bash 风格 /d/a/b → D:\a\b（Windows）
 *  - 相对路径 → 相对执行 cwd 解析
 *  无法解析返回 null。 */
export function normalizeArtifactAbsPath(rawPath: string, workspaceDir?: string, cwd?: string): string | null {
  let p = String(rawPath ?? "").trim();
  if (!p) return null;
  if (p.startsWith(ARTIFACT_VIRTUAL_ROOT + "/")) {
    // /agent-output/<sid>/<rest> → <存储根>/artifacts/<sid>/<rest>
    const [sid = "", ...rest] = p.slice(ARTIFACT_VIRTUAL_ROOT.length + 1).split(/[/\\]+/).filter(Boolean);
    p = path.join(artifactSessionDir(sid, workspaceDir), ...rest);
  } else {
    const m = p.match(/^\/([a-z])\/(.*)$/s);
    if (m) p = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
    if (!path.isAbsolute(p)) p = path.resolve(cwd && cwd.trim() ? cwd.trim() : process.cwd(), p);
  }
  return path.normalize(p);
}

/** 极简稳定 hash（djb2 → 8 位 hex），用于任意路径产物的 id 后缀（防同名不同目录冲突） */
function hash8(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

/**
 * 登记一个产物路径（幂等：absPath 已登记则跳过）。id 规则：
 *  - 在会话目录候选内 → 相对会话目录路径（与扫描产物 id 一致，天然去重）；
 *  - 工作目录根散落文件 → 文件名（与历史 collectWorkFiles id 一致，旧卡片可继续预览）；
 *  - 其他任意路径（用户指定目录）→ ext-<hash8>-<basename>。
 */
export async function registerArtifactPath(
  sessionId: string,
  rawPath: string,
  workspaceDir?: string,
  cwd?: string,
  origin: RegistryOrigin = "model",
  before?: ArtifactStamp,
): Promise<void> {
  try {
    const abs = normalizeArtifactAbsPath(rawPath, workspaceDir, cwd);
    if (!abs) return;
    // 临时 run 目录（快思考/复核/研究任务 _cowork_fast|review|task_）是模型做决策的
    // 中间过程：文件不登记为交付产物（显示逻辑也不读这些目录）。
    if (isTempRunPath(abs)) return;
    // CLI 内部文件（tool-results / subagents / .codebuddy 沙箱）不登记为产物：
    // 只有用户交互产生的文件（模型按用户指示 Write 的目标）才算产出物
    if (isCliInternalAbsPath(abs)) return;
    // 会话目录内的 attachments/ 子目录是用户上传附件的 staging 区（见 handlers.ts
    // stageVirtualCopy）：用户的文件永远不是模型生成的产物，模型意外写入此处也不登记。
    // 覆盖分叉目录：本轮 sid 可能就是 `<base>_<uuid>`（编辑重发），而登记/收集另一侧
    // 按基会话走，两边候选集不一致会让同一文件在登记与读取时算出不同 id。
    for (const dir of await readDirCandidates(sessionId, workspaceDir)) {
      const rel = path.relative(dir, abs);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && isIntermediateRel(rel)) {
        return;
      }
    }
    const base = path.basename(abs);
    let id = "";
    for (const dir of await readDirCandidates(sessionId, workspaceDir)) {
      const rel = path.relative(dir, abs);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
        id = sanitizeArtifactName(rel.split("\\").join("/"));
        break;
      }
    }
    // Dedicated session output directories contain generated files, including legacy
    // outputs created before the registry recorded their creation identity.
    const inSessionOutput = Boolean(id);
    if (!id) {
      const workRoot = workDirRoot(workspaceDir);
      const relW = path.relative(workRoot, abs);
      if (relW && !relW.startsWith("..") && !path.isAbsolute(relW) && !relW.includes(path.sep)) {
        id = sanitizeArtifactName(relW.split("\\").join("/"));
      } else {
        id = `ext-${hash8(abs)}-${sanitizeArtifactName(base)}`;
      }
    }
    const initial = before ?? await snapshotFile(abs);
    await mutateRegistry(sessionId, workspaceDir, (entries) => {
      const existing = entries.find((e) => e.absPath === abs);
      if (existing) {
        if (origin === "model" && existing.origin === "scan") {
          existing.origin = "model";
          existing.createdBySession = inSessionOutput || initial.exists === false;
        }
        return;
      }
      entries.push({
        id, name: base, absPath: abs, type: artifactType(base), lastSeen: false,
        origin, registeredAt: Date.now(), createdBySession: origin === "model" && (inSessionOutput || initial.exists === false),
      });
    });
  } catch {
    /* 忽略登记失败 */
  }
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  ogg: "audio/ogg", oga: "audio/ogg", flac: "audio/flac", opus: "audio/ogg", weba: "audio/webm",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  ogv: "video/ogg", avi: "video/x-msvideo", mkv: "video/x-matroska",
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroenabled.12",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  ppsx: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
};

export type ArtifactType = "html" | "markdown" | "image" | "audio" | "video" | "pdf" | "text" | "word" | "excel" | "ppt" | "other" | "dir";

/** 文本/代码类扩展名（可内嵌预览，前端 <pre> 等宽渲染）；html/md/图片/pdf 已在 artifactType 前序分支处理 */
const TEXT_EXTS: ReadonlySet<string> = new Set([
  "txt", "json", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "csv",
  "xml", "yaml", "yml", "toml", "ini", "sh", "bash", "bat", "ps1", "sql",
  "java", "go", "rs", "c", "cpp", "h", "rb", "php", "vue", "svelte",
]);

export function artifactType(name: string): ArtifactType {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "opus", "weba"].includes(ext)) return "audio";
  if (["mp4", "m4v", "webm", "mov", "ogv", "avi", "mkv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "word";
  if (["xlsx", "xlsm"].includes(ext)) return "excel";
  if (["pptx", "pptm", "ppsx"].includes(ext)) return "ppt";
  if (TEXT_EXTS.has(ext)) return "text";
  return "other";
}

export function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] || "application/octet-stream";
}

export interface ArtifactMeta {
  id: string;
  name: string;
  type: ArtifactType;
  /** 文件字节数（前端展示大小） */
  size?: number;
  /** 文件修改时间（毫秒时间戳）：AI 刷新/覆盖版本后随之更新，前端据此展示"修改时间" */
  mtimeMs?: number;
  /** 文件所在真实目录（「打开文件夹」跟随文件用）：会话目录内 = 会话目录；
   *  登记产物（模型写到任意位置） = 该文件自己的父目录。前端桌面壳据此 shell.openPath。 */
  dir?: string;
  /** 展示用完整相对路径（登记产物在会话目录 / 工作目录内时给出；name 可能只是 basename，
   *  前端导航面包屑与文件夹归组据此显示完整路径，如 hello/sub/x.txt） */
  rel?: string;
}

/** 确保会话产物目录存在并返回其路径（恒为 ~/.agent-files/artifacts/<sid>，不在用户项目内建目录） */
export async function ensureSessionDir(sessionId: string, workspaceDir?: string): Promise<string> {
  const dir = artifactSessionDir(sessionId, workspaceDir);
  await fs.mkdir(dir, { recursive: true });
  // 存储根也确保存在（首次）
  await fs.mkdir(artifactRootFor(workspaceDir), { recursive: true });
  return dir;
}

/** 文本 diff 白名单：这些扩展名的文件参与左右内容对比（基线读内容快照、收集带新旧内容）；
 *  其余（图片/pdf 等二进制）只标记变更类型，不携带内容（前端显示"无法对比"提示）。 */
const TEXT_DIFF_EXTS: ReadonlySet<string> = new Set([
  ...TEXT_EXTS,
  "txt", "md", "markdown", "json", "css", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py",

  "html", "htm", "xml", "yaml", "yml", "toml", "sql", "sh", "bat", "svg", "ini", "conf", "log", "csv", "ipynb", "tex",
]);

/** 文件是否参与文本 diff（扩展名在白名单内） */
export function isTextDiffable(name: string): boolean {
  const ext = String(name).split(".").pop()?.toLowerCase() ?? "";
  return TEXT_DIFF_EXTS.has(ext);
}

/** 基线内容快照上限：超过此大小的文件视为不可 diff（超大文本/二进制），content 置 null */
const BASELINE_CONTENT_LIMIT = 512 * 1024;

/** 工作目录（模型写文件的 cwd）根散落文件纳入产物时的排除表：常见工程配置文件不作为产物展示 */
const WORK_DIR_EXCLUDE: ReadonlyArray<RegExp> = [
  /^package\.json$/i, /^package-lock\.json$/i, /^pnpm-(lock\.yaml|workspace\.yaml)$/i,
  /^yarn\.lock$/i, /^tsconfig.*\.json$/i, /^next\.config\..*$/i, /^vite\.config\..*$/i,
  /^eslint(\.config)?\..*$/i, /^prettier(\.config)?\..*$/i, /^\.env.*$/i, /^\.gitignore$/i,
  /^\.npmrc$/i, /^\.gitattributes$/i, /^\.gitmodules$/i, /^LICENSE$/i,
  // 运行时/工程说明文件：dev server 重写的 *.log、README/CHANGELOG/CONTRIBUTING 均非对话产物
  /^.*\.log$/i, /^README.*$/i, /^CHANGELOG.*$/i, /^CONTRIBUTING.*$/i,
  // jsconfig.json：Next.js 可读性配置（tsconfig 的 JS 版），绝不是模型写的产物
  /^jsconfig\.json$/i,
];

/** 模型写文件的工作目录：选了工作区用工作区，否则进程 cwd（模型默认在 cwd 写文件） */
function workDirRoot(workspaceDir?: string): string {
  return workspaceDir && workspaceDir.trim() ? workspaceDir.trim() : process.cwd();
}

/** 工作目录根散落文件候选（仅根目录文件；子目录不扫——避免工程源码/依赖混入产物） */
async function workFileCandidates(workDir: string): Promise<Array<{ name: string; abs: string }>> {
  const out: Array<{ name: string; abs: string }> = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(workDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (isIntermediateRel(e.name)) continue;
    if (WORK_DIR_EXCLUDE.some((re) => re.test(e.name))) continue;
    out.push({ name: e.name, abs: path.join(workDir, e.name) });
  }
  return out;
}

/** 登记条目的来源：model=模型工具写的（真产物）；scan=列表兜底扫描顺带的工程文件（待判定） */
export type RegistryOrigin = "model" | "scan";

/**
 * 把工作目录根**散落文件**登记为产物（幂等），保证列表/预览读原路径即可；不再复制副本进 .agent。
 *
 * 关键点：这里登记的文件只作「候选」，origin 一律记 scan —— 它们是工作目录里本来就在的
 * 工程文件（jsconfig.json、README 之类）。已登记过的路径**不覆盖**原条目，
 * 免得把 collectArtifacts 判定过的真产物降级成 scan。
 */
async function ensureWorkRegistered(workDir: string, sessionId: string, workspaceDir?: string): Promise<void> {
  const registry = await loadRegistry(sessionId, workspaceDir);
  const byAbs = new Map(registry.map((e) => [e.absPath, e]));
  for (const f of await workFileCandidates(workDir)) {
    const abs = path.join(workDir, f.name);
    if (byAbs.has(abs)) continue; // 已登记（模型写的或上一次扫描登记的）→ 沿用原条目
    await registerArtifactPath(sessionId, abs, workspaceDir, workDir, "scan");
  }
}

/**
 * 产物表里的登记条目该不该展示：
 *  - 非工作目录的登记条目（模型按用户指示写到任意位置，origin=model）→ 展示；
 *  - 工作目录根内 origin=model（模型 Write/Edit 工具显式登记）→ 展示；
 *  - 工作目录根内 origin=scan（列表兜底扫描登记的工程/外部进程文件）→ 一律不展示。
 * 不做 mtime 启发式：外部进程（dev server 重写 .log、编辑器改 README）同样会让 mtime
 * 变新，无法与「模型 shell 写入」可靠区分 → 保守不展示（纯聊天轮次不再凭空冒产物）。
 */
async function shouldShowWorkFile(e: RegistryEntry, workDir: string): Promise<boolean> {
  if (e.createdBySession === false || e.origin === "scan") return false;
  if (e.createdBySession === true) return true;
  const resolved = path.resolve(e.absPath);
  const wd = path.resolve(workDir);
  if (resolved !== wd && !resolved.startsWith(wd + path.sep)) return true; // 非工作目录产物：原逻辑
  if ((e.origin ?? "scan") !== "scan") {
    // 历史迁移：早期 collectWorkFiles 未传 origin 时，README/*.log/LICENSE 等工作目录根
    // 工程文件被误标成 model。命中排除表的一律不展示（模型未来改 README 等也按此处理）。
    if (WORK_DIR_EXCLUDE.some((re) => re.test(path.basename(resolved)))) return false;
    return true; // 模型工具写的文件：就是产物
  }
  return false; // scan 条目（工程脚手架 / 运行时文件）一律不展示
}

/** collectArtifacts 用：工作目录根散落文件 → 登记原路径 + 变更（按 w: 基线判断 added/modified）。
 *  产物即原文件本身（不复制、不搬移）；源文件 mtime/size 与基线一致（未变）则跳过；
 *  重写（源变）记为 modified，首次为 added。 */
async function collectWorkFiles(
  workDir: string,
  sessionId: string,
  workspaceDir: string | undefined,
  baseline: Map<string, ArtifactStamp>,
): Promise<ArtifactChange[]> {
  const out: ArtifactChange[] = [];
  for (const f of await workFileCandidates(workDir)) {
    const key = "w:" + f.name;
    const stamp = baseline.get(key);
    try {
      const ss = await fs.stat(f.abs, { bigint: true });
      if (stamp && stamp.mtimeNs === ss.mtimeNs && stamp.size === Number(ss.size)) continue;
      // origin 必须显式传 scan：工作目录根散落文件是「工程/外部进程文件」，不是模型工具写的真产物。
      // 不传会落默认 model → shouldShowWorkFile 放行 → README/dev-restart-out.log 被误当对话产物。
      await registerArtifactPath(sessionId, f.abs, workspaceDir, workDir, "scan");
      const change: ArtifactChange = {
        id: sanitizeArtifactName(f.name),
        name: f.name,
        type: artifactType(f.name),
        size: Number(ss.size),
        change: stamp ? "modified" : "added",
      };
      if (isTextDiffable(f.name) && Number(ss.size) <= BASELINE_CONTENT_LIMIT) {
        change.oldContent = stamp?.content ?? null;
        change.newContent = await fs.readFile(f.abs, "utf8").catch(() => null);
      }
      out.push(change);
    } catch {
      /* 忽略并发/权限 */
    }
  }
  return out;
}

/** 产物文件戳：记录修改时间（纳秒 BigInt）与大小，用于识别「新增」与「内容更新」（同名覆盖）。
 *  content：文本文件（isTextDiffable 且 ≤ 上限）在本轮开始前的内容快照，供本轮 diff 展示旧内容；
 *  二进制/超大文件为 null（只标记变更类型，不参与内容对比）。
 *  注意：bigint 模式下 fs.stat 的 mtimeNs 是 bigint、size 是 bigint，统一在存取处转 Number(size)。 */
export interface ArtifactStamp {
  mtimeNs: bigint;
  size: number;
  content?: string | null;
  /** false 是已确认的不存在状态，必须保留，不能让后续编辑覆盖为已有文件。 */
  exists?: boolean;
  digest?: string;
}

/** 对常见文档保留摘要，即使重写改变 mtime 也能识别内容没有变化。 */
async function snapshotFile(absPath: string): Promise<ArtifactStamp> {
  try {
    const stat = await fs.stat(absPath, { bigint: true });
    if (!stat.isFile()) return { exists: false, mtimeNs: 0n, size: 0, content: null };
    const size = Number(stat.size);
    const data = size <= 16 * 1024 * 1024 ? await fs.readFile(absPath).catch(() => null) : null;
    return {
      exists: true,
      mtimeNs: stat.mtimeNs,
      size,
      content: data && size <= BASELINE_CONTENT_LIMIT && isTextDiffable(absPath) && !data.includes(0)
        ? data.toString("utf8") : null,
      digest: data ? createHash("sha256").update(data).digest("hex") : undefined,
    };
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return { exists: false, mtimeNs: 0n, size: 0, content: null };
    }
    throw error;
  }
}

function sameFile(before: ArtifactStamp | undefined, after: ArtifactStamp): boolean {
  if (!before || before.exists === false || after.exists === false) return false;
  if (before.digest && after.digest) return before.digest === after.digest;
  if (before.content != null && after.content != null) return before.content === after.content;
  return before.mtimeNs === after.mtimeNs && before.size === after.size;
}

/**
 * 基线：记录某会话「开始前」已存在的产物（宿主 + 沙箱两个位置的会话目录，以及产物根下散落文件），
 * 返回 key（"s:"/"t:" + 文件名）→ 文件戳，用于增量与更新识别。
 */
export async function baselineArtifacts(
  sessionId: string,
  workspaceDir?: string,
): Promise<Map<string, ArtifactStamp>> {
  const map = new Map<string, ArtifactStamp>();
  const stamp = async (dir: string, prefix: "s:" | "t:", rel = "") => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (isIntermediateRel(childRel)) continue;
      if (e.isDirectory() && prefix === "s:") {
        await stamp(path.join(dir, e.name), prefix, childRel);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        // 相同虚拟路径的宿主文件优先，与 readArtifact 的读取次序一致。
        if (!map.has(prefix + childRel)) map.set(prefix + childRel, await snapshotFile(path.join(dir, e.name)));
      } catch {
        /* 文件被并发删除等情况忽略 */
      }
    }
  };
  // 工作目录根散落文件（模型按用户指示写到 cwd，如「放到根目录」）也入基线（w: 前缀），
  // 用于增量识别（首次 added / 重写 modified）；工程配置/隐藏文件排除
  const stampWorkDir = async (dir: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (isIntermediateRel(e.name)) continue;
      if (WORK_DIR_EXCLUDE.some((re) => re.test(e.name))) continue;
      try {
        map.set("w:" + e.name, await snapshotFile(path.join(dir, e.name)));
      } catch {
        /* 忽略 */
      }
    }
  };
  // 基线覆盖基目录 + 全部分叉目录（编辑重发轮次写的文件也算本会话既有产物，
  // 否则下一轮会把上一轮的文件全判成 added）
  for (const dir of await readDirCandidates(sessionId, workspaceDir)) {
    await stamp(dir, "s:");
  }
  await stamp(artifactRootFor(workspaceDir), "t:");
  await stampWorkDir(workDirRoot(workspaceDir));
  // 登记在任意目录的既有文件也必须有本轮基线，尤其用于 shell 修改和删除的旧内容。
  for (const entry of await loadRegistry(sessionId, workspaceDir)) {
    if (entry.origin === "scan" || isCliInternalAbsPath(entry.absPath)) continue;
    try {
      map.set("r:" + entry.absPath, await snapshotFile(entry.absPath));
    } catch { /* 无权读取的文件不影响本轮 */ }
  }
  return map;
}

/** 产物变更：本轮对会话目录内文件的新增/修改/删除，带新旧内容（文本文件）供前端 diff 展示。 */
export interface ArtifactChange extends ArtifactMeta {
  /** 本轮变更类型：added=新增、modified=内容更新、deleted=被删除 */
  change: "added" | "modified" | "deleted";
  /** 变更前内容（文本基线快照；deleted 时为被删文件的最后内容；二进制/超限为 null） */
  oldContent?: string | null;
  /** 变更后内容（added/modified 的当前内容；deleted 无此字段） */
  newContent?: string | null;
}

/** 单条消息可存储的 artifacts JSON 大小上限（约 1MB）。
 *  超限时先丢弃 oldContent/newContent 只留元数据；元数据仍超限（海量小文件）再按条截断，
 *  防止工程依赖目录等被误扫进产物后，单条消息 artifacts 膨胀到几十 MB，拖垮消息读取。 */
const MAX_ARTIFACTS_MESSAGE_BYTES = 1_048_576;

/** 写入 agent_messages.artifacts 前的安全裁剪：返回可直接 JSON.stringify 的数组。 */
export function capArtifactsForMessage(artifacts: ArtifactChange[]): unknown[] {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return artifacts;
  if (JSON.stringify(artifacts).length <= MAX_ARTIFACTS_MESSAGE_BYTES) return artifacts;
  const meta: unknown[] = artifacts.map(({ oldContent, newContent, ...rest }) => ({ ...rest }));
  if (JSON.stringify(meta).length <= MAX_ARTIFACTS_MESSAGE_BYTES) return meta;
  const per = JSON.stringify(meta).length / meta.length;
  return meta.slice(0, Math.max(1, Math.floor(MAX_ARTIFACTS_MESSAGE_BYTES / per)));
}

/**
 * 写工具执行前采集：目标文件在本轮编辑前是否已存在 + 文本内容快照（供 diff 旧内容）。
 * 写入 into（键 = 归一化绝对路径）。同一文件本轮多次编辑只保留首次快照（= 本轮开始前状态）。
 *
 * 用途：模型用 Edit/Write 改「已有文件」（如工作区里的工程源码）时，登记表（registry）新建
 * 条目的 lastSeen 恒为 false，光靠 collectArtifacts 无法区分「新建文件」与「编辑已有文件」，
 * 会把编辑误判为 added（→ 只进「产物」不进「变更」，且缺旧内容无法 diff）。执行前若文件已存在，
 * 不存在也保留快照：本轮先 Write 新建再 Edit 时，仍按新建文件归类。
 */
export async function capturePreWriteSnapshot(
  absPath: string,
  into: Map<string, ArtifactStamp>,
): Promise<void> {
  if (into.has(absPath)) return;
  try {
    const snapshot = await snapshotFile(absPath);
    if (!into.has(absPath)) into.set(absPath, snapshot);
  } catch {
    /* 权限错误不应误判为文件不存在 */
  }
}

/**
 * 一轮对话结束后收集本轮「变更」（新增、内容更新、删除）：
 *  - 会话子目录（宿主 .agent 与 CodeBuddy 沙箱两处）里的新文件/更新文件记为变更（added/modified），
 *    递归扫描子目录（模型常把产物写进 brand-icons/ 等子目录，此前只扫顶层导致卡片缺失）；
 *  - 中间产物目录（_drafts/、_intermediate/、_tmp/ 及点开头隐藏项）一律不收集，
 *    只有会话目录根下（及非保留子目录）的文件才作为「最终产物」呈现给用户；
 *  - 宿主根目录下「散落」的新**文件**（模型忘记带 sessionId 子目录）移入会话子目录，保证隔离；
 *    **根目录下的目录不做任何搬移/扫描**——它可能是其他会话自己的目录，搬入会造成跨会话产物混入；
 *  - 同名文件被重新写入（覆盖/更新，mtime 或大小变化）记为 modified；
 *  - 删除检测：会话子目录内基线存在、本轮结束后磁盘已无 → deleted（根目录散落文件不判，
 *    它们可能被搬移进会话目录或属其他会话，误判风险高）；
 *  - 文本文件（isTextDiffable 且 ≤ 上限）携带 oldContent/newContent 供前端左右 diff；
 *    二进制/超大文件只标记变更类型。
 * 返回变更清单（新增/修改在前、删除在后，按 id 去重）。id 为相对会话目录的 posix 路径。
 */
export async function collectArtifacts(
  sessionId: string,
  baseline: Map<string, ArtifactStamp>,
  workspaceDir?: string,
  /** 写工具执行前的目标文件快照（键 = 归一化绝对路径）：区分「编辑已有文件」与「新建文件」并提供 diff 旧内容 */
  preWrite?: Map<string, ArtifactStamp>,
): Promise<ArtifactChange[]> {
  // 纯路径，不在此预建空目录；仅在确有散落文件需要移入（见下方 moveTo）时才创建。
  const sessionDir = artifactSessionDir(sessionId, workspaceDir);
  const root = artifactRootFor(workspaceDir);
  const found: ArtifactChange[] = [];
  const diskKeys = new Set<string>(); // 本轮结束后磁盘上仍存在的 key（deleted 检测用）

  // 资料库索引：把本轮新增产物登记进 agent_files（kind=output）；非致命，不影响产物卡片
  let ownerSub: string | null = null;
  try {
    ownerSub = await getOwnerSubBySession(sessionId);
  } catch {
    /* 无 DB 或会话无归属时不索引 */
  }

  /** 递归扫描一个目录；rel 为相对该扫描根的 posix 路径（顶层文件为 ""，子目录为 "sub/"） */
  const consider = async (dir: string, prefix: "s:" | "t:", moveTo: string | null, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const key = prefix + childRel;
      if (e.isDirectory()) {
        // 根目录（t:）下的目录一律不搬移、不扫描：它可能是**其他会话自己的目录**
        //（如另一场对话的 .agent/<sid>/），整体搬进来会造成跨会话产物混入。
        // 只处理「模型忘记带 sessionId」的散落**文件**；散落子目录属罕见且无法安全归因，留原地即可。
        if (prefix === "t:") continue;
        // 中间产物目录（_drafts/ 等）不进入产物清单
        if (isIntermediateRel(childRel)) continue;
        await consider(path.join(dir, e.name), prefix, moveTo, childRel);
        continue;
      }
      if (!e.isFile()) continue;
      // 中间产物不收集（_drafts/ 下的草稿、点开头隐藏文件）
      if (isIntermediateRel(childRel)) continue;
      // 文件戳：新增（基线无记录）或内容更新（mtime/大小变化）都算本轮产物
      const absolutePath = path.join(dir, e.name);
      const current = await snapshotFile(absolutePath).catch(() => null);
      if (!current || current.exists === false) continue;
      if (diskKeys.has(key)) continue; // 宿主目录优先，重复虚拟路径只处理一次
      diskKeys.add(key);
      const stamp = baseline.get(key);
      if (sameFile(stamp, current)) continue;

      if (prefix === "t:" && moveTo) {
        // 散落根目录的文件 → 移入会话子目录，确保跨会话不串；仅在确有文件要移动时才建目录
        const src = path.join(dir, e.name);
        const dst = path.join(moveTo, sanitizeArtifactName(childRel));
        await fs.mkdir(moveTo, { recursive: true }).catch(() => {});
        try {
          await fs.rename(src, dst);
        } catch {
          try {
            const buf = await fs.readFile(src);
            await fs.writeFile(dst, buf);
            await fs.unlink(src);
          } catch {
            /* 忽略无法移动的文件 */
          }
        }
      }
      const id = sanitizeArtifactName(childRel);
      const change: ArtifactChange = {
        id,
        name: childRel,
        type: artifactType(e.name),
        size: current.size,
        change: stamp && stamp.exists !== false ? "modified" : "added",
      };
      change.oldContent = stamp?.content ?? (change.change === "added" ? "" : null);
      change.newContent = current.content ?? null;
      found.push(change);
      // shell 等工具直接写会话目录时也持久化产出身份，后续 Edit 不会把它误当成用户既有文件。
      if (change.change === "added") {
        const trackedPath = prefix === "t:" && moveTo ? path.join(moveTo, id) : absolutePath;
        await registerArtifactPath(sessionId, trackedPath, workspaceDir, undefined, "model", {
          exists: false, mtimeNs: 0n, size: 0, content: null,
        });
        // 资料库索引：把新增产物登记进 agent_files（kind=output），与现有产物卡片并存（过渡期双写）
        if (ownerSub) {
          void indexFile({ ownerSub, kind: "output", absPath: trackedPath, name: childRel, sessionId, mime: mimeFor(e.name) }).catch(() => {});
        }
      }
    }
  };

  // 收集覆盖基目录 + 全部分叉目录：编辑重发/重新生成那一轮，模型写的是分叉
  // transcript id 的目录，只扫基目录会漏推这一轮的产物卡片。
  // 本轮 sid 自身对应的目录排在最前（宿主根优先的既有次序不变）。
  for (const dir of await readDirCandidates(sessionId, workspaceDir)) {
    await consider(dir, "s:", null, "");
  }
  await consider(root, "t:", sessionDir, "");
  // 工作目录根散落文件（README/.log 等工程或外部进程文件）：只登记（origin=scan），
  // 不产生本轮变更推送——它们不是对话产物；模型按指示用 Write 写 cwd 根的文件会以
  // origin=model 走 registry 段正常推送（见下），此处只兜底登记，不做展示。
  await collectWorkFiles(workDirRoot(workspaceDir), sessionId, workspaceDir, baseline);

  // 删除检测：会话子目录（s:）内基线存在、磁盘已无 → deleted（t: 散落 / w: 工作目录不判，
  // 副本保留在会话目录，误判风险高）
  for (const [key, stamp] of baseline) {
    if (!key.startsWith("s:") || stamp.exists === false) continue;
    if (diskKeys.has(key)) continue;
    const id = sanitizeArtifactName(key.slice(2));
    found.push({
      id,
      name: id,
      type: artifactType(id),
      size: stamp.size,
      change: "deleted",
      oldContent: stamp?.content ?? null,
    });
  }

  // —— 登记产物（模型写到任意位置的文件，见 registerArtifactPath）——
  // 逐个对比磁盘状态与上次收集戳：编辑已有文件 → modified（带旧内容）；新登记且此前不存在 →
  // added；戳变化 → modified；上次存在、本次消失 → deleted；登记过但从未写成功 → 忽略（不误报 deleted）。
  // 「此前是否存在」由执行前快照 preWrite 判定（登记条目 lastSeen 恒 false，单凭它会把编辑误判为 added）。
  // 登记条目随收集更新 lastSeen/戳并持久化。
  await mutateRegistry(sessionId, workspaceDir, async (registry) => {
  for (const e of registry) {
    // scan 条目（工作目录根工程/外部进程文件）不产生变更推送：只做登记兜底，永不推卡片
    if (e.origin === "scan") continue;
    // 临时 run 目录（快思考/复核/研究任务）的登记条目不展示、不推变更
    if (isTempRunPath(e.absPath)) continue;
    // 有本轮工具追踪时，只将实际观察到的写入归因给 Agent。
    // 历史登记的工作区文件被编辑器/外部进程改动，不应在纯聊天轮次中冒出变更。
    if (preWrite && !preWrite.has(e.absPath)) continue;
    // CLI 内部文件（tool-results / subagents / .codebuddy 沙箱）不收集为产物
    if (isCliInternalAbsPath(e.absPath)) continue;
    if ((await readDirCandidates(sessionId, workspaceDir)).some((dir) => {
      const rel = path.relative(dir, e.absPath);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && isIntermediateRel(rel);
    })) continue;
    const current = await snapshotFile(e.absPath).catch(() => null);
    if (!current) continue;
    const wasSeen = e.lastSeen;
    const pre = baseline.get("r:" + e.absPath) ?? preWrite?.get(e.absPath);
    const before = pre ?? (wasSeen && e.mtimeNs != null
      ? { exists: true, mtimeNs: BigInt(e.mtimeNs), size: e.size ?? 0, content: null } : undefined);
    if (current.exists === false) {
      if (before?.exists !== false && (before || wasSeen)) {
        found.push({
          id: e.id,
          name: e.name,
          type: e.type,
          size: before?.size ?? e.size ?? 0,
          change: "deleted",
          oldContent: before?.content ?? null,
          newContent: "",
        });
      }
      e.lastSeen = false;
      e.mtimeNs = undefined;
      e.size = undefined;
      continue;
    }
    const size = current.size;
    const mtimeNs = String(current.mtimeNs);
    const unchanged = sameFile(before, current);
    e.lastSeen = true;
    e.mtimeNs = mtimeNs;
    e.size = size;
    if (unchanged) continue;
    const change: ArtifactChange = {
      id: e.id,
      name: e.name,
      type: e.type,
      size,
      change: before && before.exists !== false ? "modified" : "added",
    };
    change.oldContent = before?.content ?? (change.change === "added" ? "" : null);
    change.newContent = current.content ?? null;
    found.push(change);
    // 资料库索引：模型写到任意位置的新增文件也登记进 agent_files（kind=output）
    if (change.change === "added" && ownerSub && (current.exists as boolean | undefined) !== false) {
      void indexFile({ ownerSub, kind: "output", absPath: e.absPath, name: e.name, sessionId, mime: mimeFor(e.name) }).catch(() => {});
    }
  }
  });

  const seen = new Set<string>();
  return found.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

/**
 * 列出某会话的全部产物（递归，含非保留子目录），用于「查看所有产物 (N)」按钮与右侧列表面板。
 * 与 collectArtifacts 不同：不做基线增量，直接返回磁盘上当前存在的全部文件；
 * 中间产物目录（_drafts/ 等）不进入列表；隐藏文件由 includeHidden 控制。
 * 会话目录不存在时返回空数组。
 */
export async function listSessionArtifacts(
  sessionId: string,
  workspaceDir?: string,
  includeHidden = false,
): Promise<ArtifactMeta[]> {
  const excludedFromList = (rel: string): boolean => {
    const parts = rel.split(/[\\/]+/).filter(Boolean);
    if (!includeHidden) return isIntermediateRel(rel) || parts.some((part) => part.startsWith("."));
    return INTERMEDIATE_DIR_NAMES.has(parts[0] ?? "") || parts.some((part) =>
      part === "tool-results" || part === "subagents" || part === ".codebuddy" ||
      part === ".registry" || DEPENDENCY_DIR_NAMES.has(part));
  };
  const safeSession = sanitizeSessionId(sessionId);
  const seen = new Map<string, number>();
  const out: Array<ArtifactMeta & { mtimeMs: number }> = [];
  await ensureWorkRegistered(workDirRoot(workspaceDir), sessionId, workspaceDir);
  const registry = await loadRegistry(sessionId, workspaceDir);
  const editedOnly = new Set(registry.filter((e) => e.createdBySession === false && e.origin !== "scan").map((e) => e.absPath));

  const walk = async (dir: string, rel: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // 内部草稿目录始终排除；普通点号目录仅在用户启用隐藏文件时展示。
        if (excludedFromList(childRel)) continue;
        const absDir = path.join(dir, e.name);
        const dstat = await fs.stat(absDir, { bigint: true }).catch(() => null as import("node:fs").BigIntStats | null);
        const did = `dir:${childRel}`;
        const dmeta: ArtifactMeta & { mtimeMs: number } = {
          id: did, name: childRel, rel: childRel, type: "dir", size: 0,
          mtimeMs: dstat ? Number(dstat.mtimeMs) : 0, dir: absDir,
        };
        const dexisting = seen.get(did);
        if (dexisting !== undefined) {
          if (dmeta.mtimeMs > out[dexisting].mtimeMs) out[dexisting] = dmeta;
        } else {
          seen.set(did, out.length);
          out.push(dmeta);
        }
        await walk(absDir, childRel);
        continue;
      }
      if (!e.isFile()) continue;
      if (excludedFromList(childRel)) continue;
      if (editedOnly.has(path.join(dir, e.name))) continue;
      const stat = await fs
        .stat(path.join(dir, e.name), { bigint: true })
        .catch(() => null as import("node:fs").BigIntStats | null);
      if (!stat) continue;
      const id = sanitizeArtifactName(childRel);
      const meta: ArtifactMeta & { mtimeMs: number } = {
        id, name: childRel, type: artifactType(e.name), size: Number(stat.size), mtimeMs: Number(stat.mtimeMs), dir,
      };
      const existing = seen.get(id);
      if (existing !== undefined) {
        // 同名产物会出现在多个候选目录（编辑重发分叉、群聊 fast/review/slow 后缀目录都可能有副本）：
        // 保留修改时间最新的版本，避免旧副本遮蔽模型新写入的文件（如慢思考比复核后写的内容更新）。
        if (meta.mtimeMs > out[existing].mtimeMs) out[existing] = meta;
        continue;
      }
      seen.set(id, out.length);
      out.push(meta);
    }
  };

  for (const dir of await readDirCandidates(safeSession, workspaceDir)) {
    await walk(dir, "");
  }
  // 登记产物（任意位置创建的文件）：当前仍存在于磁盘的条目并入列表
  const workDir = workDirRoot(workspaceDir);
  for (const e of registry) {
    // CLI 内部文件（tool-results / subagents / .codebuddy 沙箱）不展示
    if (isCliInternalAbsPath(e.absPath)) continue;
    // 临时 run 目录（快思考/复核/研究任务）的登记条目不展示
    if (isTempRunPath(e.absPath)) continue;
    if ((await readDirCandidates(sessionId, workspaceDir)).some((dir) => {
      const rel = path.relative(dir, e.absPath);
      return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && excludedFromList(rel);
    })) continue;
    // 工作目录根散落文件：登记时刻之前就存在 → 工程脚手架文件，不是本轮产物（不展示）
    if (!(await shouldShowWorkFile(e, workDir))) continue;
    if (seen.has(e.id)) continue;
    const stat = await fs
      .stat(e.absPath, { bigint: true })
      .catch(() => null as import("node:fs").BigIntStats | null);
    if (!stat) continue;
    // 展示用完整相对路径：登记产物（name 常为 basename）优先按会话目录 / 工作目录根换算相对路径，
    // 让前端导航与文件夹归组能显示 hello/sub/x.txt 这类完整路径；都算不出则退回 basename。
    let rel = e.name;
    for (const dir of await readDirCandidates(sessionId, workspaceDir)) {
      const r = path.relative(dir, e.absPath);
      if (r && !r.startsWith("..") && !path.isAbsolute(r)) { rel = r.split("\\").join("/"); break; }
    }
    if (rel === e.name) {
      const r = path.relative(workDir, e.absPath);
      if (r && !r.startsWith("..") && !path.isAbsolute(r)) rel = r.split("\\").join("/");
    }
    if (excludedFromList(rel)) continue;
    seen.set(e.id, out.length);
    out.push({
      id: e.id,
      name: e.name,
      rel,
      type: e.type,
      size: Number(stat.size),
      mtimeMs: Number(stat.mtimeMs),
      dir: path.dirname(e.absPath),
    });
  }
  // 最新产物在前：右侧列表首项与自动预览（list[0]）都指向最新生成的文件
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** 安全读取产物：在产物根与沙箱候选会话目录内查找（产物根优先），任何穿越尝试返回 null；
 *  会话目录未命中时，回查登记表（registry）：模型写到任意位置的文件按登记 id/name 读原路径，
 *  仅限已登记的真实路径（任意 id 无法读取未登记文件）。 */
export async function readArtifact(
  sessionId: string,
  id: string,
  workspaceDir?: string,
): Promise<{ buf: Buffer; mime: string } | null> {
  const safeSession = sanitizeSessionId(sessionId);
  const safeId = sanitizeArtifactName(id);
  for (const dir of await readDirCandidates(safeSession, workspaceDir)) {
    const expected = path.resolve(dir);
    const resolved = path.resolve(dir, safeId);
    if (resolved !== expected && !resolved.startsWith(expected + path.sep)) continue;
    try {
      const buf = await fs.readFile(resolved);
      // docx 原文件直接返回：前端 WordArtifact 用 mammoth(浏览器版) 转换渲染，输入/产物统一走原文件
      return { buf, mime: mimeFor(safeId) };
    } catch {
      /* 尝试下一个候选目录 */
    }
  }
  // 登记产物（原位置即产物）：按 id（ext-xxx-... 或工作目录根文件名）精确匹配登记条目
  for (const e of await loadRegistry(sessionId, workspaceDir)) {
    if (e.id !== safeId && e.name !== safeId) continue;
    // 双重校验：只读登记过的真实路径本身（路径穿越 / 篡改一律拒绝）
    if (path.resolve(e.absPath) !== e.absPath) continue;
    try {
      const buf = await fs.readFile(e.absPath);
      return { buf, mime: mimeFor(e.name) };
    } catch {
      return null;
    }
  }
  return null;
}

/** 与 readArtifact 相同的访问范围，用于仅在有人预览时监听文件变化。 */
export async function artifactWatchPath(sessionId: string, id: string, workspaceDir?: string): Promise<string | null> {
  const safeSession = sanitizeSessionId(sessionId);
  const safeId = sanitizeArtifactName(id);
  if (!safeId) return null;
  for (const dir of await readDirCandidates(safeSession, workspaceDir)) {
    const base = path.resolve(dir);
    const target = path.resolve(base, safeId);
    if (target === base || !target.startsWith(base + path.sep)) continue;
    try { if ((await fs.stat(target)).isFile()) return target; } catch { /* try next root */ }
  }
  for (const entry of await loadRegistry(sessionId, workspaceDir)) {
    if (entry.id !== safeId && entry.name !== safeId) continue;
    if (path.resolve(entry.absPath) !== entry.absPath) continue;
    try { if ((await fs.stat(entry.absPath)).isFile()) return entry.absPath; } catch { /* deleted */ }
  }
  return null;
}

/** 解析会话输出目录内已存在的目标（文件或目录），返回落在候选目录内的绝对路径；防穿越。 */
async function resolveSessionTarget(
  sessionId: string,
  rel: string,
  workspaceDir: string | undefined,
  wantDir: boolean,
): Promise<string | null> {
  const safe = sanitizeArtifactName(rel);
  if (!safe) return null;
  for (const dir of await readDirCandidates(sessionId, workspaceDir)) {
    const base = path.resolve(dir);
    const resolved = path.resolve(base, safe);
    if (resolved === base || !resolved.startsWith(base + path.sep)) continue;
    const st = await fs.stat(resolved).catch(() => null);
    if (st && (wantDir ? st.isDirectory() : st.isFile())) return resolved;
  }
  return null;
}

/** 删除产物：会话目录内文件/目录（目录递归），并同步移除登记表中命中的条目。 */
export async function deleteArtifactTarget(
  sessionId: string,
  rel: string,
  isDir: boolean,
  workspaceDir?: string,
): Promise<boolean> {
  const safe = sanitizeArtifactName(rel);
  const abs = await resolveSessionTarget(sessionId, rel, workspaceDir, isDir);
  let removed = false;
  if (abs) {
    await fs.rm(abs, { recursive: isDir, force: true });
    removed = true;
  }
  await mutateRegistry(sessionId, workspaceDir, (entries) => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const hit = abs
        ? e.absPath === abs || (isDir && e.absPath.startsWith(abs + path.sep))
        : e.id === safe || e.name === path.basename(safe);
      if (!hit) continue;
      void fs.rm(e.absPath, { recursive: isDir, force: true }).catch(() => {});
      entries.splice(i, 1);
    }
  });
  return removed;
}

/** 重命名产物（文件/目录，仅限会话目录内）：同目录改名，同步更新登记表条目。 */
export async function renameArtifactTarget(
  sessionId: string,
  rel: string,
  newName: string,
  isDir: boolean,
  workspaceDir?: string,
): Promise<boolean> {
  const abs = await resolveSessionTarget(sessionId, rel, workspaceDir, isDir);
  if (!abs) return false;
  const clean = sanitizeArtifactName(newName);
  const baseName = clean.split("/").pop() || clean;
  if (!baseName || baseName === "." || baseName === "..") return false;
  const dest = path.join(path.dirname(abs), baseName);
  if (dest === abs) return true;
  try {
    await fs.access(dest);
    return false; // 目标已存在
  } catch {
    /* 不存在可改名 */
  }
  await fs.rename(abs, dest);
  await mutateRegistry(sessionId, workspaceDir, async (entries) => {
    for (const e of entries) {
      const hit = isDir ? e.absPath === abs || e.absPath.startsWith(abs + path.sep) : e.absPath === abs;
      if (!hit) continue;
      e.absPath = isDir && e.absPath.startsWith(abs + path.sep)
        ? dest + e.absPath.slice(abs.length)
        : dest;
      e.name = path.basename(e.absPath);
      // 会话目录内条目：id 重新取相对候选目录的 posix 路径
      for (const dir of await readDirCandidates(sessionId, workspaceDir)) {
        const relP = path.relative(dir, e.absPath);
        if (relP && !relP.startsWith("..") && !path.isAbsolute(relP)) {
          e.id = sanitizeArtifactName(relP.split("\\").join("/"));
          break;
        }
      }
    }
  });
  return true;
}

/** Move a session artifact into an existing session folder. Never overwrite a target. */
export async function moveArtifactTarget(
  sessionId: string, rel: string, destination: string, isDir: boolean, workspaceDir?: string,
): Promise<boolean> {
  const abs = await resolveSessionTarget(sessionId, rel, workspaceDir, isDir);
  const dir = destination
    ? await resolveSessionTarget(sessionId, destination, workspaceDir, true)
    : (await readDirCandidates(sessionId, workspaceDir)).find((base) => abs?.startsWith(path.resolve(base) + path.sep));
  if (!abs || !dir || (isDir && (dir === abs || dir.startsWith(abs + path.sep)))) return false;
  const target = path.join(dir, path.basename(abs));
  if (target === abs) return true;
  if (await fs.stat(target).catch(() => null)) return false;
  await fs.rename(abs, target);
  await mutateRegistry(sessionId, workspaceDir, async (entries) => {
    const candidates = await readDirCandidates(sessionId, workspaceDir);
    for (const entry of entries) {
      if (entry.absPath !== abs && !(isDir && entry.absPath.startsWith(abs + path.sep))) continue;
      entry.absPath = target + entry.absPath.slice(abs.length);
      entry.name = path.basename(entry.absPath);
      for (const base of candidates) {
        const relative = path.relative(base, entry.absPath);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          entry.id = sanitizeArtifactName(relative.split(path.sep).join("/"));
          break;
        }
      }
    }
  });
  return true;
}

/** 在会话目录内新建文件夹：rel 为所在目录相对会话根的路径（"" = 会话根），name 为单级文件夹名。
 *  返回 "ok" | "exists"（同名文件夹或文件已存在）| null（其他失败）。 */
export async function createArtifactFolder(
  sessionId: string,
  rel: string,
  name: string,
  workspaceDir?: string,
): Promise<"ok" | "exists" | null> {
  const raw = String(name ?? "").trim();
  if (!raw) return null;
  const clean = sanitizeArtifactName(raw);
  const baseName = clean.split("/").pop() || clean;
  if (!baseName || baseName === "." || baseName === "..") return null;
  const parent = rel ? await resolveSessionTarget(sessionId, rel, workspaceDir, true) : await ensureSessionDir(sessionId, workspaceDir);
  if (!parent) return null;
  try {
    await fs.mkdir(path.join(parent, baseName));
    return "ok";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    return null;
  }
}

/** 把会话目录内某个文件夹打包为 zip（内存生成），返回 buffer 与建议文件名。 */
export async function zipFolderBuffer(
  sessionId: string,
  rel: string,
  workspaceDir?: string,
): Promise<{ buf: Buffer; name: string } | null> {
  const abs = await resolveSessionTarget(sessionId, rel, workspaceDir, true);
  if (!abs) return null;
  const zip = new JSZip();
  const baseName = path.basename(abs);
  // 根目录本身作为压缩包内文件夹条目（空目录也能在解压后保留）
  zip.folder(`${baseName}/`);
  // 递归打包：文件夹本身作为压缩包根目录（解压后得到 <baseName>/...），子目录一并保留；空目录显式写入条目
  const walk = async (dir: string, zipPrefix: string) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = path.join(dir, e.name);
      const relPath = zipPrefix ? `${zipPrefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        zip.folder(`${baseName}/${relPath}/`);
        await walk(child, relPath);
      } else {
        const data = await fs.readFile(child).catch(() => null);
        if (data) zip.file(`${baseName}/${relPath}`, data);
      }
    }
  };
  await walk(abs, "");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return { buf, name: `${baseName}.zip` };
}

/** 构造前端拉取产物的隔离 URL（session 与 file 均经编码，服务端二次校验） */
export function artifactUrl(basePath: string, sessionId: string, id: string): string {
  const bp = (basePath || "/").replace(/\/+$/, "");
  return `${bp}/api/artifact?session=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(id)}`;
}

/** 将助手 Markdown 中引用的临时图片收进会话产物目录，返回浏览器可访问的正文。 */
export async function materializeInlineImages(
  content: string,
  sessionId: string,
  basePath: string,
  workspaceDir?: string,
): Promise<string> {
  const image = /!\[([^\]\n]*)\]\((<?)(\/[^\s)>]+)(>?)\)/g;
  const matches = [...content.matchAll(image)];
  if (!matches.length) return content;
  const tempRoots = await Promise.all(["/tmp", "/private/tmp", os.tmpdir()].map((dir) => fs.realpath(dir).catch(() => "")));
  const replacements = new Map<string, string>();
  for (const match of matches) {
    const source = match[3];
    if (replacements.has(source)) continue;
    const ext = path.extname(source).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) continue;
    try {
      const real = await fs.realpath(source);
      if (!tempRoots.some((root) => root && real.startsWith(root + path.sep))) continue;
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size === 0 || stat.size > 20 * 1024 * 1024) continue;
      const data = await fs.readFile(real);
      const valid = ext === ".png" ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : ext === ".gif" ? data.subarray(0, 3).toString() === "GIF"
        : ext === ".webp" ? data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP"
        : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      if (!valid) continue;
      const name = `inline-${createHash("sha256").update(data).digest("hex").slice(0, 16)}${ext}`;
      const dir = artifactSessionDir(sessionId, workspaceDir);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, name), data, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      replacements.set(source, artifactUrl(basePath, sessionId, name));
    } catch {
      // 临时文件已被清理时保留原文，不能凭文件名猜测图片内容。
    }
  }
  return content.replace(image, (full, alt: string, open: string, source: string, close: string) => {
    const url = replacements.get(source);
    return url && Boolean(open) === Boolean(close) ? `![${alt}](${url})` : full;
  });
}

/**
 * 脱敏（第一道）：把「真实产物根目录」替换成虚拟标记 /agent-output。
 * 同时处理 Windows 盘符路径（D:\...\agent-output）与 CLI 使用的 bash 风格路径（/d/.../agent-output），
 * 避免任一真实路径残留在模型输出中。
 */
export function redactArtifactPaths(text: string): string {
  const root = artifactRoot();
  const posix = root.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  return String(text ?? "").split(root).join(ARTIFACT_VIRTUAL_ROOT).split(posix).join(ARTIFACT_VIRTUAL_ROOT);
}

/**
 * 脱敏：抹掉模型可能复述的虚拟输出路径标记（/agent-output...），
 * 避免内部约定外泄。配合系统提示（不要提路径）作为安全网。
 */
export function redactOutputPaths(text: string): string {
  return String(text ?? "").replace(/\/agent-output(?:\/[^\s)<>"']*)?/g, "");
}

/**
 * 清洗助手文本里的限流噪音（服务端源头，防止 429 错误进入回复正文/存库）：
 *  - CLI transcript 会给消息加 trace 前缀（(32hex/uuid)），剥离前缀、保留正文；
 *  - 429 频率限制错误整段（可能带 trace 前缀/后缀）直接丢弃；
 *  - 内容若清洗后为空（纯错误轮次），返回空串，前端不展示空气泡。
 */
export function sanitizeAssistantText(text: string): string {
  if (!text) return text;
  const out: string[] = [];
  for (const rawLine of String(text).split("\n")) {
    // 保留行首缩进（代码块排版依赖），清洗只作用于行内容本身：
    // 此前对每行 trim() 会系统性剥掉代码块缩进（44/44 代码块行首空格丢失的根因）。
    const leading = /^[ \t]*/.exec(rawLine)?.[0] ?? "";
    const trimmed = rawLine.trim();
    if (!trimmed) {
      out.push("");
      continue;
    }
    let rest = trimmed.replace(
      /^\(\s*[0-9a-fA-F]{8,}\s*\/\s*[0-9a-fA-F-]{8,}[^)\n]*\)\s*/,
      "",
    );
    if (/429/.test(rest) && /频率限制|rate\s*[- ]?limit/i.test(rest)) continue;
    if (!rest.trim()) continue;
    rest = rest.replace(/429[^\n]*?频率限制[^\n]*$/i, "");
    out.push(leading + rest);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}
