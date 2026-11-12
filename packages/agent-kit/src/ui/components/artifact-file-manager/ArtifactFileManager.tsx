"use client";

import { useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useClickOutside } from "../../useClickOutside.ts";
import type { ArtifactMeta } from "../../AgentWindow.tsx";
import { ArtifactIcon, FilePreviewContent, formatFileSize, formatArtifactMtime } from "../../panel/OperationPanel.tsx";
import { ChatPanelGlyph04, OperationPanelGlyph08, OperationPanelGlyph10, OperationPanelGlyph11, OperationPanelGlyph12 } from "../../icons/PageIcons.tsx";
import { NewFolderIcon } from "../../icons/SharedIcons.tsx";
import { ThinkingChevronIcon } from "../../icons/DynamicIcons.tsx";
import { LoadingState } from "../LoadingState.tsx";
import { ARTIFACT_FILE_MIME, type ArtifactFileDragItem } from "../../shared/artifactFileDrag.ts";

/**
 * 产物「文件管理器」：目录导航（面包屑 + 返回）、当前目录文件/文件夹清单；桌面文件在顶部标签预览。
 * 从 OperationPanel 抽出，状态（当前目录 / 原地预览 / 行内菜单 / 重命名 / 删除确认）全部自管理。
 */

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 0 1 15.36-6.36L21 8" />
      <path d="M21 2v6h-6" />
      <path d="M21 12a9 9 0 0 1-15.36 6.36L3 16" />
      <path d="M3 22v-6h6" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg className="afm-folder-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2.1 2.2h6.9A2.5 2.5 0 0 1 21 9.7v8.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5z" />
      <path d="M3 9.7h18" />
    </svg>
  );
}

function ViewIcon({ mode }: { mode: "icons" | "list" | "columns" }) {
  if (mode === "icons") return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2.5" y="2.5" width="8" height="8" rx="1.5" /><rect x="13.5" y="2.5" width="8" height="8" rx="1.5" /><rect x="2.5" y="13.5" width="8" height="8" rx="1.5" /><rect x="13.5" y="13.5" width="8" height="8" rx="1.5" /></svg>;
  if (mode === "list") return <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="3.5" cy="5" r="1.5" /><circle cx="3.5" cy="12" r="1.5" /><circle cx="3.5" cy="19" r="1.5" /><rect x="8" y="3.8" width="14" height="2.4" rx="1.2" /><rect x="8" y="10.8" width="14" height="2.4" rx="1.2" /><rect x="8" y="17.8" width="14" height="2.4" rx="1.2" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="2.5" width="20" height="19" rx="2" /><path d="M9 3v18M15.5 3v18" /></svg>;
}

function ZipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v10m0 0 4-4m-4 4-4-4" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z" />
      <path d="M13.5 6.5l3 3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 1.8h6a2 2 0 0 0 2-1.8l1-12" />
      <path d="M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2" />
    </svg>
  );
}

interface MenuTarget {
  kind: "file" | "folder";
  rel: string;
  name: string;
  isDir: boolean;
  rect: DOMRect;
}

interface EditTarget {
  rel: string;
  name: string;
  isDir: boolean;
}

export type FileView = "icons" | "list" | "columns";

/**
 * 文件被拖出到组件外部时携带的自定义 MIME。
 *
 * 组件内部拖拽的语义是「在本目录间移动文件」（靠 text/plain + 组件内 ref），
 * 外部 drop 区拿不到组件状态，所以额外写一份结构化数据：
 * 外部只要读这个 MIME 就能知道被拖的是哪些文件（rel / 名称 / 大小 / 是否文件夹）。
 *
 * 定义放在 shared/artifactFileDrag.ts，输入框等只需要"识别载荷"的轻量组件直接引用，
 * 不必把整个 FileManager 拉进模块图。
 */
export { ARTIFACT_FILE_MIME };
export type { ArtifactFileDragItem };

function directoryPrefixes(dir: string): string[] {
  const parts = dir.split("/").filter(Boolean);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}
function savedFileView(sessionId?: string, fallback: FileView = "list"): FileView {
  if (!sessionId || typeof window === "undefined") return fallback;
  try {
    const value = window.localStorage.getItem(`artifact-file-view:${sessionId}`);
    return value === "icons" || value === "columns" || value === "list" ? value : fallback;
  } catch { return fallback; }
}
function savedHiddenPreference(sessionId?: string): boolean {
  if (!sessionId || typeof window === "undefined") return false;
  try { return window.localStorage.getItem(`artifact-show-hidden:${sessionId}`) === "1"; }
  catch { return false; }
}

export interface ArtifactFileManagerProps {
  artifacts: ArtifactMeta[];
  /** 列表是否正在加载（未拿到清单） */
  loading: boolean;
  /** 列表加载失败 */
  error: boolean;
  onRetry: () => Promise<void>;
  /** 刷新当前目录（重新拉取清单） */
  onRefresh: () => Promise<void>;
  /** 产物文件 URL 构造：file=id */
  buildUrl: (id: string) => string;
  previewFull: boolean;
  onToggleFullscreen: () => void;
  desktopApp: boolean;
  /** 桌面壳：打开文件所在目录 */
  onOpenDir: (dir: string) => void;
  /** 分享产物；宿主不提供时不显示「分享」入口（本机目录管理器用不着） */
  onShareArtifact?: (meta: ArtifactMeta) => void;
  /** 下载文件夹压缩包 */
  onZipFolder: (rel: string) => void;
  /** 重命名：返回是否成功 */
  onRenameArtifact: (rel: string, newName: string, isDir: boolean) => Promise<boolean>;
  onMoveArtifact: (rel: string, destination: string, isDir: boolean) => Promise<boolean>;
  /** 删除：返回是否成功 */
  onDeleteArtifact: (rel: string, isDir: boolean) => Promise<boolean>;
  /** 新建文件夹：返回 ok=创建成功 / exists=同名已存在 / error=其他失败 */
  onCreateFolder: (rel: string, name: string) => Promise<"ok" | "exists" | "error">;
  /** 会话 id：本地登记的新建空文件夹按「会话::目录」作用域隔离，避免切换会话时串名单 */
  sessionId?: string;
  initialDir?: string;
  onDirectoryChange?: (dir: string) => void;
  /** 没有持久化视图偏好时的初始视图（会话里默认列表；桌面组件更合适图标/分栏） */
  defaultView?: FileView;
  /**
   * 列表视图展开某个文件夹时回调：宿主按目录懒加载时据此补数据。
   * （图标/分栏视图进目录已经走 onDirectoryChange，只有列表视图的展开不会改 fileDir。）
   */
  onExpandDir?: (dir: string) => void;
  /** 移动端：进入文件预览页 */
  onMobilePreview?: (id: string) => void;
  /** 桌面端：在顶部标签打开文件 */
  onOpenFile?: (meta: ArtifactMeta) => void;
  mobilePage?: string | null;
  /**
   * 隐藏浏览态顶部工具栏：视图切换 / 新建文件夹 / 刷新都改由右键菜单承担
   * （桌面小组件空间小，工具栏会挤掉文件列表）。
   */
  hideToolbar?: boolean;
  /** 是否允许「新建文件夹」；宿主不支持建目录时传 false（工具栏与右键菜单都不出现）。 */
  allowCreateFolder?: boolean;
  /** 显示模式变化回调：宿主据此持久化用户选的视图。 */
  onViewChange?: (view: FileView) => void;
}

export default function ArtifactFileManager(props: ArtifactFileManagerProps) {
  const {
    artifacts, loading, error, onRetry, onRefresh, buildUrl,
    previewFull, onToggleFullscreen, desktopApp, onOpenDir, onShareArtifact,
    onZipFolder, onRenameArtifact, onMoveArtifact, onDeleteArtifact, onCreateFolder, sessionId,
    onMobilePreview, onOpenFile, mobilePage, initialDir, onDirectoryChange, defaultView, onExpandDir,
    hideToolbar = false, allowCreateFolder = true, onViewChange,
  } = props;

  // 当前所在子目录（相对产物根，"" = 根）；切会话由父级卸载/重置
  const [fileDir, setFileDir] = useState(initialDir ?? "");
  useEffect(() => { onDirectoryChange?.(fileDir); }, [fileDir]);
  // 原地预览的文件（不新增顶部 tab）
  const [preview, setPreview] = useState<ArtifactMeta | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // 行内「⋯」菜单
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 重命名 / 删除确认
  const [renameTarget, setRenameTarget] = useState<EditTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<EditTarget | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // 新建文件夹弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createValue, setCreateValue] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState("");
  // 本组件内新建的空文件夹（键 = 会话::目录）：服务端扁平清单不含空目录，
  // 本地登记保证新建后（含刷新、进出目录）仍然可见，直到其中出现文件（届时由清单自动呈现）
  const [createdDirs, setCreatedDirs] = useState<Record<string, Array<{ name: string; at: number }>>>({});
  const [view, setView] = useState<FileView>(() => savedFileView(sessionId, defaultView));
  useEffect(() => { setView(savedFileView(sessionId, defaultView)); }, [sessionId, defaultView]);
  const [showHidden, setShowHidden] = useState(() => savedHiddenPreference(sessionId));
  useEffect(() => { setShowHidden(savedHiddenPreference(sessionId)); }, [sessionId]);
  useEffect(() => { if (view === "list") setFileDir(""); }, [view]);
  const [expandedDirs, setExpandedDirs] = useState<string[]>([]);
  useEffect(() => { setExpandedDirs([]); }, [sessionId]);
  const [columnPath, setColumnPath] = useState<string[]>(() => directoryPrefixes(initialDir ?? ""));
  const [focusColumn, setFocusColumn] = useState(Math.max(0, directoryPrefixes(initialDir ?? "").length - 1));
  const columnsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const path = directoryPrefixes(initialDir ?? ""); setColumnPath(path); setFocusColumn(Math.max(0, path.length - 1)); }, [sessionId]);
  useLayoutEffect(() => {
    if (view !== "columns") return;
    const scroller = columnsRef.current;
    const pane = scroller?.querySelectorAll<HTMLElement>(".afm-column-pane")[focusColumn];
    if (!scroller || !pane) return;
    const left = pane.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    scroller.scrollTo({ left: Math.max(0, left - (scroller.clientWidth - pane.clientWidth) / 2), behavior: "smooth" });
  }, [view, columnPath, focusColumn]);
  const changeView = (mode: FileView) => {
    setView(mode);
    if (sessionId) try { window.localStorage.setItem(`artifact-file-view:${sessionId}`, mode); } catch { /* storage unavailable */ }
    onViewChange?.(mode);
  };
  const [sort, setSort] = useState<"name" | "type" | "size" | "modified">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const changeSort = (field: "name" | "type" | "size" | "modified") => {
    if (sort === field) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setSort(field); setSortDirection(field === "name" || field === "type" ? "asc" : "desc"); }
  };
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [menuMode, setMenuMode] = useState<"blank" | "items" | null>(null);
  const [contextDir, setContextDir] = useState("");
  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null);
  // 「显示模式」二级菜单：独立 portal 渲染（父菜单 overflow 会裁掉嵌套浮层）
  const [viewSubmenuOpen, setViewSubmenuOpen] = useState(false);
  const [viewSubmenuPoint, setViewSubmenuPoint] = useState<{ x: number; y: number } | null>(null);
  const viewTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 父菜单关掉时二级菜单跟着关；Esc 也能单独收起二级菜单。
  useEffect(() => {
    if (menuMode) return;
    setViewSubmenuOpen(false);
    setViewSubmenuPoint(null);
  }, [menuMode]);
  useEffect(() => {
    if (!viewSubmenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setViewSubmenuOpen(false);
      setViewSubmenuPoint(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [viewSubmenuOpen]);
  const [infoOpen, setInfoOpen] = useState(false);
  const [batchDelete, setBatchDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeOperation, setActiveOperation] = useState<string | null>(null);
  const [showSlowOperation, setShowSlowOperation] = useState(false);
  const [operationError, setOperationError] = useState("");
  const operationInFlight = useRef(false);
  useEffect(() => {
    if (!activeOperation) { setShowSlowOperation(false); return; }
    const timer = window.setTimeout(() => setShowSlowOperation(true), 2000);
    return () => window.clearTimeout(timer);
  }, [activeOperation]);
  const [showSlowLoading, setShowSlowLoading] = useState(false);
  useEffect(() => {
    if (!loading) { setShowSlowLoading(false); return; }
    const timer = window.setTimeout(() => setShowSlowLoading(true), 2000);
    return () => window.clearTimeout(timer);
  }, [loading]);
  const runOperation = async <T,>(label: string, work: () => Promise<T>): Promise<T | undefined> => {
    if (operationInFlight.current) return undefined;
    operationInFlight.current = true;
    setOperationError("");
    setActiveOperation(label);
    try { return await work(); }
    catch { setOperationError("操作失败，请刷新后重试"); return undefined; }
    finally { operationInFlight.current = false; setActiveOperation(null); }
  };
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [rootDrop, setRootDrop] = useState(false);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const marqueeColumn = useRef<string | null>(null);
  const dragging = useRef<string[]>([]);
  useEffect(() => { setSelected([]); setAnchor(null); setMenuMode(null); }, [fileDir, sessionId]);

  const closeMenu = () => { setMenu(null); setMenuPos(null); };

  // 菜单定位：锚定「⋯」按钮，下方放不下则翻到上方（复用侧栏浮动菜单的翻转逻辑）
  useLayoutEffect(() => {
    if (!menu) return;
    const el = menuRef.current;
    if (!el) return;
    const place = () => {
      const margin = 8;
      const gap = 4;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const left = Math.max(margin, Math.min(menu.rect.left, window.innerWidth - width - margin));
      const below = menu.rect.bottom + gap;
      const above = menu.rect.top - height - gap;
      const top = below + height <= window.innerHeight - margin ? below : (above >= margin ? above : Math.max(margin, below));
      setMenuPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu]);

  // 点击菜单/「⋯」之外的任意区域，或按 Esc，关闭菜单
  useClickOutside({
    enabled: menu !== null,
    exceptSelectors: [".chat-sidebar-project-menu", ".artifact-list-more"],
    onDismiss: closeMenu,
  });

  const prefix = fileDir ? `${fileDir}/` : "";
  const crumbs = fileDir.split("/").filter(Boolean);

  // 产物展示用完整相对路径：优先服务端 rel（登记产物可能只有 basename），
  // 其次 name 自带路径（会话目录扫描产物），最后回退 id（会话目录内 id 即相对路径）
  const artifactPath = (a: Pick<ArtifactMeta, "rel" | "name" | "id">): string =>
    a.rel || (a.name.includes("/") ? a.name : a.id);
  const visibleArtifacts = showHidden ? artifacts : artifacts.filter((artifact) =>
    artifactPath(artifact).split("/").every((part) => !part.startsWith(".")));

  // 扁平清单 → 当前目录的子文件夹 + 文件
  const subFolders: string[] = [];
  const files: ArtifactMeta[] = [];
  // 文件夹「最新更新时间」= 其内部（含嵌套子目录）文件的最近修改时间
  const folderMtime = new Map<string, number>();
  {
    const seen = new Set<string>();
    for (const a of visibleArtifacts) {
      const rel = artifactPath(a);
      if (!rel.startsWith(prefix)) continue;
      const rest = rel.slice(prefix.length);
      // 服务端直接返回的目录条目（含空目录）：按第一段归为当前层子文件夹
      if (a.type === "dir") {
        const slash = rest.indexOf("/");
        const folder = slash >= 0 ? rest.slice(0, slash) : rest;
        if (!folder) continue;
        if (!seen.has(folder)) { seen.add(folder); subFolders.push(folder); }
        if (a.mtimeMs && a.mtimeMs > (folderMtime.get(folder) ?? 0)) folderMtime.set(folder, a.mtimeMs);
        continue;
      }
      const slash = rest.indexOf("/");
      if (slash >= 0) {
        const folder = rest.slice(0, slash);
        if (!seen.has(folder)) { seen.add(folder); subFolders.push(folder); }
        if (a.mtimeMs && a.mtimeMs > (folderMtime.get(folder) ?? 0)) folderMtime.set(folder, a.mtimeMs);
      } else {
        files.push(a);
      }
    }
  }
  subFolders.sort((x, y) => x.localeCompare(y, "zh"));
  files.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

  // 清单推导的文件夹 + 本地新建的空文件夹（合并后统一排序；新建空文件夹的时间取创建时刻）
  const createdKey = `${sessionId ?? ""}::${fileDir}`;
  const visibleFolders = subFolders.slice();
  for (const created of createdDirs[createdKey] ?? []) {
    if (!showHidden && created.name.startsWith(".")) continue;
    if (!visibleFolders.includes(created.name)) {
      visibleFolders.push(created.name);
      if (!folderMtime.has(created.name)) folderMtime.set(created.name, created.at);
    }
  }
  visibleFolders.sort((x, y) => x.localeCompare(y, "zh"));
  type Entry = { rel: string; name: string; isDir: boolean; size: number; mtime: number; type: string; meta?: ArtifactMeta; depth?: number };
  const entries: Entry[] = [
    ...visibleFolders.map((name) => ({ rel: `${prefix}${name}`, name, isDir: true, size: 0, mtime: folderMtime.get(name) ?? 0, type: "文件夹" })),
    ...files.map((meta) => ({ rel: artifactPath(meta), name: meta.name.split("/").pop() || meta.name, isDir: false, size: meta.size ?? 0, mtime: meta.mtimeMs ?? 0, type: meta.type, meta })),
  ];
  const compareEntries = (a: Entry, b: Entry) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let comparison = 0;
    if (sort === "modified") comparison = a.mtime - b.mtime;
    else if (sort === "size") comparison = a.size - b.size;
    else if (sort === "type") comparison = a.type.localeCompare(b.type, "zh");
    else comparison = a.name.localeCompare(b.name, "zh");
    return (sortDirection === "asc" ? comparison : -comparison) || a.name.localeCompare(b.name, "zh");
  };
  entries.sort(compareEntries);
  const tree = new Map<string, Entry>();
  const addFolder = (rel: string, mtime = 0) => {
    const existing = tree.get(rel);
    if (existing) { existing.mtime = Math.max(existing.mtime, mtime); return; }
    tree.set(rel, { rel, name: rel.split("/").pop() || rel, isDir: true, size: 0, mtime, type: "文件夹" });
  };
  for (const artifact of visibleArtifacts) {
    const rel = artifactPath(artifact);
    if (!rel) continue;
    const parts = rel.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) addFolder(parts.slice(0, i).join("/"), artifact.mtimeMs ?? 0);
    if (artifact.type === "dir") addFolder(rel, artifact.mtimeMs ?? 0);
    else tree.set(rel, { rel, name: parts.at(-1) || artifact.name, isDir: false, size: artifact.size ?? 0, mtime: artifact.mtimeMs ?? 0, type: artifact.type, meta: artifact });
  }
  for (const [key, folders] of Object.entries(createdDirs)) {
    const marker = `${sessionId ?? ""}::`;
    if (!key.startsWith(marker)) continue;
    const parent = key.slice(marker.length);
    for (const folder of folders) {
      const parts = [parent, folder.name].filter(Boolean).join("/").split("/");
      if (!showHidden && parts.some((part) => part.startsWith("."))) continue;
      for (let i = 1; i <= parts.length; i++) addFolder(parts.slice(0, i).join("/"), folder.at);
    }
  }
  const children = new Map<string, Entry[]>();
  for (const entry of tree.values()) {
    const parent = entry.rel.split("/").slice(0, -1).join("/");
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  const treeEntries: Entry[] = [];
  const appendChildren = (parent: string, depth: number) => {
    for (const entry of (children.get(parent) ?? []).sort(compareEntries)) {
      treeEntries.push({ ...entry, depth });
      if (entry.isDir && expandedDirs.includes(entry.rel)) appendChildren(entry.rel, depth + 1);
    }
  };
  appendChildren("", 0);
  const columnLevels = ["", ...columnPath];
  const columnEntries = columnLevels.flatMap((dir) => (children.get(dir) ?? []).slice().sort(compareEntries));
  const displayEntries = view === "list" ? treeEntries : view === "columns" ? columnEntries : entries;
  const entryByRel = (rel: string) => displayEntries.find((entry) => entry.rel === rel);
  /** 三个视图的可见集合不同，按 rel 找条目时要跨视图兜底（拖拽可能带着上一次选中的多项）。 */
  const findEntry = (rel: string) => entryByRel(rel) ?? tree.get(rel) ?? entries.find((entry) => entry.rel === rel) ?? null;
  /**
   * 开始拖拽文件项：
   *   - 组件内部靠 dragging.current + text/plain 走「移动到别的目录」；
   *   - 拖出组件外部时额外写一份 ARTIFACT_FILE_MIME，外部 drop 区据此拿到文件身份。
   * effectAllowed 用 copyMove：内部移动照旧（drop 区显式设 dropEffect=move），外部当复制。
   */
  const beginEntryDrag = (event: ReactDragEvent<HTMLElement>, entry: Entry) => {
    const rels = selected.includes(entry.rel) ? selected : [entry.rel];
    dragging.current = rels;
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData("text/plain", rels.join("\n"));
    const payload: ArtifactFileDragItem[] = rels
      .map((rel) => { const item = findEntry(rel); return item ? { rel: item.rel, name: item.name, size: item.size, isDir: item.isDir } : null; })
      .filter((item): item is ArtifactFileDragItem => !!item);
    if (payload.length) event.dataTransfer.setData(ARTIFACT_FILE_MIME, JSON.stringify(payload));
  };
  const selectEntry = (event: ReactMouseEvent, rel: string, columnDir?: string) => {
    const rangeEntries = view === "columns" && columnDir !== undefined
      ? (children.get(columnDir) ?? []).slice().sort(compareEntries)
      : displayEntries;
    if (event.shiftKey && anchor) {
      const start = rangeEntries.findIndex((entry) => entry.rel === anchor);
      const end = rangeEntries.findIndex((entry) => entry.rel === rel);
      if (start >= 0 && end >= 0) setSelected(rangeEntries.slice(Math.min(start, end), Math.max(start, end) + 1).map((entry) => entry.rel));
      else { setSelected([rel]); setAnchor(rel); }
    } else if (event.metaKey || event.ctrlKey) {
      setSelected((current) => {
        const sameColumn = view === "columns" && columnDir !== undefined
          ? current.filter((item) => item.split("/").slice(0, -1).join("/") === columnDir)
          : current;
        return sameColumn.includes(rel) ? sameColumn.filter((item) => item !== rel) : [...sameColumn, rel];
      });
      setAnchor(rel);
    } else { setSelected([rel]); setAnchor(rel); }
  };
  const showContext = (event: ReactMouseEvent, rel?: string) => {
    event.preventDefault();
    event.stopPropagation();
    if (rel && !selected.includes(rel)) { setSelected([rel]); setAnchor(rel); }
    if (!rel) setContextDir(view === "columns" ? (event.target as HTMLElement).closest<HTMLElement>(".afm-column-pane")?.dataset.afmDir ?? "" : view === "list" ? "" : fileDir);
    setMenuMode(rel ? "items" : "blank");
    setMenuPoint({ x: event.clientX, y: event.clientY });
    setViewSubmenuOpen(false);
    setViewSubmenuPoint(null);
  };
  /** 打开「显示模式」二级菜单：贴着触发项右侧，右侧放不下就翻到左侧。 */
  const openViewSubmenu = () => {
    const el = viewTriggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = 128;
    const right = rect.right + 6;
    const left = right + width > window.innerWidth - 8 ? Math.max(8, rect.left - width - 6) : right;
    setViewSubmenuPoint({ x: left, y: Math.max(8, Math.min(rect.top - 5, window.innerHeight - 140)) });
    setViewSubmenuOpen(true);
  };
  const toggleHidden = () => {
    if (operationInFlight.current) return;
    const next = !showHidden;
    setShowHidden(next); setSelected([]); setAnchor(null); setMenuMode(null);
    if (sessionId) try { window.localStorage.setItem(`artifact-show-hidden:${sessionId}`, next ? "1" : "0"); } catch { /* storage unavailable */ }
    if (!next) {
      if (fileDir.split("/").some((part) => part.startsWith("."))) setFileDir("");
      if (columnPath.some((dir) => dir.split("/").some((part) => part.startsWith(".")))) { setColumnPath([]); setFocusColumn(0); }
    }
    void runOperation("正在刷新文件…", onRefresh);
  };
  const downloadEntry = (entry: Entry) => {
    if (entry.isDir) { onZipFolder(entry.rel); return; }
    const link = document.createElement("a");
    link.href = `${buildUrl(entry.meta!.id)}&download=1`;
    link.download = entry.name;
    document.body.append(link); link.click(); link.remove();
  };
  /** 列表视图里的展开/收起：懒加载宿主据此补该目录的清单（onExpandDir 只报展开）。 */
  const setDirExpanded = (rel: string, open: boolean) => {
    setExpandedDirs((current) => open ? (current.includes(rel) ? current : [...current, rel]) : current.filter((item) => item !== rel));
    if (open) onExpandDir?.(rel);
  };
  const openSelected = () => {
    for (const rel of selected) {
      const entry = entryByRel(rel);
      if (entry?.isDir) {
        if (view === "list") setDirExpanded(entry.rel, !expandedDirs.includes(entry.rel));
        else if (view === "columns") { const path = directoryPrefixes(entry.rel); setColumnPath(path); setFocusColumn(Math.max(0, path.length - 1)); setFileDir(entry.rel); }
        else setFileDir(entry.rel);
      }
      else if (entry?.meta) openFile(entry.meta);
    }
    setMenuMode(null);
  };
  const deleteSelected = async () => {
    if (busy || operationInFlight.current) return;
    await runOperation("正在删除文件…", async () => {
      setBusy(true);
      try {
        let allOk = true;
        for (const rel of selected) {
          const entry = entryByRel(rel);
          if (entry && !(await onDeleteArtifact(entry.rel, entry.isDir))) allOk = false;
        }
        await onRefresh();
        if (allOk) { setSelected([]); setBatchDelete(false); }
        else setOperationError("部分文件未能删除，列表已刷新");
      } finally { setBusy(false); }
    });
  };
  const moveSelected = async (destination: string) => {
    if (busy || operationInFlight.current || selected.includes(destination)) return;
    const moving = dragging.current.slice();
    await runOperation("正在移动文件…", async () => {
      setBusy(true);
      try {
        let allOk = true;
        for (const rel of moving) {
          const entry = entryByRel(rel);
          if (entry && !(await onMoveArtifact(entry.rel, destination, entry.isDir))) allOk = false;
        }
        await onRefresh();
        if (allOk) setSelected([]);
        else setOperationError("部分文件未能移动，列表已刷新");
      } finally { setBusy(false); setDragOver(null); setRootDrop(false); dragging.current = []; }
    });
  };
  const startMarquee = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".artifact-list-item, .afm-column-item, .afm-tree-header")) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    marqueeColumn.current = view === "columns" ? (event.target as HTMLElement).closest<HTMLElement>(".afm-column-pane")?.dataset.afmDir ?? null : null;
    marqueeStart.current = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelected([]);
    setMarquee({ ...marqueeStart.current, w: 0, h: 0 });
  };
  const updateMarquee = (event: PointerEvent<HTMLDivElement>) => {
    const surface = listRef.current ?? columnsRef.current;
    if (!marqueeStart.current || !surface) return;
    const bounds = surface.getBoundingClientRect();
    const x = event.clientX - bounds.left; const y = event.clientY - bounds.top;
    const box = { x: Math.min(x, marqueeStart.current.x), y: Math.min(y, marqueeStart.current.y), w: Math.abs(x - marqueeStart.current.x), h: Math.abs(y - marqueeStart.current.y) };
    setMarquee({ ...box, x: box.x + surface.scrollLeft, y: box.y + surface.scrollTop });
    const candidates = view === "columns"
      ? Array.from(surface.querySelectorAll<HTMLElement>(".afm-column-pane")).find((pane) => pane.dataset.afmDir === marqueeColumn.current)?.querySelectorAll<HTMLElement>("[data-artifact-rel]") ?? []
      : surface.querySelectorAll<HTMLElement>("[data-artifact-rel]");
    const matches = Array.from(candidates).filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.left < bounds.left + box.x + box.w && rect.right > bounds.left + box.x && rect.top < bounds.top + box.y + box.h && rect.bottom > bounds.top + box.y;
    }).map((node) => node.dataset.artifactRel!);
    setSelected(matches);
    setAnchor(matches[0] ?? null);
  };

  const openFile = (meta: ArtifactMeta) => {
    if (onOpenFile) {
      onOpenFile(meta);
      if (mobilePage === "artifacts") onMobilePreview?.(meta.id);
      return;
    }
    if (mobilePage === "artifacts") onMobilePreview?.(meta.id);
    setPreview(meta);
    setReloadKey(0);
  };

  const backToList = () => {
    if (previewFull) onToggleFullscreen();
    setPreview(null);
  };

  const openMenu = (event: React.MouseEvent<HTMLButtonElement>, target: Omit<MenuTarget, "rect">) => {
    const rect = event.currentTarget.getBoundingClientRect();
    // 立即给出初始位置（portal 未挂载前 useLayoutEffect 拿不到 ref），下方放不下则翻到上方
    const estH = 170;
    const below = rect.bottom + 4;
    const top = below + estH > window.innerHeight - 8 ? Math.max(8, rect.top - estH - 4) : below;
    const left = Math.max(8, Math.min(rect.right - 180, window.innerWidth - 188));
    setMenu({ ...target, rect });
    setMenuPos({ top, left });
  };

  const submitRename = async () => {
    if (!renameTarget || renameBusy || operationInFlight.current) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.name) { setRenameTarget(null); return; }
    await runOperation("正在重命名…", async () => {
      setRenameBusy(true);
      try {
        const ok = await onRenameArtifact(renameTarget.rel, name, renameTarget.isDir);
        await onRefresh();
        if (!ok) { setOperationError("重命名失败：文件可能已被其他人修改"); return; }
        setRenameTarget(null);
        if (renameTarget.isDir) {
          const key = createdKey;
          setCreatedDirs((cur) => {
            const list = (cur[key] ?? []).filter((f) => f.name !== renameTarget.name);
            return { ...cur, [key]: [...list, { name, at: Date.now() }] };
          });
        }
      } finally { setRenameBusy(false); }
    });
  };

  const confirmDelete = async () => {
    if (!deleteTarget || deleteBusy || operationInFlight.current) return;
    await runOperation("正在删除文件…", async () => {
      setDeleteBusy(true);
      try {
        const ok = await onDeleteArtifact(deleteTarget.rel, deleteTarget.isDir);
        await onRefresh();
        if (!ok) { setOperationError("删除失败：文件可能已被其他人修改"); return; }
        const wasPreview = preview && !deleteTarget.isDir && preview.name === deleteTarget.rel;
        setDeleteTarget(null);
        if (deleteTarget.isDir && fileDir === deleteTarget.rel) setFileDir(crumbs.slice(0, -1).join("/"));
        if (wasPreview) setPreview(null);
        if (deleteTarget.isDir) {
          const key = createdKey;
          setCreatedDirs((cur) => {
            const list = (cur[key] ?? []).filter((f) => f.name !== deleteTarget.name);
            return { ...cur, [key]: list };
          });
        }
      } finally { setDeleteBusy(false); }
    });
  };

  const submitCreate = async () => {
    if (!createOpen || createBusy || operationInFlight.current) return;
    const name = createValue.trim();
    if (!name) { setCreateError("请输入文件夹名称"); return; }
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      setCreateError("名称不能包含 / 或 \\，也不能是 . 或 ..");
      return;
    }
    await runOperation("正在新建文件夹…", async () => {
      setCreateBusy(true);
      try {
        const result = await onCreateFolder(fileDir, name);
        await onRefresh();
        if (result === "ok") {
          const key = createdKey;
          setCreatedDirs((cur) => {
            const list = (cur[key] ?? []).filter((f) => f.name !== name);
            return { ...cur, [key]: [...list, { name, at: Date.now() }] };
          });
          setCreateOpen(false); setCreateValue(""); setCreateError("");
          return;
        }
        setCreateError(result === "exists" ? `已存在同名文件夹或文件「${name}」` : "创建失败，请重试");
      } finally { setCreateBusy(false); }
    });
  };

  return (
    <div className="afm">
      {/* 顶栏：列表态 = 返回上一级 + 面包屑 + 刷新目录；预览态 = 返回 + 文件名 + 刷新/全屏/下载 */}
      {preview ? (
        <div className="artifact-fm-toolbar">
          <button type="button" className="artifact-fm-back" title="返回列表" aria-label="返回列表" onClick={backToList}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <nav className="artifact-fm-crumbs" aria-label="产物目录">
            {artifactPath(preview).split("/").filter(Boolean).map((seg, i, arr) => {
              const last = i === arr.length - 1;
              const target = arr.slice(0, i + 1).join("/");
              return (
                <span key={target} className="artifact-fm-crumb-sep">
                  /
                  {last ? (
                    <span className="artifact-fm-crumb is-current" title={artifactPath(preview)}>{seg}</span>
                  ) : (
                    <button
                      type="button"
                      className="artifact-fm-crumb"
                      title={target}
                      onClick={() => {
                        if (previewFull) onToggleFullscreen();
                        setPreview(null);
                        setFileDir(target);
                      }}
                    >
                      {seg}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
          <div className="artifact-fm-actions">
            {preview.type === "browser" || !onShareArtifact ? null : <button type="button" className="artifact-fm-btn" title="分享" aria-label="分享产物" onClick={() => onShareArtifact(preview)}><ChatPanelGlyph04 /></button>}
            <button type="button" className="artifact-fm-btn" title="刷新（重新加载最新版本）" aria-label="刷新预览" onClick={() => setReloadKey((k) => k + 1)}>
              <RefreshIcon />
            </button>
            <button type="button" className="artifact-fm-btn" title={previewFull ? "退出全屏预览" : "全屏预览"} aria-label={previewFull ? "退出全屏预览" : "全屏预览"} onClick={onToggleFullscreen}>
              {previewFull ? <OperationPanelGlyph10 /> : <OperationPanelGlyph11 />}
            </button>
            {preview.type === "browser" ? null : (
              <a className="artifact-fm-btn artifact-fm-dl" href={`${buildUrl(preview.id)}&download=1`} title="下载" aria-label="下载">
                <OperationPanelGlyph08 />
              </a>
            )}
          </div>
        </div>
      ) : hideToolbar ? null : (
        <div className="artifact-fm-toolbar">
          <div className="afm-view-switch" role="group" aria-label="文件视图">
            {(["icons", "list", "columns"] as const).map((mode) => <button key={mode} type="button" className={view === mode ? "is-active" : ""} aria-label={mode === "icons" ? "图标视图" : mode === "list" ? "列表视图" : "分栏视图"} title={mode === "icons" ? "图标" : mode === "list" ? "列表" : "Column"} aria-pressed={view === mode} onClick={() => changeView(mode)}><ViewIcon mode={mode} /></button>)}
          </div>
          {view === "icons" && fileDir ? (
            <button type="button" className="artifact-fm-back" title="返回上一级" aria-label="返回上一级" onClick={() => setFileDir(crumbs.slice(0, -1).join("/"))}>
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
            </button>
          ) : null}
          {view === "icons" ? <nav className="artifact-fm-crumbs" aria-label="产物目录">
            {crumbs.map((seg, i) => {
              const target = crumbs.slice(0, i + 1).join("/");
              const last = i === crumbs.length - 1;
              return (
                <span key={target} className="artifact-fm-crumb-sep">
                  /
                  <button type="button" className={`artifact-fm-crumb${last ? " is-current" : ""}`} onClick={() => setFileDir(target)}>{seg}</button>
                </span>
              );
            })}
          </nav> : <span className="afm-toolbar-spacer" />}

          {allowCreateFolder ? <button type="button" className="artifact-fm-btn artifact-fm-newfolder" title="新建文件夹" aria-label="新建文件夹" onClick={() => { setCreateValue(""); setCreateError(""); setCreateOpen(true); }}>
            <NewFolderIcon />
          </button> : null}
          <button type="button" className="artifact-fm-btn artifact-fm-refresh" title="刷新当前目录" aria-label="刷新当前目录" onClick={() => void runOperation("正在刷新文件…", onRefresh)}>
            <RefreshIcon />
          </button>
        </div>
      )}

      {/* 内容区 */}
      {preview ? (
        <div className="chat-right-preview afm-preview">
          <div className="chat-right-preview-frame">
            <FilePreviewContent
              key={reloadKey}
              url={`${buildUrl(preview.id)}&t=${reloadKey}`}
              name={preview.name.split("/").pop() || preview.name}
              type={preview.type}
            />
          </div>
        </div>
      ) : error ? (
        <div className="chat-loading-error" role="alert">产出物加载失败<button type="button" onClick={() => void runOperation("正在加载文件…", onRetry)}>重试</button></div>
      ) : loading ? (
        <LoadingState label="正在加载产出物…" variant="artifacts" />
      ) : view === "columns" ? (
        <div ref={columnsRef} tabIndex={0} className={`afm-columns${rootDrop ? " is-root-drop" : ""}`} onContextMenu={(event) => showContext(event)} onPointerDown={startMarquee} onPointerMove={updateMarquee} onPointerUp={() => { marqueeStart.current = null; marqueeColumn.current = null; setMarquee(null); }} onPointerCancel={() => { marqueeStart.current = null; marqueeColumn.current = null; setMarquee(null); }} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            const dir = selected[0]?.split("/").slice(0, -1).join("/") ?? columnPath.at(-1) ?? "";
            setSelected((children.get(dir) ?? []).map((entry) => entry.rel));
          }
          if (event.key === "Escape") { setSelected([]); setMenuMode(null); }
          if (event.key === "Enter" && selected.length) openSelected();
          if ((event.key === "Delete" || event.key === "Backspace") && selected.length) { event.preventDefault(); setBatchDelete(true); }
        }} onDragOver={(event) => {
          if (!dragging.current.length || (event.target as HTMLElement).closest(".afm-column-item")) { setRootDrop(false); return; }
          event.preventDefault(); event.dataTransfer.dropEffect = "move"; setRootDrop(true);
        }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRootDrop(false); }} onDrop={(event) => {
          if ((event.target as HTMLElement).closest(".afm-column-item")) return;
          event.preventDefault(); setRootDrop(false); if (dragging.current.length) void moveSelected("");
        }}>
          {columnLevels.map((dir, level) => <div className="afm-column-pane" data-afm-dir={dir} key={dir || "root"} aria-label={dir ? `${dir} 文件夹` : "根目录"}>
            {(children.get(dir) ?? []).slice().sort(compareEntries).map((entry) => <div key={entry.rel} data-artifact-rel={entry.rel} className={`afm-column-item${selected.includes(entry.rel) || columnPath[level] === entry.rel ? " is-selected" : ""}${dragOver === entry.rel ? " is-drop-target" : ""}`}
              draggable onDragStart={(event) => beginEntryDrag(event, entry)} onDragEnd={() => { dragging.current = []; setDragOver(null); setRootDrop(false); }}
              onDragOver={entry.isDir ? (event) => { if (!dragging.current.includes(entry.rel)) { event.preventDefault(); event.stopPropagation(); setDragOver(entry.rel); setRootDrop(false); } } : undefined}
              onDragLeave={() => { if (dragOver === entry.rel) setDragOver(null); }}
              onDrop={entry.isDir ? (event) => { event.preventDefault(); event.stopPropagation(); void moveSelected(entry.rel); } : undefined}
              onContextMenu={(event) => showContext(event, entry.rel)}>
              <button type="button" className="afm-column-item-button" onClick={(event) => {
                selectEntry(event, entry.rel, dir);
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                setColumnPath((current) => entry.isDir ? [...current.slice(0, level), entry.rel] : current.slice(0, level));
                setFileDir(entry.isDir ? entry.rel : dir);
                setFocusColumn(level);
              }} onDoubleClick={() => { if (!entry.isDir && entry.meta) openFile(entry.meta); }}>
                <span className={`artifact-card-icon${entry.meta?.type === "text" ? " afm-code-icon" : ""}`} aria-hidden="true">{entry.isDir ? <FolderIcon /> : <ArtifactIcon type={entry.meta!.type} name={entry.name} />}</span>
                <span className={`afm-column-name${entry.name.startsWith(".") ? " is-hidden-file" : ""}`} title={entry.name}>{entry.name}</span>
                {entry.isDir ? <span className="afm-column-chevron"><ThinkingChevronIcon open={false} /></span> : null}
              </button>
            </div>)}
          </div>)}
          {marquee ? <div className="afm-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} /> : null}
        </div>
      ) : (
        <div ref={listRef} tabIndex={0} className={`afm-list afm-list--${view}${rootDrop ? " is-root-drop" : ""}`} onContextMenu={(event) => showContext(event)} onPointerDown={startMarquee} onPointerMove={updateMarquee} onPointerUp={() => { marqueeStart.current = null; setMarquee(null); }} onPointerCancel={() => { marqueeStart.current = null; setMarquee(null); }} onDragOver={(event) => {
          if (!dragging.current.length || (event.target as HTMLElement).closest(".artifact-list-item, .afm-tree-header, .afm-column-children")) { setRootDrop(false); return; }
          event.preventDefault(); event.dataTransfer.dropEffect = "move"; setRootDrop(true);
        }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setRootDrop(false); }} onDrop={(event) => {
          if ((event.target as HTMLElement).closest(".artifact-list-item, .afm-tree-header, .afm-column-children")) return;
          event.preventDefault(); setRootDrop(false); if (dragging.current.length) void moveSelected("");
        }} onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") { event.preventDefault(); setSelected(displayEntries.map((entry) => entry.rel)); }
          if (event.key === "Escape") { setSelected([]); setMenuMode(null); }
          if (event.key === "Enter" && selected.length) openSelected();
          if ((event.key === "Delete" || event.key === "Backspace") && selected.length) { event.preventDefault(); setBatchDelete(true); }
        }}>
          {view === "list" ? <div className="afm-tree-header" role="row">
            {([ ["name", "名称"], ["modified", "修改时间"], ["size", "大小"] ] as const).map(([field, label]) => <button key={field} type="button" role="columnheader" aria-sort={sort === field ? sortDirection === "asc" ? "ascending" : "descending" : "none"} onClick={() => changeSort(field)}>{label}<span className={`afm-sort-arrow${sortDirection === "asc" ? " is-ascending" : ""}${sort !== field ? " is-inactive" : ""}`}><ThinkingChevronIcon open /></span></button>)}
          </div> : null}
          {displayEntries.length === 0 ? <div className="chat-right-empty">{fileDir && view !== "list" ? "此目录为空" : "暂无产物"}</div> : null}
          {displayEntries.map((entry, index) => (
            <div key={entry.rel} data-artifact-rel={entry.rel} className={`artifact-list-item${entry.isDir ? " artifact-fm-folder" : ""}${view === "list" && index % 2 === 1 ? " is-striped" : ""}${selected.includes(entry.rel) ? " is-selected" : ""}${view === "list" && selected.includes(entry.rel) && (index === 0 || !selected.includes(displayEntries[index - 1].rel)) ? " is-selection-start" : ""}${view === "list" && selected.includes(entry.rel) && (index === displayEntries.length - 1 || !selected.includes(displayEntries[index + 1].rel)) ? " is-selection-end" : ""}${dragOver === entry.rel ? " is-drop-target" : ""}`}
              draggable onDragStart={(event) => beginEntryDrag(event, entry)} onDragEnd={() => { dragging.current = []; setDragOver(null); setRootDrop(false); }}
              onDragOver={entry.isDir ? (event) => { if (!dragging.current.includes(entry.rel)) { event.preventDefault(); setDragOver(entry.rel); } } : undefined}
              onDragLeave={() => { if (dragOver === entry.rel) setDragOver(null); }}
              onDrop={entry.isDir ? (event) => { event.preventDefault(); event.stopPropagation(); void moveSelected(entry.rel); } : undefined}
              onContextMenu={(event) => showContext(event, entry.rel)}>
              {view === "list" ? <span className="afm-tree-indent" style={{ width: (entry.depth ?? 0) * 18 }} /> : null}
              {view === "list" ? entry.isDir ? <button type="button" className="afm-tree-disclosure" aria-label={expandedDirs.includes(entry.rel) ? `收起 ${entry.name}` : `展开 ${entry.name}`} aria-expanded={expandedDirs.includes(entry.rel)} onClick={(event) => { event.stopPropagation(); setDirExpanded(entry.rel, !expandedDirs.includes(entry.rel)); setSelected([]); }}><ThinkingChevronIcon open={expandedDirs.includes(entry.rel)} /></button> : <span className="afm-tree-disclosure-placeholder" /> : null}
              <button type="button" className="artifact-list-item-mainbtn" onClick={(event) => selectEntry(event, entry.rel)} onDoubleClick={() => { if (entry.isDir) { if (view === "list") setDirExpanded(entry.rel, !expandedDirs.includes(entry.rel)); else setFileDir(entry.rel); } else if (entry.meta) openFile(entry.meta); }}>
                <span className={`artifact-card-icon${entry.meta?.type === "text" ? " afm-code-icon" : ""}`} aria-hidden="true">{entry.isDir ? <FolderIcon /> : <ArtifactIcon type={entry.meta!.type} name={entry.name} />}</span>
                <span className="artifact-list-item-main">
                  <span className={`artifact-list-item-name${entry.name.startsWith(".") ? " is-hidden-file" : ""}`}>{entry.name}</span>
                  <span className="artifact-list-item-meta">{entry.isDir ? "文件夹" : formatFileSize(entry.size)}{entry.mtime ? <span className="artifact-list-item-time" title={`修改于 ${new Date(entry.mtime).toLocaleString()}`}> · {formatArtifactMtime(entry.mtime)}</span> : null}</span>
                </span>
              </button>
              {view === "list" ? <><span className="afm-tree-time" title={entry.mtime ? new Date(entry.mtime).toLocaleString() : ""}>{entry.mtime ? new Date(entry.mtime).toLocaleString() : "—"}</span><span className="afm-tree-size">{entry.isDir ? "—" : formatFileSize(entry.size)}</span></> : null}
            </div>
          ))}
          {marquee ? <div className="afm-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} /> : null}
        </div>
      )}

      {operationError && !createOpen && !renameTarget && !deleteTarget && !batchDelete ? <div className="afm-operation-error" role="alert">{operationError}<button type="button" aria-label="关闭提示" onClick={() => setOperationError("")}>×</button></div> : null}
      {(activeOperation || loading) ? createPortal(<div className={`afm-operation-overlay${showSlowOperation || showSlowLoading ? " is-slow" : ""}`} aria-busy="true">
        {showSlowOperation || showSlowLoading ? <div className="afm-operation-card" role="status"><span className="afm-operation-spinner" aria-hidden="true" />{activeOperation ?? "正在加载文件…"}</div> : null}
      </div>, document.body) : null}

      {menuMode && menuPoint ? createPortal(
        <div className="chat-sidebar-project-menu afm-context-menu" role="menu" style={{ left: Math.min(menuPoint.x, window.innerWidth - 210), top: Math.min(menuPoint.y, window.innerHeight - 310) }}>
          {menuMode === "blank" ? <>
            <button type="button" role="menuitem" onClick={() => { setMenuMode(null); void runOperation("正在刷新文件…", onRefresh); }}>刷新</button>
            {allowCreateFolder ? <button type="button" role="menuitem" onClick={() => { setMenuMode(null); setCreateValue(""); setCreateError(""); setCreateOpen(true); }}>新建文件夹</button> : null}
            {contextDir === "" ? <button type="button" role="menuitem" onClick={toggleHidden}>{showHidden ? "不显示隐藏文件" : "显示隐藏文件"}</button> : null}
            {/* 工具栏被隐藏时（桌面小组件），「返回上一级」只剩这一个入口 */}
            {view === "icons" && fileDir ? <button type="button" role="menuitem" onClick={() => { setFileDir(crumbs.slice(0, -1).join("/")); setMenuMode(null); }}>返回上一级</button> : null}
            <button
              type="button"
              role="menuitem"
              ref={viewTriggerRef}
              className="afm-submenu-trigger"
              aria-haspopup="menu"
              aria-expanded={viewSubmenuOpen}
              onMouseEnter={openViewSubmenu}
              onFocus={openViewSubmenu}
              onClick={openViewSubmenu}>
              <span>显示模式</span>
              <span className="afm-submenu-caret" aria-hidden="true">›</span>
            </button>
            <div className="afm-menu-heading">排序方式</div>
            {([ ["name", "名称"], ["type", "类型"], ["size", "大小"], ["modified", "最近修改时间"] ] as const).map(([key, label]) => <button type="button" role="menuitemradio" aria-checked={sort === key} key={key} onClick={() => { changeSort(key); setMenuMode(null); }}>{sort === key ? "✓ " : "　"}{label}</button>)}
          </> : <>
            <div className="afm-menu-heading">已选中 {selected.length} 项</div>
            {(selected.length === 1 || selected.every((rel) => !entryByRel(rel)?.isDir)) ? <button type="button" role="menuitem" onClick={openSelected}>{selected.length > 1 ? "全部打开" : "打开"}</button> : null}
            <button type="button" role="menuitem" onClick={() => { selected.forEach((rel) => { const entry = entryByRel(rel); if (entry) downloadEntry(entry); }); setMenuMode(null); }}>{selected.length > 1 ? "全部下载" : "下载"}</button>
            <button type="button" role="menuitem" onClick={() => { setMenuMode(null); setInfoOpen(true); }}>信息</button>
            {selected.length === 1 ? <>
              {entryByRel(selected[0])?.meta && onShareArtifact ? <button type="button" role="menuitem" onClick={() => { const entry = entryByRel(selected[0]); setMenuMode(null); const meta = entry?.meta; if (meta) onShareArtifact(meta); }}>分享</button> : null}
              {desktopApp && entryByRel(selected[0])?.meta?.dir ? <button type="button" role="menuitem" onClick={() => { const dir = entryByRel(selected[0])?.meta?.dir; setMenuMode(null); if (dir) onOpenDir(dir); }}>打开所在文件夹</button> : null}
              <button type="button" role="menuitem" onClick={() => { const entry = entryByRel(selected[0]); setMenuMode(null); if (entry) { setRenameTarget(entry); setRenameValue(entry.name); } }}>重命名</button>
            </> : null}
            <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuMode(null); setBatchDelete(true); }}>{selected.length > 1 ? "全部删除" : "删除"}</button>
          </>}
        </div>, document.body,
      ) : null}
      {menuMode ? <div className="afm-menu-dismiss" onPointerDown={() => setMenuMode(null)} /> : null}
      {/* 「显示模式」二级菜单：独立 portal，避免被父菜单的 overflow 裁掉 */}
      {viewSubmenuOpen && viewSubmenuPoint ? createPortal(
        <div className="chat-sidebar-project-menu afm-submenu-panel" role="menu" style={{ left: viewSubmenuPoint.x, top: viewSubmenuPoint.y }}>
          {([ ["icons", "图标"], ["list", "列表"], ["columns", "分栏"] ] as const).map(([key, label]) => <button key={key} type="button" role="menuitemradio" aria-checked={view === key} onClick={() => { changeView(key); setMenuMode(null); setViewSubmenuOpen(false); setViewSubmenuPoint(null); }}><span className="afm-menu-check" aria-hidden="true">{view === key ? "✓" : ""}</span>{label}</button>)}
        </div>, document.body,
      ) : null}
      {infoOpen ? <div className="chat-modal-backdrop" onClick={() => setInfoOpen(false)}><div className="chat-modal" onClick={(event) => event.stopPropagation()}><h3 className="chat-modal-title">{selected.length === 1 ? entryByRel(selected[0])?.name : `${selected.length} 项的信息`}</h3><div className="afm-info-list">{selected.map((rel) => { const entry = entryByRel(rel); return entry ? <div className="afm-info-item" key={rel}>{selected.length > 1 ? <strong>{entry.name}</strong> : null}<span>类型：{entry.type}</span><span>位置：/{entry.rel.split("/").slice(0, -1).join("/")}</span>{!entry.isDir ? <span>大小：{formatFileSize(entry.size)}</span> : null}{entry.mtime ? <span>修改时间：{new Date(entry.mtime).toLocaleString()}</span> : null}</div> : null; })}</div><div className="chat-modal-actions"><button type="button" className="chat-modal-btn" onClick={() => setInfoOpen(false)}>关闭</button></div></div></div> : null}
      {batchDelete ? <div className="chat-modal-backdrop" onClick={() => !busy && setBatchDelete(false)}><div className="chat-modal" onClick={(event) => event.stopPropagation()}><h3 className="chat-modal-title">删除 {selected.length} 项？</h3><p className="chat-modal-desc">文件夹内的内容也会删除，删除后无法恢复。</p>{operationError ? <p className="chat-modal-error" role="alert">{operationError}</p> : null}<div className="chat-modal-actions"><button type="button" className="chat-modal-btn" disabled={busy} onClick={() => setBatchDelete(false)}>取消</button><button type="button" className="chat-modal-btn chat-modal-btn--danger" disabled={busy} onClick={() => void deleteSelected()}>{busy ? "删除中…" : selected.length > 1 ? "全部删除" : "删除"}</button></div></div></div> : null}

      {/* 新建文件夹对话框 */}
      {createOpen ? (
        <div className="chat-modal-backdrop" onClick={() => !createBusy && setCreateOpen(false)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
            <input
              className="chat-modal-input"
              value={createValue}
              autoFocus
              placeholder="文件夹名称"
              onChange={(e) => { setCreateValue(e.target.value); if (createError) setCreateError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") void submitCreate(); if (e.key === "Escape") !createBusy && setCreateOpen(false); }}
            />
            {createError ? <p className="chat-modal-error">{createError}</p> : null}
            {operationError ? <p className="chat-modal-error" role="alert">{operationError}</p> : null}
            <div className="chat-modal-actions">
              <button type="button" className="chat-modal-btn" disabled={createBusy} onClick={() => setCreateOpen(false)}>取消</button>
              <button type="button" className="chat-modal-btn chat-modal-btn--primary" disabled={createBusy} onClick={() => void submitCreate()}>
                {createBusy ? "创建中…" : "创建"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 重命名对话框 */}
      {renameTarget ? (
        <div className="chat-modal-backdrop" onClick={() => !renameBusy && setRenameTarget(null)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="chat-modal-title">重命名{renameTarget.isDir ? "文件夹" : "文件"}</h3>
            <p className="chat-modal-desc">{renameTarget.isDir ? "修改文件夹名称" : "修改文件名称（含扩展名）"}</p>
            <input
              className="chat-modal-input"
              value={renameValue}
              autoFocus
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submitRename(); if (e.key === "Escape") setRenameTarget(null); }}
            />
            {operationError ? <p className="chat-modal-error" role="alert">{operationError}</p> : null}
            <div className="chat-modal-actions">
              <button type="button" className="chat-modal-btn" disabled={renameBusy} onClick={() => setRenameTarget(null)}>取消</button>
              <button type="button" className="chat-modal-btn chat-modal-btn--primary" disabled={renameBusy} onClick={() => void submitRename()}>
                {renameBusy ? "保存中…" : "确定"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* 删除确认框 */}
      {deleteTarget ? (
        <div className="chat-modal-backdrop" onClick={() => !deleteBusy && setDeleteTarget(null)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="chat-modal-title">删除{deleteTarget.isDir ? "文件夹" : "文件"}？</h3>
            <p className="chat-modal-desc">
              即将删除「{deleteTarget.name}」{deleteTarget.isDir ? "（含其内全部文件，递归删除）" : ""}，删除后无法恢复，确定吗？
            </p>
            {operationError ? <p className="chat-modal-error" role="alert">{operationError}</p> : null}
            <div className="chat-modal-actions">
              <button type="button" className="chat-modal-btn" disabled={deleteBusy} onClick={() => setDeleteTarget(null)}>取消</button>
              <button type="button" className="chat-modal-btn chat-modal-btn--danger" disabled={deleteBusy} onClick={() => void confirmDelete()}>
                {deleteBusy ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
