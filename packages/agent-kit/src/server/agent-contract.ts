/** Application-facing contract; no agent SDK types cross this boundary.
 * Adapters emit the shared SSE vocabulary: text = final answer, thinking =
 * visible progress/reasoning summary, tool/tool_result = tool activity.
 * An SDK's private reasoning is never inferred or exposed. */
export type AgentMode = "codebuddy" | "codex" | "cc" | "dsh";
export type AgentImage = { url?: string; base64?: string; media_type?: "image/jpeg" | "image/png" | "image/gif" | "image/webp" };
export type AgentMessage = { role: string; content: string; images?: AgentImage[] };
export type AgentRunConfig = {
  groupBash?: { sessionId: string; basePath: string; previewToken: string; origin: string };
  groupAgentTools?: import("./sdk.js").SdkConfig["groupAgentTools"];
  mcpServers?: import("./mcp-config.js").AppMcpServers;
  allowedTools?: string[];
  webFetch?: boolean;
  browserAgent?: boolean;
  memoryServer?: ReturnType<typeof import("./memory.js").createMemoryMcpServer>;
  memoryOwner?: string;
  memoryExplicit?: boolean;
  model?: string;
  env?: Record<string, string | undefined>;
  /** Electron hosts can run the SDK CLI through their own Node-compatible executable. */
  cliExecutable?: string;
  codexModelKey?: string;
  attachmentPath?: string;
  attachmentPaths?: string[];
  sessionId?: string;
  resume?: boolean;
  workspaceDir?: string;
  readOnlyPaths?: string[];
  /** 除会话自身产物目录外额外允许写的目录，见 SdkConfig.extraWritablePaths */
  extraWritablePaths?: string[];
  /** 群聊：上传附件只读目录的基会话（群 base sid），见 SdkConfig.uploadsSessionId */
  uploadsSessionId?: string;
  /** 群聊慢思考：产物可写目录的基会话（群 base sid），见 SdkConfig.artifactSessionId */
  artifactSessionId?: string;
  allowBash?: boolean;
  unrestrictedFileAccess?: boolean;
  thinking?: "adaptive" | "disabled" | "enabled";
  disableTools?: boolean;
  maxTurns?: number;
  /** UI-selected local permission profile. */
  permissionMode?: "default" | "full";
  systemPrompt?: string;
  baseSystemPrompt?: string | false;
  securitySystemPrompt?: string | false;
  protectedPaths?: string[];
  /** 虚拟路径映射（模型只见虚拟路径，工具执行时改回真实路径），见 SdkConfig.pathAliases */
  pathAliases?: Array<{ from: string; to: string }>;
};
export type AgentRequest = {
  messages: AgentMessage[];
  signal?: AbortSignal;
  config: AgentRunConfig;
  titleSink?: (title: string) => void;
};
export type AgentCapabilities = {
  tools: boolean;
  images: boolean;
  steer: boolean;
  questions: boolean;
  resume: boolean;
};
export interface AgentAdapter {
  readonly mode: AgentMode;
  readonly capabilities: AgentCapabilities;
  stream(request: AgentRequest): ReadableStream<Uint8Array>;
}
