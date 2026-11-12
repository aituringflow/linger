import {
  createContext,
  useContext,
} from "react";
import type { Dispatch, SetStateAction, RefObject } from "react";
import type {
  ArtifactMeta,
  ArtifactType,
  ChatUser,
  ComposerReference,
  ComposerReferenceSource,
  GroupRef,
  ModelInfo,
  QueueItem,
  RtState,
  Scene,
  SceneSuggestion,
  SessionItem,
  UiAttachment,
  UiMessage,
  UiQuestion,
  UiVoiceRecording,
} from "./chat/types.ts";
import type { HostCapability } from "./capabilities/index.tsx";
import type { ShareState } from "./chat/platform.ts";
import type { CompareSubmission } from "./components/ComparePane.tsx";
import type { ModelMeta } from "./components/ModelSelect.tsx";
import type { ChatComposerHandle } from "./components/ChatComposer.tsx";

/**
 * 会话运行层：与布局无关的聊天会话状态与操作集合。
 *
 * 由 AgentWindow（或任意宿主）通过 <ChatSessionContext.Provider> 注入，
 * ChatPanel / 应用自定义的三栏组合通过 useChatSession() 消费同一套能力，
 * 避免每个 panel 各自实现消息流、流式请求、草稿与产物。
 */
export interface ChatSessionValue {
  // ---- 会话与消息 ----
  sessions: SessionItem[];
  sessionsRef: RefObject<SessionItem[]>;
  setMessages: Dispatch<SetStateAction<UiMessage[]>>;
  messages: UiMessage[];
  activeSidRef: RefObject<string>;
  sessionId: string;
  currentSessionTitle: string;
  currentSessionError: string;
  contentLoading: boolean;
  loadingSessionId: string | null;
  booting: boolean;
  busy: boolean;
  serverOnline: boolean;
  connDetail: { http: boolean; ws: boolean };
  retrying: boolean;
  isLoggedIn: boolean;
  isEmptyView: boolean;
  queueNotice: string;
  steerInFlight: Set<string>;
  pendingQueue: QueueItem[];
  getRt: (sid: string) => RtState;
  markBusy: (sid: string, value: boolean) => void;
  setSessionAuxErrors: Dispatch<SetStateAction<Record<string, string>>>;
  setVoiceError: (message: string) => void;
  activeQuestion: { messageIdx: number; stepIdx: number; questions: UiQuestion[] } | null;
  branching: boolean;
  setBranchError: Dispatch<SetStateAction<string>>;
  setBranchTarget: Dispatch<SetStateAction<{ sid: string; index: number; messageId?: number; title: string; snapshot: UiMessage[] } | null>>;
  dictation: {
    state: "idle" | "recording" | "transcribing";
    elapsedSec: number;
    amplitude: number;
    start: () => void;
    stop: () => void | Promise<unknown>;
    cancel: () => void;
    setFinishIntent: (intent: "send" | "cancel") => void;
  };
  cancelArmed: boolean;
  handleDraftSave: (text: string) => void;
  resolveFileUrl: (url: string | undefined | null, fileId?: string) => string;
  retryConnection: () => void;

  // ---- 运行操作 ----
  send: (
    text?: string,
    att?: UiAttachment[] | null,
    recovery?: { sid: string; runId: string; sdkSid: string; mode: NonNullable<ModelInfo["agentMode"]> },
    voice?: UiVoiceRecording,
    extraPrompt?: string | null,
    queuedReferences?: Array<{ sourceId: string; reference: ComposerReference }>,
  ) => Promise<unknown>;
  handleSend: (text: string, voice?: UiVoiceRecording) => void;
  switchSession: (id: string, sessionOverride?: SessionItem, navigate?: boolean) => Promise<unknown>;
  /** 新建会话（生成新 sid，不 abort 旧流）；与点侧栏「新建」/Ctrl+N 同路径 */
  newSession: (navigate?: boolean) => string;
  /** 收起左右面板（会话初始化用，不写全局偏好：收起的 500ms 内跳过面板状态持久化） */
  collapsePanelsForNewChat: () => void;
  refreshSessions: () => Promise<unknown>;
  cancelGeneration: () => void;
  steerQueueItem: (item: QueueItem) => Promise<void>;
  editQueueItem: (item: QueueItem) => void;
  removeQueueItem: (item: QueueItem) => void;
  regenerateFrom: (messageIdx: number) => Promise<void>;
  submitAnswer: (messageIdx: number, stepIdx: number, answerText: string, answers: Record<string, string>) => Promise<void>;
  submitBrowserAnswer: (browserId: string, text: string) => Promise<void>;
  browserAskText: string;
  setBrowserAskText: Dispatch<SetStateAction<string>>;
  editingIdx: number | null;
  setEditingIdx: Dispatch<SetStateAction<number | null>>;
  editingText: string;
  setEditingText: Dispatch<SetStateAction<string>>;
  setEditingWidth: Dispatch<SetStateAction<number | null>>;
  enhancing: boolean;
  enhanceOriginal: string | null;
  handleEnhancePrompt: () => Promise<void>;
  downloadMessageFile: (f: UiAttachment) => void;
  openInputFile: (f: UiAttachment) => Promise<void>;
  toggleThinking: (openKey: string) => void;
  toggleFoldProcess: (msgIndex: number) => void;
  foldedProcess: Set<number>;
  openThinking: Set<string>;
  msgVotes: Record<number, "up" | "down" | null>;
  setMsgVotes: Dispatch<SetStateAction<Record<number, "up" | "down" | null>>>;
  messageMoreIdx: number | null;
  setMessageMoreIdx: Dispatch<SetStateAction<number | null>>;
  copiedIdx: number | null;
  setCopiedIdx: Dispatch<SetStateAction<number | null>>;
  scrollToMsg: (i: number, behavior?: ScrollBehavior) => void;
  activeSid: string;
  historyLoadError: string | null;
  localOwner: string;
  editingWidth: number | null;

  // ---- 场景 / 模型 / 框架 ----
  scene: string | null;
  setScene: Dispatch<SetStateAction<string | null>>;
  allScenes: Scene[];
  activeScene: Scene | null;
  agentMode: "codebuddy" | "codex" | "cc" | "dsh";
  setAgentMode: Dispatch<SetStateAction<"codebuddy" | "codex" | "cc" | "dsh">>;
  agentModes: ("codebuddy" | "codex" | "dsh")[];
  agentModesPending: boolean;
  modelOptions: Array<{ id: string; name?: string; meta?: ModelMeta }>;
  codexModelOptions: Array<{ id: string; name?: string; meta?: ModelMeta }>;
  dshModelOptions: Array<{ id: string; name?: string }>;
  selectedDshModel: string;
  setSelectedDshModel: Dispatch<SetStateAction<string>>;
  selectedModel: string;
  setSelectedCodexModel: Dispatch<SetStateAction<string>>;
  selectedCodexModel: string;
  selectedModelId: string;
  modelsLoaded: boolean;
  modelError: string | null;
  modelSelectionEnabled: boolean;
  autoFetchModels: boolean;
  changeModel: (key: string) => void;
  modelSendBlocked: boolean;
  showModel: boolean;
  setShowModel: (value: boolean) => void;
  multiFramework: boolean;
  compareMode: "codebuddy" | "codex";
  setCompareMode: Dispatch<SetStateAction<"codebuddy" | "codex">>;
  compareModelKey: string;
  setCompareModelKey: Dispatch<SetStateAction<string>>;
  compareBusy: boolean;
  setCompareBusy: Dispatch<SetStateAction<boolean>>;
  compareSubmission: CompareSubmission | null;
  setCompareSubmission: Dispatch<SetStateAction<CompareSubmission | null>>;
  split: boolean;
  setSplit: Dispatch<SetStateAction<boolean>>;
  compareOnly: boolean;
  setCompareOnly: Dispatch<SetStateAction<boolean>>;
  setDiffView: Dispatch<SetStateAction<{ sid: string; activeId: string } | null>>;
  saveViewLayout: (layout: "single" | "split" | "compare") => void;
  closeSplitView: (side: "left" | "right") => void;
  compareCancelSeq: number;
  compareFrameworkName: string;
  compareModelChoices: Array<{ key: string; label?: string }>;
  currentCompareModelName: string;
  currentMobileModelName: string;
  mobileFrameworkName: string;
  mobileModelChoices: Array<{ key: string; label?: string }>;
  mobileVoiceMode: boolean;
  setMobileVoiceMode: Dispatch<SetStateAction<boolean>>;
  toggleMobileVoiceMode: () => void;
  mobileHolding: boolean;
  setMobileHolding: Dispatch<SetStateAction<boolean>>;
  mobileCancelArmed: boolean;
  setMobileCancelArmed: Dispatch<SetStateAction<boolean>>;
  mobileActionIsSend: boolean;
  mobileActionIsStop: boolean;
  voiceSendPendingRef: RefObject<boolean>;
  canSend: boolean;
  composerHasInput: boolean;
  toggleVoiceInput: () => void;
  speakerClick: () => void;
  speakerDown: (event: React.PointerEvent<HTMLElement>) => void;
  holdAreaDown: (event: React.PointerEvent<HTMLElement>) => void;
  transcribing: boolean;
  recording: boolean;
  setRightCtrlRecording: Dispatch<SetStateAction<boolean>>;
  rightCtrlRecording: boolean;
  rightCtrlVoice: boolean;
  voiceRealtimeTranscription: boolean;
  startRealtimeVoice: () => Promise<boolean>;
  stopRealtimeVoice: () => Promise<void>;
  /** 实时转写振幅 ref（由宿主注入，onAmplitude 每帧写）：输入框声波读它。 */
  voiceAmplitudeRef?: { current: number };
  toolbarCompact: number;
  setWsMenuOpen: Dispatch<SetStateAction<boolean>>;
  wsMenuOpen: boolean;

  // ---- 附件 / 引用 / 草稿 ----
  attachments: UiAttachment[];
  setComposerReferences: Dispatch<SetStateAction<Array<{ sourceId: string; reference: ComposerReference }>>>;
  composerReferences: Array<{ sourceId: string; reference: ComposerReference }>;
  composerHasText: boolean;
  setComposerHasText: Dispatch<SetStateAction<boolean>>;
  setComposerHasInput: Dispatch<SetStateAction<boolean>>;
  activeAttachments: Array<UiAttachment | { id: string; name: string; size?: number; file: File; previewUrl?: string; progress: number }>;
  clearAttachment: (index?: number) => void;
  addRef: (ref: GroupRef) => void;
  removeRef: (id: string) => void;
  uploading: boolean;
  visionWarning: string | null;
  composerRef: RefObject<ChatComposerHandle | null>;
  fileRef: RefObject<HTMLInputElement | null>;
  pendingFiles: Array<{ id: string; name: string; size?: number; file: File; previewUrl?: string; progress: number }>;
  inputFilePreview: { url: string; name: string; type: ArtifactType } | null;
  setInputFilePreview: Dispatch<SetStateAction<{ url: string; name: string; type: ArtifactType } | null>>;
  dragOver: boolean;
  setDragOver: Dispatch<SetStateAction<boolean>>;
  referenceMenuOpen: boolean;
  setReferenceMenuOpen: Dispatch<SetStateAction<boolean>>;
  localRefOpenMsg: string;
  setLocalRefOpenMsg: Dispatch<SetStateAction<string>>;
  localRefKinds: Record<string, "file" | "folder">;
  localRefAvailability: Record<string, boolean>;
  knownProjects: Array<{ dir: string; updatedAt: string }>;

  // ---- 群聊 / 邀请 / 提及 ----
  coworkActive: boolean;
  conversationMembers: Array<{ provider: string; contactId: string; name: string; avatar: string; sub?: string }>;
  conversationOwnerSub: string;
  selfSub: string;
  pendingMembers: Array<{ provider?: string; contactId: string; name: string; avatar: string }>;
  setPendingMembers: Dispatch<SetStateAction<Array<{ provider?: string; contactId: string; name: string; avatar: string }>>>;
  pendingMembersRef: RefObject<HTMLDivElement | null>;
  visiblePendingMembers: number;
  openInvite: () => void;
  pendingMentionOptions: Array<{ id: string; name: string; avatar?: string }>;
  pendingMentionActive: boolean;
  homeMentionFilter: "all" | "contacts" | "groups";
  setHomeMentionFilter: Dispatch<SetStateAction<"all" | "contacts" | "groups">>;
  showHomeMentionFilter: boolean;
  pendingMentionIndex: number;
  setPendingMentionIndex: Dispatch<SetStateAction<number>>;
  choosePendingMention: (name: string, id?: string) => void;
  homeSelectedChips: Array<{ id: string; name: string; avatar: string }>;
  onRemoveHomeRecipient: (id: string) => void;
  onPendingValueChange: (value: string, selectionStart: number) => void;
  onHomeUserValueChange?: (value: string, selectionStart: number) => void;
  trackHomeMentions: boolean;
  homeGroupRecipients: Array<{ contactId: string; name: string; avatar: string }>;
  onPendingEnter: () => boolean;
  onPendingKeyDownIntercept: (key: string) => boolean;
  pendingMentionRefs: RefObject<Array<HTMLElement | null>>;
  openFeishuChat: (openChatId: string) => Promise<void>;

  // ---- 搜索 / 分享 ----
  searchOpen: boolean;
  searchQuery: string;
  searchIdx: number;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  searchHits: number[];
  goSearch: (delta: number) => void;
  closeSearch: () => void;
  shareOpen: boolean;
  shareLoading: boolean;
  shareSending: boolean;
  shareSendMsg: string;
  shareError: string;
  copiedLink: boolean;
  shareState: ShareState | null;
  sharePopupPosition: { top: number; left: number };
  shareButtonRef: RefObject<HTMLButtonElement | null>;
  sharePopupRef: RefObject<HTMLDivElement | null>;
  moreButtonRef: RefObject<HTMLButtonElement | null>;
  moreMenuRef: RefObject<HTMLDivElement | null>;
  toolbarCenterRef: RefObject<HTMLDivElement | null>;
  moreOpen: boolean;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
  openShare: () => Promise<void>;
  copyShareLink: () => Promise<void>;
  openShareInBrowser: () => void;
  chooseAndSend: (share?: ShareState) => Promise<void>;
  setShareSendMsg: Dispatch<SetStateAction<string>>;

  // ---- 会话管理 / 工作区 ----
  activeNavigation: string;
  hasNavigation: boolean;
  conversationView: boolean;
  selectNavigation: (item: string, navigate?: boolean) => void;
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  toggleSidebar: () => void;
  openSidebarHover: () => void;
  closeSidebarHover: () => void;
  isMobileViewport: boolean;
  rightShown: boolean;
  openMobileWorkPage: (page: "settings" | "artifacts" | "chatmate" | "monologue") => void;
  setMobilePicker: Dispatch<SetStateAction<"framework" | "model" | "compare-framework" | "compare-model" | null>>;
  setRightOpen: Dispatch<SetStateAction<boolean>>;
  openArtifactList: (id: string) => void;
  ctxUsage: { usedTokens: number | null; maxTokens: number | null; compacting: boolean; lastCompactAt: number | null };
  showContextUsage: boolean;
  notifyBanner: boolean;
  setNotifyBanner: Dispatch<SetStateAction<boolean>>;
  permissionMode: "default" | "full";
  choosePermissionMode: (mode: "default" | "full") => void;
  showFullAccessWarning: boolean;
  setShowFullAccessWarning: Dispatch<SetStateAction<boolean>>;
  /** 锁定「完全访问」：不渲染输入框内的权限切换按钮，权限恒为 full。 */
  permissionLocked?: boolean;
  setJumpHighlightId: Dispatch<SetStateAction<number | null>>;
  jumpHighlightId: number | null;

  // ---- 截图 / 工作区 ----
  recentScreenshot: { id: string; name: string; thumbnail: string } | null;
  setRecentScreenshot: Dispatch<SetStateAction<{ id: string; name: string; thumbnail: string } | null>>;
  screenshotHoveredRef: RefObject<boolean>;
  screenshotTimerRef: RefObject<ReturnType<typeof setTimeout> | null>;
  addRecentScreenshot: () => Promise<void>;
  preview: { sid: string; meta: ArtifactMeta } | null;
  setPreview: Dispatch<SetStateAction<{ sid: string; meta: ArtifactMeta } | null>>;
  previewFull: boolean;
  setPreviewFull: Dispatch<SetStateAction<boolean>>;
  pickingWorkspace: boolean;
  workspaceDir: string | null;
  openWorkspacePopup: () => void;
  pickWorkspaceFromPopup: () => Promise<void>;
  clearWorkspace: () => void;
  applyWorkspace: (dir: string | null, sid?: string) => Promise<void>;

  // ---- 宿主配置（透传）----
  embedded: { temporary?: boolean; emptyMessage?: string } | undefined;
  embeddedMode: boolean;
  composerPlaceholder: string | undefined;
  emptyMessage: string | undefined;
  basePath: string;
  chatEndpoint: string | undefined;
  sidebar: unknown;
  renderSessionFooter: ((context: { sessionId: string; messages: readonly UiMessage[] }) => React.ReactNode) | undefined;
  sessionFooterVisibility: "always" | "after-response" | undefined;
  sessionFooterAppearing: boolean | undefined;
  capabilities: HostCapability[] | undefined;
  reconnectAttempt: number;
  recordingSeconds: number;
  renderSuggestion: (s: SceneSuggestion) => React.ReactNode;
  navigationKeys: string[];
  title: string;
  voiceEnabled: boolean;
  onComposerTextPresenceChange: ((hasText: boolean) => void) | undefined;
  /** 输入框「有内容」（文字**或**附件）—— 宿主判断预览浮层该不该收起时用这个。 */
  onComposerContentPresenceChange: ((hasContent: boolean) => void) | undefined;
  referenceSources: readonly ComposerReferenceSource[];
  refs: GroupRef[];
  onAttachClick: () => void;
  onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** 把一批文件作为附件上传（文件选择/拖拽/剪贴板粘贴图片共用此入口） */
  uploadFiles: (files: File[]) => void | Promise<void>;
  fillSuggestionPromptRef: RefObject<string | null>;
  notifyBannerDismissedRef: RefObject<boolean>;
  onQueueDragStart: (e: React.DragEvent, item: QueueItem) => void;
  onQueueDragOver: (e: React.DragEvent, item: QueueItem) => void;
  onQueueDrop: (e: React.DragEvent) => void;
  onQueueDragEnd: () => void;
  dirName: (p: string) => string;
  localChat: unknown;
  localFiles: unknown;
  initialUser: ChatUser | undefined;
  isDesktopApp: () => boolean;
  IS_ELECTRON: boolean;
  uploadEnabled: boolean;
  logoSrc: string | null;

  // ---- 滚动 ----
  bodyRef: RefObject<HTMLDivElement | null>;
  bindBodyRef: (node: HTMLDivElement | null) => void;
  spacerRef: RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  jumpToBottom: () => void;
  onUserScrollIntent: (deltaY: number) => void;
}

export const ChatSessionContext = createContext<ChatSessionValue | null>(null);

export function useChatSession(): ChatSessionValue {
  const value = useContext(ChatSessionContext);
  if (!value) {
    throw new Error("useChatSession must be used within a ChatSessionContext provider (e.g. inside AgentWindow).");
  }
  return value;
}
