import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent } from "react";
import { ARTIFACT_FILE_MIME, Markdown, SessionPickerDialog, AGENT_SESSION_UPDATED_EVENT, DeleteIcon, EditIcon, RefreshIcon, useClickOutside, type SessionCardSnapshot, type SessionPickerEntry, type UiAttachment } from "@turingflow/agent-kit/ui";
import type { DesktopSessionGroup } from "../../../shared/types";
import { useLauncher } from "../state";
import { readDraggedFiles, toLocalAttachments } from "../fileDrop";
import { BUILTIN_WALLPAPER, wallpaperCss } from "../wallpapers";
import Dock from "../dock/Dock";
import { desktopGrid, firstFreePlacement, fitPlacement, nearestFreePlacement, placeWidgets, placementsOverlap, widgetExtent, type GridPlacement } from "./desktopGrid";
import DesktopRefreshRunner from "./DesktopRefreshRunner";
import DesktopSendRunner from "./DesktopSendRunner";
import FileManagerWidget from "./FileManagerWidget";
import StatusBar from "./StatusBar";

const RUNNING_ID = "__running__";
const SESSION_MIME = "application/x-launcher-session";
const AGENT_SESSION_MIME = "application/x-agent-session";
/**
 * 尺寸口径统一按「行 × 列」念：1x2 = 1 行 2 列（横躺），不是 1 列 2 行。
 * 「添加文件管理」与「进行中」都用 1x2 起手，两个组件并排看齐。
 */
const FILE_WIDGET_SIZE = { columns: 2, rows: 1 };
const RUNNING_WIDGET_SIZE = { columns: 2, rows: 1 };
/**
 * 在会话卡片上按住不放多久算「停留」：到点就打开这个会话的聊天窗，
 * 接着松手，文件作为附件进它的输入框（而不是直接发成一条消息）。
 */
const CARD_HOLD_MS = 1000;
/** 闪烁动画时长：2 次快速闪烁后再开窗。 */
const CARD_FLASH_MS = 450;
type Card = { windowId: string; card: SessionCardSnapshot };
type Edge = "right" | "bottom" | "corner";
type LayoutDrag =
  | { kind: "resize"; id: string; edge: Edge; x: number; y: number; placement: GridPlacement }
  | { kind: "move"; id: string; x: number; y: number; placement: GridPlacement; emptySlot?: boolean };
/**
 * 刚添加、还没落盘的组件（草稿）。
 * 添加后先进编辑模式，用户能拖动 / 拉边调整；点「完成」才真的写进桌面状态，
 * 点「取消」或按 Esc 就直接丢弃 —— 所以草稿只在渲染层，不进 launcher 状态。
 */
type PendingWidget = { kind: "running" | "file"; id: string; placement: GridPlacement };
/** 右键菜单：x/y 是菜单弹出的位置（已做视口收敛），point 才是鼠标原始坐标（决定新组件落在哪一格）。 */
type MenuState = { x: number; y: number; point: { x: number; y: number } };
type GroupMenuState = { id: string; kind: "running" | "group" | "file"; x: number; y: number };
/** 一次「拖文件进会话」的投递任务：交给隐藏的发送器去发。 */
type SendJob = { id: string; sessionId: string; nonce: number; attachments: UiAttachment[] };

function CardHistory({ history, lastText }: Pick<SessionCardSnapshot, "history" | "lastText">) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const draggingScrollbar = useRef(false);
  const [scrollDrag, setScrollDrag] = useState(false);
  const [thumb, setThumb] = useState({ top: 0, height: 0, scrollable: false });
  // 是否已滚离顶部：只有滚离顶部时才在内容顶端启用渐隐蒙版（见 .desktop-card-preview.is-scrolled），
  // 内容少、整段可见时保持第一行完整清晰。首次挂载会自动滚到最新，因此这里也会立刻变 true。
  const [atTop, setAtTop] = useState(true);
  const syncThumb = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const { clientHeight, scrollHeight, scrollTop } = element;
    const scrollable = scrollHeight > clientHeight + 1;
    const height = scrollable ? Math.max(24, clientHeight * clientHeight / scrollHeight) : clientHeight;
    const top = scrollable ? scrollTop / (scrollHeight - clientHeight) * (clientHeight - height) : 0;
    setThumb({ top, height, scrollable });
    setAtTop(scrollTop <= 1);
  }, []);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && followLatest.current) element.scrollTop = element.scrollHeight;
    syncThumb();
  }, [history, lastText, syncThumb]);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(syncThumb);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [syncThumb]);
  function scrollFromPointer(event: PointerEvent<HTMLDivElement>) {
    const element = scrollRef.current;
    if (!element || !thumb.scrollable) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const travel = Math.max(1, bounds.height - thumb.height);
    const position = Math.max(0, Math.min(travel, event.clientY - bounds.top - thumb.height / 2));
    element.scrollTop = position / travel * (element.scrollHeight - element.clientHeight);
  }
  return <div className="desktop-card-body">
    <div ref={scrollRef} className={`desktop-card-preview${atTop ? "" : " is-scrolled"}`} tabIndex={0} onScroll={(event) => {
      const element = event.currentTarget;
      followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
      syncThumb();
    }}><div className="desktop-card-history-content">{history?.length
      ? history.map((message, index) => <div key={index} className={`desktop-card-message${message.role === "user" ? " is-user" : ""}`}>
        <Markdown content={message.content} />
      </div>)
      : <Markdown content={lastText || "暂无对话"} />}</div></div>
    <div className={`desktop-card-scrollbar${thumb.scrollable ? " is-scrollable" : ""}${scrollDrag ? " is-dragging" : ""}`}
      onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); draggingScrollbar.current = true; setScrollDrag(true); followLatest.current = false; scrollFromPointer(event); }}
      onPointerMove={(event) => { if (draggingScrollbar.current) scrollFromPointer(event); }}
      onPointerUp={(event) => { event.stopPropagation(); draggingScrollbar.current = false; setScrollDrag(false); }}
      onPointerCancel={() => { draggingScrollbar.current = false; setScrollDrag(false); }}
      onDragStart={(event) => event.preventDefault()}>
      <span className="desktop-card-scrollbar-thumb" style={{ height: thumb.height, transform: `translateY(${thumb.top}px)` }} />
    </div>
  </div>;
}

import { DesktopWidget } from "./DesktopWidget";

export default function Desktop() {
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const groups = launcher.sessionGroups ?? [];
  const themeWallpaper = launcher.wallpaper.kind === "builtin" && launcher.wallpaper.value === BUILTIN_WALLPAPER.url;
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const [page, setPage] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenuState | null>(null);
  const [cardMenu, setCardMenu] = useState<{ sessionId: string; groupId: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<{ mode: "create" | "rename"; id?: string; value: string } | null>(null);
  // 会话组溢出（卡片数 > 容量）时的「全部会话」列表：入口收敛到标题右侧的计数徽标，菜单里不再占一项。
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pickerGroup, setPickerGroup] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; placement: GridPlacement } | null>(null);
  /** 正在草稿态的新组件；只有点「完成」才会落进 launcher 状态。 */
  const [pending, setPending] = useState<PendingWidget | null>(null);
  /** 非编辑模式的拖动预览：正常模式下直接拖动分组/文件管理移动，松手即落盘。 */
  const [dragPreview, setDragPreview] = useState<{ id: string; placement: GridPlacement } | null>(null);
  const hoverPreviewRef = useRef<{ id: string; placement: GridPlacement } | null>(null);
  const [hoverGroup, setHoverGroup] = useState<string | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [refreshJobs, setRefreshJobs] = useState<Array<{ sessionId: string; nonce: number }>>([]);
  const [refreshErrors, setRefreshErrors] = useState<Record<string, string>>({});
  /** 「拖文件进会话」的投递任务：每条对应一个隐藏的发送器实例。 */
  const [sendJobs, setSendJobs] = useState<SendJob[]>([]);
  /** 投递失败的原因（按会话 ID 记），直接显示在卡片上。 */
  const [sendErrors, setSendErrors] = useState<Record<string, string>>({});
  /** 正悬停在上面的会话卡片（拖文件进来时高亮）。 */
  const [fileDropTarget, setFileDropTarget] = useState<string | null>(null);
  /** 已经「停留够久」的卡片：松手时文件进它的聊天窗输入框，而不是直接发成消息。 */
  const [heldCard, setHeldCard] = useState<string | null>(null);
  /** 每个卡片上正在计时的「停留」计时器（会话 ID → timer）。 */
  const cardHoldTimers = useRef(new Map<string, number>());
  /** 已经停留够久的会话 ID 集合。 */
  const cardHeld = useRef(new Set<string>());
  const sendNonceRef = useRef(0);
  // 自绘状态栏只在全屏时显示：窗口态下时间/电量/Wi-Fi 由系统任务栏（Win）/菜单栏（macOS）承担。
  const [fullscreen, setFullscreen] = useState(false);
  const layoutDrag = useRef<LayoutDrag | null>(null);

  useEffect(() => {
    let alive = true;
    void window.launcher.isFullscreen().then((next) => { if (alive) setFullscreen(next); }).catch(() => undefined);
    const off = window.launcher.onFullscreenChanged(setFullscreen);
    return () => { alive = false; off(); };
  }, []);

  /**
   * 一次拖拽结束后重置「卡片停留」状态。
   * 卡片上的停留计时是按会话 ID 记的，拖拽结束（dragend，或落在别处的 drop）
   * 必须清掉，否则下一次拖拽会以为"已经停留过"，直接走错分支。
   */
  useEffect(() => {
    const onEnd = () => {
      for (const timer of cardHoldTimers.current.values()) window.clearTimeout(timer);
      cardHoldTimers.current.clear();
      cardHeld.current.clear();
      setHeldCard(null);
      setFileDropTarget(null);
      dispatch({ type: "SET_FILE_ATTACH_HINT", hint: null });
    };
    window.addEventListener("dragend", onEnd);
    window.addEventListener("drop", onEnd);
    return () => {
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("drop", onEnd);
    };
  }, []);

  // Home 侧栏与桌面卡片使用同一组投放目标；侧栏的拖动格式由 agent-kit 提供。
  useEffect(() => {
    let hideFrame: number | null = null;
    const revealHome = () => {
      if (hideFrame !== null) window.cancelAnimationFrame(hideFrame);
      hideFrame = null;
      document.documentElement.classList.remove("is-dragging-home-session");
      setDraggingSessionId(null);
      setHoverGroup(null);
    };
    const onStart = (event: globalThis.DragEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.quick-input.focus-primary .chat-sidebar-item')) return;
      const sessionId = event.dataTransfer?.getData(AGENT_SESSION_MIME);
      if (!sessionId) return;
      setDraggingSessionId(sessionId);
      setHoverGroup(null);
      // Let the browser capture the drag image before making the source window transparent.
      hideFrame = window.requestAnimationFrame(() => {
        hideFrame = null;
        document.documentElement.classList.add("is-dragging-home-session");
      });
    };
    const onDrop = () => document.documentElement.classList.remove("is-dragging-home-session");
    document.addEventListener('dragstart', onStart);
    document.addEventListener('dragend', revealHome);
    document.addEventListener('drop', onDrop, true);
    return () => {
      document.removeEventListener('dragstart', onStart);
      document.removeEventListener('dragend', revealHome);
      document.removeEventListener('drop', onDrop, true);
      revealHome();
    };
  }, []);

  useEffect(() => {
    const update = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Esc 等同「取消」：草稿组件在这里直接丢弃，不进桌面状态。
        setMenu(null); setGroupMenu(null); setDialog(null); setExpanded(null); setPickerGroup(null); setEditing(null); setPending(null);
        return;
      }
      if (event.code !== "Space" || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (!document.hasFocus() || state.view !== "desktop" || state.quickInput || state.focusMode || editing || dialog || expanded || pickerGroup) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.closest("button, input, textarea, select, [contenteditable], [role='button'], [role='textbox']")) return;
      event.preventDefault();
      dispatch({ type: "SET_QUICK_INPUT", open: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, state.view, state.quickInput, state.focusMode, editing, dialog, expanded, pickerGroup]);
  // 桌面右键菜单（桌面/组件组/会话卡片）：点击菜单/组件标题之外任意处关闭
  useClickOutside({
    enabled: Boolean(menu || groupMenu || cardMenu),
    exceptSelectors: [".desktop-context-menu", ".desktop-widget-title"],
    onDismiss: () => { setMenu(null); setGroupMenu(null); setCardMenu(null); },
  });

  const grid = desktopGrid(viewport.width, viewport.height, launcher.autoHideDock ? 0 : undefined);
  const fileWidgets = launcher.fileWidgets ?? [];
  const fileWidgetIds = new Set(fileWidgets.map((widget) => widget.id));
  // 草稿态的「进行中」组件还没有落进 launcher.runningWidget，渲染/排版用 pending 的格位顶上。
  const runningPlacement = pending?.kind === "running" ? pending.placement : launcher.runningWidget;
  const desired = [
    ...(runningPlacement ? [{ id: RUNNING_ID, placement: runningPlacement }] : []),
    ...fileWidgets.map((widget) => ({ id: widget.id, placement: widget.placement })),
    // 草稿文件组件：先按草稿格位排版（与已落盘的组件一起参与避让），完成前不写状态。
    ...(pending?.kind === "file" ? [{ id: pending.id, placement: pending.placement }] : []),
    ...groups.map((group) => ({ id: group.id, placement: group.placement })),
  ];
  const layouts = placeWidgets(grid, desired);
  const activePlacement = editing ? fitPlacement(grid, editing.placement) : null;
  const layoutOf = (id: string) => dragPreview?.id === id ? dragPreview.placement : (editing?.id === id ? activePlacement : layouts.get(id));
  // 编辑态画网格参考线用：所有组件的「实际」占位。走 layoutOf 而不是直接读 layouts，
  // 因为正在拖动/改行列的那个组件的落点在 activePlacement 里（layouts 还是旧值），
  // 否则拖动过程中网格会在旧位置重新长出虚线。
  const occupiedPlacements = [...new Set([...layouts.keys(), ...(editing ? [editing.id] : [])])]
    .map((id) => layoutOf(id))
    .filter((placement): placement is GridPlacement => Boolean(placement));
  const pageCount = Math.max(1, ...[...layouts.values(), ...(activePlacement ? [activePlacement] : [])].map((p) => p.page + 1));
  useEffect(() => { if (page >= pageCount) setPage(pageCount - 1); }, [page, pageCount]);

  const catalog = useMemo(() => {
    const result = new Map<string, Card>();
    for (const session of state.desktopCatalog) result.set(session.id, {
      windowId: "primary",
      card: { sessionId: session.id, title: session.title, lastText: session.lastAssistantText ?? "", history: session.history,
        model: session.modelId ?? "", status: session.aiUnread ? "done" : "idle", updatedAt: session.updatedAt },
    });
    const order = ["primary", ...state.launchedDomains, ...Object.keys(state.sessionCardsByWindow)];
    const priority = { waiting: 4, running: 3, done: 2, idle: 1 };
    for (const windowId of new Set(order)) {
      for (const card of state.sessionCardsByWindow[windowId] ?? []) {
        const previous = result.get(card.sessionId);
        if (!previous || priority[card.status] > priority[previous.card.status]
          || (card.active && card.status === "idle" && previous.card.status === "done")
          || (priority[card.status] === priority[previous.card.status] && card.active && !previous.card.active)) {
          result.set(card.sessionId, { windowId: windowId.startsWith("desktop-refresh-") || windowId.startsWith("desktop-send-") ? "primary" : windowId,
            card: { ...card, history: card.history?.length ? card.history : previous?.card.history } });
        }
      }
    }
    return result;
  }, [state.desktopCatalog, state.sessionCardsByWindow, state.launchedDomains]);
  const owners = new Map(groups.flatMap((group) => group.sessionIds.map((sid) => [sid, group.id] as const)));
  // 进行中是状态视图，不受手动会话组归属影响；完成未读继续显示，已读后自动退出。
  const runningCards = [...catalog.values()].filter((entry) => entry.card.status !== "idle");
  const cardsFor = (id: string): Card[] => id === RUNNING_ID
    ? runningCards
    : (groups.find((group) => group.id === id)?.sessionIds ?? []).map((sid) => catalog.get(sid)).filter((entry): entry is Card => Boolean(entry));

  function canPlace(id: string, candidate: GridPlacement) {
    return [...layouts.entries()].every(([otherId, placement]) => otherId === id || !placementsOverlap(candidate, placement));
  }
  /**
   * 把某个组件的格位写回去。
   * draft=true（拖动 / 翻页这类即时操作）：草稿只改本地 pending，不碰持久化状态。
   * draft=false（点「完成」）：跳过草稿分支直接落盘 —— 新文件组件走 ADD_FILE_WIDGET 入列。
   */
  function writePlacement(id: string, placement: GridPlacement, draft = true) {
    if (draft && pending && id === pending.id) {
      setPending({ ...pending, placement });
      return;
    }
    if (id === RUNNING_ID) dispatch({ type: "SET_RUNNING_WIDGET", widget: placement });
    else if (fileWidgetIds.has(id)) dispatch({ type: "UPDATE_FILE_WIDGET", id, placement });
    else if (groups.some((group) => group.id === id)) dispatch({ type: "UPDATE_SESSION_GROUP", id, placement });
    else dispatch({ type: "ADD_FILE_WIDGET", widget: { id, placement } });
  }
  /** 退出编辑模式：草稿一律丢弃（等同「取消」，没点完成就不该出现在桌面上）。 */
  function leaveEdit() {
    if (pending) setPending(null);
    setEditing(null);
  }
  /** 全局编辑模式：可移动/缩放任意会话组（含进行中组件），拖动即保存；再次调用或点「完成」退出。 */
  function startGlobalEdit() {
    if (editing) { leaveEdit(); return; }
    const first = desired[0];
    if (!first) return;
    const placement = layouts.get(first.id);
    if (!placement) return;
    setEditing({ id: first.id, placement });
    setPage(placement.page);
    setMenu(null); setGroupMenu(null); setCardMenu(null);
  }
  /**
   * 从右键菜单添加组件：先按鼠标位置找最近的空闲格，再把它挂成草稿并立刻进入编辑模式。
   * 用户在编辑模式里调整完点「完成」才写入状态（见 saveEdit），取消则什么都不留。
   */
  function addWidget(kind: PendingWidget["kind"], point: { x: number; y: number }) {
    const size = kind === "running" ? RUNNING_WIDGET_SIZE : FILE_WIDGET_SIZE;
    const occupied = [...layouts.values()];
    const placement = nearestFreePlacement(grid, occupied, size, point, page);
    const id = kind === "running" ? RUNNING_ID : `files-${crypto.randomUUID()}`;
    setPending({ kind, id, placement });
    setEditing({ id, placement });
    setPage(placement.page);
    setMenu(null); setGroupMenu(null); setCardMenu(null);
  }
  function moveEditPage(direction: number) {
    if (!editing) return;
    const nextPage = editing.placement.page + direction;
    if (nextPage < 0) return;
    const occupied = [...layouts.entries()].filter(([id]) => id !== editing.id).map(([, placement]) => placement);
    const candidate = firstFreePlacement(grid, occupied, { ...editing.placement, page: nextPage });
    if (candidate.page !== nextPage) return;
    setEditing({ ...editing, placement: candidate });
    writePlacement(editing.id, candidate);
    setPage(nextPage);
  }
  function startLayoutDrag(id: string, kind: "move" | "resize", event: PointerEvent<HTMLDivElement>, edge?: Edge) {
    if (event.button !== 0) return;
    // 移动：正常模式与编辑模式都直接可用（拖动即保存）；缩放手感仍只在编辑模式提供。
    if (kind === "resize" && !editing) return;
    // 卡片不触发整组移动（卡片自己支持拖拽；整组的移动把手只在顶部标题栏）。
    if (kind === "move" && event.target instanceof Element && event.target.closest(".desktop-session-card")) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    // 编辑模式下允许拖动任意组件：拖的不是当前激活组时，先切换激活到该组。
    if (editing && editing.id !== id) {
      const target = layouts.get(id);
      if (!target) return;
      setEditing({ id, placement: target });
    }
    const placement = (editing?.id === id ? activePlacement : null) ?? layouts.get(id);
    if (!placement) return;
    layoutDrag.current = kind === "move"
      ? { kind, id, x: event.clientX, y: event.clientY, placement,
        emptySlot: false }
      : { kind, id, edge: edge!, x: event.clientX, y: event.clientY, placement };
  }
  function moveLayoutDrag(event: PointerEvent<HTMLDivElement>) {
    const start = layoutDrag.current;
    if (!start) return;
    const dx = Math.round((event.clientX - start.x) / (grid.cardWidth + grid.columnGap));
    const dy = Math.round((event.clientY - start.y) / (grid.cardHeight + grid.rowGap));
    const candidate = fitPlacement(grid, start.kind === "move"
      ? { ...start.placement, column: start.placement.column + dx, row: start.placement.row + dy }
      : { ...start.placement,
        columns: start.edge === "bottom" ? start.placement.columns : Math.max(1, Math.min(grid.columns - start.placement.column, start.placement.columns + dx)),
        rows: start.edge === "right" ? start.placement.rows : Math.max(1, Math.min(grid.rows - start.placement.row, start.placement.rows + dy)) });
    // 空间不够（目标格位被其他组件占据）时不更新预览 → 松手位置不变，不会移动过去。
    if (canPlace(start.id, candidate)) {
      hoverPreviewRef.current = { id: start.id, placement: candidate };
      setDragPreview({ id: start.id, placement: candidate });
      if (editing) setEditing({ id: start.id, placement: candidate });
    }
  }
  function finishLayoutDrag(save: boolean, event?: PointerEvent<HTMLDivElement>): string | null {
    const drag = layoutDrag.current;
    layoutDrag.current = null;
    setDragPreview(null);
    const preview = hoverPreviewRef.current;
    hoverPreviewRef.current = null;
    if (!save || !drag || !preview || preview.id !== drag.id) return null;
    const before = drag.placement;
    const after = preview.placement;
    if (before.column === after.column && before.row === after.row && before.columns === after.columns && before.rows === after.rows) return null;
    // 草稿只更新本地格位；已落盘的组件（含正常模式直接拖动）移动即保存。
    writePlacement(drag.id, after);
    // 全局编辑模式：拖动即保存，保持编辑状态以便继续调整其他组件。
    if (editing) setEditing({ id: drag.id, placement: after });
    return null;
  }
  function saveEdit() {
    if (!editing) return;
    const occupied = [...layouts.entries()].filter(([id]) => id !== editing.id).map(([, placement]) => placement);
    const placement = canPlace(editing.id, activePlacement!) ? activePlacement! : firstFreePlacement(grid, occupied, activePlacement!);
    // 「完成」是草稿唯一真正落盘的时机：文件组件新入列，进行中组件写 runningWidget。
    writePlacement(editing.id, placement, false);
    setPending(null);
    setEditing(null);
  }
  function openCard(entry: Card) {
    if (!editing) dispatch({ type: "OPEN_NOTIFICATION_SESSION", windowId: entry.windowId, sessionId: entry.card.sessionId, nonce: Date.now() });
  }
  /** 取消某张卡片上还没到点的「停留」计时（指针提前挪走了）。 */
  function clearCardHold(sessionId: string) {
    const timer = cardHoldTimers.current.get(sessionId);
    if (timer == null) return;
    window.clearTimeout(timer);
    cardHoldTimers.current.delete(sessionId);
  }
  function refreshCard(entry: Card) {
    if (editing || entry.card.status === "running" || entry.card.status === "waiting") return;
    const sessionId = entry.card.sessionId;
    setRefreshErrors((current) => { const next = { ...current }; delete next[sessionId]; return next; });
    setRefreshJobs((current) => current.some((job) => job.sessionId === sessionId)
      ? current : [...current, { sessionId, nonce: Date.now() + Math.random() }]);
  }
  function beginCardDrag(entry: Card, event: DragEvent<HTMLElement>) {
    event.dataTransfer.setData(SESSION_MIME, entry.card.sessionId);
    event.dataTransfer.effectAllowed = "move";
    setHoverGroup(null);
    setDraggingSessionId(entry.card.sessionId);
  }
  function dropCard(targetId: string, event: DragEvent<HTMLElement>, explicitIndex?: number) {
    event.preventDefault(); event.stopPropagation();
    setHoverGroup(null);
    setDraggingSessionId(null);
    const sid = event.dataTransfer.getData(SESSION_MIME) || event.dataTransfer.getData(AGENT_SESSION_MIME);
    const entry = catalog.get(sid);
    if (!sid || (targetId === RUNNING_ID && (!entry || entry.card.status === "idle"))) return;
    if (targetId !== RUNNING_ID && !groups.some((group) => group.id === targetId)) return;
    const cardElement = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-card-index]") : null;
    const targetGroup = groups.find((group) => group.id === targetId);
    const cardIndex = cardElement && targetGroup ? targetGroup.sessionIds.indexOf(cardElement.dataset.sessionId ?? "") : NaN;
    const after = cardElement && event.clientX > cardElement.getBoundingClientRect().left + cardElement.getBoundingClientRect().width / 2;
    let index = explicitIndex ?? (Number.isFinite(cardIndex) && cardIndex >= 0 ? cardIndex + (after ? 1 : 0) : undefined);
    const sourceIndex = targetGroup?.sessionIds.indexOf(sid) ?? -1;
    if (explicitIndex === undefined && index !== undefined && sourceIndex >= 0 && index > sourceIndex) index--;
    dispatch({ type: "MOVE_SESSION_TO_GROUP", sessionId: sid, groupId: targetId === RUNNING_ID ? null : targetId, index });
    // A freshly created Home session may not yet be in the desktop catalog.
    if (!entry) void window.launcher.listDesktopSessions()
      .then((sessions) => dispatch({ type: "SET_DESKTOP_CATALOG", sessions }))
      .catch((error) => console.error("[launcher] 刷新桌面会话目录失败：", error));
  }
  /**
   * 把文件管理组件里的文件拖到会话卡片上释放：
   * 在这个会话末尾发一条只带该文件附件的消息。
   *
   * 附件必须走 local-ref:// 句柄（会话消息与本机 Agent 服务只认这个），
   * 所以先让主进程把相对 home 的 rel 登记成引用，再交给隐藏的发送器发出去。
   */
  async function dropFilesOnSession(sessionId: string, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setFileDropTarget(null);
    const files = readDraggedFiles(event.dataTransfer);
    if (!files.length) return;
    setSendErrors((current) => { const next = { ...current }; delete next[sessionId]; return next; });
    try {
      const attachments = await toLocalAttachments(files);
      if (!attachments.length) { setSendErrors((current) => ({ ...current, [sessionId]: "文件不可用" })); return; }
      sendNonceRef.current += 1;
      setSendJobs((current) => [...current, { id: crypto.randomUUID(), sessionId, nonce: sendNonceRef.current, attachments }]);
    } catch (error) {
      console.error("[launcher] 拖拽文件进会话失败：", error);
      setSendErrors((current) => ({ ...current, [sessionId]: "文件不可用" }));
    }
  }
  /**
   * 在卡片上**停留够久**再松手：那个会话的聊天窗已经被打开了，
   * 文件作为**待发附件**进它的输入框（不发送，用户可以接着打字再发）。
   *
   * 与「拖到卡片立即释放 = 直接发一条只含附件的消息」是两条并存的分支：
   * 停没停留决定落点是「消息」还是「输入框」。
   */
  async function dropFilesIntoComposer(entry: Card, event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.stopPropagation();
    setFileDropTarget(null);
    setHeldCard(null);
    dispatch({ type: "SET_FILE_ATTACH_HINT", hint: null });
    // drop 事件一返回 dataTransfer 就被清空：载荷当场读。
    const files = readDraggedFiles(event.dataTransfer);
    if (!files.length) return;
    try {
      const attachments = await toLocalAttachments(files);
      if (!attachments.length) return;
      dispatch({
        type: "QUEUE_ATTACH_REQUEST",
        windowId: entry.windowId,
        sessionId: entry.card.sessionId,
        attachments,
      });
    } catch (error) {
      console.error("[launcher] 拖拽文件进会话输入框失败：", error);
    }
  }
  function submitDialog() {
    if (!dialog?.value.trim()) return;
    if (dialog.mode === "rename" && dialog.id) {
      dispatch({ type: "UPDATE_SESSION_GROUP", id: dialog.id, title: dialog.value.trim() });
    } else {
      const id = `group-${crypto.randomUUID()}`;
      const placement = firstFreePlacement(grid, [...layouts.values()], { columns: 3, rows: 1, page });
      const group: DesktopSessionGroup = { id, title: dialog.value.trim(), placement, sessionIds: [] };
      dispatch({ type: "ADD_SESSION_GROUP", group });
      setPage(placement.page);
    }
    setDialog(null);
  }
  function contextMenu(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest(".dock-zone, .desktop-running-widget, .desktop-edit-toolbar, .desktop-context-menu")) return;
    event.preventDefault();
    // point 保留鼠标原始坐标：菜单本身会被视口收敛，但新组件要落在用户右键的那一格附近。
    setMenu({
      x: Math.max(8, Math.min(event.clientX, viewport.width - 200)),
      y: Math.max(8, Math.min(event.clientY, viewport.height - 145)),
      point: { x: event.clientX, y: event.clientY },
    });
  }

  /** 网格格位 -> 绝对像素盒（会话组与文件管理组件共用）。 */
  function widgetBox(placement: GridPlacement) {
    return {
      left: grid.left + placement.column * (grid.cardWidth + grid.columnGap),
      top: grid.top + placement.row * (grid.cardHeight + grid.rowGap),
      width: widgetExtent(placement.columns, grid.cardWidth, grid.columnGap),
      height: widgetExtent(placement.rows, grid.cardHeight, grid.rowGap),
    };
  }
  /** 三条缩放手柄：只在编辑模式下挂出来（非激活组靠 CSS hover 显形）。 */
  function resizeHandles(id: string) {
    return <>
      <div className="desktop-widget-resize is-right" role="separator" aria-label="调整列数" onPointerDown={(event) => startLayoutDrag(id, "resize", event, "right")} />
      <div className="desktop-widget-resize is-bottom" role="separator" aria-label="调整行数" onPointerDown={(event) => startLayoutDrag(id, "resize", event, "bottom")} />
      <div className="desktop-widget-resize is-corner" role="separator" aria-label="调整行列数" onPointerDown={(event) => startLayoutDrag(id, "resize", event, "corner")} />
    </>;
  }

  function renderWidget(id: string, title: string, entries: Card[], placement: GridPlacement) {
    if (placement.page !== page) return null;
    const isEditing = editing?.id === id;
    // 空槽位可点：非编辑态、非「进行中」组的空位点击后打开选会话 dialog。
    const canAdd = !isEditing && id !== RUNNING_ID;
    const capacity = placement.columns * placement.rows;
    const slotStyle = {
      gridTemplateColumns: `repeat(${placement.columns}, minmax(0, 1fr))`,
      gridTemplateRows: `repeat(${placement.rows}, minmax(0, 1fr))`,
      columnGap: grid.columnGap, rowGap: grid.rowGap,
    } satisfies CSSProperties;
    return <DesktopWidget
      key={id}
      id={id}
      className={`${id === RUNNING_ID ? " is-running" : ""}${isEditing ? " is-editing" : ""}${hoverGroup === id ? " is-drop-target" : ""}${entries.length === 0 ? " is-empty" : ""}`}
      style={widgetBox(placement)}
      title={title}
      extra={editing ? `${placement.rows} 行 × ${placement.columns} 列` : null}
      count={entries.length > capacity ? { total: entries.length, onClick: () => setExpanded(id) } : null}
      onOpenMenu={(x, y) => setGroupMenu({ id, kind: id === RUNNING_ID ? "running" : "group", x, y })}
      onContextMenu={(event) => {
        event.preventDefault(); event.stopPropagation();
        if (editing) return;
        setGroupMenu({ id, kind: id === RUNNING_ID ? "running" : "group", x: Math.min(event.clientX, viewport.width - 200), y: Math.min(event.clientY, viewport.height - 120) });
      }}
      onDragOver={(event) => {
        if (editing || ![SESSION_MIME, AGENT_SESSION_MIME].some((mime) => event.dataTransfer.types.includes(mime))) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = event.dataTransfer.types.includes(SESSION_MIME) ? "move" : "copy";
        if (hoverGroup !== id) setHoverGroup(id);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setHoverGroup(null); }}
      onDrop={(event) => dropCard(id, event)}
      moveLayoutDrag={moveLayoutDrag}
      finishLayoutDrag={(moved, event) => { const targetGroup = finishLayoutDrag(moved, event); if (targetGroup) setPickerGroup(targetGroup); }}
      startLayoutDrag={startLayoutDrag}
    >
      <div className="desktop-widget-slots" style={slotStyle}>
        {Array.from({ length: capacity }, (_, index) => {
          const entry = entries[index];
          const refreshing = entry ? refreshJobs.some((job) => job.sessionId === entry.card.sessionId) : false;
          return entry ? <div key={entry.card.sessionId} data-card-index={index} data-session-id={entry.card.sessionId} className={`desktop-session-card${draggingSessionId === entry.card.sessionId ? " is-dragging" : ""}${fileDropTarget === entry.card.sessionId ? " is-file-drop" : ""}${heldCard === entry.card.sessionId ? " is-held" : ""}`}
            draggable={!editing}
            onDragStart={(event) => beginCardDrag(entry, event)}
            onDragEnd={() => { setHoverGroup(null); setDraggingSessionId(null); setFileDropTarget(null); }}
            /* 从文件管理组件拖文件进来：两条分支并存 ——
               · 立即松手 → 在这个会话末尾发一条只带附件的消息；
               · 停留满 2 秒 → 先打开这个会话的聊天窗，松手后文件作为附件进它的输入框。 */
            onDragOver={(event) => {
              if (editing || !event.dataTransfer.types.includes(ARTIFACT_FILE_MIME)) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
              if (fileDropTarget !== entry.card.sessionId) setFileDropTarget(entry.card.sessionId);
              // 停留计时：按住不放满 1 秒先闪烁提示，闪烁结束后再打开聊天窗。
              if (!cardHoldTimers.current.has(entry.card.sessionId)) {
                const timer = window.setTimeout(() => {
                  cardHoldTimers.current.delete(entry.card.sessionId);
                  // 先开始闪烁动画（设置 is-held 类触发 CSS 动画）
                  setHeldCard(entry.card.sessionId);
                  // 闪烁播完后再开窗 + 标记 cardHeld（松手进输入框的判定）
                  window.setTimeout(() => {
                    cardHeld.current.add(entry.card.sessionId);
                    // 提示挂在刚打开的聊天窗上：闪烁是**开窗前**的反馈，气泡是**开窗后**的 ——
                    // 窗口一打开，那张「进行中」卡片往往就从桌面消失了，气泡是此刻唯一的视觉锚点，
                    // 明确告诉用户「松手是进输入框，不是发成一条消息」。
                    dispatch({ type: "SET_FILE_ATTACH_HINT", hint: { windowId: entry.windowId, sessionId: entry.card.sessionId } });
                    openCard(entry);
                  }, CARD_FLASH_MS);
                }, CARD_HOLD_MS);
                cardHoldTimers.current.set(entry.card.sessionId, timer);
              }
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setFileDropTarget((current) => current === entry.card.sessionId ? null : current);
              // 提前挪走 = 没停留够：撤掉计时（已经到点开过窗的不撤）。
              clearCardHold(entry.card.sessionId);
            }}
            onDrop={(event) => {
              if (cardHeld.current.has(entry.card.sessionId)) { void dropFilesIntoComposer(entry, event); return; }
              void dropFilesOnSession(entry.card.sessionId, event);
            }}
            onDoubleClick={() => openCard(entry)}
            onContextMenu={(event) => {
              event.preventDefault(); event.stopPropagation();
              if (editing) return;
              setCardMenu({ sessionId: entry.card.sessionId, groupId: id, x: event.clientX, y: event.clientY });
            }}>
            <div className="desktop-card-title">{entry.card.title || "新会话"}</div>
            {/* 运行/结束状态不再占一整行：角标挂在卡片右上角外侧，运行中转圈，跑完原地变绿点。 */}
            {(refreshing || entry.card.status === "running" || entry.card.status === "waiting") && <span
              className="desktop-card-status is-running"
              role="status"
              title={entry.card.progress || (refreshing ? "准备刷新" : "正在运行")}
              aria-label={entry.card.progress || (refreshing ? "准备刷新" : "正在运行")}
            />}
            {!refreshing && entry.card.status === "done" && <span className="desktop-card-status is-done" title="未读" aria-label="未读" />}
            {refreshErrors[entry.card.sessionId] && <div className="desktop-card-refresh-error" role="alert">刷新失败：{refreshErrors[entry.card.sessionId]}</div>}
            {sendErrors[entry.card.sessionId] && <div className="desktop-card-send-error" role="alert">发送失败：{sendErrors[entry.card.sessionId]}</div>}
            <CardHistory history={entry.card.history} lastText={entry.card.lastText} />
          </div> : <div key={index}
            className={`desktop-widget-empty${canAdd ? " is-addable" : ""}`}
            role={canAdd ? "button" : undefined}
            tabIndex={canAdd ? 0 : undefined}
            /* 用 aria-label 而不是 title：原生 title 会在悬停时飘一条系统 tooltip，
               而卡片上已经有「＋ 添加会话」的可见提示，两条叠在一起很噪。 */
            aria-label={canAdd ? "添加会话" : undefined}
            onClick={canAdd ? (event) => { event.stopPropagation(); setPickerGroup(id); } : undefined}
            onKeyDown={canAdd ? (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault(); event.stopPropagation(); setPickerGroup(id);
            } : undefined}>
            {/* 空组给一条可点击提示，避免用户不知道空卡片能点。 */}
            {canAdd && entries.length === 0 && index === 0 && <span className="desktop-widget-empty-hint">＋ 添加会话</span>}
          </div>;
        })}
      </div>
      {editing && resizeHandles(id)}
    </DesktopWidget>;
  }

  /**
   * 文件管理组件：与会话组共用同一套网格 / 拖动 / 缩放手感，但内部没有卡片概念。
   * 内容区放的是 kit 的 Finder 风格文件管理器（根目录 = 用户 home）。
   */
  function renderFileWidget(id: string, placement: GridPlacement) {
    if (placement.page !== page) return null;
    const isEditing = editing?.id === id;
    const saved = fileWidgets.find((widget) => widget.id === id);
    return <DesktopWidget
      key={id}
      id={id}
      className={`desktop-file-widget${isEditing ? " is-editing" : ""}`}
      style={widgetBox(placement)}
      title="文件管理"
      extra={editing ? `${placement.rows} 行 × ${placement.columns} 列` : null}
      onOpenMenu={(x, y) => setGroupMenu({ id, kind: "file", x, y })}
      onContextMenu={(event) => {
        event.preventDefault(); event.stopPropagation();
        if (editing) return;
        setGroupMenu({ id, kind: "file", x: Math.min(event.clientX, viewport.width - 200), y: Math.min(event.clientY, viewport.height - 120) });
      }}
      moveLayoutDrag={moveLayoutDrag}
      finishLayoutDrag={finishLayoutDrag}
      startLayoutDrag={startLayoutDrag}
    >
      <div className="desktop-file-body">{isEditing ? null : <FileManagerWidget
        dir={saved?.dir}
        view={saved?.view}
        onViewChange={(next) => dispatch({ type: "UPDATE_FILE_WIDGET", id, view: next })}
        onDirChange={(next) => { if (next !== (saved?.dir ?? "")) dispatch({ type: "UPDATE_FILE_WIDGET", id, dir: next }); }}
      />}</div>
      {editing && resizeHandles(id)}
    </DesktopWidget>;
  }

  const expandedCards = expanded ? cardsFor(expanded) : [];
  const expandedTitle = expanded === RUNNING_ID ? "进行中" : groups.find((group) => group.id === expanded)?.title ?? "";
  const pickerEntries: SessionPickerEntry[] = [...catalog.values()]
    .filter((entry) => owners.get(entry.card.sessionId) !== pickerGroup)
    .sort((a, b) => String(b.card.updatedAt ?? "").localeCompare(String(a.card.updatedAt ?? "")))
    .map((entry) => {
      const owner = owners.get(entry.card.sessionId);
      return { id: entry.card.sessionId, title: entry.card.title || "新会话", preview: entry.card.lastText,
        detail: owner ? `来自 ${groups.find((group) => group.id === owner)?.title ?? "其他组"}` : null,
        updatedAt: entry.card.updatedAt, unread: entry.card.status === "done" };
    });
  return <div className="desktop" style={{ backgroundImage: wallpaperCss(launcher.wallpaper) }}
    onMouseDown={() => { if (state.quickInput && !state.focusMode) dispatch({ type: "CLOSE_CHAT" }); }}
    onContextMenu={contextMenu}>
    {/* macOS hidden title bar: reserve a native drag strip without covering traffic lights. */}
    {window.launcher.platform === "darwin" && !fullscreen && <div className="mac-window-drag-bar" aria-hidden="true" />}
    {themeWallpaper && <div className="desktop-light-wallpaper" style={{ backgroundImage: 'url("wallpapers/default-light.svg")' }} aria-hidden="true" />}
    {/* 右上角系统状态栏：只在全屏时显示；非全屏态由系统任务栏/菜单栏承担。
        桌面卡片网格仍按原高度留白（MENU_BAR_HEIGHT 未动），已摆放的卡片位置不受影响。 */}
    {fullscreen && <StatusBar />}
    {editing && <div className="desktop-grid-guide" aria-hidden="true" style={{
      left: grid.left, top: grid.top,
      width: widgetExtent(grid.columns, grid.cardWidth, grid.columnGap),
      height: widgetExtent(grid.rows, grid.cardHeight, grid.rowGap),
      gridTemplateColumns: `repeat(${grid.columns}, ${grid.cardWidth}px)`,
      gridAutoRows: grid.cardHeight, columnGap: grid.columnGap, rowGap: grid.rowGap,
    }}>{Array.from({ length: grid.columns * grid.rows }, (_, i) => {
      const column = i % grid.columns;
      const row = Math.floor(i / grid.columns);
      // 被组件占住的格子不画：组件里的虚线改由卡片自己带（见 styles-launcher.css 的 is-editing 规则）。
      // 这层网格按 cardWidth 画格子，而卡片被 slots 的 12/8/8 padding 内缩了一圈，
      // 两者永远差 8~12px —— 留在组件下面就是用户看到的「虚线画到了卡片外面」。
      const covered = occupiedPlacements.some((placement) => placement.page === page
        && column >= placement.column && column < placement.column + placement.columns
        && row >= placement.row && row < placement.row + placement.rows);
      return <span key={i} className={covered ? "is-covered" : undefined} />;
    })}</div>}
    {runningPlacement && layoutOf(RUNNING_ID) && renderWidget(RUNNING_ID, "进行中", runningCards, layoutOf(RUNNING_ID)!)}
    {fileWidgets.map((widget) => {
      const placement = layoutOf(widget.id);
      return placement ? renderFileWidget(widget.id, placement) : null;
    })}
    {pending?.kind === "file" && layoutOf(pending.id) && renderFileWidget(pending.id, layoutOf(pending.id)!)}
    {groups.map((group) => {
      const placement = layoutOf(group.id);
      return placement ? renderWidget(group.id, group.title, cardsFor(group.id), placement) : null;
    })}
    {refreshJobs.map((job) => <DesktopRefreshRunner key={job.nonce} {...job} onFinished={(sessionId, error) => {
      setRefreshJobs((current) => current.filter((item) => item.nonce !== job.nonce));
      if (error) setRefreshErrors((current) => ({ ...current, [sessionId]: error }));
      else window.dispatchEvent(new CustomEvent(AGENT_SESSION_UPDATED_EVENT, { detail: { sessionId } }));
    }} />)}
    {/* 拖文件进会话：每个任务一个隐藏的发送器，发完这一轮就卸载。 */}
    {sendJobs.map((job) => <DesktopSendRunner key={job.id} sessionId={job.sessionId} nonce={job.nonce} text="" attachments={job.attachments} onFinished={(sessionId, error) => {
      setSendJobs((current) => current.filter((item) => item.id !== job.id));
      if (error) setSendErrors((current) => ({ ...current, [sessionId]: error }));
      else window.dispatchEvent(new CustomEvent(AGENT_SESSION_UPDATED_EVENT, { detail: { sessionId } }));
    }} />)}
    {pageCount > 1 && !editing && <div className="desktop-page-nav" onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" disabled={page <= 0} onClick={() => setPage(page - 1)} aria-label="上一页">‹</button>
      <span>{page + 1} / {pageCount}</span>
      <button type="button" disabled={page >= pageCount - 1} onClick={() => setPage(page + 1)} aria-label="下一页">›</button>
    </div>}
    {editing && <div className="desktop-edit-toolbar" onMouseDown={(event) => event.stopPropagation()}>
      {/* 只有一页时不必出现翻页按钮；提示文案也尽量短 —— 工具栏浮在右上角，
          太长会盖住紧邻它的组件标题（尤其是刚添加、正压在第一行的文件管理组件）。 */}
      <span>{pending ? "点「完成」才会添加到桌面" : "拖动组件移动，拖动边缘调整格数"}</span>
      {pageCount > 1 && <>
        <button type="button" disabled={editing.placement.page <= 0} onClick={() => moveEditPage(-1)}>上一页</button>
        <button type="button" onClick={() => moveEditPage(1)}>下一页</button>
      </>}
      {/* 草稿态下「退出」就是「取消」：没点完成，组件不会留在桌面上。 */}
      <button type="button" onClick={leaveEdit}>{pending ? "取消" : "退出"}</button>
      <button type="button" className="is-primary" onClick={saveEdit}>完成</button>
    </div>}
    {menu && <div className="desktop-context-menu" role="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(event) => event.stopPropagation()}>
      {/* 草稿未完成时不再放出「添加」入口：先完成/取消，避免桌面上同时挂两个草稿。 */}
      {!runningPlacement && !pending && <button type="button" role="menuitem" onClick={() => addWidget("running", menu.point)}>添加进行中组件</button>}
      {!pending && <button type="button" role="menuitem" onClick={() => addWidget("file", menu.point)}>添加文件管理</button>}
      <button type="button" role="menuitem" onClick={() => { setDialog({ mode: "create", value: "" }); setMenu(null); }}>新建会话组</button>
      <button type="button" role="menuitem" onClick={() => startGlobalEdit()}>{editing ? "退出编辑模式" : "编辑模式"}</button>
    </div>}
    {groupMenu && <div className="desktop-context-menu" role="menu" style={{ left: groupMenu.x, top: groupMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
      {groupMenu.kind === "running" && <button type="button" role="menuitem" className="has-icon" onClick={() => { dispatch({ type: "SET_RUNNING_WIDGET", widget: undefined }); setGroupMenu(null); }}>
        <DeleteIcon className="desktop-menu-icon" />
        <span>移除进行中组件</span>
      </button>}
      {groupMenu.kind === "file" && <button type="button" role="menuitem" className="has-icon" onClick={() => { dispatch({ type: "DELETE_FILE_WIDGET", id: groupMenu.id }); setGroupMenu(null); }}>
        <DeleteIcon className="desktop-menu-icon" />
        <span>移除文件管理</span>
      </button>}
      {groupMenu.kind === "group" && <>
        <button type="button" role="menuitem" className="has-icon" onClick={() => { const group = groups.find((item) => item.id === groupMenu.id); if (group) setDialog({ mode: "rename", id: group.id, value: group.title }); setGroupMenu(null); }}>
          <EditIcon className="desktop-menu-icon" />
          <span>重命名</span>
        </button>
        <button type="button" role="menuitem" className="has-icon" onClick={() => { dispatch({ type: "DELETE_SESSION_GROUP", id: groupMenu.id }); setGroupMenu(null); }}>
          <DeleteIcon className="desktop-menu-icon" />
          <span>移除会话组</span>
        </button>
      </>}
    </div>}
    {cardMenu && (() => {
      const entry = catalog.get(cardMenu.sessionId);
      const history = entry?.card.history ?? [];
      const hasUserMessage = history.some((message) => message.role === "user");
      const disabled = !entry || entry.card.status === "running" || entry.card.status === "waiting" || !hasUserMessage;
      return <div className="desktop-context-menu" role="menu" style={{ left: cardMenu.x, top: cardMenu.y }} onMouseDown={(event) => event.stopPropagation()}>
        {/* 顺序：先「重发」（最常用的动作），再「移除此会话」（破坏性动作放最后）。图标复用 kit 的 action 图标。 */}
        <button type="button" role="menuitem" className="has-icon" disabled={disabled} onClick={() => {
          const current = catalog.get(cardMenu.sessionId);
          if (current) refreshCard(current);
          setCardMenu(null);
        }}>
          <RefreshIcon className="desktop-menu-icon" />
          <span>{entry?.card.status === "running" || entry?.card.status === "waiting" ? "会话正在运行" : hasUserMessage ? "重发最后一条消息" : "没有可重发的消息"}</span>
        </button>
        {cardMenu.groupId !== RUNNING_ID && <button type="button" role="menuitem" className="has-icon" onClick={() => {
          dispatch({ type: "MOVE_SESSION_TO_GROUP", sessionId: cardMenu.sessionId, groupId: null });
          setCardMenu(null);
        }}>
          <DeleteIcon className="desktop-menu-icon" />
          <span>移除此会话</span>
        </button>}
      </div>;
    })()}
    {dialog && <div className="desktop-modal-backdrop" onMouseDown={(event) => event.stopPropagation()} onClick={() => setDialog(null)}>
      <form className="desktop-name-dialog" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); submitDialog(); }}>
        <h3>{dialog.mode === "create" ? "新建会话组" : "重命名会话组"}</h3>
        <input autoFocus maxLength={40} value={dialog.value} onChange={(event) => setDialog({ ...dialog, value: event.target.value })} placeholder="例如：客户项目" />
        <div><button type="button" onClick={() => setDialog(null)}>取消</button><button type="submit" className="is-primary" disabled={!dialog.value.trim()}>保存</button></div>
      </form>
    </div>}
    {expanded && <div className="desktop-modal-backdrop" onMouseDown={(event) => event.stopPropagation()} onClick={() => setExpanded(null)}>
      <div className="desktop-group-list" onClick={(event) => event.stopPropagation()}>
        <header><h3>{expandedTitle} · {expandedCards.length}</h3><span>{expanded !== RUNNING_ID && <button type="button" className="desktop-group-add" onClick={() => { setPickerGroup(expanded); setExpanded(null); }}>添加会话</button>}<button type="button" onClick={() => setExpanded(null)} aria-label="关闭">×</button></span></header>
        <div className="desktop-group-list-body">{expandedCards.length ? expandedCards.map((entry, index) => <div key={entry.card.sessionId} className="desktop-group-list-row">
          <button type="button" onClick={() => { setExpanded(null); openCard(entry); }}>{entry.card.title || "新会话"}<small>{entry.card.status === "done" ? "未读" : entry.card.lastText}</small></button>
          {expanded !== RUNNING_ID && <span><button type="button" disabled={index === 0} onClick={() => dispatch({ type: "MOVE_SESSION_TO_GROUP", sessionId: entry.card.sessionId, groupId: expanded, index: index - 1 })} aria-label="上移">↑</button><button type="button" disabled={index === expandedCards.length - 1} onClick={() => dispatch({ type: "MOVE_SESSION_TO_GROUP", sessionId: entry.card.sessionId, groupId: expanded, index: index + 1 })} aria-label="下移">↓</button></span>}
        </div>) : <p>暂无会话</p>}</div>
      </div>
    </div>}
    {pickerGroup && <SessionPickerDialog title={`添加到${groups.find((group) => group.id === pickerGroup)?.title ?? "会话组"}`}
      sessions={pickerEntries} onClose={() => setPickerGroup(null)} onSelect={(sessionId) => {
        dispatch({ type: "MOVE_SESSION_TO_GROUP", sessionId, groupId: pickerGroup });
        setPickerGroup(null);
      }} />}
    <Dock />
  </div>;
}
