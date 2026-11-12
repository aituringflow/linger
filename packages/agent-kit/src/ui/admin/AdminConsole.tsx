"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AdminSettings } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";
import { AdminUsage } from "../components/AdminUsage.tsx";
import { AdminPrompts } from "./AdminPrompts.tsx";
import { AdminSkills } from "./AdminSkills.tsx";
import { AdminConnectors } from "./AdminConnectors.tsx";
import { AdminResourcePool } from "./AdminResourcePool.tsx";
import { AdminAllocation } from "./AdminAllocation.tsx";
import { AdminComponents } from "./AdminComponents.tsx";

interface MenuGroup {
  key: string;
  label: string;
  children?: { key: string; label: string }[];
}
const MENU: MenuGroup[] = [
  {
    key: "basic",
    label: "基本设置",
    children: [
      { key: "prompts", label: "提示词" },
      { key: "skills", label: "技能" },
      { key: "connectors", label: "连接器" },
    ],
  },
  {
    key: "compute",
    label: "算力统筹",
    children: [
      { key: "usage", label: "用量看板" },
      { key: "resourcePool", label: "资源池" },
      { key: "allocation", label: "算力调配" },
    ],
  },
  {
    key: "ops",
    label: "系统运维",
    children: [
      { key: "components", label: "组件状态" },
    ],
  },
  { key: "feedback", label: "用户反馈" },
];

const LABELS: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const g of MENU) {
    map[g.key] = g.label;
    for (const c of g.children ?? []) map[c.key] = c.label;
  }
  return map;
})();

export interface AdminConsoleProps {
  basePath?: string;
}

/** 管理控制台外壳：左侧树状菜单（可折叠）+ 分区内容；管理员登录后编辑并落库。 */
export function AdminConsole({ basePath = "/" }: AdminConsoleProps) {
  const root = basePath.replace(/\/+$/, "");
  const [phase, setPhase] = useState<"loading" | "login" | "ready">("loading");
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [settings, setSettings] = useState<AdminSettings>(DEFAULT_SETTINGS);
  const [savedSnapshot, setSavedSnapshot] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ basic: true, compute: true });
  const [active, setActive] = useState<string>("prompts");
  const toastTimer = useRef<number | null>(null);
  const isMobile = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767.98px)").matches;

  const dirty = JSON.stringify(settings) !== savedSnapshot;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch(`${root}/api/agent-kit-admin/admin/settings`, { credentials: "include", cache: "no-store" });
      if (r.status === 401) { setPhase("login"); return; }
      if (!r.ok) { setPhase("login"); return; }
      const body = (await r.json()) as { settings?: AdminSettings };
      const s = body.settings ?? DEFAULT_SETTINGS;
      setSettings(s);
      setSavedSnapshot(JSON.stringify(s));
      setPhase("ready");
    } catch {
      setPhase("login");
    }
  }, [root]);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const submitLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginErr(null);
    const r = await fetch(`${root}/api/agent-kit-admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.trim(), password }),
      credentials: "include",
    }).catch(() => null);
    if (!r || !r.ok) { setLoginErr("用户名或密码错误"); return; }
    setUsername(""); setPassword("");
    await loadSettings();
  };

  const logout = async () => {
    await fetch(`${root}/api/agent-kit-admin/logout`, { method: "POST", credentials: "include" }).catch(() => null);
    setSettings(DEFAULT_SETTINGS);
    setSavedSnapshot("");
    setPhase("login");
  };

  const save = async () => {
    setSaving(true); setSaveError(null);
    try {
      const r = await fetch(`${root}/api/agent-kit-admin/admin/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
        credentials: "include",
      });
      if (!r.ok) throw new Error("保存失败");
      setSavedSnapshot(JSON.stringify(settings));
      flash("已保存");
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const updateBasic = <K extends keyof AdminSettings["basic"]>(k: K, v: AdminSettings["basic"][K]) =>
    setSettings((prev) => ({ ...prev, basic: { ...prev.basic, [k]: v } }));
  const updateCompute = <K extends keyof AdminSettings["compute"]>(k: K, v: AdminSettings["compute"][K]) =>
    setSettings((prev) => ({ ...prev, compute: { ...prev.compute, [k]: v } }));

  const selectLeaf = (key: string) => {
    setActive(key);
    if (isMobile()) setSidebarOpen(false);
  };
  const toggleGroup = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const renderContent = () => {
    switch (active) {
      case "prompts": return <AdminPrompts value={settings.basic.prompts} onChange={(v) => updateBasic("prompts", v)} />;
      case "skills": return <AdminSkills value={settings.basic.skills} onChange={(v) => updateBasic("skills", v)} />;
      case "connectors": return <AdminConnectors value={settings.basic.connectors} onChange={(v) => updateBasic("connectors", v)} />;
      case "usage": return <AdminUsage embedded pane="usage" basePath={root} />;
      case "resourcePool": return <AdminResourcePool value={settings.compute.resourcePool} onChange={(v) => updateCompute("resourcePool", v)} />;
      case "allocation": return <AdminAllocation value={settings.compute.allocation} onChange={(v) => updateCompute("allocation", v)} />;
      case "components": return <AdminComponents basePath={root} />;
      case "feedback": return <AdminUsage embedded pane="feedback" basePath={root} />;
      default: return null;
    }
  };

  if (phase === "login") {
    return (
      <div className="ak-shell ak-shell--login">
        <div className="ak-login-wrap">
          <form className="ak-login-card" onSubmit={submitLogin}>
            <div className="ak-login-title">管理员登录</div>
            <div className="ak-login-sub">管理控制台仅限管理员访问</div>
            <label className="ak-login-field">
              <span>用户名</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} />
            </label>
            <label className="ak-login-field">
              <span>密码</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            {loginErr ? <div className="ak-login-err" role="alert">{loginErr}</div> : null}
            <button type="submit" className="ak-login-submit" disabled={!username.trim() || !password}>登录</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className={`ak-shell${sidebarOpen ? " is-sidebar-open" : ""}`}>
      <aside className="ak-sidebar" aria-label="管理控制台导航">
        <div className="ak-sidebar-head">管理控制台</div>
        <nav className="ak-tree">
          {MENU.map((group) => {
            if (!group.children) {
              return (
                <button key={group.key} type="button" className={`ak-tree-leaf${active === group.key ? " is-active" : ""}`} onClick={() => selectLeaf(group.key)} aria-current={active === group.key ? "page" : undefined}>
                  {group.label}
                </button>
              );
            }
            const open = expanded[group.key];
            return (
              <div className="ak-tree-group" key={group.key}>
                <button type="button" className={`ak-tree-group-head${open ? " is-open" : ""}`} aria-expanded={open} onClick={() => toggleGroup(group.key)}>
                  <span className="ak-tree-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
                  <span>{group.label}</span>
                </button>
                {open ? (
                  <div className="ak-tree-children">
                    {group.children.map((child) => (
                      <button key={child.key} type="button" className={`ak-tree-child${active === child.key ? " is-active" : ""}`} onClick={() => selectLeaf(child.key)} aria-current={active === child.key ? "page" : undefined}>
                        {child.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="ak-main">
        <header className="ak-topbar">
          <button type="button" className="ak-sidebar-toggle" onClick={() => setSidebarOpen((o) => !o)} aria-label={sidebarOpen ? "收起菜单" : "展开菜单"} aria-expanded={sidebarOpen} title={sidebarOpen ? "收起菜单" : "展开菜单"}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <h1 className="ak-topbar-title">{LABELS[active] ?? "管理控制台"}</h1>
          <div className="ak-topbar-actions">
            {dirty ? <span className="ak-dirty-dot" title="有未保存的修改">未保存</span> : null}
            <button type="button" className="ak-btn ak-btn-primary" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? "保存中…" : "保存"}
            </button>
            <button type="button" className="ak-btn ak-btn-ghost" onClick={() => void logout()}>退出登录</button>
          </div>
        </header>
        {saveError ? <div className="ak-save-err" role="alert">{saveError}</div> : null}
        <div className="ak-content">{renderContent()}</div>
      </div>
      {toast ? <div className="ak-toast" role="status">{toast}</div> : null}
    </div>
  );
}

export default AdminConsole;
