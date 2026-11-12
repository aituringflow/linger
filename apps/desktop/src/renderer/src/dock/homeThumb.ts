/**
 * 缩略图 = **真窗口本身**，不是另画一份。
 *
 * HTML 里没有「引用另一个元素的渲染结果」这种原生能力：
 *  · CSS 的 `element()` 只有 Firefox 实现，Chromium（Electron）没有；
 *  · `cloneNode` 只是拷贝一份死的快照，窗口内容变了缩略图不会变；
 *  · 再挂一个 kit `AgentWindow` 顶多算「第二扇窗」，流式输出、滚动位置都对不上。
 *
 * 所以这里用的是唯一真正「软链接」的做法：**把同一个 DOM 节点搬到缩略图里再 scale**。
 * 搬的是节点本身，React 之后的更新照常落在它身上 —— 会话在跑、消息在流、输入框在变，
 * 缩略图全都实时跟着变，因为它就是那扇窗口。
 *
 * 三条铁律：
 *  1. 搬之前先量尺寸。窗口最小化只是 `visibility: hidden`，布局还在，offsetWidth/Height 可用。
 *  2. **卸载窗口之前必须先搬回去**。React 卸载时按自己记的父节点 `removeChild`，
 *     节点被搬到别处就会抛 NotFoundError（整页白屏）。所以调用方一定要在执行
 *     「关闭这扇窗口」的 dispatch 之前调用 detach()。
 *  3. **卡片尺寸必须统一**，不能跟着窗口走：几扇窗口高度差几十像素时，卡片参差不齐
 *     看起来像坏了。统一高度由 measureBodyHeight() 一次量出，所有卡共用。
 */

/** 缩略图卡片的固定宽度。 */
export const THUMB_WIDTH = 220;
/** 卡片顶部那条标题栏的高度（不参与缩放 —— 缩到 1/3 的 11px 字就没法看了）。 */
export const THUMB_HEADER_HEIGHT = 26;
/** 统一高度上下限：再高就挡住半屏，再矮就认不出是窗口。 */
const MIN_BODY_HEIGHT = 170;
const MAX_BODY_HEIGHT = 420;
const FALLBACK_BODY_HEIGHT = 300;

/**
 * 所有卡片共用的「窗口画面」高度：取各窗口按宽度缩放后最高的那个。
 *
 * 为什么是最大值：卡片统一高度，窗口再按**高度**填满（等比，不拉扁），
 * 所以谁都不会被纵向裁掉；宽一点的那扇左右各裁掉几像素（都是窗口的空白边距）。
 */
export function measureBodyHeight(windowIds: readonly string[]): number {
  let tallest = 0;
  for (const windowId of windowIds) {
    const frame = document.querySelector<HTMLElement>(`.quick-input[data-window-id="${windowId}"]`);
    if (!frame) continue;
    const width = frame.offsetWidth;
    const height = frame.offsetHeight;
    if (!width || !height) continue;
    tallest = Math.max(tallest, height * (THUMB_WIDTH / width));
  }
  if (!tallest) return FALLBACK_BODY_HEIGHT;
  return Math.round(Math.min(MAX_BODY_HEIGHT, Math.max(MIN_BODY_HEIGHT, tallest)));
}

/**
 * 缩略图里那块「窗口底色」到底是谁画的。
 *
 * `.quick-input.focus-mode` 自己 `background: transparent`，真正的底色在
 * `.focus-window-clip > .chat-shell` 上（各皮肤还不一样）。缩略图要把卡片里
 * 窗口周围的空隙补成同一个色，否则会看到一条硬边 —— 所以往下探一层。
 */
function paintedBackground(frame: HTMLElement): string | null {
  const nodes: HTMLElement[] = [
    ...frame.querySelectorAll<HTMLElement>(".focus-window-clip, .chat-shell, .chat-main, .launcher-domain-apps"),
    frame,
  ];
  for (const node of nodes) {
    const background = getComputedStyle(node).backgroundColor;
    if (background && background !== "rgba(0, 0, 0, 0)" && background !== "transparent") return background;
  }
  return null;
}

/**
 * 标题栏文字/描边跟着**窗口底色**取反，而不是跟着应用主题走。
 *
 * 皮肤是独立于主题的：应用是浅色主题、窗口套的却是「熔火龙境」这种深色皮肤时，
 * 标题文字用 --text（深色）压在深色窗口上就看不见了。这里按底色的亮度选一套。
 */
function inkFor(background: string) {
  const match = /rgba?\(([^)]+)\)/.exec(background);
  let light = false;
  if (match) {
    const [r, g, b] = match[1].split(",").map((part) => Number.parseFloat(part));
    light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;
  }
  return light
    ? { ink: "rgba(26, 26, 30, .92)", dim: "rgba(26, 26, 30, .5)", edge: "rgba(20, 20, 24, .16)" }
    : { ink: "rgba(255, 255, 255, .92)", dim: "rgba(255, 255, 255, .45)", edge: "rgba(255, 255, 255, .14)" };
}

export interface ThumbHandle {
  /** 把窗口放回原处。幂等；组件卸载或关窗前都要调。 */
  detach: () => void;
  /** 窗口节点是否真的接到了缩略图里（false = 这扇窗口还没挂载，卡片走占位）。 */
  attached: boolean;
}

const NOOP_HANDLE: ThumbHandle = { detach: () => undefined, attached: false };

export function attachThumb(windowId: string, host: HTMLElement, bodyHeight: number): ThumbHandle {
  const frame = document.querySelector<HTMLElement>(`.quick-input[data-window-id="${windowId}"]`);
  if (!frame) return NOOP_HANDLE;

  // 先量：进缩略图之后布局宽度会被缩放包住，量出来的还是原尺寸，但先量更稳。
  const width = frame.offsetWidth || 600;
  const height = frame.offsetHeight || 700;
  // 用 host 的**内容盒**而不是常量：卡片有 1px 描边，减掉才不会在右边被裁掉 2px。
  const boxWidth = host.clientWidth || THUMB_WIDTH;
  const boxHeight = host.clientHeight || bodyHeight;
  /**
   * 等比缩到框里（宽度、高度两边取更小的比例）：比例绝不变形、内容绝不被裁。
   * 窗口比框矮时**底边对齐** —— 输入卡始终贴卡片下沿，几扇窗口的输入框在同一条线上，
   * 上方空出来的那一小截用窗口自己的底色补（下面 probe 到的颜色），看不出接缝。
   */
  const scale = Math.min(boxWidth / width, boxHeight / height);
  const offsetX = (boxWidth - width * scale) / 2;
  const offsetY = boxHeight - height * scale;
  frame.style.setProperty("--thumb-scale", String(scale));
  frame.style.setProperty("--thumb-x", `${offsetX.toFixed(2)}px`);
  frame.style.setProperty("--thumb-y", `${offsetY.toFixed(2)}px`);

  /**
   * 卡片里窗口周围的空隙补成**窗口自己的底色**（探到 .focus-window-clip / .chat-shell），
   * 否则会有一条硬边；标题栏文字/描边按这个底色的明暗取反，避免深色皮肤 + 浅色主题时看不见。
   */
  const background = paintedBackground(frame);
  const card = host.parentElement;
  if (background) {
    host.style.backgroundColor = background;
    if (card) {
      const ink = inkFor(background);
      card.style.setProperty("--home-switcher-card-bg", background);
      card.style.setProperty("--home-switcher-head-ink", ink.ink);
      card.style.setProperty("--home-switcher-head-ink-dim", ink.dim);
      card.style.setProperty("--home-switcher-card-edge", ink.edge);
    }
  }

  const parent = frame.parentElement;
  frame.classList.add("window-thumbed");
  host.appendChild(frame);

  let detached = false;
  return {
    attached: true,
    detach: () => {
      if (detached) return;
      detached = true;
      frame.classList.remove("window-thumbed");
      frame.style.removeProperty("--thumb-scale");
      frame.style.removeProperty("--thumb-x");
      frame.style.removeProperty("--thumb-y");
      if (background) {
        host.style.removeProperty("background-color");
        for (const name of ["--home-switcher-card-bg", "--home-switcher-head-ink",
          "--home-switcher-head-ink-dim", "--home-switcher-card-edge"]) {
          card?.style.removeProperty(name);
        }
      }
      // 放回那个「稳定的承载层」（.window-slot，里面只有它一个）：React 卸载窗口时
      // 会在这里 removeChild，找不到就会抛 NotFoundError。
      if (parent?.isConnected) parent.appendChild(frame);
      else if (frame.parentNode === host) host.removeChild(frame);
    },
  };
}

/**
 * 和 attachThumb 相反的姿势：**不搬动真实窗口**，而是克隆一份「静态快照」塞进缩略图。
 *
 * 给「还开着、看得见」的窗口用。真实窗口留在桌面原样（用户要的就是它别动），
 * 缩略图只是它某一刻的样子（不跟着变，关浮层就丢）。克隆体不是 React 树的一部分，
 * 所以原窗口照常更新、缩略图也不会反向污染。
 *
 * 为什么不能对可见窗口也用 attachThumb：那条是「把节点搬到卡片里」，搬了桌面上的窗口就没了——
 * 用户点 Home 本意是挑窗口，不是让眼前的窗口凭空消失。
 */
export function attachThumbSnapshot(windowId: string, host: HTMLElement, bodyHeight: number): ThumbHandle {
  const frame = document.querySelector<HTMLElement>(`.quick-input[data-window-id="${windowId}"]`);
  if (!frame) return NOOP_HANDLE;

  const width = frame.offsetWidth || 600;
  const height = frame.offsetHeight || 700;
  const boxWidth = host.clientWidth || THUMB_WIDTH;
  const boxHeight = host.clientHeight || bodyHeight;
  const scale = Math.min(boxWidth / width, boxHeight / height);
  const offsetX = (boxWidth - width * scale) / 2;
  const offsetY = boxHeight - height * scale;

  // 克隆整棵子树：此刻窗口长什么样，缩略图就是什么样（之后不再更新）。
  const clone = frame.cloneNode(true) as HTMLElement;
  // 去掉 id 避免和原窗口撞（原窗口的 id 还活着，重复 id 会让 getElementById 之类的逻辑认错）。
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
  clone.classList.add("window-thumbed");
  clone.style.setProperty("--thumb-scale", String(scale));
  clone.style.setProperty("--thumb-x", `${offsetX.toFixed(2)}px`);
  clone.style.setProperty("--thumb-y", `${offsetY.toFixed(2)}px`);
  // 纯画面：不接任何交互（克隆体不是 React 树的一部分，接了事件也会窜到原窗口）。
  clone.style.pointerEvents = "none";
  clone.setAttribute("aria-hidden", "true");

  // 卡片底色/墨色沿用真窗口那一套（和 attachThumb 一致）。
  const background = paintedBackground(frame);
  const card = host.parentElement;
  if (background) {
    host.style.backgroundColor = background;
    if (card) {
      const ink = inkFor(background);
      card.style.setProperty("--home-switcher-card-bg", background);
      card.style.setProperty("--home-switcher-head-ink", ink.ink);
      card.style.setProperty("--home-switcher-head-ink-dim", ink.dim);
      card.style.setProperty("--home-switcher-card-edge", ink.edge);
    }
  }

  host.appendChild(clone);
  let detached = false;
  return {
    attached: true,
    detach: () => {
      if (detached) return;
      detached = true;
      clone.remove();
      if (background) {
        host.style.removeProperty("background-color");
        for (const name of ["--home-switcher-card-bg", "--home-switcher-head-ink",
          "--home-switcher-head-ink-dim", "--home-switcher-card-edge"]) {
          card?.style.removeProperty(name);
        }
      }
    },
  };
}
