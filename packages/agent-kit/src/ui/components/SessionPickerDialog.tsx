"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CloseIcon, SearchIcon } from "../icons/SharedIcons.tsx";
import { relativeTime } from "../shared/relativeTime.ts";

export interface SessionPickerEntry {
  id: string;
  title: string;
  preview?: string | null;
  detail?: string | null;
  updatedAt?: string | null;
  unread?: boolean;
}

export interface SessionPickerDialogProps {
  title: string;
  sessions: SessionPickerEntry[];
  onSelect: (sessionId: string) => void;
  onClose: () => void;
}

/** Local, host-supplied session picker. It never fetches or navigates on its own. */
export default function SessionPickerDialog({ title, sessions, onSelect, onClose }: SessionPickerDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? sessions.filter((session) => `${session.title} ${session.preview ?? ""} ${session.detail ?? ""}`.toLocaleLowerCase().includes(needle)) : sessions;
  }, [query, sessions]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setActiveIndex(0); }, [query]);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, matches.length - 1)); }
    if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(0, index - 1)); }
    if (event.key === "Enter" && matches[activeIndex]) { event.preventDefault(); onSelect(matches[activeIndex].id); }
  }

  return <div className="session-picker-backdrop" onMouseDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section className="session-picker-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
      <header className="session-picker-header"><h2>{title}</h2><button type="button" aria-label="关闭" onClick={onClose}><CloseIcon /></button></header>
      <div className="session-picker-search"><SearchIcon /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onSearchKey} placeholder="搜索会话" aria-label="搜索会话" /></div>
      <div className="session-picker-list" role="listbox" aria-label="可添加的会话">
        {matches.length ? matches.map((session, index) => <button key={session.id} type="button" role="option" aria-selected={index === activeIndex}
          className={`session-picker-row${index === activeIndex ? " is-active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => onSelect(session.id)}>
          <span className="session-picker-row-main"><span className="session-picker-row-title">{session.title || "新会话"}</span>
            <span className="session-picker-row-preview">{session.detail || session.preview || "暂无对话"}</span></span>
          <span className="session-picker-row-status">{session.unread ? <span className="session-picker-unread" title="未读" /> : relativeTime(session.updatedAt)}</span>
        </button>) : <p className="session-picker-empty">{query ? "没有匹配的会话" : "暂无可添加的会话"}</p>}
      </div>
    </section>
  </div>;
}
