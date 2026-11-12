import { useEffect } from "react";
import { useLauncher } from "./state";
import Desktop from "./desktop/Desktop";
import Workspace from "./workspace/Workspace";
import FpsBadge from "./dev/FpsBadge";

export default function App() {
  const { state, dispatch } = useLauncher();

  // Ctrl/Cmd + T：Home 窗口的开关。
  // 只在「桌面 + 没有其它应用窗口」时接管 —— 数域窗口（钉钉/飞书）开着时按它
  // 不应该把焦点抢回 Home，那和操作系统的窗口管理直觉相反。
  // 主进程没有绑定这个组合键（菜单是隐藏的默认菜单，不含 Ctrl+T），所以这里能收到原生 keydown。
  useEffect(() => {
    if (!state.launcher) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return; // 输入法组合中不抢键
      const mac = /mac/i.test(navigator.userAgent);
      const accel = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!accel || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "t") return;
      if (state.view !== "desktop") return;
      // 有其它应用窗口时不响应（单窗口的 Home 开关语义）
      if (state.openWindows.some((id) => id !== "primary")) return;
      event.preventDefault();
      if (state.openWindows.includes("primary")) dispatch({ type: "CLOSE_CHAT", windowId: "primary" });
      else dispatch({ type: "OPEN_FOCUS_CHAT" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [state.launcher, state.view, state.openWindows, dispatch]);

  /**
   * 有任务运行时保持唤醒（系统设置 → 其他 → 电源）。
   *
   * 渲染层是唯一知道「现在有没有会话在跑」的地方（runningSessionsByWindow 由各聊天窗 /
   * 工作区 / 桌面后台实例上报，已按会话 id 去重），所以在这里算「开关开着 && 还有任务」
   * 的结果推给主进程，由主进程调系统电源 API（macOS IOPMAssertion / Windows
   * SetThreadExecutionState）阻止显示器休眠 —— 屏幕不黑就不会因为空闲锁屏。
   *
   * 任务结束 → 下面这个 effect 立刻把 false 推下去，主进程延迟一小会儿释放断言（见
   * keep-awake.ts），系统恢复原来的休眠策略；用户手改开关同理（依赖里有 keepAwakeOnTask）。
   * 这里不做防抖：真正的延迟释放放在主进程，才不会受窗口隐藏时渲染层定时器节流的影响。
   */
  const keepAwakeOnTask = state.launcher?.keepAwakeOnTask ?? true;
  const hasRunningTask = Object.values(state.runningSessionsByWindow).some((sessions) => sessions.length > 0);
  const keepAwake = Boolean(state.launcher) && keepAwakeOnTask && hasRunningTask;
  useEffect(() => {
    void window.launcher.setKeepAwake(keepAwake).catch(() => {});
  }, [keepAwake]);
  // 整棵界面卸载（窗口销毁 / 热重载）时兜底放掉：这时已经没人上报任务了，别把机器钉醒着。
  useEffect(() => () => { void window.launcher.setKeepAwake(false).catch(() => {}); }, []);

  if (!state.launcher) {
    return <div className="desktop" style={{ background: "#101014" }} />;
  }

  return (
    <>
      <Desktop />
      {state.view === "workspace" && <Workspace />}
      <FpsBadge />
    </>
  );
}
