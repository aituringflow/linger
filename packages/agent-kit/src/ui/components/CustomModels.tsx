"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { DeleteIcon, EditIcon } from "../icons/ActionIcons.tsx";

type Model = Record<string, unknown>;
type DesktopModels = {
  list(): Promise<{ path: string; models: Model[] }>;
  save(model: Model): Promise<boolean>;
  delete(id: string): Promise<boolean>;
};
export function desktopModels(): DesktopModels | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { agentHost?: { models?: DesktopModels } }).agentHost?.models;
}

export default function CustomModels({ onClose, onCount, inline = false }: { onClose?(): void; onCount?(count: number): void; inline?: boolean }) {
  const api = desktopModels();
  const [models, setModels] = useState<Model[]>([]);
  const [file, setFile] = useState("");
  const [editing, setEditing] = useState<Model | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const notify = (count: number) => onCount?.(count);
  const refresh = async () => {
    if (!api) return;
    try {
      const result = await api.list();
      setModels(result.models); setFile(result.path); notify(result.models.length); setError("");
    } catch (cause) { setError(String(cause)); }
  };
  useEffect(() => { void refresh(); }, []);
  const field = (key: string, value: unknown) => setEditing((current) => ({ ...current, [key]: value }));
  const save = async () => {
    if (!editing || !api) return;
    setBusy(true); setError("");
    try { await api.save(editing); setEditing(null); await refresh(); window.dispatchEvent(new Event("agent-kit:models-changed")); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    if (!api || !window.confirm(`删除模型 ${id}？`)) return;
    try { await api.delete(id); await refresh(); window.dispatchEvent(new Event("agent-kit:models-changed")); } catch (cause) { setError(String(cause)); }
  };
  const input = (label: string, key: string, type = "text") => <label className="custom-model-field">
    <span>{label}</span><input type={type === "number" ? "text" : type} inputMode={type === "number" ? "numeric" : undefined} value={String(editing?.[key] ?? "")}
      onChange={(event) => field(key, type === "number" ? (event.target.value === "" ? "" : Number(event.target.value)) : event.target.value)} />
  </label>;
  // 内嵌模式（宿主设置页）不提示落盘路径；弹窗模式保留原提示。
  const introText = inline
    ? "添加后即可在对话中选择使用。"
    : `模型添加后会自动写入本地 ${file || "models.json"} 文件中。`;
  // 内嵌模式（宿主设置页）：模型列表留在设置页里（inline），
  // 但点「添加模型」/「编辑」要弹 dialog 而不是原地展开，所以编辑态同样走 backdrop 弹层。
  const isDialog = !inline || editing;
  const panel = (
    <div className={`custom-model-panel${inline && !editing ? " custom-model-panel--inline" : ""}`} role={isDialog ? "dialog" : undefined} aria-modal={isDialog ? true : undefined} aria-label="自定义模型">
      {/* 内嵌且非编辑态：标题交给外层「自定义模型」分组标题，避免重复；其余情况显示标题 + 关闭。 */}
      {(!inline || editing) && <header><strong>{editing ? "编辑模型" : "自定义模型"}</strong>{isDialog && <button type="button" onClick={() => editing ? setEditing(null) : onClose?.()} aria-label="关闭">×</button>}</header>}
      {editing ? <>
        <div className="custom-model-form">
          {input("显示名称", "name")}{input("模型名称（ID）", "id")}{input("供应商", "vendor")}
          {input("接口地址", "url")}
          <label className="custom-model-field"><span>API Key</span><input type="password" autoComplete="off" value={String(editing.apiKey ?? "")}
            placeholder={editing.hasApiKey ? "已保存密钥，留空则保持不变" : "输入 API Key"} onChange={(event) => field("apiKey", event.target.value)} /></label>
          <div className="custom-model-options">
            {([ ["supportsToolCall", "工具调用"], ["supportsImages", "图片输入"], ["supportsReasoning", "思考模式"] ] as const).map(([key, label]) =>
              <label key={key}><input type="checkbox" checked={Boolean(editing[key])} onChange={(event) => field(key, event.target.checked)} />{label}</label>)}
          </div>
          <div className="custom-model-numbers">{input("输入 Token 上限", "maxInputTokens", "number")}{input("输出 Token 上限", "maxOutputTokens", "number")}</div>
          {input("温度", "temperature", "number")}
        </div>
        {error && <p className="custom-model-error">{error}</p>}
        <footer><button type="button" onClick={() => setEditing(null)}>取消</button><button type="button" disabled={busy} onClick={() => void save()}>保存</button></footer>
      </> : <>
        <div className="custom-model-intro"><span>{introText}</span><button type="button" onClick={() => setEditing({ id: "", name: "", vendor: "自定义", url: "", apiKey: "", maxInputTokens: 0, maxOutputTokens: 0, supportsToolCall: false, supportsImages: false })}>添加模型</button></div>
        {error && <p className="custom-model-error">{error}</p>}
        <div className="custom-model-list">{models.map((model) => <div className="custom-model-item" key={String(model.id)}>
          <span className="custom-model-icon">✧</span><span className="custom-model-name">{String(model.name || model.id)}</span><span className="custom-model-vendor">{String(model.vendor || "自定义")}</span>
          <button type="button" aria-label={`编辑 ${model.id}`} title="编辑" onClick={() => setEditing({ ...model, originalId: model.id, apiKey: "" })}><EditIcon /></button>
          <button type="button" aria-label={`删除 ${model.id}`} title="删除" onClick={() => void remove(String(model.id))}><DeleteIcon /></button>
        </div>)}</div>
      </>}
    </div>
  );
  if (isDialog) {
    const backdrop = (
      <div className="custom-model-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) editing ? setEditing(null) : onClose?.(); }}>{panel}</div>
    );
    // 弹到 body 顶层：避免被设置窗（focus-mode 带 transform）的层叠上下文困住，
    // 保证 dialog 永远盖在设置窗之上、且相对视口居中而不是被压成小窗内的一块。
    return typeof document !== "undefined" ? createPortal(backdrop, document.body) : backdrop;
  }
  return panel;
}
