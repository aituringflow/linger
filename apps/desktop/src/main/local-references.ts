import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * 本机文件引用登记表（与早期本地宿主实现保持同一份语义）。
 *
 * 渲染层选择/拖入的文件在 Electron 里拿不到绝对路径，只有 File 对象；preload 用
 * webUtils.getPathForFile 取出真实路径后交给这里登记，返回一个 local-ref:// 句柄。
 * 之后的消息附件、图片预览、模型读文件都只认这个句柄：
 *   - 渲染层预览：local-ref → AgentWindow.resolveFileUrl → /file-ref?ref=…（本地 Agent 服务读取）
 *   - 发给模型：local-agent 用 resolve() 换回绝对路径，作为只读引用注入本轮 prompt
 * 句柄带 machineId，拷贝到别的机器上自然失效，不会误读同名路径。
 */
export type LocalReference = {
  id: string;
  name: string;
  path: string;
  kind: "file" | "folder";
  size: number;
  createdAt: string;
  sourceFileId?: string;
};

type SavedReferences = { machineId: string; references: LocalReference[]; workspaces: Record<string, string> };

export class LocalReferenceStore {
  readonly machineId: string;
  private readonly file: string;
  private readonly references = new Map<string, LocalReference>();
  private readonly workspaces = new Map<string, string>();

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, "local-references.json");
    let saved: Partial<SavedReferences> = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, "utf8")) as SavedReferences; } catch { /* first launch */ }
    this.machineId = typeof saved.machineId === "string" && /^[0-9a-f-]{36}$/i.test(saved.machineId)
      ? saved.machineId : randomUUID();
    for (const ref of saved.references ?? []) {
      if (ref && typeof ref.id === "string" && typeof ref.path === "string") this.references.set(ref.id, ref);
    }
    for (const [sessionId, directory] of Object.entries(saved.workspaces ?? {})) {
      if (/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) && typeof directory === "string") this.workspaces.set(sessionId, directory);
    }
    this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ machineId: this.machineId, references: [...this.references.values()], workspaces: Object.fromEntries(this.workspaces) }), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  register(paths: string[], sourceFileId?: string): LocalReference[] {
    const added: LocalReference[] = [];
    for (const input of paths) {
      if (!path.isAbsolute(input)) continue;
      let real: string;
      let info: fs.Stats;
      try {
        real = fs.realpathSync(input);
        info = fs.statSync(real);
      } catch { continue; }
      if (!info.isFile() && !info.isDirectory()) continue;
      const existing = [...this.references.values()].find((ref) => ref.path === real && ref.sourceFileId === sourceFileId);
      if (existing) { added.push(existing); continue; }
      const ref: LocalReference = {
        id: randomUUID(), name: path.basename(real), path: real,
        kind: info.isDirectory() ? "folder" : "file", size: info.isFile() ? info.size : 0,
        createdAt: new Date().toISOString(), ...(sourceFileId ? { sourceFileId } : {}),
      };
      this.references.set(ref.id, ref);
      added.push(ref);
    }
    if (added.length) this.save();
    return added;
  }

  get(id: string): LocalReference | null { return this.references.get(id) ?? null; }

  list(): Array<LocalReference & { available: boolean }> {
    return [...this.references.values()].map((ref) => ({ ...ref, available: fs.existsSync(ref.path) }));
  }

  remove(id: string): boolean {
    const removed = this.references.delete(id);
    if (removed) this.save();
    return removed;
  }

  workspace(sessionId: string): string | null {
    const directory = this.workspaces.get(sessionId);
    return directory && fs.existsSync(directory) ? directory : null;
  }

  workspaceMap(): Record<string, string> { return Object.fromEntries(this.workspaces); }

  setWorkspace(sessionId: string, directory: string | null): void {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) throw new Error("无效的会话 ID");
    if (directory) {
      const real = fs.realpathSync(directory);
      if (!fs.statSync(real).isDirectory()) throw new Error("工作空间必须是本机文件夹");
      // 只接受用户经系统选择框或拖放登记过的目录。
      if (![...this.references.values()].some((ref) => ref.path === real && ref.kind === "folder")) throw new Error("请先选择该本机文件夹");
      this.workspaces.set(sessionId, real);
    } else this.workspaces.delete(sessionId);
    this.save();
  }

  url(ref: LocalReference): string { return `local-ref://${this.machineId}/${ref.id}`; }

  resolve(url: string): LocalReference | null {
    const match = /^local-ref:\/\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(url);
    if (!match || match[1] !== this.machineId) return null;
    const ref = this.get(match[2]);
    return ref && fs.existsSync(ref.path) ? ref : null;
  }
}
