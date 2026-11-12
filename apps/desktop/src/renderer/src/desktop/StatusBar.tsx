"use client";

import { useEffect, useState } from "react";
import type { LauncherStatusIme, LauncherSystemStatus } from "../../../shared/types";

/**
 * 自绘的 macOS 式状态栏（右侧那一簇）。
 *
 * 顺序（与系统菜单栏一致，从右往左）：时间日期 → 电量 → Wi-Fi（→ 输入法，当前隐藏）。
 * 数据来源：
 *   · 时间日期 —— 渲染层自己算，固定中文口径（`10月26日 周一 15:35`），不用任何系统调用；
 *   · 电量 / Wi-Fi / 输入法 —— 主进程的原生采集器 `statusctl`（IME 走 HIToolbox、Wi-Fi 走 CoreWLAN、
 *     电量走 IOKit），变化时通过 `onSystemStatus` 推过来。取不到就把对应项藏掉，不画假数据。
 */
export function StatusBar() {
  const [status, setStatus] = useState<LauncherSystemStatus | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    void window.launcher.getSystemStatus().then((next) => {
      if (alive) setStatus(next);
    }).catch(() => undefined);
    const unsubscribe = window.launcher.onSystemStatus((next) => setStatus(next));
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  // 只显示到分钟，10s 一跳足够；用 setTimeout 对齐到下一个 10s，避免整分钟边界上慢一拍。
  useEffect(() => {
    let timer = 0;
    const schedule = () => {
      const delay = 10_000 - (Date.now() % 10_000);
      timer = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, delay);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, []);

  const ime = status?.ime ?? null;
  const wifi = status?.wifi ?? null;
  const battery = status?.battery ?? null;

  return (
    <div className="status-bar" aria-label="系统状态">
      {/* 输入法角标暂时隐藏：原生采集没停（同一路 status 还带电量/Wi-Fi），改回 true 即恢复。 */}
      {SHOW_IME && ime && (
        <span className="status-bar-ime" title={ime.name || ime.id} aria-label={`输入法：${ime.name || ime.id}`}>
          {imeLabel(ime)}
        </span>
      )}
      {wifi && <WifiGlyph power={wifi.power} connected={wifi.connected} rssi={wifi.rssi} />}
      {battery && <BatteryGlyph percent={battery.percent} charging={battery.charging} ac={battery.ac} />}
      <span className="status-bar-clock">{formatClock(now)}</span>
    </div>
  );
}

const SHOW_IME = false;

/** 「10月26日 周一 15:35」：固定中文口径，不跟随系统语言。
 *  月日/周几自己拼，别用 Intl —— 不同 locale 会插逗号、周几缩写也不统一。 */
function formatClock(date: Date): string {
  const weekday = "日一二三四五六"[date.getDay()];
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日 周${weekday} ${hour}:${minute}`;
}

/**
 * 输入法的角标：macOS 在菜单栏上显示的是「输入法缩写」而不是全名 ——
 * 拼音是「拼」、ABC 是「A」、日文是「あ」、韩文是「한」。
 * 判断依据是输入源 id（HIToolbox 的 TISPropertyInputSourceID）加本地化名称。
 */
function imeLabel(ime: LauncherStatusIme): string {
  const haystack = `${ime.id} ${ime.name}`;
  if (/SCIM|Pinyin|Shuangpin|Wubi|Cangjie|Zhuyin|Bopomofo|Stroke|五笔|拼音|注音/i.test(haystack)) {
    if (/Wubi|五笔/i.test(haystack)) return "五";
    if (/Cangjie/i.test(haystack)) return "仓";
    if (/Zhuyin|Bopomofo|注音/i.test(haystack)) return "注";
    return "拼";
  }
  if (/Japanese|Kotoeri|Hiragana|Katakana|日本語/i.test(haystack)) return "あ";
  if (/Korean|Hangul|한국/i.test(haystack)) return "한";
  if (/ABC|US\b|British|Australian|Canadian|keylayout\.(ABC|US)/i.test(haystack)) return "A";
  const first = (ime.name || ime.id).trim().charAt(0);
  return first ? first.toUpperCase() : "⌨";
}

/** macOS 菜单栏风格：两层等厚扇形信号带和底部实心信号源。 */
function WifiGlyph({ power, connected, rssi }: { power: boolean; connected: boolean; rssi: number }) {
  const bars = !power || !connected ? 0 : rssi >= -55 ? 3 : rssi >= -67 ? 2 : 1;
  const dim = 0.24;
  return (
    <svg className="status-bar-icon" viewBox="0 0 24 24" role="img" aria-label={power ? `Wi-Fi 信号 ${bars} 格` : "Wi-Fi 已关闭"}>
      <path d="M1.6 8.15C7.35 2.35 16.65 2.35 22.4 8.15L20.1 10.4C15.63 5.95 8.37 5.95 3.9 10.4Z" fill="currentColor" opacity={bars >= 3 ? 1 : dim} />
      <path d="M5.53 12.06c3.57-3.42 9.37-3.42 12.94 0l-2.28 2.25a5.91 5.91 0 0 0-8.38 0Z" fill="currentColor" opacity={bars >= 2 ? 1 : dim} />
      <path d="M8.96 16.1a4.3 4.3 0 0 1 6.08 0L12 19.36Z" fill="currentColor" opacity={bars >= 1 ? 1 : dim} />
      {!power && (
        <path d="M3.2 3.2 20.8 20.8" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** 电量：胶囊 + 电极 + 填充；充电时叠一个闪电，≤10% 用警示色。 */
function BatteryGlyph({ percent, charging, ac }: { percent: number; charging: boolean; ac: boolean }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const low = clamped <= 10;
  // 内部可填充区域 2.6 → 21.0（总宽 18.4），留一点空位表示未充满。
  const fillWidth = Math.max(1.6, (clamped / 100) * 18.4);
  return (
    <span className={`status-bar-battery${low ? " is-low" : ""}`} title={`电量 ${clamped}%${charging ? "，正在充电" : ac ? "，已接电源" : ""}`}>
      <svg className="status-bar-battery-icon" viewBox="0 0 26 13" role="img" aria-label={`电量 ${clamped}%`}>
        <rect x="1" y="1" width="20.6" height="11" rx="3.4" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1.4" />
        <rect x="2.6" y="2.6" width={fillWidth} height="7.8" rx="1.9" fill="currentColor" />
        <path d="M23.3 4.4c1.5.5 1.5 3.7 0 4.2z" fill="currentColor" fillOpacity="0.5" />
        {charging && <path className="status-bar-bolt" d="M13.6 1.1 8.6 7.4h3.1l-1.2 4.5 5-6.5h-3.1z" />}
      </svg>
      <span className="status-bar-battery-text">{clamped}%</span>
    </span>
  );
}

export default StatusBar;
