"use client";

import type { AdminSettings } from "./types.ts";

interface Props {
  value: AdminSettings["compute"]["resourcePool"];
  onChange: (value: AdminSettings["compute"]["resourcePool"]) => void;
}

/** 资源池：算力总并发、可用模型清单与说明。 */
export function AdminResourcePool({ value, onChange }: Props) {
  return (
    <div className="ak-panel">
      <div className="ak-panel-head">
        <h2 className="ak-panel-title">资源池</h2>
        <p className="ak-panel-desc">配置可调度算力的总并发上限与可用模型清单，供算力调配分配使用。</p>
      </div>
      <div className="ak-form">
        <label className="ak-field">
          <span className="ak-field-label">总并发上限</span>
          <input
            className="ak-input ak-input-num"
            type="number"
            min={0}
            value={Number.isFinite(value.totalConcurrency) ? value.totalConcurrency : 0}
            onChange={(e) => onChange({ ...value, totalConcurrency: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="ak-field">
          <span className="ak-field-label">可用模型（每行一个）</span>
          <textarea
            className="ak-textarea"
            rows={8}
            value={value.models}
            placeholder={"claude-opus-4\nclaude-sonnet-4\nhy3"}
            onChange={(e) => onChange({ ...value, models: e.target.value })}
            spellCheck={false}
          />
        </label>
        <label className="ak-field">
          <span className="ak-field-label">说明</span>
          <textarea
            className="ak-textarea"
            rows={4}
            value={value.note}
            placeholder="资源池的补充说明，如计费方式、可用时段等。"
            onChange={(e) => onChange({ ...value, note: e.target.value })}
            spellCheck={false}
          />
        </label>
      </div>
    </div>
  );
}
