import { useCallback, useEffect, useRef, useState } from "react";
import { LogoutIcon, SettingsIcon, UserIcon } from "@turingflow/agent-kit/ui";
import { useLauncher, homeChatWindows } from "../state";
import { AboutGlyph, TrashGlyph } from "../icons";
import { clearSavedWindowGeometry } from "./WindowFrame";
import { fileToAvatarDataUrl } from "./avatarImage";

export default function AppearanceMenu({ onAction, onCloseHomeWindows }: { onAction?: () => void; onCloseHomeWindows?: () => void } = {}) {
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const [signedInUser, setSignedInUser] = useState<Awaited<ReturnType<typeof window.launcher.getWebSession>>>(null);
  const [loginError, setLoginError] = useState("");
  /** 登录窗已打开、还没登进来：面板不关，用一行状态代替「消失」。 */
  const [awaitingLogin, setAwaitingLogin] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutDialog = useRef<HTMLDialogElement>(null);
  /** 删除账号：危险操作，需要输入确认词「删除账号」才可执行。 */
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteDialog = useRef<HTMLDialogElement>(null);
  /** 个人资料编辑：点头像换图、点名字改名（user_code 只读，见 userCode 那行）。 */
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [profileBusy, setProfileBusy] = useState<"" | "avatar" | "name">("");
  const [profileError, setProfileError] = useState("");
  const avatarInput = useRef<HTMLInputElement>(null);
  // OTA 更新状态
  const [appVersion, setAppVersion] = useState("");
  const [updateRelease, setUpdateRelease] = useState<{ version: string; size: number } | null>(null);
  const [updateDl, setUpdateDl] = useState<{ phase: string; downloaded: number; total: number }>({ phase: "idle", downloaded: 0, total: 0 });
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState("");
  /** Esc 取消改名时不提交：blur 是唯一的提交入口，用它标记「这次 blur 是取消」。 */
  const cancelNameEdit = useRef(false);
  const refreshUser = useCallback(() => { void window.launcher.getWebSession().then(user => {
    setSignedInUser(user);
    // 登录窗一关（无论登没登进来）主进程都会发 web-session-changed，状态行随之收起；
    // 登进来了这里同时把账号名换成新用户，面板不用关也能看到结果。
    setAwaitingLogin(false);
  }).catch(() => setSignedInUser(null)); }, []);
  useEffect(() => {
    refreshUser();
    return window.launcher.onWebSessionChanged(refreshUser);
  }, [refreshUser]);

  // OTA 更新：初始化状态 + 订阅事件
  useEffect(() => {
    let alive = true;
    void window.launcher.getAppInfo().then((info) => { if (alive) setAppVersion(info.version); }).catch(() => undefined);
    void window.launcher.updater.status().then((s) => {
      if (!alive) return;
      setUpdateRelease(s.release);
      setUpdateDl(s.download);
    }).catch(() => undefined);
    const offAvail = window.launcher.updater.onAvailable((r) => {
      if (!alive) return;
      setUpdateRelease(r);
    });
    const offDl = window.launcher.updater.onDownloadState((s) => {
      if (!alive) return;
      setUpdateDl(s);
    });
    return () => { alive = false; offAvail(); offDl(); };
  }, []);

  async function handleCheckUpdate() {
    setUpdateChecking(true);
    setUpdateMsg("");
    try {
      const s = await window.launcher.updater.check();
      setUpdateRelease(s.release);
      setUpdateDl(s.download);
      // 必须给出可见反馈：之前只在「无更新」时写一句提示，
      // 真查到新版本时界面毫无变化，看起来就是点了没反应。
      setUpdateMsg(s.release ? `发现新版本 ${s.release.version}` : "已经是最新版本");
    } catch (e) {
      setUpdateMsg(`检查失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdateChecking(false);
    }
  }

  async function handleInstallUpdate() {
    setUpdateMsg("正在安装并重启…");
    try {
      const result = await window.launcher.updater.install();
      if (!result.ok) setUpdateMsg(`安装失败：${result.error || "未知错误"}`);
    } catch (e) {
      setUpdateMsg(`安装失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  async function goToLogin() {
    if (signedInUser) return;
    // 把当前外观（state.tsx 已解析进 <html data-theme>）带给登录窗口，
    // 否则登录页只能跟随系统深浅色，与 Launcher 外观不一致时整窗反色。
    const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const result = await window.launcher.openLogin(theme);
    if (!result.ok) { setLoginError(result.error || "无法打开登录窗口"); return; }
    // 面板保持打开：登录窗关掉后 web-session-changed 会刷新这里，用户当场就能看到结果。
    // （早先这里会 onAction?.() 把面板收掉，登录完只剩空桌面，没有任何反馈。）
    setLoginError("");
    setAwaitingLogin(true);
  }
  async function confirmLogout() {
    if (logoutBusy) return;
    setLogoutBusy(true);
    setLogoutError("");
    try {
      const result = await window.launcher.logoutWebSession();
      if (!result.ok) { setLogoutError(result.error || "退出登录失败"); return; }
      try { window.localStorage.removeItem("agent-kit:desktop-user"); } catch { /* storage unavailable */ }
      logoutDialog.current?.close();
      setSignedInUser(null);
      refreshUser();
    } catch {
      setLogoutError("退出登录失败，请稍后重试");
    } finally { setLogoutBusy(false); }
  }
  /** 彻底删除账号：输入确认词「删除账号」才放行；成功后本机登录态与本地聊天一并清除。 */
  async function confirmDeleteAccount() {
    if (deleteBusy) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      const result = await window.launcher.deleteWebSession();
      if (!result.ok) { setDeleteError(result.error || "删除账号失败"); return; }
      try { window.localStorage.removeItem("agent-kit:desktop-user"); } catch { /* storage unavailable */ }
      deleteDialog.current?.close();
      setSignedInUser(null);
      refreshUser();
    } catch {
      setDeleteError("删除账号失败，请稍后重试");
    } finally { setDeleteBusy(false); }
  }
  /**
   * 保存个人资料（名字 / 头像）。成功后就地更新展示值：主进程保存完也会发
   * web-session-changed 再刷一次，但面板不关，等那一次刷新会让用户看到旧值闪一下。
   */
  async function saveProfile(patch: { name?: string; avatar?: string }, kind: "avatar" | "name"): Promise<boolean> {
    setProfileBusy(kind);
    setProfileError("");
    try {
      const result = await window.launcher.updateProfile(patch);
      if (!result.ok) {
        setProfileError(result.error || "保存失败，请重试");
        return false;
      }
      const user = result.user;
      setSignedInUser(prev => prev ? {
        ...prev,
        name: user?.name || prev.name,
        avatar: user?.avatar || prev.avatar,
        userCode: user?.userCode ?? prev.userCode,
      } : prev);
      return true;
    } catch {
      setProfileError("保存失败，请稍后重试");
      return false;
    } finally {
      setProfileBusy("");
    }
  }

  /** 点头像：选一张本地图片 → 居中裁方 + 缩到 128px → 存成 data URL。 */
  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    try {
      const avatar = await fileToAvatarDataUrl(file);
      await saveProfile({ avatar }, "avatar");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "无法读取这张图片，换一张试试");
    }
  }

  function startEditName() {
    if (profileBusy) return;
    setNameDraft(signedInUser?.name ?? "");
    setProfileError("");
    setEditingName(true);
  }

  async function commitName() {
    setEditingName(false);
    const next = nameDraft.trim();
    if (!next) {
      setProfileError("名字不能为空");
      setNameDraft(signedInUser?.name ?? "");
      return;
    }
    if (next === signedInUser?.name) return;
    await saveProfile({ name: next }, "name");
  }

  /** 当前存在的 home chat 窗口（主窗口 + 「新建窗口」实例；open 与 minimized 互斥，不会重复）。 */
  const homeChatWindowIds = homeChatWindows(state.openWindows, state.minimizedWindows).all;

  return (
    <section className="appearance-menu" role="dialog" aria-label="Launcher 设置">
      {/* 顶部用户区：未登录时整个按钮就是「去登录」；登录后头像可换图、名字可改名，
          user_code 只读展示。整块不放 title（tooltip），悬停反馈靠底色/遮罩本身表达。 */}
      <div className="appearance-user-row">
        {signedInUser ? (
          <>
            <button type="button" className="appearance-avatar-button" aria-label="更换头像"
              disabled={profileBusy === "avatar"} onClick={() => avatarInput.current?.click()}>
              {signedInUser.avatar
                ? <img className="appearance-user-avatar" src={signedInUser.avatar} alt="" />
                : <span className="appearance-user-avatar appearance-user-avatar--placeholder"><UserIcon /></span>}
              {/* 悬停只做轻微压暗的反馈，不叠文字；「上传中」是唯一需要遮罩的状态提示。 */}
              {profileBusy === "avatar" && <span className="appearance-avatar-mask" aria-hidden="true">上传中</span>}
            </button>
            {/* 隐藏的文件选择框：点上面的头像把它唤起，选完即清空 value，方便再次选同一张图。 */}
            <input ref={avatarInput} className="appearance-avatar-input" type="file" accept="image/*" tabIndex={-1}
              onChange={(event) => { void pickAvatar(event.target.files?.[0]); event.target.value = ""; }} />
            <div className="appearance-user-info">
              {editingName ? (
                <input className="appearance-name-input" value={nameDraft} maxLength={24}
                  aria-label="修改名字" autoFocus
                  onChange={(event) => setNameDraft(event.target.value)}
                  onBlur={() => {
                    if (cancelNameEdit.current) { cancelNameEdit.current = false; setEditingName(false); return; }
                    void commitName();
                  }}
                  onKeyDown={(event) => {
                    // 面板里有全局快捷键，编辑输入框时不要再让它吃到按键。
                    event.stopPropagation();
                    if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
                    else if (event.key === "Escape") { event.preventDefault(); cancelNameEdit.current = true; event.currentTarget.blur(); }
                  }} />
              ) : (
                <button type="button" className="appearance-user-name" aria-label="修改名字"
                  disabled={profileBusy === "name"} onClick={startEditName}>{signedInUser.name}</button>
              )}
              {/* user_code 是身份主数据，只读展示，不在可编辑范围内。 */}
              {signedInUser.userCode && <span className="appearance-user-code">{signedInUser.userCode}</span>}
            </div>
            <button type="button" className="appearance-logout" aria-label="登出"
              onClick={() => { setLogoutError(""); logoutDialog.current?.showModal(); }}><LogoutIcon /></button>
            <button type="button" className="appearance-delete" aria-label="删除账号"
              onClick={() => { setDeleteError(""); deleteDialog.current?.showModal(); }}><TrashGlyph size={16} /></button>
          </>
        ) : (
          <button type="button" className="appearance-user" onClick={goToLogin} aria-label="去登录">
            <span className="appearance-user-avatar appearance-user-avatar--placeholder"><UserIcon /></span>
            <span className="appearance-user-meta">点击登录</span>
          </button>
        )}
      </div>
      {profileError && <div className="appearance-user-error" role="alert">{profileError}</div>}
      {awaitingLogin && !signedInUser && (
        <div className="appearance-login-hint" role="status">登录窗口已打开，完成后这里会自动更新</div>
      )}
      <dialog ref={logoutDialog} className="appearance-logout-dialog" aria-labelledby="appearance-logout-title" onKeyDown={event => event.stopPropagation()}>
        <h2 id="appearance-logout-title">确认登出？</h2>
        <p>登出后需要重新登录才能使用当前账号。</p>
        {logoutError && <div className="appearance-user-error" role="alert">{logoutError}</div>}
        <div className="appearance-logout-actions">
          <button type="button" className="secondary" disabled={logoutBusy} onClick={() => logoutDialog.current?.close()}>取消</button>
          <button type="button" className="primary" disabled={logoutBusy} onClick={() => void confirmLogout()}>{logoutBusy ? "登出中…" : "确认登出"}</button>
        </div>
      </dialog>
      <dialog ref={deleteDialog} className="appearance-delete-dialog" aria-labelledby="appearance-delete-title"
        onKeyDown={(event) => event.stopPropagation()}>
        <h2 id="appearance-delete-title">删除账号</h2>
        <p className="appearance-delete-warning">
          即将<strong>永久删除</strong>当前账号，且<strong>无法恢复</strong>：账号数据、云端会话与文件、本机聊天记录将全部清除。
        </p>
        {deleteError && <div className="appearance-user-error" role="alert">{deleteError}</div>}
        <div className="appearance-logout-actions">
          <button type="button" className="secondary" disabled={deleteBusy} onClick={() => deleteDialog.current?.close()}>取消</button>
          <button type="button" className="danger" disabled={deleteBusy}
            onClick={() => void confirmDeleteAccount()}>{deleteBusy ? "删除中…" : "永久删除"}</button>
        </div>
      </dialog>
      {loginError && <div className="appearance-user-error" role="alert">{loginError}</div>}
      {/* 系统设置 / 关于：快捷面板只放**入口**（保持轻量），设置项与版本信息各自开一扇
          真窗口（见 desktop/SettingsWindow.tsx、desktop/AboutWindow.tsx）。
          点完先把本面板收起（onAction），窗口由桌面层统一渲染。 */}
      <div className="appearance-action-list" role="group" aria-label="更多">
        <button type="button" className="appearance-action-item" onClick={() => {
          dispatch({ type: "OPEN_DOMAIN_FOCUS_CHAT", domainId: "settings" });
          onAction?.();
        }}>
          <SettingsIcon width={16} height={16} />
          <span>系统设置</span>
        </button>
        {/* 关于行：左侧「关于 + 版本号」作为一个整体，点击进关于窗口；
            右侧是检查更新按钮，右对齐。 */}
        <div className="appearance-action-item appearance-about-row">
          <button type="button" className="appearance-about-link" onClick={() => {
            dispatch({ type: "SET_ABOUT_WINDOW", open: true });
            onAction?.();
          }}>
            <AboutGlyph size={16} />
            <span>关于</span>
            <span className="appearance-update-version">版本 {appVersion || "—"}</span>
          </button>
          {updateDl.phase === "downloading" ? (
            <button type="button" className="appearance-update-btn" disabled>
              {Math.round((updateDl.downloaded / Math.max(updateDl.total, 1)) * 100)}%
            </button>
          ) : updateRelease ? (
            <button type="button" className="appearance-update-btn appearance-update-btn-primary" onClick={() => void handleInstallUpdate()}>
              重启升级
            </button>
          ) : updateChecking ? (
            <button type="button" className="appearance-update-btn" disabled>
              检查中…
            </button>
          ) : (
            <button type="button" className="appearance-update-btn" onClick={() => void handleCheckUpdate()}>
              检查更新
            </button>
          )}
        </div>
        {/* 检查/安装结果的可见反馈：按钮文案保持稳定，结果单独一行显示。 */}
        {updateMsg && (
          <div className={`appearance-update-msg${updateMsg.startsWith("检查失败") || updateMsg.startsWith("安装失败") ? " is-error" : ""}`}>
            {updateMsg}
          </div>
        )}
      </div>
      {/* Home 窗口操作：与上面的设置用分隔线隔开（.appearance-action-list 自带 border-top）。
          新建窗口一直可用；关闭窗口只在存在 home chat 窗口时出现，多于一个时变为「关闭全部」。
          关闭就是**真关闭**（卸载实例、下次打开是全新窗口）：最小化已经从「空闲即关闭」
          改成了「收起并记住状态」，菜单里再写「关闭」却只是收起就名不副实了。 */}
      <div className="appearance-action-list" role="group" aria-label="Home 窗口">
        <button type="button" className="appearance-action-item" onClick={() => {
          // 一个 home chat 窗口都没有时，「新建窗口」就是左键点 Home：直接开主窗口
          // （水平居中），而不是开一扇被级联偏移推到右边的 primary-2 副窗。
          if (homeChatWindowIds.length === 0) dispatch({ type: "OPEN_FOCUS_CHAT" });
          else dispatch({ type: "OPEN_NEW_HOME_CHAT" });
          onAction?.();
        }}>新建窗口</button>
        {homeChatWindowIds.length > 0 && (
          <button type="button" className="appearance-action-item" onClick={() => {
            onCloseHomeWindows?.();
            for (const id of homeChatWindowIds) {
              // 关闭 = 不记状态：连窗口位置一起忘掉，下次打开回到默认几何。
              clearSavedWindowGeometry(id);
              dispatch({ type: "CLOSE_CHAT", windowId: id });
            }
            onAction?.();
          }}>{homeChatWindowIds.length > 1 ? "关闭全部" : "关闭窗口"}</button>
        )}
      </div>
    </section>
  );
}
