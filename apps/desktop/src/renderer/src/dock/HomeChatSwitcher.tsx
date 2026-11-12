import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useClickOutside, type SessionCardSnapshot } from "@turingflow/agent-kit/ui";
import { useLauncher } from "../state";
import { clearSavedWindowGeometry } from "./WindowFrame";
import { attachThumb, attachThumbSnapshot, measureBodyHeight, THUMB_HEADER_HEIGHT, THUMB_WIDTH, type ThumbHandle } from "./homeThumb";

/**
 * Home 多窗口预览（Windows 任务栏同款）：有 ≥2 个 home chat 窗口（无论是否最小化）时，
 * 点 Dock 的 Home 弹出。
 *
 * 解决两件事：**未最小化时也能挑窗口** + **收起后怎么找回来**。缩略图点一下 = 还原那个窗口
 * （还原即原样，会话 / 左右侧面板 / 草稿都还在，因为窗口实例一直挂着没卸载）；
 * 左上角的关闭按钮 = 真正关掉它（卸载实例、忘记状态）。
 *
 * 缩略图里是**真窗口**：把它的 DOM 节点搬进来整体缩放（见 homeThumb.ts），
 * 所以内容、滚动位置、流式输出全都是实时的，不是照着会话数据画的一幅示意图。
 * 卡片比例跟着窗口走（窗口是竖的就竖着），一侧长、一侧短的那套宽高在这里不适用。
 */
export interface HomeChatSwitcherProps {
  /** 要展示的 home chat 窗口 id（顺序 = open 在前、minimized 在后）。已打开的窗口也会被缩略图化，关浮层时再放回去。 */
  windowIds: readonly string[];
  /** 当前登录用户名：卡片标题若等于它（home chat 会话默认以用户名命名），则不显示，避免浮层里重复出现自己的名字。 */
  userName?: string | null;
  /** 点背景 / 按 Esc：收起这层浮层，什么都不还原。 */
  onDismiss: () => void;
}

/** 一张卡用哪个会话当门面：正在看的 > 正在跑的 > 跑完未读的 > 最近更新的。 */
function pickCard(cards: SessionCardSnapshot[] | undefined): SessionCardSnapshot | null {
  if (!cards?.length) return null;
  return cards.find((card) => card.active)
    ?? cards.find((card) => card.status === "running" || card.status === "waiting")
    ?? cards.find((card) => card.status === "done")
    ?? [...cards].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0]
    ?? null;
}

/** 一张缩略图卡：标题栏 + 真窗口 + 左上角关闭。 */
function ThumbCard({ windowId, bodyHeight, onDismiss, userName }: { windowId: string; bodyHeight: number; onDismiss: () => void; userName?: string | null }) {
  const { state, dispatch } = useLauncher();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<ThumbHandle | null>(null);
  const [attached, setAttached] = useState(false);
  // 收起的窗口 = 隐藏的，把真实节点搬进缩略图（实时）；还开着的窗口 = 留在桌面原样，
  // 缩略图用克隆快照（attachThumbSnapshot），这样点 Home 不会让眼前的窗口凭空消失。
  const isMinimized = state.minimizedWindows.includes(windowId);

  const card = pickCard(state.sessionCardsByWindow[windowId]);
  const running = state.runningSessionsByWindow[windowId]?.length ?? 0;
  const title = card?.title?.trim() || "新对话";
  // home chat 的新会话常以登录用户名命名；浮层里再把自己的名字当窗口标题重复显示没有辨识价值，
  // 等于用户名时不再渲染标题（运行/未读等状态仍照常显示）。
  const isOwnName = Boolean(userName) && title === userName!.trim();
  const displayTitle = isOwnName ? "" : title;
  /**
   * 标题栏右侧只在**有信号**的时候出字：运行中 / 待确认 / 未读。
   * 「空闲」「空」这种没人需要的信息不写 —— 缩略图里那一大片聊天内容本来就说明它闲不闲。
   */
  const status = running > 0
    ? "运行中"
    : card?.status === "waiting"
      ? "待确认"
      : card?.status === "done"
        ? "未读"
        : null;

  /**
   * 把真窗口搬进卡片。窗口最小化时仍然挂载（会话要在后台继续跑），所以这里一定找得到它；
   * 搬的过程不改 React 的树，只改 DOM —— kit 的更新照常写进这些节点，缩略图因此是实时的。
   */
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = isMinimized
      ? attachThumb(windowId, host, bodyHeight)
      : attachThumbSnapshot(windowId, host, bodyHeight);
    handleRef.current = handle;
    setAttached(handle.attached);
    return () => {
      handle.detach();
      if (handleRef.current === handle) handleRef.current = null;
      setAttached(false);
    };
  }, [windowId, bodyHeight, isMinimized]);

  /** 还原 / 关闭之前先把节点放回去：React 卸载窗口时要能在原父节点下找到它。 */
  function release() {
    handleRef.current?.detach();
    handleRef.current = null;
    setAttached(false);
  }

  const restore = () => {
    release();
    dispatch({ type: "RESTORE_CHAT", windowId });
    onDismiss();
  };

  const close = () => {
    release();
    clearSavedWindowGeometry(windowId);
    dispatch({ type: "CLOSE_CHAT", windowId });
  };

  return (
    <div ref={cardRef} className="home-switcher-card" role="button" tabIndex={0}
      aria-label={`还原聊天窗口：${title}`} data-window-id={windowId}
      style={{ width: THUMB_WIDTH }}
      onClick={restore}
      onKeyDown={(event) => {
        // 只有卡片本身拿到焦点才响应回车/空格：关闭按钮自己也要用键盘。
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        restore();
      }}>
      <div className="home-switcher-head">
        {displayTitle && (
          <span className="home-switcher-name" title={displayTitle}>{displayTitle}</span>
        )}
        {status && (
          <span className={`home-switcher-state${running > 0 ? " is-live" : ""}`}>
            {running > 0 && <span className="home-switcher-live" />}
            {status}
          </span>
        )}
      </div>
      {/* 真窗口就挂在这一层里（position: absolute inset，缩放后正好铺满）。 */}
      <div ref={hostRef} className="home-switcher-thumb">
        {!attached && <span className="home-switcher-thumb-hold">窗口正在后台恢复…</span>}
      </div>
      <button type="button" className="home-switcher-close" aria-label={`关闭聊天窗口：${title}`}
        onClick={(event) => {
          event.stopPropagation();
          close();
        }}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.7 3.7L8.3 8.3M8.3 3.7L3.7 8.3" /></svg>
      </button>
    </div>
  );
}

export default function HomeChatSwitcher({ windowIds, userName, onDismiss }: HomeChatSwitcherProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * 所有卡片共用一个高度（量一次，不随窗口各自的高度变化）——
   * 几扇窗口高度差几十像素时，卡片高度参差看起来就像坏了（见 homeThumb.ts）。
   */
  const [bodyHeight, setBodyHeight] = useState(() => measureBodyHeight(windowIds));
  // 首帧如果窗口还没挂上（量不到），挂载后再校一次；正常情况下这里不会变。
  useLayoutEffect(() => {
    const measured = measureBodyHeight(windowIds);
    setBodyHeight((current) => (current === measured ? current : measured));
  }, [windowIds]);

  // Esc 收起；左右方向键在缩略图之间移动焦点（和 Windows 的预览条一致）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const cards = [...(rootRef.current?.querySelectorAll<HTMLElement>(".home-switcher-card") ?? [])];
      if (cards.length < 2) return;
      const current = cards.findIndex((node) => node === document.activeElement);
      const next = event.key === "ArrowRight"
        ? Math.min(cards.length - 1, current + 1)
        : Math.max(0, current - 1);
      cards[next]?.focus();
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onDismiss]);

  /**
   * 点别处收起。
   * 用 document 上的 pointerdown 而不是「整屏遮罩」来收：遮罩必须让指针穿透，
   * 否则 Dock 会被挡住 —— 用户点别的应用图标、再点一次 Home，都该正常生效。
   * Home 图标除外：那一颗自己会 toggle（见 Dock 的 onClick），这里再收一次会让它「刚关又开」。
   */
  // 浮层开着：点自身之外任意处收起（点击浮层本体 / Dock 的 Home 按钮本身不关）。
  // 组件仅在浮层打开时挂载，无需 enabled 开关。
  useClickOutside({
    enabled: true,
    refs: [rootRef],
    exceptSelectors: [".dock-home-item"],
    capture: true,
    onDismiss,
  });
  /**
   * 右键菜单（Home 的「关闭窗口 / 关闭全部」）会卸载窗口。缩略图里的节点必须**先**放回去，
   * 否则 React 卸载时会找不到原来的父节点。这里直接收起浮层：菜单和缩略图不该同时开着。
   */
  useEffect(() => {
    const onContext = (event: Event) => {
      const target = event.target as Element | null;
      if (target instanceof Element && target.closest(".home-switcher")) return;
      onDismiss();
    };
    document.addEventListener("contextmenu", onContext, true);
    return () => {
      document.removeEventListener("contextmenu", onContext, true);
    };
  }, [onDismiss]);

  // 打开即聚焦第一张：直接按 Enter 就能还原「最近收起的那个」那套手感。
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(".home-switcher-card")?.focus({ preventScroll: true });
  }, []);

  /**
   * 浮层开着时在 root 上挂个标记：小龙（.dragon-pet）是窗口自己用 DOM 造的装饰，
   * 有的挂在窗口里、有的会飘到 body 上，光靠「缩略图内的后代选择器」压不住。
   * 浮层只是一个瞬时状态，整个遮罩期把它们一起收起来最省事。
   */
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("home-switcher-open");
    return () => root.classList.remove("home-switcher-open");
  }, []);

  return (
    <div className="home-switcher-backdrop">
      <div ref={rootRef} className="home-switcher" role="dialog" aria-label="聊天窗口"
        style={{ "--thumb-card-h": `${bodyHeight + THUMB_HEADER_HEIGHT}px` } as CSSProperties}>
        {windowIds.map((windowId) => (
          <ThumbCard key={windowId} windowId={windowId} bodyHeight={bodyHeight} userName={userName} onDismiss={onDismiss} />
        ))}
      </div>
    </div>
  );
}
