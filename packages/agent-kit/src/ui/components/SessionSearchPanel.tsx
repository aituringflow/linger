"use client";

/**
 * 会话列表的全局搜索弹窗：跨会话检索「联系人 / 群聊」与「会话内历史消息」。
 *
 * 分组结构（与飞书全局搜索一致，联系人、群组合并为「会话」一组，消息在下方）：
 *  ① 会话：联系人（企业通讯录命中，可点击直达已有 1v1 或新建会话）+ 群聊（标题命中，
 *     附人数与「包含: 成员」副行，点击直达群聊并定位到命中消息）；
 *  ② 消息：会话正文命中（含命中上下文，点击定位到该条消息）。
 *
 * 为什么单独成对话框而不是在侧边栏就地过滤：
 * 侧边栏宽度只够显示会话标题，消息片段（含命中上下文）横向被裁；
 * 且搜索要同时呈现「会话」与「消息」两组结果，居中弹窗才有足够的纵向空间。
 *
 * 数据来源优先级：
 *  ① 服务端 GET /api/sessions/search?q=（联系人 ILIKE + 群标题 ILIKE + 消息正文 ILIKE，
 *     归属边界与会话列表一致）；
 *  ② 数据库不可用（503）时降级为本地 sessions 列表的标题子串过滤 —— 此时无法检索
 *     消息正文与联系人，界面显式说明原因，不让用户误以为「搜不到」是 bug。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CloseIcon, SearchIcon } from "../icons/SharedIcons.tsx";
import { apiFetch } from "../shared/apiFetch.ts";
import { Avatar } from "../shared/AvatarView.tsx";
import type { SessionItem } from "../chat/types.ts";

export interface SessionSearchPersonRow {
  id: string;
  name: string;
  department: string;
  title: string;
  avatar: string;
  email: string;
  provider: string;
  /** 服务端标记：该联系人即当前登录用户自己（选人列表标注「（你自己）」） */
  isSelf?: boolean;
  /** 该联系人已有的 1v1 会话 id；没有则为 null（前端走新建会话流程） */
  sessionId: string | null;
}

export interface SessionSearchGroupRow {
  id: string;
  title: string;
  memberCount: number;
  coworkEverGroup: boolean;
  messageCount: number;
  updatedAt: string | null;
  lastPreview: string | null;
  /** 群内首条正文命中的消息 id；只有标题命中时为 null */
  hitMessageId: number | null;
  /** 群成员中第一个姓名命中的成员名（「包含: xxx」副行），成员未命中时为 null */
  matchedMemberName: string | null;
}

export interface SessionSearchMessageRow {
  id: number;
  sessionId: string;
  sessionTitle: string;
  memberCount: number;
  role: "user" | "assistant";
  createdAt: string | null;
  snippet: string;
}

interface SessionSearchPanelProps {
  basePath: string;
  /** 数据库不可用时的本地兜底数据源（仅群标题可见；联系人/消息无法本地检索） */
  sessions: SessionItem[];
  /** 点击「联系人」结果：传入联系人行（含已有 1v1 会话 id，可能为 null） */
  onOpenPerson: (person: SessionSearchPersonRow) => void;
  /** 点击「群聊」结果：传入群会话 id 与其首条正文命中的消息 id（可能为 null） */
  onOpenGroup: (sessionId: string, hitMessageId: number | null) => void;
  /** 点击「消息」结果：传入所属会话 id 与消息 id */
  onOpenMessage: (sessionId: string, messageId: number) => void;
  onClose: () => void;
}

type SearchItem =
  | { kind: "person"; row: SessionSearchPersonRow }
  | { kind: "group"; row: SessionSearchGroupRow }
  | { kind: "message"; row: SessionSearchMessageRow };

const HISTORY_LIMIT = 10;
function historyKey(basePath: string): string { return `agent-kit:session-search-history:${basePath}`; }
function readHistory(basePath: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(historyKey(basePath)) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, HISTORY_LIMIT) : [];
  } catch { return []; }
}

/** 把文本里所有命中片段包成 <mark>；无关键词时原样返回字符串，避免多余节点。 */
function highlight(text: string, keyword: string): ReactNode {
  const value = text || "";
  if (!keyword) return value;
  const lower = value.toLowerCase();
  const needle = keyword.toLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (;;) {
    const at = lower.indexOf(needle, cursor);
    if (at === -1) {
      parts.push(value.slice(cursor));
      break;
    }
    if (at > cursor) parts.push(value.slice(cursor, at));
    parts.push(<mark className="session-search-mark" key={at}>{value.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length;
  }
  return parts;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 结果行右侧时间：今天 → 时:分；今年 → M月D日；更早 → YYYY-MM-DD。 */
function shortTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function SessionSearchPanel({ basePath, sessions, onOpenPerson, onOpenGroup, onOpenMessage, onClose }: SessionSearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<string[]>(() => readHistory(basePath));
  const [debounced, setDebounced] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dbDisabled, setDbDisabled] = useState(false);
  const [result, setResult] = useState<{ people: SessionSearchPersonRow[]; groups: SessionSearchGroupRow[]; messages: SessionSearchMessageRow[] } | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function updateHistory(next: string[]) {
    setHistory(next);
    try { window.localStorage.setItem(historyKey(basePath), JSON.stringify(next)); } catch { /* storage unavailable */ }
  }
  function remember(keyword: string) {
    const value = keyword.trim();
    if (!value) return;
    updateHistory([value, ...history.filter(item => item.toLocaleLowerCase() !== value.toLocaleLowerCase())].slice(0, HISTORY_LIMIT));
  }

  // 输入防抖：250ms 足够挡掉连打中文时的逐字请求，又不至于让结果显得卡顿。
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const keyword = debounced;
    if (!keyword) {
      setResult(null);
      setLoading(false);
      setError("");
      return;
    }
    const id = ++requestRef.current;
    setLoading(true);
    setError("");
    apiFetch(`${basePath}/api/sessions/search?q=${encodeURIComponent(keyword)}`, { cache: "no-store" })
      .then(async (response) => {
        if (id !== requestRef.current) return;
        // 数据库未配置：降级为本地标题过滤，不打扰用户报错
        if (response.status === 503) { setDbDisabled(true); setResult(null); return; }
        setDbDisabled(false);
        const data = await response.json().catch(() => ({})) as {
          people?: SessionSearchPersonRow[]; groups?: SessionSearchGroupRow[]; messages?: SessionSearchMessageRow[]; error?: string;
        };
        if (!response.ok) {
          setError(data?.error === "missing_query" ? "请输入关键词" : "搜索失败，请稍后重试");
          setResult(null);
          return;
        }
        setResult({
          people: Array.isArray(data.people) ? data.people : [],
          groups: Array.isArray(data.groups) ? data.groups : [],
          messages: Array.isArray(data.messages) ? data.messages : [],
        });
      })
      .catch(() => {
        if (id !== requestRef.current) return;
        setError("搜索失败，请检查网络后重试");
        setResult(null);
      })
      .finally(() => { if (id === requestRef.current) setLoading(false); });
  }, [basePath, debounced]);

  /** 数据库不可用时按标题过滤本地会话列表，仅产出「群聊」行（联系人/消息无法本地检索）。 */
  const localGroups = useMemo(() => {
    if (!dbDisabled || !debounced) return [] as SessionSearchGroupRow[];
    const needle = debounced.toLowerCase();
    return sessions
      .filter((session) => {
        const isGroup = (session.coworkEverGroup ?? false) || (session.memberCount ?? 0) >= 2;
        if (!isGroup) return false;
        const text = `${session.title || ""} ${session.peerName || ""}`.toLowerCase();
        return text.includes(needle);
      })
      .map((session) => ({
        id: session.id,
        title: session.title,
        memberCount: session.memberCount ?? 0,
        coworkEverGroup: session.coworkEverGroup ?? false,
        messageCount: 0,
        updatedAt: session.updatedAt ?? null,
        lastPreview: session.lastPreview ?? null,
        hitMessageId: null,
        matchedMemberName: null,
      }));
  }, [dbDisabled, debounced, sessions]);

  const personRows = useMemo<SessionSearchPersonRow[]>(() => (dbDisabled ? [] : result?.people ?? []), [dbDisabled, result]);
  const groupRows = useMemo<SessionSearchGroupRow[]>(() => (dbDisabled ? localGroups : result?.groups ?? []), [dbDisabled, localGroups, result]);
  const messageRows = useMemo<SessionSearchMessageRow[]>(() => (dbDisabled ? [] : result?.messages ?? []), [dbDisabled, result]);

  const items = useMemo<SearchItem[]>(() => [
    ...personRows.map((row): SearchItem => ({ kind: "person", row })),
    ...groupRows.map((row): SearchItem => ({ kind: "group", row })),
    ...messageRows.map((row): SearchItem => ({ kind: "message", row })),
  ], [personRows, groupRows, messageRows]);

  // 结果集变化后收拢选中项并回到列表顶部，避免停留在已被替换的行上。
  useEffect(() => { setActiveIdx(0); }, [items.length]);

  // 键盘导航时把选中行滚进视野（列表可能很长）。
  useEffect(() => {
    rowRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, items.length]);

  function open(item: SearchItem) {
    remember(query);
    if (item.kind === "person") onOpenPerson(item.row);
    else if (item.kind === "group") onOpenGroup(item.row.id, item.row.hitMessageId);
    else onOpenMessage(item.row.sessionId, item.row.id);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
      if (event.key === "Enter" && !items.length && query.trim()) { event.preventDefault(); remember(query); return; }
      if (!items.length) return;
      event.preventDefault();
      if (event.key === "Enter") { open(items[activeIdx]); return; }
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIdx((current) => (current + delta + items.length) % items.length);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const hasQuery = debounced.length > 0;
  const empty = hasQuery && !loading && !error && items.length === 0;
  const personCount = personRows.length;
  const groupCount = groupRows.length;
  const groupStart = personCount;
  const messageStart = personCount + groupCount;

  return (
    <div className="session-search-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="session-search-dialog" role="dialog" aria-modal="true" aria-label="搜索联系人、群聊与历史消息">
        <div className="session-search-field">
          <SearchIcon className="session-search-field-icon" />
          <input
            ref={inputRef}
            className="session-search-input"
            type="search"
            value={query}
            placeholder="搜索联系人、群聊或历史消息"
            aria-label="搜索关键词"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" className="session-search-clear" aria-label="清空关键词" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
              <CloseIcon />
            </button>
          ) : null}
          <button type="button" className="session-search-close" aria-label="关闭搜索" onClick={onClose}>Esc</button>
        </div>
        <div className="session-search-body">
          {!hasQuery ? (
            history.length ? <section className="session-search-section">
              <div className="session-search-history-head"><h3 className="session-search-section-title">搜索历史</h3><button type="button" onClick={() => updateHistory([])}>清空历史</button></div>
              {history.map((term) => <div className="session-search-history-row" key={term}>
                <button type="button" className="session-search-history-term" onClick={() => { remember(term); setQuery(term); inputRef.current?.focus(); }}>{term}</button>
                <button type="button" className="session-search-history-remove" aria-label={`删除搜索历史：${term}`} onClick={() => updateHistory(history.filter(item => item !== term))}>×</button>
              </div>)}
            </section> : <p className="session-search-hint">输入关键词，检索全部联系人、群聊与历史消息内容。</p>
          ) : loading ? (
            <p className="session-search-hint">正在搜索…</p>
          ) : error ? (
            <p className="session-search-hint is-error">{error}</p>
          ) : empty ? (
            <p className="session-search-hint">没有匹配「{debounced}」的联系人、群聊或消息。</p>
          ) : (
            <>
              {personCount || groupCount ? (
                <section className="session-search-section">
                  <h3 className="session-search-section-title">会话<span className="session-search-count">{personCount + groupCount}</span></h3>
                  {personRows.map((row, index) => (
                    <button
                      type="button"
                      key={`person-${row.id}`}
                      ref={(node) => { rowRefs.current[index] = node; }}
                      className={`session-search-row session-search-row-person${activeIdx === index ? " is-active" : ""}`}
                      onMouseEnter={() => setActiveIdx(index)}
                      onClick={() => onOpenPerson(row)}
                    >
                      <span className="session-search-person-avatar"><Avatar name={row.name} src={row.avatar || undefined} size={34} /></span>
                      <span className="session-search-person-meta">
                        <span className="session-search-row-head">
                          <span className="session-search-row-title">{highlight(row.name, debounced)}{row.isSelf ? <span className="session-search-row-role">（你自己）</span> : null}</span>
                        </span>
                        <span className="session-search-row-sub">{[row.department, row.title].filter(Boolean).join(" · ") || row.email}</span>
                      </span>
                    </button>
                  ))}
                  {groupRows.map((row, index) => {
                    const realIdx = groupStart + index;
                    return (
                      <button
                        type="button"
                        key={`group-${row.id}`}
                        ref={(node) => { rowRefs.current[realIdx] = node; }}
                        className={`session-search-row${activeIdx === realIdx ? " is-active" : ""}`}
                        onMouseEnter={() => setActiveIdx(realIdx)}
                        onClick={() => onOpenGroup(row.id, row.hitMessageId)}
                      >
                        <span className="session-search-row-head">
                          <span className="session-search-row-session">
                            <span className="session-search-group-avatar"><Avatar name={row.title} src={undefined} size={18} isGroup /></span>
                            {highlight(row.title, debounced)}
                            <span className="session-search-group-count">{row.memberCount}</span>
                          </span>
                          <span className="session-search-row-time">{shortTime(row.updatedAt)}</span>
                        </span>
                        {row.matchedMemberName ? <span className="session-search-row-sub">包含: {highlight(row.matchedMemberName, debounced)}</span> : row.lastPreview ? <span className="session-search-row-sub">{row.lastPreview}</span> : null}
                        {row.hitMessageId != null ? <span className="session-search-row-tag">含匹配的聊天记录</span> : null}
                      </button>
                    );
                  })}
                </section>
              ) : null}
              {messageRows.length ? (
                <section className="session-search-section">
                  <h3 className="session-search-section-title">消息<span className="session-search-count">{messageRows.length}</span></h3>
                  {messageRows.map((row, index) => {
                    const realIdx = messageStart + index;
                    return (
                      <button
                        type="button"
                        key={`message-${row.id}`}
                        ref={(node) => { rowRefs.current[realIdx] = node; }}
                        className={`session-search-row${activeIdx === realIdx ? " is-active" : ""}`}
                        onMouseEnter={() => setActiveIdx(realIdx)}
                        onClick={() => onOpenMessage(row.sessionId, row.id)}
                      >
                        <span className="session-search-row-head">
                          <span className="session-search-row-session">
                            {highlight(row.sessionTitle, debounced)}
                            <span className="session-search-row-role">{row.role === "assistant" ? "Agent" : "我"}</span>
                          </span>
                          <span className="session-search-row-time">{shortTime(row.createdAt)}</span>
                        </span>
                        <span className="session-search-row-sub">{highlight(row.snippet, debounced)}</span>
                      </button>
                    );
                  })}
                </section>
              ) : null}
            </>
          )}
          {/* 降级说明常驻：即便本次没命中也要说清「只能搜群标题」，避免用户以为是搜索坏了 */}
          {hasQuery && !loading && !error && dbDisabled ? (
            <p className="session-search-hint">当前未启用数据库，仅能按名称搜索本机可见的群聊。</p>
          ) : null}
        </div>
        <footer className="session-search-foot">
          <span>↑ ↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span>
        </footer>
      </div>
    </div>
  );
}
