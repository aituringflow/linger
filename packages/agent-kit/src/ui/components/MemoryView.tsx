import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "../shared/apiFetch.ts";
import { MemoryViewGlyph01, MemoryViewGlyph02, MemoryViewGlyph03, MemoryViewGlyph04 } from "../icons/PageIcons.tsx";

type Memory = { id: string; content: string; category: string; fileIds: string[]; files?: Array<{ id: string; name: string }> };
type FileItem = { id: string; name: string };
const kinds = [["preference", "偏好"], ["fact", "事实"], ["instruction", "指示"], ["resource", "资料"]] as const;

function Icon({ name }: { name: "close" | "edit" | "delete" }) {
  if (name === "close") return <MemoryViewGlyph01 />;
  if (name === "edit") return <MemoryViewGlyph02 />;
  return <MemoryViewGlyph03 />;
}

function SelectField({ children }: { children: ReactNode }) {
  return <span className="chat-memory-select-wrap">{children}<MemoryViewGlyph04 /></span>;
}

export default function MemoryView({ basePath, onClose }: { basePath: string; onClose: () => void }) {
  const [items, setItems] = useState<Memory[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [files, setFiles] = useState<FileItem[]>([]);
  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState("fact");
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [memoryPublic, setMemoryPublic] = useState(true);

  async function reload() {
    const response = await apiFetch(`${basePath}/api/memories`, { cache: "no-store" });
    if (!response.ok) throw new Error("加载记忆失败");
    const data = await response.json() as { memories?: Memory[]; count?: number };
    const memories = data.memories ?? [];
    setItems(memories);
    const count = data.count ?? memories.length;
    setTotalCount(count);
  }
  useEffect(() => {
    let cancelled = false;
    void reload().catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    void apiFetch(`${basePath}/api/files`, { cache: "no-store" }).then((r) => r.json()).then((data: { files?: FileItem[] }) => { if (!cancelled) setFiles(data.files ?? []); }).catch(() => {});
    void apiFetch(`${basePath}/api/memories/visibility`, { cache: "no-store" }).then((r) => r.json()).then((data: { public?: boolean }) => { if (!cancelled) setMemoryPublic(data.public !== false); }).catch(() => {});
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => { cancelled = true; document.removeEventListener("keydown", onKeyDown); };
  }, [basePath]);

  function resetForm() { setDraft(""); setFileIds([]); setCategory("fact"); setEditing(null); setFormOpen(false); }
  function startEdit(item: Memory) { setEditing(item.id); setDraft(item.content); setCategory(item.category); setFileIds(item.fileIds); setFormOpen(false); }
  async function save() {
    if (!draft.trim()) return;
    setBusy(true); setError("");
    try {
      const response = await apiFetch(`${basePath}/api/memories`, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(editing ? { id: editing } : {}), content: draft.trim(), category, fileIds }) });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "保存失败");
      resetForm(); await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("删除这条记忆？")) return;
    setError("");
    try {
      const response = await apiFetch(`${basePath}/api/memories?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("删除失败");
      if (editing === id) resetForm();
      await reload();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  return <div className="chat-memory-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="chat-memory-dialog" role="dialog" aria-modal="true" aria-label="记忆管理" onMouseDown={(event) => event.stopPropagation()}>
      <header className="chat-memory-dialog-head"><div><strong>记忆管理</strong>{!loading && totalCount > 0 ? <span>{totalCount} 条</span> : null}</div>
        <button type="button" className="chat-memory-icon-btn" onClick={onClose} aria-label="关闭"><Icon name="close" /></button>
      </header>
      <div className={`chat-memory-dialog-body${loading ? " is-loading" : ""}`}>
        {loading ? <div className="chat-memory-loading" role="status" aria-label="加载中"><span /></div> : <>
        <div className="chat-memory-toolbar"><p>仅保存你明确要求记住的信息。</p><button type="button" className="chat-memory-add" onClick={() => { resetForm(); setFormOpen(true); }}>添加记忆</button></div>
        <label className="chat-memory-visibility"><input type="checkbox" checked={memoryPublic} onChange={async event => {
          const next = event.target.checked;
          setMemoryPublic(next);
          try {
            const response = await apiFetch(`${basePath}/api/memories/visibility`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ public: next }) });
            if (!response.ok) throw new Error("保存公开设置失败");
          } catch (error) { setMemoryPublic(!next); setError(error instanceof Error ? error.message : String(error)); }
        }} />在群聊中向 Agent 公开我的记忆</label>
        {error ? <div className="chat-loading-error" role="alert">{error}</div> : null}
        {formOpen ? <form className="chat-memory-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} placeholder="输入一条希望长期记住的信息" aria-label="记忆内容" autoFocus />
          <div className="chat-memory-form-options"><SelectField><select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="记忆分类">{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></SelectField>
            <SelectField><select value="" onChange={(e) => { if (e.target.value) setFileIds((current) => [...new Set([...current, e.target.value])]); }} aria-label="关联文件">
              <option value="">关联文件（可选）</option>{files.filter((file) => !fileIds.includes(file.id)).map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}
            </select></SelectField></div>
          {fileIds.length ? <div className="chat-memory-file-chips">{fileIds.map((id) => <button key={id} type="button" onClick={() => setFileIds((current) => current.filter((fileId) => fileId !== id))}>{files.find((file) => file.id === id)?.name ?? id.slice(0, 8)} <span aria-hidden="true">×</span></button>)}</div> : null}
          <div className="chat-memory-form-actions"><button type="button" onClick={resetForm}>取消</button><button type="submit" disabled={busy || !draft.trim()}>{busy ? "保存中…" : "保存记忆"}</button></div>
        </form> : null}
        {items.length === 0 ? <div className="chat-memory-empty">暂无记忆</div> : <div className="chat-memory-list">{items.map((item) => <article className="chat-memory-item" key={item.id}>
          {editing === item.id ? <form className="chat-memory-inline-edit" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className="chat-memory-inline-row"><SelectField><select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="记忆分类">{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></SelectField>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={1000} aria-label="记忆内容" autoFocus /></div>
            <div className="chat-memory-form-options"><SelectField><select value="" onChange={(e) => { if (e.target.value) setFileIds((current) => [...new Set([...current, e.target.value])]); }} aria-label="关联文件"><option value="">关联文件</option>{files.filter((file) => !fileIds.includes(file.id)).map((file) => <option key={file.id} value={file.id}>{file.name}</option>)}</select></SelectField></div>
            {fileIds.length ? <div className="chat-memory-file-chips">{fileIds.map((id) => <button key={id} type="button" onClick={() => setFileIds((current) => current.filter((fileId) => fileId !== id))}>{files.find((file) => file.id === id)?.name ?? id.slice(0, 8)} <span aria-hidden="true">×</span></button>)}</div> : null}
            <div className="chat-memory-form-actions"><button type="button" onClick={resetForm}>取消</button><button type="submit" disabled={busy || !draft.trim()}>{busy ? "保存中…" : "保存"}</button></div>
          </form> : <>
            <div className="chat-memory-item-main"><span className="chat-memory-category">{kinds.find(([key]) => key === item.category)?.[1] ?? item.category}</span><p>{item.content}</p></div>
            <div className="chat-memory-item-actions"><button type="button" className="chat-memory-icon-btn" onClick={() => startEdit(item)} aria-label="编辑记忆" title="编辑"><Icon name="edit" /></button>
              <button type="button" className="chat-memory-icon-btn chat-memory-delete" onClick={() => void remove(item.id)} aria-label="删除记忆" title="删除"><Icon name="delete" /></button></div>
            {item.fileIds.length ? <div className="chat-memory-item-files">{item.fileIds.map((id) => <a key={id} href={`${basePath}/api/memories/file?memoryId=${encodeURIComponent(item.id)}&fileId=${encodeURIComponent(id)}`} target="_blank" rel="noreferrer">{item.files?.find((file) => file.id === id)?.name ?? files.find((file) => file.id === id)?.name ?? id.slice(0, 8)}</a>)}</div> : null}
          </>}
        </article>)}</div>}
        </>}
      </div>
    </section>
  </div>;
}
