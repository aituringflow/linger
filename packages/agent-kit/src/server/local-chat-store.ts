import fs from "node:fs";
import path from "node:path";
import { appHomePath } from "./app-home.js";

/**
 * 本地运行模式的会话落盘存储（替代云端 /api/sessions、/messages）。
 *
 * 只存放本机「用户 ↔ AI」单聊；与其他人的群聊/1v1 人际会话仍走云端，不进此存储。
 *
 * 布局（按用户隔离）：
 *   <rootDir>/<owner>/<sid>.json     owner = base64url("<provider>:<unionId>")
 *   { meta: SessionItem, messages: UiMessage[], updatedAt }
 *
 * 为什么要分用户目录：同一台机器可能换账号登录（web 与桌面宿主共用身份键），
 * 平铺存储会让 B 用户登录后看到 A 用户的会话。这里做的是**逻辑隔离**——磁盘上依旧是
 * 明文 JSON，能看文件的人当然能读别人的；要防这个得另加按用户密钥的加密（后续）。
 *
 * 读取走内存镜像（按 owner 懒加载），写操作先更新内存再防抖原子落盘；读取走内存，
 * 无容量上限（不像 localStorage 受 ~5MB 限制）。
 */

export type StoredChat = {
  meta: Record<string, unknown>;
  messages: unknown[];
  updatedAt: string;
};

/** 会话 id：uuid 形态，同时作为文件名，必须严格过滤（防路径穿越）。 */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
/** 用户键：与 agent-kit 的 encodeUserKey（base64url）同口径。 */
const OWNER_RE = /^[a-zA-Z0-9_-]{1,200}$/;
/** 老版本平铺文件的归属标记：迁移过一次就不再抢，避免第二个账号把别人的会话吞掉。 */
const LEGACY_MARKER = ".legacy-owner";

export class LocalChatStore {
  private readonly root: string;
  /** owner -> (sid -> chat)；按 owner 懒加载 */
  private readonly chats = new Map<string, Map<string, StoredChat>>();
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(rootDir = appHomePath("chats")) {
    // 默认与应用主目录（~/.<AGENT_APP_NAME>，未声明时 ~/.agent）对齐，并与 Electron userData 解耦；
    // 宿主可传独立目录，避免多个应用共享会话。
    this.root = path.resolve(rootDir);
    fs.mkdirSync(this.root, { recursive: true });
  }

  private safeId(id: unknown): string | null {
    return typeof id === "string" && SESSION_ID_RE.test(id) ? id : null;
  }

  private safeOwner(owner: unknown): string | null {
    return typeof owner === "string" && OWNER_RE.test(owner) ? owner : null;
  }

  private dirOf(owner: string): string {
    return path.join(this.root, owner);
  }

  private fileOf(owner: string, id: string): string {
    return path.join(this.dirOf(owner), `${id}.json`);
  }

  private writeKey(owner: string, id: string): string {
    return `${owner}/${id}`;
  }

  /**
   * 老数据迁移：v1 把会话平铺在 rootDir/*.json（没有属主概念）。
   * 第一次带 owner 访问时把它们整体归到该用户名下（单机升级＝当前登录用户就是原作者），
   * 之后写 .legacy-owner 标记，第二个账号不会再来吞。
   */
  private migrateLegacy(owner: string): void {
    const marker = path.join(this.root, LEGACY_MARKER);
    if (fs.existsSync(marker)) return;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch { return; }
    const legacy = entries.filter((name) => name.endsWith(".json") && SESSION_ID_RE.test(name.slice(0, -5)));
    if (legacy.length) {
      const dir = this.dirOf(owner);
      try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
      for (const name of legacy) {
        try { fs.renameSync(path.join(this.root, name), path.join(dir, name)); } catch { /* 单个失败不影响其余 */ }
      }
    }
    try { fs.writeFileSync(marker, owner, "utf8"); } catch { /* 标记写不了下次再试 */ }
  }

  /** 取（必要时加载）某用户的会话表。 */
  private bucket(owner: string): Map<string, StoredChat> {
    const existing = this.chats.get(owner);
    if (existing) return existing;
    const map = new Map<string, StoredChat>();
    this.chats.set(owner, map);
    this.migrateLegacy(owner);
    const dir = this.dirOf(owner);
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return map; }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!SESSION_ID_RE.test(id)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as Partial<StoredChat>;
        if (parsed && typeof parsed === "object" && parsed.meta && typeof parsed.meta === "object") {
          map.set(id, {
            meta: parsed.meta as Record<string, unknown>,
            messages: Array.isArray(parsed.messages) ? parsed.messages : [],
            updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
          });
        }
      } catch { /* 损坏文件跳过，不阻塞启动 */ }
    }
    return map;
  }

  /** 某用户的会话元数据列表（按 updatedAt 倒序；无 updatedAt 排末尾）。 */
  list(owner: unknown): Record<string, unknown>[] {
    const safe = this.safeOwner(owner);
    if (!safe) return [];
    return [...this.bucket(safe).values()]
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
      .map((chat) => {
        const messages = chat.messages as Array<{ role?: unknown; content?: unknown }>;
        const latest = [...messages].reverse().find((message) => typeof message.content === "string" && message.content.trim());
        const reply = [...messages].reverse().find((message) => message.role === "assistant" && typeof message.content === "string" && message.content.trim());
        return {
          ...chat.meta,
          lastPreview: chat.meta.lastPreview || latest?.content || null,
          lastAssistantText: reply?.content || null,
        };
      });
  }

  get(owner: unknown, id: string): StoredChat | null {
    const safe = this.safeOwner(owner);
    if (!safe) return null;
    return this.bucket(safe).get(id) ?? null;
  }

  /** 整体写入：合并 meta、替换 messages，刷新 updatedAt。 */
  save(owner: unknown, id: string, meta: Record<string, unknown>, messages: unknown[]): void {
    const safeOwner = this.safeOwner(owner);
    const safe = this.safeId(id);
    if (!safeOwner || !safe) return;
    const updatedAt = typeof meta.updatedAt === "string" && meta.updatedAt ? meta.updatedAt : new Date().toISOString();
    this.bucket(safeOwner).set(safe, { meta: { ...meta, id: safe, updatedAt }, messages, updatedAt });
    this.scheduleWrite(safeOwner, safe);
  }

  /** 只更新元数据（标题/置顶/工作目录等），保留已有 messages。 */
  patchMeta(owner: unknown, id: string, patch: Record<string, unknown>): void {
    const safeOwner = this.safeOwner(owner);
    const safe = this.safeId(id);
    if (!safeOwner || !safe) return;
    const bucket = this.bucket(safeOwner);
    const existing = bucket.get(safe);
    if (!existing) return;
    bucket.set(safe, { ...existing, meta: { ...existing.meta, ...patch, id: safe } });
    this.scheduleWrite(safeOwner, safe);
  }

  rename(owner: unknown, id: string, title: string): void {
    this.patchMeta(owner, id, { title });
  }

  setPinned(owner: unknown, id: string, pinOrder: number | null): void {
    this.patchMeta(owner, id, { pinOrder });
  }

  remove(owner: unknown, id: string): void {
    const safeOwner = this.safeOwner(owner);
    const safe = this.safeId(id);
    if (!safeOwner || !safe) return;
    try {
      fs.unlinkSync(this.fileOf(safeOwner, safe));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.bucket(safeOwner).delete(safe);
    const key = this.writeKey(safeOwner, safe);
    const timer = this.pending.get(key);
    if (timer) { clearTimeout(timer); this.pending.delete(key); }
  }

  /** 删除某用户的**全部**本地会话（删除账号时清理本机数据；不可恢复）。 */
  removeOwner(owner: unknown): void {
    const safe = this.safeOwner(owner);
    if (!safe) return;
    // 先清掉该 owner 的防抖写盘任务：否则内存残留会在下次 flush 时把文件写回来
    for (const [key, timer] of [...this.pending]) {
      if (key.startsWith(`${safe}/`)) {
        clearTimeout(timer);
        this.pending.delete(key);
      }
    }
    this.chats.delete(safe);
    try {
      fs.rmSync(this.dirOf(safe), { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private scheduleWrite(owner: string, id: string): void {
    const key = this.writeKey(owner, id);
    const previous = this.pending.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => this.flush(owner, id), 250);
    this.pending.set(key, timer);
  }

  private flush(owner: string, id: string): void {
    this.pending.delete(this.writeKey(owner, id));
    const chat = this.chats.get(owner)?.get(id);
    if (!chat) return;
    try {
      fs.mkdirSync(this.dirOf(owner), { recursive: true });
      const temp = `${this.fileOf(owner, id)}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(chat), "utf8");
      fs.renameSync(temp, this.fileOf(owner, id));
    } catch { /* 落盘失败不影响内存态；下次写盘重试 */ }
  }

  /** 退出前把防抖未落盘的内容一次性写尽。 */
  flushAll(): void {
    for (const key of [...this.pending.keys()]) {
      const [owner, id] = key.split("/");
      const timer = this.pending.get(key);
      if (timer) clearTimeout(timer);
      if (owner && id) this.flush(owner, id);
    }
  }
}
