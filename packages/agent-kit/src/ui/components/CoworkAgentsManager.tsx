"use client";

import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../shared/apiFetch.ts";
import { NavigationChevronIcon, SettingsIcon } from "../icons/SharedIcons.tsx";
import { ChatPanelGlyph34 } from "../icons/PageIcons.tsx";

type ReplyPolicy = "mentions_only" | "cautious" | "balanced" | "proactive" | "custom";
export type CoworkAgentInfo = { id: string; name: string; prompt: string; enabled: boolean; previewPublicId?: string | null; createdBy: string; replyPolicy: ReplyPolicy; speakingPrompt: string };
type Member = { sub: string; name: string; isSelf: boolean };
type Connection = { id: string; agentId: string; name: string; kind: string; target: string; ownerSub: string; ownerName: string; ownerAvatar: string; enabled: boolean; grants: string[] };

export default function CoworkAgentsManager({ basePath, sessionId, renderMonologues, onAgentChange, runningAgentIds, onStopAgent }: {
  basePath: string; sessionId: string; renderMonologues: (agentId: string) => ReactNode;
  /** 选中 AI 变化时通知外部（用于滚动定位：切换 AI = 重新进入，回到底部）。 */
  onAgentChange?: (agentId: string | null) => void;
  /** 当前正在执行（快思考/复核/慢思考）的 AI id 集合：仅这些 AI 在详情页显示停止按钮。 */
  runningAgentIds?: ReadonlySet<string>;
  /** 停止该 AI 的全部执行会话（快/慢思考）。 */
  onStopAgent?: (agentId: string) => void;
}) {
  const [agents, setAgents] = useState<CoworkAgentInfo[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [selfSub, setSelfSub] = useState("");
  const [ownerSub, setOwnerSub] = useState("");
  const [isTwoPerson, setIsTwoPerson] = useState(false);
  const [serverIsAdmin, setServerIsAdmin] = useState(false);
  const [groupContainerEnabled, setGroupContainerEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"detail" | "settings" | "add-connection" | "edit-connection">("detail");
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [newName, setNewName] = useState("");
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [connectionName, setConnectionName] = useState("");
  const [connectionSecret, setConnectionSecret] = useState("");
  const [connectionGrants, setConnectionGrants] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [containerBusy, setContainerBusy] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  /** 「连接与授权」区块临时开关：false=隐藏，true=恢复显示。 */
  const SHOW_CONNECTIONS = false;
  const api = `${basePath}/api/cowork/${encodeURIComponent(sessionId)}`;
  const selected = agents.find(agent => agent.id === selectedId) ?? null;
  const editingConnection = connections.find(connection => connection.id === editingConnectionId) ?? null;
  const isAdmin = selfSub === ownerSub || isTwoPerson || serverIsAdmin;
  /** 可管理 AI：群主、该 AI 创建者、任命管理员，或 1v1 双方。 */
  const canEdit = !!selected && (isAdmin || selfSub === selected.createdBy);
  /** 群级云电脑开关：群主、任命管理员，或 1v1 双方可操作。 */
  const canManageContainer = isAdmin;

  const load = async (signal?: AbortSignal) => {
    const [agentsResponse, connectionsResponse] = await Promise.all([
      apiFetch(`${api}/agents`, { cache: "no-store", signal }), apiFetch(`${api}/connections`, { cache: "no-store", signal }),
    ]);
    if (!agentsResponse.ok || !connectionsResponse.ok) {
      const statuses = [agentsResponse, connectionsResponse].filter(response => !response.ok).map(response => response.status);
      const failure = new Error("加载群 AI 设置失败") as Error & { pending?: boolean };
      failure.pending = statuses.every(status => status === 404 || status === 409 || status === 503);
      throw failure;
    }
    const agentData = await agentsResponse.json() as { agents: CoworkAgentInfo[]; members: Member[]; selfSub: string; ownerSub: string; isTwoPerson?: boolean; isAdmin?: boolean; containerEnabled?: boolean };
    const connectionData = await connectionsResponse.json() as { connections: Connection[] };
    if (signal?.aborted) return;
    setAgents(agentData.agents);
    setMembers(agentData.members);
    setSelfSub(agentData.selfSub);
    setOwnerSub(agentData.ownerSub);
    setIsTwoPerson(Boolean(agentData.isTwoPerson));
    setServerIsAdmin(Boolean(agentData.isAdmin));
    setGroupContainerEnabled(Boolean(agentData.containerEnabled));
    setConnections(connectionData.connections);
  };
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSelectedId(null); setView("detail"); setShowAddAgent(false); setError(""); setLoading(true);
    const attempt = async () => {
      try {
        await load(controller.signal);
        if (!controller.signal.aborted) setLoading(false);
      } catch (e) {
        if (controller.signal.aborted) return;
        if ((e as { pending?: boolean }).pending) timer = setTimeout(() => void attempt(), 1000);
        else { setLoading(false); setError(e instanceof Error ? e.message : "加载群 AI 设置失败"); }
      }
    };
    void attempt();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [sessionId, basePath]);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) void load();
    };
    window.addEventListener("cowork-agents-changed", changed);
    return () => window.removeEventListener("cowork-agents-changed", changed);
  }, [sessionId, basePath]);
  useEffect(() => { onAgentChange?.(selectedId); }, [selectedId, onAgentChange]);
  useEffect(() => { setNameDraft(selected?.name ?? ""); }, [selected?.id, selected?.name]);
  useEffect(() => { setPromptDraft(selected?.prompt ?? ""); }, [selected?.id, selected?.prompt]);
  const openConnection = (connection: Connection) => {
    setEditingConnectionId(connection.id); setConnectionName(connection.name);
    setConnectionSecret(""); setView("edit-connection"); setError("");
  };
  const authorizationSummary = (connection: Connection) => {
    const names = connection.grants.map(sub => members.find(member => member.sub === sub)?.name ?? "成员");
    return names.length ? `仅自己及 ${names.join("、")}` : "仅自己";
  };
  const mutate = async (path: "agents" | "connections", method: "POST" | "PATCH" | "DELETE", body: Record<string, unknown>) => {
    setBusy(true); setError("");
    try {
      const response = await apiFetch(`${api}/${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as { error?: string; agent?: CoworkAgentInfo };
      if (!response.ok) throw new Error(result.error === "invalid_secret_key" ? "COWORK_SECRET_KEY 必须是 32 字节密钥的 base64 编码" : result.error || `保存失败 (${response.status})`);
      await load();
      if (path === "agents") window.dispatchEvent(new CustomEvent("cowork-agents-changed", { detail: { sessionId } }));
      return result;
    } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); return null; }
    finally { setBusy(false); }
  };
  /** 群级共享云电脑开关：一个群一个容器，群内所有 AI 共享；群主或 1v1 双方管理员可操作。 */
  const toggleGroupContainer = async (checked: boolean) => {
    setContainerBusy(true); setError("");
    try {
      const response = await apiFetch(`${api}/container`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ containerEnabled: checked }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `云电脑${checked ? "启动" : "关闭"}失败 (${response.status})`);
      await load();
      window.dispatchEvent(new CustomEvent("cowork-agents-changed", { detail: { sessionId } }));
    } catch (error) { setError(error instanceof Error ? error.message : "容器操作失败"); }
    finally { setContainerBusy(false); }
  };
  return <div className="cowork-agents-manager">
    {loading ? <div className="chat-loading-state chat-loading-state--session" role="status" aria-label="群 AI 加载中"><span className="chat-loading-spinner" aria-hidden="true" /></div> : null}
    {!loading ? <>
    {!selected ? <>
      <div className="cowork-agent-topbar cowork-agents-heading">
        <div className="cowork-agents-heading-title"><strong>群 AI</strong><span>启用的 AI 可在群里被 @</span></div>
        <label className="cowork-settings-mute cowork-container-toggle" title={groupContainerEnabled ? "关闭云电脑" : "开启云电脑"}>
          <span>云电脑</span>
          <input type="checkbox" role="switch" aria-label="云电脑" checked={groupContainerEnabled} disabled={!canManageContainer || containerBusy}
            onChange={event => void toggleGroupContainer(event.target.checked)} />
          <span className="cowork-settings-switch" aria-hidden="true" />
          {containerBusy ? <span className="cowork-container-busy" role="status"><span className="chat-loading-spinner" aria-hidden="true" /><span className="cowork-visually-hidden">{groupContainerEnabled ? "云电脑关闭中…" : "云电脑启动中…"}</span></span> : null}
        </label>
      </div>
      <div className="cowork-agent-content">
      <div className="cowork-agents-list">
        {agents.map(agent => <div
          key={agent.id}
          className="cowork-agent-row"
          role="button"
          tabIndex={0}
          onClick={() => setSelectedId(agent.id)}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(agent.id); } }}
        >
          <span className="cowork-agent-row-open"><strong>{agent.name}</strong></span>
          <button
            type="button"
            className="chatmate-switch"
            role="switch"
            aria-label={`启用 ${agent.name}`}
            aria-checked={agent.enabled}
            disabled={busy || (!isAdmin && selfSub !== agent.createdBy)}
            onClick={(event) => { event.stopPropagation(); void mutate("agents", "PATCH", { id: agent.id, enabled: !agent.enabled }); }}
          ><span className="chatmate-switch-thumb" /></button>
          <span className="cowork-agent-row-chevron" aria-hidden="true">›</span>
        </div>)}
      </div>
      {isAdmin ? <form className="cowork-agent-add" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !newName.trim()) setShowAddAgent(false); }} onSubmit={event => { event.preventDefault(); if (!newName.trim()) return; void mutate("agents", "POST", { name: newName }).then(result => { if (result?.agent) { setNewName(""); setShowAddAgent(false); setSelectedId(result.agent.id); } }); }}>
        <button type="button" className="cowork-agent-add-toggle" aria-label="添加 AI" title="添加 AI" aria-expanded={showAddAgent} onClick={() => { setShowAddAgent(current => !current); setNewName(""); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
        {showAddAgent ? <><input value={newName} onChange={event => setNewName(event.target.value)} placeholder="AI 名称" maxLength={80} aria-label="新 AI 名称" autoFocus /><button type="submit" disabled={busy || !newName.trim()}>确认</button></> : null}
      </form> : null}
      </div>
    </> : <>
      {view === "detail" ? <>
        <div className="cowork-agent-topbar cowork-agent-detail-head cowork-agent-toolbar"><div className="cowork-agent-toolbar-title"><button type="button" className="cowork-agent-back" onClick={() => setSelectedId(null)} aria-label="返回群 AI 列表" title="返回群 AI 列表"><NavigationChevronIcon direction="left" /></button><strong>{selected.name}</strong></div><div style={{ display: "flex", alignItems: "center", gap: 8 }}>{runningAgentIds?.has(selected.id) ? <button type="button" className="cowork-agent-stop" aria-label={`停止 ${selected.name} 当前任务`} title="停止当前任务" onClick={() => onStopAgent?.(selected.id)}><ChatPanelGlyph34 /></button> : null}<button type="button" className="chat-topbar-btn cowork-agent-settings-btn" aria-label={`${selected.name} 设置`} title="设置" onClick={() => setView("settings")}><SettingsIcon /></button></div></div>
        <div className="cowork-agent-content">
        {renderMonologues(selected.id)}
        </div>
      </> : <>
        <div className="cowork-agent-topbar cowork-agent-detail-head cowork-agent-toolbar"><div className="cowork-agent-toolbar-title"><button type="button" className="cowork-agent-back" onClick={() => setView(view === "settings" ? "detail" : "settings")} aria-label={view === "settings" ? `返回${selected.name}` : "返回设置"} title="返回"><NavigationChevronIcon direction="left" /></button><strong>{view === "settings" ? `${selected.name} 设置` : view === "add-connection" ? "添加连接" : "编辑连接"}</strong></div></div>
        <div className="cowork-agent-content">
        {view === "settings" ? <>
          <label className="cowork-agent-field">名称<input value={nameDraft} disabled={!canEdit || busy} maxLength={80} onChange={event => setNameDraft(event.target.value)} onBlur={() => { if (nameDraft.trim() && nameDraft.trim() !== selected.name) void mutate("agents", "PATCH", { id: selected.id, name: nameDraft.trim() }); }} /></label>
          <label className="cowork-agent-field">AI 发言方式<select value={selected.replyPolicy === "mentions_only" ? "mentions_only" : "automatic"} onChange={event => void mutate("agents", "PATCH", { id: selected.id, replyPolicy: event.target.value === "mentions_only" ? "mentions_only" : "balanced" })} disabled={!canEdit || busy}><option value="mentions_only">仅被 @ 时发言</option><option value="automatic">不被 @ 时也可以发言</option></select></label>
          {selected.replyPolicy !== "mentions_only" ? <>
            <div className="cowork-agent-policy-tabs" role="tablist" aria-label="主动发言策略">
              {([ ["cautious", "谨慎"], ["balanced", "适时"], ["proactive", "积极"], ["custom", "自定义"] ] as const).map(([policy, label]) =>
                <button key={policy} type="button" role="tab" aria-selected={selected.replyPolicy === policy} disabled={!canEdit || busy} onClick={() => { if (selected.replyPolicy !== policy) void mutate("agents", "PATCH", { id: selected.id, replyPolicy: policy }); }}>{label}</button>)}
            </div>
            <div className="chatmate-prompt-block cowork-prompt-plain"><label className="cowork-agent-field">提示词<textarea value={selected.replyPolicy === "custom" ? promptDraft : selected.prompt} readOnly={selected.replyPolicy !== "custom"} disabled={!canEdit || busy} rows={9} maxLength={20000} onChange={event => setPromptDraft(event.target.value)} placeholder="说明这个 AI 的职责和行为" spellCheck={false} /></label>{selected.replyPolicy === "custom" ? <div className="chatmate-prompt-actions"><button type="button" disabled={!canEdit || busy || promptDraft === selected.prompt} onClick={() => void mutate("agents", "PATCH", { id: selected.id, prompt: promptDraft })}>{busy ? "保存中…" : "保存提示词"}</button></div> : null}</div>
          </> : null}
          {/* 「连接与授权」暂时隐藏：保留代码，后续需要时把 SHOW_CONNECTIONS 置 true 即可恢复 */}
          {SHOW_CONNECTIONS ? <>
            <div className="cowork-connection-title"><h3>连接与授权</h3><button type="button" onClick={() => { setConnectionName(""); setConnectionSecret(""); setConnectionGrants([]); setView("add-connection"); }}>添加连接</button></div>
            <div className="cowork-connection-list">{connections.filter(connection => connection.agentId === selected.id).map(connection => <div className="cowork-connection-row" key={connection.id}>
              <span className="cowork-connection-owner-avatar" aria-hidden="true">{connection.ownerAvatar ? <img src={connection.ownerAvatar.startsWith("/") ? `${basePath}${connection.ownerAvatar}` : connection.ownerAvatar} alt="" /> : connection.ownerName.slice(0, 1)}</span>
              <span className="cowork-connection-owner-name" title={connection.ownerName}>{connection.ownerName}</span>
              <span className="cowork-connection-info"><strong>{connection.name}</strong><small>{connection.enabled ? authorizationSummary(connection) : `已停用 · ${authorizationSummary(connection)}`}</small></span>
              <button type="button" disabled={busy || connection.ownerSub !== selfSub} onClick={() => openConnection(connection)}>编辑</button>
              <button type="button" className="cowork-agent-danger" disabled={busy || connection.ownerSub !== selfSub} onClick={() => { if (window.confirm(`删除连接“${connection.name}”？`)) void mutate("connections", "DELETE", { id: connection.id }); }}>删除</button>
            </div>)}</div>
          </> : null}
          {!selected.id.endsWith(":default") && canEdit ? <button type="button" className="cowork-agent-danger cowork-agent-delete" disabled={busy} onClick={() => { if (window.confirm(`删除 AI“${selected.name}”？`)) void mutate("agents", "DELETE", { id: selected.id }).then(result => { if (result) { setSelectedId(null); setView("detail"); } }); }}>删除 AI</button> : null}
        </> : view === "add-connection" ? <form className="cowork-connection-add" onSubmit={event => { event.preventDefault(); void mutate("connections", "POST", { agentId: selected.id, name: connectionName, secret: connectionSecret, grants: connectionGrants }).then(result => { if (result) { setConnectionSecret(""); setView("settings"); } }); }}>
          <input value={connectionName} onChange={event => setConnectionName(event.target.value)} placeholder="连接名称" maxLength={80} required /><input type="password" autoComplete="off" value={connectionSecret} onChange={event => setConnectionSecret(event.target.value)} placeholder="密钥内容" required />
          <div className="cowork-grant-section"><strong>授权使用者</strong><span className="cowork-agent-hint">默认仅自己可用。勾选后，选中的群成员也能使用此连接。</span><div className="cowork-grant-list"><label className="cowork-grant"><input type="checkbox" checked disabled />自己（创建者）</label>{members.filter(member => !member.isSelf).map(member => <label className="cowork-grant" key={member.sub}><input type="checkbox" checked={connectionGrants.includes(member.sub)} onChange={event => setConnectionGrants(current => event.target.checked ? [...current, member.sub] : current.filter(sub => sub !== member.sub))} />{member.name}</label>)}</div></div>
          <button type="submit" disabled={busy || !connectionName.trim() || !connectionSecret}>添加连接</button>
        </form> : editingConnection ? <>
          <form className="cowork-connection-add" onSubmit={event => { event.preventDefault(); void mutate("connections", "PATCH", { id: editingConnection.id, name: connectionName.trim(), ...(connectionSecret ? { secret: connectionSecret } : {}) }).then(result => { if (result) setConnectionSecret(""); }); }}>
            <input value={connectionName} maxLength={80} disabled={busy} onChange={event => setConnectionName(event.target.value)} placeholder="连接名称" required />
            <input type="password" autoComplete="off" value={connectionSecret} disabled={busy} onChange={event => setConnectionSecret(event.target.value)} placeholder="新密钥（留空则不修改）" />
            <button type="submit" disabled={busy || !connectionName.trim() || connectionName.trim() === editingConnection.name && !connectionSecret}>保存连接</button>
          </form>
          <div className="cowork-grant-section"><strong>授权使用者</strong><span className="cowork-agent-hint">默认仅自己可用，修改授权后立即生效。</span><div className="cowork-grant-list"><label className="cowork-grant"><input type="checkbox" checked disabled />自己（创建者）</label>{members.filter(member => !member.isSelf).map(member => <label className="cowork-grant" key={member.sub}><input type="checkbox" checked={editingConnection.grants.includes(member.sub)} disabled={busy} onChange={event => void mutate("connections", "PATCH", { id: editingConnection.id, grants: event.target.checked ? [...editingConnection.grants, member.sub] : editingConnection.grants.filter(sub => sub !== member.sub) })} />{member.name}</label>)}</div></div>
        </> : null}
        </div>
      </>}
    </>}
    {error ? <p className="cowork-error" role="alert">{error}</p> : null}
    </> : null}
  </div>;
}
