// 全局连接状态：感知「服务器连不上」（断网 / 服务未启动 / 实时通道异常等网络层失败）。
//
// 我们的服务有两部分，必须**都**能连上才算在线：
//  ① HTTP：任意请求成功送达（含 HTTP 4xx/5xx，说明服务器本身可达）即恢复；网络层失败
//     （fetch 抛 TypeError，如 Failed to fetch）即标记离线；
//  ② WebSocket（实时通道）：由 realtime.ts 上报实际连接状态——有订阅时 WebSocket 必须处于
//     已连接/连接中；未订阅实时频道时视为可达（不要求常驻连接）。
//
// 判定来源：
//  - window 的 online / offline 事件（浏览器对网络可达性的第一手信号）；
//  - apiFetch 的成败（HTTP 维度）；
//  - realtime.ts 的 markWsState（WS 维度）。
//
// 只处理「网络层」失败：HTTP 4xx/5xx 表示服务器可达，不算连不上，不触发提示。
// 聊天区顶栏等界面通过 subscribeConnection 订阅，离线时展示「无法连接服务器」横幅。
type ConnectionListener = (online: boolean) => void;

let httpOnline = typeof navigator === "undefined" ? true : navigator.onLine;
// WS 维度：expected=false（无实时订阅）视为可达；expected=true 时以 ok 为准
let wsOk = true;
const listeners = new Set<ConnectionListener>();

function computeOnline(): boolean {
  return httpOnline && wsOk;
}

// 缓存已通知的值，避免每次上报都广播
let online = computeOnline();
function notify() {
  const value = computeOnline();
  if (online === value) return;
  online = value;
  listeners.forEach((listener) => listener(value));
}

/** 订阅连接状态变化；返回取消订阅函数。 */
export function subscribeConnection(listener: ConnectionListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 读取当前连接状态（供初始化 useState）。 */
export function isServerOnline(): boolean {
  return computeOnline();
}

/** 读取两条通道各自的状态（供横幅显示具体是哪一半连不上）。 */
export function getConnectionState(): { http: boolean; ws: boolean } {
  return { http: httpOnline, ws: wsOk };
}

/** 由 apiFetch 上报一次 HTTP 请求的网络层成败（仅影响 HTTP 维度）。 */
export function markConnectionResult(succeeded: boolean) {
  httpOnline = succeeded;
  notify();
}

/** 由 realtime.ts 上报 WebSocket 实时通道状态。
 *  expected=false → 当前无实时订阅（不需要常驻连接）→ 视为可达；
 *  expected=true  → 必须有可用连接（connected/connecting 中），否则判定连不上。 */
export function markWsState(state: { expected: boolean; ok: boolean }) {
  wsOk = !state.expected || state.ok;
  notify();
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => { httpOnline = true; notify(); });
  window.addEventListener("offline", () => { httpOnline = false; notify(); });
}
