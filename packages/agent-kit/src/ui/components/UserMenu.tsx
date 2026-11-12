"use client";

import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { DownloadIcon, LogoutIcon } from "../icons/ActionIcons.tsx";
import CustomModels, { desktopModels } from "./CustomModels.tsx";
import type { AgentWindowProps, ChatUserRole } from "../AgentWindow.tsx";
import type { ThemeMode } from "../shared/theme.ts";
import { avatarFallbackClass, avatarInitials } from "../shared/avatar.ts";
import agentKitPackage from "../../../package.json" with { type: "json" };
import { DesktopUpdateControl, useDesktopAppVersion } from "./DesktopUpdateControl.tsx";
import { playNotificationSound, readNotificationSound, writeNotificationSound, type NotificationSound } from "../shared/notificationSound.ts";
import { isDesktopApp, showNotification } from "../chat/platform.ts";
import { voiceHoldKeyLabel, voiceHoldKeyAriaLabel } from "../shared/platform.ts";

// 客户端平台检测（与下载页一致）：仅返回 OTA 支持的平台 win32 / darwin
function detectClientPlatform() {
  if (typeof navigator === "undefined") return null;
  const p = navigator.platform || "";
  const ua = navigator.userAgent || "";
  if (/Win/i.test(p) || /Windows/i.test(ua)) return "win32";
  if (/Mac/i.test(p) || /Macintosh|Mac OS X/i.test(ua)) return "darwin";
  return null;
}

export interface UserMenuProps {
  /** 应用部署基础路径（如 /agent），用于拼接下载页等站内路由，避免 404 */
  basePath?: string;
  compact?: boolean;
  expanded?: boolean;
  userOpen: boolean;
  setUserOpen: Dispatch<SetStateAction<boolean>>;
  initialUser: AgentWindowProps["initialUser"];
  /** 用户角色列表（宿主应用传入）：profile 区展示，多角色省略 + “更多”弹窗查看全部 */
  roles?: readonly ChatUserRole[];
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  showContextUsage: boolean;
  setShowContextUsage: Dispatch<SetStateAction<boolean>>;
  modelSelectionEnabled: boolean;
  showModel: boolean;
  setShowModel: (value: boolean) => void;
  multiFramework: boolean;
  multiFrameworkAvailable: boolean;
  setMultiFramework: Dispatch<SetStateAction<boolean>>;
  rightCtrlVoice: boolean;
  setRightCtrlVoice: (value: boolean) => void;
  logout: () => void;
  onOpenMemory: () => void;
}

export default function UserMenu({ basePath = "", compact = false, expanded = false, userOpen, setUserOpen, initialUser, roles, theme, setTheme,
  showContextUsage, setShowContextUsage, modelSelectionEnabled, showModel, setShowModel,
  multiFramework, multiFrameworkAvailable, setMultiFramework, rightCtrlVoice, setRightCtrlVoice, logout, onOpenMemory }: UserMenuProps) {
  const name = initialUser?.name || "我";
  const desktopVersion = useDesktopAppVersion();
  const isDesktop = isDesktopApp();
  const hasLocalModels = Boolean(desktopModels());
  const [customModelsOpen, setCustomModelsOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [customModelCount, setCustomModelCount] = useState(0);
  const [notificationSound, setNotificationSound] = useState<NotificationSound>(readNotificationSound);
  // 角色列表：顺着名字往右排，能放几个显示几个；放不下时递减，只留“更多”按钮收纳剩余角色。
  // 名字永远优先完整显示，角色区不参与挤压。
  const [rolesOpen, setRolesOpen] = useState(false);
  const profileNameRef = useRef<HTMLSpanElement | null>(null);
  const profileInfoRef = useRef<HTMLSpanElement | null>(null);
  const [visibleRoles, setVisibleRoles] = useState(() => roles?.length ?? 0);
  useLayoutEffect(() => {
    if (!userOpen) return;
    const name = profileNameRef.current;
    const info = profileInfoRef.current;
    if (!name || !info) return;
    const check = () => {
      // 名字被省略 = 横向放不下 → 减少一个角色胶囊，直到能放下（最少 0 个，只剩“更多”入口）
      if (name.scrollWidth > name.clientWidth + 1) {
        setVisibleRoles((count) => (count > 0 ? count - 1 : 0));
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(info);
    return () => ro.disconnect();
  }, [roles, name, userOpen, visibleRoles]);
  useEffect(() => {
    const sync = (event: StorageEvent) => { if (event.key === "agent-kit:notification-sound") setNotificationSound(readNotificationSound()); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  // 当前系统是否有可下载的客户端：菜单打开时向 OTA 询问该平台最新发布，
  // 无（或平台不受支持，如 Linux）则整条入口隐藏。
  const [canDownload, setCanDownload] = useState(false);
  useEffect(() => {
    if (!userOpen || isDesktop) return;
    const platform = detectClientPlatform();
    if (!platform) { setCanDownload(false); return; }
    let cancelled = false;
    fetch(`${basePath}/api/updates?platform=${platform}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const has = Boolean(data && (data.version || (data.release && data.release.version)));
        setCanDownload(has);
      })
      .catch(() => { if (!cancelled) setCanDownload(false); });
    return () => { cancelled = true; };
  }, [userOpen, isDesktop, basePath]);
  useEffect(() => { void desktopModels()?.list().then((result) => setCustomModelCount(result.models.length)).catch(() => {}); }, [userOpen]);
  const selfInitials = avatarInitials(name);
  const avatar = initialUser?.avatar
    ? <img className="chat-user-avatar" src={initialUser.avatar} alt="" />
    : <span className={`chat-user-avatar chat-user-avatar--fallback ${avatarFallbackClass(selfInitials)}`} aria-hidden="true">{selfInitials}</span>;
  const requestLogout = () => { setUserOpen(false); setConfirmLogout(true); };

  return <><div className={`chat-sidebar-user${compact ? " agent-navigation-user" : ""}${compact && expanded ? " is-expanded" : ""}`}>
    {customModelsOpen && <CustomModels onClose={() => setCustomModelsOpen(false)} onCount={setCustomModelCount} />}
    <button type="button" className="chat-sidebar-user-trigger" onClick={() => setUserOpen((open) => !open)}
      aria-expanded={userOpen} aria-label="用户设置" title="用户设置">
      <div className="chat-sidebar-user-row">
        {avatar}
        {!compact ? <span className="chat-sidebar-user-name">{name}</span> : null}
      </div>
      {compact ? <>
        <span className="agent-navigation-user-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="3.5" />
            <path d="M5 20v-1.5a7 7 0 0 1 14 0V20" />
          </svg>
        </span>
        <span className="agent-navigation-user-label" aria-hidden="true">我</span>
      </> : null}
    </button>
    {compact && expanded ? <span className="agent-navigation-user-name" onClick={() => setUserOpen((open) => !open)}>{name}</span> : null}
    {compact && expanded ? <button type="button" className="agent-navigation-logout" onClick={requestLogout}
      aria-label="退出登录" title="退出登录">
      <LogoutIcon />
    </button> : null}
    {userOpen ? <div className="chat-user-menu" role="menu">
      <div className="chat-user-menu-profile">
        {avatar}
        <span ref={profileInfoRef} className="chat-user-menu-profile-info"><span className="chat-user-menu-profile-name-row"><span ref={profileNameRef} className="chat-user-menu-profile-name">{name}</span>
          {roles?.length ? <span className="chat-user-menu-profile-roles">
            {roles.slice(0, visibleRoles).map((role) => <span key={role.id} className="chat-user-menu-role">{role.label}</span>)}
            {visibleRoles < roles.length ? <button type="button" className="chat-user-menu-role-more" onClick={() => setRolesOpen(true)}>更多</button> : null}
          </span> : null}
        </span>
          {(initialUser?.provider === "feishu" || initialUser?.provider === "dingtalk") && <span className="chat-user-menu-profile-meta">{initialUser.provider === "feishu" ? "飞书" : "钉钉"}{initialUser.organizationName ? ` · ${initialUser.organizationName}` : ""}{initialUser.department ? ` · ${initialUser.department}` : ""}</span>}
        </span>
      </div>
      <div className="chat-user-menu-sep" />
      <div className="chat-user-menu-row">
        <span className="chat-user-menu-label">外观</span>
        <span className="chat-user-menu-segment" role="radiogroup" aria-label="外观">
          {(["system", "light", "dark"] as const).map((mode, index) => <button key={mode} type="button" role="radio"
            aria-checked={theme === mode} className={`chat-user-menu-seg${theme === mode ? " is-on" : ""}`}
            onClick={() => setTheme(mode)}>{["系统", "浅色", "深色"][index]}</button>)}
        </span>
      </div>
      <div className="chat-user-menu-row">
        <label className="chat-user-menu-label" htmlFor="chat-notification-sound">通知提示音</label>
        <select id="chat-notification-sound" className="chat-user-menu-select" value={notificationSound}
          onChange={(event) => {
            const value = event.target.value as NotificationSound;
            setNotificationSound(value);
            writeNotificationSound(value, basePath);
            if (value === "system") showNotification("提示音试听", "系统通知提示音", `agent-sound-preview-${Date.now()}`, undefined, basePath);
            else if (value !== "off") playNotificationSound(basePath, `agent-sound-preview-${Date.now()}`);
          }}>
          <option value="off">关闭</option>
          <option value="bright">晴空</option>
          <option value="calm">静水</option>
          <option value="playful">雀跃</option>
          <option value="system">系统</option>
        </select>
      </div>
      <div className="chat-user-menu-row chat-user-menu-context-row">
        <span className="chat-user-menu-label">显示上下文使用量</span>
        <button type="button" role="switch" aria-checked={showContextUsage} aria-label="显示上下文使用量"
          className={`chat-user-menu-switch${showContextUsage ? " is-on" : ""}`}
          onClick={() => setShowContextUsage((value) => !value)}>
          <span className="chat-user-menu-switch-knob" aria-hidden="true" />
        </button>
      </div>
      {modelSelectionEnabled ? <div className="chat-user-menu-row">
        <span className="chat-user-menu-label">显示模型</span>
        <button type="button" role="switch" aria-checked={showModel} aria-label="显示模型"
          className={`chat-user-menu-switch${showModel ? " is-on" : ""}`} onClick={() => setShowModel(!showModel)}>
          <span className="chat-user-menu-switch-knob" aria-hidden="true" />
        </button>
      </div> : null}
      {multiFrameworkAvailable ? <div className="chat-user-menu-row">
        <span className="chat-user-menu-label">多框架</span>
        <button type="button" role="switch" aria-checked={multiFramework} aria-label="多框架"
          className={`chat-user-menu-switch${multiFramework ? " is-on" : ""}`}
          onClick={() => setMultiFramework((value) => !value)}>
          <span className="chat-user-menu-switch-knob" aria-hidden="true" />
        </button>
      </div> : null}
      <div className="chat-user-menu-row">
        <span className="chat-user-menu-label">按住{voiceHoldKeyLabel()}启动语音</span>
        <button type="button" role="switch" aria-checked={rightCtrlVoice} aria-label={`按住${voiceHoldKeyAriaLabel()}启动语音`}
          className={`chat-user-menu-switch${rightCtrlVoice ? " is-on" : ""}`}
          onClick={() => setRightCtrlVoice(!rightCtrlVoice)}>
          <span className="chat-user-menu-switch-knob" aria-hidden="true" />
        </button>
      </div>
      {hasLocalModels ? <button type="button" className="chat-user-menu-row chat-user-menu-action" onClick={() => { setUserOpen(false); setCustomModelsOpen(true); }}>
        <span className="chat-user-menu-label">自定义模型</span><span className="chat-user-menu-count">{customModelCount}</span>
      </button> : null}
      <button type="button" className="chat-user-menu-row chat-user-menu-action" onClick={onOpenMemory}>
        <span className="chat-user-menu-label">记忆管理</span>
      </button>
      <div className="chat-user-menu-row">
        {isDesktop
          ? <span className="desktop-update-version"><span className="chat-user-menu-label">版本</span><span className="chat-user-menu-version">{desktopVersion ?? "…"}</span></span>
          : <><span className="chat-user-menu-label">版本</span><span className="chat-user-menu-version">{agentKitPackage.version}</span></>}
        <DesktopUpdateControl menu />
      </div>
      {!isDesktop && canDownload ? <a href={`${basePath}/download`} target="_blank" rel="noopener noreferrer" className="chat-user-menu-item chat-user-menu-link">
        <span>下载客户端</span>
        <DownloadIcon className="chat-user-menu-link-icon" />
      </a> : null}
      <div className="chat-user-menu-sep chat-user-menu-logout-sep" />
      <button type="button" className="chat-user-menu-item chat-user-menu-item--danger chat-user-menu-logout" onClick={requestLogout}>退出登录</button>
    </div> : null}
  </div>
    {confirmLogout ? createPortal(<div className="chat-modal-backdrop" onClick={() => setConfirmLogout(false)}>
      <div className="chat-modal" role="dialog" aria-modal="true" aria-label="确认退出登录"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") setConfirmLogout(false); }}>
        <h3 className="chat-modal-title">退出登录？</h3>
        <p className="chat-modal-desc">确定要退出当前账号吗？</p>
        <div className="chat-modal-actions">
          <button type="button" className="chat-modal-btn" autoFocus onClick={() => setConfirmLogout(false)}>取消</button>
          <button type="button" className="chat-modal-btn chat-modal-btn--danger" onClick={() => { setConfirmLogout(false); logout(); }}>退出登录</button>
        </div>
      </div>
    </div>, document.body) : null}
    {rolesOpen && roles?.length ? createPortal(<div className="chat-modal-backdrop" onClick={() => setRolesOpen(false)}>
      <div className="chat-modal" role="dialog" aria-modal="true" aria-label="我的角色"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") setRolesOpen(false); }}>
        <h3 className="chat-modal-title">我的角色</h3>
        <ul className="chat-user-roles-popup">
          {roles.map((role) => <li key={role.id} className="chat-user-roles-popup-item">{role.label}</li>)}
        </ul>
        <div className="chat-modal-actions">
          <button type="button" className="chat-modal-btn" autoFocus onClick={() => setRolesOpen(false)}>关闭</button>
        </div>
      </div>
    </div>, document.body) : null}
  </>;
}
