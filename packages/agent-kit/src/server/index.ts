/**
 * agent-kit · 入口
 * 服务端 SDK：基于 CodeBuddy Agent SDK 的订阅式对话封装（模型默认 hy3），
 * 外加即插即用的 Next.js 端点工厂（对话/上传/语音）。
 */

export { runSdkQuery, createAgentStream, createAgentSessionStream, defaultCanUseTool, withSessionDirGuard, withSandboxBoundary, FILE_TOOLS, WEB_DISALLOWED_TOOLS, resolvePendingAsk, steerSession, closeSession, AGENT_SERVICE_UNAVAILABLE, WEB_FETCH_TOOL_NAME, buildCapabilitiesPrompt } from "./sdk.js";
export type { SdkConfig, AppCapability } from "./sdk.js";
export type { AppMcpServer, AppMcpServers } from "./mcp-config.js";
export { collectAgentText, getAgentAdapter, getConfiguredAgentModes, resolveAgentMode } from "./agent-runtime.js";
export type { AgentMode, AgentAdapter, AgentCapabilities, AgentRequest, AgentMessage } from "./agent-runtime.js";
export { attachResumableRun, cancelResumableRun, hasResumableRun, startResumableRun, validRunId } from "./run-journal.js";
// 会话访问控制（安全隔离）：登录用户 DB 归属
export { assertSessionAccess, assertChatAccess } from "./session-access.js";
export type { SessionAccessKind } from "./session-access.js";
export { Agent, createAgent } from "./agent.js";
export type { AgentConfig } from "./agent.js";
export { createWebFetchMcpServer, WebFetchService } from "./web-fetch.js";
export type { WebFetchOptions, WebFetchResult, WebFetchImage } from "./web-fetch.js";
export { createBrowserAgentMcpServer, BROWSER_AGENT_TOOL_NAME, BrowserAgentService } from "./browser-agent-mcp.js";
export type { BrowserTaskResult } from "./browser-agent-mcp.js";
// 产物读取（Electron 本地版等非 Next.js 宿主复用）：按会话隔离读文件 / 列产物清单
export { readArtifact, listSessionArtifacts, mimeFor, ensureSessionDir } from "./artifacts.js";
export { byteRange } from "./byte-range.js";
// 模型调用重试（服务端无界面模块）：群 AI / 伴聊 / agent-kit 内部复用，按 none/low/high 传参
export { retryPolicy, withRetry, isRetryableError, RetryableError } from "./retry-policy.js";
export type { RetryLevel, RetryPolicy } from "./retry-policy.js";
// 端点工厂：第三方 Next.js 应用一行引入即可复用 chat/upload/voice 端点
export {
  createChatHandler,
  createChatRunHandler,
  createChatAnswerHandler,
  createChatSteerHandler,
  createBrowserAnswerHandler,
  createVoiceTokenHandler,
  createVoiceTranscribeHandler,
  agentKitHandlers,
  createAgentApiRoute,
  createArtifactHandler,
} from "./handlers.js";
export type { AgentKitHandlersOptions, VoiceHandlerOptions } from "./handlers.js";
// 统一 API 路由工厂：单 catch-all 挂载全部端点（对话/会话/分享/认证），应用端零新增代码
export { createAgentKitApi } from "./kit-api.js";
export { installRealtimeGateway } from "./realtime.js";
export { installTerminalGateway } from "./terminal.js";
// 预览静态资源跨站保护修复（custom server 接入点）：内嵌 WebView 打开预览时
// 剥离 Sec-Fetch-*/Origin/Referer，绕过 Next dev 15.5+ 的默认 403，样式/交互正常。
export { withPreviewHeaderStrip } from "./preview-gateway.js";
export type { PreviewHeaderStripOptions } from "./preview-gateway.js";
export type { AgentKitApiOptions } from "./kit-api.js";
export { createUploadHandler } from "./upload.js";
export type { UploadOptions } from "./upload.js";
// 提示词增强（输入框「增强提示词」按钮）：独立一次性临时会话，thinking 关闭、无工具
export { createPromptEnhanceHandler } from "./prompt-enhance.js";

// 模型来源解析（通用能力）：CodeBuddy 登录态与 models.json
export { getAvailableCodeBuddyModels, getCodeBuddyModelGroups, getConfiguredCodeBuddyModels, getModelOptions, readCodeBuddyModels, getDefaultModel, isModelSelectEnabled, isCodeBuddyAuthenticated, codeBuddyAuthEnvironment } from "./model-sources.js";
export { resolveModelsFile, modelsFileSignature } from "./models-file.js";
export type { ModelsFileSignature } from "./models-file.js";
// 应用主目录（~/.<app 名>，未指定时 ~/.agent）：宿主通过 AGENT_APP_NAME 声明自己的名字
export { DEFAULT_APP_HOME_NAME, declaredAppName, appHomeName, appHomeDirName, appHomeDir, appHomePath } from "./app-home.js";
// 算力提供商（框架）认证：WorkBuddy 的登录态 / 发起登录 / 登出，宿主只管「打开哪个网址」
export { getWorkBuddyAuthStatus, loginWorkBuddy, logoutWorkBuddy } from "./provider-auth.js";
export type { ProviderAccount, ProviderAuthStatus, ProviderLoginOptions, ProviderLoginResult } from "./provider-auth.js";
export { transcribeVoice } from "./voice.js";
export type { ServerModelOption } from "./model-sources.js";
export { getCodexModelOptions, fetchCodexModelOptions } from "./codex-models.js";
export { getCodexCliPath } from "./codex-cli.js";

// 认证（钉钉 / 飞书），可复用：抽象层 + 具体实现 + 路由工厂 + 用户持久化
export * from "./auth/index.js";
// 会话管理（侧边栏会话列表增删改查）
export { createSessionHandlers, summarizeSessionTitle } from "./sessions.js";
// 会话分享（外部只读访问 + 发送到 OA）
export { createShareHandlers } from "./share.js";
export type { ShareHandlers } from "./share.js";
// 用户文件区（以登录用户 id 为目录名的用户可操作区：浏览/上传/下载/新建/重命名/删除）
export { createUserFilesHandlers, userFilesRoot, userKeyFor, safeUserFilePath } from "./user-files.js";
export type { UserFileEntry } from "./user-files.js";
