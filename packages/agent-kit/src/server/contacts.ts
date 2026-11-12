import { loadAuthConfig } from "./auth/config.js";
import { verifySession } from "./auth/handlers.js";
import { getDingTalkToken, getFeishuTenantToken, refreshFeishuUserToken } from "./oa.js";
import { ensureMigrated, getPool, getUserOauthTokenByKey, updateUserOauthToken } from "./auth/db.js";
import type { AuthConfig } from "./auth/types.js";
import { pinyin } from "pinyin-pro";

export interface CompanyContact { id: string; name: string; department: string; title: string; avatar: string; email: string; mobile: string; pinyin: string; provider: "dingtalk" | "feishu"; isSelf?: boolean }

class ContactApiError extends Error {
  constructor(readonly stage: string, readonly code: string, message: string, readonly permissionDenied: boolean) {
    super(message);
  }
}

/**
 * 中文姓名转拼音，返回「全拼 + 首字母」组合串（小写），例如「张三」→ "zhangsan zs"，
 * 供通讯录拼音搜索（输入 zhangsan / zs / zha 都能命中）。非中文部分原样保留。
 * pinyin-pro 为纯 JS、无外部依赖；emoji/符号会被忽略，不影响匹配。
 */
function nameToPinyin(name: string): string {
  if (!name) return "";
  const full = pinyin(name, { toneType: "none", type: "string", separator: "" }).toLowerCase();
  const initials = pinyin(name, { pattern: "first", toneType: "none", type: "string", separator: "" }).toLowerCase();
  return `${full} ${initials}`.trim();
}

async function jsonRequest(url: string, stage: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  const code = String(data.errcode ?? data.code ?? response.status);
  if (!response.ok || (data.errcode !== undefined && Number(data.errcode) !== 0) || (data.code !== undefined && Number(data.code) !== 0)) {
    const message = String(data.errmsg || data.msg || data.message || `HTTP ${response.status}`);
    const permissionDenied = response.status === 403 || /权限|无权|未授权|无权限|access denied|permission|forbidden|scope|no privilege|not authorized/i.test(message);
    throw new ContactApiError(stage, code, message, permissionDenied);
  }
  return data;
}

export async function dingTalkContacts(key: string, secret: string): Promise<CompanyContact[]> {
  const token = await getDingTalkToken(key, secret);
  const call = (path: string, body: object, stage: string) => jsonRequest(`https://oapi.dingtalk.com/${path}?access_token=${encodeURIComponent(token)}`, stage, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const queue: Array<{ id: number; path: string }> = [{ id: 1, path: "" }];
  const seenDepartments = new Set<number>();
  const contacts = new Map<string, CompanyContact>();
  while (queue.length) {
    const current = queue.shift()!;
    if (seenDepartments.has(current.id)) continue;
    seenDepartments.add(current.id);
    const children = await call("topapi/v2/department/listsub", { dept_id: current.id }, "读取部门");
    for (const child of children.result || []) queue.push({ id: Number(child.dept_id), path: [current.path, child.name].filter(Boolean).join(" / ") });
    for (let cursor = 0, more = true; more;) {
      const page = (await call("topapi/v2/user/list", { dept_id: current.id, cursor, size: 100 }, "读取成员")).result || {};
      for (const user of page.list || []) {
        const id = String(user.userid || "");
        if (!id) continue;
        const existing = contacts.get(id);
        const department = current.path || "总部";
        contacts.set(id, { id, name: user.name || "未命名", department: existing ? [existing.department, department].filter((v, i, a) => a.indexOf(v) === i).join("、") : department,
          title: user.title || "", avatar: user.avatar || "", email: user.email || "", mobile: user.mobile || "", pinyin: nameToPinyin(user.name || "未命名"), provider: "dingtalk" });
      }
      more = Boolean(page.has_more);
      cursor = Number(page.next_cursor ?? cursor + 100);
    }
  }
  return [...contacts.values()];
}

export async function feishuContacts(appId: string, secret: string, baseUrl: string): Promise<CompanyContact[]> {
  const token = await getFeishuTenantToken(appId, secret, baseUrl);
  const call = (path: string, params: Record<string, string>, stage: string) => {
    const url = new URL(`${baseUrl}/open-apis/contact/v3/${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return jsonRequest(url.toString(), stage, { headers: { Authorization: `Bearer ${token}` } });
  };
  const queue = [{ id: "0", path: "" }];
  const seenDepartments = new Set<string>();
  const contacts = new Map<string, CompanyContact>();
  while (queue.length) {
    const current = queue.shift()!;
    if (seenDepartments.has(current.id)) continue;
    seenDepartments.add(current.id);
    for (let pageToken = "", more = true; more;) {
      const data = (await call(`departments/${encodeURIComponent(current.id)}/children`, { department_id_type: "department_id", page_size: "50", ...(pageToken ? { page_token: pageToken } : {}) }, `读取部门 ${current.id}`)).data || {};
      for (const child of data.items || []) queue.push({ id: child.department_id, path: [current.path, child.name].filter(Boolean).join(" / ") });
      more = Boolean(data.has_more); pageToken = data.page_token || "";
      if (more && !pageToken) throw new Error("飞书部门分页缺少 page_token");
    }
    for (let pageToken = "", more = true; more;) {
      const data = (await call("users", { department_id: current.id, department_id_type: "department_id", user_id_type: "open_id", page_size: "50", ...(pageToken ? { page_token: pageToken } : {}) }, `读取部门 ${current.id} 的成员`)).data || {};
      for (const user of data.items || []) {
        const id = String(user.open_id || user.user_id || "");
        if (!id) continue;
        const existing = contacts.get(id);
        const department = current.path || "总部";
        contacts.set(id, { id, name: user.name || "未命名", department: existing ? [existing.department, department].filter((v, i, a) => a.indexOf(v) === i).join("、") : department,
          title: user.job_title || "", avatar: user.avatar?.avatar_72 || user.avatar?.avatar_origin || "", email: user.email || "", mobile: user.mobile || "", pinyin: nameToPinyin(user.name || "未命名"), provider: "feishu" });
      }
      more = Boolean(data.has_more); pageToken = data.page_token || "";
      if (more && !pageToken) throw new Error("飞书成员分页缺少 page_token");
    }
  }
  return [...contacts.values()];
}

type Provider = "dingtalk" | "feishu";
const syncs = new Map<string, Promise<void>>();

function organizationKey(provider: Provider, config: AuthConfig): string {
  return provider === "dingtalk" ? `dingtalk:${config.dingtalk.corpId}` : `feishu:${config.feishu.appId}`;
}

/**
 * 给联系人列表标记「当前登录用户自己」：用 users 表反查 user_code/open_id，
 * 命中即置 isSelf=true，前端据此在选人列表里标注「（你自己）」，避免误把自己拉进会话。
 */
export async function markSelfContacts(userSub: string, contacts: CompanyContact[]): Promise<CompanyContact[]> {
  if (!contacts.length) return contacts;
  const pool = getPool();
  if (!pool) return contacts;
  await ensureMigrated();
  const me = await pool.query("SELECT user_code, open_id FROM users WHERE provider || ':' || union_id = $1 LIMIT 1", [userSub]);
  const row = me.rows[0] as { user_code?: string | null; open_id?: string | null } | undefined;
  if (!row) return contacts;
  const selfIds = new Set<string>([String(row.user_code ?? ""), String(row.open_id ?? "")]);
  return contacts.map(contact => selfIds.has(contact.id) ? { ...contact, isSelf: true } : contact);
}

export async function findCompanyContacts(provider: Provider, config: AuthConfig, ids: string[]): Promise<CompanyContact[]> {
  const pool = getPool();
  if (!pool || !ids.length) return [];
  await ensureMigrated();
  const result = await pool.query("SELECT contact_id AS id, name, department, title, avatar, email, mobile, pinyin, provider FROM company_contacts WHERE organization_key=$1 AND contact_id=ANY($2::text[])", [organizationKey(provider, config), ids]);
  return result.rows as unknown as CompanyContact[];
}

/** 校验钉钉原生选人器返回的用户 ID，并从 OA 实时获取展示信息。 */
export async function findDingTalkContactsByIds(config: AuthConfig, ids: string[]): Promise<CompanyContact[]> {
  if (!ids.length) return [];
  const token = await getDingTalkToken(config.dingtalk.clientId, config.dingtalk.clientSecret);
  const results = await Promise.all(ids.map(async id => {
    try {
      const detail = await jsonRequest(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(token)}`, "用户详情", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userid: id, language: "zh_CN" }),
      });
      const person = detail.result || {};
      return { id, name: String(person.name || id), department: "", title: String(person.title || ""), avatar: String(person.avatar || ""), email: String(person.email || ""), mobile: String(person.mobile || ""), pinyin: "", provider: "dingtalk" as const };
    } catch { return null; }
  }));
  return results.filter((contact): contact is NonNullable<typeof contact> => contact !== null);
}

async function searchDingTalkAsApp(config: AuthConfig, query: string): Promise<CompanyContact[]> {
  const token = await getDingTalkToken(config.dingtalk.clientId, config.dingtalk.clientSecret);
  const response = await fetch("https://api.dingtalk.com/v1.0/contact/users/search", {
    method: "POST", headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
    body: JSON.stringify({ queryWord: query, offset: 0, size: 50 }), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json() as { code?: string; message?: string; list?: string[] };
  if (!response.ok || data.code) throw new Error(data.message || data.code || `钉钉搜索失败：HTTP ${response.status}`);
  if (!Array.isArray(data.list)) throw new Error("钉钉搜索返回了无效的数据");
  const ids = data.list.filter((id): id is string => typeof id === "string" && !!id).slice(0, 50);
  return findDingTalkContactsByIds(config, ids);
}

export async function findUserSearchContacts(userId: string, ids: string[], provider: Provider = "feishu"): Promise<CompanyContact[]> {
  const pool = getPool();
  if (!pool || !ids.length) return [];
  await ensureMigrated();
  const result = await pool.query("SELECT contact_id AS id, name, avatar FROM company_contact_search_results WHERE user_key=$1 AND contact_id=ANY($2::text[]) AND expires_at>now()", [userId, ids]);
  const rows = result.rows.map(row => ({ id: String(row.id), name: String(row.name), avatar: String(row.avatar), department: "", title: "", email: "", mobile: "", pinyin: "", provider }));
  const found = new Set(rows.map(row => row.id));
  const missing = ids.filter(id => !found.has(id));
  // 兜底：搜索结果缓存（10 分钟 TTL）之外的联系人，从组织通讯录快照解析。
  // 全局搜索命中的联系人来自 company_contacts（组织快照），未必进过 OA 实时搜索缓存，
  // 不补这一层，「点联系人建会话」就会 400 contact_not_found。
  if (missing.length) {
    const config = loadAuthConfig();
    const orgKey = organizationKey(provider, config);
    const snapshot = await pool.query(
      "SELECT contact_id AS id, name, avatar, department, title, email FROM company_contacts WHERE organization_key=$1 AND contact_id=ANY($2::text[])",
      [orgKey, missing],
    );
    for (const row of snapshot.rows) {
      rows.push({
        id: String(row.id), name: String(row.name), avatar: String(row.avatar),
        department: String(row.department ?? ""), title: String(row.title ?? ""), email: String(row.email ?? ""),
        mobile: "", pinyin: "", provider,
      });
    }
  }
  return rows;
}

async function searchFeishuAsUser(userId: string, config: AuthConfig, query: string): Promise<CompanyContact[]> {
  const oauth = await getUserOauthTokenByKey(userId);
  if (!oauth?.accessToken) throw new Error("当前登录尚未取得飞书用户授权，请重新登录");
  const call = async (token: string) => {
    const url = new URL(`${config.feishu.baseUrl}/open-apis/search/v1/user`);
    url.searchParams.set("query", query);
    url.searchParams.set("page_size", "50");
    const data = await jsonRequest(url.toString(), "用户搜索", { headers: { Authorization: `Bearer ${token}` } });
    const users = data.data?.users;
    if (!Array.isArray(users)) return [];
    return users.map((person: Record<string, any>) => ({
      id: String(person.open_id || ""), name: String(person.name || ""), department: "",
      title: "", avatar: String(person.avatar?.avatar_72 || ""), email: "", mobile: "", pinyin: "", provider: "feishu" as const,
    })).filter((person: CompanyContact) => person.id);
  };
  try { return await call(oauth.accessToken); }
  catch (error) {
    if (!oauth.refreshToken) throw error;
    const refreshed = await refreshFeishuUserToken(config.feishu.appId, config.feishu.appSecret, config.feishu.baseUrl, oauth.refreshToken);
    await updateUserOauthToken(userId, { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken ?? undefined });
    return call(refreshed.accessToken);
  }
}

function startSync(provider: Provider, config: AuthConfig): Promise<void> {
  const key = organizationKey(provider, config);
  const existing = syncs.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const pool = getPool();
    if (!pool) throw new Error("通讯录同步需要 PostgreSQL");
    await ensureMigrated();
    const client = await pool.connect();
    try {
      // 跨进程只允许一个同步者；锁持有到本轮外部拉取和事务提交结束。
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key]);
      if (!lock.rows[0]?.locked) return;
      try {
        const contacts = provider === "dingtalk"
          ? await dingTalkContacts(config.dingtalk.clientId, config.dingtalk.clientSecret)
          : await feishuContacts(config.feishu.appId, config.feishu.appSecret, config.feishu.baseUrl);
        await client.query("BEGIN");
        try {
          // 全量快照在事务内替换。外部拉取失败时旧数据保持可用；离职成员随成功同步删除。
          await client.query("DELETE FROM company_contacts WHERE organization_key=$1", [key]);
          for (let i = 0; i < contacts.length; i += 100) {
            const batch = contacts.slice(i, i + 100);
            const params: unknown[] = [];
            const values = batch.map((contact, index) => {
              params.push(key, provider, contact.id, contact.name, contact.department, contact.title, contact.avatar, contact.email, contact.mobile, contact.pinyin);
              return `(${Array.from({ length: 10 }, (_, j) => `$${index * 10 + j + 1}`).join(",")})`;
            });
            await client.query(`INSERT INTO company_contacts (organization_key, provider, contact_id, name, department, title, avatar, email, mobile, pinyin) VALUES ${values.join(",")}`, params);
          }
          await client.query("INSERT INTO company_contact_sync (organization_key, provider, synced_at, attempted_at, last_error) VALUES ($1,$2,now(),now(),NULL) ON CONFLICT (organization_key) DO UPDATE SET synced_at=now(), attempted_at=now(), last_error=NULL", [key, provider]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
      } catch (error) {
        await client.query("INSERT INTO company_contact_sync (organization_key, provider, attempted_at, last_error) VALUES ($1,$2,now(),$3) ON CONFLICT (organization_key) DO UPDATE SET attempted_at=now(), last_error=$3", [key, provider, error instanceof Error ? error.message : String(error)]).catch(() => {});
        throw error;
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      }
    } finally { client.release(); }
  })();
  syncs.set(key, pending);
  void pending.finally(() => { if (syncs.get(key) === pending) syncs.delete(key); }).catch(() => {});
  return pending;
}

/** 历史快照补算拼音：老数据在新增 pinyin 列时默认空串，等下次全量同步最多要 24h。
 *  这里用已落库的 name 在进程内直接算拼音回填，仅在存在 pinyin 空行时才执行（已补齐则为空操作）。 */
async function backfillPinyinForOrg(provider: Provider, config: AuthConfig): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  const key = organizationKey(provider, config);
  try {
    const rows = await pool.query<{ id: string; name: string }>(
      "SELECT contact_id AS id, name FROM company_contacts WHERE organization_key=$1 AND (pinyin IS NULL OR pinyin='')",
      [key],
    );
    if (!rows.rowCount) return;
    for (let i = 0; i < rows.rows.length; i += 100) {
      const batch = rows.rows.slice(i, i + 100);
      const placeholders = batch.map((_, index) => `($${index * 2 + 2}, $${index * 2 + 3})`).join(",");
      const params: unknown[] = [key];
      for (const row of batch) params.push(row.id, nameToPinyin(row.name));
      await pool.query(
        `UPDATE company_contacts AS c SET pinyin = v.pinyin FROM (VALUES ${placeholders}) AS v(id, pinyin) WHERE c.organization_key=$1 AND c.contact_id = v.id`,
        params,
      );
    }
  } catch (error) {
    console.error("[contacts] pinyin backfill failed", error instanceof Error ? error.message : error);
  }
}

/** 按需检查当前组织是否已有快照；没有则后台开始首轮同步。 */
export async function ensureOrganizationContacts(provider: Provider, config: AuthConfig): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await ensureMigrated();
  const key = organizationKey(provider, config);
  // 新增 pinyin 列后，对存量快照一次性补算拼音（仅当存在空行时真正执行）
  void backfillPinyinForOrg(provider, config).catch(error => console.error("[contacts] pinyin backfill failed", error));
  const state = await pool.query<{ synced_at: Date | null; attempted_at: Date | null }>("SELECT synced_at, attempted_at FROM company_contact_sync WHERE organization_key=$1", [key]);
  if (!state.rows[0]?.synced_at && (!state.rows[0]?.attempted_at || Date.now() - new Date(state.rows[0].attempted_at).getTime() > 5 * 60_000)) {
    void startSync(provider, config).catch(error => console.error("[contacts] initial sync failed", error));
  }
}

/** 测试或管理操作可显式触发同步。 */
export function clearContactsCache(): void { /* 通讯录已改为数据库快照，无进程缓存。 */ }

/** 应用内选人弹窗使用的实时 OA 搜索代理。 */
export async function searchOaContacts(request: Request): Promise<Response> {
  const config = loadAuthConfig();
  const user = verifySession(request, config);
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (user.provider !== "dingtalk" && user.provider !== "feishu") return Response.json({ error: "当前登录方式没有企业通讯录" }, { status: 400 });
  const query = ((await request.json().catch(() => ({}))) as { query?: unknown }).query;
  if (typeof query !== "string" || query.length > 100) return Response.json({ error: "无效的搜索词" }, { status: 400 });
  if (!query.trim()) return Response.json({ provider: user.provider, contacts: [] }, { headers: { "Cache-Control": "private, no-store" } });
  const pool = getPool();
  if (!pool) return Response.json({ error: "联系人搜索需要配置 PostgreSQL" }, { status: 503 });
  try {
    const contacts = user.provider === "feishu"
      ? await searchFeishuAsUser(user.sub, config, query.trim())
      : await searchDingTalkAsApp(config, query.trim());
    await ensureMigrated();
    if (contacts.length) {
      const values: unknown[] = [];
      const placeholders = contacts.map((contact, index) => {
        values.push(user.sub, contact.id, contact.name, contact.avatar);
        const p = index * 4;
        return `($${p + 1},$${p + 2},$${p + 3},$${p + 4},now()+interval '10 minutes')`;
      });
      await pool.query(`INSERT INTO company_contact_search_results (user_key, contact_id, name, avatar, expires_at) VALUES ${placeholders.join(",")} ON CONFLICT (user_key, contact_id) DO UPDATE SET name=EXCLUDED.name, avatar=EXCLUDED.avatar, expires_at=EXCLUDED.expires_at`, values);
    }
    const marked = await markSelfContacts(user.sub, contacts);
    return Response.json({ provider: user.provider, contacts: marked }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: "OA 联系人搜索失败", detail: error instanceof Error ? error.message : String(error) }, { status: 502, headers: { "Cache-Control": "private, no-store" } });
  }
}

export async function getCompanyContacts(request: Request): Promise<Response> {
  const config = loadAuthConfig();
  const user = verifySession(request, config);
  if (!user) return Response.json({ error: "请先登录" }, { status: 401 });
  if (user.provider !== "dingtalk" && user.provider !== "feishu") return Response.json({ error: "当前登录方式没有企业通讯录" }, { status: 400 });
  const pool = getPool();
  if (!pool) return Response.json({ error: "通讯录需要配置 PostgreSQL" }, { status: 503 });
  if (new URL(request.url).searchParams.has("mode")) return Response.json({ error: "不支持的通讯录查询模式" }, { status: 400 });
  try {
    await ensureMigrated();
    const key = organizationKey(user.provider, config);
    const state = await pool.query<{ synced_at: Date | null; attempted_at: Date | null; last_error: string | null }>("SELECT synced_at, attempted_at, last_error FROM company_contact_sync WHERE organization_key=$1", [key]);
    if (!state.rows[0]?.synced_at && (new URL(request.url).searchParams.get("refresh") === "1" || !state.rows[0]?.attempted_at || Date.now() - new Date(state.rows[0].attempted_at).getTime() > 5 * 60_000)) {
      void startSync(user.provider, config).catch(error => console.error("[contacts] initial sync failed", error));
    }
    const result = await pool.query("SELECT contact_id AS id, name, department, title, avatar, email, mobile, pinyin, provider FROM company_contacts WHERE organization_key=$1 ORDER BY name", [key]);
    if (!state.rows[0]?.synced_at && state.rows[0]?.last_error) {
      return Response.json({ error: "通讯录同步失败", detail: state.rows[0].last_error, suggestion: "请检查应用通讯录权限，或稍后重试。" }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
    }
    const marked = await markSelfContacts(user.sub, result.rows as unknown as CompanyContact[]);
    return Response.json({ provider: user.provider, contacts: marked, syncing: !state.rows[0]?.synced_at, syncError: state.rows[0]?.last_error || null }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("[contacts] database read failed", error);
    return Response.json({ error: "通讯录读取失败", detail: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}
