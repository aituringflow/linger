/**
 * 拖拽期间是否应暂停持续动画（DynamicComposer / 小龙 DragonPet）。
 *
 * 为什么需要：这两个组件的 rAF 每帧都要读 offsetWidth / offsetHeight / getBoundingClientRect
 * 来决定画布尺寸和龙的落点，实测约 **16.7 次布局读取/帧**。
 * - 空闲时布局没有失效，这些读取命中缓存，几乎零成本，所以平时看不出问题；
 * - 拖拽时每个 drag 事件都在改 DOM（拖拽悬停高亮、网格指示、卡片让位），布局持续失效 ——
 *   于是每次读取都会触发一次**完整的同步重排**，把一帧拆成十几次重排，
 *   拖拽帧时间被放大一个数量级。这就是「动态壁纸拖会话明显掉帧、静态壁纸很顺」的原因。
 *
 * 而拖拽期间 home 窗口已经被设成 opacity: 0（见 styles-launcher.css 的
 * .is-dragging-home-session），火焰和龙根本不可见 —— 这些重排纯属白做。
 * 所以直接跳帧即可，视觉上零损失。
 */
let dragging = false;
let installed = false;
let safetyTimer: number | undefined;
const listeners = new Set<() => void>();

/** 拖拽结束时通知（火焰/小龙在拖拽期间完全停摆，必须靠这个叫醒，否则停在那儿再也不画）。 */
export function subscribeDragIdle(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function stopDragging() {
  const wasDragging = dragging;
  dragging = false;
  if (safetyTimer !== undefined) {
    window.clearTimeout(safetyTimer);
    safetyTimer = undefined;
  }
  if (wasDragging) for (const listener of listeners) listener();
}

export function installDragIdle() {
  if (installed) return;
  installed = true;
  const start = () => {
    dragging = true;
    // 兜底：把窗口拖到屏幕外、或被系统拖放接管时 dragend 可能收不到，别让动画永久停住。
    if (safetyTimer !== undefined) window.clearTimeout(safetyTimer);
    safetyTimer = window.setTimeout(stopDragging, 15000);
  };
  document.addEventListener("dragstart", start, true);
  document.addEventListener("dragend", stopDragging, true);
  document.addEventListener("drop", stopDragging, true);
  window.addEventListener("blur", stopDragging);
}

/** 当前是否处在一次拖拽中（也覆盖「home 会话拖出、源窗口已透明」的阶段）。 */
export function isDragActive(): boolean {
  return dragging || document.documentElement.classList.contains("is-dragging-home-session");
}

installDragIdle();
