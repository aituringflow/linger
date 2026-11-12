import { useEffect, useState } from "react";

/** 初始开关：本地记住的选择优先；没选过时默认关（要看去按 F8，或把下面的 DEV_DEFAULT_ON 改回 true）。 */
const STORAGE_KEY = "launcher:fps-badge";

/** dev 下是否默认显示。暂时设成 false 把左上角 HUD 藏起来；F8 仍然可以随时手动唤出。 */
const DEV_DEFAULT_ON = false;

function initialEnabled(): boolean {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "1") return true;
  if (stored === "0") return false;
  // dev 是 vite 起的 http server，打包版走 file:// —— 不依赖 import.meta.env 的类型声明
  const dev = location.protocol === "http:" || location.protocol === "https:";
  return dev && DEV_DEFAULT_ON;
}

/**
 * 左上角帧率 HUD（F8 开关）。
 *
 * Electron 没有现成的帧率 API（app.getAppMetrics 只有 CPU/内存/进程信息），
 * 这里用 requestAnimationFrame 回调频率来数帧 —— 它等于窗口真实的合成帧率。
 * 注意：窗口被遮挡 / 最小化时 Chromium 会把 rAF 冻住，此时显示 "—" 而不是停在旧值。
 */
export default function FpsBadge() {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [fps, setFps] = useState<number | null>(null);
  const [frameMs, setFrameMs] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F8" || event.repeat) return;
      event.preventDefault();
      setEnabled((on) => {
        const next = !on;
        localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
        return next;
      });
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setFps(null);
      setFrameMs(null);
      return;
    }
    let frames = 0;
    let windowStart = performance.now();
    let lastFrame = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      frames += 1;
      lastFrame = now;
      const span = now - windowStart;
      if (span >= 500) {
        setFps(Math.round((frames * 1000) / span));
        setFrameMs(Math.round((span / frames) * 10) / 10);
        frames = 0;
        windowStart = now;
      }
      raf = window.requestAnimationFrame(loop);
    };
    raf = window.requestAnimationFrame(loop);
    const watchdog = window.setInterval(() => {
      if (performance.now() - lastFrame > 900) {
        setFps(null);
        setFrameMs(null);
      }
    }, 500);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearInterval(watchdog);
    };
  }, [enabled]);

  if (!enabled) return null;
  return (
    <div className="fps-badge" aria-hidden="true">
      <strong>{fps ?? "—"}</strong>
      <span>fps</span>
      {frameMs !== null && <em>{frameMs.toFixed(1)}ms</em>}
    </div>
  );
}
