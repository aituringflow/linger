/**
 * agent-kit · 用户数据库层（PostgreSQL）
 *
 * 职责：
 *   - 从 env（POSTGRES_*）懒加载连接池（进程级单例）；
 *   - 幂等执行 schema.sql 建表（migrate）；
 *   - 提供用户仓储：upsertUser（认证后落库/更新）、findUserByProvider、
 *     touchLastLogin。
 *
 * 仅放"公共、可复用"的代码；具体调用方（web 的路由）在 app 侧。
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { AuthUser } from "./types.js";
import { parseSessionKey } from "./session.js";
import { createHash, randomUUID } from "node:crypto";
import { copyBranchFiles, mergeBranchSnapshot, nextBranchTitle, selectBranchMessages } from "../session-fork.js";
import { capArtifactsForMessage } from "../artifacts.js";
import { isInvalidAutoTitle, quickSessionTitle } from "../session-title.js";
import { AI_DISPLAY_NAME } from "../names.js";
import { withRetry } from "../retry-policy.js";

export interface DbUser {
  id: number;
  provider: string;
  unionId: string;
  openId: string | null;
  userCode: string | null;
  name: string;
  avatar: string | null;
  email: string | null;
  mobile: string | null;
  deptName: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

/** 业务对象的 PostgreSQL 命名空间；运行期所有裸表名都解析到这里。 */
const DB_SCHEMA = "linger";

let pool: Pool | null = null;

function buildPool(): Pool | null {
  const host = process.env.POSTGRES_HOST;
  const user = process.env.POSTGRES_USER;
  const db = process.env.POSTGRES_DB;
  if (!host || !user || !db) return null; // 未配置数据库：认证仍可仅存于会话
  // pg 的启动参数（libpq options）在类型定义里没有声明，但运行期支持；
  // 用它把每条连接的默认命名空间设为 schema `linger`，避免连接复用时的竞态。
  const config: PoolConfig & { options?: string } = {
    options: `-c search_path=${DB_SCHEMA},public`,
    host,
    port: Number(process.env.POSTGRES_PORT || 5432),
    user,
    password: process.env.POSTGRES_PASSWORD || "",
    database: db,
    max: 5,
    idleTimeoutMillis: 30_000,
    // 数据库在远程主机，冷启动/网络抖动时 10s 建连偏紧，
    // 放宽到 20s 并支持 POSTGRES_CONNECT_TIMEOUT_MS 环境变量覆盖。
    connectionTimeoutMillis: Number(process.env.POSTGRES_CONNECT_TIMEOUT_MS || 20_000),
    // 代理/隧道链路（如 Clash fake-ip 路由）偶发「服务端已出结果、返回路径卡死」：
    // 查询在服务端瞬间完成但客户端永远收不到数据，若不加超时，卡住的查询会吃满
    // 连接池（max:5），后续所有数据库请求全部排队 → 接口无限 pending。
    // query_timeout（客户端侧）+ statement_timeout（服务端侧）双保险，默认 15s，可经环境变量覆盖。
    query_timeout: Number(process.env.POSTGRES_QUERY_TIMEOUT_MS || 15_000),
    statement_timeout: Number(process.env.POSTGRES_QUERY_TIMEOUT_MS || 15_000),
  };
  const pool = new Pool(config);
  // pg 连接池必须监听 'error'：否则空闲连接上的错误会成为未处理的 error 事件，直接崩掉整个进程。
  pool.on("error", (err) => {
    console.error(
      "[agent-kit auth/db] 空闲连接错误（连接池自动清理，不影响后续请求）:",
      err instanceof Error ? err.message : err,
    );
  });
  return pool;
}

/**
 * 进程级一次性自动迁移（幂等 schema.sql）：
 * 首次使用数据库时后台执行一次，避免「schema.sql / db.ts 新增列后忘记手动跑
 * npm run db:migrate，导致 INSERT 引用不存在的列而静默失败、会话历史丢空」。
 * 幂等（全部 IF NOT EXISTS）可安全重复；失败只记日志，不影响本次连接使用。
 */
let migrateOnce: Promise<void> | null = null;
/** 数据库未就绪时后台补跑迁移：最多 5 次 × 5s ≈ 25s 内 DB 恢复即自动建表，避免「启动即失败、整个进程永不迁移」。 */
const MIGRATE_RETRY_MAX = 5;
let migrateRetries = 0;
export function ensureMigrated(): Promise<void> {
  if (!migrateOnce) {
    migrateOnce = migrate().catch((e) => {
      console.error(
        "[agent-kit auth/db] 自动迁移失败（将重试）:",
        e instanceof Error ? e.message : e,
      );
      migrateOnce = null; // 允许后续 DB 访问重新触发迁移，而不是整个进程生命周期内静默跳过
      if (migrateRetries < MIGRATE_RETRY_MAX) {
        migrateRetries += 1;
        setTimeout(() => {
          if (migrateOnce) return; // 期间已迁移成功，跳过补跑
          migrateOnce = null;
          void ensureMigrated();
        }, 5_000);
      }
    });
  }
  return migrateOnce;
}

// 进程启动即触发迁移（不等首次 DB 调用）：新列/新表在第一个请求到达前大概率就绪，
// 避免「首次 INSERT 与后台迁移竞态 → 列缺失 → 消息落库失败、历史丢空」。
if (isDbEnabled()) void ensureMigrated();

/** 进程级连接池单例；未配置 Postgres 时返回 null。 */
export function getPool(): Pool | null {
  if (pool) return pool;
  pool = buildPool();
  if (pool) void ensureMigrated();
  return pool;
}

/** 是否已启用数据库（配置了 Postgres 即启用；无开关，数据强制落库）。 */
export function isDbEnabled(): boolean {
  return Boolean(process.env.POSTGRES_HOST && process.env.POSTGRES_DB);
}

function loadSchemaSql(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // 源码直连时（Next/Turbopack chunk）import.meta.url 指向构建产物目录，
  // 按仓库结构回退到 SDK 源码目录，或读 Electron 打包资源目录 AGENT_KIT_SRC_ROOT。
  const candidates = [
    path.join(here, "schema.sql"),
    path.resolve(process.cwd(), "packages/agent-kit/src/server/auth/schema.sql"),
    path.resolve(process.cwd(), "../packages/agent-kit/src/server/auth/schema.sql"),
    path.resolve(process.cwd(), "../../packages/agent-kit/src/server/auth/schema.sql"),
    process.env.AGENT_KIT_SRC_ROOT ? path.join(process.env.AGENT_KIT_SRC_ROOT, "server/auth/schema.sql") : "",
  ].filter(Boolean);
  const file = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    // 不再内置一份"DLL 兜底"副本：两处定义必然漂移。构建会把 schema.sql 一起投递，
    // 读不到就是打包/启动路径出了问题，直接抛出足够定位的错误。
    throw new Error(`[agent-kit auth/db] 读不到 schema.sql（${file}）：${error instanceof Error ? error.message : error}`);
  }
}

/** 幂等建表；无数据库配置时静默跳过。 */
export async function migrate(): Promise<void> {
  const p = getPool();
  if (!p) {
    console.warn("[agent-kit auth/db] 未配置 Postgres，跳过 migrate（用户仅存于会话）。");
    return;
  }
  const client = await p.connect();
  try {
    const schema = loadSchemaSql();
    const version = createHash("sha256").update(schema).digest("hex");
    // 多个服务进程共享数据库时，只让一个进程执行 DDL。已应用的版本直接跳过，
    // 避免每次热重启都重新获取 users / agent_sessions 等表的排他锁。
    await client.query("SELECT pg_advisory_lock(271828, 314159)");
    try {
      // schema 必须先存在：连接池的 search_path 指向它，缺失时任何 CREATE TABLE 都会落到 public。
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${DB_SCHEMA}`);
      await client.query(`SET search_path TO ${DB_SCHEMA}, public`);
      await client.query("CREATE TABLE IF NOT EXISTS schema_versions (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
      const applied = await client.query("SELECT 1 FROM schema_versions WHERE version=$1", [version]);
      if (!applied.rowCount) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await client.query(schema);
            await client.query("INSERT INTO schema_versions(version) VALUES($1) ON CONFLICT DO NOTHING", [version]);
            break;
          } catch (error) {
            if ((error as { code?: string }).code !== "40P01" || attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
          }
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(271828, 314159)");
    }
  } finally {
    client.release();
  }
}

function rowToDbUser(row: Record<string, unknown>): DbUser {
  return {
    id: Number(row.id),
    provider: String(row.provider),
    unionId: String(row.union_id),
    openId: (row.open_id as string) ?? null,
    userCode: (row.user_code as string) ?? null,
    name: String(row.name ?? ""),
    avatar: (row.avatar as string) ?? null,
    email: (row.email as string) ?? null,
    mobile: (row.mobile as string) ?? null,
    deptName: (row.dept_name as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lastLoginAt: (row.last_login_at as Date) ?? null,
  };
}

/**
 * 将认证用户 upsert 到 users 表：按 (provider, union_id) 匹配，存在则更新档案与
 * last_login_at，不存在则插入。返回数据库行（含内部 id）。
 */
export async function upsertUser(user: AuthUser, client?: PoolClient): Promise<DbUser | null> {
  const p = client ?? getPool();
  if (!p) return null;

  const sql = `
    INSERT INTO users
      (provider, union_id, open_id, user_code, name, avatar, email, mobile, dept_name, raw_profile,
       fs_user_token, fs_refresh_token, last_login_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
    ON CONFLICT (provider, union_id) DO UPDATE SET
      open_id     = COALESCE(EXCLUDED.open_id, users.open_id),
      user_code   = COALESCE(EXCLUDED.user_code, users.user_code),
      -- 名字 / 头像以「库里已有的值」为准，只在库里为空时才用本次档案补上：
      -- builtin 登录读的就是库里的值（写回同值），用户手改的也不会被覆盖。
      name        = COALESCE(NULLIF(users.name, ''), EXCLUDED.name),
      avatar      = COALESCE(NULLIF(users.avatar, ''), EXCLUDED.avatar),
      email       = COALESCE(EXCLUDED.email, users.email),
      mobile      = COALESCE(EXCLUDED.mobile, users.mobile),
      dept_name   = COALESCE(EXCLUDED.dept_name, users.dept_name),
      raw_profile = COALESCE(EXCLUDED.raw_profile, users.raw_profile),
      fs_user_token     = COALESCE(EXCLUDED.fs_user_token, users.fs_user_token),
      fs_refresh_token  = COALESCE(EXCLUDED.fs_refresh_token, users.fs_refresh_token),
      last_login_at = now(),
      updated_at  = now()
    RETURNING *;
  `;
  const values = [
    user.provider,
    user.unionId,
    user.openId || null,
    user.userCode || null,
    user.name || "",
    user.avatar || null,
    user.email || null,
    user.mobile || null,
    user.deptName || null,
    user.raw ? JSON.parse(JSON.stringify(user.raw)) : null,
    user.oauthToken?.accessToken || null,
    user.oauthToken?.refreshToken || null,
  ];

  const runner = client ?? p;
  const result = await runner.query(sql, values);
  return result.rows[0] ? rowToDbUser(result.rows[0]) : null;
}

/** 按 (provider, union_id) 查用户；不存在返回 null。 */
export async function findUserByProvider(
  provider: string,
  unionId: string,
  client?: PoolClient,
): Promise<DbUser | null> {
  const p = client ?? getPool();
  if (!p) return null;
  const runner = client ?? p;
  const result = await runner.query(
    "SELECT * FROM users WHERE provider = $1 AND union_id = $2 LIMIT 1",
    [provider, unionId],
  );
  return result.rows[0] ? rowToDbUser(result.rows[0]) : null;
}

/**
 * 更新用户自定义档案（名字 / 头像），直接覆盖 users 表里的对应列。
 * - 只更新传入的字段（undefined 表示不动）；
 * - user_code 是身份主数据，不在可改范围内。
 */
export async function updateUserProfile(input: {
  provider: string;
  unionId: string;
  name?: string;
  avatar?: string;
}): Promise<DbUser | null> {
  const p = getPool();
  if (!p) return null;
  const name = typeof input.name === "string" ? input.name : null;
  const avatar = typeof input.avatar === "string" ? input.avatar : null;
  const result = await p.query(
    `UPDATE users SET
       name       = COALESCE($3, users.name),
       avatar     = COALESCE($4, users.avatar),
       updated_at = now()
     WHERE provider = $1 AND union_id = $2
     RETURNING *`,
    [input.provider, input.unionId, name, avatar],
  );
  return result.rows[0] ? rowToDbUser(result.rows[0]) : null;
}

/** 仅刷新 last_login_at（登录成功时调用）。 */
export async function touchLastLogin(id: number, client?: PoolClient): Promise<void> {
  const p = client ?? getPool();
  if (!p) return;
  const runner = client ?? p;
  await runner.query("UPDATE users SET last_login_at = now() WHERE id = $1", [id]);
}

/**
 * 彻底删除一个账号（用户自助注销 / 删除账号）。
 *
 * 语义：账号删除 = 该用户**产生与拥有**的数据全部消失。
 *   - 该用户拥有的会话（user_id = sub）整组删除：agent_sessions 的外键级联
 *     清掉 messages / members / reads / realtime / cowork 系列 / shares 等；
 *   - 无外键、仅按主体键（sub = `provider:unionId`）关联的数据手动删除：
 *     web push 订阅、用户文件区记录、记忆、分享、反馈、好友/邀请、联系人搜索缓存、
 *     cowork 连接/授权/审计/反应/伴聊等；
 *   - 协作会话（归属他人）里该用户的成员身份 / 读取标记 / 管理员身份 / 发言一并移除，
 *     会话本身保留给其余成员。
 *
 * 全程单事务：任一步失败整体回滚，不会留下半删除状态。返回 false 表示用户不存在。
 */
export async function deleteUserByProvider(provider: string, unionId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) throw new Error("PostgreSQL 未配置");
  await ensureMigrated();
  const userKey = `${provider}:${unionId}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = await client.query("SELECT id FROM users WHERE provider=$1 AND union_id=$2", [provider, unionId]);
    if (!user.rows[0]) {
      await client.query("ROLLBACK");
      return false;
    }
    // —— 无外键、按主体键关联的行 ——
    await client.query("DELETE FROM web_push_subscriptions WHERE user_sub=$1", [userKey]);
    await client.query("DELETE FROM agent_files WHERE owner_sub=$1", [userKey]);
    await client.query("DELETE FROM agent_memories WHERE owner_sub=$1", [userKey]); // 级联 agent_memory_files
    await client.query("DELETE FROM agent_shares WHERE created_by=$1", [userKey]);
    await client.query("DELETE FROM agent_chat_shares WHERE created_by=$1", [userKey]);
    await client.query("DELETE FROM agent_feedback WHERE user_id=$1", [userKey]);
    await client.query("DELETE FROM builtin_friendships WHERE user_a=$1 OR user_b=$1", [userKey]);
    await client.query("DELETE FROM builtin_friend_invitations WHERE sender_sub=$1 OR recipient_sub=$1", [userKey]);
    await client.query("DELETE FROM company_contact_search_results WHERE user_key=$1", [userKey]);
    await client.query("DELETE FROM cowork_connections WHERE owner_sub=$1", [userKey]);
    await client.query("DELETE FROM cowork_connection_grants WHERE user_sub=$1", [userKey]);
    await client.query("DELETE FROM cowork_connection_audit WHERE actor_sub=$1", [userKey]);
    await client.query("DELETE FROM cowork_message_reactions WHERE user_sub=$1", [userKey]);
    await client.query("DELETE FROM cowork_chatmate WHERE user_sub=$1", [userKey]);
    await client.query("DELETE FROM cowork_chatmate_settings WHERE user_sub=$1", [userKey]);
    // —— 协作会话里该用户的成员身份 / 读取标记 / 管理员身份。
    //    成员键是 provider + contact_id，contact_id 可能是 open_id / user_code / builtin 的 union_id，
    //    用 users 表反查整组匹配，避免漏删。 ——
    await client.query(
      `DELETE FROM agent_session_members m USING users u
       WHERE u.provider=$1 AND u.union_id=$2 AND m.provider=u.provider
         AND (m.contact_id=u.open_id OR m.contact_id=u.user_code OR (u.provider='builtin' AND m.contact_id=u.union_id))`,
      [provider, unionId],
    );
    await client.query(
      `DELETE FROM cowork_admins a USING users u
       WHERE u.provider=$1 AND u.union_id=$2 AND a.provider=u.provider
         AND (a.contact_id=u.open_id OR a.contact_id=u.user_code OR (u.provider='builtin' AND a.contact_id=u.union_id))`,
      [provider, unionId],
    );
    await client.query("DELETE FROM agent_session_reads WHERE user_sub=$1", [userKey]);
    // —— 协作会话里该用户发出的消息（个人言论；消息表没有指向 users 的外键）——
    await client.query("DELETE FROM agent_messages WHERE sender_sub=$1", [userKey]);
    // —— 该用户拥有的会话（外键级联清理关联数据）——
    await client.query("DELETE FROM agent_sessions WHERE user_id=$1", [userKey]);
    // —— users 行（级联 builtin_credentials）——
    await client.query("DELETE FROM users WHERE id=$1", [user.rows[0].id]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


/** 取飞书 OAuth 令牌（用户身份发消息用）；无令牌或非飞书用户返回 null。 */
export async function getUserOauthTokenByKey(
  userId: string,
): Promise<{ accessToken: string | null; refreshToken: string | null } | null> {
  const p = getPool();
  if (!p) return null;
  const { provider, unionId } = parseSessionKey(userId);
  if (!provider || !unionId) return null;
  const result = await p.query(
    "SELECT provider, fs_user_token, fs_refresh_token FROM users WHERE provider = $1 AND union_id = $2 LIMIT 1",
    [provider, unionId],
  );
  const row = result.rows[0];
  if (!row || row.provider !== "feishu") return null;
  return {
    accessToken: (row.fs_user_token as string) || null,
    refreshToken: (row.fs_refresh_token as string) || null,
  };
}

/** 回写飞书 OAuth 令牌（刷新续期后调用；refreshToken 为空时保留原值）。 */
export async function updateUserOauthToken(
  userId: string,
  token: { accessToken: string; refreshToken?: string },
): Promise<void> {
  const p = getPool();
  if (!p) return;
  const { provider, unionId } = parseSessionKey(userId);
  if (!provider || !unionId) return;
  await p.query(
    "UPDATE users SET fs_user_token = $3, fs_refresh_token = COALESCE($4, fs_refresh_token), updated_at = now() WHERE provider = $1 AND union_id = $2",
    [provider, unionId, token.accessToken, token.refreshToken || null],
  );
}

// ============================================================================
//  会话（agent_sessions / agent_messages）仓储
// ============================================================================

export interface AgentSessionRow {
  id: string;
  /** 用户主体键 `${provider}:${unionId}` */
  userId: string;
  title: string;
  memberCount: number;
  peerName: string | null;
  peerAvatar: string | null;
  coworkAvatar: string;
  /** 曾是/已是群聊（≥2 真人成员过）即永久为 true，成员减少也不回退成单聊 */
  coworkEverGroup: boolean;
  /** 本会话工作目录（沙箱范围；NULL=未限定，宿主选择工作区后写入） */
  workspaceDir: string | null;
  /** Local project grouping metadata; never used as an execution directory. */
  projectDir: string | null;
  viewLayout: "single" | "split" | "compare";
  pinOrder: number | null;
  workflows: AgentSessionWorkflow[];
  /** 接入的群会话 id：1v1 人机会话可访问该群的 uploads（只读）与 artifacts（可读写）。NULL=未接入 */
  refGroupId: string | null;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  lastPreview: string | null;
  lastSenderName: string | null;
  lastQuestionPreview: string | null;
  lastUserPreview: string | null;
  lastQuestionSenderName: string | null;
  unreadCount: number;
  aiUnread: boolean;
  muted: boolean;
  /** AI 消息免打扰：仅对 AI（assistant）消息的通知生效；muted=true 时必然一并打开 */
  aiMuted: boolean;
  /** 最后一条人类消息（非本人发送）是否 @ 了当前用户：会话列表第二行据此显示 [有人@了你] */
  lastMentionedMe: boolean;
  /** 纯 1v1 单聊：我发出的最后一条消息是否已被对方阅读（会话列表绿色已读 check 用；仅列表接口计算） */
  lastMessageReadByPeer?: boolean;
}

export interface AgentSessionWorkflow {
  workflowId: string;
  appId: string;
  iconUrl: string;
  collectionIconUrl: string;
}

export interface AgentMessageRow {
  id: number;
  sessionId: string;
  role: string;
  senderSub?: string | null;
  clientMessageId?: string | null;
  senderName?: string | null;
  senderAvatar?: string | null;
  replyToId?: number | null;
  runId?: string | null;
  content: string;
  images: unknown;
  revokedAt?: Date | null;
  /** 助手消息的分步思考过程（thinking/text/tool/ask/secs 数组），历史恢复时前端据此渲染思考胶囊 */
  steps: unknown;
  /** 助手消息总用时（秒） */
  thinkingSecs: number | null;
  /** 共用时（秒）：用户发送该消息 → 全部答复完成/停止，历史恢复时前端据此显示「共用时 xx」 */
  elapsedSecs: number | null;
  /** 本轮模型信息 { usedFallback, fallbackModel, models }，历史恢复时前端据此显示积分提示 */
  modelInfo: unknown;
  /** 本轮产物清单 [{id,name,type,size}]，历史恢复时前端据此渲染文件卡片与「查看所有产物」按钮 */
  artifacts: unknown;
  /** 用户消息的上传附件 { url, name, size }，历史恢复时前端据此恢复附件条 */
  attachment: unknown;
  forwardedBundle?: unknown;
  voice: unknown;
  /** 本轮消耗 { costUsd, usage }，历史恢复时前端据此展示 token 用量 */
  costInfo: unknown;
  createdAt: Date;
}

function rowToSession(row: Record<string, unknown>, extra?: { lastMentionedMe?: boolean }): AgentSessionRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    title: String(row.title ?? "新任务"),
    memberCount: Number(row.member_count ?? 0),
    peerName: (row.peer_name as string) || null,
    peerAvatar: (row.peer_avatar as string) || null,
    coworkAvatar: String(row.cowork_avatar ?? ""),
    coworkEverGroup: row.cowork_ever_group === true,
    workspaceDir: (row.workspace_dir as string) || null,
    projectDir: (row.project_dir as string) || null,
    viewLayout: row.view_layout === "split" || row.view_layout === "compare" ? row.view_layout : "single",
    pinOrder: row.pin_order == null ? null : Number(row.pin_order),
    workflows: Array.isArray(row.workflows) ? row.workflows as AgentSessionWorkflow[] : [],
    refGroupId: (row.ref_group_id as string) || null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    messageCount: Number(row.message_count ?? 0),
    lastPreview: (row.last_preview as string) ?? null,
    lastSenderName: (row.last_sender_name as string) ?? null,
    lastQuestionPreview: (row.last_question_preview as string) ?? null,
    lastUserPreview: (row.last_user_preview as string) ?? null,
    lastQuestionSenderName: (row.last_question_sender_name as string) ?? null,
    unreadCount: Number(row.unread_count ?? 0),
    aiUnread: Boolean(row.ai_unread),
    muted: Boolean(row.muted),
    aiMuted: Boolean(row.ai_muted),
    lastMentionedMe: extra?.lastMentionedMe ?? false,
  };
}

function rowToMessage(row: Record<string, unknown>): AgentMessageRow {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    role: String(row.role),
    senderSub: row.sender_sub == null ? null : String(row.sender_sub),
    clientMessageId: row.client_message_id == null ? null : String(row.client_message_id),
    senderName: row.sender_name == null ? null : String(row.sender_name),
    senderAvatar: row.sender_avatar == null ? null : String(row.sender_avatar),
    replyToId: row.reply_to_id == null ? null : Number(row.reply_to_id),
    runId: row.run_id == null ? null : String(row.run_id),
    content: String(row.content ?? ""),
    revokedAt: row.revoked_at as Date | null,
    images: row.images ?? null,
    steps: row.steps ?? null,
    thinkingSecs: row.thinking_secs != null ? Number(row.thinking_secs) : null,
    elapsedSecs: row.elapsed_secs != null ? Number(row.elapsed_secs) : null,
    modelInfo: row.model_info ?? null,
    artifacts: row.artifacts ?? null,
    forwardedBundle: row.forwarded_bundle ?? null,
    attachment: row.attachment ?? null,
    voice: row.voice ?? null,
    costInfo: row.cost_info ?? null,
    createdAt: row.created_at as Date,
  };
}

/** 通知已登录的受邀成员同步会话列表。LISTEN 跨服务进程转发给对应用户。 */
async function notifySessionMembers(sessionId: string, members: AgentSessionMember[]): Promise<void> {
  const p = getPool();
  if (!p || !members.length) return;
  await p.query(`SELECT pg_notify('agent_session_changes',
      json_build_object('userSub',u.provider || ':' || u.union_id,'sessionId',$1::text)::text)
    FROM users u WHERE EXISTS (SELECT 1 FROM unnest($2::text[],$3::text[]) AS invited(provider,contact_id)
      WHERE invited.provider=u.provider AND (invited.contact_id=u.open_id OR invited.contact_id=u.user_code OR (u.provider='builtin' AND invited.contact_id=u.union_id)))`,
    [sessionId, members.map(member => member.provider), members.map(member => member.contactId)]);
}

/** 会话有新消息时通知全部参与成员（含发起人），前端据此即时刷新会话列表未读数；
 *  与 notifySessionMembers 同走 agent_session_changes，但带 type:'message' 供网关区分。 */
export async function notifySessionMessage(sessionId: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(`SELECT pg_notify('agent_session_changes',
      json_build_object('userSub',sub,'sessionId',$1::text,'type','message')::text)
    FROM (
      SELECT s.user_id AS sub FROM agent_sessions s WHERE s.id=$1
      UNION
      SELECT COALESCE(u.provider || ':' || u.union_id, sm.provider || ':' || sm.contact_id) AS sub
      FROM agent_session_members sm LEFT JOIN users u
        ON u.provider=sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
      WHERE sm.session_id=$1
    ) participants WHERE sub IS NOT NULL`, [sessionId]);
}

/** 注册/复用会话：已存在则返回现有行，不存在则插入。workspaceDir 仅首建时生效（复用不改）。 */
export async function createAgentSession(
  userId: string,
  sessionId: string,
  title = "新任务",
  workspaceDir?: string | null,
  viewLayout: "single" | "split" | "compare" = "single",
  client?: PoolClient,
  projectDir?: string | null,
): Promise<AgentSessionRow | null> {
  const p = client ?? getPool();
  if (!p) return null;
  const runner = client ?? p;
  const result = await runner.query(
    `INSERT INTO agent_sessions (id, user_id, title, workspace_dir, view_layout, project_dir)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       view_layout = EXCLUDED.view_layout,
       workspace_dir = COALESCE(EXCLUDED.workspace_dir, agent_sessions.workspace_dir),
       project_dir = COALESCE(EXCLUDED.project_dir, agent_sessions.project_dir)
     WHERE agent_sessions.user_id = EXCLUDED.user_id
     RETURNING *`,
    [sessionId, userId, title.slice(0, 250), workspaceDir ? workspaceDir.slice(0, 1024) : null, viewLayout, projectDir ? projectDir.slice(0, 1024) : null],
  );
  return result.rows[0] ? rowToSession(result.rows[0]) : null;
}

/** Persist a workflow instance on a session independently of panel/tab state. */
export async function upsertAgentSessionWorkflow(userId: string, sessionId: string, workflow: AgentSessionWorkflow): Promise<AgentSessionWorkflow[] | null> {
  const p = getPool();
  if (!p) return null;
  const result = await p.query(
    `UPDATE agent_sessions s SET workflows =
       (SELECT COALESCE(jsonb_agg(item ORDER BY position), '[]'::jsonb)
        FROM jsonb_array_elements(s.workflows) WITH ORDINALITY AS entries(item, position)
        WHERE item->>'workflowId' <> $3) || $4::jsonb,
       updated_at = now()
     WHERE s.id=$2 AND (${SESSION_VISIBLE_CLAUSE})
     RETURNING s.workflows`,
    [userId, sessionId, workflow.workflowId, JSON.stringify([workflow])],
  );
  return result.rows[0] && Array.isArray(result.rows[0].workflows) ? result.rows[0].workflows as AgentSessionWorkflow[] : null;
}

/**
 * 建会话并写入成员，单事务完成。
 * 为什么不复用「createAgentSession + addAgentSessionMembers」两次调用：
 * 会话行先落库、成员后落库的那一瞬，会话列表按 member_count=0 把它判成「人机聊天」，
 * 前端会先按单聊渲染再跳成群聊（用户看到的就是新建群聊瞬间变成单聊样式）。
 * 同一事务内写入则保证会话一旦可见就是正确的群聊形态。
 * 已存在且成员已就位时按幂等处理（成员已存在则不重复插入）。
 */
export async function createAgentSessionWithMembers(
  userId: string,
  sessionId: string,
  title: string,
  workspaceDir: string | null,
  viewLayout: "single" | "split" | "compare",
  projectDir: string | null,
  members: AgentSessionMember[],
): Promise<AgentSessionRow | null> {
  const p = getPool();
  if (!p) return null;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO agent_sessions (id, user_id, title, workspace_dir, view_layout, project_dir, cowork_ever_group)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         view_layout = EXCLUDED.view_layout,
         workspace_dir = COALESCE(EXCLUDED.workspace_dir, agent_sessions.workspace_dir),
         project_dir = COALESCE(EXCLUDED.project_dir, agent_sessions.project_dir),
         cowork_ever_group = agent_sessions.cowork_ever_group OR EXCLUDED.cowork_ever_group
       WHERE agent_sessions.user_id = EXCLUDED.user_id
       RETURNING *`,
      [sessionId, userId, title.slice(0, 250), workspaceDir ? workspaceDir.slice(0, 1024) : null, viewLayout, projectDir ? projectDir.slice(0, 1024) : null, members.length >= 2],
    );
    const row = result.rows[0];
    if (!row) { await client.query("ROLLBACK"); return null; }
    // 与 addAgentSessionMembers 保持一致：把「转为群聊」这个时间点记在 cowork_start_id 上
    // （取当前最大消息 id），且仅在本会话此前一个成员都没有时才写。
    // 否则把已存在的 1v1 会话升级成群聊时，起点会被覆盖成 0，导致前面的消息被当成群聊消息。
    await client.query(
      `UPDATE agent_sessions SET cowork_start_id=COALESCE((SELECT max(id) FROM agent_messages WHERE session_id=$1),0)
       WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM agent_session_members WHERE session_id=$1)`,
      [sessionId],
    );
    for (const member of members) {
      await client.query(
        `INSERT INTO agent_session_members (session_id, provider, contact_id, name, avatar)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, provider, contact_id)
         DO UPDATE SET name = EXCLUDED.name, avatar = EXCLUDED.avatar`,
        [sessionId, member.provider, member.contactId, member.name, member.avatar],
      );
    }
    await client.query("COMMIT");
    void notifySessionMembers(sessionId, members).catch(error => console.warn("[agent-kit] 会话通知失败:", error));
    return rowToSession(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 当前用户的会话列表（按最近更新倒序），附带消息数与最后一条消息预览。 */
export async function listAgentSessions(userId: string, client?: PoolClient): Promise<AgentSessionRow[]> {
  const p = client ?? getPool();
  if (!p) return [];
  const runner = client ?? p;
  // 冷启动时远程库建连偶发超时（"timeout exceeded when trying to connect"）：
  // 非事务调用重试 1 次（短退避）；事务内不重试（事务状态不可回放）。
  if (client) return listAgentSessionsBody(userId, runner);
  return withRetry(
    () => listAgentSessionsBody(userId, runner),
    {
      maxAttempts: 2,
      baseDelayMs: 800,
      backoffFactor: 2,
      jitter: 0.3,
      retryable: (e) =>
        e instanceof Error &&
        /(?:timeout|timed?\s*out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket\s*hang\s*up|connection\s+(?:refused|terminated|reset|closed)|connect\s+ECONN)/i.test(e.message),
      onRetry: (attempt, error, delayMs) =>
        console.warn(`[agent-kit auth/db] 会话列表查询重试 ${attempt}/2: ${error instanceof Error ? error.message : String(error)}（${delayMs}ms 后重试）`),
    },
  );
}

/** listAgentSessions 的实际查询体（重试包装的内层，只读 SELECT，可安全重放）。 */
async function listAgentSessionsBody(userId: string, runner: Pool | PoolClient): Promise<AgentSessionRow[]> {
  // 当前用户全局显示名：他人 @ 我 时使用的主体名字（与会话成员名一起作为匹配候选）
  const meRows = await runner.query(`SELECT name FROM users WHERE provider || ':' || union_id = $1 LIMIT 1`, [userId]);
  const myGlobalName = meRows.rows[0]?.name ? String(meRows.rows[0].name).trim() : null;
  const result = await runner.query(
    `SELECT s.*,
            COALESCE((SELECT r.muted FROM agent_session_reads r WHERE r.session_id=s.id AND r.user_sub=$1), false) AS muted,
            COALESCE((SELECT r.ai_muted FROM agent_session_reads r WHERE r.session_id=s.id AND r.user_sub=$1), false) AS ai_muted,
            (SELECT count(*) FROM agent_session_members sm WHERE sm.session_id=s.id) AS member_count,
            CASE WHEN s.user_id=$1
              THEN (SELECT sm.name FROM agent_session_members sm WHERE sm.session_id=s.id ORDER BY sm.added_at LIMIT 1)
              ELSE (SELECT COALESCE(NULLIF(u.name,''),u.user_code) FROM users u WHERE u.provider || ':' || u.union_id=s.user_id LIMIT 1) END AS peer_name,
            CASE WHEN s.user_id=$1
              THEN (SELECT sm.avatar FROM agent_session_members sm WHERE sm.session_id=s.id ORDER BY sm.added_at LIMIT 1)
              ELSE (SELECT u.avatar FROM users u WHERE u.provider || ':' || u.union_id=s.user_id LIMIT 1) END AS peer_avatar,
            (SELECT count(*) FROM agent_messages m WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0)) AS message_count,
            (SELECT count(*) FROM agent_messages m
             WHERE m.session_id=s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role='user' AND COALESCE(m.sender_sub,s.user_id)<>$1
               AND (s.user_id=$1 OR m.created_at>=COALESCE((SELECT min(sm.added_at)
                 FROM agent_session_members sm JOIN users viewer ON viewer.provider=sm.provider
                   AND (viewer.open_id=sm.contact_id OR viewer.user_code=sm.contact_id OR (viewer.provider='builtin' AND viewer.union_id=sm.contact_id))
                 WHERE sm.session_id=s.id AND viewer.provider || ':' || viewer.union_id=$1),s.created_at))
               AND m.id>COALESCE((SELECT r.last_read_message_id FROM agent_session_reads r
                                 WHERE r.session_id=s.id AND r.user_sub=$1),0)) AS unread_count,
            EXISTS(SELECT 1 FROM agent_messages m WHERE m.session_id=s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role='assistant'
              AND (s.user_id=$1 OR m.created_at>=COALESCE((SELECT min(sm.added_at)
                FROM agent_session_members sm JOIN users viewer ON viewer.provider=sm.provider
                  AND (viewer.open_id=sm.contact_id OR viewer.user_code=sm.contact_id OR (viewer.provider='builtin' AND viewer.union_id=sm.contact_id))
                WHERE sm.session_id=s.id AND viewer.provider || ':' || viewer.union_id=$1),s.created_at))
              AND m.id>COALESCE((SELECT r.last_read_message_id FROM agent_session_reads r
                                WHERE r.session_id=s.id AND r.user_sub=$1),0)) AS ai_unread,
            (SELECT ${MESSAGE_PREVIEW_SQL}
             FROM agent_messages m WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_preview,
            (SELECT CASE WHEN m.role='assistant' THEN COALESCE(m.cowork_agent_name,ca.name,'${AI_DISPLAY_NAME}') WHEN m.sender_sub=$1 THEN '我' ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END
             FROM agent_messages m LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
             LEFT JOIN cowork_agents ca ON ca.id=m.cowork_agent_id
             WHERE m.session_id=s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_sender_name,
            (SELECT left(${MESSAGE_PREVIEW_SQL}, 240) FROM agent_messages m WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role IN ('user','system') AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_question_preview,
            (SELECT left(${MESSAGE_PREVIEW_SQL}, 240) FROM agent_messages m WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role='user' AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_user_preview,
            (SELECT CASE WHEN m.role='system' THEN '' WHEN m.sender_sub=$1 THEN '我' ELSE COALESCE(NULLIF(u.name,''),u.user_code,'成员') END
             FROM agent_messages m LEFT JOIN users u ON u.provider || ':' || u.union_id=m.sender_sub
             WHERE m.session_id=s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role IN ('user','system') AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_question_sender_name,
            -- 以下五列仅服务端内部用于判断「最后一条人类消息是否 @ 了当前用户」，不随 SessionItem 返回前端
            (SELECT m.content FROM agent_messages m
             WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role IN ('user','system') AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_question_content,
            (SELECT m.sender_sub FROM agent_messages m
             WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role IN ('user','system') AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_question_sender_sub,
            (SELECT m.id FROM agent_messages m
             WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role IN ('user','system') AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_question_id,
            (SELECT r.last_read_message_id FROM agent_session_reads r
             WHERE r.session_id = s.id AND r.user_sub = $1) AS last_read_message_id,
            -- 「对方已读」三列：仅列表接口消费，不随 rowToSession 映射（在行映射阶段手工计算）
            -- 纯 1v1 单聊（member_count=1 且从未成群）时，除自己外的唯一读游标即「对方已读游标」
            (SELECT pr.last_read_message_id FROM agent_session_reads pr
             WHERE pr.session_id = s.id AND pr.user_sub <> $1 LIMIT 1) AS peer_read_message_id,
            -- 我发出的最后一条消息 id（role='user' 且 sender_sub=当前用户，未撤回）
            (SELECT m.id FROM agent_messages m
             WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.role = 'user' AND m.sender_sub = $1 AND m.revoked_at IS NULL
             ORDER BY m.id DESC LIMIT 1) AS last_own_message_id,
            -- 最后一条未撤回消息的发送者：判断会话预览对应的是不是我的消息
            (SELECT m.sender_sub FROM agent_messages m
             WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_message_sender_sub,
            (SELECT sm.name FROM agent_session_members sm JOIN users u
              ON u.provider = sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
              WHERE sm.session_id = s.id AND u.provider || ':' || u.union_id = $1 LIMIT 1) AS my_member_name
     FROM agent_sessions s
     WHERE (s.user_id = $1 OR EXISTS (
       SELECT 1 FROM agent_session_members sm JOIN users u
         ON u.provider = sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
       WHERE sm.session_id = s.id AND u.provider || ':' || u.union_id = $1
     ))
       -- 隐藏会话（软删除）：对当前用户不可见，直到对方再发消息（unhideAgentSession 清标记）
       AND NOT COALESCE((SELECT r.hidden FROM agent_session_reads r WHERE r.session_id=s.id AND r.user_sub=$1), false)
     ORDER BY (s.pin_order IS NULL), s.pin_order ASC NULLS LAST, s.updated_at DESC
     LIMIT 200`,
    [userId],
  );
  const invalidRows = result.rows.filter((row) => !row.user_renamed && isInvalidAutoTitle(String(row.title ?? "")));
  if (invalidRows.length) {
    const ids = invalidRows.map((row) => String(row.id));
    const firstMessages = await runner.query(
      `SELECT DISTINCT ON (session_id) session_id, content FROM agent_messages
       WHERE session_id = ANY($1::text[]) AND role = 'user' ORDER BY session_id, id ASC`,
      [ids],
    );
    const firstBySession = new Map(firstMessages.rows.map((row) => [String(row.session_id), String(row.content ?? "")]));
    await Promise.all(invalidRows.map(async (row) => {
      const replacement = quickSessionTitle(firstBySession.get(String(row.id)) ?? "");
      if (!replacement || isInvalidAutoTitle(replacement)) return;
      const updated = await runner.query(
        `UPDATE agent_sessions SET title = $3 WHERE user_id = $1 AND id = $2 AND NOT user_renamed AND title = $4`,
        [userId, row.id, replacement, row.title],
      );
      if (updated.rowCount) row.title = replacement;
    }));
  }
  return result.rows.map(row => {
    const session = rowToSession(row, { lastMentionedMe: lastQuestionMentionsMe(row, userId, myGlobalName) });
    if (session.userId !== userId) {
      session.workspaceDir = null;
      session.projectDir = null;
    }
    // 「对方已读」：仅纯 1v1 单聊（从未成群且成员恰为 1 人）计算。
    // 条件：会话预览对应我发出的最后一条消息（未撤回），且对方读游标 ≥ 该消息 id。
    if (!session.coworkEverGroup && session.memberCount === 1) {
      const lastOwnId = Number(row.last_own_message_id ?? 0);
      const lastSenderSub = row.last_message_sender_sub == null ? null : String(row.last_message_sender_sub);
      const peerReadId = Number(row.peer_read_message_id ?? 0);
      if (lastOwnId > 0 && lastSenderSub === userId && peerReadId >= lastOwnId) {
        session.lastMessageReadByPeer = true;
      }
    }
    return session;
  });
}

/**
 * 与 cowork.ts 的 explicitlyMentioned 保持同一 @ 命中口径：@名字 / @所有人 / @all，
 * 支持全角＠、@ 与名字间空白，名字后须为边界（空白/标点/结尾）。
 */
function messageMentionsMe(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[@＠]\\s*(?:${escaped}|所有人|all)(?=$|[\\s，。！？?,.!:：；;])`, "i").test(text);
}

/**
 * 判断会话列表的「最后一条人类消息」（role IN ('user','system')、非本人发送）是否 @ 了当前用户，
 * 且该消息尚未被读取（id > 已读游标）——[有人@了你] 只针对未读消息，读过后即消失。
 * 匹配名字取当前用户全局显示名与该会话内的成员名（他人 @ 我 时通常使用成员名）。
 */
function lastQuestionMentionsMe(row: Record<string, unknown>, userId: string, myGlobalName: string | null): boolean {
  const lastQuestionId = Number(row.last_question_id ?? 0);
  const lastReadId = Number(row.last_read_message_id ?? 0);
  if (!lastQuestionId || lastQuestionId <= lastReadId) return false;
  const senderSub = row.last_question_sender_sub == null ? null : String(row.last_question_sender_sub);
  if (senderSub === userId) return false;
  const content = String(row.last_question_content ?? "").trim();
  if (!content) return false;
  const memberName = row.my_member_name == null ? null : String(row.my_member_name).trim();
  const names = [myGlobalName, memberName].filter((name): name is string => !!name);
  return names.some((name) => messageMentionsMe(content, name));
}

/**
 * 会话可见性子句（跨会话搜索与会话列表共用）。
 *
 * 必须逐字对齐 listAgentSessions 里的同一段：搜索是另一条入口，一旦放宽，
 * 用户就能通过 /api/sessions/search 读到不属于自己的会话标题与消息正文
 * （比泄漏标题的列表更严重 —— 正文也在其中）。userId 固定绑定 $1。
 */
const SESSION_VISIBLE_CLAUSE = `s.user_id = $1 OR EXISTS (
      SELECT 1 FROM agent_session_members sm JOIN users u
        ON u.provider = sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
      WHERE sm.session_id = s.id AND u.provider || ':' || u.union_id = $1
    )`;

/**
 * 消息预览表达式（依赖别名 m，作用于单条 agent_messages 行）：
 * 纯文件消息（空正文或只有「[附件] 文件名」）按类型取摘要；其他正文原样显示。
 * 扩展名列表须与 UI 侧 messageUtils 的 isImageFile/isVideoFile/isAudioFile 保持一致。
 * 用于会话列表 / 搜索 / 详情里的 lastPreview 与 lastQuestionPreview。
 */
const PREVIEW_IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "ico"];
const PREVIEW_VIDEO_EXTS = ["mp4", "webm", "mov", "m4v", "ogv", "ogg", "avi", "mkv"];
const PREVIEW_AUDIO_EXTS = ["mp3", "m4a", "aac", "wav", "ogg", "oga", "flac", "amr", "opus", "weba"];
const sqlInList = (exts: string[]) => `(${exts.map((ext) => `'${ext}'`).join(",")})`;
const MESSAGE_FILE_MARKER_SQL = `left(btrim(m.content), 4) = '[附件]' AND strpos(m.content, chr(10)) = 0 AND strpos(m.content, chr(13)) = 0`;
const MESSAGE_PREVIEW_NAME_SQL = `COALESCE(NULLIF(CASE WHEN jsonb_typeof(m.attachment) = 'array'
  THEN m.attachment->0->>'name' ELSE m.attachment->>'name' END, ''),
  CASE WHEN ${MESSAGE_FILE_MARKER_SQL} THEN btrim(substring(btrim(m.content) from 5)) ELSE '' END)`;
const MESSAGE_PREVIEW_KIND_SQL = `CASE
  WHEN lower(split_part(${MESSAGE_PREVIEW_NAME_SQL}, '.', -1)) IN ${sqlInList(PREVIEW_IMAGE_EXTS)} THEN '图片'
  WHEN lower(split_part(${MESSAGE_PREVIEW_NAME_SQL}, '.', -1)) IN ${sqlInList(PREVIEW_VIDEO_EXTS)} THEN '视频'
  WHEN lower(split_part(${MESSAGE_PREVIEW_NAME_SQL}, '.', -1)) IN ${sqlInList(PREVIEW_AUDIO_EXTS)} THEN '音频'
  ELSE '文件' END`;
const MESSAGE_FILE_PREVIEW_SQL = `CASE WHEN ${MESSAGE_PREVIEW_KIND_SQL} = '文件'
  THEN '[文件] ' || COALESCE(NULLIF(btrim(${MESSAGE_PREVIEW_NAME_SQL}), ''), '文件')
  ELSE ${MESSAGE_PREVIEW_KIND_SQL} END`;
const MESSAGE_PREVIEW_SQL = `CASE
  WHEN ${MESSAGE_FILE_MARKER_SQL} THEN ${MESSAGE_FILE_PREVIEW_SQL}
  WHEN btrim(m.content) <> '' THEN m.content
  WHEN jsonb_typeof(m.attachment) = 'array' AND jsonb_array_length(m.attachment) > 0
    OR jsonb_typeof(m.attachment) = 'object' THEN
    ${MESSAGE_FILE_PREVIEW_SQL}
  ELSE '' END`;

/** 消息预览（TS 版，供 fork 等内存路径使用）。 */
function messagePreviewTextServer(content: unknown, attachment: unknown): string {
  const raw = String(content ?? "").trim();
  if (raw === "[附件]") return "[文件] 文件";
  const markerName = /^\[附件\]\s*([^\r\n]+)$/.exec(raw)?.[1]?.trim() || "";
  if (raw && !markerName) return raw.replace(/\s+/g, " ");
  const list = Array.isArray(attachment) ? attachment : attachment ? [attachment] : [];
  for (const item of list) {
    if (item && typeof item === "object") {
      const name = (item as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) {
        const trimmed = name.trim();
        const ext = trimmed.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
        const kind = PREVIEW_IMAGE_EXTS.includes(ext) ? "图片" : PREVIEW_VIDEO_EXTS.includes(ext) ? "视频" : PREVIEW_AUDIO_EXTS.includes(ext) ? "音频" : "文件";
        return kind === "文件" ? `[文件] ${trimmed}` : kind;
      }
    }
  }
  if (!markerName) return list.length ? "[文件] 文件" : "";
  const ext = markerName.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
  const kind = PREVIEW_IMAGE_EXTS.includes(ext) ? "图片" : PREVIEW_VIDEO_EXTS.includes(ext) ? "视频" : PREVIEW_AUDIO_EXTS.includes(ext) ? "音频" : "文件";
  return kind === "文件" ? `[文件] ${markerName}` : kind;
}

/** 跨会话搜索：按标题命中的会话 */
export interface AgentSessionSearchRow {
  id: string;
  title: string;
  memberCount: number;
  coworkEverGroup: boolean;
  messageCount: number;
  updatedAt: Date;
  lastPreview: string | null;
  /**
   * 该会话内第一条正文命中的消息 id（时间正序）。
   * 前端据此决定点击后「定位到命中消息」还是「滚到底部」；会话只有标题命中时为 null。
   */
  hitMessageId: number | null;
  /**
   * 会话成员中第一个「姓名命中关键词」的成员名（按加入时间正序）。
   * 群聊搜索结果据此展示「包含: 某某」副行；只有标题命中、成员姓名未命中时为 null。
   */
  matchedMemberName: string | null;
}

/** 全局搜索：按姓名/拼音/部门/职位/邮箱命中的企业联系人（含其已有 1v1 会话定位） */
export interface AgentPersonSearchRow {
  id: string;
  provider: string;
  name: string;
  department: string;
  title: string;
  avatar: string;
  email: string;
  /** 与该联系人已有的「真 1:1」会话 id（成员数=1 且从未成过群）；没有则为 null */
  sessionId: string | null;
  /** 该联系人即当前登录用户自己（选人/搜索列表标注「（你自己）」） */
  isSelf?: boolean;
}

/** 跨会话搜索：按消息正文命中的结果行 */
export interface AgentMessageSearchRow {
  id: number;
  sessionId: string;
  sessionTitle: string;
  memberCount: number;
  role: string;
  createdAt: Date;
  /**
   * 截断后的消息正文（见 CONTENT_CAP）。片段截取在调用侧完成，
   * 此处不做 strpos/substring：PostgreSQL 的字符下标与多字节边界组合容易出偏差，
   * 统一在 JS 里按命中位置切窗口更可控。
   */
  content: string;
}

/** 搜索命中的消息正文上限（字符）：兜住超长助手回复，避免单次搜索拉回几 MB 正文。 */
const CONTENT_CAP = 6000;

/**
 * 把用户关键词转成 ILIKE 的 `%pattern%`：转义 \ % _ 三个元字符，
 * 否则用户输入 "%" 会退化成全表匹配（等价于绕过关键词，把所有会话正文拉回来）。
 *
 * 注意：依赖 PostgreSQL LIKE 的**默认转义符反斜杠**（SQL 里显式写 ESCAPE '\' 反而会错误 ——
 * standard_conforming_strings=on 时它算两个字符，PG 报 "Escape string must be empty or one character"）。
 * 因此调用处一律写 `ILIKE $n`，不要补 ESCAPE 子句。
 */
export function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** 按会话标题检索当前用户可见的会话（ILIKE 子串匹配，与结果一并给出会话内首个正文命中的消息 id）。 */
export async function searchAgentSessions(
  userId: string,
  keyword: string,
  limit = 20,
): Promise<AgentSessionSearchRow[]> {
  const p = getPool();
  if (!p) return [];
  if (!keyword) return [];
  const result = await p.query(
    `SELECT s.id, s.title, s.updated_at, s.cowork_ever_group,
            (SELECT count(*) FROM agent_session_members sm WHERE sm.session_id = s.id) AS member_count,
            (SELECT count(*) FROM agent_messages m WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0)) AS message_count,
            (SELECT ${MESSAGE_PREVIEW_SQL}
             FROM agent_messages m WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_preview,
            (SELECT m.id FROM agent_messages m
             WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.revoked_at IS NULL AND m.content ILIKE $2
             ORDER BY m.id ASC LIMIT 1) AS hit_message_id,
            (SELECT m.name FROM agent_session_members m
             WHERE m.session_id = s.id AND m.name ILIKE $2
             ORDER BY m.added_at ASC LIMIT 1) AS matched_member_name
     FROM agent_sessions s
     WHERE (${SESSION_VISIBLE_CLAUSE}) AND s.title ILIKE $2
       AND NOT COALESCE((SELECT r.hidden FROM agent_session_reads r WHERE r.session_id=s.id AND r.user_sub=$1), false)
     ORDER BY s.updated_at DESC
     LIMIT $3`,
    [userId, likePattern(keyword), Math.max(1, Math.min(50, limit))],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title ?? "新任务"),
    memberCount: Number(row.member_count ?? 0),
    coworkEverGroup: row.cowork_ever_group === true,
    messageCount: Number(row.message_count ?? 0),
    updatedAt: row.updated_at as Date,
    lastPreview: (row.last_preview as string) ?? null,
    hitMessageId: row.hit_message_id == null ? null : Number(row.hit_message_id),
    matchedMemberName: (row.matched_member_name as string) ?? null,
  }));
}

/**
 * 全局搜索「联系人」：在企业通讯录快照（company_contacts）里按
 * 姓名 / 拼音 / 部门 / 职位 / 邮箱 做 ILIKE 子串匹配。
 *
 * 归属边界：通讯录快照按组织（organization_key）隔离，组织内成员均可检索
 * （与通讯录页 /api/contacts 同口径），不做个人可见范围裁剪。
 *
 * 结果附带每个联系人已有的「真 1:1」会话 id（成员数=1、从未成过群、当前用户可见）：
 * 前端点击联系人时若有则直接跳转，没有才走「新建含该联系人的会话」流程。
 */
export async function searchAgentPeople(
  orgKey: string,
  userId: string,
  keyword: string,
  limit = 20,
): Promise<AgentPersonSearchRow[]> {
  const p = getPool();
  if (!p) return [];
  if (!keyword) return [];
  const peopleResult = await p.query(
    `SELECT contact_id AS id, provider, name, department, title, avatar, email
     FROM company_contacts
     WHERE organization_key = $1
       AND (name ILIKE $2 OR pinyin ILIKE $2 OR department ILIKE $2 OR title ILIKE $2 OR email ILIKE $2)
     ORDER BY name
     LIMIT $3`,
    [orgKey, likePattern(keyword), Math.max(1, Math.min(50, limit))],
  );
  const people: AgentPersonSearchRow[] = peopleResult.rows.map((row) => ({
    id: String(row.id),
    provider: String(row.provider ?? "feishu"),
    name: String(row.name ?? ""),
    department: String(row.department ?? ""),
    title: String(row.title ?? ""),
    avatar: String(row.avatar ?? ""),
    email: String(row.email ?? ""),
    sessionId: null,
  }));
  if (!people.length) return people;
  const providers = [...new Set(people.map((person) => person.provider))];
  const ids = people.map((person) => person.id);
  // 批量查这些人已有的 1v1 会话（一次请求，避免 N+1）：
  // 真 1:1 = 该会话只有这一名成员且从未成过群；群聊即使成员被移除到只剩 1 人也绝不当作 1v1 复用。
  const sessionResult = await p.query(
    `SELECT DISTINCT sm.contact_id, s.id
     FROM agent_session_members sm
     JOIN agent_sessions s ON s.id = sm.session_id
     WHERE sm.provider = ANY($2::varchar[])
       AND sm.contact_id = ANY($3::varchar[])
       AND NOT s.cowork_ever_group
       AND (SELECT count(*) FROM agent_session_members m2 WHERE m2.session_id = sm.session_id) = 1
       AND NOT COALESCE((SELECT r.hidden FROM agent_session_reads r WHERE r.session_id=s.id AND r.user_sub=$1), false)
       AND (${SESSION_VISIBLE_CLAUSE})`,
    [userId, providers, ids],
  );
  const sessionIdByContact = new Map<string, string>();
  for (const row of sessionResult.rows) {
    if (!sessionIdByContact.has(String(row.contact_id))) sessionIdByContact.set(String(row.contact_id), String(row.id));
  }
  for (const person of people) person.sessionId = sessionIdByContact.get(person.id) ?? null;
  return people;
}

/** 按消息正文检索当前用户可见会话内的消息（排除已撤回 / 空正文），按消息 id 倒序取最新 N 条。 */
export async function searchAgentMessages(
  userId: string,
  keyword: string,
  limit = 30,
): Promise<AgentMessageSearchRow[]> {
  const p = getPool();
  if (!p) return [];
  if (!keyword) return [];
  const result = await p.query(
    `SELECT m.id, m.session_id, s.title AS session_title, m.role, m.created_at,
            CASE WHEN char_length(m.content) <= ${CONTENT_CAP} THEN m.content
                 ELSE left(m.content, ${CONTENT_CAP}) END AS content,
            (SELECT count(*) FROM agent_session_members sm WHERE sm.session_id = s.id) AS member_count
     FROM agent_messages m
     JOIN agent_sessions s ON s.id = m.session_id
     WHERE (${SESSION_VISIBLE_CLAUSE}) AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0)
       AND NOT COALESCE((SELECT r.hidden FROM agent_session_reads r WHERE r.session_id=s.id AND r.user_sub=$1), false)
       AND m.revoked_at IS NULL
       AND btrim(m.content) <> ''
       AND m.content ILIKE $2
     ORDER BY m.id DESC
     LIMIT $3`,
    [userId, likePattern(keyword), Math.max(1, Math.min(100, limit))],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    sessionId: String(row.session_id),
    sessionTitle: String(row.session_title ?? "新任务"),
    memberCount: Number(row.member_count ?? 0),
    role: String(row.role ?? "user"),
    createdAt: row.created_at as Date,
    content: String(row.content ?? ""),
  }));
}

/** 校验会话归属并返回该会话；不属于当前用户或不存在时返回 null。 */
export async function getAgentSession(
  userId: string,
  sessionId: string,
  client?: PoolClient,
): Promise<AgentSessionRow | null> {
  const p = client ?? getPool();
  if (!p) return null;
  const runner = client ?? p;
  const result = await runner.query(
    `SELECT s.*,
            (SELECT count(*) FROM agent_messages m WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0)) AS message_count,
            (SELECT ${MESSAGE_PREVIEW_SQL} FROM agent_messages m WHERE m.session_id = s.id AND m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.revoked_at IS NULL ORDER BY m.id DESC LIMIT 1) AS last_preview
     FROM agent_sessions s
     WHERE s.id = $2 AND (s.user_id = $1 OR EXISTS (
       SELECT 1 FROM agent_session_members sm JOIN users u
         ON u.provider = sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
       WHERE sm.session_id = s.id AND u.provider || ':' || u.union_id = $1
     ))
     LIMIT 1`,
    [userId, sessionId],
  );
  if (!result.rows[0]) return null;
  const session = rowToSession(result.rows[0]);
  if (session.userId !== userId) {
    session.workspaceDir = null;
    session.projectDir = null;
  }
  return session;
}

export interface AgentSessionMember {
  provider: string;
  contactId: string;
  name: string;
  avatar: string;
  /** 已登录成员的身份串 provider:union_id；仅目录快照、未登录过的成员为空。任免管理员用。 */
  sub?: string;
}

export async function listAgentSessionMembers(userId: string, sessionId: string): Promise<AgentSessionMember[] | null> {
  if (!await getAgentSession(userId, sessionId)) return null;
  const p = getPool();
  if (!p) return null;
  const result = await p.query(
    `SELECT sm.provider, sm.contact_id, COALESCE(NULLIF(u.name,''),u.user_code,sm.name) AS name, sm.avatar,
        u.provider || ':' || u.union_id AS sub
     FROM agent_session_members sm
     LEFT JOIN users u ON u.provider=sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
     WHERE sm.session_id = $1 ORDER BY sm.added_at, sm.contact_id`,
    [sessionId],
  );
  return result.rows.map(row => ({
    provider: String(row.provider), contactId: String(row.contact_id),
    name: String(row.name), avatar: String(row.avatar),
    sub: row.sub ? String(row.sub) : undefined,
  }));
}

export async function isAgentGroupSession(sessionId: string): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  await ensureMigrated();
  // 群聊 = 曾是群聊（cowork_ever_group，永不回退）或当前仍有真人成员
  const result = await p.query(
    `SELECT EXISTS(
       SELECT 1 FROM agent_sessions s
       WHERE s.id=$1 AND (s.cowork_ever_group OR EXISTS(SELECT 1 FROM agent_session_members sm WHERE sm.session_id=s.id))
     ) AS is_group`, [sessionId]);
  return result.rows[0]?.is_group === true;
}

/** 1v1 群聊：发起人 + 恰好 1 名已加入成员。此场景双方均为群管理员（可设置 AI、可解散群）。 */
export async function isTwoPersonAgentGroup(sessionId: string): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  const result = await p.query(
    `SELECT (SELECT count(*) FROM agent_session_members sm WHERE sm.session_id=$1) = 1 AS is_two_person`, [sessionId]);
  return result.rows[0]?.is_two_person === true;
}

/** 群管理员名单（按成员快照 provider+contact_id），不含群主（群主天然是管理员）。 */
export interface CoworkAdminRow { provider: string; contactId: string; name: string; avatar: string; }

export async function listCoworkAdmins(sessionId: string): Promise<CoworkAdminRow[]> {
  const p = getPool();
  if (!p) return [];
  await ensureMigrated();
  const result = await p.query(
    `SELECT provider, contact_id AS "contactId", name, avatar FROM cowork_admins
     WHERE session_id=$1 ORDER BY created_at, provider, contact_id`, [sessionId]);
  return result.rows.map(row => ({
    provider: String(row.provider), contactId: String(row.contactId),
    name: String(row.name ?? ""), avatar: String(row.avatar ?? ""),
  }));
}

/** 是否具备群管理角色：群主、快照命中的管理员，或 1v1（双方均为管理员）。 */
export async function isCoworkManager(
  sessionId: string,
  user: { sub: string; provider: string; openId?: string | null; unionId?: string | null },
): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  await ensureMigrated();
  const result = await p.query(
    `SELECT (s.user_id=$2) AS is_owner,
       EXISTS(
         SELECT 1 FROM cowork_admins a
         LEFT JOIN users u ON u.provider=a.provider AND (u.open_id=a.contact_id OR u.user_code=a.contact_id OR u.union_id=a.contact_id)
         WHERE a.session_id=s.id
           AND (u.provider IS NOT NULL AND u.provider || ':' || u.union_id=$2
                OR (a.provider=$3 AND a.contact_id IN ($4,$5)))
       ) AS is_admin,
       (SELECT count(*) FROM agent_session_members sm WHERE sm.session_id=s.id) = 1 AS is_two_person
     FROM agent_sessions s WHERE s.id=$1`,
    [sessionId, user.sub, user.provider, user.openId ?? "", user.unionId ?? ""],
  );
  const row = result.rows[0];
  if (!row) return false;
  return Boolean(row.is_owner || row.is_admin || row.is_two_person);
}

/** 任命管理员（按成员快照 upsert，未登录成员亦可）。 */
export async function promoteCoworkAdmin(sessionId: string, admin: CoworkAdminRow, promotedBy: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  await ensureMigrated();
  await p.query(
    `INSERT INTO cowork_admins(session_id,provider,contact_id,name,avatar,promoted_by)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (session_id,provider,contact_id) DO UPDATE
       SET name=EXCLUDED.name, avatar=EXCLUDED.avatar, promoted_by=EXCLUDED.promoted_by`,
    [sessionId, admin.provider, admin.contactId, admin.name, admin.avatar, promotedBy],
  );
}

/** 取消管理员（群主专属操作）。 */
export async function demoteCoworkAdmin(sessionId: string, provider: string, contactId: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  await ensureMigrated();
  await p.query("DELETE FROM cowork_admins WHERE session_id=$1 AND provider=$2 AND contact_id=$3", [sessionId, provider, contactId]);
}

export async function addAgentSessionMembers(userId: string, sessionId: string, members: AgentSessionMember[]): Promise<{ ok: boolean; systemMessageId: number | null }> {
  const p = getPool();
  if (!p) return { ok: false, systemMessageId: null };
  await ensureMigrated();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const accessible = await client.query(
      `SELECT s.id FROM agent_sessions s WHERE s.id = $1 AND (s.user_id = $2 OR EXISTS (
        SELECT 1 FROM agent_session_members sm JOIN users u
          ON u.provider = sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
        WHERE sm.session_id = s.id AND u.provider || ':' || u.union_id = $2
      )) FOR UPDATE OF s`,
      [sessionId, userId],
    );
    if (!accessible.rowCount) { await client.query("ROLLBACK"); return { ok: false, systemMessageId: null }; }
    // 已有消息的人机聊天加人后成为群聊；空会话首次只加一人则是 1v1。
    const preExisting = await client.query(
      `SELECT count(*)::int AS n FROM agent_session_members WHERE session_id=$1`, [sessionId]);
    const fromHumanMachine = Number(preExisting.rows[0]?.n ?? 0) === 0;
    const previousMessages = await client.query(
      `SELECT EXISTS(SELECT 1 FROM agent_messages WHERE session_id=$1) AS has_messages`, [sessionId]);
    const upgradingConversation = fromHumanMachine && previousMessages.rows[0]?.has_messages === true;
    await client.query(`UPDATE agent_sessions SET cowork_start_id=COALESCE((SELECT max(id) FROM agent_messages WHERE session_id=$1),0)
      WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM agent_session_members WHERE session_id=$1)`, [sessionId]);
    const added: AgentSessionMember[] = [];
    for (const member of members) {
      const inserted = await client.query(
        `INSERT INTO agent_session_members (session_id, provider, contact_id, name, avatar)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id, provider, contact_id) DO NOTHING RETURNING contact_id`,
        [sessionId, member.provider, member.contactId, member.name, member.avatar],
      );
      if (inserted.rowCount) added.push(member);
    }
    let systemMessageId: number | null = null;
    if (added.length) {
      const profile = await client.query("SELECT COALESCE(NULLIF(name,''),user_code) AS name FROM users WHERE provider || ':' || union_id = $1", [userId]);
      const operatorName = String(profile.rows[0]?.name ?? "");
      const memberCount = Number((await client.query(
        `SELECT count(*)::int AS n FROM agent_session_members WHERE session_id=$1`, [sessionId])).rows[0]?.n ?? 0);
      const isGroup = memberCount >= 2 || upgradingConversation;
      const event = await client.query(
        "INSERT INTO agent_messages(session_id,role,content,sender_sub) VALUES($1,'system',$2,$3) RETURNING id",
        [sessionId, isGroup
          ? `${operatorName || "成员"} 邀请了 ${added.map(member => member.name).join('、')} 进入群聊`
          : `${operatorName || "成员"} 向 ${added[0].name} 发起了聊天`, userId],
      );
      systemMessageId = Number(event.rows[0].id);
      // 仅真正成群时永久保留群聊标记。
      await client.query(
        `UPDATE agent_sessions SET cowork_ever_group=true
         WHERE id=$1 AND $2`, [sessionId, isGroup]);
    }
    await client.query("COMMIT");
    if (added.length) void notifySessionMembers(sessionId, added).catch(error => console.warn("[agent-kit] 会话通知失败:", error));
    return { ok: true, systemMessageId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/**
 * 人机聊天升级为群时的群设置初始化：仅当该会话尚未配置群模型（cowork_model IS NULL）时，
 * 用升级前会话正在使用的框架/模型填充 cowork_mode/cowork_model/cowork_codex_model，
 * 保证增强群沿用升级前的模型（如 hy3），而不是回落到群默认模型（hy4 preview）。
 * 只允许会话所有者调用；已配置过群模型的会话不受影响。
 */
export async function initAgentSessionCoworkSettings(
  userId: string,
  sessionId: string,
  init: { mode: string | null; model: string | null; codexModel: string | null },
): Promise<void> {
  const p = getPool();
  if (!p) return;
  await ensureMigrated();
  await p.query(
    `UPDATE agent_sessions SET
       cowork_mode = COALESCE($2, cowork_mode),
       cowork_model = COALESCE($3, cowork_model),
       cowork_codex_model = COALESCE($4, cowork_codex_model)
     WHERE id=$1 AND cowork_model IS NULL AND user_id=$5`,
    [sessionId, init.mode, init.model, init.codexModel, userId],
  );
}

/**
 * 退出群聊（非创建者）：把自己从成员表移除，并插入系统消息「xx 已退出群聊」。
 * 返回 ok=false 表示当前用户不是该会话成员；创建者不能调用（由解散群承担）。
 */
export async function removeAgentSessionMember(userId: string, sessionId: string): Promise<{ ok: boolean; systemMessageId: number | null; name: string }> {
  const p = getPool();
  if (!p) return { ok: false, systemMessageId: null, name: "" };
  await ensureMigrated();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const profile = await client.query("SELECT name FROM users WHERE provider || ':' || union_id = $1", [userId]);
    const name = String(profile.rows[0]?.name ?? "");
    // 通过 users 反查成员表里自己的行（与 SESSION_VISIBLE_CLAUSE 同一匹配口径）
    const removed = await client.query(
      `DELETE FROM agent_session_members sm USING users u
       WHERE sm.session_id=$1 AND u.provider=sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
         AND u.provider || ':' || u.union_id=$2
       RETURNING sm.contact_id`,
      [sessionId, userId],
    );
    if (!removed.rowCount) { await client.query("ROLLBACK"); return { ok: false, systemMessageId: null, name }; }
    await client.query(`DELETE FROM cowork_connection_grants g USING cowork_connections c
      WHERE g.connection_id=c.id AND c.session_id=$1 AND g.user_sub=$2`, [sessionId, userId]);
    await client.query("UPDATE cowork_connections SET enabled=false WHERE session_id=$1 AND owner_sub=$2", [sessionId, userId]);
    // 无论群内是否还有成员都落一条系统消息：创建者（及剩余成员）能看到「xx 已退出群聊」
    const event = await client.query(
      "INSERT INTO agent_messages(session_id,role,content,sender_sub) VALUES($1,'system',$2,$3) RETURNING id",
      [sessionId, `${name || "成员"} 已退出群聊`, userId],
    );
    const systemMessageId = Number(event.rows[0].id);
    await client.query("COMMIT");
    return { ok: true, systemMessageId, name };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/**
 * 群主批量移除成员：仅会话创建者可操作。移除后插入系统消息「x 将 a、b、c 移除了群组」。
 * 返回 removedNames（成员表快照名）供前端展示/通知；被移除成员会收到刷新通知（会话将不可见）。
 */
export async function removeAgentSessionMembers(
  operatorUserId: string,
  sessionId: string,
  contactIds: string[],
): Promise<{ ok: boolean; error?: "forbidden" | "not_found" | "not_a_group"; systemMessageId: number | null; removedNames: string[] }> {
  const p = getPool();
  if (!p) return { ok: false, error: "not_found", systemMessageId: null, removedNames: [] };
  await ensureMigrated();
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query("SELECT user_id FROM agent_sessions WHERE id=$1", [sessionId]);
    if (!owner.rowCount) { await client.query("ROLLBACK"); return { ok: false, error: "not_found", systemMessageId: null, removedNames: [] }; }
    const ownerSub = String(owner.rows[0].user_id);
    // 群主或管理员可移除成员；管理员不能移除群主、其他管理员或自己。
    const operatorIsOwner = ownerSub === operatorUserId;
    const operatorAdmin = await client.query(
      `SELECT 1 FROM cowork_admins a
       LEFT JOIN users u ON u.provider=a.provider AND (u.open_id=a.contact_id OR u.user_code=a.contact_id OR u.union_id=a.contact_id)
       WHERE a.session_id=$1 AND u.provider IS NOT NULL AND u.provider || ':' || u.union_id=$2 LIMIT 1`,
      [sessionId, operatorUserId]);
    if (!operatorIsOwner && !operatorAdmin.rowCount) { await client.query("ROLLBACK"); return { ok: false, error: "forbidden", systemMessageId: null, removedNames: [] }; }
    const profile = await client.query("SELECT COALESCE(NULLIF(name,''),user_code) AS name FROM users WHERE provider || ':' || union_id = $1", [operatorUserId]);
    const operatorName = String(profile.rows[0]?.name ?? "");
    // 取被移除成员（成员表快照；带 resolved sub 识别自己/群主）
    const targets = await client.query(
      `SELECT sm.provider, sm.contact_id, sm.name,
          u.provider || ':' || u.union_id AS sub
       FROM agent_session_members sm
       LEFT JOIN users u ON u.provider=sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR u.union_id=sm.contact_id)
       WHERE sm.session_id=$1 AND sm.contact_id = ANY($2::text[])`,
      [sessionId, contactIds],
    );
    if (!targets.rowCount) { await client.query("ROLLBACK"); return { ok: false, error: "not_found", systemMessageId: null, removedNames: [] }; }
    const protectedTarget = targets.rows.some(row => {
      const sub = row.sub ? String(row.sub) : "";
      if (sub === operatorUserId) return true; // 不能移除自己
      if (sub === ownerSub) return true; // 不能移除群主
      return false;
    });
    // 名单内管理员（按 provider+contact_id 快照）受保护，不可被移除。
    const targetAdmin = await client.query(
      `SELECT 1 FROM cowork_admins a
       JOIN UNNEST($2::text[],$3::text[]) AS t(provider,contact_id) ON t.provider=a.provider AND t.contact_id=a.contact_id
       WHERE a.session_id=$1 LIMIT 1`,
      [sessionId, targets.rows.map(row => String(row.provider)), targets.rows.map(row => String(row.contact_id))]);
    if (protectedTarget || targetAdmin.rowCount) { await client.query("ROLLBACK"); return { ok: false, error: "forbidden", systemMessageId: null, removedNames: [] }; }
    const removedNames = targets.rows.map(row => String(row.name ?? ""));
    const removedRows = targets.rows.map(row => ({ provider: String(row.provider ?? ""), contactId: String(row.contact_id), name: String(row.name ?? ""), avatar: "" }));
    await client.query(
      `DELETE FROM agent_session_members WHERE session_id=$1 AND contact_id = ANY($2::text[])`,
      [sessionId, contactIds],
    );
    await client.query(`DELETE FROM cowork_connection_grants g USING cowork_connections c
      WHERE g.connection_id=c.id AND c.session_id=$1 AND g.user_sub<>$2
        AND NOT EXISTS (SELECT 1 FROM agent_session_members sm JOIN users u ON u.provider=sm.provider
          AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
          WHERE sm.session_id=$1 AND u.provider || ':' || u.union_id=g.user_sub)`, [sessionId, operatorUserId]);
    await client.query(`UPDATE cowork_connections c SET enabled=false WHERE c.session_id=$1 AND c.owner_sub<>$2
      AND NOT EXISTS (SELECT 1 FROM agent_session_members sm JOIN users u ON u.provider=sm.provider
        AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
        WHERE sm.session_id=$1 AND u.provider || ':' || u.union_id=c.owner_sub)`, [sessionId, operatorUserId]);
    const event = await client.query(
      "INSERT INTO agent_messages(session_id,role,content,sender_sub) VALUES($1,'system',$2,$3) RETURNING id",
      [sessionId, `${operatorName || "成员"} 将 ${removedNames.join("、")} 移除了群组`, operatorUserId],
    );
    const systemMessageId = Number(event.rows[0].id);
    await client.query("COMMIT");
    // 被移除成员刷新会话列表（可见性消失）；剩余成员/创建者刷新消息（看到系统消息）
    void notifySessionMembers(sessionId, removedRows).catch(error => console.warn("[agent-kit] 移除成员通知失败:", error));
    void notifySessionMessage(sessionId).catch(error => console.warn("[agent-kit] 移除成员消息通知失败:", error));
    return { ok: true, systemMessageId, removedNames };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function createAgentFeedback(input: { userId: string; sessionId: string; messageId?: number; answer: string; vote: "up" | "down"; categories: string[]; detail: string }): Promise<void> {
  const p = getPool();
  if (!p) throw new Error("database_unavailable");
  await ensureMigrated();
  // 同用户同会话同消息只保留一行投票：先删后插（事务），支持点赞/点踩切换与重复提交不产生重复行。
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM agent_feedback WHERE user_id=$1 AND session_id=$2 AND message_id=$3",
      [input.userId, input.sessionId, input.messageId ?? null],
    );
    await client.query(
      `INSERT INTO agent_feedback (user_id, session_id, message_id, answer_preview, vote, categories, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [input.userId, input.sessionId, input.messageId ?? null, input.answer.slice(0, 4000), input.vote, JSON.stringify(input.categories), input.detail],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** 取消投票（点赞/点踩切换回无状态）：删除该用户在该消息上的反馈行。 */
export async function deleteAgentFeedback(input: { userId: string; sessionId: string; messageId?: number }): Promise<void> {
  const p = getPool();
  if (!p) throw new Error("database_unavailable");
  await ensureMigrated();
  await p.query(
    "DELETE FROM agent_feedback WHERE user_id=$1 AND session_id=$2 AND message_id=$3",
    [input.userId, input.sessionId, input.messageId ?? null],
  );
}

/** 读取某会话下当前用户对各消息的投票（用于前端渲染时 hydrate）。 */
export async function getAgentFeedbackVotes(userId: string, sessionId: string): Promise<Record<number, "up" | "down">> {
  const p = getPool();
  if (!p) throw new Error("database_unavailable");
  await ensureMigrated();
  const result = await p.query(
    "SELECT message_id, vote FROM agent_feedback WHERE user_id=$1 AND session_id=$2 AND message_id IS NOT NULL",
    [userId, sessionId],
  );
  const out: Record<number, "up" | "down"> = {};
  for (const row of result.rows) {
    // BIGINT 经 node-postgres 返回为字符串，需转回数字再作为 map key。
    const mid = Number(row.message_id);
    if (Number.isSafeInteger(mid) && (row.vote === "up" || row.vote === "down")) out[mid] = row.vote;
  }
  return out;
}

export async function listAgentFeedback(limit = 20, offset = 0): Promise<{ rows: unknown[]; total: number }> {
  const p = getPool();
  if (!p) throw new Error("database_unavailable");
  await ensureMigrated();
  const [result, count] = await Promise.all([p.query(
    `SELECT f.id, f.user_id AS "userId", COALESCE(u.name, f.user_id) AS "userName",
            f.session_id AS "sessionId", COALESCE(s.title, '') AS "sessionTitle",
            f.message_id AS "messageId", COALESCE(m.content, f.answer_preview) AS "answerPreview",
            f.vote, f.categories, f.detail, f.created_at AS "createdAt"
       FROM agent_feedback f
       LEFT JOIN users u ON f.user_id = u.provider || ':' || u.union_id
         OR (u.provider = 'dingtalk' AND f.user_id = 'dingtalk:' || u.user_code)
       LEFT JOIN agent_sessions s ON f.session_id = s.id
       LEFT JOIN agent_messages m ON m.id = f.message_id AND m.session_id = f.session_id
      ORDER BY f.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset],
  ), p.query("SELECT COUNT(*)::int AS total FROM agent_feedback")]);
  return { rows: result.rows, total: Number(count.rows[0]?.total ?? 0) };
}

export async function queryAdminFeedbackCategories(): Promise<{ category: string; count: number }[]> {
  const p = getPool();
  if (!p) throw new Error("database_unavailable");
  await ensureMigrated();
  const result = await p.query(`SELECT c.category, COUNT(*)::int AS count
    FROM agent_feedback f, jsonb_array_elements_text(f.categories) AS c(category)
    WHERE f.vote = 'down' GROUP BY c.category ORDER BY count DESC, c.category LIMIT 20`);
  return result.rows.map((row) => ({ category: String(row.category), count: Number(row.count) }));
}

export async function queryAdminFeedbackVoteCounts(): Promise<{ up: number; down: number }> {
  const p = getPool();
  if (!p) throw new Error("database_unavailable");
  await ensureMigrated();
  const result = await p.query(`SELECT COUNT(*) FILTER (WHERE vote = 'up')::int AS up,
    COUNT(*) FILTER (WHERE vote = 'down')::int AS down FROM agent_feedback`);
  return { up: Number(result.rows[0]?.up ?? 0), down: Number(result.rows[0]?.down ?? 0) };
}

export async function queryAdminTopUsers(limit = 20): Promise<{
  userId: string; userName: string; inputTokens: number; outputTokens: number; costUsd: number; messages: number;
}[]> {
  const p = getPool();
  if (!p) throw new Error("database_unavailable");
  await ensureMigrated();
  const result = await p.query(`SELECT s.user_id AS user_id, COALESCE(u.name, s.user_id) AS user_name,
    COALESCE(SUM((m.cost_info->'usage'->>'input_tokens')::bigint), 0)::bigint AS input_tokens,
    COALESCE(SUM((m.cost_info->'usage'->>'output_tokens')::bigint), 0)::bigint AS output_tokens,
    COALESCE(SUM((m.cost_info->>'costUsd')::double precision), 0)::double precision AS cost_usd,
    COUNT(*)::int AS messages
    FROM agent_messages m JOIN agent_sessions s ON s.id = m.session_id
    LEFT JOIN users u ON s.user_id = u.provider || ':' || u.union_id
      OR (u.provider = 'dingtalk' AND s.user_id = 'dingtalk:' || u.user_code)
    WHERE m.cost_info IS NOT NULL AND (m.cost_info->>'inherited') IS DISTINCT FROM 'true'
    GROUP BY s.user_id, u.name
    ORDER BY COALESCE(SUM((m.cost_info->'usage'->>'input_tokens')::bigint), 0)
      + COALESCE(SUM((m.cost_info->'usage'->>'output_tokens')::bigint), 0) DESC
    LIMIT $1`, [Math.max(1, Math.min(100, limit))]);
  return result.rows.map((row) => ({ userId: String(row.user_id), userName: String(row.user_name),
    inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), costUsd: Number(row.cost_usd), messages: Number(row.messages) }));
}

/** 重命名会话（仅限归属用户）。 */
export async function renameAgentSession(
  userId: string,
  sessionId: string,
  title: string,
  userRenamed = false,
  client?: PoolClient,
): Promise<boolean> {
  const p = client ?? getPool();
  if (!p) return false;
  const runner = client ?? p;
  const result = await runner.query(
    `UPDATE agent_sessions SET title = $3, user_renamed = $4, updated_at = now()
     WHERE user_id = $1 AND id = $2`,
    [userId, sessionId, title.slice(0, 250), userRenamed],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateAgentSessionLayout(
  userId: string,
  sessionId: string,
  viewLayout: "single" | "split" | "compare",
): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    `UPDATE agent_sessions SET view_layout = $3 WHERE user_id = $1 AND id = $2`,
    [userId, sessionId, viewLayout],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setAgentSessionMuted(userId: string, sessionId: string, muted: boolean): Promise<boolean> {
  const pool = getPool();
  if (!pool || !await getAgentSession(userId, sessionId)) return false;
  // 打开全量免打扰时必然一并打开 AI 消息免打扰（只升不降：关闭全量免打扰不清 ai_muted）
  await pool.query(`INSERT INTO agent_session_reads(session_id,user_sub,muted) VALUES($1,$2,$3)
    ON CONFLICT(session_id,user_sub) DO UPDATE SET
      muted=EXCLUDED.muted,
      ai_muted=CASE WHEN EXCLUDED.muted THEN true ELSE agent_session_reads.ai_muted END`, [sessionId, userId, muted]);
  return true;
}

/** AI 消息免打扰：仅对 AI（assistant）消息的通知生效；muted=true 时由 setAgentSessionMuted 联动强制打开 */
export async function setAgentSessionAiMuted(userId: string, sessionId: string, aiMuted: boolean): Promise<boolean> {
  const pool = getPool();
  if (!pool || !await getAgentSession(userId, sessionId)) return false;
  await pool.query(`INSERT INTO agent_session_reads(session_id,user_sub,ai_muted) VALUES($1,$2,$3)
    ON CONFLICT(session_id,user_sub) DO UPDATE SET ai_muted=EXCLUDED.ai_muted`, [sessionId, userId, aiMuted]);
  return true;
}

/**
 * 隐藏 / 取消隐藏会话（软删除，仅对当前用户生效）：
 * 只把 agent_session_reads 里的 hidden 置位，不删除服务器上会话与消息的任何数据；
 * 隐藏后该会话从当前用户的列表与跨会话搜索中消失，对方再发消息时由 unhideAgentSession 自动恢复可见。
 */
export async function setAgentSessionHidden(userId: string, sessionId: string, hidden: boolean): Promise<boolean> {
  const pool = getPool();
  if (!pool || !await getAgentSession(userId, sessionId)) return false;
  await pool.query(`INSERT INTO agent_session_reads(session_id,user_sub,hidden) VALUES($1,$2,$3)
    ON CONFLICT(session_id,user_sub) DO UPDATE SET hidden=EXCLUDED.hidden`, [sessionId, userId, hidden]);
  return true;
}

/** 单聊个人删除：共享消息和附件保留，仅推进当前用户的可见历史边界。 */
export async function deletePersonalChat(userId: string, sessionId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool || !await getAgentSession(userId, sessionId)) return false;
  const result = await pool.query(`INSERT INTO agent_session_reads(session_id,user_sub,hidden,deleted_through_id,last_read_message_id)
    SELECT s.id,$1,true,COALESCE(max(m.id),0),COALESCE(max(m.id),0)
    FROM agent_sessions s LEFT JOIN agent_messages m ON m.session_id=s.id
    WHERE s.id=$2 AND NOT s.cowork_ever_group
      AND (SELECT count(*) FROM agent_session_members sm WHERE sm.session_id=s.id)=1
    GROUP BY s.id
    ON CONFLICT(session_id,user_sub) DO UPDATE SET hidden=true,
      deleted_through_id=GREATEST(agent_session_reads.deleted_through_id,EXCLUDED.deleted_through_id),
      last_read_message_id=GREATEST(agent_session_reads.last_read_message_id,EXCLUDED.last_read_message_id)`, [userId,sessionId]);
  return Boolean(result.rowCount);
}

/** 会话有新消息时解除全部参与者的隐藏标记（hidden 置 false），使隐藏的会话自动重新出现在列表。 */
export async function unhideAgentSession(sessionId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.query(`UPDATE agent_session_reads SET hidden=false WHERE session_id=$1 AND hidden=true AND EXISTS (SELECT 1 FROM agent_messages m WHERE m.session_id=$1 AND m.id>agent_session_reads.deleted_through_id)`, [sessionId]);
}

/** 置顶追加到末尾；取消置顶清空顺序，不改变会话的最近活动时间。 */
export async function setAgentSessionPinned(userId: string, sessionId: string, pinned: boolean): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  const result = pinned
    ? await p.query(
        `UPDATE agent_sessions SET pin_order = COALESCE(pin_order,
           (SELECT COALESCE(MAX(pin_order), -1) + 1 FROM agent_sessions WHERE user_id = $1))
         WHERE user_id = $1 AND id = $2`,
        [userId, sessionId],
      )
    : await p.query(
        `UPDATE agent_sessions SET pin_order = NULL WHERE user_id = $1 AND id = $2`,
        [userId, sessionId],
      );
  return (result.rowCount ?? 0) > 0;
}

/** 原子保存当前用户整个置顶组的顺序；旧快照或混入其他用户 ID 时拒绝。 */
export async function reorderPinnedSessions(userId: string, ids: string[]): Promise<boolean> {
  const p = getPool();
  if (!p || new Set(ids).size !== ids.length) return false;
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT id FROM agent_sessions WHERE user_id = $1 AND pin_order IS NOT NULL FOR UPDATE`,
      [userId],
    );
    const expected = new Set(current.rows.map((row) => String(row.id)));
    if (expected.size !== ids.length || ids.some((id) => !expected.has(id))) {
      await client.query("ROLLBACK");
      return false;
    }
    for (let index = 0; index < ids.length; index++) {
      await client.query(
        `UPDATE agent_sessions SET pin_order = $3 WHERE user_id = $1 AND id = $2`,
        [userId, ids[index], index],
      );
    }
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** SDK 自动命名（topic / ai-title）落库：仅当用户从未手动改过标题时覆盖（user_renamed=false），
 *  否则跳过，保护用户手动编辑的标题不被自动命名替换。 */
export async function setSessionTitleIfNotUserRenamed(
  userId: string,
  sessionId: string,
  title: string,
  client?: PoolClient,
): Promise<boolean> {
  if (isInvalidAutoTitle(title)) return false;
  const p = client ?? getPool();
  if (!p) return false;
  const runner = client ?? p;
  const result = await runner.query(
    `UPDATE agent_sessions SET title = $3, updated_at = now()
     WHERE user_id = $1 AND id = $2 AND NOT user_renamed`,
    [userId, sessionId, title.slice(0, 250)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 更新会话工作目录（沙箱范围；传 null 表示清除限定）。仅限归属用户。 */
export async function updateAgentSessionWorkspace(
  userId: string,
  sessionId: string,
  workspaceDir: string | null,
  client?: PoolClient,
): Promise<boolean> {
  const p = client ?? getPool();
  if (!p) return false;
  const runner = client ?? p;
  const result = await runner.query(
    `UPDATE agent_sessions SET workspace_dir = $3, updated_at = now()
     WHERE user_id = $1 AND id = $2`,
    [userId, sessionId, workspaceDir ? workspaceDir.slice(0, 1024) : null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 1v1 人机会话接入/取消接入群：传 null 表示取消。仅会话 owner 可改。 */
export async function updateAgentSessionRefGroup(
  userId: string,
  sessionId: string,
  refGroupId: string | null,
): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  const result = await p.query(
    `UPDATE agent_sessions SET ref_group_id = $3, updated_at = now() WHERE user_id = $1 AND id = $2`,
    [userId, sessionId, refGroupId ? refGroupId.slice(0, 128) : null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 解析「会话接入的群」：必须是群（曾/已是群聊或有成员）且当前用户有权访问（owner 或群成员）。
 *  无权或不是群时返回 null——调用方据此跳过目录注入，不报错暴露群是否存在。 */
export async function resolveSessionGroupRef(
  userId: string,
  refGroupId: string | null,
): Promise<{ id: string; title: string; coworkAvatar: string; workspaceDir: string | null } | null> {
  if (!refGroupId || !/^[a-zA-Z0-9_-]{1,128}$/.test(refGroupId)) return null;
  const p = getPool();
  if (!p) return null;
  await ensureMigrated();
  // getAgentSession 已覆盖「owner 或群成员」两种归属；再叠加群判定，避免把 1v1 会话当群接入。
  const session = await getAgentSession(userId, refGroupId);
  if (!session) return null;
  if (!(session.coworkEverGroup || session.memberCount > 0 || await isAgentGroupSession(refGroupId))) return null;
  return { id: session.id, title: session.title, coworkAvatar: session.coworkAvatar, workspaceDir: session.workspaceDir };
}

/** Sync a local project's sidebar grouping without granting server filesystem access. */
export async function updateAgentSessionProject(userId: string, sessionId: string, projectDir: string | null): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  const result = await p.query(
    `UPDATE agent_sessions SET project_dir = $3 WHERE user_id = $1 AND id = $2`,
    [userId, sessionId, projectDir ? projectDir.slice(0, 1024) : null],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 删除会话（消息级联删除）。发起人或当前 1v1 的唯一已加入成员可解散。 */
export async function deleteAgentSession(
  userId: string,
  sessionId: string,
  client?: PoolClient,
): Promise<boolean> {
  const p = client ?? getPool();
  if (!p) return false;
  const runner = client ?? p;
  const result = await runner.query(
    `DELETE FROM agent_sessions WHERE id=$2 AND user_id=$1`,
    [userId, sessionId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** admin 用量聚合（暂不鉴权）：summary 总量 + 按模型 / 按会话 / 单条消息 Top 消耗。
 *  数据源：agent_messages.cost_info JSONB { costUsd, usage: { input_tokens, output_tokens } }。 */
export async function queryAdminUsage(
  limit = 20,
  offset = 0,
  options: { model?: string; sort?: "input" | "output" | "cost" | "recent" } = {},
): Promise<{
  summary: { inputTokens: number; outputTokens: number; costUsd: number; costedMsgs: number; sessions: number };
  byModel: { model: string; inputTokens: number; outputTokens: number; msgs: number }[];
  bySession: { sessionId: string; title: string; createdAt: Date; inputTokens: number; outputTokens: number; costUsd: number; costedMsgs: number }[];
  details: { id: number; sessionId: string; sessionTitle: string; createdAt: Date; inputTokens: number; outputTokens: number; costUsd: number; model: string; contentPreview: string; userContent: string; user: string }[];
  detailsTotal: number;
} | null> {
  const p = getPool();
  if (!p) return null;
  const model = options.model?.trim() || null;
  const orderBy = {
    input: "(m.cost_info->'usage'->>'input_tokens')::bigint",
    output: "(m.cost_info->'usage'->>'output_tokens')::bigint",
    cost: "(m.cost_info->>'costUsd')::double precision",
    recent: "m.created_at",
  }[options.sort ?? "input"];
  const [sum, byModel, bySession, details, detailsCount] = await Promise.all([
    p.query(
      `SELECT
         COALESCE(SUM((m.cost_info->'usage'->>'input_tokens')::bigint), 0)::bigint AS input_tokens,
         COALESCE(SUM((m.cost_info->'usage'->>'output_tokens')::bigint), 0)::bigint AS output_tokens,
         COALESCE(SUM((m.cost_info->>'costUsd')::double precision), 0)::double precision AS cost_usd,
         COUNT(*) FILTER (WHERE m.cost_info IS NOT NULL) AS costed_msgs,
         COUNT(DISTINCT m.session_id) AS sessions
       FROM agent_messages m WHERE (m.cost_info->>'inherited') IS DISTINCT FROM 'true'`,
    ),
    p.query(
      `SELECT
         COALESCE(m.model_info->'models'->>0, '?') AS model,
         COALESCE(SUM((m.cost_info->'usage'->>'input_tokens')::bigint), 0)::bigint AS input_tokens,
         COALESCE(SUM((m.cost_info->'usage'->>'output_tokens')::bigint), 0)::bigint AS output_tokens,
         COUNT(*) AS msgs
       FROM agent_messages m
       WHERE m.cost_info IS NOT NULL AND (m.cost_info->>'inherited') IS DISTINCT FROM 'true'
       GROUP BY 1
       ORDER BY input_tokens DESC`,
    ),
    p.query(
      `SELECT
         s.id AS session_id, s.title, s.created_at,
         COALESCE(SUM((m.cost_info->'usage'->>'input_tokens')::bigint), 0)::bigint AS input_tokens,
         COALESCE(SUM((m.cost_info->'usage'->>'output_tokens')::bigint), 0)::bigint AS output_tokens,
         COALESCE(SUM((m.cost_info->>'costUsd')::double precision), 0)::double precision AS cost_usd,
         COUNT(*) FILTER (WHERE m.cost_info IS NOT NULL) AS costed_msgs
       FROM agent_sessions s
       JOIN agent_messages m ON m.session_id = s.id
       WHERE m.cost_info IS NOT NULL AND (m.cost_info->>'inherited') IS DISTINCT FROM 'true'
       GROUP BY s.id, s.title, s.created_at
       ORDER BY input_tokens DESC`,
    ),
    p.query(
      `SELECT
         m.id, m.session_id, s.title AS session_title, s.user_id,
         u.name AS user_name,
         m.created_at,
         (m.cost_info->'usage'->>'input_tokens')::bigint AS input_tokens,
         (m.cost_info->'usage'->>'output_tokens')::bigint AS output_tokens,
         (m.cost_info->>'costUsd')::double precision AS cost_usd,
         COALESCE(m.model_info->'models'->>0, '?') AS model,
         left(m.content, 200) AS content_preview,
         -- 该轮的用户提问：同一会话中、本条消息之前最近的一条 user 消息内容
         (
           SELECT left(u2.content, 200)
           FROM agent_messages u2
           WHERE u2.session_id = m.session_id AND u2.role = 'user' AND u2.id < m.id
           ORDER BY u2.id DESC
           LIMIT 1
         ) AS user_content
       FROM agent_messages m
       JOIN agent_sessions s ON s.id = m.session_id
       LEFT JOIN users u ON u.provider || ':' || u.union_id = s.user_id
         OR (u.provider = 'dingtalk' AND s.user_id = 'dingtalk:' || u.user_code)
       WHERE m.cost_info IS NOT NULL AND (m.cost_info->>'inherited') IS DISTINCT FROM 'true'
         AND ($3::text IS NULL OR COALESCE(m.model_info->'models'->>0, '?') = $3)
       ORDER BY ${orderBy} DESC NULLS LAST, m.id DESC
       LIMIT $1 OFFSET $2`,
      [Math.max(1, Math.min(100, limit)), Math.max(0, offset), model],
    ),
    p.query(`SELECT COUNT(*)::int AS total FROM agent_messages m
      WHERE m.cost_info IS NOT NULL AND (m.cost_info->>'inherited') IS DISTINCT FROM 'true'
        AND ($1::text IS NULL OR COALESCE(m.model_info->'models'->>0, '?') = $1)`, [model]),
  ]);
  const num = (v: unknown) => Number(v ?? 0);
  const summary = {
    inputTokens: num(sum.rows[0]?.input_tokens),
    outputTokens: num(sum.rows[0]?.output_tokens),
    costUsd: num(sum.rows[0]?.cost_usd),
    costedMsgs: num(sum.rows[0]?.costed_msgs),
    sessions: num(sum.rows[0]?.sessions),
  };
  return {
    summary,
    detailsTotal: Number(detailsCount.rows[0]?.total ?? 0),
    byModel: byModel.rows.map((r) => ({
      model: String(r.model ?? "?"),
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      msgs: num(r.msgs),
    })),
    bySession: bySession.rows.map((r) => ({
      sessionId: String(r.session_id),
      title: String(r.title ?? ""),
      createdAt: r.created_at as Date,
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      costUsd: num(r.cost_usd),
      costedMsgs: num(r.costed_msgs),
    })),
    details: details.rows.map((r) => ({
      id: num(r.id),
      sessionId: String(r.session_id),
      sessionTitle: String(r.session_title ?? ""),
      createdAt: r.created_at as Date,
      inputTokens: num(r.input_tokens),
      outputTokens: num(r.output_tokens),
      costUsd: num(r.cost_usd),
      model: String(r.model ?? "?"),
      contentPreview: String(r.content_preview ?? ""),
      userContent: r.user_content != null ? String(r.user_content) : "",
      user: r.user_name != null ? String(r.user_name) : (r.user_id != null ? String(r.user_id) : ""),
    })),
  };
}

/** 追加一条消息并刷新会话更新时间。 */
export async function addAgentMessage(
  sessionId: string,
  role: string,
  content: string,
  images?: unknown,
  steps?: unknown,
  thinkingSecs?: number | null,
  modelInfo?: unknown,
  artifacts?: unknown,
  attachment?: unknown,
  elapsedSecs?: number | null,
  costInfo?: unknown,
  client?: PoolClient,
  runId?: string,
  voice?: unknown,
  senderSub?: string,
): Promise<number | null> {
  const p = client ?? getPool();
  if (!p) return null;
  // 写入前等待迁移完成（幂等，毫秒级；防止新列在引擎刚启动的首条消息上缺失）
  await ensureMigrated();
  const runner = client ?? p;
  const result = await runner.query(
    `INSERT INTO agent_messages (session_id, role, content, images, steps, thinking_secs, model_info, artifacts, attachment, elapsed_secs, cost_info, run_id, voice, sender_sub)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      sessionId,
      role,
      content,
      images ? JSON.stringify(images) : null,
      steps ? JSON.stringify(steps) : null,
      thinkingSecs != null ? Math.round(thinkingSecs) : null,
      modelInfo ? JSON.stringify(modelInfo) : null,
      artifacts && Array.isArray(artifacts) && artifacts.length ? JSON.stringify(capArtifactsForMessage(artifacts)) : null,
      attachment && typeof attachment === "object" ? JSON.stringify(attachment) : null,
      elapsedSecs != null ? Math.round(elapsedSecs) : null,
      costInfo && typeof costInfo === "object" ? JSON.stringify(costInfo) : null,
      role === "assistant" && runId ? runId : null,
      role === "user" && voice ? JSON.stringify(voice) : null,
      role === "user" ? senderSub ?? null : null,
    ],
  );
  await runner.query("UPDATE agent_sessions SET updated_at = now() WHERE id = $1", [sessionId]);
  return result.rows[0] ? Number(result.rows[0].id) : null;
}

/** 仅发送者可撤回自己的消息；保留占位，并清除可展示的内容。 */
export async function revokeAgentMessage(userId: string, sessionId: string, messageId: number): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  await ensureMigrated();
  const result = await pool.query(
    `UPDATE agent_messages SET content='', images=NULL, attachment=NULL, voice=NULL, revoked_at=now()
     WHERE id=$1 AND session_id=$2 AND role='user' AND sender_sub=$3 AND revoked_at IS NULL
     RETURNING id`,
    [messageId, sessionId, userId],
  );
  if (result.rowCount) {
    // 撤回后即时通知全部参与者刷新会话列表（预览回退到最后一条未撤回消息）
    void notifySessionMessage(sessionId).catch(error => console.error("[db] revoke notify failed", error));
  }
  return Boolean(result.rowCount);
}

/** 会话内全部消息（按时间正序）；不属于当前用户返回空数组。 */
export async function listAgentMessages(
  userId: string,
  sessionId: string,
  client?: PoolClient,
): Promise<AgentMessageRow[]> {
  const p = client ?? getPool();
  if (!p) return [];
  const runner = client ?? p;
  const result = await runner.query(
    `SELECT m.*, CASE WHEN m.role='assistant' THEN COALESCE(m.cowork_agent_name,ca.name,'${AI_DISPLAY_NAME}') ELSE COALESCE(NULLIF(u.name,''),u.user_code) END AS sender_name, u.avatar AS sender_avatar
     FROM agent_messages m
     JOIN agent_sessions s ON s.id = m.session_id
     LEFT JOIN cowork_agents ca ON ca.id = m.cowork_agent_id
     LEFT JOIN users u ON u.provider || ':' || u.union_id = COALESCE(m.sender_sub, s.user_id)
     WHERE m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.session_id = $2 AND (s.user_id = $1 OR EXISTS (
       SELECT 1 FROM agent_session_members sm JOIN users viewer
         ON viewer.provider = sm.provider AND (viewer.open_id=sm.contact_id OR viewer.user_code=sm.contact_id OR (viewer.provider='builtin' AND viewer.union_id=sm.contact_id))
       WHERE sm.session_id = s.id AND viewer.provider || ':' || viewer.union_id = $1
     ))
     ORDER BY m.id ASC`,
    [userId, sessionId],
  );
  return result.rows.map(rowToMessage);
}

/** 群聊增量读取，沿用会话成员权限校验；用于高频共享流式状态刷新。 */
export async function listAgentMessagesSince(userId: string, sessionId: string, afterId: number): Promise<AgentMessageRow[]> {
  const p = getPool();
  if (!p) return [];
  const result = await p.query(
    `SELECT m.*, CASE WHEN m.role='assistant' THEN COALESCE(m.cowork_agent_name,ca.name,'${AI_DISPLAY_NAME}') ELSE COALESCE(NULLIF(u.name,''),u.user_code) END AS sender_name, u.avatar AS sender_avatar
     FROM agent_messages m JOIN agent_sessions s ON s.id=m.session_id
     LEFT JOIN cowork_agents ca ON ca.id=m.cowork_agent_id
     LEFT JOIN users u ON u.provider || ':' || u.union_id=COALESCE(m.sender_sub,s.user_id)
     WHERE m.id > COALESCE((SELECT dr.deleted_through_id FROM agent_session_reads dr WHERE dr.session_id=s.id AND dr.user_sub=$1),0) AND m.session_id=$2 AND m.id>$3 AND (s.user_id=$1 OR EXISTS (
       SELECT 1 FROM agent_session_members sm JOIN users viewer
         ON viewer.provider=sm.provider AND (viewer.open_id=sm.contact_id OR viewer.user_code=sm.contact_id OR (viewer.provider='builtin' AND viewer.union_id=sm.contact_id))
       WHERE sm.session_id=s.id AND viewer.provider || ':' || viewer.union_id=$1
     )) ORDER BY m.id ASC`,
    [userId, sessionId, afterId],
  );
  return result.rows.map(rowToMessage);
}

/** Mark messages actually rendered by this viewer as read, without allowing the cursor to move backwards. */
export async function markAgentSessionRead(userId: string, sessionId: string, throughId: number): Promise<void> {
  const pool = getPool();
  if (!pool || !Number.isSafeInteger(throughId) || throughId < 0) return;
  await ensureMigrated();
  const session = await getAgentSession(userId, sessionId);
  if (!session) return;
  await pool.query(`INSERT INTO agent_session_reads(session_id,user_sub,last_read_message_id)
    VALUES($1,$2,LEAST($3::bigint,COALESCE((SELECT max(id) FROM agent_messages WHERE session_id=$1),0)))
    ON CONFLICT(session_id,user_sub) DO UPDATE SET
      last_read_message_id=GREATEST(agent_session_reads.last_read_message_id,EXCLUDED.last_read_message_id),updated_at=now()`,
    [sessionId,userId,throughId]);
}

/** 当前用户所有可见会话「全部已读」：游标一次性推进到各自最新消息；可见性须与 SESSION_VISIBLE_CLAUSE 逐字一致。
 *  注意：INSERT...SELECT 中同一 $1 会出现在 SELECT 列 / text 列比较 / 拼接比较多处，
 *  Postgres 无法统一推断参数类型（inconsistent types），必须显式 ::text 强转。 */
export async function markAgentSessionsReadAll(userId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await ensureMigrated();
  await pool.query(`INSERT INTO agent_session_reads(session_id,user_sub,last_read_message_id)
    SELECT s.id, $1::text, COALESCE((SELECT max(m.id) FROM agent_messages m WHERE m.session_id=s.id),0)
    FROM agent_sessions s
    WHERE s.user_id = $1::text OR EXISTS (
      SELECT 1 FROM agent_session_members sm JOIN users u
        ON u.provider = sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
      WHERE sm.session_id = s.id AND u.provider || ':' || u.union_id = $1::text
    )
    ON CONFLICT(session_id,user_sub) DO UPDATE SET
      last_read_message_id=GREATEST(agent_session_reads.last_read_message_id,EXCLUDED.last_read_message_id),updated_at=now()`,
    [userId]);
}

export interface MessageReader { userSub: string; name: string; avatar: string; read: boolean }

/** Resolve the people who belonged to the conversation when a message was sent. */
export async function getAgentMessageReaders(userId: string, sessionId: string, messageId: number): Promise<MessageReader[] | null> {
  const pool = getPool();
  if (!pool || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
  await ensureMigrated();
  if (!await getAgentSession(userId,sessionId)) return null;
  const message = await pool.query(`SELECT m.id,m.created_at,m.sender_sub,s.user_id FROM agent_messages m
    JOIN agent_sessions s ON s.id=m.session_id WHERE m.session_id=$1 AND m.id=$2 AND m.role='user'`,[sessionId,messageId]);
  if (!message.rowCount || (message.rows[0].sender_sub ?? message.rows[0].user_id) !== userId) return null;
  const result = await pool.query(`WITH participants AS (
      SELECT s.user_id AS user_sub, COALESCE(u.name,'发起人') AS name, COALESCE(u.avatar,'') AS avatar
      FROM agent_sessions s LEFT JOIN users u ON u.provider || ':' || u.union_id=s.user_id WHERE s.id=$1
      UNION
      SELECT COALESCE(u.provider || ':' || u.union_id,sm.provider || ':' || sm.contact_id),
        COALESCE(NULLIF(u.name,''),sm.name),COALESCE(u.avatar,sm.avatar)
      FROM agent_session_members sm LEFT JOIN users u ON u.provider=sm.provider
        AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
      WHERE sm.session_id=$1 AND sm.added_at<=$2
    ) SELECT DISTINCT ON (p.user_sub) p.user_sub,p.name,p.avatar,COALESCE(r.last_read_message_id,0)>=$3 AS read
      FROM participants p LEFT JOIN agent_session_reads r ON r.session_id=$1 AND r.user_sub=p.user_sub
      WHERE p.user_sub<>$4 ORDER BY p.user_sub`,[sessionId,message.rows[0].created_at,messageId,userId]);
  return result.rows.map(row=>({userSub:String(row.user_sub),name:String(row.name),avatar:String(row.avatar),read:Boolean(row.read)}));
}

/** Copy a bounded history in one transaction; serialize suffix allocation per owner. */
export async function forkAgentSession(userId: string, sourceId: string, messageIndex: number, messageId?: number, snapshot?: unknown): Promise<AgentSessionRow> {
  const pool = getPool();
  if (!pool) throw new Error("数据库不可用");
  await ensureMigrated();
  const client = await pool.connect();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);
    const source = await client.query("SELECT * FROM agent_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [sourceId, userId]);
    if (!source.rows[0]) throw new Error("会话不存在或无权访问");
    const history = await listAgentMessages(userId, sourceId, client);
    const selected = mergeBranchSnapshot(selectBranchMessages(history, messageIndex, messageId), snapshot);
    const titles = await client.query("SELECT title FROM agent_sessions WHERE user_id = $1", [userId]);
    const title = nextBranchTitle(String(source.rows[0].title), titles.rows.map((row) => String(row.title)));
    const id = randomUUID();
    const workspace = source.rows[0].workspace_dir as string | undefined;
    const prepared = await copyBranchFiles(sourceId, id, selected, workspace);
    cleanup = prepared.cleanup;
    const inserted = await client.query("INSERT INTO agent_sessions (id, user_id, title, workspace_dir, project_dir, user_renamed) VALUES ($1, $2, $3, $4, $5, true) RETURNING *", [id, userId, title, workspace ?? null, source.rows[0].project_dir ?? null]);
    for (const message of prepared.messages) {
      await client.query(`INSERT INTO agent_messages (session_id, role, content, images, steps, thinking_secs, elapsed_secs, model_info, artifacts, attachment, cost_info, created_at, voice)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, message.role, message.content,
        JSON.stringify(message.images), JSON.stringify(message.steps), message.thinkingSecs, message.elapsedSecs,
        JSON.stringify(message.modelInfo), JSON.stringify(message.artifacts), JSON.stringify(message.attachment), JSON.stringify(message.costInfo && typeof message.costInfo === "object" ? { ...message.costInfo, inherited: true } : null), message.createdAt, JSON.stringify(message.voice)]);
    }
    await client.query("COMMIT");
    const lastMsg = selected.at(-1);
    const lastQuestion = [...selected].reverse().find((message) => message.role === "user");
    return { ...rowToSession(inserted.rows[0]), messageCount: selected.length,
      lastPreview: messagePreviewTextServer(lastMsg?.content, lastMsg?.attachment) || null,
      lastQuestionPreview: messagePreviewTextServer(lastQuestion?.content, lastQuestion?.attachment) || null,
      lastUserPreview: messagePreviewTextServer(lastQuestion?.content, lastQuestion?.attachment) || null };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await cleanup?.();
    throw error;
  } finally { client.release(); }
}

/** 会话内所有用户消息的附件 url 列表（删会话清理磁盘文件前收集，须在删除会话前调用）。 */
export async function listSessionAttachmentUrls(
  userId: string,
  sessionId: string,
  client?: PoolClient,
): Promise<string[]> {
  const p = client ?? getPool();
  if (!p) return [];
  const runner = client ?? p;
  const result = await runner.query(
    `SELECT m.attachment
     FROM agent_messages m
     JOIN agent_sessions s ON s.id = m.session_id
     WHERE s.user_id = $1 AND m.session_id = $2 AND m.role = 'user' AND m.attachment IS NOT NULL`,
    [userId, sessionId],
  );
  const urls: string[] = [];
  for (const row of result.rows) {
    const value = (row as Record<string, unknown>).attachment;
    for (const att of Array.isArray(value) ? value : value ? [value] : []) {
      if (att && typeof att === "object" && typeof att.url === "string" && att.url) urls.push(att.url);
    }
  }
  return urls;
}

/** 截断会话：删除指定 id（含）之后的所有消息（编辑重发时调用，让刷新后不出现旧消息）。 */
export async function truncateAgentMessages(
  userId: string,
  sessionId: string,
  upToId: number,
): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(
    `DELETE FROM agent_messages m
     USING agent_sessions s
     WHERE s.id = m.session_id AND s.user_id = $1 AND m.session_id = $2 AND m.id > $3`,
    [userId, sessionId, upToId],
  );
}

// ----------------------------- 文件索引（agent_files） -----------------------------

/** 文件行。 */
export interface FileRow {
  id: string;
  ownerSub: string;
  sessionId: string | null;
  kind: "output" | "input" | "userfile";
  name: string;
  mime: string | null;
  size: number;
  storageKey: string;
  folder: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 注入式查询执行器（测试可用 fake 注入；生产用进程池）。 */
export type QueryRunner = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> };

function rowToFile(row: Record<string, unknown>): FileRow {
  return {
    id: String(row.id),
    ownerSub: String(row.owner_sub),
    sessionId: row.session_id == null ? null : String(row.session_id),
    kind: (String(row.kind) as FileRow["kind"]) ?? "output",
    name: String(row.name ?? ""),
    mime: row.mime == null ? null : String(row.mime),
    size: Number(row.size ?? 0),
    storageKey: String(row.storage_key),
    folder: row.folder == null ? null : String(row.folder),
    deletedAt: row.deleted_at == null ? null : (row.deleted_at instanceof Date ? row.deleted_at : new Date(String(row.deleted_at))),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}

/** 登记一个文件索引行（幂等：同 id 忽略）。 */
export async function createFile(
  row: {
    id: string;
    ownerSub: string;
    sessionId?: string | null;
    kind: "output" | "input" | "userfile";
    name: string;
    mime?: string | null;
    size: number;
    storageKey: string;
    folder?: string | null;
  },
  client?: QueryRunner,
): Promise<boolean> {
  const p = client ?? getPool();
  if (!p) return false;
  await ensureMigrated();
  try {
    await p.query(
      `INSERT INTO agent_files (id, owner_sub, session_id, kind, name, mime, size, storage_key, folder)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         updated_at = now(),
         session_id = COALESCE(EXCLUDED.session_id, agent_files.session_id),
         name = EXCLUDED.name, size = EXCLUDED.size, mime = EXCLUDED.mime,
         storage_key = EXCLUDED.storage_key, folder = EXCLUDED.folder
       WHERE agent_files.deleted_at IS NULL`,
      [
        row.id, row.ownerSub, row.sessionId ?? null, row.kind, row.name.slice(0, 512),
        row.mime ?? null, row.size, row.storageKey, row.folder ?? null,
      ],
    );
    return true;
  } catch (e) {
    console.error(`[agent-kit auth/db] createFile 失败:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** 按 fileId 取文件行；软删/不存在返回 null。 */
export async function getFileById(fileId: string, client?: QueryRunner): Promise<FileRow | null> {
  const p = client ?? getPool();
  if (!p) return null;
  const result = await p.query(
    `SELECT * FROM agent_files WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
    [fileId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? rowToFile(row) : null;
}

/** 资料库列表：按 owner 过滤，可选 session / kind / 关键词 / 排除软删。
 *  附带 session_exists（会话被删 → 标注"会话已删除"，D1）。 */
export async function listFilesByOwner(
  ownerSub: string,
  opts?: { sessionId?: string; kind?: string; q?: string; includeDeleted?: boolean; limit?: number },
  client?: QueryRunner,
): Promise<Array<FileRow & { sessionExists: boolean }>> {
  const p = client ?? getPool();
  if (!p) return [];
  const where: string[] = ["f.owner_sub = $1"];
  const params: unknown[] = [ownerSub];
  if (!opts?.includeDeleted) where.push("f.deleted_at IS NULL");
  if (opts?.sessionId) { params.push(opts.sessionId); where.push(`f.session_id = $${params.length}`); }
  if (opts?.kind) { params.push(opts.kind); where.push(`f.kind = $${params.length}`); }
  if (opts?.q) { params.push(`%${opts.q}%`); where.push(`(f.name ILIKE $${params.length} OR COALESCE(f.folder, '') ILIKE $${params.length} OR s.title ILIKE $${params.length})`); }
  params.push(Math.max(1, Math.min(500, opts?.limit ?? 200)));
  const result = await p.query(
    `SELECT f.*, (s.id IS NOT NULL) AS session_exists
     FROM agent_files f
     LEFT JOIN agent_sessions s ON s.id = f.session_id
     WHERE ${where.join(" AND ")} ORDER BY f.updated_at DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((r) => {
    const f = rowToFile(r as Record<string, unknown>);
    return { ...f, sessionExists: Boolean((r as Record<string, unknown>).session_exists) };
  });
}

/**
 * 按会话列出文件；并附 session_exists 标记（会话被删 → true 之外的"会话已删除"判定）。
 * 用于资料库"会话已删除"标注（D1）。
 */
export async function listFilesBySession(
  sessionId: string,
  opts?: { ownerSub?: string; kind?: string; includeDeleted?: boolean },
  client?: QueryRunner,
): Promise<Array<FileRow & { sessionExists: boolean }>> {
  const p = client ?? getPool();
  if (!p) return [];
  const where: string[] = ["f.session_id = $1"];
  const params: unknown[] = [sessionId];
  if (!opts?.includeDeleted) where.push("f.deleted_at IS NULL");
  if (opts?.ownerSub) { params.push(opts.ownerSub); where.push(`f.owner_sub = $${params.length}`); }
  if (opts?.kind) { params.push(opts.kind); where.push(`f.kind = $${params.length}`); }
  const result = await p.query(
    `SELECT f.*, (s.id IS NOT NULL) AS session_exists
     FROM agent_files f
     LEFT JOIN agent_sessions s ON s.id = f.session_id
     WHERE ${where.join(" AND ")} ORDER BY f.updated_at DESC`,
    params,
  );
  return result.rows.map((r) => {
    const f = rowToFile(r as Record<string, unknown>);
    return { ...f, sessionExists: Boolean((r as Record<string, unknown>).session_exists) };
  });
}

/** 改文件的归属会话（fork 复制 / 重新归类用）。 */
export async function updateFileSession(fileId: string, sessionId: string | null, client?: QueryRunner): Promise<void> {
  const p = client ?? getPool();
  if (!p) return;
  await p.query(
    `UPDATE agent_files SET session_id = $2, updated_at = now() WHERE id = $1`,
    [fileId, sessionId],
  );
}

/** 软删：仅标记 deleted_at，不动字节（保留在资料库、可恢复）。 */
export async function softDeleteFile(fileId: string, client?: QueryRunner): Promise<void> {
  const p = client ?? getPool();
  if (!p) return;
  await p.query(
    `UPDATE agent_files SET deleted_at = now(), updated_at = now() WHERE id = $1`,
    [fileId],
  );
}

/** 一次软删当前用户选中的文件；owner 过滤防止跨用户批量操作。 */
export async function softDeleteFilesByOwner(ownerSub: string, fileIds: string[], client?: QueryRunner): Promise<string[]> {
  const p = client ?? getPool();
  if (!p || fileIds.length === 0) return [];
  const result = await p.query(
    `UPDATE agent_files SET deleted_at = now(), updated_at = now()
     WHERE owner_sub = $1 AND id = ANY($2::text[]) AND deleted_at IS NULL RETURNING id`,
    [ownerSub, fileIds],
  );
  return result.rows.map((row) => String((row as Record<string, unknown>).id));
}

/** 独立文件改名；严格限定 owner 与 userfile，防止修改会话产物。 */
export async function renameUserFile(ownerSub: string, fileId: string, name: string, client?: QueryRunner): Promise<boolean> {
  const p = client ?? getPool();
  if (!p) return false;
  const result = await p.query(
    `UPDATE agent_files SET name = $3, updated_at = now()
     WHERE id = $1 AND owner_sub = $2 AND kind = 'userfile' AND deleted_at IS NULL RETURNING id`,
    [fileId, ownerSub, name],
  );
  return result.rows.length > 0;
}

/** 硬删：删字节 + 删行 + 删其 file 级分享。返回被删行的 storageKey（供调用方清理）。 */
export async function hardDeleteFile(fileId: string, client?: QueryRunner): Promise<string | null> {
  const p = client ?? getPool();
  if (!p) return null;
  const got = await getFileById(fileId, client);
  if (!got) return null;
  try {
    await deleteSharesForFile(fileId, client);
    await p.query(`DELETE FROM agent_files WHERE id = $1`, [fileId]);
  } catch (e) {
    console.error(`[agent-kit auth/db] hardDeleteFile 失败:`, e instanceof Error ? e.message : e);
  }
  return got.storageKey;
}

/** 会话归属的用户主体键（用于把产物/输入索引到正确的 owner）。带短 TTL 缓存。 */
const sessionOwnerCache = new Map<string, { sub: string; at: number }>();
export async function getOwnerSubBySession(sessionId: string, client?: QueryRunner): Promise<string | null> {
  const p = client ?? getPool();
  if (!p) return null;
  const cached = sessionOwnerCache.get(sessionId);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.sub;
  const result = await p.query(`SELECT user_id FROM agent_sessions WHERE id = $1 LIMIT 1`, [sessionId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const sub = row ? String(row.user_id) : null;
  if (sub) sessionOwnerCache.set(sessionId, { sub, at: Date.now() });
  return sub;
}

// ----------------------------- 会话分享（外部只读） -----------------------------

/** 分享记录行。 */
export interface ShareRow {
  token: string;
  sessionId: string | null;
  scopeType: "session" | "file";
  scopeId: string;
  /** 创建者主体键 `${provider}:${unionId}` */
  createdBy: string;
  permission: "view" | "comment" | "edit";
  granteeSub: string | null;
  expiresAt: Date | null;
  revoked: boolean;
  createdAt: Date;
}

/** 按主键查分享记录；不存在返回 null。 */
export async function getShareByToken(token: string, client?: QueryRunner): Promise<ShareRow | null> {
  const p = client ?? getPool();
  if (!p) return null;
  const result = await p.query(
    `SELECT token, session_id, scope_type, scope_id, created_by, permission, grantee_sub, expires_at, revoked, created_at
     FROM agent_shares WHERE token = $1 LIMIT 1`,
    [token],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    token: String(row.token),
    sessionId: row.session_id == null ? null : String(row.session_id),
    scopeType: (String(row.scope_type) as ShareRow["scopeType"]) ?? "session",
    scopeId: String(row.scope_id ?? ""),
    createdBy: String(row.created_by),
    permission: (String(row.permission) as ShareRow["permission"]) ?? "view",
    granteeSub: row.grantee_sub == null ? null : String(row.grantee_sub),
    expiresAt: row.expires_at == null ? null : (row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at))),
    revoked: Boolean(row.revoked),
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/** 创建分享记录（兼容旧签名：仅会话级）。会话级时 sessionId 即 scopeId。 */
export async function createShareRecord(
  token: string,
  sessionId: string,
  userId: string,
  client?: QueryRunner,
): Promise<boolean> {
  return createShare({ token, scopeType: "session", scopeId: sessionId, sessionId, createdBy: userId }, client);
}

/** 创建分享记录（双粒度）。文件级时 sessionId 可留空。 */
export async function createShare(
  share: {
    token: string;
    scopeType: "session" | "file";
    scopeId: string;
    sessionId?: string | null;
    createdBy: string;
    permission?: "view" | "comment" | "edit";
    granteeSub?: string | null;
    expiresAt?: Date | null;
  },
  client?: QueryRunner,
): Promise<boolean> {
  const p = client ?? getPool();
  if (!p) return false;
  await ensureMigrated();
  try {
    await p.query(
      `INSERT INTO agent_shares (token, session_id, scope_type, scope_id, created_by, permission, grantee_sub, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (token) DO NOTHING`,
      [
        share.token, share.sessionId ?? null, share.scopeType, share.scopeId, share.createdBy,
        share.permission ?? "view", share.granteeSub ?? null, share.expiresAt ?? null,
      ],
    );
    return true;
  } catch (e) {
    console.error(`[agent-kit auth/db] createShare 失败:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/** 取某 file 的分享列表（owner 用，管理权限/撤销）。 */
export async function listSharesForFile(fileId: string, client?: QueryRunner): Promise<ShareRow[]> {
  const p = client ?? getPool();
  if (!p) return [];
  const result = await p.query(
    `SELECT token, session_id, scope_type, scope_id, created_by, permission, grantee_sub, expires_at, revoked, created_at
     FROM agent_shares WHERE scope_type = 'file' AND scope_id = $1 ORDER BY created_at DESC`,
    [fileId],
  );
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      token: String(row.token),
      sessionId: row.session_id == null ? null : String(row.session_id),
      scopeType: "file" as const,
      scopeId: String(row.scope_id ?? ""),
      createdBy: String(row.created_by),
      permission: (String(row.permission) as ShareRow["permission"]) ?? "view",
      granteeSub: row.grantee_sub == null ? null : String(row.grantee_sub),
      expiresAt: row.expires_at == null ? null : (row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at))),
      revoked: Boolean(row.revoked),
      createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
    };
  });
}

/** 撤销分享（仅创建者）。返回是否成功。 */
export async function revokeShare(token: string, ownerSub: string, client?: QueryRunner): Promise<boolean> {
  const p = client ?? getPool();
  if (!p) return false;
  const result = await p.query(
    `UPDATE agent_shares SET revoked = true WHERE token = $1 AND created_by = $2`,
    [token, ownerSub],
  );
  return (result.rowCount ?? 0) > 0;
}

/** 删除某文件的所有 file 级分享（硬删文件时调用）。 */
export async function deleteSharesForFile(fileId: string, client?: QueryRunner): Promise<void> {
  const p = client ?? getPool();
  if (!p) return;
  await p.query(
    `DELETE FROM agent_shares WHERE scope_type = 'file' AND scope_id = $1`,
    [fileId],
  );
}

// ----------------------------- 分享 / ACL 网关（强制在 API 层） -----------------------------

/**
 * ACL 核心：viewer 能否访问某 fileId。
 *  - owner 直接过；
 *  - 已发送到群聊的输入文件，当前群成员可读；草稿上传仍仅上传者可读；
 *  - 否则查生效的 file 级 share（未撤销、未过期、公开或指定人=viewer）；
 *  - 否则拒绝。所有文件读取必须过这一关，与目录无关（结构上防穿越）。
 */
export async function canAccessFile(fileId: string, viewerSub: string | null, client?: QueryRunner): Promise<boolean> {
  const p = client ?? getPool();
  if (!p) return false;
  const f = await getFileById(fileId, client);
  if (!f) return false;
  if (f.ownerSub === viewerSub) return true;
  if (viewerSub && f.kind === "input" && f.sessionId) {
    const posted = await p.query(
      `SELECT 1 FROM agent_sessions s
       WHERE s.id=$1
         AND EXISTS (
           SELECT 1 FROM agent_session_members sm JOIN users u
             ON u.provider=sm.provider AND (u.open_id=sm.contact_id OR u.user_code=sm.contact_id OR (u.provider='builtin' AND u.union_id=sm.contact_id))
           WHERE sm.session_id=s.id AND u.provider || ':' || u.union_id=$3
         )
         AND EXISTS (
           SELECT 1 FROM agent_messages m
           WHERE m.session_id=s.id AND m.revoked_at IS NULL
             AND (m.attachment @> jsonb_build_object('fileId', $2::text)
               OR m.attachment @> jsonb_build_array(jsonb_build_object('fileId', $2::text)))
         )
       LIMIT 1`,
      [f.sessionId, fileId, viewerSub],
    );
    if (posted.rows.length) return true;
  }
  const result = await p.query(
    `SELECT 1 FROM agent_shares
     WHERE scope_type = 'file' AND scope_id = $1 AND revoked = false
       AND (expires_at IS NULL OR expires_at > now())
       AND (grantee_sub IS NULL OR grantee_sub = $2)
     LIMIT 1`,
    [fileId, viewerSub],
  );
  return result.rows.length > 0;
}

/**
 * 读取鉴权：优先用分享 token（公开/匿名访问），否则用登录用户做 ACL。
 * 返回是否允许读取该 fileId。
 */
export async function readAccessForFile(
  fileId: string,
  viewerSub: string | null,
  shareToken: string | null,
  client?: QueryRunner,
): Promise<boolean> {
  if (shareToken) {
    const share = await getShareByToken(shareToken, client);
    if (!share || share.scopeType !== "file" || share.scopeId !== fileId) return false;
    if (share.revoked) return false;
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) return false;
    if (share.granteeSub && share.granteeSub !== viewerSub) return false;
    return true;
  }
  return canAccessFile(fileId, viewerSub, client);
}

/** 按 session_id 查会话标题（公开分享页展示用；不校验归属）。 */
export async function getSessionTitleBySessionId(sessionId: string): Promise<string> {
  const p = getPool();
  if (!p) return "";
  const result = await p.query(`SELECT title FROM agent_sessions WHERE id = $1 LIMIT 1`, [sessionId]);
  const row = result.rows[0] as { title?: unknown } | undefined;
  return row && typeof row.title === "string" ? row.title : "";
}

/** 公开读取会话消息（分享页用；不校验用户归属，依赖分享 token 不可枚举）。 */
export async function listAgentMessagesPublic(sessionId: string): Promise<AgentMessageRow[]> {
  const p = getPool();
  if (!p) return [];
  const result = await p.query(
    `SELECT m.*
     FROM agent_messages m
     WHERE m.session_id = $1
     ORDER BY m.id ASC`,
    [sessionId],
  );
  return result.rows.map(rowToMessage);
}

/** 按主体键 `${provider}:${unionId}` 查钉钉 userid / 飞书 employee_id（OA 发送消息时作为 sender 使用）。 */
export async function getUserCodeByKey(userId: string): Promise<string> {
  const p = getPool();
  if (!p) return "";
  const { provider, unionId } = parseSessionKey(userId);
  if (!provider || !unionId) return "";
  const result = await p.query(
    `SELECT user_code FROM users WHERE provider = $1 AND union_id = $2 LIMIT 1`,
    [provider, unionId],
  );
  const row = result.rows[0] as { user_code?: unknown } | undefined;
  return row && typeof row.user_code === "string" ? row.user_code : "";
}
