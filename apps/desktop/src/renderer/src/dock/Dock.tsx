import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { DownloadIcon, useClickOutside } from "@turingflow/agent-kit/ui";
import { useTranslation } from "../i18n";
import { useLauncher, isHomeChatWindow, homeChatWindows, runningSessionCount } from "../state";
import { isArtifactFileDrag, readDraggedFiles, toLocalAttachments } from "../fileDrop";
import { AppIcon, askIconPalette, DomainEntryIcon, DomainIcon } from "../icons";
import { wallpaperSkinId, type WallpaperSkinId } from "../wallpapers";
import QuickInput from "./QuickInput";
import { clearSavedWindowGeometry } from "./WindowFrame";
import AppearanceMenu from "./AppearanceMenu";
import DomainPicker from "../desktop/DomainPicker";
import SettingsWindow from "../desktop/SettingsWindow";
import AboutWindow from "../desktop/AboutWindow";
import KnowledgeWindow from "../desktop/KnowledgeWindow";
import ContactsWindow from "../contacts/ContactsWindow";
import ContactsDomainChannel from "../contacts/ContactsDomainChannel";
import HomeMessageNotifications from "./HomeMessageNotifications";
import HomeVoiceWave from "./HomeVoiceWave";
import HomeVoiceError from "./HomeVoiceError";
import { describeRecorderFailure, describeSessionFailure, type VoiceFailure } from "./realtimeVoiceError";
import HomeChatSwitcher from "./HomeChatSwitcher";
import { currentVoiceAmplitude, voiceAmplitudeRefFor } from "./voiceLevel";
import { isVoiceHoldKey, startIdleVoiceCapture, stopIdleVoiceCapture } from "./idleVoice";
import { createTencentRealtimeRecorder, createFakeRealtimeRecorder, type RealtimeRecorderHandle } from "./tencentRealtimeRecorder";
import { pinWindowVoiceMode, setPinnedVoiceMode, startWindowVoiceMode, stopWindowVoiceMode } from "./voiceMode";
import { localAgentUrl } from "../localAgentUrl";

/**
 * 把语音转写出的文字填进某个窗口的输入框。
 *
 * 用原生 value setter 触发 React 受控组件更新（直接赋值 .value 不会被 React 捕获）。
 *
 * 两个必须处理的时序问题：
 *  · 窗口刚打开、textarea 还没挂载 —— 用 rAF 轮询重试（最多约 2s），**每次重试都读最新文本**，
 *    所以第一段文字出现时立刻浮出的那个输入框，最终落进去的一定是最新一句完整的话；
 *  · 会话可能已经被新的一次按住取代 —— 用 alive 回调判定，旧的重试不能把新内容盖掉。
 */
function seedComposerText(read: () => string, windowId: string, alive: () => boolean) {
  let tries = 0;
  const apply = () => {
    if (!alive()) return;
    const root = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
    const ta = root?.querySelector<HTMLTextAreaElement>(".chat-input-zone textarea") ?? null;
    if (!ta) {
      if (tries++ < 120) requestAnimationFrame(apply);
      return;
    }
    const text = read();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (setter) setter.call(ta, text);
    else (ta as unknown as { value: string }).value = text;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    // 只在焦点不在输入框时才抢：识别过程中每来一句都 focus() 会把焦点从别的控件上拽走。
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    // 回填后把光标落到文字末尾（转写/草稿回填统一预期），用户可继续手动输入或再按住语音键追加。
    requestAnimationFrame(() => {
      if (!ta.isConnected) return;
      const end = text.length;
      ta.setSelectionRange(end, end);
    });
  };
  apply();
}

/** 只移动一份文字镜像；真实消息仍由聊天组件渲染，换行和字距全程不缩放。 */
function flyVoiceText(root: HTMLElement, textarea: HTMLTextAreaElement, text: string, onComplete: () => void) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onComplete(); return; }
  const source = textarea.getBoundingClientRect();
  const style = getComputedStyle(textarea);
  const padLeft = Number.parseFloat(style.paddingLeft) || 0;
  const padRight = Number.parseFloat(style.paddingRight) || 0;
  const padTop = Number.parseFloat(style.paddingTop) || 0;
  const available = source.width - padLeft - padRight;
  root.style.setProperty("--voice-text-width", `${available}px`);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const longest = Math.max(0, ...text.split("\n").map((line) => context?.measureText(line).width ?? 0));
  const width = Math.min(available, Math.ceil(longest + 2));
  const flight = document.createElement("div");
  flight.className = "voice-message-flight";
  flight.textContent = text;
  Object.assign(flight.style, {
    left: `${source.left + padLeft}px`, top: `${source.top + padTop - textarea.scrollTop}px`,
    width: `${width}px`, fontFamily: style.fontFamily, fontSize: style.fontSize,
    fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing,
    color: style.color,
  });
  document.body.appendChild(flight);
  const previousCount = root.querySelectorAll(".chat-message-row .msg.user .bubble").length;
  let target: HTMLElement | null = null;
  let frame = 0;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    window.clearTimeout(timeout);
    if (frame) cancelAnimationFrame(frame);
    if (target) target.style.visibility = "";
    flight.remove();
    onComplete();
  };
  const findTarget = () => {
    const bubbles = root.querySelectorAll<HTMLElement>(".chat-message-row .msg.user .bubble");
    if (bubbles.length <= previousCount) return;
    target = bubbles[bubbles.length - 1];
    target.style.visibility = "hidden";
    observer.disconnect();
    const started = performance.now();
    const tick = (now: number) => {
      if (!target?.isConnected) { finish(); return; }
      const rect = target.getBoundingClientRect();
      const targetStyle = getComputedStyle(target);
      const x = rect.left + (Number.parseFloat(targetStyle.paddingLeft) || 0) - source.left - padLeft;
      const y = rect.top + (Number.parseFloat(targetStyle.paddingTop) || 0) - source.top - padTop + textarea.scrollTop;
      const progress = Math.min(1, (now - started) / 650);
      const eased = 1 - Math.pow(1 - progress, 3);
      flight.style.transform = `translate3d(${x * eased}px, ${y * eased}px, 0)`;
      if (progress < 1) frame = requestAnimationFrame(tick);
      else finish();
    };
    frame = requestAnimationFrame(tick);
  };
  const observer = new MutationObserver(findTarget);
  observer.observe(root, { childList: true, subtree: true });
  const timeout = window.setTimeout(finish, 4000);
  findTarget();
}

function sendComposerText(windowId: string, text: string, alive: () => boolean, animate = false, releasedAt = 0) {
  let tries = 0;
  const send = () => {
    if (!alive()) return;
    const root = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
    const textarea = root?.querySelector<HTMLTextAreaElement>(".chat-input-zone textarea");
    if (!textarea || textarea.value.trim() !== text.trim() || (animate && !root?.classList.contains("voice-first-chat"))) {
      if (tries++ < 120) requestAnimationFrame(send);
      else root?.removeAttribute("data-voice-sending");
      return;
    }
    if (root?.classList.contains("voice-first-chat")) {
      if (releasedAt && performance.now() - releasedAt < 380) {
        requestAnimationFrame(send);
        return;
      }
      root.dataset.voicePhase = "flight";
      flyVoiceText(root, textarea, text, () => {
        if (!root.isConnected) return;
        root.dataset.voicePhase = "window";
        window.setTimeout(() => {
          if (!root.isConnected || root.dataset.voicePhase !== "window") return;
          root.dataset.voicePhase = "bubble";
          window.setTimeout(() => {
            if (root.dataset.voicePhase === "bubble") root.removeAttribute("data-voice-phase");
          }, 450);
        }, 480);
      });
    }
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  };
  requestAnimationFrame(send);
}

/** 读某个窗口输入框里当前的文字（语音优先：按下去时要把它当成前缀保留，而不是覆盖掉）。 */
function readComposerText(windowId: string): string {
  const root = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
  const ta = root?.querySelector<HTMLTextAreaElement>(".chat-input-zone textarea") ?? null;
  return ta?.value ?? "";
}

/**
 * 这些窗口 id 虽然也在 openWindows 里，但不是「聊天窗」：
 *  · settings / contacts：自己的设置页 / 联系人窗口，没有输入框；
 *  · wechat：数域窗口由原生窗口承担，渲染层没有它的 composer。
 * 语音优先要判断「有没有聚焦的聊天窗」，必须按这个口径排除。
 */
const NON_CHAT_WINDOW_IDS = new Set(["settings", "wechat", "contacts"]);

/** 悬停半秒后浮出输入框，避免路过 Dock 时误触。 */
const HOVER_DELAY_MS = 500;
/**
 * Home 光环的「初始角度」。CSS 里 `.ask-orbit-outer` 的基准 transform 也是 -45deg。
 * 停止时最后一定落回这个角度（视觉上的初始状态）。
 */
const ORBIT_HOME_ANGLE = -45;
/**
 * 光环由两段 180° 对称的弧线组成：转 180° 与 0° 视觉完全一致。
 * 归位时取最近的等价初始态，避免为了回 0° 多转大半圈。
 */
const ORBIT_HOME_PERIOD = 180;
/** 归位阶段的限速（度/秒）：比待机转速略快即可，避免为了对齐突然猛转半圈。 */
const ORBIT_SETTLE_MAX_SPEED = 80;

/**
 * 「任务越多转得越快」的唯一公式：入参是**在跑的任务数**（Dock 角标那个数），返回一圈多少秒。
 *
 *   n=0 → 10s（不会转，仅作为基准值）　n=1 → 10s（= 输入框展开时的基准转速）　n=2 → 4s
 *   n=3 → 2.5s　n=4 → 1.82s　n=5 → 1.43s　n=6 → 1.18s　…　最快 1s（n≥7 到顶）
 *
 * 三条硬约束，改公式时别破坏：
 *   1. 入参只能是 `runningTotal`，不能换成某个窗口自己的计数 ——
 *      一旦两处各算一套，就会出现「角标显示有任务在跑、光环不转」这类对不上的状态。
 *   2. **n=1 必须等于基准周期 10s/圈**：这是「一个任务时的转速 = 输入框展开时的转速」的口径，
 *      也是用户能对照的锚点；基准值变了这里要同步。
 *   3. n≥1 时随 n 单调递减（任务越多越快），最快 1s。n=0 的返回值不参与旋转（target=0，不转）。
 * 导出是为了让验收脚本能直接验这几条，不依赖动画帧。
 */
export function orbitPeriodForRunning(tasks: number): number {
  return Math.max(1, 10 / (1 + Math.max(0, tasks - 1) * 1.5));
}

/**
 * Dock 图标边长（px）。必须和 `styles.css` 里 `.dock-item` / `.icon-wrap` 的 60px 一致：
 * 那边的胶囊高度 = 图标 + 上下 padding 8×2 + 边框 2 = 78，`--dock-reserved-height` 再 +8 = 86。
 * 改这里就要同步改那三个数，否则图标会被圆形容器裁掉或留白。
 */
const DOCK_ICON_SIZE = 60;

/**
 * Dock 内拖动排序的落点。
 *  · `side`  落在 Home 哪一侧（指针过 Home 中线就换边）；
 *  · `index` 该侧数组里「**把自己摘掉之后**」的下标 —— `MOVE_DOCK_DOMAIN` 直接用。
 */
export type DockDropTarget = { side: "left" | "right"; index: number };

/**
 * 拖动 Dock 图标时算落点。
 *
 * 关键约束：**只测同侧其它图标的中心，绝不测被拖的那个**。
 * 拿自己当参照会让落点追着自己跑（自己永远在自己左边）。
 *
 * 导出是为了让验收脚本能在真实 DOM 上直接验落点，不依赖 Playwright 的拖拽模拟。
 */
export function resolveDockDrop(
  dock: HTMLElement | null,
  pins: { left: string[]; right: string[] },
  x: number,
  draggedId: string,
): DockDropTarget | null {
  const home = dock?.querySelector<HTMLElement>(".dock-home-item");
  if (!dock || !home) return null;
  const homeRect = home.getBoundingClientRect();
  const side: "left" | "right" = x < homeRect.left + homeRect.width / 2 ? "left" : "right";
  const rects = (side === "left" ? pins.left : pins.right)
    .filter((id) => id !== draggedId)
    .map((id) => dock.querySelector<HTMLElement>(`.dock-domain-item[data-domain="${id}"]`)?.getBoundingClientRect() ?? null);
  // 落点 = 「中心在指针左边的图标」个数，两侧数组都是视觉上的左→右，所以同一套算法。
  let index = rects.length;
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    if (rect && x < rect.left + rect.width / 2) { index = i; break; }
  }
  return { side, index };
}

function chatOwner(provider: string, unionId: string): string {
  const bytes = new TextEncoder().encode(`${provider}:${unionId}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function onHomeHoverRoute(x: number, y: number): boolean {
  const icon = document.querySelector<HTMLElement>(".dock-home-item")?.getBoundingClientRect();
  const composer = document.querySelector<HTMLElement>(".quick-input[data-window-id='primary'] .chat-composer-stack")?.getBoundingClientRect();
  if (!icon || !composer) return false;
  const progress = Math.max(0, Math.min(1, (y - composer.bottom) / Math.max(1, icon.top - composer.bottom)));
  const center = (composer.left + composer.right) / 2;
  const halfWidth = composer.width / 2 * (1 - progress) + icon.width / 2 * progress + 32;
  return y >= composer.bottom - 12 && y <= icon.bottom + 12 && Math.abs(x - center) <= halfWidth;
}

/** 当前角度前方最近的「初始等价角度」还差多少（0..180，保持原旋转方向）。 */
function orbitHomeOffset(angle: number): number {
  // 求“下一个初始等价角”在前方多远：两段对称弧每 180° 出现一次同样的姿态。
  return ((ORBIT_HOME_ANGLE - angle) % ORBIT_HOME_PERIOD + ORBIT_HOME_PERIOD) % ORBIT_HOME_PERIOD;
}

export default function Dock() {
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  /** 自动隐藏 Dock：开启时 Dock 缩到屏幕外，鼠标移到屏幕底部边缘才滑出（动画对齐 macOS）。 */
  const autoHideDock = launcher.autoHideDock ?? false;
  /** Dock 上常驻「数域」入口（默认关）：Home 右侧那个 Launchpad 样式的图标。 */
  const dockDomainEntry = launcher.dockDomainEntry ?? false;
  const [dockRevealed, setDockRevealed] = useState(false);
  const autoHideTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!autoHideDock) { setDockRevealed(false); return; }
    // 距离屏幕底边的触发带：窄一点才像 macOS（只有指针真正贴近底边才唤出）。
    const EDGE = 8;
    const scheduleHide = () => {
      if (autoHideTimerRef.current !== null) window.clearTimeout(autoHideTimerRef.current);
      // 鼠标离开 Dock 后的收起滞留时间：比 macOS 默认的约 400ms 更长，避免指针一偏就立刻收起。
      autoHideTimerRef.current = window.setTimeout(() => setDockRevealed(false), 1200);
    };
    // React 19 把 WindowEventMap 的 mousemove 改成了 React.MouseEvent，故这里用与
    // addEventListener 一致的参数类型，避免 DOM/合成事件类型打架。
    const onMove = (event: WindowEventMap["mousemove"]) => {
      const nearBottom = event.clientY >= window.innerHeight - EDGE;
      // 已滑出时指针落在 Dock 上要保活；隐藏时 Dock 在屏幕外，:hover / contains 都拿不到，靠 nearBottom 唤醒。
      const overDock = dockRef.current != null
        && (dockRef.current.matches(":hover") || (event.target instanceof Element && dockRef.current.contains(event.target)));
      if (nearBottom || overDock) {
        if (autoHideTimerRef.current !== null) { window.clearTimeout(autoHideTimerRef.current); autoHideTimerRef.current = null; }
        setDockRevealed(true);
      } else {
        scheduleHide();
      }
    };
    window.addEventListener("mousemove", onMove, true);
    return () => {
      window.removeEventListener("mousemove", onMove, true);
      if (autoHideTimerRef.current !== null) window.clearTimeout(autoHideTimerRef.current);
    };
  }, [autoHideDock]);
  // 把「自动隐藏」挂到根节点：CSS 据此把 --dock-reserved-height 归零（桌面网格与最大化窗口都不再给 Dock 留位）。
  useEffect(() => {
    document.documentElement.classList.toggle("dock-auto-hide", autoHideDock);
    return () => document.documentElement.classList.remove("dock-auto-hide");
  }, [autoHideDock]);
  useEffect(() => () => { if (autoHideTimerRef.current !== null) window.clearTimeout(autoHideTimerRef.current); }, []);
  const { t } = useTranslation();
  const [updateRelease, setUpdateRelease] = useState<{ version: string } | null>(null);
  const [updateDownload, setUpdateDownload] = useState<{ phase: string; downloaded: number; total: number }>({ phase: "idle", downloaded: 0, total: 0 });
  useEffect(() => {
    let alive = true;
    let receivedEvent = false;
    let receivedDownload = false;
    const unsubscribe = window.launcher.updater.onAvailable((release) => {
      receivedEvent = true;
      if (alive) setUpdateRelease(release);
    });
    const unsubscribeDownload = window.launcher.updater.onDownloadState((download) => {
      receivedDownload = true;
      if (alive) setUpdateDownload(download);
    });
    void window.launcher.updater.status().then((status) => {
      if (alive && !receivedEvent) setUpdateRelease(status.release);
      if (alive && !receivedDownload) setUpdateDownload(status.download);
    }).catch(() => {});
    return () => { alive = false; unsubscribe(); unsubscribeDownload(); };
  }, []);
  // Dock 上的角标只负责「告诉你更新在哪」：点击打开外观菜单，
  // 真正的下载/重启升级在菜单「关于」行里确认，避免误点一下就重启应用。
  const updateBadgeLabel = updateRelease
    ? updateDownload.phase === "downloading" && updateDownload.total > 0
      ? t("update.downloadingPercent", { percent: Math.min(100, Math.round(updateDownload.downloaded / updateDownload.total * 100)) })
      : t("update.available", { version: updateRelease.version })
    : "";
  const [homeUnread, setHomeUnread] = useState(0);
  const unreadParts = useRef({ local: 0, cloud: 0 });
  const unreadRefreshId = useRef(0);
  const [inboxTick, setInboxTick] = useState(0);
  const onInboxMessage = useCallback(() => setInboxTick(tick => tick + 1), []);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const requestId = ++unreadRefreshId.current;
      let user: Awaited<ReturnType<typeof window.launcher.getWebSession>>;
      try { user = await window.launcher.getWebSession(); } catch { return; }
      const owner = chatOwner(user?.provider || "local", user?.unionId || "guest");
      const localChat = (window as Window & { agentHost?: { localChat?: { list: (owner: string) => Promise<Array<{ aiUnread?: boolean }>> } } }).agentHost?.localChat;
      const [local, cloud] = await Promise.all([
        localChat?.list(owner).catch(() => null) ?? Promise.resolve(null),
        user ? window.launcher.webChatApi("GET", "/api/sessions").then(response => response.status === 200 ? JSON.parse(response.body) : null).catch(() => null) : Promise.resolve([]),
      ]);
      if (!active || requestId !== unreadRefreshId.current) return;
      if (local) unreadParts.current.local = local.filter(session => session.aiUnread).length;
      if (cloud !== null) {
        const cloudRows = Array.isArray(cloud) ? cloud : Array.isArray(cloud?.sessions) ? cloud.sessions : [];
        unreadParts.current.cloud = cloudRows.reduce((sum: number, session: { memberCount?: number; coworkEverGroup?: boolean; unreadCount?: number; aiUnread?: boolean }) =>
          sum + ((session.memberCount ?? 0) > 0 || session.coworkEverGroup ? (session.unreadCount ?? 0) + (session.aiUnread ? 1 : 0) : 0), 0);
      }
      setHomeUnread(unreadParts.current.local + unreadParts.current.cloud);
    };
    void refresh();
    const off = window.launcher.onDesktopSessionsChanged(() => { void refresh(); });
    const offSession = window.launcher.onWebSessionChanged(() => { void refresh(); });
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { active = false; off(); offSession(); window.clearInterval(timer); };
  }, [inboxTick]);
  // 同步未读数到 macOS 系统 Dock badge
  useEffect(() => {
    window.launcher.setUnreadBadge(homeUnread);
  }, [homeUnread]);
  // 静态 / 动态是壁纸模式：皮肤跟随所选壁纸；浅色 / 深色即皮肤本身。
  // 防御：任何意外值（如旧持久化残留）都回落到壁纸皮肤，避免图标配色查表崩溃。
  const skin: WallpaperSkinId | "light" | "dark" = launcher.appearance === "light" || launcher.appearance === "dark"
    ? launcher.appearance
    : wallpaperSkinId(launcher.wallpaper);
  const primary = launcher.dockItems.find((i) => i.kind === "primary") ?? launcher.dockItems[0];
  const pins = launcher.dockPins ?? { left: [], right: [] };
  const dragging = state.draggingDomain;
  const draggedDomain = dragging
    ? (launcher.domains.find((domain) => domain.id === dragging.id)
      ?? (dragging.id === "settings" ? { id: "settings", name: "设置" } : null)
      ?? (dragging.id === "domains" ? { id: "domains", name: "数域" } : null))
    : null;
  /**
   * 刚从「选择数域」拖进来、刚刚落下的那一格。
   *
   * 拖动过程中落点预览（.dock-drop-slot）已经把它按**最终尺寸**画在最终位置了，所以松手时
   * 真图标必须原地直接接上：
   *  · 不能再放 `dock-pin-in` 入场动画 —— 预览是满尺寸，真图标却从 scale(.72)/opacity 0 长出来，
   *    这一进一退看着就是「闪一下」；
   *  · 预览格也不能带着 200ms 过渡收掉 —— 它会和新图标同时占宽，整个胶囊先胀大再缩回，
   *    整条 Dock 跟着抖一下（实测宽 212 → 280 → 212）。
   *
   * 用「上一次渲染时的拖拽态」在 render 里就地判断，不额外存 state：这样真图标**首次挂载的那一帧**
   * 就带着抑制类，不会先播一帧动画再被纠正。600ms 只是让这个标记自然过期，避免下次重新固定
   * 同一个图标时也被误抑制。
   */
  const landedPinnedRef = useRef<{ id: string; until: number } | null>(null);
  const prevDraggingRef = useRef(dragging);
  if (prevDraggingRef.current && !dragging && prevDraggingRef.current.source === "sidebar") {
    landedPinnedRef.current = { id: prevDraggingRef.current.id, until: performance.now() + 600 };
  }
  prevDraggingRef.current = dragging;
  const landedPinnedId = landedPinnedRef.current && performance.now() < landedPinnedRef.current.until
    ? landedPinnedRef.current.id
    : null;
  const onDesktop = state.view === "desktop";
  /** 已打开的窗口（"primary" + 数域 id），末尾最上层。 */
  const openWindows = state.openWindows;
  const primaryOpen = openWindows.includes("primary");
  /** 当前聚焦（最上层）窗口 = openWindows 最后一个；多窗口时给聚焦窗口更亮的边框。 */
  const focusedWindowId = openWindows.at(-1) ?? null;
  const multiWindow = openWindows.length > 1;
  /**
   * 窗口的**渲染顺序**必须稳定，且与 openWindows 的层叠顺序解耦。
   *
   * openWindows 的顺序 = 层叠顺序（末尾在最前），焦点变化会改它；z-index 依旧按 indexOf 算。
   * 但如果 JSX 顺序也跟着这个数组走，置顶就会在 mousedown 与 mouseup 之间把被点的窗口节点
   * 搬到兄弟节点末尾 —— Chromium 会因此直接丢弃这次 click，表现成「点第一下只让窗口聚焦、
   * 控件要点两次才生效」。所以这里按「第一次出现时的顺序」固定渲染顺序，置顶只改 z-index。
   */
  const windowSeqRef = useRef(new Map<string, number>());
  const windowSeqNextRef = useRef(0);
  function stableWindowOrder(ids: string[]): string[] {
    for (const id of ids) {
      if (!windowSeqRef.current.has(id)) windowSeqRef.current.set(id, windowSeqNextRef.current++);
    }
    return [...ids].sort((a, b) => (windowSeqRef.current.get(a) ?? 0) - (windowSeqRef.current.get(b) ?? 0));
  }
  useEffect(() => { if (primaryOpen) void window.launcher.bringHomeForward(); }, [primaryOpen]);
  /** 未固定但正在运行的数域：像 macOS 里从 Launchpad 打开、还没拖进 Dock 的应用，先临时占个位。 */
  const launchedUnpinned = state.launchedDomains.filter((id) => openWindows.includes(id) && !pins.left.includes(id) && !pins.right.includes(id));
  /**
   * 「在跑的任务数」——Home 这一块**唯一**的运行态口径，角标数字和光环转速都只能用它。
   *
   * 为什么不是各窗口相加：同一轮任务可能被两个实例同时上报（桌面拖文件发起的那轮跑在
   * 隐藏实例里，打开 home chat 后又被聊天窗接管），相加会把一轮算成两个。
   *
   * 为什么必须只留这一份：以前角标用「全部上报方」、光环用 `runningByWindow.primary`，
   * 两个口径一旦分叉就会出现「角标显示 1 个任务在跑、Home 却纹丝不动」这种对不上的状态。
   * 加新上报方（例如桌面后台实例）时，只需要保证它写进 runningSessionsByWindow，
   * 角标和光环会一起生效 —— 不要再单独给某处算一套。
   */
  const runningTotal = runningSessionCount(state.runningSessionsByWindow);
  /**
   * 「语音优先任务正在被大模型处理」：开启语音优先、且存在仍处于极简态的窗口有会话在跑。
   * 此时 Home 正中实心圆切换为空心方块（停止语义），点击 Home 优先停止该任务，
   * 不停止后台其他窗口的任务（那些任务继续跑）。
   */
  const voiceFirstRunning = Boolean(launcher.voiceFirst) && state.voiceFirstMinimal.some((id) => (state.runningSessionsByWindow[id]?.length ?? 0) > 0);
  /** 最小化（隐藏但会话继续后台跑）的窗口：不卸载、不可见，点 Dock 图标恢复。 */
  const minimizedWindows = state.minimizedWindows;
  const primaryMinimized = minimizedWindows.includes("primary");
  /**
   * Home 这一族窗口（"primary" + 「新建窗口」开出的 primary-<n>）的现状。
   *  · open      —— 可见的（顺序即最上层顺序）；
   *  · minimized —— 收起的（实例还挂着，状态全在）；
   *  · all       —— 两者合计；**空 = 没有进行中的 chat**，Dock 底部的灰点跟着它灭。
   */
  const homeWindows = homeChatWindows(openWindows, minimizedWindows);
  /** 「多窗口预览」浮层是否打开（收起 ≥2 个 home chat 时点 Home 弹出）。 */
  const [homeSwitcherOpen, setHomeSwitcherOpen] = useState(false);
  // 浮层自己只在「一扇 home 窗口都不剩」或离开桌面时收起：在预览里连点关闭按钮，
  // 不该第一个按下就把整层浮层收掉（还剩的那扇就再也点不到了）。改用 all（已打开+收起），
  // 因为现在未最小化的多窗口也会开这个浮层，不能按「收起数」判断。
  useEffect(() => {
    if (!homeSwitcherOpen) return;
    if (!onDesktop || homeWindows.all.length === 0) setHomeSwitcherOpen(false);
  }, [homeSwitcherOpen, onDesktop, homeWindows.all.length]);

  const hoverTimer = useRef<number | null>(null);
  const hoverExitTimer = useRef<number | null>(null);
  /**
   * 图标上方那个「名字气泡」（macOS Dock 同款）。
   *
   * hover 本身**不改任何视觉**（不加底色、不提亮），名字气泡就是唯一的 hover 反馈。
   * 位置用 fixed 坐标算好在图标正上方，再 portal 到 body：Dock 在横向溢出时会 `overflow-x: auto`，
   * 气泡挂在里面会被裁掉。
   */
  const [dockTip, setDockTip] = useState<{ label: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<number | null>(null);
  /** 离开图标后的「延迟收起」定时器：图标之间的空隙不该把气泡收掉。 */
  const tipHideTimer = useRef<number | null>(null);
  /** 气泡此刻是否已经显示：已经显示时换图标要立刻跟随，不再重新等延迟。 */
  const tipShown = useRef(false);
  const hasText = useRef(false);
  /**
   * 输入框「有内容」（文字**或**附件）。
   * 只看文字的话，"拖了一个文件进去但还没打字"会被当成空输入 → 悬浮输入框自动收起 → 附件丢了。
   */
  const hasContent = useRef(false);
  /** 正在把文件往 home 按钮上拖：这时不能因为指针移动把悬浮输入框收起来。 */
  const fileDragActive = useRef(false);
  /**
   * Dock 内拖动的活动记录。
   *  · `at`     松手后要落到的位置（side + 去掉自己之后的下标），由 pointermove 实时算；
   *  · `origin` 按下那一刻的位置：拖动中途被取消（窗口失焦、pointercancel）要还原回去，
   *             因为位置是**边拖边改**的，不还原就会停在被拖到一半的地方。
   * 存在 ref 而不是 state，因为收尾的 window pointerup 监听器是首次渲染的闭包，
   * 读 state 会读到旧值。
   */
  const dockDragRef = useRef<{
    id: string; x: number; y: number; active: boolean;
    /** 按下点 → 图标中心的偏移：幽灵图标按它跟随，起手时正好压在原图标上，不会"跳"到指针中心。 */
    ox: number; oy: number;
    at: DockDropTarget | null;
    origin: DockDropTarget | null;
  } | null>(null);
  /**
   * pins 的实时快照。
   * 拖动过程中会真的换位（pins 一直在变），而 pointermove 监听器挂在 window 上、
   * 是首次渲染的闭包 —— 直接读 `pins` 会一直读到拖动开始前那一份。
   */
  const pinsRef = useRef(pins);
  useEffect(() => { pinsRef.current = pins; });
  const dockDragFrameRef = useRef<number | null>(null);
  const dockDidDragRef = useRef(false);
  const orbitRef = useRef<HTMLDivElement | null>(null);
  const orbitFrameRef = useRef<number | null>(null);
  const orbitMotionRef = useRef<{ angle: number; speed: number; target: number; last: number; stopTarget: number | null }>({
    angle: ORBIT_HOME_ANGLE,
    speed: 0,
    target: 0,
    last: 0,
    stopTarget: null,
  });
  const [pendingContacts, setPendingContacts] = useState(0);
  /** 待机态下，本组件自己接管的语音录音是否激活（防止 keydown 自动重复反复触发）。 */
  const idleVoiceActiveRef = useRef(false);
  /** 待机态这次录音是否配了真实转写（有本机 Agent 服务时才有）：决定松手后是"结束"还是"开始转写"。 */
  const idleTranscribeRef = useRef(false);
  /** 转写兜底定时器：ASR 迟迟不返回时把「处理中」状态关掉。 */
  const idleTranscribeTimerRef = useRef<number | undefined>(undefined);
  /** 本轮待机语音是否已经把输入框打开（转写完成才打开）：成功/失败/超时兜底都只开一次。 */
  const idleComposerOpenedRef = useRef(false);
  /** 腾讯云 wss 实时转录录音器（按住 Option 期间）。 */
  const realtimeRecorderRef = useRef<RealtimeRecorderHandle | null>(null);
  const realtimeActiveRef = useRef(false);
  /** 最近一次 state 的快照：语音/自动消失的回调都是异步的，闭包里的 state 会过期。 */
  const stateRef = useRef(state);
  stateRef.current = state;
  /**
   * 这一次「按住语音键」的目标（语音优先）。
   *
   *  · `{ mode: "composer", windowId }` —— 有聚焦的聊天窗：只把语音转成文字写进它的输入框；
   *  · `{ mode: "new-chat" }`          —— 桌面上没有聊天窗：第一段文字出现才浮出输入框，
   *    松手等识别结束后**直接以新对话发出去**。
   *
   * 按下时定下目标，整轮（含松手后等待 final 的异步段）都以它为准 —— 中途窗口开关不改变这一次的语义。
   */
  const voiceTargetRef = useRef<{ mode: "composer"; windowId: string } | { mode: "new-chat" } | null>(null);
  /** 按下那一刻输入框里已有的文字：语音是「接着说」，最终文本 = 这段 + 识别结果。 */
  const voiceDraftRef = useRef("");
  /** 本次识别累计的文本（recorder 每帧回调）。 */
  const voiceTextRef = useRef("");
  /** 新对话模式下是否已经因为「第一段文字出现」把输入框浮出来了。 */
  const voiceInputShownRef = useRef(false);
  /** 第几次按住：松手后的异步回调靠它判定「这一轮是否已经被新的一轮取代」。 */
  const voiceSessionRef = useRef(0);

  /**
   * 松手后把「本轮累计的识别文本 / 草稿前缀 / 已浮出输入框标记」一次性清空。
   *
   * 这些 ref 不是按下时重置的（按下时 beginVoiceFirst 会重置），而是**松手时**必须清干净，
   * 否则下一次按下的首字判定、草稿拼接会受上一次残留的记录影响。
   * 结构性 ref（voiceTargetRef / realtimeActiveRef / realtimeRecorderRef）在 finish 开头已置空，
   * 这里只管这批「内容」状态。
   */
  const resetVoiceTextState = () => {
    voiceTextRef.current = "";
    voiceDraftRef.current = "";
    voiceInputShownRef.current = false;
  };

  useEffect(() => {
    function onPointerMove(event: PointerEvent) { trackDockDrag(event.clientX, event.clientY); }
    function onPointerUp(event: PointerEvent) { finishDockDrag(event.clientY); }
    function onPointerCancel() { finishDockDrag(0, true); }
    // pointermove 挂在 window 而不是按钮上：拖动中图标要真的换位（DOM 重新排序），
    // 按钮上的 pointer capture 在节点被移动后不保证还在，窗口级监听不受影响。
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("blur", onPointerCancel);
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("blur", onPointerCancel);
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      if (dockDragFrameRef.current !== null) window.cancelAnimationFrame(dockDragFrameRef.current);
      if (orbitFrameRef.current !== null) window.cancelAnimationFrame(orbitFrameRef.current);
      orbitFrameRef.current = null;
      orbitMotionRef.current.last = 0;
    };
  }, []);

  const homeActive = primaryOpen || !onDesktop;
  /** Home 的声波只响应 Home 自己的录音或转写；数域状态不驱动 Home。 */
  const voiceWindow = state.voiceRecordingWindow;
  /** 正在转写（ASR 处理中）的窗口：松手后到文字出来之前，Home 声波切"处理中"动画。 */
  const transcribingWindow = state.voiceTranscribingWindow;
  /** Home 的声波/光环在录音态与转写态都要保持可见（松手后录音窗口已清、只剩转写窗口在）。 */
  const voiceActive = voiceWindow !== null || transcribingWindow !== null;
  /** 转写态独立判定：松手 CLEAR_VOICE_RECORDING 后 voiceActive 仍由 transcribingWindow 撑住，动画才能播。 */
  const voiceTranscribing = transcribingWindow !== null;
  /** 声波竖线用 Home 图标的主色（跟图标同一套配色，深浅色都不违和）。 */
  const waveColor = askIconPalette(skin).core;
  /** 外围辉光：参考图是蓝色辉光；深浅色都用同一个蓝，靠不透明度区分强弱。 */
  const glowColor = "#5b9cff";

  // 光环转速：唯一口径是上面的 runningTotal（= 角标那个数），任务越多转得越快。
  // 这里只算**目标速度**——真正的加速/减速在下面 rAF 里用指数缓动逼近 target，
  // 所以多一个任务时是"越转越快"的过渡，不会瞬间飙到最高速。
  const orbitPeriodSeconds = orbitPeriodForRunning(runningTotal);

  /**
   * 语音模式（Windows 按住右 Alt / macOS 按住 Option）仍要让 Home 光环转起来：
   * 语音不属于「运行中的会话」，但它是用户正在进行的交互，按住键 Home 纹丝不动手感不对。
   * 语音态单独给一个轻快的周期（≤6s），取「会话周期、6s」里更短的那个；
   * 转写中再快一档（≤2.2s）：配合声波的扫描波，明确表达"正在处理"。
   */
  const voiceOrbitPeriod = Math.min(6, orbitPeriodSeconds);
  const transcribeOrbitPeriod = Math.min(2.2, voiceOrbitPeriod);
  /**
   * 光环只由「正在执行的会话」驱动：
   *  · 有运行中会话（runningTotal>0）→ 按任务数转：1 个任务 = 输入框展开时的基准 10s/圈，
   *    任务越多越快（见 orbitPeriodForRunning）；
   *  · 没有运行中会话 → 一律不转。输入框展开、Home 窗口打开 / 最小化 / 全部关掉、
   *    hover 预览都不再触发旋转；
   *  · 语音录音 / 转写 → 按语音周期转（见上），这是独立的交互态，不占用任务转速档位。
   * 停止时不直接把 target 归零就完事：rAF 里会先减速并回正到 ORBIT_HOME_ANGLE，避免停在半路。
   */
  const orbitTarget = runningTotal > 0
    ? 360 / (voiceTranscribing ? transcribeOrbitPeriod : voiceActive ? voiceOrbitPeriod : orbitPeriodSeconds)
    : voiceActive
      ? 360 / (voiceTranscribing ? transcribeOrbitPeriod : voiceOrbitPeriod)
      : 0;

  useEffect(() => {
    const motion = orbitMotionRef.current;
    motion.target = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : orbitTarget;
    if (orbitFrameRef.current !== null || (motion.target === 0 && motion.speed === 0)) return;
    const tick = (time: number) => {
      const frame = orbitMotionRef.current;
      const dt = frame.last ? Math.min((time - frame.last) / 1000, 0.05) : 0;
      frame.last = time;
      if (frame.target > 0) {
        frame.stopTarget = null;
        // 加速/减速的时间常数：越小越"跟手"。用 0.22s 加速，开会话后约 0.7s 就能到目标转速；
        // 减速 0.38s（比加速慢一点，会话结束后不要猛地一顿）。
        const easingSeconds = frame.target > frame.speed ? 0.22 : 0.38;
        frame.speed += (frame.target - frame.speed) * (1 - Math.exp(-dt / easingSeconds));
        frame.angle = (frame.angle + frame.speed * dt) % 360;
      } else {
        // —— 回到初始姿态再停 ——
        // 不能只是把速度衰减到 0：那样会停在任意角度，Home 图标回不到初始状态。
        // 进入减速时先锁定一个目标角度（最近的初始等价姿态），整个减速阶段都朝它走。
        if (frame.stopTarget === null) {
          let distance = orbitHomeOffset(frame.angle);
          // 剩余距离不够用于平滑减速时，宁可继续转一个对称周期（180°）再收住，
          // 也不要从高速直接一顿停死。低速时距离短就直接停，不会白转半圈。
          if (frame.speed > 60 && distance < Math.max(8, frame.speed * 0.3)) distance += ORBIT_HOME_PERIOD;
          frame.stopTarget = frame.angle + distance;
        }
        const remaining = frame.stopTarget - frame.angle;
        const settleSpeed = remaining <= 0.02
          ? 0
          : Math.min(ORBIT_SETTLE_MAX_SPEED, Math.max(remaining * 1.6, 4));
        const easingSeconds = settleSpeed > frame.speed ? 0.22 : 0.38;
        frame.speed += (settleSpeed - frame.speed) * (1 - Math.exp(-dt / easingSeconds));
        // 本帧不越过目标：越接近初始姿态，步长越小，最后自然收住而不是回弹。
        const step = Math.min(frame.speed * dt, remaining);
        if (remaining - step <= 0.02) {
          frame.angle = ORBIT_HOME_ANGLE;
          frame.stopTarget = null;
          frame.speed = 0;
        } else {
          // 减速阶段不做 360° 取模：stopTarget 是包含整圈数的绝对角度。
          frame.angle += step;
        }
      }
      const orbit = orbitRef.current?.querySelector<SVGElement>(".ask-orbit-outer");
      if (orbit) orbit.style.transform = `rotate(${frame.angle}deg)`;
      if (frame.target > 0 || frame.speed > 0) orbitFrameRef.current = window.requestAnimationFrame(tick);
      else { orbitFrameRef.current = null; frame.last = 0; }
    };
    motion.last = 0;
    orbitFrameRef.current = window.requestAnimationFrame(tick);
  }, [orbitTarget]);

  /**
   * 语音链路的失败上报（唯一出口）。
   *
   * 以前这条链路上的失败是「静默复位」：签发 503 就清掉录音态、什么都不显示 ——
   * 表现就是按住 Option 毫无反应，排查时完全不知道是没登录、没配腾讯云凭据、还是麦克风没权限。
   * 现在一律 console.error 打全量信息 + 在 Home 上方浮一条可操作的错误条。
   *
   * 同时负责把录音态、录音器引用收干净：失败后不能留一个「还在录音」的假状态。
   */
  const reportVoiceFailure = useCallback((failure: VoiceFailure) => {
    console.error("[launcher] 语音转写失败：", failure.message, failure.detail ?? "");
    realtimeActiveRef.current = false;
    const recorder = realtimeRecorderRef.current;
    realtimeRecorderRef.current = null;
    void recorder?.cancel().catch(() => undefined);
    const voiceTarget = voiceTargetRef.current;
    voiceTargetRef.current = null;
    const windowId = voiceTarget?.mode === "composer" ? voiceTarget.windowId : "primary";
    // 两个都清：reducer 只清「当前正在录的那个窗口」，不匹配的派发是空操作，
    // 这样就不必在这里维护一份「本次录音挂在哪个窗口上」的额外账本。
    dispatch({ type: "CLEAR_VOICE_RECORDING", windowId });
    dispatch({ type: "CLEAR_VOICE_RECORDING", windowId: "primary" });
    dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId });
    dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId: "primary" });
    // 摘掉语音模式：输入框恢复完整控件（失败时也要摘，否则会留在半透明态）。
    // 极简窗例外：它被 pin 住了，标记保留（极简外观一直保持到窗口关闭）。
    stopWindowVoiceMode();
    // 新对话模式下失败时，如果为了显示文字已经把输入框浮出来了，收掉它：
    // 留一个空输入框会让人以为「语音没识别到」，而真正的错误条在 Home 上方。
    if (voiceInputShownRef.current) {
      voiceInputShownRef.current = false;
      dispatch({ type: "SET_QUICK_INPUT", open: false });
    }
    dispatch({ type: "SET_VOICE_ERROR", message: failure.message, detail: failure.detail, action: failure.action });
  }, [dispatch]);

  /**
   * 当前「聚焦的聊天窗」（可以把语音写进它的输入框）。
   *
   * 只认最上层窗口：语音优先的语义是「对着眼下正在看的那个窗口说话」。
   * 设置 / 联系人 / 微信（原生窗口）虽然也在 openWindows 里，但不是聊天窗，一律排除。
   */
  const focusedChatWindow = useCallback((): string | null => {
    const s = stateRef.current;
    const front = s.focusDockItemId;
    if (!front || !s.openWindows.includes(front)) return null;
    if (isHomeChatWindow(front)) return front;
    if (NON_CHAT_WINDOW_IDS.has(front)) return null;
    return (s.launcher?.domains ?? []).some((domain) => domain.id === front) ? front : null;
  }, []);

  /**
   * 按住语音键（语音优先）：按下即开录，两种落点见 voiceTargetRef。
   *
   * 顺序上「先亮状态、再连服务」：用户按下就要看到 Home 开始转圈 + 声波，
   * 而不是等 200ms 的会话请求回来才动。失败会被 reportVoiceFailure 收干净。
   */
  const beginVoiceFirst = useCallback(() => {
    const s = stateRef.current;
    const focused = focusedChatWindow();
    // 极简新聊天只从没有任何聊天窗的桌面进入；有聊天窗但焦点在别处时不暗中创建新窗。
    const hasChatWindow = [...s.openWindows, ...s.minimizedWindows].some((id) =>
      isHomeChatWindow(id) || (s.launcher?.domains ?? []).some((domain) => domain.id === id));
    if (!focused && (s.view !== "desktop" || hasChatWindow)) return;
    const voiceTarget = focused
      ? { mode: "composer" as const, windowId: focused }
      : { mode: "new-chat" as const };
    const windowId = voiceTarget.mode === "composer" ? voiceTarget.windowId : "primary";
    const session = voiceSessionRef.current + 1;
    voiceSessionRef.current = session;
    voiceTargetRef.current = voiceTarget;
    voiceTextRef.current = "";
    voiceInputShownRef.current = false;
    // 输入框里已有的文字要保留：语音是「接着说」，最终文本 = 这段 + 识别结果。
    // （新对话模式下通常为空；用户如果已经打了半句，也会被一起发出去，不会丢。）
    voiceDraftRef.current = readComposerText(windowId).trim();
    realtimeActiveRef.current = true;
    // 重新尝试就先把上一条错误收掉：否则新一次失败看起来像"没反应"，其实是被旧气泡挡着。
    dispatch({ type: "CLEAR_VOICE_ERROR" });
    dispatch({ type: "SET_VOICE_RECORDING", windowId });
    // 输入框切「语音模式」：只留中间文字、背景半透明（复用原 composer，不另做一套）。
    startWindowVoiceMode(windowId);

    /**
     * 实时转写每收到一帧文本的回写逻辑（真 / 假录音器共用）：
     *  · 累计文本进 voiceTextRef，松手时据此发出；
     *  · 没有聊天窗时，第一段文字出现才把输入框浮出来（此前桌面只有 Home 的转圈 + 声波）；
     *  · 把完整文本灌进目标窗口的 composer（聚焦窗 → 那个窗；新对话 → primary 预览窗）。
     */
    const onRealtimeResult = ({ text }: { text: string }) => {
      voiceTextRef.current = text;
      const current = voiceTargetRef.current;
      if (!current) return;
      if (current.mode === "new-chat" && !voiceInputShownRef.current) {
        if (!text.trim()) return;
        voiceInputShownRef.current = true;
        dispatch({ type: "SET_QUICK_INPUT", open: true });
      }
      seedComposerText(
        () => (voiceDraftRef.current ? `${voiceDraftRef.current} ${voiceTextRef.current}` : voiceTextRef.current),
        current.mode === "composer" ? current.windowId : "primary",
        // 只认这一次按住：松手后最后一帧结果仍要写进去，但被下一轮取代后就不能再动输入框。
        () => voiceSessionRef.current === session,
      );
    };
    const onRealtimeAmplitude = (value: number) => { voiceAmplitudeRefFor(windowId).current = value; };

    // 预览模式：不连腾讯云、不申请麦克风，用假录音器把演示文案流式灌进去，
    // 让整条语音优先交互（转圈→声波→首字浮出输入框→松手自动发）在本机就能验收。
    if (s.launcher?.voicePreviewOnly) {
      void (async () => {
        try {
          const recorder = await createFakeRealtimeRecorder({ onResult: onRealtimeResult, onAmplitude: onRealtimeAmplitude });
          if (voiceSessionRef.current !== session || !realtimeActiveRef.current) {
            void recorder.cancel().catch(() => undefined);
            return;
          }
          realtimeRecorderRef.current = recorder;
        } catch (error) {
          if (voiceSessionRef.current === session) reportVoiceFailure(describeRecorderFailure(error));
        }
      })();
      return;
    }

    // 实时转写需要远程服务支持，本机没有独立登录态。
    const webUrl = s.webAuth?.url;
    if (!webUrl) {
      reportVoiceFailure({
        message: "使用语音需要先登录",
        detail: "登录后即可使用语音转写功能",
        action: "login",
      });
      return;
    }
    void (async () => {
      try {
        const result = await window.launcher.webChatApi("POST", "/api/audio/session", undefined);
        if (voiceSessionRef.current !== session || !realtimeActiveRef.current) return; // 握手期间已经松手
        if (result.status !== 200) {
          reportVoiceFailure(describeSessionFailure(result.status, result.body));
          return;
        }
        const body = JSON.parse(result.body) as { connection?: { url?: string } };
        if (!body.connection?.url) {
          reportVoiceFailure({ message: "语音服务启动失败", detail: "请稍后重试" });
          return;
        }
        // 诊断日志：握手失败时先分清是哪一层
        console.log(`[voice-first] 语音会话建立 → ${result.status}`);
        const recorder = await createTencentRealtimeRecorder({
          url: body.connection.url,
          onResult: onRealtimeResult,
          onAmplitude: onRealtimeAmplitude,
          // 会话中途出错（腾讯云返回非 0、wss 断开）：同样走统一出口，别静默停掉。
          onError: (error) => { if (voiceSessionRef.current === session) reportVoiceFailure(describeRecorderFailure(error)); },
        });        if (voiceSessionRef.current !== session || !realtimeActiveRef.current) {
          void recorder.cancel().catch(() => undefined);
          return;
        }
        realtimeRecorderRef.current = recorder;
      } catch (error) {
        if (voiceSessionRef.current !== session) return;
        reportVoiceFailure(describeRecorderFailure(error));
      }
    })();
  }, [dispatch, focusedChatWindow, reportVoiceFailure]);

  /**
   * 松开语音键（语音优先）。
   *
   * 关键在「等」：先让 recorder 把 end 发出去、等腾讯云把最后一句推完，拿到完整文本。
   * 拿到后**不自动发送**（取消发送）——文字已经流式写进目标窗口的输入框，
   * 发不发、什么时候发由用户自己决定。这样既「按住即说」，松手后也不会糊里糊涂发出去。
   *  · 聚焦窗口 → 文字在它的输入框里，退出语音模式即可；
   *  · 没有窗口（新对话）→ 把预览窗提升为完整窗口，文字留在输入框，不自动发。
   */
  const finishVoiceFirst = useCallback(() => {
    const voiceTarget = voiceTargetRef.current;
    if (!voiceTarget) return;
    const session = voiceSessionRef.current;
    const releasedAt = performance.now();
    const voiceRoot = document.querySelector<HTMLElement>(`[data-window-id="${voiceTarget.mode === "composer" ? voiceTarget.windowId : "primary"}"]`);
    if (voiceRoot && (voiceTarget.mode === "new-chat" || voiceRoot.classList.contains("voice-first-chat"))) {
      voiceRoot.dataset.voicePhase = "background";
    }
    voiceTargetRef.current = null;
    realtimeActiveRef.current = false;
    const windowId = voiceTarget.mode === "composer" ? voiceTarget.windowId : "primary";
    const recorder = realtimeRecorderRef.current;
    realtimeRecorderRef.current = null;
    dispatch({ type: "CLEAR_VOICE_RECORDING", windowId });

    // 一个字都没听见、录音器也没建起来：不进入「处理中」，声波直接灭掉。
    if (!recorder && !voiceTextRef.current.trim()) {
      dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId });
      stopWindowVoiceMode();
      resetVoiceTextState();
      return;
    }
    dispatch({ type: "SET_VOICE_TRANSCRIBING", windowId });

    void (async () => {
      let finalText = "";
      try {
        finalText = recorder ? await recorder.stop() : "";
      } catch {
        finalText = "";
      }
      if (voiceSessionRef.current !== session) {
        // 已被新一次按住取代：那一轮会自己收尾，别动它的语音模式标记。
        return;
      }
      try {
        const spoken = (finalText || voiceTextRef.current).trim();
        const composed = voiceDraftRef.current
          ? (spoken ? `${voiceDraftRef.current} ${spoken}` : voiceDraftRef.current)
          : spoken;
        dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId });
        dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId: "primary" });

        if (!spoken) {
          stopWindowVoiceMode();
          voiceRoot?.removeAttribute("data-voice-phase");
          return;
        }

        if (voiceTarget.mode === "composer") {
          // 最终转写可能与最后一帧流式文字不同：先写回完整文本，再发送。
          // 极简窗在发送完成前保持输入框可见，避免被上一轮的隐藏标记抢先收起。
          const root = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
          if (root?.classList.contains("voice-first-chat")) root.dataset.voiceSending = "true";
          seedComposerText(() => composed, windowId, () => voiceSessionRef.current === session);
          stopWindowVoiceMode();
          sendComposerText(windowId, composed, () => voiceSessionRef.current === session, false, releasedAt);
          return;
        }
        if (!composed) {
          // 一句都没识别出来：退出语音模式，恢复完整控件；
          // 如果刚才为了显示文字把输入框浮出来了，收掉，别留一个空框。
          stopWindowVoiceMode();
          if (voiceInputShownRef.current) {
            voiceInputShownRef.current = false;
            dispatch({ type: "SET_QUICK_INPUT", open: false });
          }
          return;
        }
        // 没有聚焦窗口：把预览态窗口提升为完整窗口（同一实例，输入框里已经有这段话，
        // 不重新挂载、不跳到未读会话），文字保留在输入框，但不自动发送。
        dispatch({ type: "PROMOTE_PRIMARY" });
        dispatch({ type: "SET_VOICE_FIRST_MINIMAL", windowId, value: true });
        pinWindowVoiceMode(windowId);
        stopWindowVoiceMode();
        seedComposerText(() => composed, windowId, () => voiceSessionRef.current === session);
        sendComposerText(windowId, composed, () => voiceSessionRef.current === session, true, releasedAt);
      } finally {
        // 整轮消费完（或异常）：清空识别文本 / 草稿 / 浮出标记，保证下次按下不残留上次记录。
        resetVoiceTextState();
      }
    })();
  }, [dispatch]);

  /**
   * 语音键接管：语音优先时**不管有没有窗口**都由 Launcher 全局处理（kit 那边收到
   * voiceRealtimeTranscription=true 时同样让位），这样才能做到「桌面上没窗口也能说话」。
   * 关闭语音优先时保留旧链路：纯待机态由 Launcher 接管声波，有窗口就交给 kit。
   */
  useEffect(() => {
    let pressedAt = 0;
    let cancelled = false;
    const cancelVoice = () => {
      cancelled = true;
      voiceSessionRef.current += 1;
      const target = voiceTargetRef.current;
      const cancelledSession = voiceSessionRef.current;
      if (target && voiceTextRef.current) {
        const windowId = target.mode === "composer" ? target.windowId : "primary";
        const draft = voiceDraftRef.current;
        seedComposerText(() => draft, windowId, () => voiceSessionRef.current === cancelledSession);
      }
      voiceTargetRef.current = null;
      realtimeActiveRef.current = false;
      const recorder = realtimeRecorderRef.current;
      realtimeRecorderRef.current = null;
      if (recorder) void recorder.cancel().catch(() => undefined);
      if (target) dispatch({ type: "CLEAR_VOICE_RECORDING", windowId: target.mode === "composer" ? target.windowId : "primary" });
      dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId: target?.mode === "composer" ? target.windowId : "primary" });
      stopWindowVoiceMode();
      if (target?.mode === "new-chat" && voiceInputShownRef.current) {
        voiceInputShownRef.current = false;
        dispatch({ type: "SET_QUICK_INPUT", open: false });
      }
      resetVoiceTextState();
      if (idleVoiceActiveRef.current) {
        idleVoiceActiveRef.current = false;
        stopIdleVoiceCapture({ transcribe: false });
        dispatch({ type: "CLEAR_VOICE_RECORDING", windowId: "primary" });
      }
      window.clearTimeout(idleTranscribeTimerRef.current);
      idleTranscribeRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (!isVoiceHoldKey(event)) {
        if (pressedAt) cancelVoice();
        return;
      }
      if (!(stateRef.current.launcher?.rightCtrlVoice ?? true) && !stateRef.current.launcher?.voiceFirst) return;
      pressedAt = performance.now();
      cancelled = false;
      // 系统自动重复（一直按着不放）：开头的 active 守卫只能挡住「正在录」的情况。
      // 失败路径会把 active 复位，此时每一次自动重复都会重新发起一次会话请求 —— 会刷屏。
      if (idleVoiceActiveRef.current || realtimeActiveRef.current) return;

      // ── 语音优先：按住即说（按下立即开始识别，不延迟、不判断时长）──
      if (stateRef.current.launcher?.voiceFirst) {
        event.preventDefault();
        beginVoiceFirst();
        return;
      }

      // ── 旧链路：待机态录完整段，松手后转写并打开聊天窗 ──
      const s = stateRef.current;
      if (s.openWindows.length > 0 || s.quickInput) return;
      if (!document.hasFocus()) return;
      idleVoiceActiveRef.current = true;
      idleComposerOpenedRef.current = false;
      dispatch({ type: "SET_VOICE_RECORDING", windowId: "primary" });
      const host = s.agentHost;
      idleTranscribeRef.current = Boolean(host);
      dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId: "primary" });
      const idleOpts = host
        ? {
            onTranscribed: (text: string) => {
              // 转写完成才显示输入框：打开并填入转写文字，光标落到文末（seedComposerText 负责）。
              if (!idleComposerOpenedRef.current) {
                idleComposerOpenedRef.current = true;
                dispatch({ type: "SET_QUICK_INPUT", open: true });
                dispatch({ type: "OPEN_FOCUS_CHAT" });
              }
              seedComposerText(() => text, "primary", () => true);
            },
            onTranscribeEnd: () => {
              dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId: "primary" });
              idleTranscribeRef.current = false;
              // 转写失败：输入框也要打开（空），可直接手动输入，避免屏幕没有任何反馈。
              if (!idleComposerOpenedRef.current) {
                idleComposerOpenedRef.current = true;
                dispatch({ type: "SET_QUICK_INPUT", open: true });
                dispatch({ type: "OPEN_FOCUS_CHAT" });
              }
            },
            tokenUrl: localAgentUrl(host.url, "/api/voice/token"),
            transcribeUrl: localAgentUrl(host.url, "/api/voice/transcribe"),
          }
        : undefined;
      void startIdleVoiceCapture(voiceAmplitudeRefFor("primary"), idleOpts);
      event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isVoiceHoldKey(event)) return;
      const tooShort = pressedAt > 0 && performance.now() - pressedAt < 1000;
      pressedAt = 0;
      if (cancelled || tooShort) {
        cancelVoice();
        return;
      }
      // 语音优先：松开即收尾（不自动发送，文字留在输入框）。
      if (voiceTargetRef.current) {
        finishVoiceFirst();
        return;
      }
      // 旧链路：松开即结束录音并开始转写。输入框不可见（待机态）时松手**不**立即弹出输入框，
      // Home 按钮播放转写动画，等转写完成（onTranscribed / onTranscribeEnd）后再显示输入框。
      if (!idleVoiceActiveRef.current) return;
      idleVoiceActiveRef.current = false;
      stopIdleVoiceCapture();
      dispatch({ type: "CLEAR_VOICE_RECORDING", windowId: "primary" });
      if (idleTranscribeRef.current) {
        dispatch({ type: "SET_VOICE_TRANSCRIBING", windowId: "primary" });
        window.clearTimeout(idleTranscribeTimerRef.current);
        idleTranscribeTimerRef.current = window.setTimeout(() => {
          dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId: "primary" });
          idleTranscribeRef.current = false;
          // 超时兜底也补开输入框（空）：转写迟迟不返回时不能让屏幕完全没反馈，可直接手动输入。
          if (!idleComposerOpenedRef.current) {
            idleComposerOpenedRef.current = true;
            dispatch({ type: "SET_QUICK_INPUT", open: true });
            dispatch({ type: "OPEN_FOCUS_CHAT" });
          }
        }, 20_000);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.clearTimeout(idleTranscribeTimerRef.current);
      if (idleVoiceActiveRef.current) {
        idleVoiceActiveRef.current = false;
        stopIdleVoiceCapture({ transcribe: false });
        dispatch({ type: "CLEAR_VOICE_RECORDING", windowId: "primary" });
      }
      if (realtimeRecorderRef.current) {
        void realtimeRecorderRef.current.cancel().catch(() => {});
        realtimeRecorderRef.current = null;
        realtimeActiveRef.current = false;
      }
      // 组件卸载 / effect 重跑：别把窗口留在半透明的语音模式里。
      stopWindowVoiceMode();
      dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId: "primary" });
    };
  }, [beginVoiceFirst, finishVoiceFirst, dispatch]);

  /**
   * 语音错误条的自动消失：8 秒后收，或者点一下立刻收。
   * 定时器按 `at` 重挂 —— 连续两次失败（比如连按两下 Option）会刷新计时，不会被上一条的
   * 旧定时器提前清掉，也不会让第二条的倒计时从第一条的时间点算起。
   */
  useEffect(() => {
    const voiceError = state.voiceError;
    if (!voiceError) return;
    const timer = window.setTimeout(() => dispatch({ type: "CLEAR_VOICE_ERROR" }), 8_000);
    return () => window.clearTimeout(timer);
  }, [state.voiceError, dispatch]);

  /**
   * 语音优先：聊天窗到点自己消失（"他过了一会儿回来，又只看到了桌面"）。
   *
   * 计时口径：
   *  · 窗口出现在 openWindows 的那一刻起算；
   *  · 桌面内的指针、滚动、输入与按键活动都会把它重置；按住或拖动时不会关闭；
   *  · 这一轮还在跑时到点也不关，先续一分钟一轮地等它跑完（关窗口 = 卸载实例 = 这一轮直接断掉）。
   *
   * 为什么是「关闭」而不是「最小化」：最小化会留下实例与旧会话，下次按住语音键就不是新对话了；
   * 语音优先要的是「回来就是干干净净的桌面」，所以到点按真正的关闭处理。
   *
   * 只作用于 Home 的聊天窗（primary / primary-<n>）：数域窗口是"另一个应用"，不该被语音优先的
   * 节奏带走。
   */
  const voiceFirstHideMinutes = launcher.voiceFirstWindowMinutes ?? 5;
  const autoHideEnabled = Boolean(launcher.voiceFirst) && voiceFirstHideMinutes > 0;
  const hideTimersRef = useRef(new Map<string, number>());
  const activePointersRef = useRef(new Set<number>());
  /** 定时器回调里要读最新配置与运行态（回调是几十秒后才跑的，闭包里的值早就过期）。 */
  const autoHideRef = useRef({ enabled: autoHideEnabled, minutes: voiceFirstHideMinutes });
  autoHideRef.current = { enabled: autoHideEnabled, minutes: voiceFirstHideMinutes };

  const armWindowAutoHide = useCallback((windowId: string) => {
    const timers = hideTimersRef.current;
    const existing = timers.get(windowId);
    if (existing !== undefined) window.clearTimeout(existing);
    const tick = () => {
      timers.delete(windowId);
      const { enabled, minutes } = autoHideRef.current;
      if (!enabled) return;
      // A long press or drag is still active use, even when no new events arrive.
      if (activePointersRef.current.size > 0) {
        timers.set(windowId, window.setTimeout(tick, 1_000));
        return;
      }
      // 还在跑：续一轮，等这一轮真的结束再开始倒计时。
      if ((stateRef.current.runningSessionsByWindow[windowId]?.length ?? 0) > 0) {
        timers.set(windowId, window.setTimeout(tick, Math.max(1, minutes) * 60_000));
        return;
      }
      dispatch({ type: "CLOSE_CHAT", windowId });
    };
    timers.set(windowId, window.setTimeout(tick, Math.max(1, autoHideRef.current.minutes) * 60_000));
  }, [dispatch]);

  // 开关 / 时长变化：全部作废重来（旧时长的定时器不能继续倒计时）。
  useEffect(() => {
    const timers = hideTimersRef.current;
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
  }, [autoHideEnabled, voiceFirstHideMinutes]);

  /**
   * 极简聊天窗（state.voiceFirstMinimal）与 DOM 上的 data-voice-mode 标记保持同步。
   *
   * 标记打在窗口根上，kit 的 CSS 据此把输入区收成「只有文字+背景」（见 dock/voiceMode.ts）。
   * 用「钉住名单」而不是一次性设置：录音结束、失败回收等路径都会调 stopWindowVoiceMode()，
   * 不钉住的话极简窗会被这些收尾动作意外恢复成完整输入框。
   * 窗口关闭时 state 里就没有它了 → 标记自动摘掉 → 窗口下次打开是普通完整窗口。
   */
  useEffect(() => {
    setPinnedVoiceMode(state.voiceFirstMinimal);
  }, [state.voiceFirstMinimal]);

  // 极简窗只有最新一轮 AI 答复真正完成后，点窗外才按真关闭处理。
  useEffect(() => {
    if (!state.voiceFirstMinimal.length) return;
    const onOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(".dock-home-item")) return;
      for (const windowId of stateRef.current.voiceFirstMinimal) {
        if (!stateRef.current.openWindows.includes(windowId)) continue;
        const root = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
        if (!root || root.contains(target) || root.dataset.voicePhase || root.dataset.voiceRecording || root.dataset.voiceSending) continue;
        if ((stateRef.current.runningSessionsByWindow[windowId]?.length ?? 0) > 0) continue;
        const messages = root.querySelectorAll<HTMLElement>(".chat-body-inner > .chat-message-row, .chat-body-inner > .msg.bot");
        const last = messages[messages.length - 1];
        if (!last?.matches(".msg.bot") || !last.querySelector(".msg-footer")) continue;
        clearSavedWindowGeometry(windowId);
        dispatch({ type: "CLOSE_CHAT", windowId });
      }
    };
    document.addEventListener("pointerdown", onOutside, true);
    return () => document.removeEventListener("pointerdown", onOutside, true);
  }, [state.voiceFirstMinimal, dispatch]);

  // 窗口进出：新开的起表，关掉的销表。已在表里的**不重置**（否则任何窗口开关都会刷新别人的倒计时）。
  useEffect(() => {
    if (!autoHideEnabled) return;
    const timers = hideTimersRef.current;
    const openHome = state.openWindows.filter(isHomeChatWindow);
    for (const id of openHome) if (!timers.has(id)) armWindowAutoHide(id);
    for (const id of [...timers.keys()]) {
      if (openHome.includes(id)) continue;
      const timer = timers.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      timers.delete(id);
    }
  }, [autoHideEnabled, state.openWindows, armWindowAutoHide]);

  /**
   * 运行态一变就重新计时：答案刚出来的那一刻不该继续接着上一轮开始前的倒计时。
   * 用「窗口:会话数」拼成签名，只有真正变化时才重置。
   */
  const runningSignature = Object.entries(state.runningSessionsByWindow)
    .map(([id, sessions]) => `${id}:${sessions.length}`)
    .sort()
    .join("|");
  useEffect(() => {
    if (!autoHideEnabled) return;
    for (const id of stateRef.current.openWindows.filter(isHomeChatWindow)) armWindowAutoHide(id);
  }, [runningSignature, autoHideEnabled, armWindowAutoHide]);

  // Like a screen lock, count inactivity across the desktop, not only the focused chat.
  useEffect(() => {
    if (!autoHideEnabled) return;
    const onActivity = () => {
      const s = stateRef.current;
      for (const id of s.openWindows.filter(isHomeChatWindow)) armWindowAutoHide(id);
    };
    let lastMove = 0;
    const onMove = () => {
      const now = Date.now();
      if (now - lastMove < 1_000) return;
      lastMove = now;
      onActivity();
    };
    const onPointerDown = (event: PointerEvent) => {
      activePointersRef.current.add(event.pointerId);
      onActivity();
    };
    const onPointerEnd = (event: PointerEvent) => {
      activePointersRef.current.delete(event.pointerId);
      onActivity();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerEnd, true);
    document.addEventListener("pointercancel", onPointerEnd, true);
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("wheel", onActivity, { capture: true, passive: true });
    document.addEventListener("scroll", onActivity, true);
    document.addEventListener("input", onActivity, true);
    document.addEventListener("keydown", onActivity, true);
    return () => {
      activePointersRef.current.clear();
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerEnd, true);
      document.removeEventListener("pointercancel", onPointerEnd, true);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("wheel", onActivity, true);
      document.removeEventListener("scroll", onActivity, true);
      document.removeEventListener("input", onActivity, true);
      document.removeEventListener("keydown", onActivity, true);
    };
  }, [autoHideEnabled, armWindowAutoHide]);

  // 卸载（整棵 Dock 被拆掉）时收干净，别留一堆还会派发的定时器。
  useEffect(() => () => {
    const timers = hideTimersRef.current;
    for (const timer of timers.values()) window.clearTimeout(timer);
    timers.clear();
  }, []);

  // Home 右键设置由 Launcher 自己管理，外观和壁纸使用同一份状态。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsAnchor, setSettingsAnchor] = useState<{ left: number; top: number } | null>(null);
  const [domainMenu, setDomainMenu] = useState<{ id: string; left: number; top: number } | null>(null);

  /**
   * Dock 默认 `overflow: visible`（见 styles.css）—— 999px 圆角的胶囊一旦裁内容，
   * 联系人图标右上角的邀请数角标会被圆角弧线切掉一块。只有图标多到真的超过 max-width 时，
   * 才退回横向滚动（此时宁可按老样子裁角标也要能滚）。这里只负责量「放没放得下」。
   */
  const dockRef = useRef<HTMLDivElement | null>(null);
  const [dockOverflowing, setDockOverflowing] = useState(false);
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const update = () => setDockOverflowing(el.scrollWidth > el.clientWidth + 1);
    update();
    // 图标增删（pin/unpin、临时数域进出）走 childList；窗口缩放 / max-width 生效走 ResizeObserver。
    const observer = new ResizeObserver(update);
    observer.observe(el);
    const mutations = new MutationObserver(update);
    mutations.observe(el, { childList: true });
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); mutations.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  useEffect(() => window.launcher.onWechatPocClosed(() => dispatch({ type: "CLOSE_CHAT", windowId: "wechat" })), [dispatch]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest('.dock-domain-item[data-domain="wechat"]')) return;
      window.launcher.noteLauncherInteraction();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  // 数域右键菜单：点击菜单之外任意处或按 Esc 关闭
  useClickOutside({
    enabled: domainMenu !== null,
    exceptSelectors: [".dock-domain-popup"],
    onDismiss: () => setDomainMenu(null),
  });
  // 菜单开着时：点菜单外 / Dock 外任意处或按 Esc 关闭
  useClickOutside({
    enabled: settingsOpen,
    exceptSelectors: [".dock-settings-popup", ".dock-item"],
    onDismiss: () => setSettingsOpen(false),
  });

  // hover 预览态（Home 上空浮出输入框、还没展开成窗口）按 Esc 收起。
  // 只在**没有输入内容**时生效：有草稿时 Esc 可能是在取消输入法候选，
  // 而且真把带内容的输入框关掉会让用户以为草稿丢了。
  useEffect(() => {
    if (!state.quickInput || primaryOpen || !onDesktop) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (hasText.current || hasContent.current) return;
      dispatch({ type: "SET_QUICK_INPUT", open: false });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.quickInput, primaryOpen, onDesktop, dispatch]);

  function onPrimaryContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (state.quickInput && !(hasText.current || hasContent.current) && !primaryOpen) {
      dispatch({ type: "SET_QUICK_INPUT", open: false });
    }
    if (settingsOpen) { setSettingsOpen(false); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    setSettingsAnchor({ left: rect.left + rect.width / 2, top: rect.top });
    setSettingsOpen(true);
  }

  /**
   * 升级角标点击：只打开外观菜单，不直接安装。
   * 装包并重启是不可逆的打断，必须让用户在菜单里看到「重启升级」再确认一次。
   */
  function openMenuFromUpdateBadge(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    hideDockTipNow();
    if (settingsOpen) { setSettingsOpen(false); return; }
    if (state.quickInput && !(hasText.current || hasContent.current) && !primaryOpen) {
      dispatch({ type: "SET_QUICK_INPUT", open: false });
    }
    const item = event.currentTarget.closest(".dock-item");
    const anchorEl = item instanceof HTMLElement ? item : event.currentTarget;
    const rect = anchorEl.getBoundingClientRect();
    setSettingsAnchor({ left: rect.left + rect.width / 2, top: rect.top });
    setSettingsOpen(true);
  }

  /** 气泡宽度粗估（中文约 13px/字、西文约 7px/字 + 左右内距）：只用来把它夹在视口里，别让它顶出屏幕。 */
  function estimateTipHalfWidth(label: string) {
    const cjk = (label.match(/[\u3000-\u9fff\uff00-\uffef]/g) ?? []).length;
    return Math.min(cjk * 13 + (label.length - cjk) * 7 + 26, 260) / 2;
  }

  /** 在某个 Dock 图标正上方弹出它的名字（macOS Dock 的手感）。 */
  function showDockTip(label: string, element: HTMLElement) {
    // 正在拖 Dock 内部排序：图标一直在让位，气泡跟着乱跳没意义。
    if (dockDragRef.current) return;
    if (tipHideTimer.current !== null) { window.clearTimeout(tipHideTimer.current); tipHideTimer.current = null; }
    if (tipTimer.current !== null) { window.clearTimeout(tipTimer.current); tipTimer.current = null; }
    const place = () => {
      const rect = element.getBoundingClientRect();
      const half = estimateTipHalfWidth(label);
      const x = Math.min(Math.max(rect.left + rect.width / 2, half + 8), window.innerWidth - half - 8);
      tipShown.current = true;
      setDockTip({ label, x, y: rect.top - 8 });
    };
    // 已经显示着（从相邻图标扫过来）就立即跟随、不再等；否则等一小会儿再弹，
    // 免得鼠标横扫整条 Dock 时一路闪出十几个气泡。
    if (tipShown.current) place();
    else tipTimer.current = window.setTimeout(() => { tipTimer.current = null; place(); }, 140);
  }

  /** 立刻收起（点击 / 右键 / 开始拖动时用：这些操作要求气泡马上消失）。 */
  function hideDockTipNow() {
    if (tipTimer.current !== null) { window.clearTimeout(tipTimer.current); tipTimer.current = null; }
    if (tipHideTimer.current !== null) { window.clearTimeout(tipHideTimer.current); tipHideTimer.current = null; }
    tipShown.current = false;
    setDockTip(null);
  }

  /**
   * 指针离开图标：
   * - 真正移出整条 Dock（relatedTarget 不在 dock 内）→ 立即收，不给 90ms 余辉，满足「划走立即消失」。
   * - 在 Dock 内部从一个图标划到另一个（含划到 Home）→ 压 90ms 再收，避免每个图标闪一下；
   *   相邻数域图标会在 enter 时立即 place() 接力，Home 不弹气泡所以会自然收掉（见 Home 的 onMouseEnter）。
   */
  function hideDockTip(event?: React.MouseEvent | React.MouseEvent<HTMLElement>) {
    // 指针一旦离开这个图标，pending 的「延时弹出」定时器必须立刻取消：
    // 否则在 140ms 延时区间内移出、又恰好没有后续 onMouseEnter 接力时，
    // 定时器到点仍会把气泡弹出来（此时鼠标早已不在任何图标上，也没有新的 mouseleave 来收）。
    if (tipTimer.current !== null) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
    // 真正离开 Dock（移到桌面 / 窗口）：立刻收，不要 90ms 余辉。
    if (event) {
      const related = event.relatedTarget;
      if (!(related instanceof Element) || !dockRef.current?.contains(related)) {
        hideDockTipNow();
        return;
      }
    }
    if (tipHideTimer.current !== null || !tipShown.current) return;
    tipHideTimer.current = window.setTimeout(() => {
      tipHideTimer.current = null;
      tipShown.current = false;
      setDockTip(null);
    }, 90);
  }

  // 卸载时收掉待弹/待收的定时器（窗口切换/热更新都可能把 Dock 拆掉）。
  useEffect(() => () => {
    if (tipTimer.current !== null) window.clearTimeout(tipTimer.current);
    if (tipHideTimer.current !== null) window.clearTimeout(tipHideTimer.current);
  }, []);

  function onEnter() {
    // 悬停只负责浮出输入框；Home 光环是否旋转与输入框无关（只看 runningTotal）。
    if (!onDesktop || primaryOpen || settingsOpen) return;
    /**
     * 有收起的 chat 窗口时**不再浮出空输入框**：这时点 Home 的语义是「把我收起来的窗口拿回来」
     * （1 扇直接还原、多扇弹缩略图），如果 hover 先浮出一个空 composer，点和看就对不上了。
     * 拖文件到 Home 仍会浮出输入框 —— 那条路是 onHomeDragOver 显式派的 SET_QUICK_INPUT，不经过这里。
     */
    if (homeWindows.minimized.length > 0 || homeWindows.all.length >= 2 || homeSwitcherOpen) return;
    if (hoverExitTimer.current !== null) { window.clearTimeout(hoverExitTimer.current); hoverExitTimer.current = null; }
    if (!state.quickInput) { hasText.current = false; hasContent.current = false; }
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null;
      dispatch({ type: "SET_QUICK_INPUT", open: true });
    }, HOVER_DELAY_MS);
  }

  function onLeave(event: MouseEvent<HTMLElement>) {
    const next = event.relatedTarget;
    // 移进输入框 / 输入框桥接区 / Dock 自身：输入框保持显示（光环是否旋转只由 runningTotal 决定）；
    // 只有真正离开这块区域（回到桌面）才收输入框。
    if (next instanceof Element && next.closest(".dock-home-item, .quick-input-bridge, .quick-input")) return;
    if (state.quickInput && onHomeHoverRoute(event.clientX, event.clientY)) return;
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (state.quickInput && !primaryOpen) {
      // Mouseleave can fire over a transparent pixel between the icon and composer.
      // The pointermove watcher below decides whether the pointer has actually left that path.
      if (hoverExitTimer.current !== null) window.clearTimeout(hoverExitTimer.current);
      hoverExitTimer.current = window.setTimeout(() => {
        hoverExitTimer.current = null;
        if (!(hasText.current || hasContent.current)) dispatch({ type: "SET_QUICK_INPUT", open: false });
      }, 500);
    }
  }

  useEffect(() => {
    if (!state.quickInput || primaryOpen || !onDesktop) return;
    const clearExit = () => {
      if (hoverExitTimer.current !== null) { window.clearTimeout(hoverExitTimer.current); hoverExitTimer.current = null; }
    };
    const onMove = (event: PointerEvent) => {
      const target = event.target;
      if (onHomeHoverRoute(event.clientX, event.clientY) || target instanceof Element && target.closest(".quick-input[data-window-id='primary']")) clearExit();
      else if (hoverExitTimer.current === null && !(hasText.current || hasContent.current) && !fileDragActive.current) {
        hoverExitTimer.current = window.setTimeout(() => {
          hoverExitTimer.current = null;
          dispatch({ type: "SET_QUICK_INPUT", open: false });
        }, 150);
      }
    };
    document.addEventListener("pointermove", onMove);
    return () => { document.removeEventListener("pointermove", onMove); clearExit(); };
  }, [state.quickInput, primaryOpen, onDesktop, dispatch]);

  function onClick() {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    // 语音优先任务正在被大模型处理：Home 显示停止图标，点击 Home 只停止该任务
    // （极简窗里在跑的会话），后台其他窗口的任务不停止、不收起/还原窗口。
    if (voiceFirstRunning) {
      for (const id of state.voiceFirstMinimal) {
        if ((state.runningSessionsByWindow[id]?.length ?? 0) === 0) continue;
        const root = document.querySelector<HTMLElement>(`[data-window-id="${id}"]`);
        root?.querySelector<HTMLButtonElement>(".chat-send--stop")?.click();
      }
      return;
    }
    // 设置面板开着时，左键点击 Home 只关闭面板，不再打开/收起聚焦窗口
    if (settingsOpen) { setSettingsOpen(false); return; }
    if (!onDesktop) { dispatch({ type: "SET_VIEW", view: "desktop" }); return; }
    const minimalWindow = state.voiceFirstMinimal.find((id) => homeWindows.all.includes(id));
    if (minimalWindow) {
      const remaining = state.voiceFirstMinimal.filter((id) => id !== minimalWindow);
      setPinnedVoiceMode(remaining);
      const root = document.querySelector<HTMLElement>(`[data-window-id="${minimalWindow}"]`);
      root?.removeAttribute("data-voice-message-sent");
      root?.removeAttribute("data-voice-phase");
      root?.removeAttribute("data-voice-sending");
      dispatch({ type: "SET_VOICE_FIRST_MINIMAL", windowId: minimalWindow, value: false });
      if (homeWindows.minimized.includes(minimalWindow)) dispatch({ type: "RESTORE_CHAT", windowId: minimalWindow });
      return;
    }
    // 预览层开着时再点一次 Home = 收起它。
    if (homeSwitcherOpen) { setHomeSwitcherOpen(false); return; }
    /**
     * Home = 「chat 这个应用」的图标，左键语义按「有几扇窗口、在哪」决定：
     *  1. home 窗口 ≥2 扇（无论是否最小化）→ 弹出多窗口预览（Windows 任务栏那种缩略图条），挑一个还原；
     *  2. 收起中正好 1 扇 → 直接还原它（不用再多点一次）；
     *  3. 还有可见的窗口 → 把最上层那扇带回前台（已在前台则保持，不再最小化）；
     *  4. 一扇都没有 → 开主窗口。
     * 注意 3 用的是「最上层那扇」而不是写死 primary：多窗口时用户眼里 Home 管的是整族窗口。
     */
    if (homeWindows.all.length >= 2) {
      // 悬浮输入框别压在这层浮层上（它是 hover 预览，没内容就该收）。
      if (state.quickInput && !(hasText.current || hasContent.current)) dispatch({ type: "SET_QUICK_INPUT", open: false });
      setHomeSwitcherOpen(true);
      return;
    }
    if (homeWindows.minimized.length === 1) {
      dispatch({ type: "RESTORE_CHAT", windowId: homeWindows.minimized[0] });
      return;
    }
    const front = homeWindows.open.at(-1);
    if (front) {
      // 有内容（草稿/附件）的悬停输入框不碰；空的在置顶窗口时收掉，避免压住刚带回前台的窗口。
      if (state.quickInput && !(hasText.current || hasContent.current)) dispatch({ type: "SET_QUICK_INPUT", open: false });
      dispatch({ type: "FOCUS_CHAT_WINDOW", windowId: front });
      return;
    }
    dispatch({ type: "OPEN_FOCUS_CHAT" });
  }

  /**
   * 把文件管理组件里的文件拖到 Dock 的 home 按钮上：
   * 悬浮输入框（hover 预览态）立刻浮出来，松手后文件作为**待发附件**进它的输入框。
   *
   * 与「拖到聊天窗」是同一套内核（kit 的 attachRequest 协议），只是落点是 home 的预览态。
   * 注意：请求先进全局队列再由窗口消费 —— 悬浮输入框是这一刻才挂起来的，
   * 组件刚挂上时 kit 还没准备好接请求。
   */
  const [homeFileDrop, setHomeFileDrop] = useState(false);
  function onHomeDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!isArtifactFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    fileDragActive.current = true;
    setHomeFileDrop(true);
    // 立刻把悬浮输入框浮出来：等 500ms 的 hover 延时太慢，用户还没松手就该看见输入框。
    dispatch({ type: "SET_QUICK_INPUT", open: true });
  }
  function onHomeDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    fileDragActive.current = false;
    setHomeFileDrop(false);
  }
  function onHomeDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!isArtifactFileDrag(event.dataTransfer)) return;
    // drop 事件一返回 dataTransfer 就被清空：载荷当场读。
    const files = readDraggedFiles(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragActive.current = false;
    setHomeFileDrop(false);
    dispatch({ type: "SET_QUICK_INPUT", open: true });
    void (async () => {
      try {
        const attachments = await toLocalAttachments(files);
        if (!attachments.length) return;
        dispatch({ type: "QUEUE_ATTACH_REQUEST", windowId: "primary", attachments });
      } catch (error) {
        console.error("[launcher] 拖拽文件到 Home 失败：", error);
      }
    })();
  }

  function isRemoveTarget(y: number): boolean {
    const dock = document.querySelector(".dock")?.getBoundingClientRect();
    return !!dock && y < dock.top - 36;
  }

  function onDockDomainPointerDown(event: ReactPointerEvent<HTMLButtonElement>, id: string) {
    if (event.button !== 0) return;
    if (id === "wechat") window.launcher.beginWechatDockPress();
    dockDidDragRef.current = false;
    // 记下原位：取消拖动时按它还原（位置是边拖边改的，不能靠"不改"来还原）。
    const origin: DockDropTarget | null = pins.left.includes(id)
      ? { side: "left", index: pins.left.indexOf(id) }
      : pins.right.includes(id)
        ? { side: "right", index: pins.right.indexOf(id) }
        : null;
    // 幽灵图标按「按下点 → 图标中心」的偏移跟随：起手那一刻它正好压住原图标（尺寸、位置都不变）。
    const rect = event.currentTarget.getBoundingClientRect();
    const ox = rect.left + rect.width / 2 - event.clientX;
    const oy = rect.top + rect.height / 2 - event.clientY;
    dockDragRef.current = { id, x: event.clientX, y: event.clientY, active: false, ox, oy, at: null, origin };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /**
   * 拖动中的每帧处理（由 window 的 pointermove 驱动，见上面的 effect）。
   *
   * 两个效果同步推进：
   *  1. **真的换位** —— 指针越过邻图标的中心就把图标挪过去，用户看到的落点就是松手后的位置。
   *     早期版本是在落点画一条插入线、松手才换位，但「幽灵图标」是以指针为中心绘制的，
   *     正好把那条线整个盖住，等于没有反馈。
   *  2. 更新幽灵图标的位置（rAF 节流）。
   */
  function trackDockDrag(x: number, y: number) {
    const drag = dockDragRef.current;
    if (!drag) return;
    if (!drag.active && Math.hypot(x - drag.x, y - drag.y) < 7) return;
    drag.active = true;
    const remove = isRemoveTarget(y);
    // 数域入口是固定的一格：只能拖出去（= 关掉设置里的开关），不参与左右换位。
    const at = remove || drag.id === "domains"
      ? null
      : resolveDockDrop(dockRef.current, pinsRef.current, x, drag.id);
    drag.at = at;
    // 换位只在落点真的变了时才派发：同一格反复派发会让整棵树白渲染，也会不停写回持久化。
    if (at) {
      const list = at.side === "left" ? pinsRef.current.left : pinsRef.current.right;
      if (at.index !== list.indexOf(drag.id)) {
        dispatch({ type: "MOVE_DOCK_DOMAIN", domainId: drag.id, side: at.side, index: at.index, preview: true });
      }
    }
    if (dockDragFrameRef.current !== null) window.cancelAnimationFrame(dockDragFrameRef.current);
    dockDragFrameRef.current = window.requestAnimationFrame(() => {
      dockDragFrameRef.current = null;
      dispatch({ type: "SET_DOMAIN_DRAG", drag: { id: drag.id, x: x + drag.ox, y: y + drag.oy, side: null, source: "dock", remove } });
    });
  }

  function finishDockDrag(y: number, cancelled = false) {
    const drag = dockDragRef.current;
    if (!drag) return;
    if (drag.id === "wechat" && (drag.active || cancelled)) window.launcher.cancelWechatDockPress();
    dockDragRef.current = null;
    if (dockDragFrameRef.current !== null) window.cancelAnimationFrame(dockDragFrameRef.current);
    dockDragFrameRef.current = null;
    if (!drag.active) return;
    if (drag.id === "domains") {
      // 入口：拖到 Dock 上方松手 = 从 Dock 移出（把设置里的开关关掉），拖回去等于没动。
      if (cancelled) { dispatch({ type: "SET_DOMAIN_DRAG", drag: null }); return; }
      dockDidDragRef.current = true;
      if (isRemoveTarget(y)) dispatch({ type: "SET_DOCK_DOMAIN_ENTRY", enabled: false });
      else dispatch({ type: "SET_DOMAIN_DRAG", drag: null });
      window.setTimeout(() => { dockDidDragRef.current = false; }, 0);
      return;
    }
    if (cancelled) {
      // 中途取消（失焦 / pointercancel）：还原到按下去时的位置，别停在拖到一半的地方。
      if (drag.origin) dispatch({ type: "MOVE_DOCK_DOMAIN", domainId: drag.id, side: drag.origin.side, index: drag.origin.index });
      else dispatch({ type: "UNPIN_DOCK_DOMAIN", domainId: drag.id });
      return;
    }
    dockDidDragRef.current = true;
    // 优先级：拖到 Dock 上方 → 移出 Dock；否则按最终落点收尾（防止最后一次 move 没派发到）。
    if (isRemoveTarget(y)) dispatch({ type: "UNPIN_DOCK_DOMAIN", domainId: drag.id });
    else if (drag.at) dispatch({ type: "MOVE_DOCK_DOMAIN", domainId: drag.id, side: drag.at.side, index: drag.at.index });
    else dispatch({ type: "SET_DOMAIN_DRAG", drag: null });
    window.setTimeout(() => { dockDidDragRef.current = false; }, 0);
  }

  function domainItem(id: string) {
    const domain = launcher.domains.find((item) => item.id === id) ?? (id === "settings" ? { id: "settings", name: "设置" } : null);
    if (!domain) return null;
    // 不再用 title：浏览器原生 tooltip 会和下面这个名字气泡叠在一起。
    // hover 只弹气泡，图标本身不变色/不提亮（macOS 的手感）。
    return <button key={id} type="button" data-domain={id} className={`dock-item dock-domain-item${dragging?.source === "dock" && dragging.id === id ? " is-dragging" : ""}${landedPinnedId === id ? " landed-in" : ""}`} aria-label={id === "settings" ? "打开系统设置" : id === "wechat" ? "切换微信数域窗口" : `打开${domain.name}数域`} onMouseEnter={(event) => showDockTip(domain.name, event.currentTarget)} onMouseLeave={hideDockTip} onPointerDown={(event) => { hideDockTipNow(); onDockDomainPointerDown(event, id); }} onPointerUp={(event) => finishDockDrag(event.clientY)} onPointerCancel={() => finishDockDrag(0, true)} onDragStart={(event) => event.preventDefault()} onContextMenu={(event) => {
      event.preventDefault();
      hideDockTipNow();
      setSettingsOpen(false);
      const rect = event.currentTarget.getBoundingClientRect();
      setDomainMenu({ id, left: Math.min(window.innerWidth - 80, Math.max(80, rect.left + rect.width / 2)), top: rect.top - 12 });
    }} onClick={(event) => {
      if (dockDidDragRef.current) return;
      hideDockTipNow();
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      if (id === "settings") {
        if (!onDesktop) dispatch({ type: "SET_VIEW", view: "desktop" });
        dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: id });
      } else if (id === "wechat") {
        if (!onDesktop) dispatch({ type: "SET_VIEW", view: "desktop" });
        if (event.detail === 0) window.launcher.noteLauncherInteraction();
        void window.launcher.toggleWechatPoc(launcher.appearance === "light" ? "light" : "dark", event.detail > 0).then((result) => {
          if (!result.ok) window.alert(result.error ?? "微信数域启动失败");
          else if (result.foreground || !state.openWindows.includes(id)) dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: id });
        });
      } else if (onDesktop) dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: id });
      else dispatch({ type: "SET_VIEW", view: "desktop" });
    }}>
      <span className="icon-wrap" style={{ backgroundColor: "transparent" }}><DomainIcon id={id} size={DOCK_ICON_SIZE} skin={skin} /></span>
      {id === "contacts" && pendingContacts > 0 && <span className="contacts-dock-badge" aria-label={`${pendingContacts} 条好友邀请`}>{pendingContacts > 9 ? "9+" : pendingContacts}</span>}
      {/* 运行指示：只要这个数域有窗口开着或最小化着就有灰点（多个窗口各亮各的） */}
      {(state.openWindows.includes(id) || state.minimizedWindows.includes(id)) && <span className="dock-focus-indicator" aria-hidden="true" />}
    </button>;
  }

  function dropSlot(side: "left" | "right") {
    return <div key={`drop-${side}`} data-domain={draggedDomain?.id} className={`dock-drop-slot${dragging?.side === side ? " is-target" : ""}`} aria-hidden="true">
      {draggedDomain && draggedDomain.id !== "domains" && <span className="icon-wrap"><DomainIcon id={draggedDomain.id} size={DOCK_ICON_SIZE} skin={skin} /></span>}
    </div>;
  }

  return (
    <div className="dock-zone" onMouseDown={(event) => event.stopPropagation()}>
      {/* 主窗口：hover 预览态挂载（仅输入框可见）→ 点击后同一实例展开为完整窗口，输入框位置/大小不变。
          已经打开时永远渲染完整窗口；最小化时保持挂载但隐藏（会话继续后台跑）；
          只有「没有任何窗口」时鼠标悬停 Home 才给预览态。 */}
      {(primaryOpen || primaryMinimized || (state.quickInput && !primaryOpen)) && onDesktop && (
        // hover 激活（quickInput && !focusMode && 未打开）时一律按预览形态渲染：
        // 即使窗口处于最小化（会话后台跑）也临时浮出输入框供继续输入；mouseleave 后回隐藏态。
        //
        // 外层 .window-slot 是给多窗口预览用的**稳定的 React 承载层**：缩略图会把
        // 里面的窗口节点整体搬进卡片（见 homeThumb.ts），而 React 只认识这一层。
        // 没有它，别的窗口插入/重排时 React 会拿「已被搬走的窗口」当插入锚点，直接抛 NotFoundError。
        <div key="primary" className="window-slot">
          <QuickInput windowId="primary" layer={state.quickInput && !primaryOpen ? 101 + openWindows.length : 101 + Math.max(0, openWindows.indexOf("primary"))}
            minimized={primaryMinimized && !(state.quickInput && !primaryOpen)}
            preview={state.quickInput && !primaryOpen}
            keepSidebarOpenWhenUnread={homeUnread > 0}
            focused={multiWindow && focusedWindowId === "primary"}
            onTextPresenceChange={(has) => { hasText.current = has; }}
            onContentPresenceChange={(has) => { hasContent.current = has; }}
            onMouseLeave={onLeave} />
        </div>
      )}
      {/* 「新建窗口」开出的附加 home chat 窗口（primary-<n>）：独立会话、独立 frame，
          与主窗口一样有最小化（后台继续）语义；最小化后通过桌面「进行中」卡片或通知恢复。 */}
      {onDesktop && [
        ...stableWindowOrder(openWindows.filter(isHomeChatWindow).filter((id) => id !== "primary")),
        ...stableWindowOrder(minimizedWindows.filter((id) => isHomeChatWindow(id) && !openWindows.includes(id) && id !== "primary")),
      ].map((id) => (
        <div key={id} className="window-slot">
          <QuickInput windowId={id} layer={101 + Math.max(0, openWindows.indexOf(id))} minimized={minimizedWindows.includes(id)} preview={false} focused={multiWindow && focusedWindowId === id} onTextPresenceChange={() => undefined} onMouseLeave={onLeave} />
        </div>
      ))}
      {/* 数域窗口：每个数域一个独立 frame，像操作系统的应用窗口一样并排存在。
          层叠由 z-index（= openWindows 下标）决定，渲染顺序固定不变（见 stableWindowOrder），
          所以置顶只改 z-index、不会搬动 DOM 节点。
          最小化的窗口排在已打开窗口之后（隐藏占位、保持挂载以让会话继续）。 */}
      <ContactsDomainChannel baseUrl={state.webAuth?.url ?? null} onPending={setPendingContacts} />
      <HomeMessageNotifications baseUrl={state.webAuth?.url ?? null} onMessage={onInboxMessage} />
      {onDesktop && [...stableWindowOrder(openWindows.filter((id) => !isHomeChatWindow(id))), ...stableWindowOrder(minimizedWindows.filter((id) => !isHomeChatWindow(id) && !openWindows.includes(id)))].map((id) => (
        id === "wechat"
          ? null
          : id === "contacts"
          ? <ContactsWindow key={id} layer={101 + Math.max(0, openWindows.indexOf(id))} minimized={minimizedWindows.includes(id)} focused={multiWindow && focusedWindowId === id} />
          : id === "settings"
          ? <SettingsWindow key={id} layer={101 + Math.max(0, openWindows.indexOf(id))} minimized={minimizedWindows.includes(id)} focused={multiWindow && focusedWindowId === id} />
          : id === "knowledge"
          ? <KnowledgeWindow key={id} layer={101 + Math.max(0, openWindows.indexOf(id))} minimized={minimizedWindows.includes(id)} focused={multiWindow && focusedWindowId === id} />
          : <QuickInput key={id} windowId={id} layer={101 + Math.max(0, openWindows.indexOf(id))} minimized={minimizedWindows.includes(id)} preview={false} focused={multiWindow && focusedWindowId === id} onTextPresenceChange={() => undefined} onMouseLeave={onLeave} />
      ))}
      {/* 「选择数域」也是一扇真窗口（同一个 WindowFrame，只留关闭按钮），所以由桌面层统一渲染，
          不挂在某个聊天窗的局部 state 上 —— 开着它的时候切换 / 关闭聊天窗都不受影响。 */}
      {onDesktop && state.domainPickerOpen && <DomainPicker />}
      {/* 「关于」同样是真窗口：只有静态版本信息，由快捷设置面板的「关于」入口打开。 */}
      {onDesktop && state.aboutWindowOpen && <AboutWindow />}
      {state.quickInput && !primaryOpen && (
        <div className="quick-input-bridge" onMouseLeave={onLeave} aria-hidden="true" />
      )}
      <div ref={dockRef} className={`dock${dockOverflowing ? " is-overflowing" : ""}${dragging ? " is-dragging-domain" : ""}${autoHideDock ? " dock-auto-hide" : ""}${autoHideDock ? (dockRevealed ? " is-revealed" : " is-hidden") : ""}`} onMouseLeave={hideDockTipNow}>
        {pins.left.map(domainItem)}
        {dropSlot("left")}
        <div
          className={`dock-item dock-home-item${homeActive ? " home-active" : ""}${homeFileDrop ? " is-file-drop" : ""}`}
          // Home 按钮不弹名字气泡：它本身就是主入口，label「问」既非数域也不是应用名，
          // 显示在 Dock 上反而误导；其他按钮（数域 / 应用）仍走 showDockTip 显示各自的名字。
          onMouseEnter={(event) => { hideDockTipNow(); onEnter(); }}
          onMouseLeave={(event) => { onLeave(event); hideDockTip(event); }}
          onClick={() => { hideDockTipNow(); onClick(); }}
          onContextMenu={(event) => { hideDockTipNow(); onPrimaryContextMenu(event); }}
          onDragOver={onHomeDragOver}
          onDragLeave={onHomeDragLeave}
          onDrop={onHomeDrop}
          aria-label={primary.label}
          style={{ cursor: "pointer" }}
        >
          <div ref={orbitRef} className="icon-wrap dock-primary-icon">
            <AppIcon kind="primary" size={DOCK_ICON_SIZE} skin={skin} running={voiceFirstRunning} />
          </div>
          {updateRelease && <button
            type="button"
            className="dock-update-badge"
            aria-label={updateBadgeLabel}
            title={updateBadgeLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => openMenuFromUpdateBadge(event)}
          ><DownloadIcon /></button>}
          {homeUnread > 0 && <span className="contacts-dock-badge" aria-label={`${homeUnread} 条未读消息`}>{homeUnread > 99 ? "99+" : homeUnread}</span>}
          {/* 语音声波：按住 Windows 右 Alt / macOS Option 录音时叠在 Home 圆钮上。
              音量从 voiceLevel 的 ref 读（不进 state），避免每帧重渲染整棵 launcher。 */}
          <HomeVoiceWave
            active={voiceActive}
            transcribing={voiceTranscribing}
            readAmplitude={() => (voiceWindow ? currentVoiceAmplitude(voiceWindow) : 0)}
            color={waveColor}
            glowColor={glowColor}
          />
          {/* 运行指示（macOS 同款，两种状态互斥）：
              有会话在跑 → 底部数字角标（所有窗口合计，含收起后在后台跑的）；
              否则只要有 home chat 窗口（可见的或收起的）就显示灰色小圆点 ——
              它代表「chat 还有进行中的窗口」，**只有把全部 chat 窗口都关了才消失**；
              收起了几扇不影响：灰点一直在，因为状态还在。 */}
          {runningTotal > 0
            ? <div className="dock-badge-running" aria-label={`${runningTotal} 个运行中的会话`}>
                <span className="dock-running-count">{runningTotal}</span>
              </div>
            : homeWindows.all.length > 0
              ? <span className="dock-focus-indicator" aria-hidden="true" />
              : null}
        </div>
        {/* 数域入口：设定里打开后常驻 Home 右侧，点一下弹出「选择数域」窗口。
            外观按 macOS 启动台：白色圆角卡片 + 搜索条 + 两行三列彩格。 */}
        {dockDomainEntry && (
          <button
            type="button"
            className="dock-item dock-domain-entry"
            aria-label="选择数域"
            onMouseEnter={(event) => showDockTip("数域", event.currentTarget)}
            onMouseLeave={hideDockTip}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              hideDockTipNow();
              dockDidDragRef.current = false;
              const rect = event.currentTarget.getBoundingClientRect();
              const ox = rect.left + rect.width / 2 - event.clientX;
              const oy = rect.top + rect.height / 2 - event.clientY;
              dockDragRef.current = { id: "domains", x: event.clientX, y: event.clientY, active: false, ox, oy, at: null, origin: null };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerUp={(event) => finishDockDrag(event.clientY)}
            onPointerCancel={() => finishDockDrag(0, true)}
            onDragStart={(event) => event.preventDefault()}
            onContextMenu={(event) => {
              // 与其他 Dock 图标一致：右键给出「从 Dock 移出」。
              event.preventDefault();
              hideDockTipNow();
              setSettingsOpen(false);
              const rect = event.currentTarget.getBoundingClientRect();
              setDomainMenu({ id: "domains", left: Math.min(window.innerWidth - 80, Math.max(80, rect.left + rect.width / 2)), top: rect.top - 12 });
            }}
            onClick={() => {
              if (dockDidDragRef.current) return;
              hideDockTipNow();
              if (!onDesktop) dispatch({ type: "SET_VIEW", view: "desktop" });
              // 入口就是「打开」：弹窗开着时点它不会变成关闭（指针落点在弹窗外已先触发一次收起，
              // 这里再写 open: false 会闪一下又重新打开，反而看不懂）。
              dispatch({ type: "SET_DOMAIN_PICKER", open: true });
            }}
          >
            <span className="icon-wrap"><DomainEntryIcon size={DOCK_ICON_SIZE} skin={skin} /></span>
          </button>
        )}
        {dropSlot("right")}
        {pins.right.map(domainItem)}
        {/* 未固定、但窗口开着的数域：临时停在 Dock 最右侧，关掉窗口就消失 */}
        {launchedUnpinned.map(domainItem)}
      </div>
      {/* 多窗口预览：有 ≥2 扇 home chat 窗口（无论是否最小化）时点 Home 弹出（portal 到 body，压在窗口层之上）。 */}
      {homeSwitcherOpen && onDesktop && homeWindows.all.length > 0 && createPortal(
        <HomeChatSwitcher windowIds={homeWindows.all} userName={state.webUser?.name} onDismiss={() => setHomeSwitcherOpen(false)} />,
        document.body)}
      {dragging && draggedDomain && createPortal(
        // 幽灵图标与 Dock 里那一格**同尺寸、同渲染**（都走 .icon-wrap 的 60px 圆形裁切）：
        // 以前这里是 size+4 再 scale(1.06)，一按下去图标就「胀一下」，非常抢眼。
        <div className={`dock-drag-ghost${dragging.side ? " over-dock" : ""}${dragging.remove ? " remove-target" : ""}`} data-domain={draggedDomain.id} style={{ left: dragging.x, top: dragging.y }} aria-hidden="true">
          <span className="icon-wrap">
            {draggedDomain.id === "domains"
              ? <DomainEntryIcon size={DOCK_ICON_SIZE} skin={skin} />
              : <DomainIcon id={draggedDomain.id} size={DOCK_ICON_SIZE} skin={skin} />}
          </span>
        </div>, document.body)}

      {/* hover 名字气泡：hover 的唯一反馈（图标本身不变色）。portal 到 body，
          因为 Dock 横向溢出时是 overflow-x: auto，挂在里面会被裁掉。 */}
      {dockTip && createPortal(
        <div className="dock-tooltip" style={{ left: dockTip.x, top: dockTip.y }} role="tooltip">{dockTip.label}</div>,
        document.body)}

      {/* 语音失败条：浮在 Home 上方 —— 声波该出现的位置，就是错误该出现的位置。 */}
      {state.voiceError && (
        <HomeVoiceError
          message={state.voiceError.message}
          detail={state.voiceError.detail}
          action={state.voiceError.action}
          onDismiss={() => dispatch({ type: "CLEAR_VOICE_ERROR" })}
          onAction={() => {
            if (state.voiceError.action !== "login") return;
            const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
            void window.launcher.openLogin(theme).then((result) => {
              if (!result.ok) {
                // 打开登录窗口失败，直接把错误显示成语音错误条
                dispatch({
                  type: "SET_VOICE_ERROR",
                  message: "无法打开登录窗口",
                  detail: result.error || "请稍后重试",
                });
              }
            });
          }}
        />
      )}

      {settingsOpen && settingsAnchor && createPortal(
        <div className="dock-settings-popup" style={{ left: settingsAnchor.left, top: settingsAnchor.top - 28, transform: "translateX(-50%) translateY(-100%)" }}>
          <AppearanceMenu onAction={() => setSettingsOpen(false)} onCloseHomeWindows={() => {
            if (hoverTimer.current !== null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null; }
            if (hoverExitTimer.current !== null) { window.clearTimeout(hoverExitTimer.current); hoverExitTimer.current = null; }
            dispatch({ type: "SET_QUICK_INPUT", open: false });
          }} />
        </div>, document.body)}
      {domainMenu && createPortal(
        <div className="dock-domain-popup" style={{ left: domainMenu.left, top: domainMenu.top, transform: "translate(-50%, -100%)" }}>
          {(() => {
            if (domainMenu.id === "domains") {
              return <button type="button" onClick={() => {
                dispatch({ type: "SET_DOCK_DOMAIN_ENTRY", enabled: false });
                setDomainMenu(null);
              }}>从 Dock 移出</button>;
            }
            const isOpen = openWindows.includes(domainMenu.id) || minimizedWindows.includes(domainMenu.id);
            return <button type="button" onClick={() => {
              if (isOpen) {
                // 窗口已打开 → 关闭
                if (domainMenu.id === "wechat") void window.launcher.closeWechatPoc();
                else dispatch({ type: "CLOSE_CHAT", windowId: domainMenu.id });
              } else {
                // 窗口未打开 → 从 Dock 移出
                dispatch({ type: "UNPIN_DOCK_DOMAIN", domainId: domainMenu.id });
              }
              setDomainMenu(null);
            }}>{isOpen ? "关闭窗口" : "从 Dock 移出"}</button>;
          })()}
        </div>, document.body)}
    </div>
  );
}
