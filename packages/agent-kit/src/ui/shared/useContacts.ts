"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "./apiFetch.ts";

/** 企业联系人（前端视图模型，与服务端 CompanyContact 字段对齐） */
export type CompanyContactUi = {
  id: string; name: string; department: string; title: string;
  avatar: string; email: string; mobile: string; pinyin?: string; provider: "dingtalk" | "feishu" | "builtin";
  /** 服务端标记：该联系人即当前登录用户自己（选人列表标注「（你自己）」） */
  isSelf?: boolean;
};

export type ContactsError = { title: string; detail: string; suggestion: string };

/** 模块级缓存：通讯录页 / 联系人选择弹窗共享同一份数据，短 TTL 内互不重复请求 */
const cache = new Map<string, { contacts: CompanyContactUi[]; ts: number }>();
const CACHE_TTL = 60_000;

/**
 * 企业通讯录加载 hook：所有需要联系人列表的界面（通讯录页、会话邀请、
 * 新建任务选人）统一走这里，禁止各自再复制一份 fetch 逻辑。
 * - 命中缓存（60s 内）直接返回，不发起请求；
 * - reload() 清缓存强制重拉（界面「刷新 / 重试」按钮用）；
 * - 错误透出服务端的 title/detail/suggestion 三段结构，供界面完整展示。
 */
export function useContacts(basePath: string, options?: { enabled?: boolean; query?: string; search?: boolean; provider?: "dingtalk" | "feishu" | "builtin" }) {
  const enabled = options?.enabled ?? true;
  const provider = options?.provider;
  const search = options?.search ?? false;
  const query = options?.query?.trim() ?? "";
  const cacheKey = `${basePath}:${provider ?? "company"}:${search ? `search:${query}` : "all"}`;
  const [contacts, setContacts] = useState<CompanyContactUi[]>(() => {
    const hit = cache.get(cacheKey);
    return hit && Date.now() - hit.ts < CACHE_TTL ? hit.contacts : [];
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ContactsError | null>(null);
  const [tick, setTick] = useState(0);
  const forceRefreshForRef = useRef("");
  // query 变化 = 换了「数据集」。上面的 useState 初始化函数只在首次挂载跑一次，
  // 之后 cacheKey 再变 contacts 仍是上一批数据 —— 搜索框清空后旧结果会残留到新请求返回，
  // 表现为列表闪一下旧内容。这里在渲染期同步纠正（React 官方推荐的
  // 「adjust state when a prop changes」写法），保证旧数据不会被绘制出来。
  const [prevCacheKey, setPrevCacheKey] = useState(cacheKey);
  if (prevCacheKey !== cacheKey) {
    setPrevCacheKey(cacheKey);
    const hit = cache.get(cacheKey);
    setContacts(hit && Date.now() - hit.ts < CACHE_TTL ? hit.contacts : []);
    setLoading(false);
    setError(null);
  }
  const reload = useCallback(() => {
    // 记录这次强制刷新是针对哪个查询的：换词后不应把 refresh=1 带给新查询
    forceRefreshForRef.current = cacheKey;
    cache.delete(cacheKey);
    setTick(t => t + 1);
  }, [cacheKey]);
  useEffect(() => {
    if (!enabled) return;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      setContacts(hit.contacts);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const forceRefresh = forceRefreshForRef.current === cacheKey;
    forceRefreshForRef.current = "";
    setLoading(true);
    setError(null);
    const load = async (retry = true): Promise<{ contacts?: CompanyContactUi[]; syncing?: boolean }> => {
      try {
        if (provider === "builtin") {
          const launcher = (globalThis as typeof globalThis & { launcher?: { contactsApi(method: string, path: string): Promise<{ ok: boolean; status: number; data?: { friends?: Array<{ id: string; name: string; avatar?: string }>; error?: string } }> } }).launcher;
          const result = launcher?.contactsApi
            ? await launcher.contactsApi("GET", "")
            : await apiFetch(`${basePath}/api/domain/contacts`, { signal: controller.signal, cache: "no-store" })
                .then(async response => ({ ok: response.ok, status: response.status, data: await response.json() as { friends?: Array<{ id: string; name: string; avatar?: string }>; error?: string } }));
          if (!result.ok) throw { status: result.status, title: result.data?.error || "读取好友失败" };
          const data = result.data ?? {};
          const friends = (data.friends ?? []).map(friend => ({
            id: friend.id, name: friend.name, avatar: friend.avatar || "", department: "", title: "", email: "", mobile: "", provider: "builtin" as const,
          }));
          return { contacts: search && query ? friends.filter(friend => friend.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) : friends };
        }
        const params = new URLSearchParams();
        if (!search && forceRefresh) params.set("refresh", "1");
        const response = await apiFetch(search ? `${basePath}/api/contacts/search` : `${basePath}/api/contacts${params.size ? `?${params}` : ""}`, {
          method: search ? "POST" : "GET",
          headers: search ? { "Content-Type": "application/json" } : undefined,
          body: search ? JSON.stringify({ query }) : undefined,
          signal: controller.signal, cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) throw { status: response.status, title: data.error || "读取失败", detail: data.detail || "", suggestion: data.suggestion || "" };
        if (data.syncing && !data.contacts?.length) {
          window.setTimeout(() => { if (!controller.signal.aborted) setTick(t => t + 1); }, 2000);
        }
        return data;
      } catch (err) {
        // 冷启动时飞书或数据库连接偶发超时；只对临时服务错误重试一次。
        if (retry && !controller.signal.aborted && ((err as { status?: number }).status === 502 || err instanceof TypeError)) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { controller.signal.removeEventListener("abort", onAbort); resolve(); }, 500);
            const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
            controller.signal.addEventListener("abort", onAbort, { once: true });
          });
          return load(false);
        }
        throw err;
      }
    };
    load()
      .then(data => {
        const list: CompanyContactUi[] = Array.isArray(data.contacts) ? data.contacts : [];
        if (!data.syncing) cache.set(cacheKey, { contacts: list, ts: Date.now() });
        setContacts(list);
      })
      .catch(err => {
        if (err?.name === "AbortError") return;
        setError({
          title: err?.title || "通讯录读取失败",
          detail: err?.detail || err?.message || "未知错误",
          suggestion: err?.suggestion || "请稍后重试。",
        });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [basePath, cacheKey, enabled, provider, query, search, tick]);
  return { contacts, loading, error, reload };
}
