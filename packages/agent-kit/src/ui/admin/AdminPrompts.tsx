"use client";

import { useState } from "react";

interface Props {
  value: { systemPrompt: string; groupPrompt: string };
  onChange: (value: { systemPrompt: string; groupPrompt: string }) => void;
}

const MAX = 20000;

/** 提示词：系统提示词 / 群 AI 提示词 两个 tab，各一个多行文本框。 */
export function AdminPrompts({ value, onChange }: Props) {
  const [tab, setTab] = useState<"system" | "group">("system");
  const active = tab === "system" ? value.systemPrompt : value.groupPrompt;
  const setActive = (text: string) => {
    if (tab === "system") onChange({ ...value, systemPrompt: text.slice(0, MAX) });
    else onChange({ ...value, groupPrompt: text.slice(0, MAX) });
  };
  return (
    <div className="ak-panel">
      <div className="ak-panel-head">
        <h2 className="ak-panel-title">提示词</h2>
        <p className="ak-panel-desc">配置 AI 的默认系统提示词与群聊场景的群 AI 提示词，保存后对所有会话生效。</p>
      </div>
      <nav className="ak-tabs" role="tablist" aria-label="提示词类型">
        <button type="button" role="tab" aria-selected={tab === "system"} className={tab === "system" ? "active" : ""} onClick={() => setTab("system")}>系统提示词</button>
        <button type="button" role="tab" aria-selected={tab === "group"} className={tab === "group" ? "active" : ""} onClick={() => setTab("group")}>群 AI 提示词</button>
      </nav>
      <label className="ak-field">
        <span className="ak-field-label">{tab === "system" ? "系统提示词" : "群 AI 提示词"}</span>
        <textarea
          className="ak-textarea"
          value={active}
          rows={14}
          placeholder={tab === "system" ? "例如：你是一个严谨高效的 AI 助手，回答需简洁、准确……" : "例如：你是群里的 AI 助理，仅在被 @ 时回复，保持中立……"}
          onChange={(e) => setActive(e.target.value)}
          spellCheck={false}
        />
        <span className="ak-field-count">{active.length} / {MAX}</span>
      </label>
    </div>
  );
}
