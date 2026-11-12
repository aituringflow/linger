"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionItem } from "../chat/types.ts";
import { apiFetch } from "../shared/apiFetch.ts";
import { useContacts, type CompanyContactUi } from "../shared/useContacts.ts";
import { Avatar } from "../shared/AvatarView.tsx";

type Destination = { kind: "session"; id: string; name: string } | { kind: "contact"; contact: CompanyContactUi };

export default function ForwardMessageDialog({ basePath, sourceSessionId, messageIds, preview, sessions, forwardMode, onClose, onForwarded }: {
  basePath: string; sourceSessionId: string; messageIds: number[]; preview: string; sessions: SessionItem[];
  forwardMode?: "merged" | "individual";
  onClose: () => void; onForwarded: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const createdSessionRef = useRef<string | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [destination, setDestination] = useState<Destination | null>(null);
  const [searchFocused, setSearchFocused] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"merged" | "individual">(forwardMode ?? (messageIds.length > 1 ? "merged" : "individual"));
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(query), 200); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !sending) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, sending]);
  const { contacts, loading: contactsLoading } = useContacts(basePath, { enabled: !!debouncedQuery, search: true, query: debouncedQuery });
  const matchingSessions = useMemo(() => sessions.filter(session => (session.memberCount ?? 0) > 0 &&
    (session.peerName || session.title).toLocaleLowerCase().includes(query.toLocaleLowerCase())), [sessions, query]);
  const matchingContacts = contacts;
  const selectedAvatar = destination?.kind === "contact" ? destination.contact.avatar : destination?.kind === "session" ? sessions.find(session => session.id === destination.id)?.peerAvatar : null;
  const selectedName = destination?.kind === "contact" ? destination.contact.name : destination?.name;
  function chooseDestination(next: Destination) {
    createdSessionRef.current = null;
    setDestination(next);
    setQuery("");
    setSearchFocused(false);
    searchRef.current?.blur();
  }

  async function submit() {
    if (sending || !destination) return;
    setSending(true); setError("");
    try {
      let targetSessionId = destination?.kind === "session" ? destination.id : createdSessionRef.current || "";
      const contactIds = destination.kind === "contact" ? [destination.contact.id] : [];
      if (!targetSessionId) {
        const response = await apiFetch(`${basePath}/api/sessions`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: crypto.randomUUID(), title: destination.kind === "contact" ? destination.contact.name : "新会话", contactIds }),
        });
        const result = await response.json().catch(() => ({})) as { session?: { id?: string }; error?: string };
        if (!response.ok || !result.session?.id) throw new Error(result.error || "创建会话失败");
        targetSessionId = result.session.id;
        createdSessionRef.current = targetSessionId;
      }
      const response = await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(sourceSessionId)}/forward`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageIds, mode, targetSessionId }),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(result.error || "转发失败，请重试");
      onForwarded();
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "转发失败，请重试"); }
    finally { setSending(false); }
  }

  return <div className="cowork-forward-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !sending) onClose(); }}>
    <div className="cowork-forward-dialog" role="dialog" aria-modal="true" aria-label="转发消息">
      <header><h2>分享{messageIds.length > 1 ? ` ${messageIds.length} 条消息` : "消息"}</h2></header>
      {messageIds.length > 1 && !forwardMode ? <div className="cowork-forward-modes" role="radiogroup" aria-label="分享方式">
        <label><input type="radio" name="forward-mode" checked={mode === "merged"} onChange={() => setMode("merged")} />合并分享 <small>作为一张聊天记录卡片</small></label>
        <label><input type="radio" name="forward-mode" checked={mode === "individual"} onChange={() => setMode("individual")} />逐条分享 <small>按原顺序发送多条消息</small></label>
      </div> : null}
      <div className={`cowork-forward-searchbox${searchFocused ? " is-focused" : ""}`} onClick={() => searchRef.current?.focus()}>
        {destination ? <span className="cowork-forward-chip"><Avatar name={selectedName || "成员"} src={selectedAvatar ?? undefined} size={24} className="cowork-forward-avatar" /><span>{selectedName}</span><button type="button" aria-label="移除转发对象" onClick={event => { event.stopPropagation(); createdSessionRef.current = null; setDestination(null); searchRef.current?.focus(); }}>×</button></span> : null}
        <input ref={searchRef} className="cowork-forward-search" value={query} onChange={event => setQuery(event.target.value)} onFocus={() => setSearchFocused(true)} onBlur={() => setSearchFocused(false)} placeholder={destination ? "" : "搜索会话或联系人"} aria-label="搜索会话或联系人" />
      </div>
      {searchFocused || !destination ? <div className="cowork-forward-list" onMouseDown={event => event.preventDefault()}>
        {matchingSessions.length ? <><span className="cowork-forward-section">最近对话</span>{matchingSessions.map(session => <button key={session.id} type="button" className={`cowork-forward-row${destination?.kind === "session" && destination.id === session.id ? " is-selected" : ""}`} onClick={() => chooseDestination({ kind: "session", id: session.id, name: session.peerName || session.title })}>
          <Avatar name={session.peerName || session.title} src={session.peerAvatar ?? undefined} size={32} className="cowork-forward-avatar" /><span>{session.memberCount === 1 ? session.peerName || session.title : session.title}</span>{(session.memberCount ?? 0) > 1 ? <small>({(session.memberCount ?? 0) + 1})</small> : null}
        </button>)}</> : null}
        {query.trim() && matchingContacts.length ? <><span className="cowork-forward-section">联系人</span>{matchingContacts.map(contact => <button key={`${contact.provider}:${contact.id}`} type="button" className={`cowork-forward-row${destination?.kind === "contact" && destination.contact.id === contact.id ? " is-selected" : ""}`} onClick={() => chooseDestination({ kind: "contact", contact })}>
          <Avatar name={contact.name} src={contact.avatar ?? undefined} size={32} className="cowork-forward-avatar" /><span>{contact.name}</span><small>{contact.department}</small>
        </button>)}</> : null}
        {contactsLoading && query.trim() ? <span className="cowork-forward-section">搜索中…</span> : null}
        {!matchingSessions.length && !matchingContacts.length && !contactsLoading ? <span className="cowork-forward-section">{query ? "没有找到匹配的会话或联系人" : "暂无可转发的会话"}</span> : null}
      </div> : null}
      <div className="cowork-forward-preview" title={preview}>{preview}</div>
      {error ? <p className="cowork-error" role="alert">{error}</p> : null}
      <footer><button type="button" onClick={onClose} disabled={sending}>取消</button><button type="button" className="is-primary" disabled={sending || !destination} onClick={() => void submit()}>{sending ? "发送中…" : "发送"}</button></footer>
    </div>
  </div>;
}
