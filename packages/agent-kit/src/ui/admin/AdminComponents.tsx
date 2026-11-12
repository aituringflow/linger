"use client";

/**
 * agent-kit · admin 部署组件状态页
 *
 * 展示这台机器上部署期组件（Node / npm / Docker / Playwright / 中文字体 /
 * 原生模块 / PostgreSQL / 凭据 / 配置项）的健康状态，并对可自动安装的组件
 * 提供「安装」按钮：后台执行安装命令，日志实时回显，完成后自动重新检测。
 *
 * 用法（内嵌在 AdminConsole 的「系统运维 → 组件状态」分区）：
 *   <AdminComponents basePath="/linger" />
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type ComponentStatus = "ok" | "missing" | "warn" | "disabled" | "n/a";
export type ComponentCategory =
  | "runtime" | "infra" | "browser" | "native" | "auth" | "config" | "build";

export interface ComponentReport {
  id: string;
  name: string;
  category: ComponentCategory;
  categoryLabel: string;
  status: ComponentStatus;
  statusLabel: string;
  detail: string;
  version?: string;
  required: string;
  installable: boolean;
  autoInstallable: boolean;
  installHint: string;
  guidance?: string;
  checkedAt: string;
}

interface ComponentsResponse {
  components: ComponentReport[];
  summary: Record<string, number>;
  platform: string;
  node: string;
  checkedAt: string;
}

interface JobState {
  jobId: string;
  componentId: string;
  componentName: string;
  state: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  exitCode: number | null;
  log: string;
}

export interface AdminComponentsProps {
  basePath?: string;
}

const CATEGORY_ORDER: ComponentCategory[] = ["runtime", "infra", "browser", "native", "build", "auth", "config"];

export function AdminComponents({ basePath = "/" }: AdminComponentsProps) {
  const root = basePath.replace(/\/+$/, "");
  const [data, setData] = useState<ComponentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // componentId -> 该组件最近一次安装任务（running 期间轮询刷新日志）
  const [jobs, setJobs] = useState<Record<string, JobState>>({});
  const [starting, setStarting] = useState<string | null>(null);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const pollTimers = useRef<Record<string, number>>({});

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch(`${root}/api/agent-kit-admin/admin/components`, { credentials: "include", cache: "no-store" });
      const body = (await r.json()) as ComponentsResponse & { error?: string };
      if (r.status === 401) throw new Error(body.error || "需要管理员登录");
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setData(body);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => { void load(); }, [load]);

  // 卸载时清理轮询定时器
  useEffect(() => () => {
    for (const id of Object.values(pollTimers.current)) window.clearTimeout(id);
  }, []);

  const pollJob = useCallback(async (componentId: string, jobId: string) => {
    const tick = async () => {
      try {
        const r = await fetch(`${root}/api/agent-kit-admin/admin/components/install/${encodeURIComponent(jobId)}`, { credentials: "include", cache: "no-store" });
        if (!r.ok) return;
        const job = (await r.json()) as JobState;
        setJobs((prev) => ({ ...prev, [componentId]: job }));
        if (job.state === "running") {
          pollTimers.current[componentId] = window.setTimeout(() => void tick(), 2000);
        } else {
          delete pollTimers.current[componentId];
          void load(); // 安装结束 → 重新检测状态
        }
      } catch {
        delete pollTimers.current[componentId];
      }
    };
    void tick();
  }, [root, load]);

  const startInstall = async (componentId: string) => {
    setStarting(componentId);
    setErr(null);
    try {
      const r = await fetch(`${root}/api/agent-kit-admin/admin/components/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: componentId }),
        credentials: "include",
      });
      const body = (await r.json()) as { jobId?: string; error?: string; guidance?: string };
      if (r.status === 401) throw new Error("需要管理员登录");
      if (!r.ok) {
        // 非安装型组件会返回 400 + guidance：直接展开该组件的指引
        if (body.guidance) {
          setJobs((prev) => ({ ...prev, [componentId]: { jobId: "", componentId, componentName: componentId, state: "failed", startedAt: Date.now(), exitCode: null, log: `[指引] ${body.guidance}` } }));
          setOpenLog(componentId);
        }
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      setOpenLog(componentId);
      void pollJob(componentId, body.jobId!);
    } catch (e) {
      if (!(e instanceof Error && e.message === "需要管理员登录")) setErr(e instanceof Error ? e.message : "启动安装失败");
    } finally {
      setStarting(null);
    }
  };

  const retryJob = (componentId: string) => {
    const job = jobs[componentId];
    if (job?.jobId) void pollJob(componentId, job.jobId);
  };

  const summary = data?.summary ?? {};
  const summaryEntries: { key: string; label: string; count: number }[] = [
    { key: "ok", label: "正常", count: summary.ok ?? 0 },
    { key: "missing", label: "缺失", count: summary.missing ?? 0 },
    { key: "warn", label: "需关注", count: summary.warn ?? 0 },
    { key: "disabled", label: "未启用", count: summary.disabled ?? 0 },
  ];
  const groups = CATEGORY_ORDER
    .map((cat) => ({ cat, items: (data?.components ?? []).filter((c) => c.category === cat) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="ak-comp">
      <div className="ak-comp-head">
        <div className="ak-comp-summary">
          {summaryEntries.map((s) => (
            <span key={s.key} className={`ak-comp-chip ak-comp-chip--${s.key}`}>{s.label} {s.count}</span>
          ))}
          {data ? (
            <span className="ak-comp-meta">平台 {data.platform} · Node {data.node} · 检测于 {new Date(data.checkedAt).toLocaleString("zh-CN", { hour12: false })}</span>
          ) : null}
        </div>
        <div className="ak-comp-actions">
          <button type="button" className="ak-btn ak-btn-ghost" onClick={() => void load()} disabled={loading}>
            {loading ? "检测中…" : "重新检测"}
          </button>
        </div>
      </div>
      {err ? <div className="ak-comp-err" role="alert">{err}</div> : null}
      {loading && !data ? <div className="ak-comp-loading">正在检测本机组件…（部分检查需要几秒）</div> : null}

      {groups.map(({ cat, items }) => (
        <section key={cat} className="ak-comp-group">
          <h3 className="ak-comp-group-title">{items[0].categoryLabel}</h3>
          <div className="ak-comp-table">
            {items.map((c) => {
              const job = jobs[c.id];
              const running = job?.state === "running";
              const failed = job?.state === "failed";
              const logOpen = openLog === c.id && !!job;
              return (
                <div className={`ak-comp-row${c.status === "missing" ? " is-missing" : ""}${running ? " is-running" : ""}`} key={c.id}>
                  <div className="ak-comp-cell ak-comp-cell--name">
                    <div className="ak-comp-name">{c.name}</div>
                    <div className="ak-comp-required">{c.required}</div>
                  </div>
                  <div className="ak-comp-cell ak-comp-cell--status">
                    <span className={`ak-comp-badge ak-comp-badge--${c.status}`}>{c.statusLabel}</span>
                    {c.version ? <span className="ak-comp-version">{c.version}</span> : null}
                  </div>
                  <div className="ak-comp-cell ak-comp-cell--detail">
                    <div className="ak-comp-detail">{c.detail}</div>
                    {logOpen ? (
                      <pre className="ak-comp-log" role="log">{job!.log || "（暂无输出）"}{running ? "\n…" : ""}</pre>
                    ) : null}
                    {failed && !logOpen ? <button type="button" className="ak-comp-link" onClick={() => setOpenLog(c.id)}>查看失败日志</button> : null}
                  </div>
                  <div className="ak-comp-cell ak-comp-cell--action">
                    {running ? (
                      <span className="ak-comp-running">安装中…</span>
                    ) : c.autoInstallable && (c.status === "missing" || c.status === "warn") ? (
                      <button type="button" className="ak-btn ak-btn-primary ak-btn-sm" onClick={() => void startInstall(c.id)} disabled={starting === c.id || running}>
                        {starting === c.id ? "启动中…" : "安装"}
                      </button>
                    ) : c.status === "missing" || c.status === "warn" ? (
                      <button type="button" className="ak-btn ak-btn-ghost ak-btn-sm" onClick={() => {
                        if (c.guidance) {
                          setJobs((prev) => ({ ...prev, [c.id]: { jobId: "", componentId: c.id, componentName: c.name, state: "failed", startedAt: Date.now(), exitCode: null, log: `[安装指引]\n${c.guidance}` } }));
                          setOpenLog(c.id);
                        } else {
                          setOpenLog(openLog === c.id ? null : c.id);
                        }
                      }}>
                        安装指引
                      </button>
                    ) : (
                      <span className="ak-comp-hint">{c.installHint}</span>
                    )}
                    {!running && job && job.state !== "running" ? (
                      <button type="button" className="ak-comp-link" onClick={() => { setOpenLog(openLog === c.id ? null : c.id); retryJob(c.id); }}>{logOpen ? "收起日志" : "查看日志"}</button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export default AdminComponents;
