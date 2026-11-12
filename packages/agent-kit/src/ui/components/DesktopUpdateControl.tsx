"use client";

import { useEffect, useState } from "react";
import { DownloadIcon } from "../icons/ActionIcons.tsx";
import { ProgressRingIcon } from "../icons/DynamicIcons.tsx";

type Release = { version: string } | null;
type DownloadState = { phase: "idle" | "downloading" | "ready" | "error"; downloaded: number; total: number; error?: string };
type Bridge = { updater?: {
  status(): Promise<{ version: string; release: Release; download: DownloadState }>;
  check(): Promise<{ version: string; release: Release; download: DownloadState }>;
  install(): Promise<{ ok: boolean; error?: string }>;
  onAvailable(listener: (release: Release) => void): () => void;
  onDownloadState(listener: (state: DownloadState) => void): () => void;
} };
const bridge = () => (window as Window & { agentHost?: Bridge }).agentHost?.updater;
const showProgressEvent = "agent:update-show-progress";

export function useDesktopAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void bridge()?.status().then((value) => { if (active) setVersion(value.version); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return version;
}

export function DesktopUpdateControl({ compact = false, menu = false }: { compact?: boolean; menu?: boolean }) {
  const [release, setRelease] = useState<Release>(null);
  const [busy, setBusy] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [message, setMessage] = useState("");
  const [download, setDownload] = useState<DownloadState>({ phase: "idle", downloaded: 0, total: 0 });
  useEffect(() => {
    const updater = bridge();
    if (!updater) return;
    let active = true;
    void updater.status().then((value) => { if (active) { setRelease(value.release); setDownload(value.download); } }).catch(() => {});
    const unsubscribe = updater.onAvailable((value) => { if (active) { setRelease(value); setShowProgress(false); } });
    const unsubscribeDownload = updater.onDownloadState((value) => { if (active) setDownload(value); });
    const revealProgress = () => setShowProgress(true);
    window.addEventListener(showProgressEvent, revealProgress);
    return () => { active = false; unsubscribe(); unsubscribeDownload(); window.removeEventListener(showProgressEvent, revealProgress); };
  }, []);
  if (typeof window === "undefined" || !bridge()) return null;
  async function check() {
    setBusy(true);
    if (menu) setMessage("检查中…");
    try {
      const result = await bridge()!.check();
      setRelease(result.release);
      setDownload(result.download);
      const reveal = Boolean(result.release && result.download.phase !== "ready");
      setShowProgress(reveal);
      if (reveal) window.dispatchEvent(new Event(showProgressEvent));
      // 主按钮场景：下载进度由按钮进度圈表达、就绪由按钮文案表达，不弹文字提示；
      // 菜单场景无进度可视化，保留“发现/就绪”提示；已是最新与错误仍给反馈。
      if (!result.release) setMessage("已经是最新版本");
      else if (menu) setMessage(result.download.phase === "ready"
        ? `新版本 ${result.release.version} 已就绪，点击侧栏按钮安装`
        : `发现新版本 ${result.release.version}，正在后台下载`);
      else setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function install() {
    // 安装过程不转圈、不弹提示（点击后应用随即退出重启），避免干扰使用；失败仍给出错误反馈
    try {
      const result = await bridge()!.install();
      if (!result.ok) setMessage(result.error || "更新失败，请重试");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新失败，请重试");
    }
  }
  if (menu) return <>
    <button type="button" className="chat-user-menu-action desktop-update-check" disabled={busy} onClick={check}>检查更新</button>
    {message ? <span role="status" className="desktop-update-message">{message}</span> : null}
  </>;
  const downloading = showProgress && download.phase === "downloading";
  const percent = downloading && download.total > 0 ? Math.min(100, Math.round(download.downloaded / download.total * 100)) : null;
  // 下载中：按钮显示下载进度，不可点击；下载完成（ready）：按钮变为“安装更新 v”，点击即安装并自动重启
  const label = downloading ? (percent === null ? "正在下载更新" : `正在下载更新 ${percent}%`) :
    download.phase === "ready" ? `安装更新 ${release?.version}` : `更新可用 ${release?.version}`;
  return release ? <><button type="button" disabled={busy || downloading} className={`desktop-update-button${compact ? " is-compact" : ""}`}
    onClick={install} title={label} aria-label={label}>
    {busy ? <ProgressRingIcon percent={null} /> : downloading ? <ProgressRingIcon percent={percent} /> : <DownloadIcon />}
    {!compact ? <span>{label}</span> : null}
  </button>{compact && message ? <span className="desktop-update-toast" role="status">{message}</span> : null}</> : null;
}
