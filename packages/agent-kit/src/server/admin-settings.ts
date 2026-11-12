/**
 * agent-kit · 管理控制台配置（基本设置 / 算力统筹）
 *
 * 把控制台里所有可编辑项收敛到一张 admin_settings 表（单键 'global' 存整份 JSON），
 * 管理员在控制台编辑后整份覆盖写入；普通登录用户可读取（供 SDK 运行时使用）。
 *
 * 端点（在 kit-api.ts 中接线）：
 *   GET  /api/agent-kit-admin/settings        -> 普通登录用户读取（verifySession）
 *   GET  /api/agent-kit-admin/admin/settings  -> 管理员读取（admin Cookie）
 *   PUT  /api/agent-kit-admin/admin/settings  -> 管理员整份覆盖写入
 */
import { getPool, isDbEnabled } from "./auth/db.js";
import { verifySession } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import { verifyAdmin } from "./sessions.js";

const SETTINGS_KEY = "global";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ConnectorItem {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  enabled: boolean;
}

export interface AdminSettings {
  basic: {
    prompts: { systemPrompt: string; groupPrompt: string };
    skills: SkillItem[];
    connectors: ConnectorItem[];
  };
  compute: {
    resourcePool: { totalConcurrency: number; models: string; note: string };
    allocation: { strategy: "fair" | "priority" | "fixed"; perUserQuota: number; burst: boolean; note: string };
  };
}

export function getDefaultSettings(): AdminSettings {
  return {
    basic: {
      prompts: { systemPrompt: "", groupPrompt: "" },
      skills: [],
      connectors: [],
    },
    compute: {
      resourcePool: { totalConcurrency: 0, models: "", note: "" },
      allocation: { strategy: "fair", perUserQuota: 0, burst: false, note: "" },
    },
  };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asStrategy(v: unknown): "fair" | "priority" | "fixed" {
  return v === "priority" || v === "fixed" ? v : "fair";
}

/** 把任意输入收敛成合法 AdminSettings（缺字段补默认，类型不符纠正），保证落库与前端安全。 */
export function normalizeSettings(input: unknown): AdminSettings {
  const def = getDefaultSettings();
  const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const basic = (obj.basic && typeof obj.basic === "object" ? obj.basic : {}) as Record<string, unknown>;
  const compute = (obj.compute && typeof obj.compute === "object" ? obj.compute : {}) as Record<string, unknown>;

  const prompts = (basic.prompts && typeof basic.prompts === "object" ? basic.prompts : {}) as Record<string, unknown>;
  const skillsRaw = Array.isArray(basic.skills) ? basic.skills : [];
  const connectorsRaw = Array.isArray(basic.connectors) ? basic.connectors : [];

  const resourcePool = (compute.resourcePool && typeof compute.resourcePool === "object" ? compute.resourcePool : {}) as Record<string, unknown>;
  const allocation = (compute.allocation && typeof compute.allocation === "object" ? compute.allocation : {}) as Record<string, unknown>;

  return {
    basic: {
      prompts: {
        systemPrompt: str(prompts.systemPrompt),
        groupPrompt: str(prompts.groupPrompt),
      },
      skills: skillsRaw
        .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
        .map((s, i) => ({
          id: str(s.id) || `skill_${i + 1}`,
          name: str(s.name),
          description: str(s.description),
          enabled: bool(s.enabled),
        })),
      connectors: connectorsRaw
        .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
        .map((c, i) => ({
          id: str(c.id) || `conn_${i + 1}`,
          name: str(c.name),
          type: str(c.type),
          endpoint: str(c.endpoint),
          enabled: bool(c.enabled),
        })),
    },
    compute: {
      resourcePool: {
        totalConcurrency: num(resourcePool.totalConcurrency),
        models: str(resourcePool.models),
        note: str(resourcePool.note),
      },
      allocation: {
        strategy: asStrategy(allocation.strategy),
        perUserQuota: num(allocation.perUserQuota),
        burst: bool(allocation.burst),
        note: str(allocation.note),
      },
    },
  };
}

/** 读取整份配置；无数据库或尚无配置时返回默认值。 */
export async function getAdminSettings(): Promise<AdminSettings> {
  if (!isDbEnabled()) return getDefaultSettings();
  const p = getPool();
  if (!p) return getDefaultSettings();
  try {
    const res = await p.query("SELECT value FROM admin_settings WHERE key=$1", [SETTINGS_KEY]);
    if (res.rows.length === 0) return getDefaultSettings();
    return normalizeSettings(res.rows[0].value);
  } catch (e) {
    console.error("[agent-kit admin-settings] 读取失败:", e instanceof Error ? e.message : e);
    return getDefaultSettings();
  }
}

/** 整份覆盖写入配置（先做 normalize，保证落库结构合法）。 */
export async function saveAdminSettings(input: unknown): Promise<AdminSettings> {
  const value = normalizeSettings(input);
  if (!isDbEnabled()) return value;
  const p = getPool();
  if (!p) return value;
  try {
    await p.query(
      `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=now()`,
      [SETTINGS_KEY, JSON.stringify(value)],
    );
  } catch (e) {
    console.error("[agent-kit admin-settings] 写入失败:", e instanceof Error ? e.message : e);
    throw e;
  }
  return value;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** GET /api/agent-kit-admin/settings：普通登录用户读取（供 SDK 运行时拉取提示词/技能等）。 */
export async function getSettings(request: Request): Promise<Response> {
  const user = verifySession(request, loadAuthConfig());
  if (!user) return json({ error: "未登录或登录已过期" }, 401);
  return json({ settings: await getAdminSettings() });
}

/** GET /api/agent-kit-admin/admin/settings：管理员读取。 */
export async function adminGetSettings(request: Request): Promise<Response> {
  if (!verifyAdmin(request)) return json({ error: "未登录或登录已过期，请先登录" }, 401);
  return json({ settings: await getAdminSettings() });
}

/** PUT /api/agent-kit-admin/admin/settings：管理员整份覆盖写入。 */
export async function adminSaveSettings(request: Request): Promise<Response> {
  if (!verifyAdmin(request)) return json({ error: "未登录或登录已过期，请先登录" }, 401);
  const body = (await request.json().catch(() => ({}))) as { settings?: unknown };
  if (!body || typeof body !== "object" || !("settings" in body)) {
    return json({ error: "请求体缺少 settings 字段" }, 400);
  }
  try {
    const saved = await saveAdminSettings(body.settings);
    return json({ settings: saved });
  } catch {
    return json({ error: "保存配置失败" }, 500);
  }
}
