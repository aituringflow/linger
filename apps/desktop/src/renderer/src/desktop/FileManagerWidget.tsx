import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArtifactFileManager, type ArtifactMeta, type ArtifactType, type FileView } from "@turingflow/agent-kit/ui";
import type { LauncherFsEntry } from "../../../shared/types";
import { localFileUrl } from "../localFile";

/**
 * 桌面「文件管理」组件：直接复用 kit 的 Finder 风格文件管理器（ArtifactFileManager），
 * 根目录固定是用户 home。
 *
 * 与产物面板的区别在数据来源：那边一次拿到整棵树，这里按目录懒加载 ——
 * 每进一层就把这一层的清单并进 artifacts 缓存（rel 相对 home）。
 * 因此三个视图都能用：图标/分栏靠 onDirectoryChange，列表视图的展开靠 onExpandDir。
 */

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "tiff"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "aac", "flac", "ogg", "aiff"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi"]);
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "jsonl", "yaml", "yml", "toml", "ini", "conf", "log", "tsv",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "less", "xml", "sh", "zsh",
  "bash", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "swift", "sql",
]);

function artifactTypeOf(name: string): ArtifactType {
  const ext = /\.([^./]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (!ext) return "other";
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (VIDEO_EXT.has(ext)) return "video";
  if (TEXT_EXT.has(ext)) return ext === "md" || ext === "markdown" ? "markdown" : "text";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv") return "excel";
  if (ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc") return "word";
  if (ext === "xlsx" || ext === "xls" || ext === "xlsm") return "excel";
  if (ext === "pptx" || ext === "ppt" || ext === "ppsx") return "ppt";
  return "other";
}

function joinHome(home: string, rel: string): string {
  if (!home) return rel;
  return rel ? `${home.replace(/\/+$/, "")}/${rel}` : home;
}

/** 列表模式下 folder 展开按钮的图标：向右 chevron（未展开时）。 */
function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

/** 向左 chevron（返回按钮）。 */
function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="15 6 9 12 15 18" />
    </svg>
  );
}

export default function FileManagerWidget({ dir: savedDir = "", view, onViewChange, onDirChange }: {
  /** 上次停留的目录（相对 home，"" = home 根）；重启后直接回到这里。 */
  dir?: string;
  /** 上次选的显示模式（桌面组件持久化在 launcher.fileWidgets 里）。 */
  view?: FileView;
  onViewChange?: (view: FileView) => void;
  onDirChange?: (dir: string) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [home, setHome] = useState("");
  // 每层目录的清单缓存：键是相对 home 的目录（""=home）
  const [dirs, setDirs] = useState<Record<string, LauncherFsEntry[]>>({});
  // 已经请求过的目录（含空目录：空目录也要记，否则每次渲染都会重新拉一遍）
  const loaded = useRef<Set<string>>(new Set());
  const inflight = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  // 当前目录：初值就是上次记住的位置
  const [dir, setDir] = useState(savedDir);
  const dirRef = useRef(savedDir);
  const viewRef = useRef<FileView>(view ?? "icons");
  // 目录没了（关掉 launcher 期间被删）时换个 key 让 kit 重新挂载回 home
  const [resetKey, setResetKey] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // 宿主回调每次渲染都是新函数：走 ref 引用，免得 loadDir 跟着抖
  const onDirChangeRef = useRef(onDirChange);
  onDirChangeRef.current = onDirChange;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const initialDirRef = useRef(savedDir);

  // 导航历史栈：后退/前进
  const [historyStack, setHistoryStack] = useState<string[]>([savedDir]);
  const [historyIndex, setHistoryIndex] = useState(0);
  // 用 ref 保存最新的 historyIndex，避免闭包拿不到最新值
  const historyIndexRef = useRef(0);
  historyIndexRef.current = historyIndex;
  // 标记是否是程序化切换目录（避免 onDirectoryChange 又往历史栈里 push）
  const navigatingRef = useRef(false);

  const loadDir = useCallback(async (rel: string, force = false) => {
    if (!force && (loaded.current.has(rel) || inflight.current.has(rel))) return;
    inflight.current.add(rel);
    setLoading(true);
    try {
      const entries = await window.launcher.listDirectory(rel);
      if (!entries) {
        // 目录已不存在：记住的目录失效了 —— 回到 home，别把用户留在空壳里。
        loaded.current.add(rel);
        setDirs((current) => ({ ...current, [rel]: [] }));
        if (dirRef.current === rel) {
          dirRef.current = "";
          setDir("");
          onDirChangeRef.current?.("");
          setResetKey((key) => key + 1);
        }
        return;
      }
      loaded.current.add(rel);
      setDirs((current) => ({ ...current, [rel]: entries }));
    } catch {
      // 读不了（无权限 / 目录已消失）：留空目录，不打断其它层级
      loaded.current.add(rel);
      setDirs((current) => ({ ...current, [rel]: [] }));
    } finally {
      inflight.current.delete(rel);
      if (rel === initialDirRef.current) setInitialLoadComplete(true);
      if (inflight.current.size === 0) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void window.launcher.getHomeDir().then(setHome).catch(() => setHome(""));
    void loadDir("");
    // 上次记住的目录也要先拉出来：kit 挂载后才会用 initialDir 展示它
    if (initialDirRef.current) void loadDir(initialDirRef.current);
  }, [loadDir]);

  const refresh = useCallback(async () => {
    loaded.current.delete(dir);
    await loadDir(dir, true);
  }, [dir, loadDir]);

  /** kit 报告目录变化：更新本地状态、加载该层清单，并把新目录告诉宿主（好记住）。 */
  const handleDirChange = useCallback((next: string) => {
    const changed = dirRef.current !== next;
    dirRef.current = next;
    setDir(next);
    void loadDir(next);
    // 不管是不是程序化导航，只要目录变化事件触发了，就重置标记
    // （程序化导航时 changed 可能是 false，但我们也要重置，不然标记永远是 true）
    const wasNavigating = navigatingRef.current;
    navigatingRef.current = false;
    // 列表视图没有「当前目录」这回事（kit 切到列表时会把 fileDir 归零），
    // 这时候不能把记住的目录冲掉。
    if (changed && viewRef.current !== "list") {
      onDirChangeRef.current?.(next);
      // 不是程序化导航（后退/前进/面包屑跳转）时，才往历史栈里 push
      if (!wasNavigating) {
        const currentIndex = historyIndexRef.current;
        setHistoryStack((stack) => {
          // 截断当前位置之后的历史（如果有前进历史的话）
          const trimmed = stack.slice(0, currentIndex + 1);
          // 避免连续 push 同一个目录
          if (trimmed[trimmed.length - 1] === next) return trimmed;
          return [...trimmed, next];
        });
        setHistoryIndex((i) => i + 1);
      }
    }
  }, [loadDir]);

  /** 后退：回到上一个目录。 */
  /** 返回：回到上一级目录（父目录），直到 home。 */
  const goBack = useCallback(() => {
    if (!dir) return; // 已经在 home 了，没有上一级
    const parent = dir.split("/").slice(0, -1).join("/");
    navigatingRef.current = true;
    dirRef.current = parent;
    setDir(parent);
    void loadDir(parent);
    onDirChangeRef.current?.(parent);
    // 更新历史栈
    const currentIndex = historyIndexRef.current;
    setHistoryStack((stack) => {
      const trimmed = stack.slice(0, currentIndex + 1);
      if (trimmed[trimmed.length - 1] === parent) return trimmed;
      return [...trimmed, parent];
    });
    setHistoryIndex((i) => i + 1);
    // 重新挂载 ArtifactFileManager，让它用新的 initialDir
    setResetKey((key) => key + 1);
  }, [dir, loadDir]);

  /** 前进：回到下一个目录。 */
  const goForward = useCallback(() => {
    if (historyIndex >= historyStack.length - 1) return;
    const newIndex = historyIndex + 1;
    const target = historyStack[newIndex];
    navigatingRef.current = true;
    setHistoryIndex(newIndex);
    dirRef.current = target;
    setDir(target);
    void loadDir(target);
    onDirChangeRef.current?.(target);
    // 重新挂载 ArtifactFileManager，让它用新的 initialDir
    setResetKey((key) => key + 1);
  }, [historyIndex, historyStack, loadDir]);

  /** 面包屑跳转：直接跳到指定目录，并更新历史栈。 */
  const navigateTo = useCallback((target: string) => {
    if (dirRef.current === target) return;
    const currentIndex = historyIndexRef.current;
    // 更新历史栈：截断当前位置之后的历史，把新目录加进去
    setHistoryStack((stack) => {
      const trimmed = stack.slice(0, currentIndex + 1);
      if (trimmed[trimmed.length - 1] === target) return trimmed;
      return [...trimmed, target];
    });
    setHistoryIndex((i) => i + 1);
    navigatingRef.current = true;
    dirRef.current = target;
    setDir(target);
    void loadDir(target);
    onDirChangeRef.current?.(target);
    setResetKey((key) => key + 1);
  }, [loadDir]);

  const handleViewChange = useCallback((next: FileView) => {
    viewRef.current = next;
    onViewChangeRef.current?.(next);
  }, []);

  /**
   * 全屏预览：不换父节点（换父节点会整棵重挂，正在看的文件就没了），
   * 而是给外层组件挂一个 is-file-expanded，由 CSS 把它撑到整个视口。
   */
  useEffect(() => {
    const widget = rootRef.current?.closest<HTMLElement>(".desktop-running-widget");
    if (!widget) return;
    widget.classList.toggle("is-file-expanded", expanded);
    return () => widget.classList.remove("is-file-expanded");
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setExpanded(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // 文件系统变化监听：当前目录变化时，告诉主进程要监听新的目录
  useEffect(() => {
    if (view !== "icons") return; // 只在图标模式下监听
    void window.launcher.watchDirectory(dir);
  }, [dir, view]);

  // 监听目录变化事件，自动刷新
  useEffect(() => {
    const off = window.launcher.onDirectoryChanged((changedDir) => {
      // 只有变化的是当前目录时才刷新
      if (changedDir === dirRef.current) {
        void refresh();
      }
    });
    return off;
  }, [refresh]);

  const artifacts = useMemo<ArtifactMeta[]>(() => {
    const list: ArtifactMeta[] = [];
    for (const [dirRel, entries] of Object.entries(dirs)) {
      for (const entry of entries) {
        list.push({
          id: entry.rel,
          rel: entry.rel,
          name: entry.name,
          type: entry.isDir ? "dir" : artifactTypeOf(entry.name),
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          // 「打开所在文件夹」要目录：主进程只给了 rel，这里保留父层 rel。
          dir: dirRel,
        });
      }
    }
    return list;
  }, [dirs]);

  return <div className="desktop-file-manager" ref={rootRef}>
    {/* 图标模式下的导航栏：返回/前进按钮 + 路径面包屑 */}
    {viewRef.current === "icons" && (
      <div className="file-nav-bar">
        <button
          type="button"
          className="file-nav-btn"
          disabled={!dir}
          onClick={goBack}
        >
          <ChevronLeftIcon />
        </button>
        <button
          type="button"
          className="file-nav-btn"
          disabled={historyIndex >= historyStack.length - 1}
          onClick={goForward}
        >
          <ChevronRightIcon />
        </button>
        <nav className="file-nav-crumbs" aria-label="文件路径">
          <button type="button" className="file-nav-crumb" onClick={() => navigateTo("")}>
            ~
          </button>
          {dir.split("/").filter(Boolean).map((seg, i, arr) => {
            const target = arr.slice(0, i + 1).join("/");
            const last = i === arr.length - 1;
            return (
              <span key={target} className="file-nav-crumb-sep">
                /
                {last ? (
                  <span className="file-nav-crumb is-current">{seg}</span>
                ) : (
                  <button
                    type="button"
                    className="file-nav-crumb"
                    onClick={() => navigateTo(target)}
                  >
                    {seg}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
      </div>
    )}
    <ArtifactFileManager
      artifacts={artifacts}
      // 懒加载下一层时保留文件管理器，不要用全屏加载态替换整个内容区。
      loading={loading && !initialLoadComplete}
      error={false}
      onRetry={refresh}
      onRefresh={refresh}
      // 本机文件走 local-file:// 协议；面板还会往后拼 &download=1 / &t=…，所以先带上 ?v=1 占位。
      buildUrl={(id) => localFileUrl(joinHome(home, id), "?v=1")}
      previewFull={expanded}
      onToggleFullscreen={() => setExpanded((value) => !value)}
      desktopApp
      // 双击文件：一律用系统默认应用打开，不在组件内部预览
      onOpenFile={(meta) => {
        const absPath = joinHome(home, meta.rel);
        void window.agentHost.openPath(absPath);
      }}
      onOpenDir={(target) => { void window.launcher.revealPath(target); }}
      onZipFolder={(rel) => { void window.launcher.revealPath(rel); }}
      onRenameArtifact={(rel, name) => window.launcher.renamePath(rel, name)}
      onMoveArtifact={(rel, destination) => window.launcher.movePath(rel, destination)}
      onDeleteArtifact={(rel) => window.launcher.trashPath(rel)}
      onCreateFolder={(rel, name) => window.launcher.createDirectory(rel, name)}
      // 根目录 = home；进目录时懒加载该层清单
      initialDir={dir}
      onDirectoryChange={handleDirChange}
      onExpandDir={(next) => { void loadDir(next); }}
      defaultView={view ?? "icons"}
      onViewChange={handleViewChange}
      // 小组件空间小，顶部工具栏整个去掉：视图切换挪到右键菜单的「显示模式」。
      hideToolbar
      // 本机目录不提供「新建文件夹 / 刷新」入口（工具栏已隐藏，右键菜单里也一并去掉）。
      allowCreateFolder={false}
      // 记住的目录失效时（被删）换个 key 重挂，好让 kit 回到 home
      key={resetKey}
    />
  </div>;
}
