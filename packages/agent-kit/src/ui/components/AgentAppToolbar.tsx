"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import { useChatSession } from "../chatSession.tsx";
import SessionErrorIndicator from "./SessionErrorIndicator.tsx";
import { MoreIcon, AddUserIcon } from "../icons/SharedIcons.tsx";
import { ModelSelectGlyph01, ChatPanelGlyph01, ChatPanelGlyph02, ChatPanelGlyph04, ChatPanelGlyph06, ChatPanelGlyph08 } from "../icons/PageIcons.tsx";

export function AgentAppToolbar() {
  const t = useChatTranslation();
  const {
    conversationView, selectNavigation, toggleSidebar, openSidebarHover, closeSidebarHover,
    sidebarOpen, setSidebarOpen, isEmptyView, contentLoading, logoSrc, currentSessionTitle,
    currentSessionError, serverOnline, connDetail, retryConnection, retrying,
    isMobileViewport, embeddedMode, multiFramework, agentModes, busy, compareBusy,
    split, setAgentMode, setCompareOnly, setCompareSubmission, saveViewLayout, setSplit,
    hasNavigation, isLoggedIn, activeNavigation, openInvite, embedded, shareButtonRef,
    shareOpen, openShare, moreButtonRef, moreOpen, setMoreOpen, moreMenuRef,
    mobileFrameworkName, mobileModelChoices, currentMobileModelName, compareFrameworkName,
    compareModelChoices, currentCompareModelName, setMobilePicker, openMobileWorkPage,
    rightShown, setRightOpen, setDiffView, setInputFilePreview,
  } = useChatSession();
  return (
    <header className="chat-topbar">
          <div className="chat-topbar-left">
            {!embeddedMode && conversationView ? <button type="button" className="chat-mobile-home-back"
              onClick={() => selectNavigation("home", false)} aria-label={t("backConversations")} title={t("backConversations")}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m14 5-7 7 7 7" />
              </svg>
            </button> : null}
            <button
              type="button"
              className="chat-sidebar-toggle"
              onMouseEnter={openSidebarHover}
              onMouseLeave={closeSidebarHover}
              onClick={() => {
                // 点击固定/收起：清掉悬浮预览态，避免收起后立即又浮出来
                toggleSidebar();
                // 移动端：左右抽屉互斥（悬浮抽屉会盖满屏幕，同时打开会互相遮挡且遮罩不可点）
                if (window.matchMedia("(max-width: 767.98px)").matches) setRightOpen(false);
              }}
              aria-label={t("conversationList")}
              aria-expanded={sidebarOpen}
              title={t("conversationList")}
            >
              <ChatPanelGlyph01 />
            </button>
            {/* 有会话时：顶栏左侧显示 logo + 会话标题；
                空态（新建任务）/ 加载中时不显示任何内容，避免首屏闪现应用 title */}
            {isEmptyView || contentLoading ? null : (
              <>
                {logoSrc ? (
                  <img className="chat-logo" src={logoSrc} alt="" />
                ) : null}
                <span className="chat-title chat-title--left" title={currentSessionTitle}>
                  {currentSessionTitle}
                </span>
              </>
            )}
            {currentSessionError ? <SessionErrorIndicator message={currentSessionError} /> : null}
          </div>
          {/* 连不上服务器（断网等网络层失败）时在顶栏右侧按钮组左侧常驻提示；
              带「重试」按钮可立即探测，网络恢复（轮询/任意请求成功）后自动消失。
              HTTP 通但实时连接不通时单独提示，便于区分是哪种故障 */}
          {!serverOnline ? (
            <div className="chat-connection-banner" role="status">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                <path d="M12 9v4" /><path d="M12 17h.01" />
              </svg>
              <span>{connDetail.http ? t("reconnectingRealtime") : t("networkError")}</span>
              <button type="button" className="chat-connection-retry" onClick={retryConnection} disabled={retrying}>
                {retrying ? t("retrying") : "重试"}
              </button>
            </div>
          ) : null}
          {!isMobileViewport && !embeddedMode && multiFramework && agentModes.length > 1 ? <button type="button" className={`chat-topbar-btn chat-split-button${split ? " is-active" : ""}`}
            disabled={busy || compareBusy} aria-pressed={split} aria-label={split ? t("closeCompare") : t("compare")}
            title={split ? t("closeCompare") : t("compare")} onClick={() => {
              if (!split) { setAgentMode(agentModes.includes("codebuddy") ? "codebuddy" : agentModes[0]); setCompareOnly(false); }
              setCompareSubmission(null);
              saveViewLayout(split ? "single" : "split");
              setSplit((value) => !value);
            }}>
            <ChatPanelGlyph02 />
          </button> : null}
          {(!isEmptyView || (hasNavigation && conversationView) || (isLoggedIn && activeNavigation === "home")) ? (
            <div className="chat-topbar-right">
            {/* 新建对话和已有人机对话都可从顶部邀请成员。 */}
            {isLoggedIn && !embeddedMode && activeNavigation === "home" ? (
              <button type="button" className="chat-topbar-btn chat-invite-trigger" onClick={() => void openInvite()} disabled={busy} aria-label={t("addMembers")} title={busy ? t("waitForResponse") : "添加成员"}><AddUserIcon /></button>
            ) : null}
            {/* 桌面：分享 */}
            {!isEmptyView ? <div className="chat-topbar-desktop">
            {!embedded?.temporary ? <button
              ref={shareButtonRef}
              type="button"
              className={`chat-topbar-btn${shareOpen ? " is-active" : ""}`}
              onClick={openShare}
              aria-label={t("share")}
              title={t("share")}
            >
              <ChatPanelGlyph04 />
            </button> : null}
            </div> : null}
            {/* 移动端：更多菜单按钮 */}
            <button
              ref={moreButtonRef}
              type="button"
              className={`chat-topbar-btn chat-topbar-mobile-more${moreOpen ? " is-active" : ""}`}
              onClick={() => setMoreOpen(o => !o)}
              aria-label={t("more")}
              title={t("more")}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
            >
              <MoreIcon />
            </button>
            {moreOpen ? (
              <>
                <div className="chat-panel-backdrop" onClick={() => setMoreOpen(false)} />
                <div ref={moreMenuRef} className="chat-topbar-more" role="menu" aria-label={t("moreActions")}>
                  {/* 移动端：新建任务（空对话）界面隐藏分享 */}
                  {!isEmptyView ? <>
                  {!embedded?.temporary ? <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); openShare(); }}>
                    <ChatPanelGlyph06 />{t("share")}
                  </button> : null}
                  </> : null}
                  {multiFramework && agentModes.length > 1 ? <button type="button" role="menuitem" aria-label={t(split ? "chooseCurrentLeftFramework" : "chooseCurrentFramework", { name: mobileFrameworkName })} onClick={() => { setMoreOpen(false); setMobilePicker("framework"); }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>
                    {split ? t("leftName", { name: mobileFrameworkName }) : mobileFrameworkName}
                  </button> : null}
                  {mobileModelChoices.length > 0 ? <button type="button" role="menuitem" aria-label={t(split ? "chooseCurrentLeftModel" : "chooseCurrentModel", { name: currentMobileModelName })} onClick={() => { setMoreOpen(false); setMobilePicker("model"); }}>
                    <ModelSelectGlyph01 />{split ? t("leftName", { name: currentMobileModelName }) : currentMobileModelName}
                  </button> : null}
                  {split && agentModes.length > 1 ? <button type="button" role="menuitem" aria-label={t("chooseCurrentRightFramework", { name: compareFrameworkName })} onClick={() => { setMoreOpen(false); setMobilePicker("compare-framework"); }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></svg>{t("rightName", { name: compareFrameworkName })}</button> : null}
                  {split && compareModelChoices.length > 0 ? <button type="button" role="menuitem" aria-label={t("chooseCurrentRightModel", { name: currentCompareModelName })} onClick={() => { setMoreOpen(false); setMobilePicker("compare-model"); }}><ModelSelectGlyph01 />{t("rightName", { name: currentCompareModelName })}</button> : null}
                  {!isEmptyView && !embeddedMode ? <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); openMobileWorkPage("artifacts"); }}>{t("viewArtifacts")}</button> : null}
                </div>
              </>
            ) : null}
            <button
              type="button"
              className="chat-sidebar-toggle chat-right-panel-toggle"
              onClick={() => {
                if (rightShown) {
                  // 实际显示中 → 关闭（记录用户偏好）
                  setRightOpen(false);
                  setDiffView(null); // 右栏关闭：退出变更 diff 视图
                  setInputFilePreview(null); // 右栏关闭：退出输入文件预览
                } else {
                  setRightOpen(true);
                }
                // 移动端：左右抽屉互斥（悬浮抽屉会盖满屏幕，同时打开会互相遮挡且遮罩不可点）
                if (window.matchMedia("(max-width: 767.98px)").matches) setSidebarOpen(false);
              }}
              aria-label={t("expandRight")}
              aria-expanded={rightShown}
              title={t("expandRight")}
            >
              <ChatPanelGlyph08 />
            </button>
          </div>
          ) : null}
    </header>
  );
}
