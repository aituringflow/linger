"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

const EDIT_MIN_WIDTH = 420;

// agent-kit · ChatPanel（中栏聊天区域：顶栏 / 消息流 / 输入区）
// 从 AgentWindow 的聊天主体拆分而来；会话运行状态经 ChatSessionContext 注入。
// 宿主可直接 <ChatPanel active={...} views={...} />，或通过 AgentWindow 装配使用。

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, type CSSProperties, type ChangeEvent, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown from "../components/Markdown.tsx";
import { saveAgentMode } from "../chat/agentModePreference.ts";
import ConversationPanel from "../panel/ConversationPanel.tsx";
import SessionSearchPanel, { type SessionSearchPersonRow } from "../components/SessionSearchPanel.tsx";
import UserMenu from "../components/UserMenu.tsx";
import { ContentPage } from "../components/ContentPanel.tsx";
import { NavigationSidebar, hasSidebar, resolveSidebar } from "../components/NavigationSidebar.tsx";
import { FullscreenContext } from "../components/FullscreenContext.tsx";
import SessionErrorIndicator from "../components/SessionErrorIndicator.tsx";
import ContactsView from "../components/ContactsView.tsx";
import LibraryView, { type LibraryFile } from "../components/LibraryView.tsx";
import { localFilesApi, isLocalReference, type LocalReference } from "../shared/localFiles.ts";
import MemoryView from "../components/MemoryView.tsx";
import OperationPanel, { ArtifactIcon, CHAT_LINK_OPEN_EVENT, fileArtifactType, formatFileSize } from "../panel/OperationPanel.tsx";
import type { CoworkMonologue } from "../components/CoworkPanel.tsx";
import { relativeTime } from "../shared/relativeTime.ts";
import { apiFetch } from "../shared/apiFetch.ts";
import { resolveAttachmentUrl } from "../shared/attachmentUrl.ts";
import { getConnectionState, isServerOnline, subscribeConnection } from "../shared/connectionStatus.ts";
import { Avatar } from "../shared/AvatarView.tsx";
import { realtimeClient } from "../shared/realtime.ts";
import { buildCapabilitiesContext, dispatchCapabilityReply, renderCapabilityCards, toCapMessages } from "../capabilities/index.tsx";
import { ensureWebPushSubscription, installPushProbe, removeWebPushSubscription } from "../shared/webPush.ts";
import { playNotificationSound, syncNotificationSoundForPush } from "../shared/notificationSound.ts";
import ChatComposer, { type ChatComposerHandle } from "../components/ChatComposer.tsx";
import { ChatToolbar } from "../components/ChatToolbar.tsx";
import ContactPickerDialog from "../components/ContactPickerDialog.tsx";
import ShareToChatDialog from "../components/ShareToChatDialog.tsx";
import MemberChip from "../components/MemberChip.tsx";
import { avatarFallbackClass, avatarInitials } from "../shared/avatar.ts";
import CoworkPanel from "../components/CoworkPanel.tsx";
import AiResponse from "../chat/AiResponse.tsx";
import HumanMessage from "../chat/HumanMessage.tsx";
import TimeMarker, { shouldShowTimeMarker } from "../chat/TimeMarker.tsx";
import RecordOverlay, { GlobalRecordingWave, RecordingWave } from "../chat/RecordOverlay.tsx";
import { useVoiceHold } from "../chat/useVoiceHold.ts";
import { useNavStack } from "../shared/useNavStack.ts";
import { readMobileVoiceMode, saveMobileVoiceMode, toggleMobileVoiceMode as switchMobileVoiceMode } from "../chat/mobileVoiceMode.ts";
import { quickSessionTitle } from "../chat/quickTitle.ts";
import { localProjectMessages, localProjectSessions, saveLocalProjectSession, removeLocalProjectSession } from "../chat/localProjectSessions.ts";
import { listLocalProjectDirs, rememberLocalProjectDir, ensureLocalProjectDir, forgetLocalProjectDir, mergeProjectGroups } from "../chat/localProjectDirs.ts";
import { localChatAvailable, localChatList, localChatMessages, localChatSave, localChatPatch, localChatRemove, isAiOnlyChat } from "../chat/localChatStore.ts";
import { encodeUserKey } from "../chat/userKey.ts";
import { useContacts } from "../shared/useContacts.ts";
import ChatInputArea from "../components/ChatInputArea.tsx";
import { EditIcon, RecallIcon } from "../icons/ActionIcons.tsx";
import { SendToChatIcon, BrowserGlobeIcon } from "../icons/SharedIcons.tsx";
import { imeCompositionEnd, imeCompositionStart, isImeConfirmKey } from "../shared/ime.ts";
import { stripRateLimitText } from "../shared/assistantText.ts";
import { useChatScroll } from "../useChatScroll.ts";
import { useAtMention, type MentionCandidate } from "../shared/useAtMention.ts";
import MessageSlider from "../components/MessageSlider.tsx";
import ModelSelect, { modelOptionKey, normalizeModelOption, type ModelOption, type ModelMeta } from "../components/ModelSelect.tsx";
import { ModelSelectGlyph01 } from "../icons/PageIcons.tsx";
import { MobileChoiceDialog } from "../components/MobileChoiceDialog.tsx";
import ComparePane, { type CompareSubmission } from "../components/ComparePane.tsx";
import { lastProcessFallback } from "../chat/processSteps.ts";
import { copyTextToClipboard } from "../shared/clipboard.ts";
import { readChatDraft, saveChatDraft, AGENT_OPEN_ARTIFACTS_EVENT, AGENT_OPEN_DIFF_EVENT, COWORK_MESSAGE_REVOKED_EVENT, COWORK_MESSAGE_UPDATE_EVENT } from "../shared/drafts.ts";
import { ArtifactDiffPanel, type ArtifactChange } from "../components/ArtifactDiff.tsx";
import { aggregateArtifactChanges } from "../shared/artifactDiffModel.ts";
import { SlowPageSpinner } from "../components/LoadingState.tsx";
import { applyTheme, readTheme, type ThemeMode } from "../shared/theme.ts";
import { DesktopHistoryControls } from "../components/DesktopHistoryControls.tsx";
import { consumeAgentDraft, isAgentDraftConsumed, pendingAgentDraft, readAgentLocation, writeAgentLocation } from "../shared/navigation.ts";
import {
  readShowContextUsage,
  writeShowContextUsage,
  readShowModel,
  writeShowModel,
  readMultiFramework,
  writeMultiFramework,
  subscribeUiPrefs,
  SHOW_CONTEXT_USAGE_KEY,
  SHOW_MODEL_KEY,
  MULTI_FRAMEWORK_KEY,
  RIGHT_CTRL_VOICE_KEY,
  readRightCtrlVoice,
  writeRightCtrlVoice,
  readLastSession,
  writeLastSession,
  clearLastSession,
} from "../shared/uiPrefs.ts";
import type { ArtifactType, ArtifactMeta, Scene, SceneSuggestion, ChatUser, ChatUserRole, AgentWindowProps, ComposerReference, UiAttachment, UiImage, UiVoiceRecording, UiQuestionOption, UiQuestion, UiTool, UiStep, BrowserStepData, ModelInfo, UiMessage, QueueItem, RtState, SessionItem, GroupRef } from "../chat/types.ts";
export type { ArtifactType, ArtifactMeta, Scene, ChatUser, ChatUserRole, AgentWindowProps, ComposerReference, ComposerReferenceSource, UiAttachment, UiImage, UiQuestionOption, UiQuestion, UiTool, UiStep, BrowserStepData, ModelInfo, UiMessage, QueueItem, RtState, SessionItem, GroupRef } from "../chat/types.ts";
import { modelListSnapshot, fetchModelList, clearModelListSnapshot, type ModelListSnapshot } from "../chat/modelList.ts";
import { DD_SDK_URL, FEISHU_SDK_URL, ShareCancelledError, loadScript, isInDingTalk, isInFeishu, isDesktopApp, isDingTalkNotificationWebView, summarizeForNotify, isGroupSession, notificationTitleForSession, notifySettingsUrl, showNotification, canNotify, type ShareState } from "../chat/platform.ts";
import { isAudioFile, isImageFile, isVideoFile, isLikelyNonVisionModel, generateSessionId, parseSseFrame } from "../chat/messageUtils.ts";
import { browserCdp } from "../chat/browserCdp.ts";
import { openWorkPanelSurface, type SessionWorkflow, type WorkPanelSurface } from "../chat/workPanel.ts";
import UserBubble from "../chat/UserBubble.tsx";
import MediaAttachment, { type ImageGalleryItem } from "../chat/MediaAttachment.tsx";
import FileMessageCard from "../chat/FileMessageCard.tsx";
import VoiceMessage from "../chat/VoiceMessage.tsx";
import QuestionCard from "../chat/QuestionCard.tsx";
import { CheckIcon, CopyIcon, FileIcon, ImageIcon, MicIcon, MoreIcon, AddUserIcon } from "../icons/SharedIcons.tsx";
import { ContextMeterIcon, PermissionIcon } from "../icons/DynamicIcons.tsx";
import { isInvalidGeneratedTitle } from "../chat/modelList.ts";
import { fileToBase64, stripAttachmentLine, formatDuration, messagePreviewText } from "../chat/messageUtils.ts";
import { IS_ELECTRON, AGENT_HOST, canPickWorkspace } from "../chat/platform.ts";
import { compactTokens, contextUsedTokens } from "../chat/usage.ts";
import { useVoiceDictation, createDictationTranscriber, type VoiceTranscriber, type VoiceDictationError } from "@summersmile/voice-dictation";
import { OperationPanelGlyph08, ChatPanelGlyph01, ChatPanelGlyph02, ChatPanelGlyph04, ChatPanelGlyph06, ChatPanelGlyph08, ChatPanelGlyph09, ChatPanelGlyph10, ChatPanelGlyph11, ChatPanelGlyph12, ChatPanelGlyph16, ChatPanelGlyph17, ChatPanelGlyph18, ChatPanelGlyph19, ChatPanelGlyph20, ChatPanelGlyph21, ChatPanelGlyph22, ChatPanelGlyph23, ChatPanelGlyph24, ChatPanelGlyph25, ChatPanelGlyph26, ChatPanelGlyph27, ChatPanelGlyph28, ChatPanelGlyph29, ChatPanelGlyph30, ChatPanelGlyph31, ChatPanelGlyph32, ChatPanelGlyph33, ChatPanelGlyph34, ChatPanelGlyph35 } from "../icons/PageIcons.tsx";
import { useChatSession } from "../chatSession.tsx";

export interface ChatPanelProps {
  toolbar?: ReactNode;
  /** 当前激活页面："home" 渲染聊天区域，其他键渲染 views 中对应页面。 */
  active: string;
  /** 非 home 页面内容（如 library / contacts / 宿主自定义页）。 */
  views?: Record<string, ReactNode>;
  /** 群聊面板（由宿主装配传入；缺省时渲染聊天区域）。 */
  coworkView?: ReactNode;
  /** 输入框常驻麦克风按钮是否可见（与 voiceEnabled 解耦；默认跟随 voiceEnabled）。 */
  showVoiceButton?: boolean;
}

function RefChipBar({ refs, basePath, onRemove }: { refs: GroupRef[]; basePath?: string; onRemove: (id: string) => void }) {
  const t = useChatTranslation();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(refs.length);
  const [showName, setShowName] = useState<Set<number>>(new Set());
  const [overflow, setOverflow] = useState(false);
  const ARROW_W = 30;

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const measure = measureRef.current;
    if (!wrap || !measure) return;
    const compute = () => {
      const W = wrap.clientWidth;
      const nodes = Array.from(measure.children) as HTMLElement[];
      const GAP = 6;
      const greedy = (reserve: number) => {
        let used = 0;
        let count = 0;
        const names = new Set<number>();
        for (let i = 0; i < refs.length; i++) {
          const nameW = nodes[i * 2]?.offsetWidth ?? 0;
          const avW = nodes[i * 2 + 1]?.offsetWidth ?? 0;
          const pad = used === 0 ? 0 : GAP;
          if (used + pad + nameW <= W - reserve) { used += pad + nameW; names.add(i); count++; }
          else if (used + pad + avW <= W - reserve) { used += pad + avW; count++; }
          else break;
        }
        return { count, names };
      };
      // 第一遍不预留箭头：全部放得下就完整显示名字、不显示 ›；
      // 放不下再第二遍预留箭头位，压缩到只显示能容纳的。
      let res = greedy(0);
      if (res.count < refs.length) res = greedy(ARROW_W);
      setVisible(res.count);
      setShowName(res.names);
      setOverflow(res.count < refs.length);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [refs]);

  if (!refs.length) return null;
  const avatarSrc = (r: GroupRef) => r.avatar ? (r.avatar.startsWith("/") ? `${basePath ?? ""}${r.avatar}` : r.avatar) : undefined;

  return (
    <div className="ref-chip-wrap">
      {/* 隐藏测量层：每个接入项两个节点（名称胶囊宽 / 纯头像胶囊宽） */}
      <div ref={measureRef} className="ref-chip-measure" aria-hidden="true">
        {refs.map((r) => (
          <Fragment key={r.id}>
            <span className="ref-chip ref-chip--name">
              <span className="ref-chip-av"><Avatar name={r.title} src={avatarSrc(r)} isGroup={r.kind !== "peer"} size={18} className="chat-ref-avatar" /></span>
              <span className="ref-chip-name">{r.title}</span>
            </span>
            <span className="ref-chip ref-chip--avatar">
              <span className="ref-chip-av"><Avatar name={r.title} src={avatarSrc(r)} isGroup={r.kind !== "peer"} size={18} className="chat-ref-avatar" /></span>
            </span>
          </Fragment>
        ))}
      </div>
      <div className="ref-chip-bar" ref={wrapRef}>
        <div className="ref-chip-scroll">
          {refs.slice(0, visible).map((r, i) => (
            <span
              key={r.id}
              className={`ref-chip${showName.has(i) ? " ref-chip--name" : " ref-chip--avatar"}`}
              title={r.title}
            >
              <span className="ref-chip-av">
                <Avatar name={r.title} src={avatarSrc(r)} isGroup={r.kind !== "peer"} size={18} className="chat-ref-avatar" />
                <button
                  type="button"
                  className="ref-chip-x"
                  onClick={() => onRemove(r.id)}
                  aria-label={t("removeReference")}
                  title={t("removeReference")}
                >×</button>
              </span>
              {showName.has(i) ? <span className="ref-chip-name">{r.title}</span> : null}
            </span>
          ))}
        </div>
        {overflow ? (
          <button
            type="button"
            className="ref-chip-more"
            onClick={() => setOpen((v) => !v)}
            aria-label={t("allReferences")}
            aria-expanded={open}
          >›</button>
        ) : null}
      </div>
      {open ? (
        <div className="ref-chip-pop">
          <div className="ref-chip-pop-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="ref-chip-pop-inner">
            <div className="ref-chip-pop-title">{t("referencesCount", { count: refs.length })}</div>
            {refs.map((r) => (
              <div className="ref-chip-row" key={r.id}>
                <Avatar name={r.title} src={avatarSrc(r)} isGroup={r.kind !== "peer"} size={18} className="chat-ref-avatar" />
                <span className="ref-chip-row-name" title={r.title}>{r.title}</span>
                <button type="button" className="ref-chip-row-remove" onClick={() => onRemove(r.id)}>{t("remove")}</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const MAX_RECORDING_MS = 10 * 60 * 1000;

function ContextMeter({
  usedTokens,
  maxTokens,
  compacting,
  lastCompactAt,
}: {
  usedTokens: number | null;
  maxTokens: number | null;
  compacting?: boolean;
  lastCompactAt?: number | null;
}) {
  const t = useChatTranslation();
  const used = usedTokens ?? 0;
  // 只在有实际用量时显示；上限未知（服务端拿不到模型窗口）时仍显示——给出 token 数与整环中性提示，
  // 不再因为「拿不到上限」而整环消失（此前的硬隐藏是圆环显示不了的直接原因）。
  if (used <= 0) return null;
  const known = typeof maxTokens === "number" && maxTokens > 0;
  const pct1 = known ? Math.min(100, (used / maxTokens) * 100) : null;
  const pct = pct1 == null ? null : Math.round(pct1);
  const tone = pct == null ? "neutral" : pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
  const r = 7.5;
  const circ = 2 * Math.PI * r;
  // 上限未知：dashoffset=0 → 整环中性显示（表示"有用量、容量未知"）；已知：按比例留缺口
  const off = pct == null ? 0 : circ * (1 - pct / 100);
  const tipParts = [
    pct1 != null
      ? t("contextKnown", { percent: pct1.toFixed(1), used: compactTokens(used), max: compactTokens(maxTokens as number) })
      : t("contextUnknown", { used: compactTokens(used) }),
  ];
  if (compacting) tipParts.push(t("contextCompacting"));
  else if (lastCompactAt) {
    const secs = Math.max(0, Math.round((Date.now() - lastCompactAt) / 1000));
    tipParts.push(secs < 60 ? t("compactedSeconds", { count: secs }) : t("compactedMinutes", { count: Math.round(secs / 60) }));
  }
  const tip = tipParts.join(" ");
  return (
    <span
      className={`ctx-meter ctx-meter--${tone}${compacting ? " is-compacting" : ""}`}
      data-tip={tip}
      aria-label={tip}
    >
      <ContextMeterIcon radius={r} circumference={circ} offset={off} />
    </span>
  );
}

export default function ChatPanel({ active, views, coworkView, toolbar, showVoiceButton }: ChatPanelProps) {
  const t = useChatTranslation();
  const [shareToChatOpen, setShareToChatOpen] = useState(false);
  const {
    activeAttachments,
    activeNavigation,
    activeQuestion,
    activeScene,
    activeSidRef,
    addRecentScreenshot,
    addRef,
    agentMode,
    agentModes,
    agentModesPending,
    allScenes,
    applyWorkspace,
    attachments,
    autoFetchModels,
    basePath,
    bindBodyRef,
    booting,
    branching,
    browserAskText,
    busy,
    canSend,
    cancelArmed,
    cancelGeneration,
    changeModel,
    chatEndpoint,
    chooseAndSend,
    choosePendingMention,
    homeSelectedChips,
    onRemoveHomeRecipient,
    choosePermissionMode,
    clearAttachment,
    clearWorkspace,
    closeSearch,
    closeSidebarHover,
    closeSplitView,
    codexModelOptions,
    compareBusy,
    compareCancelSeq,
    compareFrameworkName,
    compareMode,
    compareModelChoices,
    compareModelKey,
    compareSubmission,
    composerRef,
    composerReferences,
    connDetail,
    contentLoading,
    conversationMembers,
    conversationOwnerSub,
    conversationView,
    copiedIdx,
    copiedLink,
    copyShareLink,
    coworkActive,
    ctxUsage,
    currentCompareModelName,
    currentMobileModelName,
    currentSessionError,
    currentSessionTitle,
    dictation,
    downloadMessageFile,
    dragOver,
    editQueueItem,
    editingIdx,
    editingText,
    embedded,
    embeddedMode,
    composerPlaceholder,
    emptyMessage,
    fileRef,
    foldedProcess,
    getRt,
    goSearch,
    handleDraftSave,
    handleSend,
    hasNavigation,
    isEmptyView,
    isLoggedIn,
    isMobileViewport,
    jumpHighlightId,
    jumpToBottom,
    loadingSessionId,
    localChat,
    localFiles,
    localRefAvailability,
    localRefKinds,
    localRefOpenMsg,
    markBusy,
    messageMoreIdx,
    mobileActionIsSend,
    mobileActionIsStop,
    mobileCancelArmed,
    mobileFrameworkName,
    mobileHolding,
    mobileModelChoices,
    mobileVoiceMode,
    modelError,
    modelOptions,
    modelSelectionEnabled,
    modelSendBlocked,
    modelsLoaded,
    moreButtonRef,
    moreMenuRef,
    moreOpen,
    msgVotes,
    multiFramework,
    notifyBanner,
    openArtifactList,
    openFeishuChat,
    openInputFile,
    openInvite,
    openMobileWorkPage,
    openShare,
    openShareInBrowser,
    openSidebarHover,
    openThinking,
    openWorkspacePopup,
    pendingMembers,
    pendingMembersRef,
    pendingMentionIndex,
    pendingMentionOptions,
    pendingMentionActive,
    homeMentionFilter,
    setHomeMentionFilter,
    showHomeMentionFilter,
    pendingQueue,
    permissionMode,
    permissionLocked,
    pickWorkspaceFromPopup,
    pickingWorkspace,
    previewFull,
    queueNotice,
    recentScreenshot,
    recording,
    referenceMenuOpen,
    refreshSessions,
    regenerateFrom,
    removeQueueItem,
    removeRef,
    renderSessionFooter,
    resolveFileUrl,
    retryConnection,
    retrying,
    rightCtrlRecording,
    rightCtrlVoice,
    voiceRealtimeTranscription,
    startRealtimeVoice,
    stopRealtimeVoice,
    voiceAmplitudeRef,
    saveViewLayout,
    scene,
    screenshotHoveredRef,
    screenshotTimerRef,
    scrollToMsg,
    searchHits,
    searchIdx,
    searchOpen,
    searchQuery,
    selectNavigation,
    selectedCodexModel,
    dshModelOptions, selectedDshModel, setSelectedDshModel,
    selectedModel,
    selectedModelId,
    selfSub,
    send,
    serverOnline,
    sessionId,
    sessions,
    sessionsRef,
    setAgentMode,
    setBranchError,
    setBranchTarget,
    setBrowserAskText,
    setCompareBusy,
    setCompareMode,
    setCompareModelKey,
    setCompareOnly,
    setCompareSubmission,
    setComposerHasInput,
    setComposerHasText,
    setComposerReferences,
    setCopiedIdx,
    setDiffView,
    setEditingIdx,
    setEditingText,
    setEditingWidth,
    setInputFilePreview,
    setLocalRefOpenMsg,
    setMessageMoreIdx,
    setMessages,
    setMobilePicker,
    setMoreOpen,
    setMsgVotes,
    setNotifyBanner,
    setPendingMembers,
    setPendingMentionIndex,
    setPreview,
    setPreviewFull,
    setRecentScreenshot,
    setReferenceMenuOpen,
    setRightCtrlRecording,
    setRightOpen,
    setScene,
    setSearchQuery,
    setSelectedCodexModel,
    setSessionAuxErrors,
    setShowFullAccessWarning,
    setSidebarOpen,
    setSplit,
    setVoiceError,
    setWsMenuOpen,
    shareButtonRef,
    shareError,
    shareLoading,
    shareOpen,
    sharePopupPosition,
    sharePopupRef,
    shareSendMsg,
    shareSending,
    showContextUsage,
    showFullAccessWarning,
    showModel,
    sidebar,
    sidebarOpen,
    spacerRef,
    speakerClick,
    speakerDown,
    split,
    steerInFlight,
    steerQueueItem,
    submitAnswer,
    submitBrowserAnswer,
    switchSession,
    toggleFoldProcess,
    toggleMobileVoiceMode,
    toggleSidebar,
    toggleThinking,
    toggleVoiceInput,
    toolbarCenterRef,
    toolbarCompact,
    transcribing,
    uploading,
    visiblePendingMembers,
    visionWarning,
    voiceSendPendingRef,
    wsMenuOpen,
    onPendingValueChange,
    onHomeUserValueChange,
    trackHomeMentions,
    homeGroupRecipients,
    onPendingEnter,
    onPendingKeyDownIntercept,
    pendingMentionRefs,
    composerHasInput,
    compareOnly,
    uploadEnabled,
    logoSrc,
    activeSid,
    rightShown,
    shareState,
    historyLoadError,
    localOwner,
    editingWidth,
    messages,
    initialUser,
    bodyRef,
    atBottom,
    onUserScrollIntent,
    reconnectAttempt,
    sessionFooterVisibility,
    sessionFooterAppearing,
    capabilities,
    workspaceDir,
    renderSuggestion,
    fillSuggestionPromptRef,
    notifyBannerDismissedRef,
    onQueueDragStart,
    onQueueDragOver,
    onQueueDrop,
    onQueueDragEnd,
    onComposerTextPresenceChange,
    onComposerContentPresenceChange,
    voiceEnabled,
    title,
    holdAreaDown,
    refs,
    referenceSources,
    onAttachClick,
    onPickFile,
    uploadFiles,
    navigationKeys,
    dirName,
    knownProjects,
    recordingSeconds,
  } = useChatSession();

  if (active !== "home") {
    return <>{views?.[active] ?? null}</>;
  }

  return <>{coworkView ?? (
           <div className={`chat-main${isEmptyView && !split && !compareOnly ? " is-empty" : ""}`} data-file-drop-target={uploadEnabled ? "" : undefined}>
        {dragOver && uploadEnabled ? <div className="chat-drop-overlay"></div> : null}
        {toolbar}
        {/* 对话内搜索条：搜索当前会话全部消息，Enter/按钮循环定位命中 */}
        {searchOpen ? (
          <div className="chat-search-bar">
            <ChatPanelGlyph09 />
            <input
              className="chat-search-bar-input"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onCompositionStart={imeCompositionStart}
              onCompositionEnd={imeCompositionEnd}
              onKeyDown={(e) => {
                if (isImeConfirmKey(e)) return;
                if (e.key === "Enter") goSearch(e.shiftKey ? -1 : 1);
                if (e.key === "Escape") closeSearch();
              }}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchConversation")}
            />
            <span className="chat-search-bar-count">
              {searchQuery.trim() ? (searchHits.length ? `${searchIdx + 1}/${searchHits.length}` : "0") : ""}
            </span>
            <button type="button" className="chat-search-bar-btn" onClick={() => goSearch(-1)} aria-label={t("previousResult")} title={t("previousResultHint")}>
              <ChatPanelGlyph10 />
            </button>
            <button type="button" className="chat-search-bar-btn" onClick={() => goSearch(1)} aria-label={t("nextResult")} title={t("nextResultHint")}>
              <ChatPanelGlyph11 />
            </button>
            <button type="button" className="chat-search-bar-btn chat-search-bar-close" onClick={closeSearch} aria-label={t("closeSearch")} title={t("close")}>
              <ChatPanelGlyph12 />
            </button>
          </div>
        ) : null}
        {/* 分享面板：创建只读分享链接后，让用户选择 复制链接 / 浏览器打开 / 发送到 OA 聊天 */}
        {shareOpen ? (
          <div ref={sharePopupRef} className="chat-share-pop" style={sharePopupPosition}>
              <button type="button" className="chat-share-opt" onClick={() => setShareToChatOpen(true)}>
                <span className="chat-share-opt-icon"><SendToChatIcon /></span>
                <span className="chat-share-opt-body"><span className="chat-share-opt-title">{t("sendToChat")}</span><span className="chat-share-opt-desc">{t("sendToChatDesc")}</span></span>
              </button>
              {shareLoading ? (
                <div className="chat-share-loading">{t("creatingLink")}</div>
              ) : shareError ? (
                <div className="chat-share-error">{shareError}</div>
              ) : shareState ? (
                <>
                  <button type="button" className="chat-share-opt" onClick={copyShareLink}>
                    <span className="chat-share-opt-icon">
                      <CopyIcon />
                    </span>
                    <span className="chat-share-opt-body">
                      <span className="chat-share-opt-title">{t("copyLink")}</span>
                      <span className="chat-share-opt-desc">{t("copyLinkDesc")}</span>
                    </span>
                    {copiedLink ? <span className="chat-share-opt-state">{t("copied")}</span> : null}
                  </button>
                  <button type="button" className="chat-share-opt" onClick={openShareInBrowser}>
                    <span className="chat-share-opt-icon">
                      <BrowserGlobeIcon />
                    </span>
                    <span className="chat-share-opt-body">
                      <span className="chat-share-opt-title">{t("openBrowser")}</span>
                      <span className="chat-share-opt-desc">{t("openBrowserDesc")}</span>
                    </span>
                  </button>
                  {(() => {
                    const isOa = shareState.provider === "dingtalk" || shareState.provider === "feishu";
                    // Electron 桌面壳场景：无 OA 客户端 JSAPI 环境，隐藏「发送到 OA 聊天」菜单项
                    if (!isOa || isDesktopApp()) return null;
                    const oaName = shareState.provider === "dingtalk" ? "钉钉" : "飞书";
                    const inApp = shareState.provider === "dingtalk" ? isInDingTalk() : isInFeishu();
                    if (!inApp) return null;
                    return (
                      <button
                        type="button"
                        className="chat-share-opt"
                        disabled={shareSending}
                        onClick={() => chooseAndSend(shareState)}
                      >
                        <span className="chat-share-opt-icon">
                          <SendToChatIcon />
                        </span>
                        <span className="chat-share-opt-body">
                          <span className="chat-share-opt-title">{t("sendToProvider", { provider: oaName })}</span>
                          <span className="chat-share-opt-desc">
                            {shareSending
                              ? t("opening")
                              : t("chooseProviderConversation", { provider: oaName })}
                          </span>
                        </span>
                      </button>
                    );
                  })()}
                  {shareSendMsg ? (
                    <div className={`chat-share-oa-msg${shareSendMsg.startsWith("发送失败") ? " is-error" : ""}`}>{shareSendMsg}</div>
                  ) : null}
                  {/* 飞书分享成功后的轻提示：与操作项区分，作为"已分享"反馈置于下方，整条可点击跳转会话 */}
                  {shareState.provider === "feishu" && shareState.chatId && isInFeishu() ? (
                    <button
                      type="button"
                      className="chat-share-oa-link"
                      onClick={() => openFeishuChat(shareState.chatId!)}
                    >
                      <ChatPanelGlyph16 />
                      <span>{t("sharedView")}</span>
                    </button>
                  ) : null}
                </>
              ) : null}
          </div>
        ) : null}
        {/* 分享直达发送的结果反馈（面板未打开时也可见，3s 自动消失） */}
        {shareSendMsg && !shareOpen ? (
          <div className={`chat-share-toast${shareSendMsg.startsWith("发送失败") ? " is-error" : ""}`}>{shareSendMsg}</div>
        ) : null}
        {/* 本地引用附件在网页端点击打开时的拦截提示 */}
        {localRefOpenMsg ? (
          <div className="chat-share-toast is-error">{localRefOpenMsg}</div>
        ) : null}
      {/* 聊天滚动容器：全宽（滚动条贴聊天区最右缘），消息内容在内部 .chat-body-inner 限宽
          min(80%, 1200px) 居中（父容器全宽，滚动条不跟随消息列右缘）。
          置顶防抖核心：列表底部 chat-stream-spacer 动态补足滚动范围（见 styles.css 注释）。 */}
      <div className={split ? "chat-split-grid" : "chat-single-body"}>
      <div className={`chat-split-primary${compareOnly ? " is-hidden" : ""}`}>
      {split ? <div className="chat-split-pane-head">
        {agentModes.length > 1 ? <ModelSelect showIcon={false} options={agentModes.map((mode) => ({ id: mode, name: mode === "dsh" ? "DeepSeek Harness" : mode === "codex" ? "Codex" : "CodeBuddy" }))}
          value={agentMode} title={t("leftFramework")} disabled={busy} compact openOnHover onChange={(mode) => { setAgentMode(mode as typeof agentMode); saveAgentMode(sessionId, mode); }} /> : null}
        {agentModes.length > 0 && showModel && agentMode === "codebuddy" && modelOptions.length ? <ModelSelect options={modelOptions} value={selectedModel} onChange={changeModel} /> : null}
        {agentMode === "codebuddy" && !modelOptions.length && modelsLoaded ? <span className="chat-model-error" role="alert">{modelError}</span> : null}
        {agentModes.length > 0 && showModel && agentMode === "dsh" && dshModelOptions.length ? <ModelSelect options={dshModelOptions} value={selectedDshModel} onChange={setSelectedDshModel} /> : null}
        {agentModes.length > 0 && showModel && agentMode === "codex" && codexModelOptions.length ? <ModelSelect options={codexModelOptions} value={selectedCodexModel} onChange={(key) => {
          setSelectedCodexModel(key);
          localStorage.setItem(`agent-kit:codex-model:${sessionId}`, key);
        }} /> : null}
        <button type="button" className="chat-split-close" aria-label={t("closeLeftView")} title={t("closeLeftView")} onClick={() => closeSplitView("left")}>×</button>
      </div> : null}
      <div className={`chat-body${contentLoading ? " is-loading" : ""}`} ref={bindBodyRef} tabIndex={0}>
        <div className="chat-body-inner">
        {historyLoadError && !contentLoading ? (
          <div className="chat-loading-error" role="alert">{t("loadConversationFailed")}<button type="button" onClick={() => void switchSession(historyLoadError)}>{t("retry")}</button></div>
        ) : null}
        {contentLoading ? (
          /* 进入会话详情：1s 内不显示任何 loading，超时才显示页面居中转圈（无文字），避免快速加载闪烁 */
          <SlowPageSpinner key={loadingSessionId ?? "boot"} />
        ) : messages.length === 0 ? (
          /* 空态（新建任务）：欢迎/提示区已移到下方 chat-main-inner 居中容器，与输入区一起垂直居中 */
          null
        ) : (
          (() => {
            const imageGallery: ImageGalleryItem[] = messages.flatMap((message, messageIndex) => {
              if (message.revokedAt) return [];
              const files = message.attachments ?? (message.attachment ? [message.attachment] : []);
              return files.flatMap((attachment, fileIndex) => {
                const file = attachment.kind || !isLocalReference(attachment.url) ? attachment : { ...attachment, kind: localRefKinds[attachment.url] };
                return isImageFile(file) && (IS_ELECTRON || !isLocalReference(file.url)) ? [{ key: `${messageIndex}:${fileIndex}`, name: file.name, url: resolveFileUrl(file.url, file.fileId) }] : [];
              });
            });
            return messages.map((m, i) => {
            const streamingLast = busy && i === messages.length - 1;
            // 搜索命中状态：data-msg-index 是滚动定位锚点；高亮当前命中的消息块
            const hitPos = searchHits.indexOf(i);
            const isHit = hitPos !== -1;
            const isCurrent = isHit && hitPos === searchIdx;
            // 多步思考（plan-and-execute）：steps 每项 = { thinking, text, tool, secs }。
            // 活动步（本轮最后一条、最后一步尚未封存工具）→ 展开直播；其余步 → 折叠胶囊（可手动展开）。
            const steps = m.steps || [];
            const hasSteps = m.role === "assistant" && steps.length > 0;
            // 折叠态：流式中的消息不折叠（steps 直播）；含提问卡的步保持可见（折叠时跳过折叠）
            const isFolded = foldedProcess.has(i);
            const contentText = m.role === "assistant" ? stripRateLimitText(m.content) : "";
            const fallbackResult = m.role === "assistant" && !contentText && hasSteps ? lastProcessFallback(steps) : "";
            const messageAttachments = m.attachments ?? (m.attachment ? [m.attachment] : []);
            const fileMessageText = m.role === "user" ? stripAttachmentLine(m.content).trim() : "";
            const hasFileMessage = m.role === "user" && messageAttachments.some(file => !isImageFile(file) && !isVideoFile(file) && !isAudioFile(file));
            const fileMessageClass = hasFileMessage ? ` bubble--file-message${fileMessageText.length > 90 ? " bubble--file-message-wide" : ""}` : "";
            // 分支按钮：紧随点赞/点踩之后、更多按钮之前，与反馈按钮同组同尺寸同间距
            const branchButton = !embeddedMode && !streamingLast ? (
              <button type="button" className="chat-fb-btn" title={t("branchFromHere")} aria-label={t("branchFromHere")}
                disabled={!isLoggedIn || branching || busy} onClick={() => { setBranchError(""); setBranchTarget({ sid: activeSid, index: i, messageId: m.id, title: sessions.find((session) => session.id === activeSid)?.title || t("newTask"), snapshot: structuredClone(messages.slice(0, i + 1)) }); }}>
                <ChatPanelGlyph17 />
              </button>
            ) : null;
            const messageBubble = (
              <div className={`bubble${m.voice && m.role === "user" ? " bubble--voice" : ""}${fileMessageClass}`}>
                {m.revokedAt ? <span className="msg-revoked">{t("messageRevoked")}</span> : null}
                {!m.revokedAt ? <>
                {messageAttachments.length ? (
                <div className="msg-attachments">
                {messageAttachments.map((attachment, fileIndex) => {
                  const file = attachment.kind || !isLocalReference(attachment.url) ? attachment : { ...attachment, kind: localRefKinds[attachment.url] };
                  const isLocalRef = isLocalReference(file.url);
                  const webBlocked = !IS_ELECTRON && isLocalRef;
                  if (isImageFile(file) || isVideoFile(file) || isAudioFile(file)) return <MediaAttachment key={`${file.url}-${fileIndex}`} file={file} url={resolveFileUrl(file.url, file.fileId)} gallery={imageGallery} galleryKey={`${i}:${fileIndex}`} onUnavailable={webBlocked ? () => {
                    setLocalRefOpenMsg(t("localFileUnavailable"));
                    setTimeout(() => setLocalRefOpenMsg(""), 3000);
                  } : undefined} />;
                  return <FileMessageCard key={`${file.url}-${fileIndex}`} file={file} unavailable={isLocalRef && localRefAvailability[file.url] === false}
                    onOpen={() => {
                      if (webBlocked) {
                        setLocalRefOpenMsg(t("localFileUnavailable"));
                        setTimeout(() => setLocalRefOpenMsg(""), 3000);
                      } else void openInputFile(file);
                    }} />;
                })}
                </div>
                ) : null}
              {editingIdx === i ? (
                <div className="msg-edit-box">
                  <textarea
                    className="msg-edit-textarea"
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    autoFocus
                    onFocus={(e) => { const len = e.target.value.length; e.target.setSelectionRange(len, len); }}
                    rows={Math.min(10, Math.max(2, editingText.split("\n").length))}
                  />
                  <div className="msg-edit-footer">
                    <span className="msg-edit-hint">{t("editRestart")}</span>
                    <div className="msg-edit-btns">
                      <button type="button" className="chat-modal-btn" onClick={() => setEditingIdx(null)}>{t("cancel")}</button>
                      <button
                        type="button"
                        className="chat-modal-btn chat-modal-btn--primary"
                        onClick={async () => {
                          const newText = editingText.trim();
                          if (!newText) return;
                          const sid = activeSid;
                          const rt = getRt(sid);
                          rt.messages = rt.messages.slice(0, i);
                          const oldSdkSid = rt.sdkSid;
                          // 派生自本会话 id 的临时 SDK transcript id（`sid_` 前缀供服务端鉴权反查，
                          // 见 session-access.ts）；不再新建会话行，侧边栏不会多出「新任务」。
                          rt.sdkSid = `${sid}_${crypto.randomUUID()}`;
                          rt.sessionStarted = false;
                          rt.sessionRegistered = false;
                          markBusy(sid, false);
                          const lastKept = rt.messages[rt.messages.length - 1];
                          const upToId = lastKept?.id || 0;
                          setEditingIdx(null);
                          const edit2Target = sessionsRef.current.find((item) => item.id === sid);
                          const edit2LocalAi = localChat && isAiOnlyChat(edit2Target);
                          if (edit2LocalAi) {
                            if (edit2Target) void localChatSave(localOwner, { ...edit2Target, updatedAt: new Date().toISOString() }, rt.messages);
                          } else if (!embedded?.temporary) await Promise.allSettled([
                            apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/truncate`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ upToId }),
                            }),
                            apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/close-sdk`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ sdkSid: oldSdkSid }),
                            }),
                          ]);
                          send(newText).catch(() => {});
                        }}
                      >{t("send")}</button>
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  {m.role === "assistant" ? (
                    contentText ? (
                      <Markdown content={contentText} urlBasePath={basePath} highlight={searchOpen ? searchQuery : undefined} streaming={streamingLast} revealAt={m.revealAt} />
                    ) : fallbackResult && isFolded && !streamingLast && !steps.some((s) => s.ask && s.ask.length) ? (
                      <div className="msg-fallback-result">
                        <Markdown content={fallbackResult} urlBasePath={basePath} highlight={searchOpen ? searchQuery : undefined} />
                      </div>
                    ) : (
                      ""
                    )
                  ) : m.voice ? (
                    <VoiceMessage recording={m.voice} basePath={basePath} />
                  ) : m.content ? (
                    <UserBubble text={m.attachment || m.attachments?.length ? stripAttachmentLine(m.content) : m.content} highlight={searchOpen ? searchQuery : undefined} basePath={basePath} />
                  ) : (
                    ""
                  )}
                </>
              )}
                </> : null}
              </div>
            );
            const marker = shouldShowTimeMarker(m.createdAt, messages[i - 1]?.createdAt)
              ? <TimeMarker at={m.createdAt!} /> : null;
            if (m.role === "user") return <Fragment key={i}>{marker}<div className={`chat-message-row${m.id != null && m.id === jumpHighlightId ? " is-jump-hit" : ""}`}><HumanMessage
              key={i} messageIndex={i}
              own={(m.senderSub || conversationOwnerSub || selfSub) === selfSub}
              showAvatar={conversationMembers.length > 0}
              avatar={m.senderSub === selfSub ? initialUser?.avatar : m.senderAvatar}
              senderName={m.senderName || initialUser?.name || t("member")}
              bubble={messageBubble}
              belowBubble={m.voice && m.content ? (
                <div className="msg-voice-transcript--plain">
                  <UserBubble text={m.content} highlight={searchOpen ? searchQuery : undefined} basePath={basePath} />
                </div>
              ) : null}
              actionsAtBottom={conversationMembers.length === 0}
              actions={editingIdx === i || m.revokedAt ? undefined : <>
                  {/* 撤回仅用于有成员参与的会话（1v1/群聊）中自己的消息；人机聊天（无成员）不提供撤回 */}
                  {conversationMembers.length > 0 && m.id && m.senderSub === selfSub && !embedded?.temporary ? <button
                    type="button" title={t("recall")} aria-label={t("recall")}
                    onClick={async () => {
                      const sid = activeSid;
                      const res = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/messages`, {
                        method: "PATCH", headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ messageId: m.id }),
                      }).catch(() => null);
                      if (!res?.ok) { setSessionAuxErrors((previous) => ({ ...previous, [sid]: t("recallFailed") })); return; }
                      const rt = getRt(sid);
                      rt.messages = rt.messages.map((message) => message.id === m.id
                        ? { ...message, content: "", images: undefined, voice: undefined, attachment: undefined, attachments: [], revokedAt: new Date().toISOString() }
                        : message);
                      if (activeSidRef.current === sid) setMessages([...rt.messages]);
                      // 撤回后立即刷新会话列表：预览回退到最后一条未撤回消息
                      void refreshSessions();
                    }}
                  ><RecallIcon /></button> : null}
                  <button
                    type="button"
                    title={t("edit")}
                    onClick={(e) => {
                      // 量取原气泡宽度，编辑框沿用该宽度（与编辑前的消息框一致）
                      const bubble = (e.currentTarget as HTMLElement)
                        .closest(".msg")?.querySelector<HTMLElement>(".bubble");
                      setEditingWidth(bubble ? Math.round(bubble.getBoundingClientRect().width) : null);
                      setEditingIdx(i);
                      setEditingText(m.content || "");
                    }}
                  >
                    <ChatPanelGlyph18 />
                  </button>
                  <button
                    type="button"
                    title={copiedIdx === i ? t("copiedShort") : t("copy")}
                    aria-label={copiedIdx === i ? t("copiedShort") : t("copy")}
                    className={copiedIdx === i ? "is-copied" : undefined}
                    onClick={async () => {
                      const ok = await copyTextToClipboard(m.content || "");
                      if (ok) {
                        setCopiedIdx(i);
                        window.setTimeout(() => {
                          setCopiedIdx((c) => (c === i ? null : c));
                        }, 1800);
                      }
                    }}
                  >
                    {copiedIdx === i ? (
                      <CheckIcon />
                    ) : (
                      <CopyIcon />
                    )}
                  </button>
                  {(() => {
                    const files = m.attachments ?? (m.attachment ? [m.attachment] : []);
                    const file = files.length === 1 && !isImageFile(files[0]) ? files[0] : null;
                    return file ? <span className="cowork-more-anchor" data-message-more>
                      <button type="button" className="cowork-more-trigger" title={t("more")} aria-label={t("moreActions")} onClick={() => setMessageMoreIdx(current => current === i ? null : i)}><MoreIcon /></button>
                      {messageMoreIdx === i ? <span className="cowork-more-pop" role="menu"><button type="button" role="menuitem" onClick={() => { setMessageMoreIdx(null); downloadMessageFile(file); }}><OperationPanelGlyph08 /><span>{t("download")}</span></button></span> : null}
                    </span> : null;
                  })()}
              </>}
              className={`${isHit ? " is-search-hit" : ""}${isCurrent ? " is-search-current" : ""}${editingIdx === i ? " is-editing" : ""}`}
              style={editingIdx === i && editingWidth ? { width: Math.max(editingWidth, EDIT_MIN_WIDTH) } : undefined}
            /></div></Fragment>;
            return (
            <Fragment key={i}>{marker}<div
              key={i}
              data-msg-index={i}
              className={`msg bot${isHit ? " is-search-hit" : ""}${isCurrent ? " is-search-current" : ""}${m.id != null && m.id === jumpHighlightId ? " is-jump-hit" : ""}`}
              style={editingIdx === i && editingWidth ? { width: Math.max(editingWidth, EDIT_MIN_WIDTH) } : undefined}
            >
            {m.role === "assistant" ? <AiResponse
              scene="direct" steps={steps} elapsedSecs={m.elapsedSecs} running={streamingLast}
              mode={m.modelInfo?.agentMode} basePath={basePath} content={contentText}
              expanded={!isFolded} onToggleExpanded={() => toggleFoldProcess(i)}
              isStepOpen={(stepIndex) => openThinking.has(`${i}:${stepIndex}`)}
              onToggleStep={(stepIndex) => toggleThinking(`${i}:${stepIndex}`)}
              browserAskText={browserAskText} onBrowserAskText={setBrowserAskText}
              onBrowserAnswer={(browserId, answer) => { void submitBrowserAnswer(browserId, answer); }}
              answer={messageBubble}
              afterAnswer={<>
              {m.role === "assistant" && m.artifacts?.some((a) => a.change === "added" || !a.change) ? (
                <div className="artifact-grid">
                  {m.artifacts.filter((a) => a.change === "added" || !a.change).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className="artifact-card"
                      onClick={() => {
                        // 点击消息里的产物卡片：打开右栏预览，同时把「偏好」置为展开
                        setRightOpen(true);
                        setPreview({ sid: activeSid, meta: a });
                        setDiffView(null); // 打开单文件预览：退出变更 diff 视图
                        setInputFilePreview(null); // 打开单文件预览：退出输入文件预览
                      }}
                    >
                      <span className="artifact-card-icon" aria-hidden="true">
                        <ArtifactIcon type={a.type} />
                      </span>
                      <span className="artifact-card-main">
                        <span className="artifact-card-name">{a.name}</span>
                        <span className="artifact-card-meta">
                          {a.size ? (
                            <span className="artifact-card-size">{formatFileSize(a.size)}</span>
                          ) : null}
                        </span>
                      </span>
                      <span className="artifact-card-open" aria-hidden="true">
                        <ChatPanelGlyph19 />
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {!streamingLast && m.role === "assistant" ? (() => {
                // 消息级：查看产出物 / 查看变更 跟随每条助手消息，仅当该消息真正产生对应内容才出现。
                // 不再按会话累计、也不再只挂在最后一条——否则无产物的旧答复 / 纯聊天轮次也会冒出两张卡片。
                const msgArtifacts = m.artifacts || [];
                const addedCount = msgArtifacts.filter((a) => a.change === "added" || !a.change).length;
                const changeCount = msgArtifacts.filter((a) => a.change === "modified" || a.change === "deleted").length;
                if (addedCount === 0 && changeCount === 0) return null;
                const firstChangeId = msgArtifacts.find((a) => a.change === "modified" || a.change === "deleted")?.id ?? "";
                return (
                  <div className="artifact-viewall-row">
                    {addedCount > 0 ? (
                      <button
                        type="button"
                        className="artifact-viewall"
                        onClick={() => openArtifactList(activeSid)}
                        title={t("viewArtifactsHint")}
                      >
                        {t("viewArtifactsCount", { count: addedCount })}
                      </button>
                    ) : null}
                    {changeCount > 0 ? (
                      <button
                        type="button"
                        className="artifact-viewall"
                        onClick={() => {
                          setPreview(null);
                          setPreviewFull(false);
                          setInputFilePreview(null); // 打开变更 diff：退出输入文件预览
                          setDiffView({ sid: activeSid, activeId: firstChangeId });
                          setRightOpen(true);
                        }}
                        title={t("viewChangesHint")}
                      >
                        {t("viewChangesCount", { count: changeCount })}
                      </button>
                    ) : null}
                  </div>
                );
              })() : null}
              </>}
              footer={{
                feedback: {
                  basePath, sessionId: activeSid, messageId: m.id,
                  vote: m.id != null ? msgVotes[m.id] ?? null : null,
                  onVote: m.id != null ? (vote) => setMsgVotes((prev) => ({ ...prev, [m.id as number]: vote })) : undefined,
                  answer: contentText || fallbackResult,
                  branchAction: branchButton,
                  onRegenerate: () => void regenerateFrom(i), canRegenerate: !busy,
                },
                extra: <>
                  {m.modelInfo?.usedFallback ? (
                    <span
                      className="chat-model-hint"
                      role="note"
                      data-tip={t("advancedModel")}
                      aria-label={t("advancedModel")}
                    >
                      <span className="chat-model-hint-icon" aria-hidden="true">
                        <ChatPanelGlyph20 />
                      </span>
                    </span>
                  ) : null}
                  {typeof m.costInfo?.costUsd === "number" && m.costInfo.costUsd > 0 ? (
                    <div className="msg-cost">
                      约 ${m.costInfo.costUsd.toFixed(4)}
                    </div>
                  ) : null}
                  {agentModes.length > 1 ? (
                    <span className="msg-footer-model">{m.modelInfo?.agentMode === "dsh" ? "DeepSeek Harness" : m.modelInfo?.agentMode === "codex" ? "Codex" : "CodeBuddy"}</span>
                  ) : null}
                  {showModel ? (
                    <span className="msg-footer-model">
                      {(() => {
                        const models = m.modelInfo?.models;
                        const isCodex = m.modelInfo?.agentMode === "codex";
                        const ids = (models && models.length > 0) ? models : [isCodex ? "Codex 默认模型" : selectedModelId];
                        return ids.map(id => {
                          const opt = (isCodex ? codexModelOptions : modelOptions).find(o => normalizeModelOption(o).id === id);
                          return opt ? normalizeModelOption(opt).name || id : id;
                        }).join(", ");
                      })()}
                    </span>
                  ) : null}
                </>,
              }}
            /> : null}
            </div></Fragment>
            );
          })
          })()
        )}
        {/* 连接状态横幅：紧跟最新消息下方，断网/重连时清晰可见（比顶栏提示更醒目）。
            任务仍在后台执行，恢复后横幅自动消失、结果继续流入。 */}
        {!contentLoading && reconnectAttempt > 0 ? (
          <div className="chat-conn-banner" role="status">
            <span className="chat-conn-spinner" aria-hidden="true" />
            <span className="chat-conn-banner-title">
              {t("reconnecting", { count: reconnectAttempt })}
            </span>
          </div>
        ) : null}
        {!contentLoading && renderSessionFooter
          && (sessionFooterVisibility === "always" || (!busy && messages.some((m) => m.role === "assistant")))
          ? (() => {
              const content = renderSessionFooter({ sessionId: activeSid, messages });
              return content == null || content === false
                ? null
                : <div className={`chat-session-footer${sessionFooterAppearing ? " chat-session-footer--appearing" : ""}`} key={activeSid}>{content}</div>;
            })()
          : null}
        {!contentLoading && capabilities?.length
          && (sessionFooterVisibility === "always" || (!busy && messages.some((m) => m.role === "assistant")))
          ? (() => {
              const cards = renderCapabilityCards(capabilities, { sessionId: activeSid, messages: toCapMessages(messages), channel: "chat" });
              return cards.length === 0
                ? null
                : <div className={`chat-session-footer${sessionFooterAppearing ? " chat-session-footer--appearing" : ""}`} key={`cap-${activeSid}`}>{cards}</div>;
            })()
          : null}
        {/* 流式置顶 reserve：动态 spacer（见 [messages] effect 的高度计算）。
            置于消息列表最底部，缩小不牵动上方内容 → 流式期间不抖动。 */}
        <div ref={spacerRef} className="chat-stream-spacer" aria-hidden="true" />
        </div>
      </div>
      </div>
      {split || compareOnly ? <ComparePane key={activeSid} basePath={basePath} chatEndpoint={chatEndpoint} sessionId={activeSid} submission={compareSubmission?.sessionId === activeSid ? compareSubmission : null}
        codebuddyModels={modelOptions} codexModels={codexModelOptions} agentModes={agentModes.filter((mode): mode is "codebuddy" | "codex" => mode !== "dsh")} mode={compareMode} modelKey={compareModelKey}
        onModeChange={setCompareMode} onModelChange={(key) => { setCompareModelKey(key); localStorage.setItem(`agent-kit:compare-model:${sessionId}:${compareMode}`, key); }}
        showHeader={split} onClose={() => closeSplitView("right")} showModel={showModel} workspaceDir={workspaceDir}
        cancelSeq={compareCancelSeq} onBusyChange={setCompareBusy} /> : null}
      </div>

      {/* 侧边消息滑块（ChatGPT/豆包式）：聊天区够宽且内容可滚动时出现；
          hover 横线加宽 + 显示所属轮次的用户提问，点击跳转到那个提问（同「历史」面板定位） */}
      {!split && !compareOnly ? <MessageSlider bodyRef={bodyRef} messages={messages} loading={contentLoading} onJump={scrollToMsg} onWheelIntent={onUserScrollIntent} /> : null}

      <div className="chat-main-inner">
      {/* 空态（新建任务）：问候 + 建议提示与输入区一起垂直居中（WB 新建任务样式）；
          输入第一条消息后 is-empty 移除，自动回到底部常规布局 */}
      {isEmptyView && !split && !compareOnly ? (
        <div className="chat-empty">
          {homeGroupRecipients.length > 1 ? <h2>{t("sendIndividually", { names: homeGroupRecipients.map((person: { name: string }) => person.name).join(", ") })}</h2>
            : (emptyMessage ?? embedded?.emptyMessage ?? t("helloAssistant")) ? <h2>{emptyMessage ?? embedded?.emptyMessage ?? t("helloAssistant")}</h2> : null}
          {activeScene?.suggestions?.length ? (
            <>
              <p>{t("commonExamples")}</p>
              <div className="chat-suggestions">
                {activeScene.suggestions.map(renderSuggestion)}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      {/* 离开底部时：消息底部渐隐模糊遮罩 + 居中「回到底部」按钮。
          锚定在输入区容器顶部（bottom:100%），始终位于消息区与输入区交界处，不随滚动移动 */}
      {!atBottom ? (
        <div className="chat-body-overlay">
          <div className="chat-body-fade" aria-hidden="true" />
          <button
            type="button"
            className={`chat-bottom-btn${busy ? " is-live" : ""}`}
            onClick={jumpToBottom}
            aria-label={t("backToBottom")}
          >
            <ChatPanelGlyph21 />
          </button>
        </div>
      ) : null}
      {/* 场景栏：加载中（刷新/切会话）一律不渲染，避免中间态闪现。
          加载完成后：空态显示全部场景供选择；非空态仅当当前场景 sticky=true 时显示该场景，
          作为“我此刻在这个场景里”的指示（技能/skill 随场景生效）；当前场景非 sticky 则场景栏整体隐藏 */}
      {!contentLoading && (isEmptyView ? allScenes : activeScene?.sticky ? [activeScene] : []).length > 0 ? (
        <div className="chat-scene-bar">
          <div className="chat-scenes">
            {(isEmptyView ? allScenes : activeScene?.sticky ? [activeScene] : []).map((s) => (
              <button
                key={s.key}
                type="button"
                className={`chat-scene ${scene === s.key ? "is-active" : ""}`}
                onClick={() => {
                  fillSuggestionPromptRef.current = null; // 切场景后不再携带上一个场景建议的提示词
                  setScene(s.key);
                }}
                aria-pressed={scene === s.key}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* 附件条位于 textarea 上方；有附件时输入卡片随内容增高。 */}
      <div className="chat-input-zone">
      {/* Web 通知权限被拒绝时的引导条（桌面壳/已授权不出现） */}
      {notifyBanner && !isDingTalkNotificationWebView() ? (
        <div className="chat-notify-banner">
          <ChatPanelGlyph22 />
          <span className="chat-notify-banner-text">
            {t("notificationDenied")}
          </span>
          {notifySettingsUrl() ? (
            <a className="chat-notify-banner-link" href={notifySettingsUrl()}>{t("openBrowserSettings")}</a>
          ) : null}
          <button
            type="button"
            className="chat-notify-banner-close"
            onClick={() => {
              notifyBannerDismissedRef.current = true;
              setNotifyBanner(false);
            }}
            aria-label={t("dismissNotice")}
            title={t("close")}
          >
            <ChatPanelGlyph23 />
          </button>
        </div>
      ) : null}
      {/* 新建任务预选成员显示在输入卡片外，发送首条消息后隐藏。 */}
      {isEmptyView && !split && !compareOnly && pendingMembers.length ? (
        <div ref={pendingMembersRef} className="chat-pending-members" aria-label={t("selectedMembers", { count: pendingMembers.length })}>
          {pendingMembers.slice(0, visiblePendingMembers).map(member => (
            <MemberChip key={member.contactId} name={member.name} avatar={member.avatar}
              onRemoveClick={() => {
                if (trackHomeMentions && homeSelectedChips.some(chip => chip.id === member.contactId)) {
                  onRemoveHomeRecipient(member.contactId);
                } else setPendingMembers(current => current.filter(item => item.contactId !== member.contactId));
              }} />
          ))}
          {pendingMembers.length > visiblePendingMembers ? <button type="button" className="chat-pending-more" onClick={openInvite} title={t("editSelected")} aria-label={t("editSelectedMembers", { count: pendingMembers.length })}><span>{t("totalMembers", { count: pendingMembers.length })}</span><EditIcon /></button> : null}
        </div>
      ) : null}
      {/* 新建对话空态：输入框输入 @ 弹出已选成员列表，选中后插入 @姓名（与群聊一致） */}
      {isEmptyView && !split && !compareOnly && (pendingMentionOptions.length || (showHomeMentionFilter && pendingMentionActive)) ? (
        <div className="cowork-mentions">
          {showHomeMentionFilter ? <div className="cowork-mention-filters" role="group" aria-label={t("mentionTypes")}>
            {([ ["all", t("filterAll")], ["contacts", t("filterContacts")], ["groups", t("filterGroups")] ] as const).map(([filter, label]) => (
              <button key={filter} type="button" aria-pressed={homeMentionFilter === filter}
                onMouseDown={event => event.preventDefault()} onClick={() => setHomeMentionFilter(filter)}>{label}</button>
            ))}
          </div> : null}
          <div role="listbox" aria-label={t("mentionMembers")}>{pendingMentionOptions.map((option, index) => (
          <button
            key={option.id}
            ref={node => { pendingMentionRefs.current[index] = node; }}
            type="button"
            role="option"
            aria-selected={index === pendingMentionIndex}
            tabIndex={-1}
            onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => setPendingMentionIndex(index)}
            onClick={() => choosePendingMention(option.name, option.id)}
          >
            {option.avatar
              ? <img src={option.avatar} alt="" referrerPolicy="no-referrer" />
              : <span className={avatarFallbackClass(avatarInitials(option.name))}>{avatarInitials(option.name)}</span>}
            {option.name}
            {option.id.startsWith("group:") ? <small>{t("groupChat")}</small> : null}
          </button>
        ))}{!pendingMentionOptions.length ? <div className="cowork-mention-empty">{t("noMatches")}</div> : null}</div></div>
      ) : null}
      {/* AskUserQuestion 提问卡片：固定在输入框上方（替代原消息流内多卡片展开显示），
          始终只展示一张，内部箭头/下一步切换题目；提交答案后 activeQuestion 变 null 自动消失 */}
      {activeQuestion && !compareOnly ? (
        <QuestionCard
          questions={activeQuestion.questions}
          answered={null}
          onSubmit={(text, answers) => submitAnswer(activeQuestion.messageIdx, activeQuestion.stepIdx, text, answers)}
        />
      ) : null}
      <ChatInputArea
        pendingQueue={pendingQueue} queueNotice={queueNotice} steerInFlight={steerInFlight}
        onQueueDragStart={onQueueDragStart} onQueueDragOver={onQueueDragOver}
        onQueueDrop={onQueueDrop} onQueueDragEnd={onQueueDragEnd}
        steerQueueItem={steerQueueItem} editQueueItem={editQueueItem} removeQueueItem={removeQueueItem}
        activeAttachments={activeAttachments} clearAttachment={clearAttachment}
        resolveFileUrl={resolveFileUrl} visionWarning={visionWarning} uploading={uploading}
        mobileHolding={mobileHolding} mobileCancelArmed={mobileCancelArmed}
        // 实时转录进行中（按住 option 走腾讯云 wss，或点了输入框里的麦克风按钮）：
        // 只显示纯文本，隐藏工具栏/附件/特效，alpha 淡入淡出。
        // 用 recording 而不是 rightCtrlRecording —— 后者只在 kit 自己的按住路径里置位，
        // 麦克风按钮那条走 realtimeActive，两边都要能触发语音模式。
        realtimeVoiceActive={Boolean(recording && voiceRealtimeTranscription)}
        groupDropEnabled={!coworkActive}
        onDropGroup={addRef}
      >
        <ChatComposer
          ref={composerRef}
          activeSid={activeSid}
          busy={compareOnly ? compareBusy : busy}
          booting={contentLoading}
          uploading={uploading}
          modelLoading={autoFetchModels && !modelsLoaded}
          modelBlocked={modelSendBlocked}
          attachments={attachments}
          recording={recording}
          transcribing={transcribing}
          onSend={handleSend}
          onDraftSave={handleDraftSave}
          onHasInputChange={setComposerHasInput}
          onHasTextChange={(hasText) => { setComposerHasText(hasText); onComposerTextPresenceChange?.(hasText); }}
          /**
           * 「有内容」= 文字**或**附件。宿主（如 home 悬浮输入框）要判断
           * 预览浮层该不该收起时必须看这个：只挂了附件没打字时浮层里是有东西的，
           * 收起就等于把附件丢了。
           */
          onHasContentChange={onComposerContentPresenceChange}
          // @ 提及仅在「新建对话空态」生效（此时无消息列表，逐键同步开销可忽略）；
          // 普通单聊/已有会话不挂载这些回传，保持输入框输入隔离、不触发整页重渲染。
          onValueChange={(trackHomeMentions || isEmptyView) && !split && !compareOnly ? onPendingValueChange : undefined}
          onUserValueChange={trackHomeMentions && isEmptyView ? onHomeUserValueChange : undefined}
          onEnter={isEmptyView && !split && !compareOnly ? onPendingEnter : undefined}
          onKeyDownIntercept={isEmptyView && !split && !compareOnly ? onPendingKeyDownIntercept : undefined}
          onVoiceHoldStart={voiceEnabled && rightCtrlVoice && !contentLoading ? () => {
            if (dictation.state !== "idle") return false;
            // 实时转录由宿主 Dock 全局接管（跨窗口/聚焦态都能按 Option），这里不拦截。
            if (voiceRealtimeTranscription) return false;
            voiceSendPendingRef.current = false;
            if (!window.isSecureContext) {
              setVoiceError("当前局域网 HTTP 地址无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）");
              return false;
            }
            setVoiceError("");
            dictation.start();
            setRightCtrlRecording(true);
            return true;
          } : undefined}
          onVoiceHoldEnd={voiceEnabled ? () => {
            if (voiceRealtimeTranscription) return; // Dock 接管，这里不处理
            setRightCtrlRecording(false);
            dictation.stop();
          } : undefined}
          onPasteFiles={uploadFiles}
          mobileVoiceMode={mobileVoiceMode}
          appName={title}
          placeholder={composerPlaceholder}
        />
        <button
          type="button"
          className={`chat-mobile-hold${mobileVoiceMode ? " is-active" : ""}${mobileHolding ? " is-holding" : ""}`}
          onPointerDown={holdAreaDown}
          onContextMenu={(event) => event.preventDefault()}
          disabled={transcribing || uploading || contentLoading || modelSendBlocked}
          aria-label={transcribing ? "正在识别语音" : "按住说话，移出输入框取消"}
        >
          {transcribing ? "正在识别…" : mobileHolding ? "" : "按住说话"}
        </button>
        {mobileHolding ? (
          <RecordOverlay amplitude={dictation.amplitude} cancelArmed={mobileCancelArmed} />
        ) : null}
        <ChatToolbar className={`${mobileVoiceMode ? " chat-toolbar--mobile-voice" : ""}${recording || rightCtrlRecording ? " chat-toolbar--recording" : ""}`} compact={toolbarCompact}>
          {/* 加号恒在最左，语音与发送操作恒在最右；只有中间一组随宽度降级。
              三段式：left 固定不换行 / center 内部自行换行 / right 固定贴最右。 */}
          <div className={`chat-toolbar-left${refs.length || composerReferences.length ? " has-refs" : ""}`}>
          {(uploadEnabled || referenceSources.length > 0) ? (
            <div className="chat-attach-anchor">
              {recentScreenshot ? <button type="button" className="chat-screenshot-suggestion" onClick={() => void addRecentScreenshot()} onMouseEnter={() => { screenshotHoveredRef.current = true; if (screenshotTimerRef.current) clearTimeout(screenshotTimerRef.current); screenshotTimerRef.current = null; }} onMouseLeave={() => { screenshotHoveredRef.current = false; setRecentScreenshot(null); }} aria-label={t("addScreenshot")} disabled={uploading}>
                <img src={recentScreenshot.thumbnail} alt="刚刚的截图" />
              </button> : null}
              <button
                type="button"
                className="chat-tool"
                onClick={onAttachClick}
                disabled={recording || transcribing || (uploading && !referenceSources.length)}
                aria-label={referenceSources.length ? "添加引用" : uploading ? "处理中" : localFiles ? "引用本机文件" : "上传附件"}
                aria-expanded={referenceSources.length ? referenceMenuOpen : undefined}
                aria-haspopup={referenceSources.length ? "menu" : undefined}
              >
                <ChatPanelGlyph24 />
              </button>
              <input ref={fileRef} type="file" multiple hidden onChange={onPickFile} />
              {referenceMenuOpen ? <>
                <div className="chat-reference-menu-backdrop" onClick={() => setReferenceMenuOpen(false)} />
                <div className="chat-reference-menu" role="menu" aria-label={t("addReference")}>
                  <button type="button" role="menuitem" disabled={!uploadEnabled || uploading} onClick={() => { setReferenceMenuOpen(false); fileRef.current?.click(); }}>{localFiles ? "文件和文件夹" : "文件"}</button>
                  {referenceSources.map((source) => <button type="button" role="menuitem" key={source.id} onClick={() => {
                    setReferenceMenuOpen(false);
                    const selectedSid = activeSid;
                    void Promise.resolve().then(() => source.onSelect({ sessionId: selectedSid, add: (reference) => {
                      if (activeSidRef.current !== selectedSid || !reference.id || !reference.context) return;
                      setComposerReferences((current) => current.some((item) => item.sourceId === source.id && item.reference.id === reference.id)
                        ? current.map((item) => item.sourceId === source.id && item.reference.id === reference.id ? { sourceId: source.id, reference } : item)
                        : [...current, { sourceId: source.id, reference }]);
                    } })).catch((error) => console.warn("[agent-kit] 引用来源选择失败:", error));
                  }}>{source.label}</button>)}
                </div>
              </> : null}
            </div>
          ) : null}
          {!coworkActive ? (
            <RefChipBar refs={refs} basePath={basePath} onRemove={removeRef} />
          ) : null}
          {composerReferences.map(({ sourceId, reference }) => {
            const source = referenceSources.find((entry) => entry.id === sourceId);
            return <span className="chat-reference-chip" key={`${sourceId}:${reference.id}`} title={reference.label}>
              <span className="chat-reference-chip-content">{source?.renderReference?.(reference) ?? reference.label}</span>
              <button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => setComposerReferences((current) => current.filter((item) => item.sourceId !== sourceId || item.reference.id !== reference.id))}>×</button>
            </span>;
          })}
          </div>
          {(recording || rightCtrlRecording) && !(rightCtrlRecording && previewFull && rightShown) ? <div className="chat-desktop-record-wave" role="status" aria-label={t("voiceInput")}><RecordingWave amplitude={dictation.amplitude} readAmplitude={voiceRealtimeTranscription && recording ? () => voiceAmplitudeRef?.current ?? 0 : undefined} /></div> : null}
          {rightCtrlRecording && previewFull && rightShown ? <GlobalRecordingWave amplitude={dictation.amplitude} /> : null}
          <div className="chat-toolbar-center" ref={toolbarCenterRef} data-compact={toolbarCompact}>
          {/* 项目空间在新建对话时选择；进入聊天后输入框不再显示该入口。 */}
          {canPickWorkspace && isEmptyView && readAgentLocation(navigationKeys)?.view === "new" ? (
            <div className="chat-ws-anchor">
              <button
                type="button"
                className={`chat-ws-btn${wsMenuOpen ? " is-open" : ""}${workspaceDir ? " has-workspace" : ""}`}
                onClick={openWorkspacePopup}
                disabled={recording || transcribing}
                title={workspaceDir ? `当前项目：${workspaceDir}` : "选择项目（Agent 只在本项目目录内读写文件）"}
                aria-expanded={wsMenuOpen}
                aria-haspopup="menu"
              >
                <ChatPanelGlyph25 />
                {workspaceDir ? <span className="chat-ws-selected-name">{dirName(workspaceDir)}</span> : null}
              </button>
              {wsMenuOpen ? (
                <div className="chat-ws-pop" role="menu">
                  {/* 点击 popup 外任意处关闭 */}
                  <div className="chat-ws-pop-backdrop" onClick={() => setWsMenuOpen(false)} aria-hidden="true" />
                  <div className="chat-ws-pop-inner">
                      {workspaceDir ? (
                        <div className="chat-ws-current">
                          <span className="chat-ws-current-path" title={workspaceDir}>
                            {workspaceDir}
                          </span>
                          <button
                            type="button"
                            className="chat-ws-act chat-ws-act--clear"
                            onClick={() => {
                              clearWorkspace();
                              setWsMenuOpen(false);
                            }}
                          >
                            移除
                          </button>
                        </div>
                      ) : null}
                      <div className="chat-ws-pop-label">{t("existingProjects")}</div>
                      {knownProjects.length === 0 ? (
                        <div className="chat-ws-pop-empty">{t("noProjects")}</div>
                      ) : (
                        knownProjects.map(({ dir }) => (
                          <button
                            key={dir}
                            type="button"
                            className={`chat-ws-pop-item${workspaceDir === dir ? " is-active" : ""}`}
                            onClick={() => {
                              void applyWorkspace(dir);
                              setWsMenuOpen(false);
                            }}
                          >
                            <ChatPanelGlyph27 />
                            <span className="chat-ws-pop-item-name" title={dir}>
                              {dirName(dir)}
                            </span>
                            {workspaceDir === dir ? (
                              <span className="chat-ws-pop-item-check" aria-hidden="true">✓</span>
                            ) : null}
                          </button>
                        ))
                      )}
                      <div className="chat-ws-pop-divider" />
                      <button
                        type="button"
                        className="chat-ws-pop-act"
                        onClick={pickWorkspaceFromPopup}
                        disabled={pickingWorkspace}
                      >
                        <span className="chat-ws-pop-act-icon" aria-hidden="true">
                          <ChatPanelGlyph28 />
                        </span>
                        打开本地文件夹
                      </button>
                    </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {/* 默认权限（完全访问）：紧贴「选择工作空间」右侧；容器变窄时由 CSS 先去掉文字只留图标，
              仍放不下时框架/模型选择才单独成行，保证图标永不被压缩。 */}
          {uploadEnabled && canPickWorkspace && !permissionLocked ? (
            <>
              <button type="button" className={`chat-permission-btn${permissionMode === "full" ? " is-full" : ""}`} aria-label={`访问控制：${permissionMode === "full" ? "完全访问" : "默认权限"}`} title={permissionMode === "full" ? "完全访问" : "默认权限"} onClick={() => permissionMode === "default" ? setShowFullAccessWarning(true) : choosePermissionMode("default")}>
                <PermissionIcon full={permissionMode === "full"} />
                <span className="chat-permission-label">{permissionMode === "full" ? "完全访问" : "默认权限"}</span>
              </button>
              {showFullAccessWarning ? (
                <div className="chat-modal-backdrop" onClick={() => setShowFullAccessWarning(false)}>
                  <div className="chat-access-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-access-title" aria-describedby="chat-access-desc" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="chat-access-close" aria-label={t("close")} onClick={() => setShowFullAccessWarning(false)}>×</button>
                    <h3 id="chat-access-title" className="chat-access-title"><ChatPanelGlyph29 />{t("fullAccessTitle")}</h3>
                    <p id="chat-access-desc" className="chat-access-desc">{t("fullAccessDesc")}</p>
                    <div className="chat-access-capabilities">
                      <div><span className="chat-access-cap-icon" aria-hidden="true"><ChatPanelGlyph30 /></span><section><strong>{t("fileOperations")}</strong><p>{t("fileOperationsDesc")}</p></section></div>
                      <div><span className="chat-access-cap-icon" aria-hidden="true"><ChatPanelGlyph31 /></span><section><strong>{t("terminalCommands")}</strong><p>{t("terminalCommandsDesc")}</p></section></div>
                      <div><span className="chat-access-cap-icon" aria-hidden="true"><ChatPanelGlyph32 /></span><section><strong>{t("internetAccess")}</strong><p>{t("internetAccessDesc")}</p></section></div>
                    </div>
                    <div className="chat-access-actions"><button type="button" onClick={() => setShowFullAccessWarning(false)}>{t("cancel")}</button><button type="button" className="chat-access-confirm" onClick={() => { choosePermissionMode("full"); setShowFullAccessWarning(false); }}>{t("confirm")}</button></div>
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
          <div className="chat-tool-spacer" />
          {showContextUsage && !compareOnly ? (() => {
            // 优先用 SDK 返回的上下文上限（codebuddy 订阅走此路径），
            // 否则用 model 列表 meta.maxInputTokens（真实配置数据）
            const selMeta = modelOptions.find((o) => o.id === selectedModelId)?.meta;
            const metaMax = selMeta?.maxInputTokens;
            const maxFromMeta = (typeof metaMax === "number" && metaMax > 0) ? metaMax : null;
            const maxTokens = agentMode === "codebuddy" ? ctxUsage.maxTokens ?? maxFromMeta : null;
            return (
              <ContextMeter
                usedTokens={ctxUsage.usedTokens}
                maxTokens={maxTokens}
                compacting={ctxUsage.compacting}
                lastCompactAt={ctxUsage.lastCompactAt}
              />
            );
          })() : null}
          {/* 小屏时仅框架和模型选择移到上方；上下文用量留在底部操作行。 */}
          <div className="chat-toolbar-pickers">
          <div className="chat-pickers-row chat-pickers-model-row">
          {!split && agentModes.length > 0 && (compareOnly ? compareMode : agentMode) === "codebuddy" && modelSelectionEnabled && showModel && modelOptions.length ? (
            <ModelSelect options={modelOptions} value={compareOnly ? compareModelKey : selectedModel} iconOnNarrow onChange={compareOnly ? (key) => { setCompareModelKey(key); localStorage.setItem(`agent-kit:compare-model:${sessionId}:${compareMode}`, key); } : changeModel} />
          ) : null}
          {!split && !agentModesPending && agentModes.length === 0 ? (
            <button type="button" className="chat-model-error" onClick={() => window.dispatchEvent(new Event("launcher:open-compute-settings"))}>{t("noCompute")}</button>
          ) : !split && agentModes.length > 0 && agentMode !== "dsh" && !modelOptions.length && !codexModelOptions.length && modelsLoaded ? (
            <button type="button" className="chat-model-error" onClick={() => window.dispatchEvent(new Event("launcher:open-compute-settings"))}>{t("noComputeShort")}</button>
          ) : !split && agentModes.length > 0 && (compareOnly ? compareMode : agentMode) === "codebuddy" && !modelOptions.length && modelsLoaded ? <span className="chat-model-error" role="alert">{modelError}</span> : null}
          {!split && agentModes.length > 0 && !compareOnly && agentMode === "dsh" && showModel && dshModelOptions.length ? <ModelSelect options={dshModelOptions} value={selectedDshModel} onChange={setSelectedDshModel} iconOnNarrow /> : null}
          {!split && agentModes.length > 0 && (compareOnly ? compareMode : agentMode) === "codex" && showModel && codexModelOptions.length ? (
            <ModelSelect options={codexModelOptions} value={compareOnly ? compareModelKey : selectedCodexModel} iconOnNarrow onChange={(key) => {
              if (compareOnly) { setCompareModelKey(key); localStorage.setItem(`agent-kit:compare-model:${sessionId}:${compareMode}`, key); }
              else { setSelectedCodexModel(key); localStorage.setItem(`agent-kit:codex-model:${sessionId}`, key); }
            }} />
          ) : null}
          </div>
          {multiFramework && !split && agentModes.length > 1 ? (
            <div className="chat-pickers-row chat-pickers-framework-row">
              <ModelSelect showIcon={false} options={agentModes.filter((mode) => !compareOnly || mode !== "dsh").map((mode) => ({ id: mode, name: mode === "dsh" ? "DeepSeek Harness" : mode === "codex" ? "Codex" : "CodeBuddy" }))}
                value={compareOnly ? compareMode : agentMode} title={t("chooseFramework")} disabled={compareOnly ? compareBusy : busy} compact openOnHover onChange={(key) => {
                const mode = key as typeof agentMode;
                if (compareOnly) setCompareMode(mode as "codebuddy" | "codex");
                else { setAgentMode(mode); saveAgentMode(sessionId, mode); }
              }} />
            </div>
          ) : null}
          </div>
          </div>
          <div className="chat-toolbar-right">
          {/* 增强提示词：独立临时会话润色输入框文字 → 生成后变撤回按钮，点击还原原文。
              默认隐藏：仅当输入框有文字（或正在增强/已增强待还原）时显示；附件不参与增强。
              录音/转写/上传中不可用。
              tooltip 用自定义 data-tooltip 气泡（同消息操作条），不用系统 title。 */}
          {/* 「增强提示词」按钮已按产品要求隐藏：服务端 /api/prompt-enhance、父组件
              handleEnhancePrompt / enhanceOriginal / enhancing 逻辑全部保留，
              以后要恢复只需把这段按钮 JSX 加回来。 */}
          {recording ? (
            <span className="chat-voice-hint" aria-live="polite">
              <span className="chat-voice-dot" aria-hidden="true" />
              {Math.floor(recordingSeconds / 60)}:{String(recordingSeconds % 60).padStart(2, "0")} /{" "}
              {Math.floor(MAX_RECORDING_MS / 60000)}:{String((MAX_RECORDING_MS / 1000) % 60).padStart(2, "0")}
            </span>
          ) : null}
          {/* 可见麦克风按钮：受 showVoiceButton 控制（默认跟随 voiceEnabled，保持旧行为）。
              按住语音键录音转写由 onVoiceHoldStart 的 voiceEnabled 总开关决定，与此处解耦。 */}
          {(showVoiceButton ?? voiceEnabled) ? (
            <button
              type="button"
              className={`chat-voice ${recording ? "recording" : ""} ${transcribing ? "connecting" : ""}`}
              onClick={toggleVoiceInput}
              aria-label={transcribing ? "取消语音转写" : recording ? "结束录音" : "语音输入"}
              title={transcribing ? "取消语音转写" : undefined}
              aria-pressed={recording}
            >
              {transcribing ? (
                <span className="chat-voice-spinner" aria-hidden="true" />
              ) : recording ? (
                <span className="chat-voice-icon chat-voice-icon--stop" aria-hidden="true">
                  <ChatPanelGlyph33 />
                </span>
              ) : (
                <span className="chat-voice-icon">
                  <MicIcon />
                </span>
              )}
            </button>
          ) : null}
          {/* 主圆钮三态：语音模式→键盘切换；有内容→发送；语音可用且无内容→录音喇叭。
              语音关闭且无内容、非语音模式时不渲染（既不能录也不能发，避免无效按钮占位）。 */}
          {/* 固定 34×34 槽包裹主圆钮：录音/发送切换只换内部按钮，槽占位恒定，
              左侧「增强提示词」等按钮位置不跳动。 */}
          {!mobileActionIsStop && (mobileVoiceMode || mobileActionIsSend || voiceEnabled) ? (
          <div className="chat-mobile-action-slot">
          <button
            type="button"
            className={`chat-mobile-action${mobileVoiceMode ? " is-keyboard" : mobileActionIsSend ? " is-send" : " is-speaker"}`}
            onClick={mobileVoiceMode ? toggleMobileVoiceMode : mobileActionIsSend ? () => composerRef.current?.sendNow() : speakerClick}
            onPointerDown={!mobileVoiceMode && !mobileActionIsSend ? speakerDown : undefined}
            onContextMenu={(event) => event.preventDefault()}
            disabled={mobileVoiceMode ? false : mobileActionIsSend ? !canSend : dictation.state !== "idle"}
            aria-label={mobileVoiceMode ? "切换到键盘输入" : mobileActionIsSend ? "发送" : "轻点切换到按住说话，长按录音"}
            title={mobileVoiceMode ? "切换到键盘输入" : mobileActionIsSend ? "发送" : "轻点切换，长按录音"}
          >
            <span className="chat-mobile-action-icon chat-mobile-action-icon--speaker" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="4" cy="12" r="1.3" /><path d="M8 8a6 6 0 0 1 0 8M12 4a11 11 0 0 1 0 16" /></svg></span>
            <span className="chat-mobile-action-icon chat-mobile-action-icon--keyboard" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 19h16" /><circle cx="5" cy="7" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="15" cy="7" r="1" /><circle cx="20" cy="7" r="1" /><circle cx="5" cy="12" r="1" /><circle cx="10" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="20" cy="12" r="1" /></svg></span>
            <span className="chat-mobile-action-icon chat-mobile-action-icon--send" aria-hidden="true"><ChatPanelGlyph35 /></span>
          </button>
          </div>
          ) : null}
          {(compareOnly ? compareBusy : busy || (split && compareBusy)) ? (
            <button
              type="button"
              className="chat-send chat-send--stop chat-send--desktop"
              onClick={cancelGeneration}
              aria-label={t("stopGeneration")}
            >
              <ChatPanelGlyph34 />
            </button>
          ) : (
            <button
              type="button"
              className="chat-send chat-send--desktop"
              onClick={() => composerRef.current?.sendNow()}
              disabled={!canSend}
              aria-label={modelSendBlocked ? "模型加载中，暂不可发送" : uploading ? "附件上传中，暂不可发送" : "发送"}
            >
              <ChatPanelGlyph35 />
            </button>
          )}
          </div>
        </ChatToolbar>
      </ChatInputArea>
      </div>
      </div>
      </div>
  )}{shareToChatOpen ? <ShareToChatDialog basePath={basePath} sourceSessionId={activeSid} sessions={sessions} onClose={() => setShareToChatOpen(false)} /> : null}</>;
}
