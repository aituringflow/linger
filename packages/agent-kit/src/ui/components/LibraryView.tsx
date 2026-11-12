"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useClickOutside } from "../useClickOutside.ts";
import { CloseIcon } from "../icons/SharedIcons.tsx";
import { apiFetch } from "../shared/apiFetch.ts";
import type { SessionItem } from "../AgentWindow.tsx";
import { FilePreviewContent } from "../panel/OperationPanel.tsx";
import { localFilesApi, type LocalReference } from "../shared/localFiles.ts";
import { LibraryViewGlyph01, LibraryViewGlyph02, LibraryViewGlyph03, LibraryViewGlyph04 } from "../icons/PageIcons.tsx";

export type LibraryFile = { id: string; name: string; kind: "input" | "output" | "userfile"; mime: string | null; size: number; sessionId: string | null; sessionExists: boolean; folder: string | null };
type View = "input" | "output" | "sessions" | "userfile" | "local";

export default function LibraryView({ basePath, sessions, onOpenSession, onStartConversation, onStartLocalReference }: {
  basePath: string; sessions: SessionItem[]; onOpenSession: (sid: string) => void; onStartConversation: (file: LibraryFile) => void; onStartLocalReference?: (file: LocalReference) => void;
}) {
  const localFiles = localFilesApi();
  const [files, setFiles] = useState<LibraryFile[]>([]);
  const [localRefs, setLocalRefs] = useState<LocalReference[]>([]);
  const [localProgress, setLocalProgress] = useState<{ id: string; current: number; total: number } | null>(null);
  const [localUploadingId, setLocalUploadingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [view, setView] = useState<View>("sessions");
  const [searchOpen, setSearchOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<LibraryFile | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [renameTarget, setRenameTarget] = useState<LibraryFile | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    const url = `${basePath}/api/files${searchTerm ? `?q=${encodeURIComponent(searchTerm)}` : ""}`;
    void apiFetch(url, { cache: "no-store", signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
      .then((data) => { if (!controller.signal.aborted) setFiles(Array.isArray(data.files) ? data.files : []); })
      .catch(() => { if (!controller.signal.aborted) setError("文件加载失败，请重试"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [basePath, revision, searchTerm]);
  useEffect(() => { if (localFiles && view === "local") void localFiles.list().then(setLocalRefs); }, [revision, view]);
  useEffect(() => localFiles?.onUploadProgress(setLocalProgress), []);
  useEffect(() => { folderInputRef.current?.setAttribute("webkitdirectory", ""); }, [view]);
  useEffect(() => { setSelected(new Set()); }, [query]);
  // 资料库条目菜单：点击菜单/⋯ 之外任意处或 Esc 关闭
  useClickOutside({
    enabled: openMenuId !== null,
    exceptSelectors: [".chat-library-menu"],
    onDismiss: () => setOpenMenuId(null),
  });

  const titles = useMemo(() => new Map(sessions.map((session) => [session.id, session.title])), [sessions]);
  const visible = useMemo(() => files.filter((file) => (view === "sessions" ? Boolean(file.sessionId) : file.kind === view) && `${file.name} ${file.folder ?? ""} ${file.sessionId ? titles.get(file.sessionId) ?? "" : ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [files, view, query, titles]);
  const visibleLocal = useMemo(() => view === "local" ? localRefs.filter((ref) => `${ref.name} ${ref.path ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) : [], [localRefs, view, query]);
  const groups = useMemo(() => {
    const result = new Map<string, LibraryFile[]>();
    for (const file of visible) if (file.sessionId) result.set(file.sessionId, [...(result.get(file.sessionId) ?? []), file]);
    return [...result.entries()];
  }, [visible]);
  const allSelected = visible.length > 0 && visible.every((file) => selected.has(file.id));
  const selectedFiles = visible.filter((file) => selected.has(file.id));
  const allExpanded = groups.every(([sid]) => expanded[sid] ?? true);
  const allCollapsed = groups.length > 0 && groups.every(([sid]) => expanded[sid] === false);
  const fileUrl = (file: LibraryFile, download = false) => `${basePath}/api/file?fileId=${encodeURIComponent(file.id)}${download ? "&download=1" : ""}`;
  function toggleAll() { setSelected((current) => { const next = new Set(current); for (const file of visible) allSelected ? next.delete(file.id) : next.add(file.id); return next; }); }
  function toggleOne(id: string) { setSelected((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; }); }
  async function remove(file: LibraryFile) {
    if (!window.confirm(`将“${file.name}”移出资料库？`)) return;
    try {
      const response = await apiFetch(`${basePath}/api/files?fileId=${encodeURIComponent(file.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(String(response.status));
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setSelected((current) => { const next = new Set(current); next.delete(file.id); return next; });
      if (previewFile?.id === file.id) setPreviewFile(null);
    } catch { setError("移除失败，请重试"); }
  }
  async function uploadIndependent(files: File[]) {
    if (files.length === 0) return;
    setUploading(true); setError("");
    const failed: string[] = [];
    let succeeded = 0;
    for (const file of files) {
      try {
        const form = new FormData(); form.append("file", file);
        if (file.webkitRelativePath) form.append("folder", file.webkitRelativePath.split("/").slice(0, -1).join("/"));
        const response = await apiFetch(`${basePath}/api/files`, { method: "POST", body: form });
        if (!response.ok) {
          const detail = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(detail?.error || `HTTP ${response.status}`);
        }
        succeeded += 1;
      } catch (error) {
        failed.push(`${file.name}：${error instanceof Error ? error.message : "上传失败"}`);
      }
    }
    if (succeeded) setRevision((value) => value + 1);
    if (failed.length) setError(`${failed.length} 个文件上传失败：${failed.join("；")}`);
    setUploading(false);
  }
  async function uploadLocal(ref: LocalReference) {
    if (!localFiles) return;
    const summary = await localFiles.scan(ref.id);
    if (!summary || summary.error) { setError(summary?.error || "无法读取本机文件"); return; }
    const mb = ((summary.bytes ?? 0) / (1024 * 1024)).toFixed(1);
    if (!window.confirm(`将“${ref.name}”的 ${summary.count ?? 0} 个文件（${mb} MB）上传到资料库？${summary.oversized ? `\n其中 ${summary.oversized} 个文件超过 50 MB 上限，将跳过。` : ""}`)) return;
    setLocalUploadingId(ref.id); setLocalProgress(null); setError("");
    try {
      const result = await localFiles.upload(ref.id);
      if (result.failed.length) setError(`${result.failed.length} 个文件上传失败：${result.failed.slice(0, 3).join("；")}`);
      setRevision((value) => value + 1);
    } catch (error) { setError(error instanceof Error ? error.message : "上传失败"); }
    finally { setLocalUploadingId(null); setLocalProgress(null); }
  }
  async function removeLocal(ref: LocalReference) {
    if (!localFiles || !window.confirm(`移除本机引用“${ref.name}”？本机原文件不会删除。`)) return;
    await localFiles.remove(ref.id);
    setLocalRefs((current) => current.filter((item) => item.id !== ref.id));
  }
  async function renameIndependent() {
    if (!renameTarget || !renameName.trim()) return;
    setRenaming(true); setError("");
    try {
      const response = await apiFetch(`${basePath}/api/files`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId: renameTarget.id, name: renameName.trim() }) });
      if (!response.ok) throw new Error("重命名失败，请重试");
      setFiles((current) => current.map((file) => file.id === renameTarget.id ? { ...file, name: renameName.trim() } : file));
      if (previewFile?.id === renameTarget.id) setPreviewFile({ ...previewFile, name: renameName.trim() });
      setRenameTarget(null);
    } catch (error) { setError(error instanceof Error ? error.message : "重命名失败，请重试"); }
    finally { setRenaming(false); }
  }
  async function removeSelected() {
    if (selectedFiles.length === 0 || !window.confirm(`将选中的 ${selectedFiles.length} 个文件移出资料库？`)) return;
    setBulkBusy(true); setError("");
    try {
      const response = await apiFetch(`${basePath}/api/files`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileIds: selectedFiles.map((file) => file.id) }) });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as { deletedIds?: string[] };
      const deleted = new Set(data.deletedIds ?? []);
      setFiles((current) => current.filter((file) => !deleted.has(file.id)));
      setSelected((current) => new Set([...current].filter((id) => !deleted.has(id))));
      if (previewFile && deleted.has(previewFile.id)) setPreviewFile(null);
      if (deleted.size !== selectedFiles.length) setError("部分文件未能移出，请刷新后重试");
      else setSelectionMode(false);
    } catch { setError("批量移除失败，请重试"); }
    finally { setBulkBusy(false); }
  }
  function renderFile(file: LibraryFile) {
    return <div className={`chat-library-row${previewFile?.id === file.id ? " is-active" : ""}`} key={file.id}>
      {selectionMode ? <input type="checkbox" checked={selected.has(file.id)} onChange={() => toggleOne(file.id)} aria-label={`选择 ${file.name}`} /> : null}
      <button type="button" className="chat-library-row-main" onClick={() => { if (selectionMode) toggleOne(file.id); else { setPreviewFile(file); setPreviewOpen(true); } }} title={selectionMode ? `选择 ${file.name}` : `预览 ${file.name}`}><span className="chat-library-row-name">{file.folder ? `${file.folder}/` : ""}{file.name}</span><span className="chat-library-row-detail">{file.kind === "input" ? "输入" : file.kind === "output" ? "输出" : "独立文件"} · {Math.ceil(file.size / 1024)} KB{file.sessionId ? ` · ${titles.get(file.sessionId) || (file.sessionExists ? "关联会话" : "会话已删除")}` : ""}</span></button>
      {!selectionMode ? <details className="chat-library-menu" open={openMenuId === file.id}><summary aria-label={`${file.name} 的操作`} title="文件操作" onClick={(event) => { event.preventDefault(); setOpenMenuId((current) => current === file.id ? null : file.id); }}>⋯</summary><div className="chat-library-menu-popover">
        <button type="button" onClick={() => { setOpenMenuId(null); onStartConversation(file); }}>开始新对话</button>
        {file.kind === "userfile" ? <button type="button" onClick={() => { setOpenMenuId(null); setRenameTarget(file); setRenameName(file.name); }}>重命名</button> : null}
        {file.sessionId && file.sessionExists ? <button type="button" onClick={() => { setOpenMenuId(null); onOpenSession(file.sessionId!); }}>前往会话</button> : null}
        <a href={fileUrl(file, true)} onClick={() => setOpenMenuId(null)}>下载</a><button type="button" onClick={() => { setOpenMenuId(null); void remove(file); }}>移出资料库</button>
      </div></details> : null}
    </div>;
  }

  return <main className="chat-library-main">
    {renameTarget ? <div className="chat-modal-backdrop" onClick={() => { if (!renaming) setRenameTarget(null); }}><form className="chat-modal" role="dialog" aria-modal="true" aria-label="重命名文件" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void renameIndependent(); }}><h3 className="chat-modal-title">重命名文件</h3><input className="chat-library-rename-input" autoFocus value={renameName} onChange={(event) => setRenameName(event.target.value)} maxLength={512} aria-label="新文件名" /><div className="chat-modal-actions"><button type="button" className="chat-modal-btn" onClick={() => setRenameTarget(null)} disabled={renaming}>取消</button><button type="submit" className="chat-modal-btn" disabled={renaming || !renameName.trim()}>{renaming ? "保存中…" : "保存"}</button></div></form></div> : null}
    <div className="chat-library-center">
    <header className="chat-topbar"><div className="chat-topbar-left"><span className="chat-title chat-title--left">资料库</span></div>
      <div className="chat-topbar-right"><button type="button" className={`chat-topbar-btn${searchOpen ? " is-active" : ""}`} onClick={() => { setSearchOpen((open) => !open); setQuery(""); }} aria-label="搜索文件" title="搜索文件"><LibraryViewGlyph01 /></button><button type="button" className="chat-topbar-btn" onClick={() => setRevision((value) => value + 1)} aria-label="刷新文件" title="刷新文件"><LibraryViewGlyph02 /></button></div></header>
    <div className={`chat-library-content${view === "userfile" && fileDragOver ? " is-file-drag-over" : ""}`}
      data-file-drop-target={view === "userfile" && !uploading && !selectionMode ? "" : undefined}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        if (view !== "userfile" || uploading || selectionMode) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setFileDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileDragOver(false);
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setFileDragOver(false);
        if (view !== "userfile" || uploading || selectionMode) return;
        if (Array.from(event.dataTransfer.items).some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
          setError("拖放暂不支持文件夹，请使用“上传文件夹”按钮");
          return;
        }
        void uploadIndependent(Array.from(event.dataTransfer.files));
      }}>
      {view === "userfile" && fileDragOver ? <div className="chat-drop-overlay"><div className="chat-drop-box">松开上传到独立文件</div></div> : null}
      {searchOpen ? <div className="chat-library-search-row"><input ref={searchInputRef} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setSearchOpen(false); setQuery(""); } }} placeholder="搜索文件名或文件夹" aria-label="搜索文件名或文件夹" />{query ? <button type="button" onClick={() => { setQuery(""); searchInputRef.current?.focus(); }} aria-label="清空搜索" title="清空搜索"><CloseIcon /></button> : null}</div> : null}
      <nav className="chat-library-tabs" aria-label="资料库分类">{([ ["sessions", "按对话"], ["userfile", "独立文件"], ["output", "输出产物"], ["input", "输入附件"], ...(localFiles ? [["local", "本机引用"]] : []) ] as Array<[View, string]>).map(([key, label]) => <button key={key} type="button" className={view === key ? "is-active" : ""} disabled={bulkBusy} onClick={() => { setView(key); setSelectionMode(false); setSelected(new Set()); }}>{label}</button>)}</nav>
      <>
      <div className="chat-library-tools">
        {view === "userfile" && !selectionMode ? <><input ref={uploadInputRef} className="chat-library-upload-input" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void uploadIndependent(files); }} /><button type="button" className="chat-library-select-toggle" disabled={uploading} onClick={() => uploadInputRef.current?.click()}>{uploading ? "上传中…" : "上传文件"}</button>{localFiles ? <><input ref={folderInputRef} className="chat-library-upload-input" type="file" multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void uploadIndependent(files); }} /><button type="button" className="chat-library-select-toggle" disabled={uploading} onClick={() => folderInputRef.current?.click()}>上传文件夹</button></> : null}</> : null}
        {view === "sessions" ? <div className="chat-library-expand-actions" role="group" aria-label="对话文件展开状态"><button type="button" className={allExpanded ? "is-active" : ""} aria-pressed={allExpanded} onClick={() => setExpanded(Object.fromEntries(groups.map(([sid]) => [sid, true])))}>全部展开</button><button type="button" className={allCollapsed ? "is-active" : ""} aria-pressed={allCollapsed} onClick={() => setExpanded(Object.fromEntries(groups.map(([sid]) => [sid, false])))}>全部折叠</button></div> : null}
        <div className="chat-library-selection-actions">
          {selectionMode ? <><button type="button" className="chat-library-remove-selected" style={{ visibility: selectedFiles.length > 0 ? "visible" : "hidden" }} disabled={bulkBusy || selectedFiles.length === 0} onClick={() => void removeSelected()}><LibraryViewGlyph03 />{bulkBusy ? "正在移出…" : "移除选中文件"}</button><label><input type="checkbox" checked={allSelected} disabled={visible.length === 0 || bulkBusy} onChange={toggleAll} /> 全选</label><span className="chat-library-selected-count">已选 {selectedFiles.length}</span></> : null}
          {view !== "local" ? <button type="button" className="chat-library-select-toggle" aria-pressed={selectionMode} disabled={bulkBusy} onClick={() => { setSelectionMode((mode) => !mode); setSelected(new Set()); }}>{selectionMode ? "取消选择" : "选择"}</button> : null}
        </div>
      </div>
      {error ? <div className="chat-loading-error" role="alert">{error}<button type="button" onClick={() => setRevision((value) => value + 1)}>重试</button></div> : null}
      {!loading && !error && (view === "local" ? visibleLocal.length === 0 : visible.length === 0) ? <div className="chat-library-empty">暂无文件</div> : null}
      {view === "sessions" ? <div className="chat-library-tree">{groups.map(([sid, group]) => { const open = expanded[sid] ?? true; return <section className="chat-library-session" key={sid}><div className="chat-library-session-head"><button type="button" className="chat-library-session-toggle" onClick={() => setExpanded((current) => ({ ...current, [sid]: !open }))} aria-expanded={open}><span className={`chat-library-chevron${open ? " is-open" : ""}`}>›</span><span className="chat-library-session-title">{titles.get(sid) || (group[0].sessionExists ? sid : "已删除的对话")}</span><span className="chat-library-session-count">{group.length}</span></button>{group[0].sessionExists ? <button type="button" className="chat-library-session-open" onClick={() => onOpenSession(sid)}>前往会话</button> : null}</div>{open ? <div className="chat-library-tree-files">{group.map(renderFile)}</div> : null}</section>; })}</div> : view === "local" ? <div className="chat-library-list">{visibleLocal.map((ref) => <div className="chat-library-row" key={ref.id}><button type="button" className="chat-library-row-main" onClick={() => onStartLocalReference?.(ref)} disabled={ref.available === false}><span className="chat-library-row-name">{ref.name}</span><span className="chat-library-row-detail">{ref.kind === "folder" ? "本机文件夹" : "本机文件"}{ref.available === false ? " · 此设备不可用" : ""}{ref.sourceFileId ? " · 已从资料库下载" : ""}</span></button><div className="chat-library-local-actions"><button type="button" disabled={ref.available === false || localUploadingId !== null} onClick={() => void uploadLocal(ref)}>{localUploadingId === ref.id ? `上传中 ${localProgress?.current ?? 0}/${localProgress?.total ?? 0}` : "上传到资料库"}</button><button type="button" onClick={() => void removeLocal(ref)}>移除引用</button></div></div>)}</div> : <div className="chat-library-list">{visible.map(renderFile)}</div>}
      <div className="chat-library-footer">{loading ? "正在加载…" : `共 ${view === "local" ? visibleLocal.length : visible.length} 个文件`}</div></>
    </div></div>{previewOpen ? <aside className="chat-library-preview"><div className="chat-library-preview-head"><strong>文件预览</strong><div className="chat-library-preview-actions">{previewFile ? <a className="artifact-menu-dl" href={fileUrl(previewFile, true)} title="下载" aria-label={`下载 ${previewFile.name}`}><LibraryViewGlyph04 /></a> : null}<button type="button" className="artifact-drawer-close" onClick={() => setPreviewOpen(false)} aria-label="关闭预览"><CloseIcon /></button></div></div>{previewFile ? <><div className="chat-library-preview-name">{previewFile.name}</div><div className="chat-library-preview-media chat-right-preview-frame"><FilePreviewContent url={fileUrl(previewFile)} name={previewFile.name} /></div></> : <div className="chat-library-preview-empty">选择一个文件进行预览</div>}</aside> : null}
  </main>;
}
