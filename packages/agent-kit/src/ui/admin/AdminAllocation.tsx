"use client";

import type { AdminSettings } from "./types.ts";

interface Props {
  value: AdminSettings["compute"]["allocation"];
  onChange: (value: AdminSettings["compute"]["allocation"]) => void;
}

const STRATEGIES: { value: AdminSettings["compute"]["allocation"]["strategy"]; label: string }[] = [
  { value: "fair", label: "公平调度（按到达顺序均分）" },
  { value: "priority", label: "优先级调度（高优先级优先）" },
  { value: "fixed", label: "固定配额（按用户分配固定额度）" },
];

/** 算力调配：分配策略、单用户配额、突发与说明。 */
export function AdminAllocation({ value, onChange }: Props) {
  return (
    <div className="ak-panel">
      <div className="ak-panel-head">
        <h2 className="ak-panel-title">算力调配</h2>
        <p className="ak-panel-desc">配置算力分配策略与单用户配额，控制资源池的调度方式。</p>
      </div>
      <div className="ak-form">
        <label className="ak-field">
          <span className="ak-field-label">分配策略</span>
          <select
            className="ak-select"
            value={value.strategy}
            onChange={(e) => onChange({ ...value, strategy: e.target.value as AdminSettings["compute"]["allocation"]["strategy"] })}
          >
            {STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="ak-field">
          <span className="ak-field-label">单用户配额（并发）</span>
          <input
            className="ak-input ak-input-num"
            type="number"
            min={0}
            value={Number.isFinite(value.perUserQuota) ? value.perUserQuota : 0}
            onChange={(e) => onChange({ ...value, perUserQuota: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </label>
        <label className="ak-checkbox ak-checkbox--block">
          <input type="checkbox" checked={value.burst} onChange={(e) => onChange({ ...value, burst: e.target.checked })} />
          <span>允许突发（配额用尽时短暂借用空闲算力）</span>
        </label>
        <label className="ak-field">
          <span className="ak-field-label">说明</span>
          <textarea
            className="ak-textarea"
            rows={4}
            value={value.note}
            placeholder="算力调配的补充说明。"
            onChange={(e) => onChange({ ...value, note: e.target.value })}
            spellCheck={false}
          />
        </label>
      </div>
    </div>
  );
}
