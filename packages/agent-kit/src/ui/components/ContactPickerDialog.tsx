"use client";

import { useChatTranslation } from "../chat/i18n.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CompanyContactUi, ContactsError } from "../shared/useContacts.ts";
import { Avatar } from "../shared/AvatarView.tsx";

/**
 * 通用联系人选择弹窗（PC 双栏布局，可跨场景复用）：
 * - 左栏：搜索 + 可选联系人列表（复选框，点击整行即切换选中）；
 * - 右栏：已选列表（头像 + 姓名 + × 移除），头部显示「已选：N 人」；
 * - 底部右侧确认按钮，文案由 confirmLabel 决定（新建任务「新建」/ 会话内「邀请」）。
 * 选择状态由本组件内部持有，确认时经 onConfirm(ids) 一次性交回调用方；
 * excludeIds 中的联系人不在左栏出现（如已在会话中的成员）。
 */
export default function ContactPickerDialog({
  open, title, confirmLabel, contacts, loading, error, onReload, query, onQueryChange,
  excludeIds = [], initialSelected = [], initialContacts = [], busy, actionError = "", onConfirm, onClose,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  contacts: CompanyContactUi[];
  loading: boolean;
  error: ContactsError | null;
  onReload: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  excludeIds?: string[];
  initialSelected?: string[];
  initialContacts?: CompanyContactUi[];
  busy?: boolean;
  /** 确认动作（如邀请）失败提示，显示在 footer 上方 */
  actionError?: string;
  onConfirm: (selectedIds: string[]) => void | Promise<void>;
  onClose: () => void;
}) {
  const t = useChatTranslation();
  const [visibleCount, setVisibleCount] = useState(100);
  const [selected, setSelected] = useState<string[]>([]);
  // 仅在弹窗打开瞬间以 initialSelected 播种一次：父组件后续 props 变化不覆盖用户操作
  const seededRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open && !seededRef.current) {
      setSelected(initialSelected);
      onQueryChange("");
      setVisibleCount(100);
      seededRef.current = true;
      // 打开即聚焦搜索框，省去手动点一下
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    if (!open) seededRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const exclude = useMemo(() => new Set(excludeIds), [excludeIds]);
  const knownContacts = useRef(new Map<string, CompanyContactUi>());
  for (const contact of initialContacts) knownContacts.current.set(contact.id, contact);
  for (const contact of contacts) knownContacts.current.set(contact.id, contact);
  // OA 已返回匹配结果；会话中已有的联系人仍展示，但不可再次勾选。
  const selectable = useMemo(() => contacts.filter(contact => !exclude.has(contact.id)), [contacts, exclude]);
  const matched = contacts;
  useEffect(() => setVisibleCount(100), [query]);
  const selectedContacts = useMemo(() => selected
    .map(id => knownContacts.current.get(id))
    .filter((contact): contact is CompanyContactUi => Boolean(contact)), [selected, contacts]);
  // 全选只作用于可勾选的人：已在会话中的人本就不可选，不能被塞进 selected
  const allFilteredSelected = selectable.length > 0 && selectable.every(contact => selected.includes(contact.id));

  if (!open) return null;
  const toggle = (id: string) => setSelected(list => list.includes(id) ? list.filter(v => v !== id) : [...list, id]);
  return (
    <div className="chat-invite-backdrop" onClick={onClose}>
      <div className="chat-invite-dialog chat-invite-dialog--picker" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
        <header><strong>{title}</strong><button type="button" onClick={onClose} aria-label={t("close")}>×</button></header>
        <div className="chat-invite-body">
          <div className="chat-invite-left">
            <div className="chat-invite-controls">
              <input ref={inputRef} aria-label={t("searchContacts")} placeholder={t("searchName")} value={query} onChange={event => onQueryChange(event.target.value)} />
              <button type="button" disabled={!selectable.length || loading || Boolean(error)}
                onClick={() => setSelected(current => {
                  const ids = new Set(selectable.map(contact => contact.id));
                  return allFilteredSelected ? current.filter(id => !ids.has(id)) : [...new Set([...current, ...ids])];
                })}>{allFilteredSelected ? "取消全选" : "全选"}</button>
            </div>
            <div className="chat-invite-list">
              {loading && !contacts.length ? <p className="chat-invite-state">{t("loadingContacts")}</p>
                : error ? (
                  <div className="chat-invite-state chat-invite-error" role="alert">
                    <strong>{error.title}</strong>
                    {error.detail ? <p>{error.detail}</p> : null}
                    <button type="button" onClick={onReload} disabled={loading}>{t("retry")}</button>
                  </div>
                )
                : matched.length ? <>{matched.slice(0, visibleCount).map(contact => {
                  // 已在会话中的人：显示这一行，checkbox 勾上并禁用（不可取消邀请）
                  const locked = exclude.has(contact.id);
                  return (
                  <label key={contact.id} className={`chat-invite-contact${locked ? " is-locked" : ""}`} title={locked ? "已在当前会话中" : undefined}>
                    <input type="checkbox" checked={locked || selected.includes(contact.id)} disabled={locked} onChange={() => toggle(contact.id)} />
                    <Avatar name={contact.name} src={contact.avatar || undefined} className="chat-invite-avatar" />
                    <span className="chat-invite-contact-info"><strong>{contact.name}{contact.isSelf ? <em className="chat-invite-self-tag">（你自己）</em> : null}</strong><small>{contact.department}</small></span>
                    {locked ? <em className="chat-invite-locked-tag">{t("alreadyMember")}</em> : null}
                  </label>
                  );
                })}{visibleCount < matched.length ? <button type="button" className="chat-invite-load-more" onClick={() => setVisibleCount(count => count + 100)}>{t("showMorePeople", { count: matched.length - visibleCount })}</button> : null}</> : query.trim() ? <p className="chat-invite-state chat-invite-empty">{t("noResults")}</p> : null}
            </div>
          </div>
          <div className="chat-invite-right">
            <p className="chat-invite-right-head">已选：{selected.length} 人</p>
            <div className="chat-invite-selected-list">
              {selectedContacts.map(contact => (
                <div key={contact.id} className="chat-invite-selected-row">
                  <Avatar name={contact.name} src={contact.avatar || undefined} className="chat-invite-avatar" />
                  <span className="chat-invite-selected-name">{contact.name}{contact.isSelf ? <em className="chat-invite-self-tag">（你自己）</em> : null}</span>
                  <button type="button" className="chat-invite-remove" onClick={() => toggle(contact.id)} aria-label={`移除 ${contact.name}`}>×</button>
                </div>
              ))}
              {!selectedContacts.length ? <p className="chat-invite-state">{t("noneSelected")}</p> : null}
            </div>
          </div>
        </div>
        {actionError ? <p className="chat-invite-error" role="alert">{actionError}</p> : null}
        <footer>
          <span>已选 {selected.length} 人</span>
          <button type="button" disabled={!selected.length || busy || loading} onClick={() => void onConfirm(selected)}>{confirmLabel}</button>
        </footer>
      </div>
    </div>
  );
}
