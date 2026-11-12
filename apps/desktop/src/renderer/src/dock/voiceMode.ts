/**
 * 「语音模式」标记（实时转写时输入框只留文字、背景半透明）。
 *
 * 设计原则（来自产品要求）：**不另做简易输入框**。实时语音场景复用的还是原来那个
 * `.chat-composer` / textarea —— 同一个元素、同一套尺寸与排布，只是在**窗口根**上打一个
 * `data-voice-mode="realtime"`，由 kit 的 CSS 把外围控件（工具栏 / 附件 / 待发队列 /
 * 移动端按住钮 / 录音波形 / WebGL 特效）淡出、背景改半透明。
 *
 * 为什么打在窗口根而不是 composer 自己：
 *   · 窗口根（`[data-window-id]`）是 launcher 自己的元素，跨所有面板 / 主题都稳定；
 *   · 以后调 `.chat-composer` 的大小、圆角、内边距，语音态**自动跟着变** ——
 *     绝不会出现「打字态变大了、语音态还是老尺寸」这种脱节（这正是另做一套的风险）。
 *
 * 时序：新对话模式下输入框要等**第一句话**才浮出，窗口根元素当时还不存在。
 * 用 MutationObserver 等它出现（不用 rAF 轮询：用户可能按住好几秒才开口，
 * 轮询有上限就会漏，导致输入框带着完整控件闪一下）。
 *
 * 两类「需要这个标记」的窗口，分开管 —— 混在一起会出两类 bug：
 *   · active —— **正在录音**的那一扇：本轮结束就该摘掉，恢复完整控件。
 *   · pinned —— **语音优先的极简聊天窗**：发完消息后仍然要保持最小输入区
 *     （只有文字+背景），直到窗口被关闭才恢复。
 * 必须分开：录音结束会调 stop()，若不区分，极简窗会被下一轮录音的收尾动作
 * 意外恢复成完整输入框；反过来，若只靠 pinned 不区分 active，
 * 「录音结束」又会误摘极简窗的标记。
 */

/** 正在录音的窗口 id（null = 没有活跃会话）。 */
let activeWindowId: string | null = null;
/** 需要一直保持语音模式的窗口（语音优先的极简聊天窗）。 */
const pinned = new Set<string>();
/** 等待窗口根挂载的 observer：还有窗口没挂上标记时保持监听。 */
let pendingObserver: MutationObserver | null = null;

function rootOf(windowId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
}

/** 当前应该带 data-voice-mode 的窗口集合 = 正在录音的 + 钉住的。 */
function desired(): string[] {
  return activeWindowId ? [...new Set([activeWindowId, ...pinned])] : [...pinned];
}

/**
 * 把标记同步到 DOM：给需要的打上、不该有的摘掉。
 * 返回是否还有窗口没挂载（没挂载就得继续等它出现）。
 */
function syncMarks(): boolean {
  const want = desired();
  let pending = false;
  for (const id of want) {
    const root = rootOf(id);
    if (!root) { pending = true; continue; }
    root.dataset.voiceMode = "realtime";
    if (id === activeWindowId) root.dataset.voiceRecording = "true";
    else root.removeAttribute("data-voice-recording");
  }
  // 摘掉不再需要的（录音结束 / 解除钉住）。
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-window-id][data-voice-mode]"))) {
    const id = el.dataset.windowId;
    if (id && !want.includes(id)) {
      el.removeAttribute("data-voice-mode");
      el.removeAttribute("data-voice-recording");
    }
  }
  return pending;
}

/**
 * 同步标记并按需监听 DOM。
 *
 * 监听是必要的：钉住的极简窗可能被**卸载后重挂**（关掉再开同 id 的窗口），
 * 新挂上来的根元素没有标记，得补上。
 */
function watch(): void {
  if (!syncMarks()) {
    pendingObserver?.disconnect();
    pendingObserver = null;
    return;
  }
  if (pendingObserver) return;
  pendingObserver = new MutationObserver(() => { watch(); });
  pendingObserver.observe(document.body, { childList: true, subtree: true });
}

/**
 * 开始一次实时语音会话：把目标窗口标记成语音模式。
 * 元素还没挂载时会自动等它出现，不用担心「先闪一下完整控件」。
 */
export function startWindowVoiceMode(windowId: string): void {
  activeWindowId = windowId;
  watch();
}

/**
 * 结束会话：摘掉语音模式标记（正常发完 / 失败 / 取消都要调，别把窗口留在半透明态）。
 * 幂等；没有活跃会话时是空操作。
 *
 * **钉住的窗口例外**：极简聊天窗要一直保持最小输入区，只有解除钉住才会恢复。
 */
export function stopWindowVoiceMode(): void {
  activeWindowId = null;
  watch();
}

/**
 * 钉住某个窗口：此后即使 stopWindowVoiceMode() 也不会摘掉它的 data-voice-mode。
 * 用于语音优先的极简聊天窗 —— 输入区要一直保持「只有文字+背景」。
 *
 * 必须**先钉后 stop**：钉住时 stop 只清 active、不动标记，顺序反了会闪一下完整控件。
 */
export function pinWindowVoiceMode(windowId: string): void {
  pinned.add(windowId);
  watch();
}

/**
 * 用「窗口 id 列表」整体替换钉住名单（宿主 state 的唯一出口）。
 * 语音优先的极简聊天窗靠它保持最小输入区；窗口关闭时列表里就没有它了，标记自动摘掉。
 */
export function setPinnedVoiceMode(windowIds: readonly string[]): void {
  pinned.clear();
  for (const id of windowIds) pinned.add(id);
  watch();
}
