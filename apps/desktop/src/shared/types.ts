/** 主进程 / preload / renderer 三方共享的类型定义 */

export type Domain = {
  id: string;
  name: string;
  color: string;
  /** 数域皮肤的自定义主色（默认取 color，可被用户覆盖） */
  skinColor?: string;
  /** 数域提供商可指定完整的 CSS border（颜色、粗细、线型）；省略时沿用当前壁纸皮肤。 */
  composerBorder?: string;
  /** 兼容只指定颜色的数域配置。 */
  composerBorderColor?: string;
};

export type DockItemKind = "primary" | "domain" | "app" | "separator";

export interface DockItem {
  id: string;
  kind: DockItemKind;
  label: string;
  domainId?: string;
  appId?: string;
}

export interface LauncherApp {
  id: string;
  name: string;
}

export type WallpaperKind = "gradient" | "color" | "image" | "builtin";
export type AppearanceMode = "light" | "dark" | "static" | "dynamic";

/** 熔火龙境（动态壁纸）火焰参数：intensity=强度（速度随强度联动，越强越快）、amplitude=幅度（%，相对初始值等比缩放）。 */
export interface FireParams {
  intensity: number;
  amplitude: number;
}
export interface GoldParams { speed: number; sparkle: number }
export interface WaterParams { intensity: number; amplitude: number; tint: string }

export interface Wallpaper {
  kind: WallpaperKind;
  /** gradient: 内置渐变 id；color: css 颜色；image: 本地图片绝对路径（经 local-file:// 加载）；builtin: 应用内置图片的相对 URL */
  value: string;
}

/** 通知提示音：与 agent-kit / local app 保持同一套取值（off=静音、system=系统音）。 */
export type NotificationSound = "off" | "bright" | "calm" | "playful" | "system";

/**
 * 算力提供商（= 聊天里可选的框架）。id 与 kit 的 agentMode 对应：
 * workbuddy → "codebuddy"（CodeBuddy 订阅），codex → "codex"（Codex CLI）。
 */
export type ComputeProviderId = "workbuddy" | "codex" | "dsh";

/** 某个算力提供商的实时状态（由对应 SDK/CLI 探测，不落盘）。 */
export interface LauncherComputeProvider {
  id: ComputeProviderId;
  name: string;
  /** 是否已登录。 */
  authenticated: boolean;
  /** DSH can have a saved key even when verification fails. */
  configured?: boolean;
  /** 对应 CLI 是否可用。 */
  available: boolean;
  /** 登录账号展示名（SDK 查得到才给）。 */
  accountName?: string;
  /** 最近一次登录/登出失败的原因，仅供设置面板提示。 */
  error?: string;
}

/**
 * Codex CLI 的平台包（解开约 437MB）不打进安装包，首次启用时按需下载（压缩包约 157MB）。
 * 设置面板据此显示「下载组件」/ 进度条。
 */
export interface CodexRuntimeState {
  /** 平台包是否已就绪（已下载并解压，或复用了本机同版本的 codex）。 */
  installed: boolean;
  /** 就绪来源：download=我们下载到 userData 的那份；local=复用本机已装的同版本。 */
  source?: "download" | "local";
  /** 与构建机 node_modules 里 @openai/codex 一致的版本。 */
  version: string;
  downloading: boolean;
  /** 已下载字节数。 */
  downloaded: number;
  /** 总字节数；服务端没给 content-length 时为 0。 */
  total: number;
  /** 最近一次失败原因。 */
  error?: string;
}


export interface DesktopWidgetPlacement {
  columns: number;
  rows: number;
  column?: number;
  row?: number;
  page?: number;
}

/** 文件管理组件列本机目录时的一行：rel 相对用户 home，渲染层不接触绝对路径。 */
export interface LauncherFsEntry {
  rel: string;
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
}

/**
 * 登记后的本机文件引用：url 是 local-ref:// 句柄，
 * 会话消息附件与本机 Agent 服务都靠它换回真实路径。
 */
export interface LauncherLocalRef {
  id: string;
  url: string;
  name: string;
  size: number;
  kind: "file" | "folder";
}

export interface DesktopSessionGroup {
  id: string;
  title: string;
  placement: DesktopWidgetPlacement;
  /** 此组内的会话 ID 顺序；一个会话仅归属一个手动组。 */
  sessionIds: string[];
}

/**
 * 文件管理组件：和会话组共用桌面网格，但内部没有「卡片」概念。
 * 只持久化格位与显示模式（图标 / 列表 / 分栏），其余状态每次打开现取。
 */
export interface DesktopFileWidget {
  id: string;
  placement: DesktopWidgetPlacement;
  /** 显示模式；缺省按「图标」渲染。 */
  view?: "icons" | "list" | "columns";
  /**
   * 当前目录（相对 home 的路径，"" = home 根）。
   * 记下来是为了重启后还停在上次的位置，而不是每次都回到 home。
   */
  dir?: string;
}

export interface LauncherDesktopSession {
  id: string;
  title: string;
  lastPreview?: string | null;
  lastAssistantText?: string | null;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  modelId?: string | null;
  aiUnread?: boolean;
  updatedAt?: string | null;
}

/** 渲染层 -> 主进程：发一条系统通知。windowId/sessionId 是点击后回到正确窗口、正确会话的唯一依据。 */
export interface LauncherNotificationPayload {
  /** "primary" / 数域 id / "workspace" */
  windowId: string;
  sessionId: string;
  /** 同一轮回复的 id：主进程据此去重，避免重连/重渲染重复弹。 */
  runId?: string;
  title: string;
  body: string;
  /** true = 不播放系统提示音（关闭 / 使用自定义音效时由渲染层播放）。 */
  silent?: boolean;
}

/** 主进程 -> 渲染层：用户点了某条通知，请打开该窗口并切到该会话。 */
export interface LauncherNotificationOpen {
  windowId: string;
  sessionId: string;
}

export interface LauncherState {
  version: number;
  /** Interface language; absent or system follows the operating system. */
  language?: "system" | "zh-CN" | "en";
  domains: Domain[];
  dockItems: DockItem[];
  /** 固定在主入口两侧的数域，数组顺序即 Dock 显示顺序。 */
  dockPins?: { left: string[]; right: string[] };
  apps: LauncherApp[];
  wallpaper: Wallpaper;
  appearance: AppearanceMode;
  /** 桌面进行中组件的格数和左上角格坐标；缺省表示尚未添加。 */
  runningWidget?: DesktopWidgetPlacement;
  sessionGroups?: DesktopSessionGroup[];
  /** 桌面上的文件管理组件（可多个）；没有卡片概念，内部目前是空白。 */
  fileWidgets?: DesktopFileWidget[];
  showModel?: boolean;
  /** 输入框显示上下文使用情况，默认关闭。 */
  showContextUsage?: boolean;
  selectedModel?: string;
  /** 输入框显示语音按钮（默认开）。关闭后按住说话仍可用，只是不显示可见的麦克风按钮。 */
  showVoiceButton?: boolean;
  rightCtrlVoice?: boolean;
  /**
   * 语音预览模式：按住语音键只录音看动效，**不真的转写**（不请求转写端点、不扣费）。
   * 用于先验收 Home 声波动画效果。
   */
  voicePreviewOnly?: boolean;
  /**
   * 语音优先（默认关闭）。打开后按住语音键走腾讯云 WebSocket 实时 ASR，行为分两种：
   *  · 没有聚焦的聊天窗：Home 转圈 + 声波，第一段文字出现才浮出输入框；松手后等
   *    腾讯云把最后一句推完，消息**直接以新对话发出**（不用按回车）；
   *  · 有聚焦的聊天窗：只把语音转成文字写进那个窗口的输入框。
   * 关闭时回到「录完整段再上传」的旧链路。
   */
  voiceFirst?: boolean;
  /**
   * 语音优先模式下聊天窗的自动消失时间（分钟，0 = 不消失，默认 5）。
   * 桌面大部分时间应该是空的：问答结束、人走开一会儿，窗口自己收掉，回来还是桌面。
   */
  voiceFirstWindowMinutes?: number;
  /** 通知提示音；是否通知不由应用决定（用户可在系统设置里关闭通知）。 */
  notificationSound?: NotificationSound;
  /** 小龙喷火音效开关（默认关）。开启后点击小龙喷火时播放音效。 */
  dragonFireSound?: boolean;
  /** 小龙显隐开关（默认显示）。右键小龙 →「隐藏火龙」可关闭，外观菜单「显示小龙」恢复。 */
  dragonVisible?: boolean;
  /**
   * 自动隐藏 Dock（默认关闭）。开启后 Dock 默认缩到屏幕外，鼠标移到屏幕底部边缘才滑出，
   * 动画与时序对齐 macOS；隐藏时 Dock 不占位，最大化窗口可占据原 Dock 所在空间。
   */
  autoHideDock?: boolean;
  /**
   * Dock 上常驻「数域」入口（默认关闭）。开启后 Home 右侧固定显示一个数域图标，
   * 点击弹出「选择数域」窗口；关闭时不占 Dock 位置，仍可从工具栏 / 右键菜单打开。
   */
  dockDomainEntry?: boolean;
  /**
   * 有任务运行时保持唤醒（默认开启）。开启后只要还有会话在跑，主进程就向系统申请
   * 电源断言（macOS IOPMAssertion / Windows SetThreadExecutionState），阻止显示器休眠，
   * 从而不会因为空闲锁屏；所有任务结束后自动释放，系统恢复原来的休眠策略。
   */
  keepAwakeOnTask?: boolean;
  /**
   * 已启用的算力提供商（系统设置 →「算力提供商」里那个「启动」）。
   * 缺省视为全部启用；被禁用的框架不会出现在聊天的框架切换里。
   */
  enabledComputeProviders?: ComputeProviderId[];
  customWallpaper?: string;
  /** 动态壁纸（熔火龙境）火焰参数；未配置时用 kit 预设初始值。 */
  fireParams?: FireParams;
  goldParams?: GoldParams;
  waterParams?: WaterParams;
  activeDomainId: string;
}

/** 状态栏的输入法：id 是输入源标识（com.apple.inputmethod.SCIM.ITABC），name 是本地化名（Pinyin – Simplified）。 */
export interface LauncherStatusIme {
  id: string;
  name: string;
}

/** 状态栏的 Wi-Fi：rssi 单位 dBm，未连接时为 0；SSID 需要定位权限，取不到就不给。 */
export interface LauncherStatusWifi {
  power: boolean;
  connected: boolean;
  rssi: number;
}

/** 状态栏的电量：percent 0–100，无电池的机型为 null（整个 battery 字段为空）。 */
export interface LauncherStatusBattery {
  percent: number;
  charging: boolean;
  ac: boolean;
}

/** 自绘状态栏需要的系统状态（时间日期由渲染层自己算，不走这里）。 */
export interface LauncherSystemStatus {
  ime: LauncherStatusIme | null;
  wifi: LauncherStatusWifi | null;
  battery: LauncherStatusBattery | null;
  /** 是否走了原生采集器；false = 命令行降级（没有信号强度/输入法名称）。 */
  native: boolean;
}

/** preload 暴露给渲染进程的 API 形状 */
export interface LauncherApi {
  getState(): Promise<LauncherState>;
  saveState(state: LauncherState): Promise<{ ok: boolean; error?: string }>;
  listDesktopSessions(): Promise<LauncherDesktopSession[]>;
  onDesktopSessionsChanged(listener: () => void): () => void;
  pickWallpaperImage(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  openWechatPoc(theme: "light" | "dark"): Promise<{ ok: boolean; error?: string }>;
  toggleWechatPoc(theme: "light" | "dark", usePress: boolean): Promise<{ ok: boolean; foreground: boolean; error?: string }>;
  beginWechatDockPress(): void;
  cancelWechatDockPress(): void;
  noteLauncherInteraction(): void;
  closeWechatPoc(): Promise<void>;
  bringHomeForward(): Promise<void>;
  onWechatPocClosed(listener: () => void): () => void;
  listModels(): Promise<Array<string | { id: string; name?: string; meta?: Record<string, unknown> }>>;
  /** models.json 的当前版本与「上次加载时」的记录，用于展示上次更新时间和判断是否需要刷新。 */
  getModelsFileStatus(): Promise<{ file: string | null; mtimeMs: number | null; seenAt: string | null; changed: boolean } | null>;
  /** models.json 在运行期被改动时触发（主进程轮询签名发现变化）。 */
  onModelsFileChanged(listener: () => void): () => void;
  listCodexModels(): Promise<Array<{ id: string; name?: string; meta?: Record<string, unknown> }>>;
  listDshModels(): Promise<Array<{ id: string; name?: string }>>;
  transcribeVoice(audio: ArrayBuffer, mimeType: string, fileName: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  chatSend(sessionId: string, messages: Array<{ role: "user" | "assistant"; content: string }>, model?: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  chatTitle(firstMessage: string, model?: string): Promise<{ ok: true; title: string } | { ok: false; error: string }>;
  /** 渲染层 AgentWindow 的本地 Agent 服务地址（含鉴权 token）。 */
  getAgentHost(): Promise<{ url: string }>;
  /** Web 服务根地址（登录/会话账号由 apps/web 的 /linger 提供，约定与本地宿主一致）；未配置时返回 null。 */
  getWebAuth(): Promise<{ url: string } | null>;
  getWebSession(): Promise<{ name: string; avatar?: string; provider: string; unionId: string; sub: string; userCode?: string; deptName?: string } | null>;
  /** 修改自己的展示名 / 头像（user_code 不可改）。 */
  updateProfile(patch: { name?: string; avatar?: string }): Promise<{ ok: boolean; error?: string; user?: { name: string; avatar?: string; userCode?: string } }>;
  logoutWebSession(): Promise<{ ok: boolean; error?: string }>;
  /** 彻底删除当前账号：服务端清除账号数据 + 本机清理登录态、凭据与本地聊天；不可恢复。 */
  deleteWebSession(): Promise<{ ok: boolean; error?: string }>;
  /** 打开内置登录窗口。theme 传当前界面主题（Launcher 外观 = 浅/深），
   *  登录页据此染色，避免 Launcher 浅色 + 系统深色时登录窗变成黑底。 */
  openLogin(theme?: "light" | "dark"): Promise<{ ok: boolean; error?: string }>;
  onWebSessionChanged(listener: () => void): () => void;
  getDomainTicket(): Promise<string | null>;
  contactsApi(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<{ ok: boolean; status: number; data: any }>;
  webChatApi(method: string, path: string, body?: string): Promise<{ status: number; contentType: string; body: string }>;
  /** 发系统通知；返回是否真正显示（系统不支持/参数非法时为 false）。 */
  showNotification(payload: LauncherNotificationPayload): Promise<boolean>;
  /** 设置 macOS Dock 图标上的未读数 badge；传 0 清空。 */
  setUnreadBadge(count: number): void;
  /** 订阅「用户点了通知」：回传来源窗口与会话，宿主负责打开窗口并切会话；返回取消订阅函数。 */
  onNotificationOpen(listener: (payload: LauncherNotificationOpen) => void): () => void;
  /** 「关于」窗口的应用与运行时信息（版本号等；纯静态数据）。 */
  getAppInfo(): Promise<{ name: string; version: string; electron: string; chrome: string; node: string; platform: string }>;
  /** 状态栏的初始系统状态（电量 / Wi-Fi / 输入法）。 */
  getSystemStatus(): Promise<LauncherSystemStatus>;
  /** 订阅状态栏的系统状态变化；返回取消订阅函数。 */
  onSystemStatus(listener: (status: LauncherSystemStatus) => void): () => void;
  /**
   * 「有任务运行时保持唤醒」：渲染层把「开关打开 && 有任务在跑」的结果推给主进程，
   * 主进程据此申请 / 释放系统电源断言。返回主进程当前是否真的拿着断言。
   */
  setKeepAwake(active: boolean): Promise<boolean>;
  /** 窗口当前是否全屏（自绘状态栏只在全屏时显示）。 */
  isFullscreen(): Promise<boolean>;
  /** 订阅全屏状态变化；返回取消订阅函数。 */
  onFullscreenChanged(listener: (fullscreen: boolean) => void): () => void;
  /** 桌面「文件管理」组件：用户 home 目录绝对路径（组件根目录）。 */
  getHomeDir(): Promise<string>;
  /** 列一层目录（rel 相对 home，""=home）；目录不存在返回 null，读不了返回空数组。 */
  listDirectory(rel: string): Promise<LauncherFsEntry[] | null>;
  /** 重命名（同目录内改文件名）。 */
  renamePath(rel: string, name: string): Promise<boolean>;
  /** 新建文件夹：ok=成功 / exists=同名已存在 / error=失败。 */
  createDirectory(rel: string, name: string): Promise<"ok" | "exists" | "error">;
  /** 移动到目标目录（都是相对 home 的路径）。 */
  movePath(rel: string, destDir: string): Promise<boolean>;
  /** 移到系统废纸篓（可恢复；不会真删）。 */
  trashPath(rel: string): Promise<boolean>;
  /** 在系统文件管理器里定位该条目。 */
  revealPath(rel: string): Promise<boolean>;
  /**
   * 把桌面文件管理组件里的条目（rel 相对 home）登记成本机引用句柄（local-ref://）。
   * 会话消息的附件只认这个句柄，所以拖文件进会话前要先过这一道。
   */
  registerLocalRefs(rels: string[]): Promise<LauncherLocalRef[]>;
  /** 设置要监听的目录（rel 相对 home），目录变化时通过 onDirectoryChanged 通知。 */
  watchDirectory(rel: string): Promise<boolean>;
  /** 监听目录变化事件，返回取消监听的函数。 */
  onDirectoryChanged(handler: (rel: string) => void): () => void;
  /** 系统设置 →「算力提供商」：各提供商的登录态（主进程用 CodeBuddy SDK 探测，带短缓存）；
   *  force=true 时跳过缓存重新探测（面板打开、登录/登出后都会这么做）。 */
  getComputeProviders(force?: boolean): Promise<LauncherComputeProvider[]>;
  /** 发起某个提供商的登录：主进程会打开系统浏览器完成授权，成功后才返回。 */
  loginComputeProvider(id: ComputeProviderId): Promise<{ ok: boolean; error?: string }>;
  /** 退出某个提供商的登录。 */
  logoutComputeProvider(id: ComputeProviderId): Promise<{ ok: boolean; error?: string }>;
  /** 订阅登录态变化（登录/登出成功、切换到前台），返回取消订阅函数。 */
  onComputeProvidersChanged(listener: (provider?: ComputeProviderId) => void): () => void;
  saveDshKey(key: string): Promise<{ ok: boolean; error?: string }>;
  deleteDshKey(): Promise<{ ok: boolean; error?: string }>;
  /** Codex CLI 平台包的安装状态（不打进安装包，首次使用按需下载）。 */
  getCodexRuntime(): Promise<CodexRuntimeState>;
  /** 下载并安装 Codex CLI 平台包（压缩包约 157MB）；已装好时直接返回成功。 */
  installCodexRuntime(): Promise<{ ok: boolean; error?: string }>;
  /** 订阅下载进度，返回取消订阅函数。 */
  onCodexRuntimeState(listener: (state: CodexRuntimeState) => void): () => void;
  /** office→PDF 预览引擎（LibreOfficeKit，解开约 184MB）是否就绪；不打进安装包。 */
  getLibreOfficeRuntime(): Promise<{ installed: boolean }>;
  /** 立刻下载并安装 office 预览引擎；已装好时直接返回成功。 */
  installLibreOfficeRuntime(): Promise<{ ok: boolean; error?: string }>;
  /** OTA 更新：当前状态（当前版本、可用新版本、下载进度）。 */
  updater: {
    status(): Promise<{ version: string; release: { version: string; filename: string; size: number } | null; download: { phase: string; downloaded: number; total: number; error?: string } }>;
    check(): Promise<{ version: string; release: { version: string; filename: string; size: number } | null; download: { phase: string; downloaded: number; total: number; error?: string } }>;
    install(): Promise<{ ok: boolean; error?: string }>;
    onAvailable(listener: (release: { version: string; filename: string; size: number } | null) => void): () => void;
    onDownloadState(listener: (state: { phase: string; downloaded: number; total: number; error?: string }) => void): () => void;
  };
  /** 本地知识库 */
  knowledge: {
    listLibraries(): Promise<Array<{ id: string; name: string; enabled: boolean }>>;
    listLibrariesStats(): Promise<Array<{ id: string; name: string; enabled: boolean; stats: KnowledgeStats | null }>>;
    createLibrary(name: string): Promise<{ id: string; name: string; enabled: boolean }>;
    selectLibrary(id: string): Promise<{ ok: boolean }>;
    updateLibrary(id: string, changes: { name?: string; enabled?: boolean }): Promise<unknown>;
    deleteLibrary(id: string): Promise<{ ok: boolean }>;
    pickFolder(): Promise<string | null>;
    addFolder(folderPath: string): Promise<{ ok: boolean; error?: string }>;
    removeFolder(folderPath: string): Promise<{ ok: boolean }>;
    listFolders(): Promise<Array<{ path: string; addedAt: string }>>;
    setFolder(folderPath: string | null): Promise<{ ok: boolean; error?: string }>;
    /** 知识库窗口关闭时暂停索引，重新打开时恢复 */
    setPaused(paused: boolean): Promise<{ ok: boolean }>;
    videoSource(filePath: string, convert: boolean): Promise<string>;
    prepareVideoPreview(filePath: string): Promise<string>;
    revealDocument(libraryId: string, chunkId: number, hash: string): Promise<void>;
    resolveChatImage(id: string): Promise<string | null>;
    resolveChatSnapshot(owner: string, sessionId: string, name: string): Promise<string | null>;
    chatVideo(libraryId: string, chunkId: number, hash: string, startMs: number, endMs: number, kind: "thumbnail" | "play"): Promise<{ path?: string; bytes?: Uint8Array; start: number; end: number; title: string }>;
    videoThumbnail(chunkId: number): Promise<string>;
    excludeFile(fileId: number): Promise<{ ok: boolean }>;
    /** 把源文件移到系统废纸篓，并从知识库移除（可从废纸篓恢复） */
    trashFile(fileId: number): Promise<{ ok: boolean }>;
    getFileChunks(fileId: number): Promise<KnowledgeChunk[]>;
    listModels(): Promise<KnowledgeModelInfo[]>;
    openModelFolder(model: "embeddinggemma2"): Promise<{ ok: boolean; error?: string }>;
    getModelStatus(model?: "embeddinggemma2"): Promise<KnowledgeModelStatus>;
    downloadModel(model?: "embeddinggemma2"): Promise<KnowledgeModelStatus>;
    onModelStatus(listener: (p: KnowledgeModelStatus) => void): () => void;
    /** 兼容旧调用：只取前 100 条，新代码用 queryFiles */
    listFiles(offset?: number): Promise<Array<{ id: number; path: string; title: string; type: string; status: string; size: number; chunkCount: number; error?: string | null }>>;
    /** 文件浏览器：搜索 / 类型 / 状态 / 排序 / 分页，返回当前页和命中总数 */
    queryFiles(query?: KnowledgeFileQuery): Promise<KnowledgeFilePage>;
    /** 按需生成图片缩略图（老库首次浏览时用），返回已生成的缩略图路径 */
    fileThumbnails(fileIds: number[]): Promise<Array<{ fileId: number; path: string }>>;
    /** 片段内嵌图片的缩略图（文档原图 / 召回结果） */
    chunkThumbnails(chunkIds: number[]): Promise<Array<{ chunkId: number; path: string }>>;
    stats(): Promise<KnowledgeStats>;
    getProgress(): Promise<KnowledgeIndexProgress>;
    reindex(): Promise<{ ok: boolean }>;
    reindexFile(fileId: number): Promise<{ ok: boolean }>;
    clearAll(): Promise<{ ok: boolean; files: number; chunks: number }>;
    openFile(filePath: string): Promise<{ ok: boolean; error?: string }>;
    search(query: string, options?: number | KnowledgeRetrievalOptions): Promise<KnowledgeSearchResult[]>;
    /** 语音召回：16kHz 单声道 PCM，检索视频音轨片段（结果带 videoStart/videoEnd） */
    searchAudio(audio: Float32Array, options?: KnowledgeRetrievalOptions): Promise<KnowledgeSearchResult[]>;
    onProgress(listener: (p: KnowledgeIndexProgress) => void): () => void;
    /** 图片片段的 OCR → 大模型描述分阶段进展（即时推送，不必等 3 秒轮询） */
    onChunkStage(listener: (e: KnowledgeChunkStageEvent) => void): () => void;
    /** 知识库设置（图片识别模型、窗口关闭后是否后台索引） */
    getSettings(): Promise<KnowledgeSettings>;
    /** 保存设置；`imageModel: null` 清除选择、回退默认模型 */
    saveSettings(patch: { imageModel?: KnowledgeImageModel | null; backgroundIndexing?: boolean }): Promise<KnowledgeSettings>;
    /** 图片识别可选的框架与模型（框架自带模型 + models.json 自定义模型） */
    listImageModels(): Promise<KnowledgeFrameworkModels[]>;
  };
  platform: string;
}

/** 图片识别可选的框架 */
export type KnowledgeFramework = "codebuddy" | "codex";

/** 一个图片识别模型的选项 */
export interface KnowledgeImageModelChoice {
  /** 框架内的模型标识：codebuddy 为模型 id，codex 为 `${vendor}::${id}` 或原生 id */
  id: string;
  name?: string;
  vendor?: string;
  /** 来自本地 models.json 的自定义模型 */
  custom?: boolean;
  /** 明确声明不支持图片时为 false；未知（undefined）按可用处理 */
  supportsImages?: boolean;
}

/** 一个框架及其可选的图片识别模型 */
export interface KnowledgeFrameworkModels {
  id: KnowledgeFramework;
  name: string;
  models: KnowledgeImageModelChoice[];
  /** 框架不可用时的原因（未登录 / CLI 未安装等） */
  error?: string;
}

/** 图片识别模型选择 */
export interface KnowledgeImageModel {
  framework: KnowledgeFramework;
  model: string;
}

/** 知识库全局设置 */
export interface KnowledgeSettings {
  imageModel?: KnowledgeImageModel;
  /** 知识库窗口关闭后继续在后台索引；默认 true */
  backgroundIndexing?: boolean;
}

/** 文件浏览器：按类型筛选 */
export type KnowledgeFileKind = "all" | "image" | "video" | "document";
/** 文件浏览器：按状态筛选（queued = 排队中 + 解析中） */
export type KnowledgeFileStatusFilter = "all" | "queued" | "failed" | "indexed";
/** 文件浏览器排序 */
export type KnowledgeFileSort = "date-desc" | "date-asc" | "name-asc" | "size-desc" | "added-desc";

export interface KnowledgeFileQuery {
  offset?: number;
  limit?: number;
  /** 匹配文件名或完整路径 */
  search?: string;
  kind?: KnowledgeFileKind;
  status?: KnowledgeFileStatusFilter;
  sort?: KnowledgeFileSort;
}

export interface KnowledgeFileListItem {
  id: number;
  path: string;
  title: string;
  type: string;
  status: string;
  size: number;
  chunkCount: number;
  coverage?: "unknown" | "complete" | "partial";
  error?: string | null;
  dateTakenMs?: number | null;
  mtimeMs: number;
  camera?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** 已生成缩略图时返回本地绝对路径；null 表示待生成（调 fileThumbnails） */
  thumbPath?: string | null;
}

export interface KnowledgeFilePage {
  items: KnowledgeFileListItem[];
  total: number;
  groups: Array<{ year: string | null; count: number }>;
}

/** 知识库统计数据 */
export interface KnowledgeStats {
  fileCount: number;
  indexedFiles: number;
  chunkCount: number;
  pendingFiles: number;
  failedFiles: number;
  totalBytes: number;
  /** kb.db（含 WAL/SHM）实际占用大小 */
  dbBytes: number;
  embeddedChunks: number;
  failedEmbeddingChunks?: number;
  embeddingFailures?: Array<{ fileId: number; path: string; videoStart: number | null; videoEnd: number | null; error: string }>;
  estimatedChunks: number;
  estimatedEmbeddedChunks: number;
  avgChunksPerFile: number;
  typeDistribution: Array<{ type: string; count: number; bytes: number }>;
  statusDistribution: Array<{ status: string; count: number }>;
}

/** 知识库索引进度 */
export interface KnowledgeIndexProgress {
  phase: "idle" | "scanning" | "indexing" | "embedding" | "model-download";
  scannedFiles: number;
  totalFiles: number;
  currentFile: string;
  indexedFiles: number;
  failedFiles: number;
  /** 还没处理完的文件数（排队中 + 解析中），用于显示「还剩 N 个」 */
  remainingFiles?: number;
  queuedChunks: number;
  error?: string;
  /** 当前文件的细分阶段，例如「大模型正在识别第 1/2 张图片…」 */
  detail?: string;
  /** 模型下载进度 */
  model?: {
    name: string;
    file: string;
    percent: number;
    downloadedMB: number;
    totalMB: number;
    phase: "downloading" | "done" | "error";
    error?: string;
  };
}

/** 知识库检索结果 */
export interface KnowledgeSearchResult {
  videoStart?: number;
  videoEnd?: number;
  /** video=画面窗口，audio=视频音轨窗口（语音召回命中）；文本/图片为空 */
  modality?: "video" | "audio" | null;
  imagePath?: string;
  chunkId: number;
  text: string;
  filePath: string;
  fileTitle: string;
  headingPath: string;
  score: number;
  source: "dense" | "keyword" | "both";
  /** 拍摄时间（EXIF DateTimeOriginal，epoch ms）；无 EXIF 为 null，展示时回退 mtimeMs */
  dateTakenMs?: number | null;
  /** 文件系统修改时间（拍摄时间缺失时兜底） */
  mtimeMs?: number;
  /** 机型（Make + Model）；无信息为 null */
  camera?: string | null;
  /** GPS 纬度（南纬为负）；无定位为 null */
  lat?: number | null;
  /** GPS 经度（西经为负）；无定位为 null */
  lon?: number | null;
}

export interface KnowledgeModelStatus { id: "embeddinggemma2"; phase: "checking" | "downloading" | "done" | "error"; file: string; percent: number; downloadedMB: number; totalMB: number; error?: string }
/**
 * 图片片段的处理阶段。
 * ocr → describing → described 是主链路；模型不可用/失败时回退 fallback（保留 OCR 原文）。
 * ready 表示普通文本片段或图片本体片段，不需要经过大模型。
 */
export type KnowledgeChunkStage = "ocr" | "describing" | "described" | "fallback" | "ready";

export interface KnowledgeChunkStageEvent {
  fileId: number;
  fileTitle: string;
  stage: KnowledgeChunkStage | "done";
  imageIndex: number;
  imageTotal: number;
  /** 可直接展示的中文短文案 */
  label: string;
}

export interface KnowledgeChunk {
  videoStart?: number;
  videoEnd?: number;
  /** video=画面窗口，audio=音轨窗口 */
  modality?: "video" | "audio" | null;
  imagePath?: string;
  id: number;
  seq: number;
  text: string;
  headingPath: string;
  tokenCount: number;
  dimension: number;
  stage?: KnowledgeChunkStage;
  /** 生成这条图片文字描述所用的大模型 id；旧索引数据为 undefined */
  describeModel?: string;
}

export interface KnowledgeModelInfo { id: "embeddinggemma2"; path: string; size: number; ready: boolean; files: Array<{ name: string; size: number; expectedSize: number; valid: boolean }> }

export interface KnowledgeRetrievalOptions { limit?: number; minScore?: number; mode?: "hybrid" | "dense" | "keyword"; rerank?: boolean }
