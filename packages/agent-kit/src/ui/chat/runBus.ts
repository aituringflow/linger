/**
 * 同一渲染进程内的「会话运行态广播」。
 *
 * 为什么要它：一个页面可能同时挂着多个 AgentWindow 实例，各自持有一份 runtime（rt，
 * 里面是 messages / busy / 流缓冲）。桌面宿主就是这样——
 *  · 桌面上的真实聊天窗（primary / primary-n）负责用户正在看的那个会话；
 *  · 桌面的隐藏实例（DesktopSendRunner / DesktopRefreshRunner）负责「桌面把文件拖到
 *    会话卡片上」这类后台动作，它们在**自己的** rt 里跑完这一轮。
 * 两者指向同一条会话（同一份落盘数据），但流只存在于发起方。结果就是：
 * 桌面卡片能看到流式答复（快照来自隐藏实例），点开同一个会话却看到空答复——
 * 因为真实聊天窗的 rt 里没有这一轮，也收不到任何通知。
 *
 * 这里只广播「某会话在这一刻开始/结束了一轮」，不搬运消息内容：
 *  · start → 正在看这个会话的实例去 /chat/run 接管那条 run（重放 + 实时）；
 *  · end   → 正在看这个会话的实例重读落盘历史，把最终答复补齐。
 * 数据仍然只有一个来源（会话存储 / 运行日志），广播只负责"该刷新了"。
 *
 * 只在模块级别生效，因此天然覆盖同一页面内的多实例（桌面宿主全部窗口都是虚拟窗口，
 * 同一个 JS 上下文）；跨浏览器标签页/多窗口不在此范围内（那种场景本来就各有各的 rt）。
 */

export type RunEventType = "start" | "end";

export interface RunEvent {
  type: RunEventType;
  sessionId: string;
  /** 发起方实例 id：接收方据此忽略自己发出的事件，避免自我唤醒。 */
  origin: string;
  at: number;
}

type RunListener = (event: RunEvent) => void;

const listeners = new Set<RunListener>();

/** 广播一次运行态变化（同步派发；监听方异常不影响其它监听方与调用方）。 */
export function publishRunEvent(event: { type: RunEventType; sessionId: string; origin: string }): void {
  if (!event.sessionId) return;
  const payload: RunEvent = { ...event, at: Date.now() };
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch (error) {
      console.warn("[agent-kit] 会话运行态广播处理异常:", error);
    }
  }
}

/** 订阅运行态变化；返回取消订阅函数。 */
export function subscribeRunEvents(listener: RunListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
