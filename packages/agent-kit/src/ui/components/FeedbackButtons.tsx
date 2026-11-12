"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreIcon } from "../icons/SharedIcons.tsx";
import { FeedbackCopyIcon, FeedbackVoteIcon } from "../icons/DynamicIcons.tsx";
import { createPortal } from "react-dom";

type Vote = "up" | "down" | null;
type Menu = "more" | null;
const reasons = ["不正确或不完整", "没有遵循我的指示", "偏题 / 超出范围", "丢失上下文", "速度慢或有故障", "安全或法律问题", "其他"];
/** Answer actions. Feedback remains local until an upstream reporting API is available. */
export default function FeedbackButtons({ basePath = "", sessionId, messageId, answer = "", branchAction, onRegenerate, canRegenerate = false, vote = null, onVote }: { basePath?: string; sessionId?: string; messageId?: number; answer?: string; branchAction?: ReactNode; onRegenerate?: () => void; canRegenerate?: boolean; vote?: Vote; onVote?: (v: Vote) => void }) {
  const [draftVote, setDraftVote] = useState<"up" | "down" | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [detail, setDetail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [menu, setMenu] = useState<Menu>(null);
  const [copied, setCopied] = useState<"answer" | "session" | null>(null);
  const [copyError, setCopyError] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuFocused = useRef(false);
  const trigger = () => moreRef.current;
  const close = () => { trigger()?.focus(); setMenu(null); };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  useLayoutEffect(() => {
    if (menu && menuPos && !menuFocused.current) {
      menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      menuFocused.current = true;
    }
  }, [menu, menuPos]);
  useLayoutEffect(() => {
    if (!menu) return;
    const button = trigger();
    const popup = menuRef.current;
    if (!button || !popup) return;
    const position = () => {
      const rect = button.getBoundingClientRect();
      const width = popup.offsetWidth;
      const height = popup.offsetHeight;
      const below = rect.bottom + 6;
      const top = rect.top >= height + 14 ? rect.top - height - 6 : below;
      setMenuPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(top, window.innerHeight - height - 8)) });
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => { window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [menu]);

  const copy = async (target: "answer" | "session") => {
    const text = target === "answer" ? answer : sessionId;
    if (!text) return;
    try {
      const desktop = (window as unknown as { agentHost?: { clipboard?: { writeText(text: string): Promise<unknown> | unknown } } }).agentHost;
      if (desktop?.clipboard?.writeText) await desktop.clipboard.writeText(text);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
      else {
        const focused = document.activeElement as HTMLElement | null;
        const textarea = document.createElement("textarea");
        textarea.value = text; textarea.setAttribute("readonly", "");
        textarea.style.cssText = "position:fixed;top:-9999px;left:-9999px";
        document.body.appendChild(textarea);
        try { textarea.select(); if (!document.execCommand("copy")) throw new Error("Copy failed"); }
        finally { textarea.remove(); focused?.focus(); }
      }
      setCopied(target); setCopyError(false);
    } catch { setCopied(null); setCopyError(true); }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { setCopied(null); setCopyError(false); }, 1800);
  };
  const open = (next: Exclude<Menu, null>) => { menuFocused.current = false; setMenuPos(null); setMenu(menu === next ? null : next); };
  const openFeedback = (value: "up" | "down") => { setDraftVote(value); setCategories([]); setDetail(""); setSubmitError(""); setMenu(null); };
  // 点赞是纯正向动作：直接切换本地点赞态，不弹反馈对话框（点踩才需要填原因）。
  const toggleLike = () => { const next = vote === "up" ? null : "up"; onVote?.(next); void persistVote(next === null ? "none" : next); };
  // 把投票落库：点赞（up）/取消（none）直接提交；点踩走 submitFeedback（带原因）。
  const persistVote = async (next: "up" | "down" | "none") => {
    if (!sessionId || messageId == null) return; // 无会话/消息 ID 仅本地，不落库
    try {
      await fetch(`${basePath}/api/feedback`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, messageId, answer, vote: next, categories: [], detail: "" }) });
    } catch { /* 静默：本地状态已更新，落库失败不影响交互 */ }
  };
  const submitFeedback = async () => {
    if (!draftVote || !sessionId || (!categories.length && !detail.trim())) return;
    setSubmitting(true); setSubmitError("");
    try {
      const response = await fetch(`${basePath}/api/feedback`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, messageId, answer, vote: draftVote, categories, detail: detail.trim() }) });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error || `提交失败 (${response.status})`); }
      onVote?.(draftVote); setDraftVote(null);
    } catch (e) { setSubmitError(e instanceof Error ? e.message : "提交失败，请重试"); }
    finally { setSubmitting(false); }
  };
  return <div className="chat-fb">
    <button type="button" className={`chat-fb-btn${copied === "answer" ? " is-copied" : ""}`} onClick={() => void copy("answer")} disabled={!answer}
      title={copied === "answer" ? "已复制答案" : "复制答案"} aria-label={copied === "answer" ? "已复制答案" : "复制答案"}>
      <FeedbackCopyIcon copied={copied === "answer"} />
    </button>
    {(["up", "down"] as const).map((value) => <button key={value} type="button" className={`chat-fb-btn chat-fb-vote${vote === value ? " on" : ""}`}
      title={value === "up" ? "点赞" : "点踩"} aria-label={value === "up" ? "点赞" : "点踩并提交反馈"} onClick={() => value === "up" ? toggleLike() : openFeedback(value)}>
      <FeedbackVoteIcon vote={value} selected={vote === value} />
    </button>)}
    {branchAction}
    <button ref={moreRef} type="button" className={`chat-fb-btn chat-fb-more${menu === "more" ? " on" : ""}`} title="更多" aria-label="更多" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => open("more")}>
      <MoreIcon />
    </button>
    <span className="chat-fb-status" role="status">{copyError ? "复制失败，请重试" : copied === "answer" ? "已复制答案" : copied === "session" ? "已复制会话ID" : ""}</span>
    {menu ? createPortal(<>
      <div className="chat-fb-menu-backdrop" onClick={close} />
      <div ref={menuRef} className="chat-fb-menu" role="menu" aria-label="更多操作"
        style={{ position: "fixed", ...menuPos, visibility: menuPos ? "visible" : "hidden" }}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(null); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); close(); }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault(); const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const index = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[index]?.focus();
          }
        }}>
        <>
          {onRegenerate ? <button type="button" role="menuitem" className="chat-fb-menu-item" disabled={!canRegenerate} onClick={() => { close(); onRegenerate(); }}>重新生成内容</button> : null}
          <button type="button" role="menuitem" className="chat-fb-menu-item" disabled={!sessionId} onClick={() => void copy("session")}>{copied === "session" ? "已复制 ✓" : "复制会话ID"}</button>
        </>
      </div>
    </>, document.body) : null}
    {draftVote ? createPortal(<div className="chat-feedback-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !submitting) setDraftVote(null); }}>
      <div className="chat-feedback-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-feedback-title" onKeyDown={(e) => { if (e.key === "Escape" && !submitting) setDraftVote(null); }}>
        <div className="chat-feedback-head"><h2 id="chat-feedback-title">提交反馈</h2><button type="button" aria-label="关闭" onClick={() => setDraftVote(null)} disabled={submitting}>×</button></div>
        <div className="chat-feedback-reasons">{reasons.map((reason) => <button key={reason} type="button" className={categories.includes(reason) ? "selected" : ""} aria-pressed={categories.includes(reason)} onClick={() => setCategories((prev) => prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason])}>{categories.includes(reason) ? "✓" : "+"} {reason}</button>)}</div>
        <textarea autoFocus value={detail} onChange={(e) => setDetail(e.target.value)} maxLength={4000} placeholder="填写详情（选填）" aria-label="反馈详情" />
        <p>你的反馈可用于改进回复质量。</p>
        {submitError ? <div className="chat-feedback-error" role="alert">{submitError}</div> : null}
        <button type="button" className="chat-feedback-submit" disabled={submitting || !sessionId || (!categories.length && !detail.trim())} onClick={() => void submitFeedback()}>{submitting ? "提交中…" : "提交"}</button>
      </div>
    </div>, document.body) : null}
  </div>;
}
