import * as fs from "node:fs/promises";
import path from "node:path";
import { artifactRoot, uploadStorageDir, artifactType, ensureSessionDir, readArtifact, saveRegistry, sanitizeArtifactName, type RegistryEntry } from "./artifacts.js";
import type { AgentMessageRow } from "./auth/db.js";

export function nextBranchTitle(title: string, existing: Iterable<string>): string {
  const used = new Set(existing);
  const base = title.replace(/（\d+）$/, "");
  for (let n = 1; ; n++) {
    const suffix = `（${n}）`;
    const candidate = base.slice(0, 250 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

export function selectBranchMessages(messages: AgentMessageRow[], index: number, messageId?: number): AgentMessageRow[] {
  const end = messageId === undefined ? index : messages.findIndex((message) => message.id === messageId);
  if (!Number.isSafeInteger(end) || end < 0 || end >= messages.length || messages[end].role !== "assistant") {
    throw new Error("所选答复尚未保存或已发生变化，请刷新后重试");
  }
  return structuredClone(messages.slice(0, end + 1));
}

/** Preserve still-visible browser steps/long text while keeping file references server-owned. */
export function mergeBranchSnapshot(messages: AgentMessageRow[], snapshot?: unknown): AgentMessageRow[] {
  if (snapshot === undefined) return messages;
  if (!Array.isArray(snapshot) || snapshot.length !== messages.length) throw new Error("会话内容已变化，请刷新后重试");
  return messages.map((message, index) => {
    const live = snapshot[index];
    if (!live || live.role !== message.role || typeof live.content !== "string" || (live.id !== undefined && live.id !== message.id)
      || (live.content !== message.content && live.content.slice(0, 20000) !== message.content)) throw new Error("会话内容已变化，请刷新后重试");
    return { ...message, content: live.content, images: Array.isArray(live.images) ? live.images : message.images,
      steps: Array.isArray(live.steps) ? live.steps : message.steps };
  });
}

/** Independent files prevent deleting/editing the source from breaking the branch. */
export async function copyBranchFiles(sourceId: string, targetId: string, messages: AgentMessageRow[], workspaceDir?: string) {
  const copies: string[] = [];
  const replacements = new Map<string, string>();
  const sourceUploads = uploadStorageDir(sourceId);
  const targetUploads = uploadStorageDir(targetId);
  const result = structuredClone(messages);
  let folder: string | undefined;
  const cleanup = async () => {
    await Promise.all(copies.map((file) => fs.unlink(file).catch(() => {})));
    // Resolve and check the generated UUID directory before removing anything recursively.
    if (folder && path.basename(path.resolve(folder)) === targetId) await fs.rm(path.resolve(folder), { recursive: true, force: true });
    if (folder) await saveRegistry(targetId, [], workspaceDir);
  };
  try {
  // Only server-stored attachment URLs are allowed to select upload files.
  for (const message of result) {
    const value = message.attachment;
    for (const attachment of (Array.isArray(value) ? value : value ? [value] : []) as { url?: string }[]) {
      if (!attachment?.url?.startsWith("/api/upload?")) continue;
      if (replacements.has(attachment.url)) continue;
      const parsed = new URL(attachment.url, "http://local");
      const name = parsed.searchParams.get("name") || "";
      if (parsed.searchParams.get("session") !== sourceId || !name || name !== path.basename(name) || name.includes("\\")) throw new Error("附件路径无效");
      const privateSource = path.join(sourceUploads, name);
      const source = await fs.access(privateSource).then(() => privateSource).catch(() => { throw new Error("附件文件不可用，未创建分支"); });
      const target = path.join(targetUploads, name);
      await fs.mkdir(targetUploads, { recursive: true });
      try { await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL); }
      catch { throw new Error("附件文件不可用，未创建分支"); }
      copies.push(target);
      replacements.set(attachment.url, `/api/upload?session=${encodeURIComponent(targetId)}&name=${encodeURIComponent(name)}`);
    }
  }
    folder = await ensureSessionDir(targetId, workspaceDir);
    const staging = path.join(workspaceDir ? path.resolve(workspaceDir) : folder, "attachments");
    for (const url of replacements.values()) {
      if (!url.startsWith("/api/upload?")) continue;
      const name = new URL(url, "http://local").searchParams.get("name") || "";
      await fs.mkdir(staging, { recursive: true });
      const target = path.join(staging, name);
      if (path.resolve(target) !== path.resolve(path.join(targetUploads, name))) {
        await fs.copyFile(path.join(targetUploads, name), target, fs.constants.COPYFILE_EXCL);
        copies.push(target);
      }
    }
    const files = new Map<string, Record<string, unknown>>();
    const created = new Set<string>();
    for (const message of result) for (const item of Array.isArray(message.artifacts) ? message.artifacts : []) {
      if (!item || typeof item.id !== "string" || item.type === "browser") continue;
      if (item.change === "added" || !item.change) created.add(item.id);
      files.set(item.id, item);
    }
    const entries: RegistryEntry[] = [];
    for (const [id, file] of files) {
      if (file.change === "deleted") continue;
      const name = sanitizeArtifactName(id);
      const target = path.resolve(folder, name);
      if (!target.startsWith(path.resolve(folder) + path.sep)) throw new Error("产出物路径无效");
      const content = typeof file.newContent === "string" ? Buffer.from(file.newContent) : (await readArtifact(sourceId, id, workspaceDir))?.buf;
      if (!content) throw new Error(`产出物 ${String(file.name ?? id)} 不可用，未创建分支`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: "wx" });
      entries.push({ id: name, name: String(file.name ?? name), absPath: target, type: artifactType(name), origin: "model", createdBySession: created.has(id), lastSeen: true, size: content.length });
    }
    await saveRegistry(targetId, entries, workspaceDir);
    // Rewrite embedded upload links and artifact session URLs throughout message metadata.
    replacements.set(`/agent-output/${sourceId}/`, `/agent-output/${targetId}/`);
    replacements.set(`session=${encodeURIComponent(sourceId)}`, `session=${encodeURIComponent(targetId)}`);
    const rewrite = (value: unknown): unknown => {
      if (typeof value === "string") {
        for (const [before, after] of replacements) value = (value as string).split(before).join(after);
        return value;
      }
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
      return value;
    };
    return { messages: result.map((message) => {
      const copied = rewrite(message) as AgentMessageRow;
      if (Array.isArray(copied.artifacts)) copied.artifacts = copied.artifacts.map((file) => {
        const entry = entries.find((entry) => entry.id === file.id);
        return entry ? { ...file, dir: path.dirname(entry.absPath) } : file;
      });
      return copied;
    }), cleanup };
  } catch (error) { await cleanup(); throw error; }
}
