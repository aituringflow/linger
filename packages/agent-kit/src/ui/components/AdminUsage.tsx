"use client";

/**
 * agent-kit · admin 用量分析页
 *
 * 面向管理员的 token 消耗去向分析：拉取 /api/agent-kit-admin/usage 聚合结果，
 * 展示总量卡片 + 按会话分组的消耗明细表（黑白灰系）：
 * 明细按会话合并单元格（第一列显示会话名 + 该会话合计），组内每条消息一行，
 * 每行带该轮的用户提问与助手回复预览，帮助定位"几百万 token 花在哪"。
 *
 * 用法（宿主挂载到 /agent-kit-admin 路由）：
 *   <AdminUsage basePath="/linger" />
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { imeCompositionEnd, imeCompositionStart, isImeConfirmKey } from "../shared/ime.ts";
import { SideChat } from "./SideChat.tsx";
import { ChatPanelGlyph08 } from "../icons/PageIcons.tsx";
import type { Scene } from "../chat/types.ts";

interface UsageData {
  detailsTotal: number;
  summary: { inputTokens: number; outputTokens: number; costUsd: number; costedMsgs: number; sessions: number };
  byModel: { model: string; inputTokens: number; outputTokens: number; msgs: number }[];
  bySession: {
    sessionId: string; title: string; createdAt: string; inputTokens: number; outputTokens: number; costUsd: number; costedMsgs: number;
  }[];
  details: {
    id: number; sessionId: string; sessionTitle: string; createdAt: string;
    inputTokens: number; outputTokens: number; costUsd: number; model: string; contentPreview: string;
    userContent: string; user: string;
  }[];
}
interface FeedbackRow { id: number; userId: string; userName: string; sessionId: string; sessionTitle: string; messageId: number | null; answerPreview: string; vote: "up" | "down"; categories: string[]; detail: string; createdAt: string }

export interface AdminUsageProps {
  basePath?: string;
  /** @deprecated 运营看板不再显示返回按钮，保留此属性以兼容现有调用。 */
  onBack?: () => void;
  /**
   * 内嵌模式：在管理控制台（AdminConsole）内作为某个分区的正文渲染，
   * 不再自带顶栏（标题 / 登录 / 登出 / 分页 tab），由控制台统一提供；
   * 仅保留内容区 + 右侧运营助手，并由一个浮层按钮控制助手显隐。
   */
  embedded?: boolean;
  /** 内嵌时固定展示的面板（"usage"=用量看板 / "feedback"=用户反馈）；不传则沿用内部 tab 切换。 */
  pane?: "usage" | "feedback";
}

const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : `${n}`);

const ADMIN_SCENES: Scene[] = [
  { key: "usage", label: "用量分析", suggestions: [
    { label: "使用量最多的 Top 3 用户是谁？分别消耗了多少输入和输出 token？" },
    { label: "输入 token 消耗最多的 3 个模型是什么？各占总量多少？" },
    { label: "成本最高的 3 个会话是什么？分别花了多少？" },
  ] },
  { key: "feedback", label: "用户反馈", suggestions: [
    { label: "用户吐槽最多的 3 个问题是什么？分别出现多少次？" },
    { label: "作为运营负责人，我应该先处理哪 3 类用户问题？请说明依据和建议动作。" },
    { label: "最近的负面反馈主要集中在哪些问题？请举出典型描述。" },
  ] },
];

function AdminPager({ page, total, onChange }: { page: number; total: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return <nav className="au-pager" aria-label="表格分页">
    <span>共 {total} 条 · 第 {page} / {pages} 页</span>
    <button type="button" disabled={page <= 1} onClick={() => onChange(page - 1)}>上一页</button>
    <button type="button" disabled={page >= pages} onClick={() => onChange(page + 1)}>下一页</button>
  </nav>;
}

export function AdminUsage({ basePath = "/", embedded = false, pane }: AdminUsageProps) {
  const root = basePath.replace(/\/+$/, "");
  const [data, setData] = useState<UsageData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // phase: loading=拉数据中 / login=需要 admin 登录 / ready=已登录有数据
  const [phase, setPhase] = useState<"loading" | "login" | "ready">(embedded ? "ready" : "loading");
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<"usage" | "feedback">("usage");
  const activeTab: "usage" | "feedback" = pane ?? tab;
  const [feedback, setFeedback] = useState<FeedbackRow[]>([]);
  const [feedbackError, setFeedbackError] = useState("");
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [usagePage, setUsagePage] = useState(1);
  const [usageModel, setUsageModel] = useState("");
  const [usageSort, setUsageSort] = useState<"input" | "output" | "cost" | "recent">("input");
  const [feedbackPage, setFeedbackPage] = useState(1);
  const [feedbackTotal, setFeedbackTotal] = useState(0);
  const [feedbackVoteCounts, setFeedbackVoteCounts] = useState({ up: 0, down: 0 });
  const [sideChatOpen, setSideChatOpen] = useState(true);
  const usageRequestId = useRef(0);
  const [expandedFeedbackId, setExpandedFeedbackId] = useState<number | null>(null);

  const loadFeedback = useCallback(async () => {
    setFeedbackLoading(true); setFeedbackError("");
    try {
      const response = await fetch(`${root}/api/agent-kit-admin/feedback?page=${feedbackPage}`, { credentials: "include", cache: "no-store" });
      const body = await response.json() as { feedback?: FeedbackRow[]; total?: number; voteCounts?: { up: number; down: number }; error?: string };
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setFeedback(body.feedback || []);
      setFeedbackTotal(body.total || 0);
      setFeedbackVoteCounts(body.voteCounts || { up: 0, down: 0 });
    } catch (e) { setFeedbackError(e instanceof Error ? e.message : "加载失败"); }
    finally { setFeedbackLoading(false); }
  }, [root, feedbackPage]);
  useEffect(() => { if (phase === "ready" && activeTab === "feedback") void loadFeedback(); }, [phase, activeTab, loadFeedback]);

  const load = useCallback(() => {
    const requestId = ++usageRequestId.current;
    setErr(null);
    setPhase((current) => current === "ready" ? current : "loading");
    const query = new URLSearchParams({ page: String(usagePage), sort: usageSort });
    if (usageModel) query.set("model", usageModel);
    fetch(`${root}/api/agent-kit-admin/usage?${query}`, { credentials: "include", cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) {
          // 未登录 / 登录过期：进入登录表单（内嵌模式由控制台统一登录，这里仅提示错误）
          if (requestId === usageRequestId.current) {
            if (embedded) { setErr("未登录或登录已过期，请重新进入控制台"); setPhase("ready"); }
            else setPhase("login");
          }
          return null;
        }
        if (!r.ok) {
          // 服务端错误时优先展示 JSON error 字段（如数据库未迁移/未配置），否则退回 HTTP 状态码
          let msg = `HTTP ${r.status}`;
          try {
            const j = (await r.json()) as { error?: string };
            if (j?.error) msg = j.error;
          } catch {
            /* 非 JSON 响应保持原样 */
          }
          throw new Error(msg);
        }
        return (await r.json()) as UsageData;
      })
      .then((j) => {
        if (j && requestId === usageRequestId.current) {
          setData(j);
          setPhase("ready");
        }
      })
      .catch((e: unknown) => {
        if (requestId !== usageRequestId.current) return;
        setErr(e instanceof Error ? e.message : "加载失败");
        setPhase("ready");
      });
  }, [root, usagePage, usageModel, usageSort]);

  useEffect(() => {
    load();
  }, [load]);

  /** 提交 admin 登录（admin/admin），成功后重新拉取数据。 */
  const submitLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginErr(null);
    const r = await fetch(`${root}/api/agent-kit-admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim(), password }),
      credentials: "include",
    }).catch(() => null);
    if (!r || !r.ok) {
      setLoginErr("用户名或密码错误");
      return;
    }
    setUsername("");
    setPassword("");
    load();
  };

  /** 退出 admin 登录，回到登录表单。 */
  const logout = async () => {
    await fetch(`${root}/api/agent-kit-admin/logout`, { method: "POST", credentials: "include" }).catch(() => null);
    setData(null);
    setPhase("login");
  };

  // 是否已有任何带消耗记录的数据：没有时展示「暂无用量数据」空态，而不是报错
  const hasCostData =
    data !== null &&
    (data.summary.costedMsgs > 0 ||
      data.byModel.length > 0 ||
      data.bySession.length > 0 ||
      data.details.length > 0);

  return (
    <div className={`au-page${embedded ? " au-embedded" : ""}`}>
      {embedded ? (
        <button type="button" className="au-chat-fab" onClick={() => setSideChatOpen((open) => !open)} aria-label={sideChatOpen ? "隐藏运营助手" : "显示运营助手"} aria-expanded={sideChatOpen} title={sideChatOpen ? "隐藏运营助手" : "显示运营助手"}><ChatPanelGlyph08 /></button>
      ) : (
        <header className="au-topbar">
          <h1 className="au-title">运营看板</h1>
          {phase === "ready" ? <nav className="au-tabs" role="tablist" aria-label="运营看板导航">
            <button type="button" role="tab" aria-selected={tab === "usage"} className={tab === "usage" ? "active" : ""} onClick={() => setTab("usage")}>用量分析</button>
            <button type="button" role="tab" aria-selected={tab === "feedback"} className={tab === "feedback" ? "active" : ""} onClick={() => setTab("feedback")}>用户反馈</button>
          </nav> : null}
          {phase === "ready" ? <button type="button" className="chat-sidebar-toggle au-chat-toggle" onClick={() => setSideChatOpen((open) => !open)} aria-label={sideChatOpen ? "隐藏运营助手" : "显示运营助手"} aria-expanded={sideChatOpen} title={sideChatOpen ? "隐藏运营助手" : "显示运营助手"}><ChatPanelGlyph08 /></button> : null}
          {phase === "ready" ? (
            <button type="button" className="au-back au-logout" onClick={logout} aria-label="退出登录">
              <span>退出登录</span>
            </button>
          ) : null}
        </header>
      )}
      <div className={`au-workspace${sideChatOpen ? "" : " is-chat-hidden"}`}><main className="au-content"><div className="au-scroll">
      {phase === "ready" && activeTab === "feedback" ? <section className="au-feedback" role="tabpanel">
        <div className="au-feedback-stats" aria-label="全部用户反馈统计">
          <div><span>全部反馈</span><strong>{feedbackTotal}</strong></div>
          <div><span>点赞</span><strong>{feedbackVoteCounts.up}</strong></div>
          <div><span>点踩</span><strong>{feedbackVoteCounts.down}</strong></div>
        </div>
        {feedbackError ? <div role="alert">{feedbackError}</div> : feedbackLoading ? <div>正在加载反馈…</div> : feedback.length === 0 ? <div>暂无用户反馈</div> :
          <div className="admin-table-wrap"><table className="admin-table au-feedback-table"><thead><tr><th>时间</th><th>用户</th><th>评价</th><th>分类</th><th>详情</th><th>回复</th><th>会话</th></tr></thead><tbody>
            {feedback.map((row) => <tr key={row.id} className={expandedFeedbackId === row.id ? "is-expanded" : ""} onClick={() => setExpandedFeedbackId((id) => id === row.id ? null : row.id)}><td className="admin-time">{new Date(row.createdAt).toLocaleString("zh-CN")}</td><td>{row.userName}<small className="au-feedback-meta">{row.userId}</small></td><td>{row.vote === "up" ? "👍 点赞" : "👎 点踩"}</td><td>{row.categories.join("、") || "—"}</td><td><button type="button" className="au-feedback-cell" aria-expanded={expandedFeedbackId === row.id} onClick={(event) => { event.stopPropagation(); setExpandedFeedbackId((id) => id === row.id ? null : row.id); }}><span className="au-feedback-text">{row.detail || "—"}</span></button></td><td><button type="button" className="au-feedback-cell" aria-expanded={expandedFeedbackId === row.id} onClick={(event) => { event.stopPropagation(); setExpandedFeedbackId((id) => id === row.id ? null : row.id); }}><span className="au-feedback-text">{row.answerPreview || "—"}</span></button></td><td>{row.sessionTitle || row.sessionId}<small className="au-feedback-meta">{row.sessionId}{row.messageId ? ` · #${row.messageId}` : ""}</small></td></tr>)}
          </tbody></table></div>}
      </section> : null}

      {phase === "ready" && activeTab === "feedback" ? null : phase === "login" ? (
        <div className="au-login-wrap">
          <form className="au-login-card" onSubmit={submitLogin}>
            <div className="au-login-title">管理员登录</div>
            <div className="au-login-sub">用量分析页仅限管理员访问</div>
            <label className="au-login-field">
              <span>用户名</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                onCompositionStart={imeCompositionStart}
                onCompositionEnd={imeCompositionEnd}
                onKeyDown={(e) => { if (e.key === "Enter" && isImeConfirmKey(e)) e.preventDefault(); }}
                autoComplete="username"
                spellCheck={false}
              />
            </label>
            <label className="au-login-field">
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onCompositionStart={imeCompositionStart}
                onCompositionEnd={imeCompositionEnd}
                onKeyDown={(e) => { if (e.key === "Enter" && isImeConfirmKey(e)) e.preventDefault(); }}
                autoComplete="current-password"
              />
            </label>
            {loginErr ? <div className="au-login-err" role="alert">{loginErr}</div> : null}
            <button type="submit" className="au-login-submit" disabled={!username.trim() || !password}>
              登录
            </button>
          </form>
        </div>
      ) : err ? (
        <div className="au-error" role="alert">
          加载用量数据失败（{err}）。请确认服务端已配置数据库，且已完成数据库迁移（agent_messages.cost_info 列存在）。
          <button type="button" className="au-back" onClick={load} style={{ marginTop: 10 }}>
            重试
          </button>
        </div>
      ) : !data ? (
        <div className="au-loading" role="status">
          <span className="chat-booting-spinner" aria-hidden="true" />
          <span>正在统计用量…</span>
        </div>
      ) : !hasCostData ? (
        <div className="au-empty-page" role="status">
          <div className="au-empty-page-title">暂无用量数据</div>
          <div className="au-empty-page-sub">
            还没有带消耗记录（cost_info）的消息。完成一轮对话后，这里会展示 Token 消耗去向。
          </div>
        </div>
      ) : (
        <>
          {/* 总量卡片 */}
          <div className="au-cards">
            <div className="au-card">
              <div className="au-card-num">{fmt(data.summary.inputTokens)}</div>
              <div className="au-card-cap">累计输入 tokens</div>
            </div>
            <div className="au-card">
              <div className="au-card-num">{fmt(data.summary.outputTokens)}</div>
              <div className="au-card-cap">累计输出 tokens</div>
            </div>
            <div className="au-card">
              <div className="au-card-num">
                {data.summary.costUsd > 0 ? `$${data.summary.costUsd.toFixed(4)}` : "—"}
              </div>
              <div className="au-card-cap">累计成本</div>
            </div>
            <div className="au-card">
              <div className="au-card-num">{data.summary.costedMsgs}</div>
              <div className="au-card-cap">有消耗记录的消息</div>
            </div>
            <div className="au-card">
              <div className="au-card-num">{data.summary.sessions}</div>
              <div className="au-card-cap">会话数</div>
            </div>
          </div>

          {/* 消息明细由服务端按筛选与排序条件分页。 */}
          <section className="au-sec">
            <div className="au-usage-toolbar">
              <h2 className="au-sec-title">消息消耗明细</h2>
              <label>模型<select value={usageModel} onChange={(event) => { setUsageModel(event.target.value); setUsagePage(1); }}>
                <option value="">全部模型</option>
                {data.byModel.map((item) => <option key={item.model} value={item.model}>{item.model}</option>)}
              </select></label>
              <label>排序<select value={usageSort} onChange={(event) => { setUsageSort(event.target.value as typeof usageSort); setUsagePage(1); }}>
                <option value="input">输入最多</option><option value="output">输出最多</option>
                <option value="cost">成本最高</option><option value="recent">最近时间</option>
              </select></label>
            </div>
            <div className="au-table-wrap">
              <table className="au-table">
                <thead>
                  <tr>
                    <th className="au-col-session">会话</th>
                    <th>时间</th>
                    <th>用户</th>
                    <th>用户提问</th>
                    <th>模型</th>
                    <th className="au-num">输入</th>
                    <th className="au-num">输出</th>
                    <th className="au-num">成本</th>
                    <th>助手回复预览</th>
                  </tr>
                </thead>
                <tbody>
                  {data.details.map((d) => (
                        <tr key={d.id}>
                          <td className="au-preview" title={d.sessionId}>{d.sessionTitle || d.sessionId}</td>
                          <td className="au-mono">{new Date(d.createdAt).toLocaleString("zh-CN", { hour12: false })}</td>
                          <td className="au-preview" title={d.user || undefined}>{d.user || "—"}</td>
                          <td className="au-preview" title={d.userContent || undefined}>
                            {d.userContent || "—"}
                          </td>
                          <td className="au-mono">{d.model}</td>
                          <td className="au-num au-strong">{fmt(d.inputTokens)}</td>
                          <td className="au-num">{fmt(d.outputTokens)}</td>
                          <td className="au-num">{d.costUsd > 0 ? `$${d.costUsd.toFixed(4)}` : "—"}</td>
                          <td className="au-preview" title={d.contentPreview || undefined}>
                            {d.contentPreview || "—"}
                          </td>
                        </tr>
                  ))}
                  {data.details.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="au-empty">当前筛选条件下暂无数据</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      </div>{phase === "ready" ? activeTab === "feedback"
        ? <AdminPager page={feedbackPage} total={feedbackTotal} onChange={setFeedbackPage} />
        : <AdminPager page={usagePage} total={data?.detailsTotal ?? 0} onChange={setUsagePage} /> : null}
      </main>{phase === "ready" ? <aside className="au-chat-pane" aria-label="运营数据问答"><SideChat basePath={root} chatEndpoint={`${root}/api/agent-kit-admin/ask`} authUser={{ name: "管理员", unionId: "admin", provider: "builtin" }} heading="运营数据助手" placeholder="向运营数据提问…" emptyMessage="选择场景，试试下面的问题。" scenes={ADMIN_SCENES} /></aside> : null}</div>
    </div>
  );
}

export default AdminUsage;
