"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Dispatch, type DragEvent as ReactDragEvent, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import SessionErrorIndicator from "../components/SessionErrorIndicator.tsx";
import { PinIcon, SearchIcon, CheckIcon } from "../icons/SharedIcons.tsx";
import { LoadingState } from "../components/LoadingState.tsx";
import { imeCompositionEnd, imeCompositionStart, isImeConfirmKey } from "../shared/ime.ts";
import { DRAFT_CHANGED_EVENT, readChatDraft } from "../shared/drafts.ts";
import { messagePreviewText, sessionFilePreview } from "../chat/messageUtils.ts";
import { GROUP_DRAG_MIME } from "../chat/types.ts";
import { Avatar } from "../shared/AvatarView.tsx";
import type { SessionItem } from "../AgentWindow.tsx";
import { OperationPanelGlyph12, ConversationPanelGlyph01, ConversationPanelGlyph02, ConversationPanelGlyph06, ConversationPanelGlyph07, ConversationPanelGlyph08, ConversationPanelGlyph09, ConversationPanelGlyph10 } from "../icons/PageIcons.tsx";
import { useClickOutside } from "../useClickOutside.ts";

type ProjectMenu = { dir: string; x: number; y: number } | null;
type ProjectAnchor = { dir: string; rect: DOMRect } | null;
type SessionMenu = { sid: string; x: number; y: number } | null;
type SessionAnchor = { sid: string; rect: DOMRect } | null;

function FloatingSidebarMenu({ anchor, point, className = "", children }: {
  anchor?: DOMRect;
  point?: { x: number; y: number };
  className?: string;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const place = () => {
      const margin = 8;
      const gap = 4;
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.max(margin, Math.min(anchor?.left ?? point?.x ?? margin, window.innerWidth - width - margin));
      const below = (anchor?.bottom ?? point?.y ?? margin) + gap;
      const above = (anchor?.top ?? point?.y ?? margin) - height - gap;
      const top = below + height <= window.innerHeight - margin
        ? below
        : above >= margin
          ? above
          : Math.max(margin, Math.min(below, window.innerHeight - height - margin));
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, point]);
  return createPortal(
    <div ref={menuRef} className={`chat-sidebar-project-menu ${className}`} role="menu"
      style={position ? position : { visibility: "hidden" } as CSSProperties}>
      {children}
    </div>,
    document.body,
  );
}

/** Home 内的会话管理面板；不要与应用级左侧导航 Sidebar 混用。 */
export interface ConversationPanelProps {
  basePath: string;
  sidebarOpen: boolean;
  sidebarLogo?: string | null;
  title: string;
  sessionsLoading: boolean;
  sessions: SessionItem[];
  isLoggedIn: boolean;
  libraryOpen: boolean;
  conversationActive: boolean;
  onOpenLibrary: () => void;
  showLibraryShortcut?: boolean;
  newSession: () => string;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  /** 新建对话后保持左侧会话列表面板不收起（宿主主窗口用；默认收起）。 */
  keepSidebarOnNewChat?: boolean;
  /** 打开全局搜索（会话名称 + 会话内历史消息），由宿主持有的跨会话跳转逻辑接管 */
  onOpenSearch: () => void;
  sidebarHover: boolean;
  onSidebarHoverEnter: () => void;
  onSidebarHoverLeave: () => void;
  sessionsLoadError: boolean;
  desktopApp: boolean;
  refreshSessions: () => Promise<void>;
  ungroupedSessions: SessionItem[];
  pinnedSessions: SessionItem[];
  setSessionPinned: (sid: string, pinned: boolean) => Promise<void>;
  moveSessionToPinned: (sid: string, index: number) => Promise<void>;
  /** 「全部已读」：把某会话全部未读消息标记为已读（仅群聊/协作等有成员参与的会话菜单显示） */
  markSessionReadAll?: (sid: string) => Promise<void> | void;
  loadingSessionId: string | null;
  sessionId: string;
  renameId: string | null;
  runningSids: Set<string>;
  unseenDoneSids: Set<string>;
  /** 卡在提问环节、等待用户确认的会话集合（sid）：时间位显示「待确认」tag */
  pendingQuestionSids: Set<string>;
  sessionErrors: Record<string, string>;
  longPressFiredRef: { current: boolean };
  longPressTimerRef: { current: number | null };
  switchSession: (sid: string) => Promise<unknown>;
  /** Ctrl+Tab 快捷切换完成后的收尾回调（如把焦点落回输入框）；由宿主传入，缺省不做事。 */
  focusComposer?: () => void;
  clearLongPress: () => void;
  openSessionMenuAt: (sid: string, x: number, y: number) => void;
  commitRename: (sid: string, title: string) => Promise<unknown>;
  relTime: (iso?: string | null) => string;
  projectGroups: Array<[string, SessionItem[]]>;
  isProjectHidden: (dir: string) => boolean;
  projectRenameDir: string | null;
  projectDisplayName: (dir: string) => string;
  setProjectAlias: (dir: string, name: string) => void;
  setProjectRenameDir: Dispatch<SetStateAction<string | null>>;
  collapsedProjects: Record<string, boolean>;
  toggleProjectCollapsed: (dir: string) => void;
  projectMenu: ProjectMenu;
  setProjectMenu: Dispatch<SetStateAction<ProjectMenu>>;
  projectMenuAnchor: ProjectAnchor;
  setProjectMenuAnchor: Dispatch<SetStateAction<ProjectAnchor>>;
  applyWorkspace: (dir: string, sessionId?: string) => Promise<unknown>;
  openArtifactFileDir: (dir: string) => Promise<void>;
  setConfirmDeleteProjectDir: Dispatch<SetStateAction<string | null>>;
  onClearUngrouped: () => void;
  sessionMenu: SessionMenu;
  setSessionMenu: Dispatch<SetStateAction<SessionMenu>>;
  sessionMenuAnchor: SessionAnchor;
  setSessionMenuAnchor: Dispatch<SetStateAction<SessionAnchor>>;
  setRenameId: Dispatch<SetStateAction<string | null>>;
  setConfirmDeleteId: Dispatch<SetStateAction<string | null>>;
  /** 有成员会话（1v1 / 群聊）的「删除」：确认后仅标记为对当前用户隐藏（软删除），不删服务器数据 */
  setConfirmHideId: Dispatch<SetStateAction<string | null>>;
  userMenu?: ReactNode;
  headerUserMenu?: ReactNode;
}

export default function ConversationPanel(props: ConversationPanelProps) {
  const t = useChatTranslation();
  const {
    basePath, sidebarOpen, sidebarLogo, title, sessionsLoading, sessions, isLoggedIn, libraryOpen, conversationActive, onOpenLibrary, showLibraryShortcut = true,
    newSession, setSidebarOpen, onOpenSearch, sidebarHover, onSidebarHoverEnter, onSidebarHoverLeave, keepSidebarOnNewChat = false,
    sessionsLoadError, desktopApp, refreshSessions,
    ungroupedSessions, pinnedSessions, setSessionPinned, moveSessionToPinned, markSessionReadAll,
    loadingSessionId, sessionId, renameId, runningSids,
    unseenDoneSids, pendingQuestionSids, sessionErrors, longPressFiredRef, longPressTimerRef, switchSession,
    focusComposer, clearLongPress, openSessionMenuAt, commitRename, relTime,
    projectGroups, isProjectHidden,
    projectRenameDir, projectDisplayName, setProjectAlias, setProjectRenameDir,
    collapsedProjects, toggleProjectCollapsed, projectMenu, setProjectMenu,
    projectMenuAnchor, setProjectMenuAnchor, applyWorkspace, openArtifactFileDir,
    setConfirmDeleteProjectDir, onClearUngrouped, sessionMenu, setSessionMenu, sessionMenuAnchor,
    setSessionMenuAnchor, setRenameId, setConfirmDeleteId, setConfirmHideId, userMenu, headerUserMenu,
  } = props;
  const webSessions = desktopApp ? sessions : sessions.filter((s) => !(s.projectDir || s.workspaceDir));
  const displayedPinnedSessions = desktopApp ? pinnedSessions : pinnedSessions.filter((s) => !(s.projectDir || s.workspaceDir));
  const displayedUngroupedSessions = desktopApp ? ungroupedSessions : webSessions.filter((s) => s.pinOrder == null);
  // 桌面端：未选项目的「用户↔AI」单聊归入「对话」组；人际 1v1/群聊（仍走云端）保持平铺
  const aiDialogSessions = displayedUngroupedSessions.filter((s) => (s.memberCount ?? 0) === 0 && !s.coworkEverGroup);
  const peopleSessions = displayedUngroupedSessions.filter((s) => (s.memberCount ?? 0) > 0 || Boolean(s.coworkEverGroup));
  // 侧边栏分组规则（桌面宿主）：会话都来自「新建对话」，选了项目就是本地项目会话（归入项目组）；
  // 没选文件夹的与 web 逻辑一致——和群聊/1v1 一起平铺展示、按时间倒序（服务端已按 updated_at DESC 排序），没有「任务」分类。
  const [, refreshDraftPreviews] = useState(0);
  useEffect(() => {
    const refresh = () => refreshDraftPreviews(value => value + 1);
    window.addEventListener(DRAFT_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(DRAFT_CHANGED_EVENT, refresh); window.removeEventListener("storage", refresh); };
  }, []);
  const [expandedLists, setExpandedLists] = useState<Record<string, boolean>>({});
  // 「对话」组（未选项目的 AI 单聊）本地折叠状态，仅本组件内生效
  const [dialogCollapsed, setDialogCollapsed] = useState(false);
  const [dialogMenuAnchor, setDialogMenuAnchor] = useState<DOMRect | null>(null);
  // 对话组「更多」菜单：点击菜单/⋯ 之外任意处关闭
  useClickOutside({
    enabled: dialogMenuAnchor !== null,
    exceptSelectors: [".chat-sidebar-project-menu", ".chat-sidebar-dialog-group .chat-sidebar-group-more"],
    onDismiss: () => setDialogMenuAnchor(null),
  });
  const visibleSessions = (key: string, list: SessionItem[]) =>
    expandedLists[key] ? list : list.slice(0, 5);
  const showMore = (key: string, list: SessionItem[]) =>
    list.length > 5 && !expandedLists[key] && (
      <button type="button" className="chat-sidebar-show-more"
        onClick={() => setExpandedLists((current) => ({ ...current, [key]: true }))}>
        {t("viewMore")}
      </button>
    );
  const collapseList = (key: string) =>
    setExpandedLists((current) => ({ ...current, [key]: false }));
  const toggleProjectGroup = (dir: string) => {
    if (!collapsedProjects[dir]) collapseList(`project:${dir}`);
    toggleProjectCollapsed(dir);
  };
  const [dragSid, setDragSid] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const clearDrag = () => { setDragSid(null); setDropIndex(null); };
  const onPinnedDragOver = (event: ReactDragEvent, index: number) => {
    if (!dragSid) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropIndex(index);
  };
  const onPinnedDrop = (event: ReactDragEvent, index: number) => {
    if (!dragSid) return;
    event.preventDefault();
    event.stopPropagation();
    void moveSessionToPinned(dragSid, index);
    clearDrag();
  };
  const [hoveredError, setHoveredError] = useState<{ sid: string; x: number; y: number } | null>(null);

  // —— Ctrl(+Shift)+Tab 快速切换会话：按住 Ctrl 点 Tab 弹出最近 6 个会话，Tab 下移 / Shift+Tab 上移，
  //    松开 Ctrl 即切换到高亮项；Esc 取消。refs 供全局键盘回调读取最新值（回调只注册一次）。 ——
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherIndex, setSwitcherIndex] = useState(0);
  const switcherOpenRef = useRef(false);
  const switcherIndexRef = useRef(0);
  // 最近会话（排除当前会话，按 updatedAt 倒序取 6 个）：web 端与侧边栏同一口径（过滤项目/工作目录会话）
  const switcherSessions = (desktopApp ? sessions : webSessions)
    .filter((s) => s.id !== (loadingSessionId ?? sessionId))
    .slice()
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
    .slice(0, 6);
  const switcherListRef = useRef<SessionItem[]>(switcherSessions);
  switcherListRef.current = switcherSessions;
  const switchSessionRef = useRef(switchSession);
  switchSessionRef.current = switchSession;
  const focusComposerRef = useRef(focusComposer);
  focusComposerRef.current = focusComposer;
  const closeSwitcher = () => {
    switcherOpenRef.current = false;
    setSwitcherOpen(false);
  };
  useEffect(() => {
    if (!isLoggedIn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Esc：取消切换（不切会话）
      if (event.key === "Escape" && switcherOpenRef.current) {
        event.preventDefault();
        closeSwitcher();
        return;
      }
      if (!event.ctrlKey || event.key !== "Tab") return;
      const list = switcherListRef.current;
      if (!list.length) return;
      event.preventDefault();
      if (!switcherOpenRef.current) {
        switcherOpenRef.current = true;
        switcherIndexRef.current = 0;
        setSwitcherIndex(0);
        setSwitcherOpen(true);
        return;
      }
      // 已打开：Tab 下移，Ctrl+Shift+Tab 上移，循环
      const next = event.shiftKey ? switcherIndexRef.current - 1 : switcherIndexRef.current + 1;
      const wrapped = ((next % list.length) + list.length) % list.length;
      switcherIndexRef.current = wrapped;
      setSwitcherIndex(wrapped);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      // 松开 Control（Windows/Mac 物理 Ctrl 键 key 均为 "Control"）：切换到高亮项并关闭
      if (event.key !== "Control" || !switcherOpenRef.current) return;
      const list = switcherListRef.current;
      let index = switcherIndexRef.current;
      if (index >= list.length) index = 0;
      const target = list[index];
      closeSwitcher();
      if (target) {
        // 切换完成后把焦点落回输入框：await 保证会话数据已切完，
        // rAF 等 React 把新会话渲染提交后再 focus（切换会触发 ChatComposer 重渲染/重建）。
        void switchSessionRef.current(target.id).then(() => {
          requestAnimationFrame(() => focusComposerRef.current?.());
        });
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
    };
  }, [isLoggedIn]);

  /** 单个会话条目（无项目/项目组内共用）：标题（超长走马灯）+ 相对时间 + ⋯ 操作菜单（长按/右键同）；
      highlight 仅用于 Ctrl+Tab 切换浮层的键盘高亮，侧边栏不传。 */
  const renderSessionItem = (s: SessionItem, highlight = false) => {
    const draft = readChatDraft(s.id);
    const draftText = draft.text.replace(/\s+/g, " ").trim() || (draft.attachments.length ? `[${t("attachment")}]` : "");
    const recentText = (s.lastPreview || "").replace(/\s+/g, " ").trim();
    const active = !libraryOpen && conversationActive && s.id === (loadingSessionId ?? sessionId);
    // 有成员参与（1v1 / 群聊）的会话，第二行显示最新消息（包括 AI 回复）；
    // 无人参与的作业流会话仍显示最后一条用户消息。
    const memberCount = s.memberCount ?? 0;
    const workApps = s.workflows || [];
    const hasWorkflow = workApps.length > 0;
    // 群聊判定：曾是/已是群（coworkEverGroup 永不回退）或当前成员 ≥2
    const isGroup = (s.coworkEverGroup ?? false) || memberCount > 1 || (hasWorkflow && memberCount > 0);
    // 有真人成员参与的会话（1v1 / 群聊 / 曾是群的会话）
    const hasMembers = memberCount > 0 || (s.coworkEverGroup ?? false);
    const recentFilePreview = sessionFilePreview(recentText);
    const lastUserRaw = s.lastUserPreview || s.lastQuestionPreview || "";
    const filePreview = sessionFilePreview(lastUserRaw);
    const lastUserPreview = filePreview ? "" : messagePreviewText(lastUserRaw);
    const recentSender = s.lastSenderName || "";
    // 最后一条人类消息 @ 了我：第二行在该消息预览前插入 [有人@了你] 标签，其余预览逻辑不变
    const mentionTag = s.lastMentionedMe ? <span className="chat-sidebar-mention-label">{t("mentionMe")}</span> : null;
    // 纯 1v1 单聊：我方最后一条消息已被对方阅读 → 消息预览开头显示单聊已读样式：
    // 绿色空心圆圈（复用聊天详情的 .cowork-read-pie-mark 组件）+ 绿色 check（复用 CheckIcon 组件），
    // 不另行绘制图形；外层 holder 与预览行等高并垂直居中，保证与消息文字对齐。
    const readMark = hasMembers && !isGroup && s.lastMessageReadByPeer && !(!active && draftText) ? (
      <span className="chat-sidebar-item-read-holder" role="img" aria-label={t("readByPeer")}>
        <span className="cowork-read-pie-mark chat-sidebar-item-read-mark" style={{ "--read-angle": "0deg" } as CSSProperties} aria-hidden="true">
          <CheckIcon className="chat-sidebar-item-read-check" />
        </span>
      </span>
    ) : null;
    const hasPreview = !!draftText || !!recentText;
    // 群聊（含曾成群但成员已减少）列表标题用会话标题；单聊（成员 ≤1 且从未成群）显示对方姓名。
    const displayTitle = isGroup ? s.title : (s.peerName || s.title);
    const editing = renameId === s.id;
    // 会话正在运行（含后台运行的会话）：时间位换成黑白灰转圈动画；
    // 用 runningSids 而非全局 busy，切走不杀旧流的会话也能正确显示转圈。
    const running = runningSids.has(s.id);
    // 卡在提问环节（最后一条 AI 消息为未回答的提问卡片）：时间位显示「待确认」tag
    const pendingQuestion = pendingQuestionSids.has(s.id);
    // 后台跑完、当前未查看的会话：时间位显示小绿圈（点进该会话即清除）
    const unseenDone = unseenDoneSids.has(s.id);
    const error = sessionErrors[s.id];
    const workIcon = (workApps.length > 1 ? workApps[workApps.length - 1].collectionIconUrl : workApps[0]?.iconUrl) || workApps[0]?.iconUrl;
    const pinnedIndex = displayedPinnedSessions.findIndex((entry) => entry.id === s.id);
    const dropBefore = dragSid && pinnedIndex >= 0 && dropIndex === pinnedIndex;
    const dropAfter = dragSid && pinnedIndex === displayedPinnedSessions.length - 1 && dropIndex === displayedPinnedSessions.length;
    return (
      <div
        key={s.id}
        className={`chat-sidebar-item${active ? " is-active" : ""}${highlight ? " is-highlight" : ""}${hasMembers ? "" : " is-solo"}${hasWorkflow ? " is-workflow" : ""}${hasPreview ? " has-preview" : ""}${!desktopApp && pinnedIndex >= 0 ? " is-web-pinned" : ""}${dropBefore ? " is-drop-before" : ""}${dropAfter ? " is-drop-after" : ""}${dragSid === s.id ? " is-dragging" : ""}`}
        draggable={!editing}
        onDragStart={(event) => {
          setDragSid(s.id);
          // copyMove 同时允许 copy（接入输入框）与 move（侧边栏排序/置顶），避免 effectAllowed 与
          // 目标 dropEffect 不匹配被 Chrome 判定 not-allowed 而 drop 不触发
          event.dataTransfer.effectAllowed = "copyMove";
          event.dataTransfer.setData("application/x-agent-session", s.id);
          // 群聊与 1v1 会话都可拖进输入框接入：额外带一份会话信息，
          // 输入框靠这个 MIME 判断是否允许落下（dragover 阶段只能读 types，读不到数据）。
          const refPayload = isGroup
            ? { id: s.id, title: s.title, avatar: s.coworkAvatar ?? null, kind: "group" as const }
            : { id: s.id, title: s.peerName || s.title, avatar: s.peerAvatar ?? null, kind: "peer" as const };
          event.dataTransfer.setData(GROUP_DRAG_MIME, JSON.stringify(refPayload));
        }}
        onDragEnd={clearDrag}
        onDragOver={pinnedIndex >= 0 ? (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onPinnedDragOver(event, pinnedIndex + (event.clientY > rect.top + rect.height / 2 ? 1 : 0));
        } : undefined}
        onDrop={pinnedIndex >= 0 ? (event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onPinnedDrop(event, pinnedIndex + (event.clientY > rect.top + rect.height / 2 ? 1 : 0));
        } : undefined}
        onMouseEnter={(event) => {
          if (!error) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setHoveredError({
            sid: s.id,
            x: Math.max(8, Math.min(rect.right + 8, window.innerWidth - 316)),
            y: Math.max(8, Math.min(rect.top, window.innerHeight - 110)),
          });
        }}
        onMouseLeave={() => setHoveredError(null)}
        onClick={() => {
          // 长按刚弹出过菜单：本次 click 是松手误触，吞掉并复位
          if (longPressFiredRef.current) {
            longPressFiredRef.current = false;
            return;
          }
          if (!editing) {
            // Ctrl+Tab 浮层里点选：先关浮层再切换（侧边栏正常点击时 switcherOpenRef 为 false，无副作用）
            if (switcherOpenRef.current) closeSwitcher();
            switchSession(s.id);
            // 移动端悬浮抽屉：选中会话后自动收起，避免遮住聊天区
            if (window.matchMedia("(max-width: 767.98px)").matches) setSidebarOpen(false);
          }
        }}
        // 移动端无 hover：长按 500ms 弹出操作菜单（移动/滚动/松手均取消）
        onTouchStart={(e) => {
          if (editing) return;
          const t = e.touches[0];
          const x = t?.clientX ?? 0;
          const y = t?.clientY ?? 0;
          clearLongPress();
          longPressTimerRef.current = window.setTimeout(() => openSessionMenuAt(s.id, x, y), 500);
        }}
        onTouchMove={clearLongPress}
        onTouchEnd={clearLongPress}
        onTouchCancel={clearLongPress}
        // 桌面端右键同样弹出菜单（与项目分组右键一致）；阻止浏览器原生菜单
        onContextMenu={(e) => {
          e.preventDefault();
          if (editing) return;
          clearLongPress();
          if (sessionMenu?.sid === s.id) return; // 长按已弹出：不重复定位
          openSessionMenuAt(s.id, e.clientX, e.clientY);
        }}
      >
        {(s.memberCount || s.coworkEverGroup) ? (() => {
          // 无头像时的兜底：单聊用蓝底姓名（≤2 字全名，否则后两字），与通讯录/搜索一致；
          // 群聊沿用方形浅蓝底 + 群名首字。头像几何/字号由 .chat-sidebar-session-avatar 提供。
          const groupMemberCount = s.memberCount ?? 0;
          // 增强群 icon：背景一律是群头像（coworkAvatar 或群兜底）；
          // 带业务流的聊天（含由人机聊天加人升级而成的增强群）把升级前的业务流 icon
          // 叠加显示在群 icon 左下角（.chat-sidebar-work-badge），标识「由业务流聊天升级而来」。
          const isGroup = (s.coworkEverGroup ?? false) || groupMemberCount > 1 || hasWorkflow;
          const rawSrc = isGroup ? s.coworkAvatar : s.peerAvatar;
          const src = rawSrc ? (isGroup && rawSrc.startsWith("/") ? `${basePath}${rawSrc}` : rawSrc) : undefined;
          const label = (isGroup ? s.title : s.peerName || s.title).trim();
          return <span className="chat-sidebar-avatar-wrap"><Avatar
            name={label}
            src={src}
            isGroup={isGroup}
            className={`chat-sidebar-session-avatar${isGroup ? " is-group" : ""}`}
            title={isGroup ? s.title : s.peerName || s.title}
            noTooltip
            ariaHidden
          />{workIcon ? <img className="chat-sidebar-work-badge" src={workIcon} alt="" aria-label={t("workflow")} /> : null}{Number(s.unreadCount) > 0 ? <span className={`chat-sidebar-unread${s.muted ? " is-muted" : ""}`} aria-label={t("unreadCount", { count: s.unreadCount ?? 0 })}>{s.unreadCount! > 99 ? "99+" : s.unreadCount}</span> : null}</span>;
        })() : workIcon ? <span className="chat-sidebar-avatar-wrap"><img className="chat-sidebar-session-avatar is-work-app" src={workIcon} alt="" aria-hidden="true" /></span> : null}
        {editing ? (
          <input
            className="chat-sidebar-rename-input"
            defaultValue={displayTitle}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onCompositionStart={imeCompositionStart}
            onCompositionEnd={imeCompositionEnd}
            onKeyDown={(e) => {
              if (isImeConfirmKey(e)) return;
              if (e.key === "Enter") { e.preventDefault(); commitRename(s.id, e.currentTarget.value); }
              else if (e.key === "Escape") setRenameId(null);
            }}
            onBlur={(e) => commitRename(s.id, e.currentTarget.value)}
          />
        ) : (
          <>
            <span className="chat-sidebar-item-content">
            <span className="chat-sidebar-item-main">
              {/* 标题单行：超长（>12 字）时 hover 走马灯滚动 */}
              <span
                className={`chat-sidebar-item-title${displayTitle.length > 12 ? " is-marquee" : ""}`}
              >
                {displayTitle.length > 12 ? (
                  <span
                    className="chat-sidebar-item-title-text"
                    style={{ "--marquee-dur": `${Math.max(2, displayTitle.length * 0.1).toFixed(1)}s` } as CSSProperties}
                  >
                    {displayTitle}
                  </span>
                ) : (
                  <span className="chat-sidebar-item-title-text">{displayTitle}</span>
                )}
              </span>
              {/* 时间：运行中显示转圈动画，否则相对时间；hover 时隐藏，位置让给 ⋯ 按钮 */}
              <span className="chat-sidebar-item-time">
                {loadingSessionId === s.id ? (
                  <span className="chat-sidebar-item-spinner" aria-hidden="true" />
                ) : error ? (
                  <SessionErrorIndicator message={error} popupPosition={hoveredError?.sid === s.id ? hoveredError : null} />
                ) : pendingQuestion ? (
                  <span className="chat-sidebar-item-pending" aria-label={t("pendingConfirmation")}><span className="chat-sidebar-item-pending-dot" aria-hidden="true" />{t("pendingConfirmation")}</span>
                ) : running ? (
                  <span className="chat-sidebar-item-spinner" aria-hidden="true" />
                ) : !active && (unseenDone || s.aiUnread) ? (
                  <span className="chat-sidebar-item-done" aria-hidden="true" />
                ) : (
                  relTime(s.updatedAt)
                )}
              </span>
              {/* WorkBuddy 风格：hover 时时间位让给单个 ⋯ 按钮，点开菜单（重命名/删除） */}
              <span className="chat-sidebar-item-actions" onClick={(e) => e.stopPropagation()}>
                {pinnedIndex >= 0 ? <button type="button" className="chat-sidebar-item-act chat-sidebar-item-pin" title={t("unpin")} aria-label={t("unpin")}
                  onClick={() => void setSessionPinned(s.id, false)}><PinIcon /></button> : null}
                <button
                  type="button"
                  className={`chat-sidebar-item-act chat-sidebar-item-more${sessionMenuAnchor?.sid === s.id ? " is-open" : ""}`}
                  title={t("conversationActions")}
                  aria-label={t("conversationActions")}
                  onClick={(e) => {
                    setSessionMenu(null);
                    setProjectMenu(null);
                    setProjectMenuAnchor(null);
                    setSessionMenuAnchor(
                      sessionMenuAnchor?.sid === s.id
                        ? null
                        : { sid: s.id, rect: (e.currentTarget as HTMLButtonElement).getBoundingClientRect() },
                    );
                  }}
                >
                  <OperationPanelGlyph12 />
                </button>
              </span>
            </span>
            {hasWorkflow && !hasMembers ? (filePreview ? <span className="chat-sidebar-item-preview is-file">{mentionTag}<span className="chat-sidebar-file-tag">{filePreview.label}</span><span className="chat-sidebar-file-details">{filePreview.details}</span></span> : lastUserPreview ? <span className="chat-sidebar-item-preview">{mentionTag}{lastUserPreview}</span> : null)
              : !active && draftText ? <span className="chat-sidebar-item-preview is-draft"><span className="chat-sidebar-draft-label">{t("draft")}</span>{draftText}</span>
              : recentFilePreview ? <span className="chat-sidebar-item-preview is-file">{readMark}{mentionTag}{recentSender ? <span>{recentSender}：</span> : null}<span className="chat-sidebar-file-tag">{recentFilePreview.label}</span><span className="chat-sidebar-file-details">{recentFilePreview.details}</span></span> : recentText ? <span className="chat-sidebar-item-preview">{readMark}{mentionTag}{recentSender ? `${recentSender}：` : ""}{recentText}</span> : null}
            </span>
          </>
        )}
      </div>
    );
  };

  return (
    <>
      {/* 左栏：会话列表 + 底部用户信息（WB/Codex 式三栏布局，默认隐藏，顶栏左上角按钮唤起） */}
      <aside
        className={`chat-sidebar chat-pane-left${sidebarOpen ? " is-open" : ""}${!sidebarOpen && sidebarHover ? " is-hover" : ""}`}
        aria-hidden={!sidebarOpen && !sidebarHover && typeof window !== "undefined" && !window.matchMedia("(max-width: 767.98px)").matches}
        onMouseEnter={onSidebarHoverEnter}
        onMouseLeave={onSidebarHoverLeave}
      >
        <div className="chat-sidebar-inner">
          <div className="chat-sidebar-head">
            {headerUserMenu ? <div className="chat-mobile-sidebar-profile">{headerUserMenu}</div> : null}
            {headerUserMenu && isLoggedIn ? <button type="button" className="chat-mobile-sidebar-new" title={t("newConversation")} aria-label={t("newConversation")}
              onClick={() => { newSession(); setSidebarOpen(false); }}>
              <ConversationPanelGlyph01 />
            </button> : null}
            {/* 移动端（有底部导航）隐藏了整行 newrow，搜索入口随「新建对话」一起挪到头部 bar */}
            {headerUserMenu && isLoggedIn ? <button type="button" className="chat-mobile-sidebar-search" title={t("globalSearch")} aria-label={t("globalSearch")}
              onClick={onOpenSearch}>
              <SearchIcon />
            </button> : null}
            {sidebarLogo ? (
              <img className="chat-sidebar-logo" src={sidebarLogo} alt="" />
            ) : (
              <span className="chat-sidebar-title">Home</span>
            )}
            {/* 右上角应用名（宿主 title prop，如 "Agent"） */}
            <span className="chat-sidebar-appname" title={title}>{title}</span>
          </div>
          {/* 「新建任务」独立成行并固定不滚动（主流 agent 布局：头部下第一行 + 圆圈加号图标），
              与下方会话列表之间留出间距，明确区分两个功能区 */}
          {isLoggedIn ? (
            <div className="chat-sidebar-newrow">
              {/* 新建对话与搜索同排：搜索是全局入口（跨会话），做成独立图标按钮，
                  与主操作「新建对话」共用同一行高度，避免它看起来像会话列表的一项。 */}
              <div className="chat-sidebar-newrow-head">
                <button
                  type="button"
                  className="chat-sidebar-new chat-sidebar-new--task"
                  title={t("newConversation")}
                  onClick={() => {
                    newSession();
                    if (!keepSidebarOnNewChat && window.matchMedia("(max-width: 767.98px)").matches) setSidebarOpen(false);
                  }}
                >
                  <ConversationPanelGlyph01 />
                  <span>{t("newConversation")}</span>
                </button>
                <button
                  type="button"
                  className="chat-sidebar-search"
                  title={t("globalSearch")}
                  aria-label={t("globalSearch")}
                  onClick={onOpenSearch}
                >
                  <SearchIcon />
                </button>
              </div>
              {showLibraryShortcut ? <button type="button" className={`chat-sidebar-new${libraryOpen ? " is-active" : ""}`} onClick={onOpenLibrary} aria-current={libraryOpen ? "page" : undefined}>
                <ConversationPanelGlyph02 />
                <span>{t("navLibrary")}</span>
              </button> : null}
            </div>
          ) : null}
          <div className="chat-sidebar-list">
            {isLoggedIn ? (
              sessionsLoading && webSessions.length === 0 ? (
                <LoadingState label={t("loadingConversations")} variant="sidebar" />
              ) : sessionsLoadError && webSessions.length === 0 ? (
                <div className="chat-loading-error" role="alert">{t("conversationsFailed")}<button type="button" onClick={() => void refreshSessions()}>{t("retry")}</button></div>
              ) : webSessions.length === 0 ? (
                <div className="chat-sidebar-empty">{t("noConversations")}</div>
              ) : (
                <>
                  {!desktopApp ? <>
                    {displayedPinnedSessions.map((s) => renderSessionItem(s))}
                    {displayedUngroupedSessions.map((s) => renderSessionItem(s))}
                  </> : <>
                  {pinnedSessions.length > 0 && (
                    <div className="chat-sidebar-group chat-sidebar-pinned-group">
                      <div className="chat-sidebar-group-title chat-sidebar-pinned-title"
                        onDragOver={(event) => onPinnedDragOver(event, 0)}
                        onDrop={(event) => onPinnedDrop(event, 0)}>
                        <span className="chat-sidebar-group-pin"><PinIcon filled /></span>
                        <span className="chat-sidebar-group-name">{t("pin")}</span>
                        <span className="chat-sidebar-group-count">{pinnedSessions.length}</span>
                      </div>
                      {visibleSessions("pinned", pinnedSessions).map((s) => renderSessionItem(s))}
                      {showMore("pinned", pinnedSessions)}
                      <div className={`chat-sidebar-pinned-tail${dragSid && dropIndex === pinnedSessions.length ? " is-drop-target" : ""}`}
                        onDragOver={(event) => onPinnedDragOver(event, pinnedSessions.length)}
                        onDrop={(event) => onPinnedDrop(event, pinnedSessions.length)} />
                    </div>
                  )}
                  {/* 人际 1v1/群聊（仍走云端）平铺展示，不属于任何组，置于最上方 */}
                  {peopleSessions.map((s) => renderSessionItem(s))}
                  {/* 未选项目的「用户↔AI」单聊归入「对话」组 */}
                  {aiDialogSessions.length > 0 && (
                    <div className="chat-sidebar-group chat-sidebar-dialog-group">
                      <div
                        className={`chat-sidebar-group-title${dialogCollapsed ? " is-collapsed" : ""}`}
                        onClick={() => setDialogCollapsed((v) => !v)}
                      >
                        <span className="chat-sidebar-group-name">{t("navHome")}</span>
                        <span className="chat-sidebar-group-count">{aiDialogSessions.length}</span>
                        <button
                          type="button"
                          className="chat-sidebar-group-chevron"
                          aria-label={dialogCollapsed ? t("expandConversations") : t("collapseConversations")}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDialogCollapsed((v) => !v);
                          }}
                        >
                          <ConversationPanelGlyph06 />
                        </button>
                        <span className="chat-sidebar-group-actions" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="chat-sidebar-group-act chat-sidebar-group-more"
                            title={t("conversationActions")} aria-label={t("conversationActions")}
                            onClick={(e) => { e.stopPropagation(); setDialogMenuAnchor(dialogMenuAnchor ? null : e.currentTarget.getBoundingClientRect()); }}>
                            <OperationPanelGlyph12 />
                          </button>
                        </span>
                      </div>
                      {dialogCollapsed ? null : aiDialogSessions.map((s) => renderSessionItem(s))}
                    </div>
                  )}
                  {dialogMenuAnchor ? (
                    <FloatingSidebarMenu anchor={dialogMenuAnchor}>
                      <button type="button" role="menuitem" className="is-danger" onClick={() => {
                        setDialogMenuAnchor(null);
                        onClearUngrouped();
                      }}>
                        <ConversationPanelGlyph10 /><span>{t("clear")}</span>
                      </button>
                    </FloatingSidebarMenu>
                  ) : null}
                  {/* 有项目的会话：按项目分组（组标题 = 目录名 + 条目数；可折叠；
                      hover 右侧出现「+ 新建会话」「⋯ 菜单（打开文件夹/重命名/删除项目）」） */}
                  {projectGroups
                    .filter(([dir]) => !isProjectHidden(dir))
                    .map(([dir, list]) => (
                    <div className="chat-sidebar-group chat-sidebar-project-group" key={dir}>
                      {projectRenameDir === dir ? (
                        <input
                          className="chat-sidebar-rename-input"
                          defaultValue={projectDisplayName(dir)}
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                          onCompositionStart={imeCompositionStart}
                          onCompositionEnd={imeCompositionEnd}
                          onKeyDown={(e) => {
                            if (isImeConfirmKey(e)) return;
                            if (e.key === "Enter") {
                              e.preventDefault();
                              setProjectAlias(dir, e.currentTarget.value);
                              setProjectRenameDir(null);
                            } else if (e.key === "Escape") setProjectRenameDir(null);
                          }}
                          onBlur={(e) => {
                            setProjectAlias(dir, e.currentTarget.value);
                            setProjectRenameDir(null);
                          }}
                        />
                      ) : (
                        <div
                          className={`chat-sidebar-group-title${collapsedProjects[dir] ? " is-collapsed" : ""}`}
                          title={dir}
                          onClick={() => toggleProjectGroup(dir)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setProjectMenuAnchor(null);
                            setProjectMenu({ dir, x: e.clientX, y: e.clientY });
                          }}
                        >
                          <span className="chat-sidebar-group-name">{projectDisplayName(dir)}</span>
                          <span className="chat-sidebar-group-count">{list.length}</span>
                          <button
                            type="button"
                            className="chat-sidebar-group-chevron"
                            aria-label={collapsedProjects[dir] ? t("expandProject") : t("collapseProject")}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleProjectGroup(dir);
                            }}
                          >
                            <ConversationPanelGlyph06 />
                          </button>
                          <span className="chat-sidebar-group-actions" onClick={(e) => e.stopPropagation()}>
                            {desktopApp ? <button
                              type="button"
                              className="chat-sidebar-group-act chat-sidebar-group-add"
                              title={t("newProjectConversation")}
                              aria-label={t("newProjectConversation")}
                              onClick={() => {
                                // 组折叠时新建会话：先展开，否则新会话落在折叠组里看不见
                                if (collapsedProjects[dir]) toggleProjectGroup(dir);
                                const sid = newSession();
                                void applyWorkspace(dir, sid);
                              }}
                            >
                              <ConversationPanelGlyph07 />
                            </button> : null}
                            <button
                              type="button"
                              className={`chat-sidebar-group-act chat-sidebar-group-more${projectMenuAnchor?.dir === dir ? " is-open" : ""}`}
                              title={t("projectActions")}
                              aria-label={t("projectActions")}
                              onClick={(e) => {
                                e.stopPropagation();
                                setProjectMenu(null);
                                setProjectMenuAnchor(projectMenuAnchor?.dir === dir ? null : { dir, rect: (e.currentTarget as HTMLButtonElement).getBoundingClientRect() });
                              }}
                            >
                              <OperationPanelGlyph12 />
                            </button>
                          </span>
                        </div>
                      )}
                      {collapsedProjects[dir] ? null : <>
                        {visibleSessions(`project:${dir}`, list).map((s) => renderSessionItem(s))}
                        {showMore(`project:${dir}`, list)}
                      </>}
                    </div>
                  ))}
                  </>}
                  {/* 项目菜单（⋯ 按钮或右键触发，固定定位） */}
                  {projectMenu || projectMenuAnchor ? (
                    <FloatingSidebarMenu anchor={projectMenuAnchor?.rect} point={projectMenu ?? undefined}>
                      {desktopApp ? (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            const dir = projectMenu?.dir ?? projectMenuAnchor!.dir;
                            setProjectMenu(null);
                            setProjectMenuAnchor(null);
                            void openArtifactFileDir(dir);
                          }}
                        >
                          <ConversationPanelGlyph08 />
                          <span>{t("openFolder")}</span>
                        </button>
                      ) : null}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setProjectRenameDir(projectMenu?.dir ?? projectMenuAnchor!.dir);
                          setProjectMenu(null);
                          setProjectMenuAnchor(null);
                        }}
                      >
                        <ConversationPanelGlyph09 />
                        <span>{t("rename")}</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="is-danger"
                        onClick={() => {
                          setConfirmDeleteProjectDir(projectMenu?.dir ?? projectMenuAnchor!.dir);
                          setProjectMenu(null);
                          setProjectMenuAnchor(null);
                        }}
                      >
                        <ConversationPanelGlyph10 />
                        <span>{t("deleteProject")}</span>
                      </button>
                    </FloatingSidebarMenu>
                  ) : null}
                  {/* 会话菜单（⋯ 按钮 / 移动端长按 / 右键触发）：portal 到 body，
                      脱离移动端抽屉的 overflow 裁剪与层叠上下文，确保完整可见且盖住聊天区 */}
                  {sessionMenu || sessionMenuAnchor ? (() => {
                    const menuSid = sessionMenu?.sid ?? sessionMenuAnchor!.sid;
                    // 有成员参与（1v1 / 群聊，含曾成群）的会话才有他人消息未读的概念；纯人机聊天（无成员且未成过群）不显示「全部已读」
                    const menuSession = sessions.find((s) => s.id === menuSid);
                    const hasMembers = (menuSession?.memberCount ?? 0) > 0 || (menuSession?.coworkEverGroup ?? false);
                    return (
                      <FloatingSidebarMenu anchor={sessionMenuAnchor?.rect} point={sessionMenu ?? undefined} className="chat-sidebar-session-menu">
                          <button type="button" role="menuitem" onClick={() => {
                            const pinned = pinnedSessions.some((entry) => entry.id === menuSid);
                            setSessionMenu(null);
                            setSessionMenuAnchor(null);
                            void setSessionPinned(menuSid, !pinned);
                          }}>
                            <PinIcon filled={pinnedSessions.some((entry) => entry.id === menuSid)} />
                            <span>{pinnedSessions.some((entry) => entry.id === menuSid) ? t("unpin") : t("pin")}</span>
                          </button>
                          {hasMembers && markSessionReadAll ? (
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setSessionMenu(null);
                                setSessionMenuAnchor(null);
                                void markSessionReadAll(menuSid);
                              }}
                            >
                              <CheckIcon />
                              <span>{t("markAllRead")}</span>
                            </button>
                          ) : null}
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setRenameId(menuSid);
                              setSessionMenu(null);
                              setSessionMenuAnchor(null);
                            }}
                          >
                            <ConversationPanelGlyph09 />
                            <span>{t("rename")}</span>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="is-danger"
                            onClick={() => {
                              if (hasMembers) setConfirmHideId(menuSid);
                              else setConfirmDeleteId(menuSid);
                              setSessionMenu(null);
                              setSessionMenuAnchor(null);
                            }}
                          >
                            <ConversationPanelGlyph10 />
                            <span>{t("delete")}</span>
                          </button>
                        </FloatingSidebarMenu>
                    );
                  })() : null}
                </>
              )
            ) : (
              <div className="chat-sidebar-empty">
                {t("guestUnsaved")}
                <br />
                {t("loginHistory")}
              </div>
            )}
          </div>
          {userMenu}
        </div>
      </aside>
      {/* Ctrl(+Shift)+Tab 快速切换浮层：条目复用侧边栏会话行（renderSessionItem），展示方式与会话列表一致；
          portal 到 body，脱离侧栏裁剪与层叠上下文。松开 Ctrl 由全局 keyup 提交切换。 */}
      {switcherOpen && switcherSessions.length ? createPortal(
        <div
          className="session-switcher-backdrop"
          onMouseDown={(event) => { if (event.target === event.currentTarget) closeSwitcher(); }}
        >
          <div className="session-switcher-dialog" role="dialog" aria-modal="true" aria-label={t("quickSwitch")}>
            <div className="session-switcher-list">
              {switcherSessions.map((s, index) => (
                <div
                  key={s.id}
                  onMouseEnter={() => { switcherIndexRef.current = index; setSwitcherIndex(index); }}
                >
                  {renderSessionItem(s, index === switcherIndex)}
                </div>
              ))}
            </div>
            <footer className="session-switcher-foot">
              <span>{t("nextShortcut")}</span>
              <span>{t("previousShortcut")}</span>
              <span>{t("releaseCtrl")}</span>
              <span>{t("escapeCancel")}</span>
            </footer>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
