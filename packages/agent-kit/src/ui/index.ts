"use client";

/**
 * agent-kit · 入口
 * workbuddy 风格聊天 UI SDK（自 hotline 项目拷贝改造）。
 * 组件全部参数化：basePath / scenes / 端点 / 标题均可由宿主配置。
 *
 * 快速开始（一站式）：<AgentApp basePath="/linger" title="AI 助手" />
 * 高级用法：<AgentChat {...props} /> + <LoginPage /> + useAgentAuth() 自行拼装。
 */
export { default as AgentWindow, DEFAULT_SCENES } from "./AgentWindow.tsx";
export { default as CustomModels, desktopModels } from "./components/CustomModels.tsx";
export { CHAT_MIN_WIDTH } from "./shared/layout.ts";
export { openWorkPanelSurface, recordSessionWorkflow } from "./chat/workPanel.ts";
export { useAppFullscreen } from "./components/FullscreenContext.tsx";
export type { AppFullscreen } from "./components/FullscreenContext.tsx";
export type { WorkPanelSurface, SessionWorkflow } from "./chat/workPanel.ts";
export { ContentPanel, ContentPage } from "./components/ContentPanel.tsx";
export type { ContentPanelProps } from "./components/ContentPanel.tsx";
export type {
  ArtifactMeta,
  ArtifactType,
  ChatUser,
  AgentWindowProps,
  ComposerReference,
  ComposerReferenceSource,
  ModelInfo,
  QueueItem,
  RtState,
  Scene,
  SessionCardSnapshot,
  SessionItem,
  UiAttachment,
  UiImage,
  UiMessage,
  UiQuestion,
  UiQuestionOption,
  UiStep,
  UiTool,
} from "./AgentWindow.tsx";
export { default as ChatPanel } from "./panel/ChatPanel.tsx";
export type { ChatPanelProps } from "./panel/ChatPanel.tsx";
export { default as OperationPanel } from "./panel/OperationPanel.tsx";
export type { OperationPanelProps } from "./panel/OperationPanel.tsx";
// Finder 风格文件管理器（图标/列表/分栏三视图）：会话产物面板在用，也供宿主把本机目录喂进去复用。
export { default as ArtifactFileManager } from "./components/artifact-file-manager/ArtifactFileManager.tsx";
export { ARTIFACT_FILE_MIME } from "./components/artifact-file-manager/ArtifactFileManager.tsx";
export { readArtifactFileDragItems } from "./shared/artifactFileDrag.ts";
export type { ArtifactFileManagerProps, ArtifactFileDragItem, FileView } from "./components/artifact-file-manager/ArtifactFileManager.tsx";
// 对话列表面板；内容区域由 ContentPanel 装载。
export { default as ConversationPanel } from "./panel/ConversationPanel.tsx";
export type { ConversationPanelProps } from "./panel/ConversationPanel.tsx";
export { NavigationSidebar, hasSidebar, resolveSidebar, sidebarEntry } from "./components/NavigationSidebar.tsx";
export type { SidebarEntry, SidebarIconState, SidebarItem } from "./components/NavigationSidebar.tsx";
export { default as Markdown } from "./components/Markdown.tsx";
export { relativeTime } from "./shared/relativeTime.ts";
export { default as SessionPickerDialog } from "./components/SessionPickerDialog.tsx";
export type { SessionPickerDialogProps, SessionPickerEntry } from "./components/SessionPickerDialog.tsx";
export type { MarkdownProps } from "./components/Markdown.tsx";
export { default as FeedbackButtons } from "./components/FeedbackButtons.tsx";
export { default as ModelSelect } from "./components/ModelSelect.tsx";
export { modelOptionKey } from "./components/ModelSelect.tsx";
export type { ModelOption, ModelMeta } from "./components/ModelSelect.tsx";
// 模型图标（有 meta.iconUrl 用图、没有用兜底立方体）：宿主自建模型列表时也复用同一套外观。
export { ModelIcon } from "./components/ModelIcon.tsx";
export type { ModelIconProps } from "./components/ModelIcon.tsx";
export { voiceHoldKeyLabel, voiceHoldKeyAriaLabel } from "./shared/platform.ts";
export type { AgentHostApi } from "./chat/platform.ts";
// 通知摘要：宿主自建系统通知（如 Electron 主进程 Notification）时复用同一套清洗/截断规则。
export { summarizeForNotify } from "./chat/platform.ts";
export { default as MessageSlider } from "./components/MessageSlider.tsx";
// 聊天输入框本体（textarea + autoGrow + IME + 草稿防抖），供宿主自组输入区
export { default as ChatComposer } from "./components/ChatComposer.tsx";
export type { ChatComposerHandle, ChatComposerProps } from "./components/ChatComposer.tsx";
export { ChatToolbar } from "./components/ChatToolbar.tsx";
export { ChatTranscript } from "./components/ChatTranscript.tsx";
export type { ChatTranscriptMessage, ChatTranscriptProps } from "./components/ChatTranscript.tsx";
export { quickSessionTitle } from "./chat/quickTitle.ts";
export { ChatTopBar } from "./components/ChatTopBar.tsx";
export type { ChatTopBarProps } from "./components/ChatTopBar.tsx";
// 用户设置菜单（用户区弹层：外观 / 通知提示音 / 上下文使用量 / 模型 / 语音 / 自定义模型 / 记忆管理 / 版本 / 退出登录）
export { default as UserMenu } from "./components/UserMenu.tsx";
export type { UserMenuProps } from "./components/UserMenu.tsx";
// 主题工具（UserMenu「外观」segment 依赖；宿主自持状态时用 readTheme / applyTheme 持久化）
export { readTheme, applyTheme, initTheme } from "./shared/theme.ts";
export type { ThemeMode } from "./shared/theme.ts";
// 界面显示偏好（多框架 / 模型 / 上下文用量）：与 kit UserMenu 里的开关共用同一份 localStorage + 事件，
// 宿主的设置面板（如「算力」设置页）读写同一 key 即可实时联动所有聊天窗。
export { MULTI_FRAMEWORK_KEY, readMultiFramework, subscribeUiPrefs, writeMultiFramework } from "./shared/uiPrefs.ts";
// 会话外部更新广播（桌面卡片重发等跨实例同步用）
export { AGENT_SESSION_UPDATED_EVENT } from "./shared/drafts.ts";
// 弹层统一抽象：点击自身之外任意处关闭（右键菜单 / 更多菜单 / 下拉共用）
export { useClickOutside } from "./useClickOutside.ts";
export type { UseClickOutsideOptions } from "./useClickOutside.ts";
export { Dismissable } from "./components/Dismissable.tsx";
export type { DismissableProps } from "./components/Dismissable.tsx";
// 应用级装配件：登录态 hook / 登录页 / 钉钉免登 / 一站式入口
export { useAgentAuth } from "./useAgentAuth.ts";
export type { AuthState } from "./useAgentAuth.ts";
export { LoginPage } from "./components/LoginPage.tsx";
export type { LoginPageProps, LoginProviderOption } from "./components/LoginPage.tsx";
export { DingTalkAutoLogin } from "./components/DingTalkAutoLogin.tsx";
export { AgentApp } from "./AgentApp.tsx";
export { useChatSession } from "./chatSession.tsx";
export type { AgentAppProps } from "./AgentApp.tsx";
// 通道无关的宿主能力注册表（chat/cowork 统一触发，承接报销及未来 skill/MCP）
export {
  buildCapabilitiesContext,
  dispatchCapabilityReply,
  renderCapabilityCards,
  toCapMessage,
  toCapMessages,
} from "./capabilities/index.tsx";
export type {
  HostCapability,
  CapChannel,
  CapMessage,
  CapAttachment,
  CapContextArgs,
} from "./capabilities/index.tsx";
export { createSideChat } from "./side-chat.ts";
export type { SideChatClient, SideChatEvent, SideChatMessage, SideChatOptions, SideChatResult } from "./side-chat.ts";
export { SideChat } from "./components/SideChat.tsx";
export type { SideChatProps } from "./components/SideChat.tsx";
// admin 用量分析页（token 消耗去向，暂不鉴权）
export { default as AdminUsage } from "./components/AdminUsage.tsx";
export type { AdminUsageProps } from "./components/AdminUsage.tsx";
// admin 管理控制台（侧边树状菜单：基本设置 / 算力统筹 / 用户反馈）
export { AdminConsole } from "./admin/AdminConsole.tsx";
export type { AdminConsoleProps } from "./admin/AdminConsole.tsx";
export type { AdminSettings, SkillItem, ConnectorItem } from "./admin/types.ts";

// SVG 图标组件：全部暴露给宿主应用（页面 glyph、按钮、文件类型、平台图标、工具图标等）。
// 必须经由公共入口导出，宿主通过包名 alias 消费 agent-kit 时才能正确解析，
// 不能让用户去 import 包内部的 src 相对路径。用 export * 批量转发，新增图标无需再手动加出口。
export * from "./icons/ActionIcons.tsx";
export * from "./icons/DynamicIcons.tsx";
export * from "./icons/FileTypeIcons.tsx";
// FileTypeIcon 是 default 导出，export * 不会转发，需单独转出
export { default as FileTypeIcon } from "./icons/FileTypeIcons.tsx";
// 知名模型的品牌字形（自绘单色剪影）+ 品牌匹配函数：宿主自建模型列表时与 ModelIcon 同一套外观
export * from "./icons/ModelBrandIcons.tsx";
export * from "./icons/PageIcons.tsx";
export * from "./icons/PlatformIcons.tsx";
export * from "./icons/SharedIcons.tsx";
export { UserIcon } from "./icons/SharedIcons.tsx";
export * from "./icons/ToolIcons.tsx";

// 通用头像组件（有图用图、无图用姓名兜底；兜底字号随尺寸换算，避免文字贴圆边）
export { Avatar } from "./shared/AvatarView.tsx";
export type { AvatarProps } from "./shared/AvatarView.tsx";
export { ChatLocaleProvider } from './chat/i18n.tsx';
