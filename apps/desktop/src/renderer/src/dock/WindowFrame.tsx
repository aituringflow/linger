import { useTranslation } from "../i18n";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * 通用窗口壳：launcher 里所有「像应用窗口」的东西都用它。
 *
 * 职责只有窗口本身：位置/尺寸、拖顶栏移动、双击缩放、八向边框缩放、左上角红绿灯、
 * 圆角裁剪与入场动画。**业务内容一律走 children**，按钮显示与否走 controls。
 *
 * 现有的两个使用者：
 *  · QuickInput（Home / 数域聊天窗）—— 三颗红绿灯全开，还会上报右栏宽度给 kit；
 *  · DomainPicker（选择数域）—— 只留关闭按钮，不可缩放、不记忆位置。
 *
 * 注意类的历史包袱：外层仍叫 `.quick-input`（窗口几何那套 CSS 都是按这个选择器写的，
 * 包括 `.quick-input.focus-mode` 的 top/left/width/height 与各皮肤的变量），
 * 换名字会让几十条规则一起失配，所以保留；要改就整体改，别单独动这一处。
 */

export interface WindowFrameControls {
  /** 左上角红绿灯：不传默认都显示。 */
  close?: boolean;
  minimize?: boolean;
  maximize?: boolean;
}

export interface WindowFrameProps {
  /** 窗口标识：记忆几何（同一 id 再次打开恢复位置尺寸）与 data-window-id 都用它。 */
  id: string;
  skinId: string;
  style?: CSSProperties;
  /** 追加的类名（如聊天主窗口的 focus-primary）。 */
  className?: string;
  initialOffset?: { x: number; y: number };
  /** 首次尺寸；height 省略 = 高度交给 CSS（聊天窗按视口算）。null = 全部交给 CSS。 */
  initialSize?: { width: number; height?: number } | null;
  minWidth?: number;
  minHeight?: number;
  /** 是否记住/恢复同 id 的位置和尺寸。一次性窗口（对话框）传 false。 */
  rememberGeometry?: boolean;
  controls?: WindowFrameControls;
  /** 是否允许拖边框改尺寸。对话框一般关掉。 */
  resizable?: boolean;
  /** 高度由内容撑开（对话框）：不写 --window-height，CSS 走 height:auto + 视口以内的 max-height。 */
  fitContent?: boolean;
  /** 顶栏左侧（红绿灯右边）的自定义内容，通常是标题。 */
  header?: ReactNode;
  /** 标题对齐：start（默认，紧贴红绿灯右侧）| center（在整条顶栏里水平居中，对话框用）。 */
  headerAlign?: "start" | "center";
  /** 入场动画的起点：返回 Dock 图标矩形；返回 null 表示不做「从图标展开」的动画。 */
  appearFrom?: () => DOMRect | null;
  preview?: boolean;
  minimized?: boolean;
  ariaLabel?: string;
  /** 内容区被 pointerdown 时不触发（聊天窗预览态用：点输入区不算打开窗口）。 */
  previewInteractiveSelector?: string;
  onFocus?: () => void;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximizeChange?: (maximized: boolean) => void;
  /** 是否为当前聚焦（最上层）窗口：多窗口时给它更亮的边框，方便区分。由宿主按 openWindows 末尾判断。 */
  focused?: boolean;
  /** 语音优先极简态：隐藏框架控制按钮（红绿灯）；输入区是否极简由 data-voice-mode 决定。 */
  voiceFirstMinimal?: boolean;
  voiceFirstSurface?: boolean;
  /** 基准几何上报（右栏收起时的外框），宿主用来判断"右侧还剩多少屏幕空间"。 */
  onGeometryChange?: (geometry: { left: number; right: number; baseWidth: number; viewport: number }) => void;
  /** 右栏当前占用的宽度（0 = 收起）。> 0 时拖右侧边框只调整右栏宽度，不动窗口基准宽。 */
  rightPanelWidth?: number;
  /** 窗口相对基准宽多出来的部分（可能小于 rightPanelWidth：右侧空间不足时右栏挤压中栏）。 */
  windowExtra?: number;
  onRightPanelResize?: (width: number, windowInc: number) => void;
  onMouseLeave?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  /**
   * 拖放：文件管理器的载荷经过窗口（宿主在此 preventDefault 以接受 drop）。
   * 挂在整个窗口根节点上：用户把文件拖到聊天窗的任意位置（消息区、输入框）都算落在窗口上。
   */
  onArtifactDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void;
  /** 拖放：文件管理器的载荷落在窗口上。 */
  onArtifactDrop?: (event: ReactDragEvent<HTMLDivElement>) => void;
  /** 拖放：指针离开窗口（宿主据此清掉高亮）。 */
  onArtifactDragLeave?: (event: ReactDragEvent<HTMLDivElement>) => void;
  /** 拖放高亮（宿主在 dragover 时置位）。 */
  artifactDropActive?: boolean;
  /** 需要从外部读窗口节点时传（聊天窗用它算输入卡的入场位移）。 */
  nodeRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

type Gesture =
  | { kind: "move"; x: number; y: number; offsetX: number; offsetY: number }
  /**
   * 从最大化状态拖顶部移动窗口。抓取时把**当时窗口的实际尺寸**（全屏宽 × Dock 以上的高）
   * 和鼠标在窗口内的落点一起带下来：拖出去只是"在原尺寸上平移"，不会缩回记忆尺寸。
   */
  | { kind: "restore"; x: number; y: number; grabX: number; grabY: number; width: number; height: number }
  | { kind: "resize"; x: number; y: number; offsetX: number; offsetY: number; width: number; height: number; edge: string };

const savedWindows = new Map<string, { offset: { x: number; y: number }; size: { width: number; height?: number } | null; maximized: boolean }>();

/** 清除某个窗口保存的几何信息（位置/大小/最大化），下次打开时用初始值。 */
export function clearSavedWindowGeometry(id: string): void {
  savedWindows.delete(id);
}

/** 首次打开的默认宽度（CSS 的 --home-frame-width 与这里保持一致）：固定上限，窄屏时让出左右各 24px。 */
const DEFAULT_WINDOW_WIDTH = 600;
const WINDOW_VIEWPORT_GUTTER = 48;
/** 默认最小尺寸：内容放不下时由使用者通过 minWidth / minHeight 覆盖。 */
const DEFAULT_MIN_WIDTH = 320;
// 顶部硬边界：focus-mode 窗口的 top = 12px + offset.y。offset.y < -12 会让窗口顶越过屏幕顶、
// 标题栏被推到视口外再也抓不回来。拖拽时钳住下界，使窗口顶永远 >= 0（不能穿过顶部）；
// 底部不钳（允许像 macOS 那样把窗口拖过 Dock 区域）。所有经 WindowFrame 渲染的窗口都是 focus-mode，
// 故统一对 offset.y 施加这个下界。
const TOP_MIN_OFFSET_Y = -12;
const DEFAULT_MIN_HEIGHT = 200;
/** 右侧面板的最小宽度（与 kit 分隔线拖拽的下限一致）。 */
const MIN_RIGHT_WIDTH = 240;

export default function WindowFrame({
  id,
  skinId,
  style,
  className = "",
  initialOffset,
  initialSize = null,
  minWidth = DEFAULT_MIN_WIDTH,
  minHeight = DEFAULT_MIN_HEIGHT,
  rememberGeometry = true,
  controls,
  resizable = true,
  fitContent = false,
  header,
  headerAlign = "start",
  appearFrom,
  preview = false,
  minimized = false,
  ariaLabel,
  previewInteractiveSelector = ".chat-input-zone",
  onFocus,
  onClose,
  onMinimize,
  onMaximizeChange,
  focused = false,
  voiceFirstMinimal = false,
  voiceFirstSurface = false,
  onGeometryChange,
  rightPanelWidth = 0,
  windowExtra,
  onRightPanelResize,
  onMouseLeave,
  onArtifactDragOver,
  onArtifactDrop,
  onArtifactDragLeave,
  artifactDropActive = false,
  nodeRef,
  children,
}: WindowFrameProps) {
  const { t } = useTranslation();
  const showClose = controls?.close ?? true;
  const showMinimize = controls?.minimize ?? true;
  const showMaximize = controls?.maximize ?? true;
  const controlCount = Number(showClose) + Number(showMinimize) + Number(showMaximize);
  /** 顶栏标题的左边距：红绿灯占多宽就往右让多少（12 左内距 + 每颗 12 + 间距 8 + 与文字留 4）。 */
  const headerInset = 12 + controlCount * 12 + Math.max(0, controlCount - 1) * 8 + 4;

  // 预览态（hover 挂载）时：忽略记忆几何，用默认位置/尺寸，使输入框精确落在预览位置；
  // 同一实例随后展开为完整窗口，输入框位置/大小全程不变。记忆几何保留给非预览打开。
  const [offset, setOffset] = useState(() => preview ? { x: 0, y: 0 } : (savedWindows.get(id)?.offset ?? initialOffset ?? { x: 0, y: 0 }));
  const [size, setSize] = useState<{ width: number; height?: number } | null>(() => {
    if (preview) return null;
    const saved = rememberGeometry ? savedWindows.get(id)?.size : null;
    if (saved && saved.width < minWidth) return { width: minWidth, height: Math.max(minHeight, saved.height ?? minHeight) };
    if (saved) return saved;
    if (!initialSize) return null;
    // 只给宽度时高度继续交给 CSS（对话框按内容撑开）。
    return initialSize.height == null
      ? { width: Math.max(minWidth, initialSize.width) }
      : { width: Math.max(minWidth, initialSize.width), height: Math.max(minHeight, initialSize.height) };
  });
  const [maximized, setMaximized] = useState(() => preview ? false : (rememberGeometry ? savedWindows.get(id)?.maximized ?? false : false));
  const [interacting, setInteracting] = useState(false);
  /** 正在拖右侧边框改右栏宽度：期间窗口/右栏/中栏全部由 --launcher-right-width 单变量驱动。 */
  const [rightResizing, setRightResizing] = useState(false);
  const [minimizing, setMinimizing] = useState(false);
  // 任何窗口首次以非预览态挂载时，整窗播放 appearing 动画；经 hover 预览展开的窗口不重复播放。
  const [directEntering, setDirectEntering] = useState(() => !preview);
  const [composerEntering, setComposerEntering] = useState(() => preview);
  useEffect(() => {
    if (!composerEntering) return;
    // 入场动画只属于首次 hover。会话切换会重新挂载 composer，不能因此重播。
    const timer = window.setTimeout(() => setComposerEntering(false), 500);
    return () => window.clearTimeout(timer);
  }, [composerEntering]);
  const minimizeTimerRef = useRef<number | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const localFrameRef = useRef<HTMLDivElement | null>(null);
  const frameRef = nodeRef ?? localFrameRef;
  const topbarRef = useRef<HTMLDivElement | null>(null);
  const startedAsPreview = useRef(Boolean(preview));
  // A preview expands in place: the already visible composer must never inherit
  // the whole-frame entrance animation (whose first frame has opacity: 0).
  const gestureRef = useRef<Gesture | null>(null);

  // 点击 Home 时整窗从 Dock 上方向上出现；hover 预览时输入卡仍从图标处浮起。
  const appearFromRef = useRef(appearFrom);
  appearFromRef.current = appearFrom;
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const iconRect = appearFromRef.current?.();
    if (!frame || !iconRect) return;
    const style = getComputedStyle(frame);
    const frameLeft = Number.parseFloat(style.left);
    const frameTop = Number.parseFloat(style.top);
    const width = frame.offsetWidth;
    const height = frame.offsetHeight;
    if (!Number.isFinite(frameLeft) || !Number.isFinite(frameTop) || !width || !height) return;
    const frameCenterX = maximized ? frameLeft + width / 2 : frameLeft;
    frame.style.setProperty("--composer-appear-offset-x", `${iconRect.left + iconRect.width / 2 - frameCenterX}px`);
    frame.style.setProperty("--composer-appear-offset-y", `${iconRect.top + iconRect.height - frameTop - height + 16}px`);
    if (!directEntering) return;
    frame.style.setProperty("--appear-offset-y", `${Math.max(48, iconRect.top + iconRect.height / 2 - frameTop - height)}px`);
  }, [directEntering, maximized, id, frameRef]);

  useEffect(() => {
    if (!preview && rememberGeometry) savedWindows.set(id, { offset, size, maximized });
  }, [id, offset, size, maximized, preview, rememberGeometry]);

  // 语音优先窗口只按真实消息高度向上生长；输入卡始终贴在同一个底部锚点。
  useEffect(() => {
    if (!voiceFirstSurface || maximized) return;
    const frame = frameRef.current;
    if (!frame) return;
    let frameId = 0;
    const resize = new ResizeObserver(() => schedule());
    const measure = () => {
      frameId = 0;
      resize.disconnect();
      const composer = frame.querySelector<HTMLElement>(".chat-composer-stack");
      const body = frame.querySelector<HTMLElement>(".chat-body-inner");
      if (composer) resize.observe(composer);
      if (body) resize.observe(body);
      if (!composer) return;
      const composerHeight = composer.getBoundingClientRect().height;
      let contentHeight = 0;
      if (!preview && body && !body.parentElement?.classList.contains("is-loading")) {
        const children = [...body.children].filter((child) => !child.classList.contains("chat-stream-spacer"));
        const bodyStyle = getComputedStyle(body);
        const gap = Number.parseFloat(bodyStyle.rowGap) || 0;
        contentHeight = children.reduce((total, child) => {
          const childStyle = getComputedStyle(child);
          return total + child.getBoundingClientRect().height
            + (Number.parseFloat(childStyle.marginTop) || 0)
            + (Number.parseFloat(childStyle.marginBottom) || 0);
        }, 0) + Math.max(0, children.length - 1) * gap
          + (Number.parseFloat(bodyStyle.paddingTop) || 0)
          + (Number.parseFloat(bodyStyle.paddingBottom) || 0);
      }
      const bottom = Number.parseFloat(getComputedStyle(frame).bottom) || 102;
      const maxHeight = window.innerHeight - 12 - bottom;
      const desiredHeight = Math.max(composerHeight + 32, composerHeight + contentHeight + 32);
      const capped = desiredHeight > maxHeight;
      frame.toggleAttribute("data-voice-height-capped", capped);
      const height = Math.min(maxHeight, desiredHeight);
      const next = `${Math.ceil(height)}px`;
      if (frame.style.getPropertyValue("--voice-chat-height") !== next) frame.style.setProperty("--voice-chat-height", next);
    };
    const schedule = () => { if (!frameId) frameId = requestAnimationFrame(measure); };
    const mutations = new MutationObserver(schedule);
    mutations.observe(frame, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      mutations.disconnect();
      resize.disconnect();
      window.removeEventListener("resize", schedule);
      frame.style.removeProperty("--voice-chat-height");
      frame.removeAttribute("data-voice-height-capped");
    };
  }, [voiceFirstSurface, maximized, preview, frameRef]);

  // 全屏状态上报：宿主据此切换布局模式（聊天窗是 grow → fixed），否则最大化时面板会被推到屏幕外。
  const maximizeReportRef = useRef(onMaximizeChange);
  maximizeReportRef.current = onMaximizeChange;
  useEffect(() => { maximizeReportRef.current?.(maximized); }, [maximized]);

  /**
   * 最大化时窗口底边必须正好压在 Dock 顶边上。
   * Dock 的真实顶边 = 屏幕高 − (图标 54 + 上下各 7 padding + 1px 边框 + 距底 8)，
   * 一旦和 CSS 里写死的 --dock-reserved-height 差几像素，底部就会留一条缝（浅色主题下
   * 窗口底色和壁纸几乎同色，那条缝特别显眼）。这里直接量 Dock 的顶边写成 --dock-top-inset，
   * 窗口高度用它 —— Dock 以后改高矮也不用回来同步常量。
   * 量不到（Dock 还没布局 / 值异常）时不写，CSS 会回退到原来的 100vh − 预留高度。
   * 用 layout effect：高度带 200ms 过渡，实测值必须在这一次绘制前就落上，
   * 否则过渡会先朝回退值走一帧。
   */
  useLayoutEffect(() => {
    if (!maximized) return;
    const frame = frameRef.current;
    if (!frame) return;
    const { style } = frame;
    function measure() {
      const top = document.querySelector<HTMLElement>(".dock")?.getBoundingClientRect().top;
      if (top == null || !Number.isFinite(top) || top <= 0) return;
      style.setProperty("--dock-top-inset", `${Math.round(top * 100) / 100}px`);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      style.removeProperty("--dock-top-inset");
    };
  }, [maximized, frameRef]);

  // 基准几何上报（右栏收起时的窗口外框）。定位模型是：
  //   left = 50% + offsetX  →  translateX(-50%)  →  左边缘 = vw/2 + offsetX - base/2
  // 展开右栏时窗口向右加宽、左边缘不动，所以"右侧还剩多少屏幕空间"就是 viewport - right。
  // 屏幕尺寸变化（窗口 resize）也要重报，否则上次算出的空间会过期。
  const geometryReportRef = useRef(onGeometryChange);
  geometryReportRef.current = onGeometryChange;
  useEffect(() => {
    function report() {
      if (!geometryReportRef.current) return;
      const vw = window.innerWidth;
      const base = size?.width ?? Math.min(DEFAULT_WINDOW_WIDTH, vw - WINDOW_VIEWPORT_GUTTER);
      const left = vw / 2 + offset.x - base / 2;
      geometryReportRef.current({ left, right: left + base, baseWidth: base, viewport: vw });
    }
    report();
    window.addEventListener("resize", report);
    return () => window.removeEventListener("resize", report);
  }, [offset.x, size?.width, id]);

  // 右栏相关也走 ref：上面的 pointermove 监听是空依赖注册的，闭包里读不到最新 props。
  // width = 右栏真实宽度（拖拽基准）；extra = 窗口相对基准宽多出来的量（算基准宽用，可能小于 width）。
  const rightPanelRef = useRef({ width: rightPanelWidth, extra: windowExtra ?? rightPanelWidth, onResize: onRightPanelResize });
  rightPanelRef.current = { width: rightPanelWidth, extra: windowExtra ?? rightPanelWidth, onResize: onRightPanelResize };
  /** 手势开始那一刻的右栏宽度（resize 用累计 dx 计算目标宽度，不能逐帧累加）。 */
  const resizeStartRightRef = useRef(0);
  /** 手势开始那一刻的窗口增量（可能小于右栏宽度：窗口右侧空间不足时右栏会挤压中栏）。 */
  const resizeStartIncRef = useRef(0);
  /**
   * 拖右侧边框期间"正在生效"的右栏宽度。
   * 拖拽时**不经过 React**：直接往 frame 上写两个 CSS 变量
   * （--launcher-right-width 管窗口增量、--right-resize-width 管右栏宽度），
   * 窗口宽 = base + 增量、中栏宽 = 容器宽 − 左栏 − 右栏，同一次布局算完，零错位；
   * 松手时才把最终值回传宿主落到 state。非 null 即表示手上有未提交的实时值。
   */
  const rightLiveRef = useRef<number | null>(null);
  /** 与 rightLiveRef 配套的窗口增量（松手时一起提交，避免 chat 在收尾瞬间跳一下）。 */
  const rightLiveIncRef = useRef(0);
  /** 手势序号：松手后延后解除拖拽态，用它判断这两帧里是否已经开始了新手势。 */
  const gestureSeqRef = useRef(0);

  useEffect(() => () => {
    if (minimizeTimerRef.current !== null) window.clearTimeout(minimizeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!minimized) return;
    // The frame stays mounted while hidden. Clear the exit animation state so
    // restoring it does not leave the old opacity:0 class on the same node.
    if (minimizeTimerRef.current !== null) window.clearTimeout(minimizeTimerRef.current);
    minimizeTimerRef.current = null;
    setMinimizing(false);
  }, [minimized]);

  useEffect(() => {
    function move(event: globalThis.PointerEvent) {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (gesture.kind === "restore") {
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4) return;
        /**
         * 只平移，不改尺寸：尺寸沿用抓取那一刻窗口的实测值（最大化时就是全屏宽 × Dock 以上的高）。
         * 之前这里回退到"记忆尺寸 / 默认 600px"，于是从最大化往下拖，窗口会突然缩成 600 宽 ——
         * 看起来像"拖动把 frame 拖窄了"。和 macOS 的 zoom 一致：拖动缩放过的窗口，尺寸不变。
         * 窗口宽度 = 基准宽 + 右栏锁存宽（--launcher-right-width），所以基准宽要减掉右栏那部分，
         * 否则右栏开着时拖出来会比屏幕还宽。
         */
        const rightExtra = rightPanelRef.current.extra;
        const width = Math.max(minWidth, Math.round(gesture.width - rightExtra));
        const height = gesture.height;
        const nextOffset = {
          x: event.clientX - gesture.grabX - window.innerWidth / 2 + width / 2,
          // 12 = .quick-input.focus-mode 的 top 基准；扣掉鼠标在窗口内的落点，抓手才不会跳
          y: Math.max(TOP_MIN_OFFSET_Y, event.clientY - gesture.grabY - 12),
        };
        setSize({ width, height });
        setInteracting(true);
        setOffset(nextOffset);
        setMaximized(false);
        gestureRef.current = { kind: "move", x: event.clientX, y: event.clientY, offsetX: nextOffset.x, offsetY: nextOffset.y };
      } else if (gesture.kind === "move") {
        const rawY = gesture.offsetY + event.clientY - gesture.y;
        // 顶部硬边界：窗口顶 = 12px + offset.y，钳住下界使顶永远 >= 0（不能穿过顶部）。
        setOffset({ x: gesture.offsetX + event.clientX - gesture.x, y: Math.max(TOP_MIN_OFFSET_Y, rawY) });
      } else {
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        // 右栏展开时拖右侧边框：窗口"基准宽"不动，多出来/少掉的宽度全部给右栏，
        // 这样中栏（chat）宽度纹丝不动 —— 相当于在 resize 右侧面板本身。
        // 这里**直接写 CSS 变量、不进 React**：窗口宽 = base + 变量、右栏宽 = 变量、
        // 中栏宽 = 容器宽 − 左栏 − 变量，三者同一次布局算完；走 state 的话窗口宽度和
        // kit 的 --grow-right 是两条更新路径，差一帧就让中栏先宽后窄地抖。
        if (gesture.edge === "e" && resizeStartRightRef.current > 0) {
          const startRight = resizeStartRightRef.current;
          const startInc = resizeStartIncRef.current;
          const base = sizeRef.current?.width ?? Math.min(DEFAULT_WINDOW_WIDTH, window.innerWidth - WINDOW_VIEWPORT_GUTTER);
          const startWin = base + startInc;
          const rawRight = startRight + dx;
          // 右栏不小于 MIN_RIGHT_WIDTH
          const width = Math.max(MIN_RIGHT_WIDTH, rawRight);
          // 窗口宽 = 起点宽 + 右栏的变化量，但下限是「中栏最小 + 右栏最小」：
          // 右栏缩到下限后继续往左拖，窗口继续变窄，多出来的空间由中栏让出
          // —— 这就是"右栏已最小、中栏还有空间时中栏可以变小"。
          // 起点必然满足 win ≥ minWidth + right（否则本来就不该出现），所以这里不会把窗口放大的。
          const win = Math.max(minWidth + width, startWin + (rawRight - startRight));
          // 窗口增量按"窗口宽的变化量"推进：起点上 inc 可能小于 rightWidth
          // （贴屏幕右边时右栏挤压中栏），用绝对值会让第一帧跳一下。
          const inc = win - base;
          rightLiveRef.current = width;
          rightLiveIncRef.current = inc;
          const frame = frameRef.current;
          frame?.style.setProperty("--launcher-right-width", `${inc}px`);
          frame?.style.setProperty("--right-resize-width", `${width}px`);
          return;
        }
        const west = gesture.edge.includes("w");
        const east = gesture.edge.includes("e");
        const north = gesture.edge.includes("n");
        const south = gesture.edge.includes("s");
        const width = Math.max(minWidth, gesture.width + (east ? dx : west ? -dx : 0));
        const height = Math.max(minHeight, gesture.height + (south ? dy : north ? -dy : 0));
        const leftChange = west ? gesture.width - width : 0;
        setSize({ width, height });
        setOffset({
          x: gesture.offsetX + leftChange + (width - gesture.width) / 2,
          // 顶部硬边界：从北边拉高窗口时窗口顶会跟着上移，钳住下界使顶永远 >= 0（不能穿过顶部）。
          y: Math.max(TOP_MIN_OFFSET_Y, gesture.offsetY + (north ? gesture.height - height : 0)),
        });
      }
    }
    function stop() {
      // 拖右侧边框结束时把实时值一次性提交给宿主（落 state、kit 用它重写 --grow-right），
      // 之后的一切又回到 React 驱动，行为与「拖分隔线」完全一致。
      const live = rightLiveRef.current;
      rightLiveRef.current = null;
      gestureRef.current = null;
      if (live != null) rightPanelRef.current.onResize?.(live, rightLiveIncRef.current);
      // 拖拽态**延后两帧**再解除。松手这一刻 React 刚把新宽度提交上去，如果同一帧就
      // 摘掉 .window-interacting / .window-resizing-right，CSS 会在 kit 的 --grow-right
      // 还没落到 DOM 时切回它，右栏先按旧宽度排一次版 —— 就是"松手时两个 panel 抖一下、
      // 最后才真正算好"的来源。等两帧（React commit + 浏览器布局）后再切，值已经相等，
      // 切换过程零视觉变化。
      const seq = ++gestureSeqRef.current;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (gestureSeqRef.current !== seq) return; // 这两帧里又开始了新手势
          setInteracting(false);
          setRightResizing(false);
        });
      });
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.removeEventListener("blur", stop);
    };
  }, [minWidth, minHeight]);

  function startDrag(event: globalThis.PointerEvent) {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    gestureSeqRef.current += 1; // 取消上一次松手后挂起的"解除拖拽态"
    if (maximized) {
      /** 抓取最大化窗口时的实测几何（= 全屏宽 × Dock 以上的高）与鼠标落点，拖出去按原尺寸平移。 */
      const rect = frameRef.current?.getBoundingClientRect();
      gestureRef.current = {
        kind: "restore",
        x: event.clientX,
        y: event.clientY,
        grabX: rect ? event.clientX - rect.left : 0,
        grabY: rect ? event.clientY - rect.top : 19,
        width: rect?.width ?? window.innerWidth,
        height: rect?.height ?? window.innerHeight,
      };
    } else {
      setInteracting(true);
      gestureRef.current = { kind: "move", x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
    }
    event.preventDefault();
  }
  // 顶部栏的拖动/双击必须走**原生**监听：工具栏是 createPortal 进来的，React 合成事件按组件树
  // 冒泡、不按 DOM 树，挂在 .focus-topbar-wrap 上的 onPointerDown 收不到落在工具栏上的按下
  // （工具栏铺满整条 38px 顶部，等于整条都是拖不动的死区）。原生事件按 DOM 冒泡就没这个问题。
  const startDragRef = useRef(startDrag);
  startDragRef.current = startDrag;
  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const onPointerDown = (event: globalThis.PointerEvent) => startDragRef.current(event);
    const onDoubleClick = (event: MouseEvent) => {
      if (!showMaximize || (event.target as HTMLElement).closest("button")) return;
      toggleMaximize();
    };
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("dblclick", onDoubleClick);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("dblclick", onDoubleClick);
    };
  }, [showMaximize]);

  function startResize(event: PointerEvent<HTMLDivElement>, edge: string) {
    if (event.button !== 0 || maximized) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    gestureSeqRef.current += 1; // 取消上一次松手后挂起的"解除拖拽态"
    // 右栏展开时窗口会额外多出 windowExtra（CSS 里按 --launcher-right-width 加的）。这里必须用
    // 逻辑宽度（--window-width，即用户 resize 出来的基准宽），否则每拖一次边框都会把
    // 含右栏的视觉宽度写回基准，窗口越拖越宽。注意用 extra 而不是右栏真实宽度：
    // 屏幕右侧空间不足时右栏会挤压中栏，窗口增量 < 右栏宽度。
    const rightExtra = rightPanelRef.current.extra;
    const width = sizeRef.current?.width ?? Math.max(minWidth, rect.width - rightExtra);
    const height = sizeRef.current?.height ?? rect.height;
    gestureRef.current = { kind: "resize", x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y, width, height, edge };
    // 右栏开着时，右侧边框拖拽改为调整右栏宽度（见 move 里的分支）
    resizeStartRightRef.current = edge === "e" ? rightPanelRef.current.width : 0;
    if (resizeStartRightRef.current > 0) {
      resizeStartIncRef.current = rightPanelRef.current.extra;
      // 拖拽期间右栏宽度由 --right-resize-width 驱动，必须先把初值落上，
      // 否则 CSS 回退到 0，按住的一瞬间右栏会先塌下去。
      frameRef.current?.style.setProperty("--right-resize-width", `${resizeStartRightRef.current}px`);
      setRightResizing(true);
    }
    setInteracting(true);
    event.preventDefault();
    event.stopPropagation();
  }

  function toggleMaximize() {
    setMaximized((value) => !value);
  }

  function minimize() {
    if (minimizing) return;
    if (!onMinimize || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onMinimize?.();
      return;
    }
    setMinimizing(true);
    minimizeTimerRef.current = window.setTimeout(onMinimize, 180);
  }

  /**
   * 置顶在 pointerdown 当下派发即可 —— 前提是「置顶不改 DOM 顺序」。
   *
   * 置顶 = openWindows 顺序变化，只影响 z-index（Dock 里按 indexOf 算 layer）。Dock 渲染窗口时
   * 用的是稳定的顺序（见 Dock 的 stableWindowOrder），所以这次置顶不会把当前窗口的 DOM 节点
   * 搬到兄弟末尾。Chromium 只在节点被移动/移除时才丢弃这次 click；仅仅改 z-index、className、
   * 触发重渲染都不影响，click 照常派发给控件 —— 一次点击既置顶又生效。
   *
   * 反例（曾经踩过）：如果渲染顺序跟着 openWindows 走，按下时置顶会把节点搬走，mousedown 与
   * mouseup 之间节点换了位置，这次 click 就被吞掉，表现成「点第一下只聚焦、要点两次才生效」。
   */

  const frameClassName = [
    "quick-input", "focus-mode", `skin-${skinId}`, "window-frame",
    className,
    fitContent ? "window-fit-content" : "",
    preview ? "window-preview" : "",
    minimized ? "window-minimized" : "",
    startedAsPreview.current ? "window-previewed" : "",
    composerEntering ? "window-composer-entering" : "",
    directEntering ? "window-direct-enter" : "",
    maximized ? "window-maximized" : "",
    interacting ? "window-interacting" : "",
    rightResizing ? "window-resizing-right" : "",
    minimizing ? "window-minimizing" : "",
    focused ? "window-focused" : "",
    voiceFirstMinimal ? "voice-first-chat" : "",
    voiceFirstSurface ? "voice-first-surface" : "",
    artifactDropActive ? "window-file-drop" : "",
  ].filter(Boolean).join(" ");

  return (
    <div ref={frameRef} data-window-id={id} inert={minimized} aria-hidden={minimized}
      role={ariaLabel ? "dialog" : undefined} aria-label={ariaLabel}
      className={frameClassName}
      style={{ ...style, ...(rightLiveRef.current != null ? { "--launcher-right-width": `${rightLiveIncRef.current}px` } : null), zIndex: style?.zIndex ?? (maximized ? 900 : undefined), "--window-offset-x": `${offset.x}px`, "--window-offset-y": `${offset.y}px`, "--window-width": size ? `${size.width}px` : undefined, "--window-height": !fitContent && size?.height ? `${size.height}px` : undefined } as CSSProperties}
      onAnimationEnd={(event) => {
        if (event.animationName === "home-composer-in") setComposerEntering(false);
        if (event.target === event.currentTarget && directEntering) setDirectEntering(false);
      }}
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement;
        /**
         * 预览态里**点输入区不算"打开窗口"**：加号、项目/模型选择、权限、发送等按钮，
         * 以及它们展开的菜单，都只属于输入区本身 —— 用户要的是"只显示输入框"的悬浮输入条，
         * 不能因为点了个按钮就把整棵聊天 UI 弹出来。展开完整窗口仍走三条明确路径：
         * 点 Dock 的 Home 按钮、发消息（消息区出现即自动展开，见 QuickInput）、Ctrl/Cmd+T。
         */
        if (preview && previewInteractiveSelector && target.closest(previewInteractiveSelector)) return;
        /**
         * 点窗口控制按钮（关闭/最小化/最大化）**不**在 pointerdown 阶段抢焦点：
         * 否则焦点变化会触发整窗重渲染，把这次 click 事件的按钮节点替换掉 → 按钮的
         * onClick 收不到，表现成"点第一下只聚焦、要点两下才生效"。焦点改到按钮 onClick
         * 里补（那时 click 已派发完，重渲染不会再吞这次点击）。
         */
        if (target.closest(".focus-window-controls")) return;
        // 其余区域：按下即置顶（Dock 的渲染顺序稳定，置顶只改 z-index，不会吞掉这次 click）。
        onFocus?.();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseLeave={preview ? onMouseLeave : undefined}
      onDragOver={onArtifactDragOver}
      onDrop={onArtifactDrop}
      onDragLeave={(event) => {
        // 指针只是从窗口里的一个子元素挪到另一个子元素时不算离开窗口。
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        onArtifactDragLeave?.(event);
      }}>
      {resizable && !maximized && (["n", "e", "s", "w", "ne", "se", "sw", "nw"] as const).map((edge) => (
        <div key={edge} className={`focus-resize-handle focus-resize-${edge}`} onPointerDown={(event) => startResize(event, edge)} aria-hidden="true" />
      ))}
      <div className="focus-window-clip">
        <div ref={topbarRef} className="focus-topbar-wrap">
          <div className="focus-window-controls" aria-label={t("window.controls")}>
            {showClose && (
              /* 关闭 = 隐藏（与最小化一致，ChatGPT 式）：窗口折叠、会话继续后台跑，点 Dock 图标原样恢复。
                 不删 savedWindows —— 恢复时保持关闭前的窗口大小与位置。 */
              <button type="button" className="focus-window-control close" aria-label={t("window.close")} onClick={() => { onFocus?.(); onClose?.(); }}>
                <svg viewBox="0 0 12 12" className="focus-close-glyph" aria-hidden="true">
                  <path d="M3.7 3.7L8.3 8.3M8.3 3.7L3.7 8.3" />
                </svg>
              </button>
            )}
            {showMinimize && (
              <button type="button" className="focus-window-control minimize" aria-label={t("window.minimize")} onClick={() => { onFocus?.(); minimize(); }}>
                <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6h7" /></svg>
              </button>
            )}
            {showMaximize && (
              <button type="button" className="focus-window-control maximize" aria-label={maximized ? t("window.restore") : t("window.maximize")} onClick={() => { onFocus?.(); toggleMaximize(); }}>
                <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 5V2.5H5M2.5 2.5L5.2 5.2M9.5 7v2.5H7M9.5 9.5L6.8 6.8" /></svg>
              </button>
            )}
          </div>
          {header != null && <div className={`window-frame-header${headerAlign === "center" ? " is-centered" : ""}`}
            style={headerAlign === "center" ? undefined : { paddingLeft: headerInset }}>{header}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
