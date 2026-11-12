"use client";

import type { ConnectorItem } from "./types.ts";
import { genId } from "./types.ts";

interface Props {
  value: ConnectorItem[];
  onChange: (value: ConnectorItem[]) => void;
}

/** 连接器：可增删、启停的外部系统连接器（如 MCP / 三方 API）。 */
export function AdminConnectors({ value, onChange }: Props) {
  const update = (id: string, patch: Partial<ConnectorItem>) =>
    onChange(value.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const remove = (id: string) => onChange(value.filter((c) => c.id !== id));
  const add = () => onChange([...value, { id: genId("conn"), name: "", type: "", endpoint: "", enabled: true }]);

  return (
    <div className="ak-panel">
      <div className="ak-panel-head ak-panel-head--row">
        <div>
          <h2 className="ak-panel-title">连接器</h2>
          <p className="ak-panel-desc">配置 AI 可对接的外部连接器（名称 / 类型 / 接入地址），关闭后不对外暴露。</p>
        </div>
        <button type="button" className="ak-btn ak-btn-primary" onClick={add}>+ 新增连接器</button>
      </div>
      {value.length === 0 ? (
        <div className="ak-empty">暂无连接器，点击右上角「新增连接器」添加。</div>
      ) : (
        <ul className="ak-list">
          {value.map((c) => (
            <li className="ak-list-item" key={c.id}>
              <label className="ak-checkbox">
                <input type="checkbox" checked={c.enabled} onChange={(e) => update(c.id, { enabled: e.target.checked })} />
                <span>启用</span>
              </label>
              <div className="ak-list-fields">
                <input className="ak-input" value={c.name} placeholder="名称" onChange={(e) => update(c.id, { name: e.target.value })} />
                <input className="ak-input" value={c.type} placeholder="类型（如 mcp / http）" onChange={(e) => update(c.id, { type: e.target.value })} />
                <input className="ak-input ak-input-wide" value={c.endpoint} placeholder="接入地址" onChange={(e) => update(c.id, { endpoint: e.target.value })} />
              </div>
              <button type="button" className="ak-btn ak-btn-danger" onClick={() => remove(c.id)} aria-label="删除连接器">删除</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
