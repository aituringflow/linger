import { app } from "electron";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LauncherStatusBattery, LauncherStatusWifi, LauncherSystemStatus } from "../shared/types";

/**
 * 自绘状态栏的系统数据源。
 *
 * 时间日期由渲染层自己算（`Date` + Intl，跟系统时区/语言绑定，不需要任何系统调用），
 * 这里只负责三样必须问系统的：电量、Wi-Fi、当前输入法。
 *
 * 首选 `native/statusctl`（长驻 `--watch`，状态变一行，800ms 一轮）：
 *   · 电量 —— IOKit `IOPSCopyPowerSourcesInfo`（百分比 / 是否充电 / 是否接电源）
 *   · Wi-Fi —— CoreWLAN `CWInterface`（开关、信号强度 RSSI；SSID 在 macOS 14+ 需要定位权限，
 *              拿不到是正常的，UI 也不用它）
 *   · 输入法 —— Carbon HIToolbox `TISCopyCurrentKeyboardInputSource`
 * 这三样 Electron / Chromium 都没有可用 API，必须走系统框架。
 *
 * 二进制不存在（没装 Command Line Tools / 没跑编译脚本）时退回命令行采集：
 *   `pmset -g batt` / `networksetup + ifconfig` / `defaults read com.apple.HIToolbox`。
 * 退化模式拿不到信号强度（Wi-Fi 图标固定满格）和输入法的本地化名称（用输入源 id 兜底）。
 *
 * Windows 没有原生采集器，直接走命令行路径：
 *   · Wi-Fi —— `netsh wlan show interfaces`（开关、连接状态、信号百分比换算 dBm）
 *   · 电量 —— PowerShell `Get-CimInstance Win32_Battery`（百分比 / 充电 / 接电源）
 *   · 输入法 —— 跨进程读前台线程键盘布局代价太大，且 UI 暂不显示输入法，直接给 null。
 */

/** 采集器吐出来的原始结构；取不到的项是 null。 */
interface RawStatus {
  ime?: { id?: string; name?: string } | null;
  wifi?: { power?: unknown; connected?: unknown; rssi?: number } | null;
  battery?: { percent?: number; charging?: unknown; ac?: unknown; minutes?: number } | null;
}

const truthy = (value: unknown): boolean => value === true || value === 1 || value === "1";

function normalize(raw: RawStatus, native: boolean): LauncherSystemStatus {
  const ime = raw.ime && (raw.ime.id || raw.ime.name)
    ? { id: String(raw.ime.id ?? ""), name: String(raw.ime.name ?? raw.ime.id ?? "") }
    : null;
  const wifi = raw.wifi
    ? {
        power: truthy(raw.wifi.power),
        connected: truthy(raw.wifi.connected),
        rssi: Number(raw.wifi.rssi ?? 0) || 0,
      }
    : null;
  const percent = Number(raw.battery?.percent ?? -1);
  const battery = Number.isFinite(percent) && percent >= 0
    ? { percent, charging: truthy(raw.battery?.charging), ac: truthy(raw.battery?.ac) }
    : null;
  return { ime, wifi, battery, native };
}

/** 找采集器二进制：打包态优先 Resources，dev 用工程目录下的 resources/。 */
function helperBinary(): string | null {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "statusctl") : "",
    path.join(app.getAppPath(), "resources", "statusctl"),
    path.join(app.getAppPath(), "..", "..", "apps", "launcher", "resources", "statusctl"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续找下一个
    }
  }
  return null;
}

const run = (command: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 1500 }, (error, stdout) => resolve(error ? "" : String(stdout ?? "")));
  });

/** 最近一次采集结果（渲染层挂载时先要一份，不用等下一次变化）。 */
let current: LauncherSystemStatus = { ime: null, wifi: null, battery: null, native: false };
export function currentSystemStatus(): LauncherSystemStatus {
  return current;
}

/** 退化路径（macOS）：命令行采集（慢一些、信息少一些，但不需要编译原生工具）。 */
async function collectViaMacShell(): Promise<LauncherSystemStatus> {
  const [batteryText, wifiPowerText, wifiInfoText, imeId] = await Promise.all([
    run("pmset", ["-g", "batt"]),
    run("networksetup", ["-getairportpower", "en0"]),
    run("ifconfig", ["en0"]),
    run("defaults", ["read", "com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID"]),
  ]);

  const percent = Number((batteryText.match(/(\d+)%/) ?? [])[1]);
  const battery = Number.isFinite(percent)
    ? {
        percent,
        charging: /;\s*charging/i.test(batteryText) && !/not charging/i.test(batteryText),
        ac: /AC Power/i.test(batteryText),
      }
    : null;

  const power = /:\s*On\s*$/m.test(wifiPowerText);
  const wifi = {
    power,
    connected: power && /status:\s*active/.test(wifiInfoText) && /\n\tinet\s/.test(wifiInfoText),
    rssi: 0,
  };

  const id = imeId.trim();
  const ime = id ? { id, name: id } : null;

  return { ime, wifi, battery, native: false };
}

/**
 * Windows 命令行采集：netsh（Wi-Fi）+ PowerShell Win32_Battery（电量）。
 * netsh 的输出跟随系统语言（中文系统是「状态/信号」），正则两种语言都收。
 */
async function collectViaWindowsShell(): Promise<LauncherSystemStatus> {
  const [wlanText, batteryText] = await Promise.all([
    run("netsh", ["wlan", "show", "interfaces"]),
    // 输出一行 "percent,batteryStatus"；无电池（台式机）时不输出，电量项整个隐藏。
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1; " +
      "if ($b -and $null -ne $b.EstimatedChargeRemaining) { Write-Output (\"{0},{1}\" -f [int]$b.EstimatedChargeRemaining, [int]$b.BatteryStatus) }"]),
  ]);

  let wifi: LauncherStatusWifi | null = null;
  const wlan = wlanText.trim();
  // 没有无线网卡（台式机）时不画 Wi-Fi 图标；有网卡但关了无线电则画「Wi-Fi 已关闭」。
  if (wlan && !/no wireless interface|没有无线/i.test(wlan)) {
    const poweredDown = /powered\s*down|电源已关闭/i.test(wlan);
    const state = (/^\s*(?:State|状态)\s*:\s*(.+)$/im.exec(wlan)?.[1] ?? "").trim();
    const connected = !poweredDown && /^(connected|已连接)$/i.test(state);
    const signal = Number(/^\s*(?:Signal|信号)\s*:\s*(\d+)\s*%/im.exec(wlan)?.[1]);
    // 微软信号质量百分比与 dBm 的近似换算：quality ≈ (rssi + 100) * 2。
    const rssi = Number.isFinite(signal) ? Math.round(signal / 2) - 100 : 0;
    wifi = { power: !poweredDown, connected, rssi: connected ? rssi : 0 };
  }

  let battery: LauncherStatusBattery | null = null;
  const batteryMatch = /^\s*(\d+)\s*,\s*(\d+)\s*$/m.exec(batteryText);
  if (batteryMatch) {
    const percent = Math.max(0, Math.min(100, Number(batteryMatch[1])));
    const status = Number(batteryMatch[2]);
    // Win32_Battery.BatteryStatus：1=放电（用电池），2=接电源未在充，3=已充满，6–9=充电中。
    battery = { percent, charging: status >= 6 && status <= 9, ac: status >= 2 && status <= 11 };
  }

  return { ime: null, wifi, battery, native: false };
}

function collectViaShell(): Promise<LauncherSystemStatus> {
  return process.platform === "win32" ? collectViaWindowsShell() : collectViaMacShell();
}

/** 退化轮询间隔：Windows 每次要起 PowerShell 进程，比 macOS 的原生命令重，放宽到 5s。 */
const FALLBACK_INTERVAL_MS = process.platform === "win32" ? 5000 : 3000;

/**
 * 起一个长驻采集器，状态变化时回调。返回停止函数（进程会被杀掉）。
 * 采集器异常退出会自动重启（最多每 5s 一次），避免切几次输入法就把状态栏弄死。
 */
export function startSystemStatusWatch(onStatus: (status: LauncherSystemStatus) => void): () => void {
  let stopped = false;
  let child: ReturnType<typeof spawn> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  let lastPayload = "";

  const emit = (status: LauncherSystemStatus) => {
    const payload = JSON.stringify(status);
    if (payload === lastPayload) return;
    lastPayload = payload;
    current = status;
    if (!stopped) onStatus(status);
  };

  const startShellFallback = () => {
    if (stopped || fallbackTimer) return;
    console.warn(process.platform === "win32"
      ? "[status-bar] Windows 无原生采集器，走 netsh/PowerShell 命令行采集"
      : "[status-bar] 未找到 statusctl，退回命令行采集（无信号强度/输入法名称）");
    const tick = () => void collectViaShell().then(emit).catch(() => undefined);
    tick();
    fallbackTimer = setInterval(tick, FALLBACK_INTERVAL_MS);
  };

  const startNative = (binary: string) => {
    if (stopped) return;
    const proc = spawn(binary, ["--watch"], { stdio: ["ignore", "pipe", "ignore"] });
    child = proc;
    let buffer = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            emit(normalize(JSON.parse(line) as RawStatus, true));
          } catch {
            // 单行解析失败不影响后续
          }
        }
        index = buffer.indexOf("\n");
      }
    });
    proc.on("error", () => {
      child = null;
      if (stopped) return;
      // 起不来（权限/架构不匹配）就走退化路径，不要再重启。
      startShellFallback();
    });
    proc.on("exit", () => {
      child = null;
      if (stopped || fallbackTimer) return;
      restartTimer = setTimeout(() => startNative(binary), 5000);
    });
  };

  // statusctl 只有 macOS 实现；其他平台直接走各自的命令行路径。
  const binary = process.platform === "darwin" ? helperBinary() : null;
  if (binary) startNative(binary);
  else startShellFallback();

  return () => {
    stopped = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (fallbackTimer) clearInterval(fallbackTimer);
    if (child) {
      child.kill();
      child = null;
    }
  };
}

export type { LauncherSystemStatus };
