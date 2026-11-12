"use client";

import type { SkillItem } from "./types.ts";
import { genId } from "./types.ts";

interface Props {
  value: SkillItem[];
  onChange: (value: SkillItem[]) => void;
}

/** 技能：可增删、启停的技能列表。 */
export function AdminSkills({ value, onChange }: Props) {
  const update = (id: string, patch: Partial<SkillItem>) =>
    onChange(value.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const remove = (id: string) => onChange(value.filter((s) => s.id !== id));
  const add = () => onChange([...value, { id: genId("skill"), name: "", description: "", enabled: true }]);

  return (
    <div className="ak-panel">
      <div className="ak-panel-head ak-panel-head--row">
        <div>
          <h2 className="ak-panel-title">技能</h2>
          <p className="ak-panel-desc">启用或配置 AI 可调用的技能（工具 / 能力），关闭后本轮会话不再自动调用。</p>
        </div>
        <button type="button" className="ak-btn ak-btn-primary" onClick={add}>+ 新增技能</button>
      </div>
      {value.length === 0 ? (
        <div className="ak-empty">暂无技能，点击右上角「新增技能」添加。</div>
      ) : (
        <ul className="ak-list">
          {value.map((s) => (
            <li className="ak-list-item" key={s.id}>
              <label className="ak-checkbox">
                <input type="checkbox" checked={s.enabled} onChange={(e) => update(s.id, { enabled: e.target.checked })} />
                <span>启用</span>
              </label>
              <div className="ak-list-fields">
                <input className="ak-input" value={s.name} placeholder="技能名称" onChange={(e) => update(s.id, { name: e.target.value })} />
                <input className="ak-input ak-input-wide" value={s.description} placeholder="技能描述" onChange={(e) => update(s.id, { description: e.target.value })} />
              </div>
              <button type="button" className="ak-btn ak-btn-danger" onClick={() => remove(s.id)} aria-label="删除技能">删除</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
