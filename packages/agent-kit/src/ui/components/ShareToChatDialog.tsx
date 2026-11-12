"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionItem } from "../chat/types.ts";
import { apiFetch } from "../shared/apiFetch.ts";
import { Avatar } from "../shared/AvatarView.tsx";

export default function ShareToChatDialog({ basePath, sourceSessionId, artifactId, sessions, onClose }: {
  basePath: string; sourceSessionId: string; artifactId?: string; sessions: SessionItem[]; onClose: () => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !sending) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, sending]);
  const targets = useMemo(() => sessions.filter(session => session.id !== sourceSessionId &&
    (session.memberCount ?? 0) > 0 && (session.peerName || session.title).toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  [sessions, sourceSessionId, query]);

  async function submit() {
    if (sending || !selected.size) return;
    setSending(true); setError("");
    const failed: string[] = [];
    for (const id of selected) {
      const target = sessions.find(session => session.id === id);
      try {
        const response = await apiFetch(`${basePath}/api/share/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceSessionId, targetSessionId: id, artifactId }),
        });
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok) throw new Error(result.error || "发送失败");
        setSelected(current => { const next = new Set(current); next.delete(id); return next; });
      } catch (cause) { failed.push(`${target?.peerName || target?.title || "会话"}：${cause instanceof Error ? cause.message : "发送失败"}`); }
    }
    setSending(false);
    if (failed.length) setError(failed.join("；"));
    else onClose();
  }

  return <div className="cowork-forward-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !sending) onClose(); }}>
    <div className="cowork-forward-dialog" role="dialog" aria-modal="true" aria-label={artifactId ? "分享产物到聊天" : "发送到聊天"}>
      <header><h2>{artifactId ? "分享产物到聊天" : "发送到聊天"}</h2></header>
      <input ref={searchRef} className="cowork-forward-search chat-share-target-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索群聊或单聊" aria-label="搜索群聊或单聊" />
      <div className="cowork-forward-list chat-share-target-list">
        {targets.map(session => {
          const name = session.memberCount === 1 ? session.peerName || session.title : session.title;
          return <label key={session.id} className="cowork-forward-row chat-share-target-row">
            <input type="checkbox" checked={selected.has(session.id)} disabled={sending} onChange={() => setSelected(current => {
              const next = new Set(current); if (next.has(session.id)) next.delete(session.id); else next.add(session.id); return next;
            })} />
            <Avatar name={name} src={session.peerAvatar ?? undefined} size={32} className="cowork-forward-avatar" />
            <span>{name}</span>{(session.memberCount ?? 0) > 1 ? <small>({(session.memberCount ?? 0) + 1})</small> : null}
          </label>;
        })}
        {!targets.length ? <span className="cowork-forward-section">{query ? "没有找到匹配的聊天" : "暂无可分享的聊天"}</span> : null}
      </div>
      {error ? <p className="cowork-error" role="alert">{error}</p> : null}
      <footer><button type="button" onClick={onClose} disabled={sending}>取消</button><button type="button" className="is-primary" disabled={sending || !selected.size} onClick={() => void submit()}>{sending ? "发送中…" : `发送${selected.size ? ` (${selected.size})` : ""}`}</button></footer>
    </div>
  </div>;
}
