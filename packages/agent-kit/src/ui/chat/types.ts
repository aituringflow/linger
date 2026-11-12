import type { ReactNode } from "react";
import type { ModelOption } from "../components/ModelSelect.tsx";
import type { ArtifactChange } from "../components/ArtifactDiff.tsx";
import type { SidebarEntry } from "../components/NavigationSidebar.tsx";
import type { HostCapability } from "../capabilities/index.tsx";

/** 产物类型（与服务端 artifacts.ts 的 ArtifactType 保持一致；browser 为右栏浏览器实时预览的虚拟类型） */
export type ArtifactType = "html" | "markdown" | "image" | "audio" | "video" | "pdf" | "text" | "word" | "excel" | "ppt" | "other" | "dir" | "browser";

/** 产物元信息（服务端 /api/artifact 列表返回） */
export interface ArtifactMeta {
  id: string;
  name: string;
  type: ArtifactType;
  /** 文件字节数（前端展示大小） */
  size?: number;
  /** 文件修改时间（毫秒时间戳）：AI 刷新/覆盖版本后随之更新，前端据此展示"修改时间" */
  mtimeMs?: number;
  /** 文件所在真实目录（「打开文件夹」跟随文件用）：服务端 list 返回；桌面壳据此 openPath */
  dir?: string;
  /** 展示用完整相对路径（登记产物在会话目录 / 工作目录内时返回；name 可能只是 basename） */
  rel?: string;
}

/** 场景建议（空态建议按钮）。每个建议可独立控制发送方式与专属提示词。 */
export interface SceneSuggestion {
  /** 展示文案；sendOnClick=false 时原样放入输入框，由用户补充/修改后手动发送 */
  label: string;
  /**
   * 点击后是否直接发送；缺省 true。
   * - true：点击即作为用户消息发出（suggestion.prompt 随本次请求注入 system）；
   * - false：仅把 label 放入输入框并聚焦，不发送；用户补充（如指定月份）后手动发送，
   *   该建议的 prompt 仍随这次发送注入。
   */
  sendOnClick?: boolean;
  /** 该建议专属系统提示词：随该建议触发的这一次发送作为 system 消息注入；
   *  与 Scene.prompt 并存时按序拼接（场景级在前、建议级在后）；不传则仅用场景级。 */
  prompt?: string;
  /**
   * 命令动作：设置了 command 的建议点击后不发送消息，而是触发动作。
   * 格式为 "<动作> <参数>"，目前支持：
   * - `open <url>`：在右侧面板的新 tab 打开该网址（http/https；缺省协议时自动补 https://）。
   * 后续可扩展其他动作，未支持的动作会安全忽略（不发送消息）。
   */
  command?: string;
}

/** 场景（顶部场景栏的每一项） */
export interface Scene {
  key: string;
  label: string;
  suggestions: SceneSuggestion[];
  /**
   * 场景专属系统提示词：切换到该场景后，每轮发送时作为 system 消息一并送入 AI，
   * 用于约束该场景下的角色、口径与回答风格；不传则不注入。
   */
  prompt?: string;
  /**
   * 当前选中场景在会话中的显示指示：缺省 false。
   * 场景栏策略：新建对话（空态）总是显示全部场景供选择（含 sticky=false）；
   * 进入会话后（非空态），仅当当前选中的场景 sticky=true 时，场景栏显示该场景按钮，
   * 作为“我此刻在这个场景里”的指示（该场景的技能/提示词随会话生效）；当前场景
   * sticky=false 则非空态场景栏整体隐藏。场景切换仅发生在空态。
   * 快捷问题（suggestions）只在该场景为空态（未发消息）时显示，与 sticky 无关。
   */
  sticky?: boolean;
}

/** 登录用户信息（unionId 存在视为已登录） */
export interface ChatUser {
  unionId?: string;
  name?: string;
  avatar?: string;
  /** 登录方式：dingtalk | feishu（分享到 OA 时决定走哪家 JSAPI） */
  provider?: string;
  organizationName?: string;
  /** 部门名（服务端按提供方解析；缺权限/未配置时为空） */
  department?: string;
}

/** 用户角色（由宿主应用传入，用户设置菜单展示；可多个） */
export interface ChatUserRole {
  /** 角色唯一标识 */
  id: string;
  /** 角色展示名 */
  label: string;
}

export interface AgentWindowProps {
  /** Interface locale supplied by the host; defaults to Simplified Chinese. */
  locale?: "zh-CN" | "en";
  /** Host-controlled hold-to-talk preference. */
  voiceHoldEnabled?: boolean;
  /** App 通过 ?providers= 传给 web 登录页的 AUTH_PROVIDER 值；登录/退出跳转时拼到 /login 上，
   *  使 App 的 env 优先级高于 web 服务自身配置；不传则登录页仅 builtin。 */
  loginProviders?: string;
  /** Toolbar content supplied by the host application. */
  toolbar?: ReactNode;
  /** 宿主可把真人会话工具栏放入自己的窗口顶栏。 */
  renderCoworkToolbar?: (settings: { open: boolean; label: string; title: string; toggle: () => void }) => ReactNode;
  /** fixed: side panels share the host frame; grow: side panels extend outside the chat frame. */
  layoutMode?: "fixed" | "grow";
  /** Host owns the document theme (for example, a wallpaper-driven desktop shell). */
  themeManagedByHost?: boolean;
  /** 应用自排三栏位置时复用 AgentWindow 已连接的面板和会话切换。 */
  renderPanels?: (panels: AgentWindowPanels) => ReactNode;
  /** 是否显示应用级导航；AgentApp 默认开启，直接使用 AgentWindow 默认关闭。 */
  showNavigation?: boolean;
  /** 追加到聊天窗口根元素的宿主样式类。 */
  className?: string;
  /** 本机 AI 会话模式；cloudEnabled 可同时启用已登录账号的真人会话。 */
  localGuest?: boolean;
  /** 混合模式：本机保存 AI 会话，同时从账号服务读取真人会话。 */
  cloudEnabled?: boolean;
  /** Home 快捷输入的好友候选。仅新建对话空态显示。 */
  homeContacts?: Array<{ id: string; name: string; avatar?: string }>;
  resolveHomeContactSession?: (contactId: string) => Promise<string | null>;
  resolveHomeGroupSession?: (contactIds: string[]) => Promise<string | null>;
  onExistingPersonChatOpened?: () => void;
  onHomeMentionCleared?: () => void;
  /** 悬浮输入框提交消息后展开完整窗口。 */
  onHomeMessageSubmitted?: () => void;
  /** 供宿主判断 hover 预览是否已有输入。 */
  onComposerTextPresenceChange?: (hasText: boolean) => void;
  /**
   * 输入框「有内容」的存在性变化（**文字或附件**都算）。
   * 与 onComposerTextPresenceChange 的差别：后者只看文字。
   * 宿主（如 home 悬浮输入框）要判断「该收起预览态了没」时必须用这个 ——
   * 只挂了附件没打字时，浮层里是有东西的，不该被自动收起，否则附件会丢。
   */
  onComposerContentPresenceChange?: (hasContent: boolean) => void;
  /** 输入框默认占位文案；不传时用 kit 默认（"和 ${title} 一起工作"）。 */
  composerPlaceholder?: string;
  /** 新建对话空态欢迎文案；不传时用 kit 默认（"你好，我是你的助手"），传空串则不显示欢迎标题。 */
  emptyMessage?: string;
  /** 挂载即新对话（宿主 hover 入口等）：每次挂载都从空白新会话开始，不恢复上次会话。
   *  产生的会话即为普通会话，正常进入会话列表。 */
  newChatOnMount?: boolean;
  /** 新对话默认收起左右面板。
   *  用于「从空白入口（如宿主的 Home 悬停输入框）直接发消息」新建的会话：这类会话从零开始，
   *  不应继承上一次会话遗留的展开状态。存量会话（切换进来）不受影响，仍按用户上次的选择显示。 */
  closePanelsOnNewChat?: boolean;
  /** 新建对话时保持左侧会话列表面板不收起（仅对 closePanelsOnNewChat 生效）。
   *  用于宿主 Home 主窗口：用户点「新建对话」后仍想看到会话列表，侧栏不应消失；
   *  右侧面板仍照常收起。默认 false，不影响其他宿主。 */
  keepSidebarOnNewChat?: boolean;
  /** 挂载时强制展开左侧会话列表面板。
   *  用于「有未读消息时打开聊天窗」的场景：让用户一眼看到哪些会话有未读。
   *  只在挂载时执行一次，且不写入全局面板偏好（避免覆盖用户之前收起侧栏的选择）。
   *  与 closePanelsOnNewChat 互斥：同时为 true 时本优先生效。 */
  openSidebarOnMount?: boolean;
  /** 宿主首次使用时的权限默认值；用户后续选择仍会持久化。 */
  defaultPermissionMode?: "default" | "full";
  /** 宿主独立的权限偏好键，避免不同桌面应用互相覆盖。 */
  permissionPreferenceKey?: string;
  /** 锁定为「完全访问」：权限恒为 full，且不渲染输入框内的权限切换按钮（桌面宿主用）。 */
  permissionLocked?: boolean;
  /**
   * 是否响应内置键盘快捷键（Ctrl/Cmd+N 新建、Ctrl/Cmd+B 左栏、Ctrl/Cmd+O 右栏）。
   * 默认 true。多窗口宿主（如同时开 Home 与数域窗口）应只给**最上层**的实例传 true，
   * 否则所有实例都挂着 document 监听，一次按键会同时改掉每个窗口的面板。
   */
  shortcutsActive?: boolean;
  /**
   * 语音录制状态变化（按住 Windows 右 Alt / macOS Option 开始，松开结束）。低频回调，
   * 宿主用它切换 Dock / 任务栏上的录音指示。
   */
  onVoiceStateChange?: (active: boolean) => void;
  /**
   * 「正在把录音转成文字」状态变化（松手后、ASR 返回前）。低频回调，
   * 宿主用它显示"处理中"（例如 Dock 上的声波转成忙碌态、旋转加速），
   * 避免用户松手后看到动画直接停住、以为没录上。
   */
  onVoiceTranscribingChange?: (transcribing: boolean) => void;
  /**
   * 实时麦克风音量（0..1）的 ref 通道。每帧都在变，**不要**用回调 ——
   * 宿主应该在自己的动画帧里读它，避免每帧重渲染。
   */
  voiceAmplitudeRef?: { current: number };
  /**
   * 仅预览语音动效，**不真的转写**。
   *
   * 麦克风照常打开（所以音量/波形是真实的），但转写通道被替换成空实现：
   * 松手后既不请求转写端点、也不落音频文件、更不会产生费用。
   * 用来在没有 ASR 凭据 / 想先看动画效果时验证 UI。
   */
  voicePreviewOnly?: boolean;
  /**
   * 运行中的会话数（含切走后仍在后台跑的）：宿主可用于 Dock 角标、任务栏提示等全局指示。
   * 第二个参数是这些会话的 id：同一轮任务可能同时被两个实例上报（桌面后台实例发起、
   * 真实聊天窗随后接管同一条 run），宿主按 id 去重才不会把一轮算成两个任务。
   */
  onRunningSessionsChange?: (count: number, sessionIds: readonly string[]) => void;
  /**
   * 全部已保存会话的快照列表（标题 / 最后一条消息 / 模型 / 状态）：宿主用于桌面卡片和会话组。
   * 完成未读态会在用户打开会话后转为 idle。
   */
  onSessionSnapshotsChange?: (snapshots: SessionCardSnapshot[]) => void;
  /**
   * 右栏宽度变化：显示时为像素宽度，隐藏时为 null。
   * 宿主用它把右侧面板的宽度从窗口宽度里预留出来（窗口整体变宽而不是挤压中栏）。
   * 注意拖拽调整宽度时也会持续上报，宿主若只想在展开瞬间取一次值，需自行锁存。
   */
  onRightPanelWidthChange?: (width: number | null) => void;
  /**
   * 受控的右栏宽度（px）。传了就以它为准，kit 内部的拖拽/默认值不再生效，
   * 所有变化只通过 onRightPanelWidthChange 回传，由宿主决定是否落地。
   * 用于「宿主自己也有一条途径改变右栏宽度」（例如宿主拖窗口右边框时只想加宽右栏）。
   */
  rightPanelWidth?: number;
  /**
   * 受控的「显示模型选择器」开关。传了就忽略 defaultShowModel / localStorage，
   * 完全由宿主决定（宿主自己的设置面板里已经有这个开关）。
   */
  showModel?: boolean;
  /** 宿主受控 showModel 时，kit 内部（用户菜单里的开关）发生变化时的回传。 */
  onShowModelChange?: (show: boolean) => void;
  /** 宿主受控的输入框上下文使用量显示设置。 */
  showContextUsage?: boolean;
  onShowContextUsageChange?: (show: boolean) => void;
  /** 应用层扩展输入框“添加引用”菜单。文件入口始终由 kit 放在第一项。 */
  referenceSources?: readonly ComposerReferenceSource[];
  /** 用户角色列表（由宿主应用传入）：用户设置菜单 profile 区展示，多角色放不下时省略 + “更多”弹窗查看全部。 */
  roles?: readonly ChatUserRole[];
  /** Host extension called once when a non-embedded assistant turn completes. */
  onAssistantResponse?: (context: { sessionId: string; text: string; messages: readonly UiMessage[]; title?: string; runId?: string; isActiveSession?: boolean }) => void;
  /**
   * 宿主接管「AI 回复完成」通知。
   *
   * 传了就由宿主自己发系统通知（例如桌面壳走 Electron 主进程 Notification，
   * 这样点击通知能精确打开来源窗口 + 对应会话）；kit 内置的网页 Notification 会同时让路，
   * 避免同一轮回复弹两条。
   *
   * context 里带齐路由所需信息：sessionId 定位会话，runId 供宿主去重，
   * title 是**本轮会话**的标题（不是点击时用户恰好切到的会话），
   * isActiveSession 表示该会话是否正被用户查看（宿主可据此实现「仅后台提醒」）。
   */
  onReplyNotification?: (context: {
    sessionId: string;
    title: string;
    text: string;
    runId: string;
    isActiveSession: boolean;
  }) => void;
  /** Current total of unread human messages plus one for each AI conversation with unread replies. */
  onUnreadCountChange?: (count: number) => void;
  /**
   * 宿主请求切到某个会话（如点击了系统通知）。
   * nonce 变化即视为一次新请求：值相同不会重复触发，点击同一会话的两次通知也能再切一次。
   */
  sessionRequest?: { sessionId: string; nonce: number } | null;
  /** 处理完一次 sessionRequest（无论目标会话是否存在）后回调，宿主据此清掉请求，避免重挂载时重复跳转。 */
  onSessionRequestHandled?: (nonce: number) => void;
  /**
   * 宿主把「@联系人」预选投递给 home 输入框（联系人窗口点「发消息」）：
   * 与 home 输入框内 @ 选择同一人完全等价 —— 有历史 1v1 会话则跳转历史并保持顶部成员 chip，
   * 没有则进入新建对话并把该联系人预选进草稿（首条消息发送时才建会话落库）。
   */
  mentionRequest?: { person: { id: string; name: string; avatar: string }; nonce: number } | null;
  /** 处理完一次 mentionRequest 后回调，宿主据此清掉请求，避免重挂载时重复触发。 */
  onMentionRequestHandled?: (nonce: number) => void;
  /** Host-triggered resend of the last user turn, without opening a visible chat. */
  rerunRequest?: { sessionId: string; nonce: number } | null;
  onRerunRequestHandled?: (nonce: number, error?: string) => void;
  /**
   * 宿主请求向某个会话**新增**一轮用户消息（不是重发上一轮）。
   * 典型场景：桌面把本机文件拖到会话卡片上 —— 相当于在会话末尾发一条只带附件的消息。
   * text 留空、只给 attachments 时，发出的消息就只有附件。
   *
   * **sessionId 省略 = 新开一条对话再发**（语音优先：松手即发、一句一对话）。
   * 此时页面会先新建会话（与点「新建对话」同一条路径），再把 text 作为该会话的第一轮。
   */
  sendRequest?: { sessionId?: string; nonce: number; text?: string; attachments?: UiAttachment[] } | null;
  /** 处理完一次 sendRequest（无论成功与否）后回调，宿主据此清掉请求、避免重挂载时重复发送。 */
  onSendRequestHandled?: (nonce: number, error?: string) => void;
  /**
   * 宿主请求把附件放进某个会话的**输入框**（挂载态，不发送）。
   * 典型场景：桌面把本机文件拖到聊天窗 / 会话卡片停留后释放 / Dock home 悬浮输入框 ——
   * 落点都是「输入框里有附件、还没发出去」，用户可以继续打字再发送。
   *
   * 语义与 sendRequest 的差别只有两点：
   *  · 不发送（附件只是挂进 composer）；
   *  · sessionId 可选：不传就注入当前会话；传了 kit 会先切到该会话再注入
   *    （切会话会恢复该会话草稿里的附件，所以必须等切换完成后再追加，否则会被覆盖）。
   */
  attachRequest?: { nonce: number; sessionId?: string; attachments: UiAttachment[] } | null;
  /** 处理完一次 attachRequest（无论成功与否）后回调，宿主据此清掉请求、避免重挂载时重复注入。 */
  onAttachRequestHandled?: (nonce: number, error?: string) => void;
  /** A hidden host runner must not mark its active conversation as read. */
  backgroundMode?: boolean;
  /**
   * 宿主 UI 当前不可见（例如把聊天窗关掉/最小化后，实例仍挂载、会话继续在后台跑）。
   * 置位期间**任何会话都不会被标记已读**：一轮结束一律落成"未读"，
   * 关掉窗口时正在跑的会话跑完后会停在"已完成未读"，而不是立刻被判成已读后从列表消失。
   * 与 backgroundMode 的区别：它只影响已读判定，不改变"挂载时不恢复会话/不处理会话更新"等行为。
   */
  readSuppressed?: boolean;
  /**
   * 通道无关的注册能力列表（报销/未来 skill/MCP）。chat 与 cowork 双通道统一触发其
   * buildContext / onReply / renderCard；与旧回调（conversationContext/onAssistantResponse/
   * renderSessionFooter）并存，旧回调继续生效。
   */
  capabilities?: HostCapability[];
  /** App-owned context included with the next assistant request; the SDK does not interpret its contents. */
  conversationContext?: (context: { sessionId: string; messages: readonly UiMessage[] }) => string;
  /** Render the existing middle conversation as an isolated app-owned side chat.
   *  注意：embedded 只要传入即开启 embeddedMode；占位文案不在此处，用 composerPlaceholder 单独传。 */
  embedded?: {
    sessionId: string;
    temporary: boolean;
    title?: string;
    model?: string;
    agentMode?: "codebuddy" | "codex";
    systemPrompt?: string;
    context?: () => string;
    emptyMessage?: string;
    onResult?: (text: string, messages: readonly UiMessage[]) => void;
    onError?: (error: Error) => void;
  };
  /** 登录用户信息 */
  initialUser?: ChatUser;
  /** API 根路径，如 /agent；产物预览/上传/会话等端点都基于它 */
  basePath?: string;
  /** 场景列表；不传用 DEFAULT_SCENES，传 null 隐藏场景 tab（含空态建议） */
  scenes?: Scene[] | null;
  /** 退出登录回调（宿主接管时不再调 /api/logout 跳转） */
  onLogout?: () => void | Promise<void>;
  /** 聊天 SSE 端点覆盖（默认 basePath/api/chat） */
  chatEndpoint?: string;
  /** 桌面端本机产物端点覆盖（默认 basePath/api/artifact） */
  artifactEndpoint?: string;
  /** 上传端点覆盖（默认 basePath/api/upload） */
  uploadEndpoint?: string;
  /** 是否启用语音输入（按住语音键录音转写的总开关，含输入框常驻麦克风按钮）。 */
  voiceEnabled?: boolean;
  /**
   * 输入框常驻「麦克风」按钮是否可见，与 voiceEnabled 解耦：
   *  · voiceEnabled 控制**按住语音键（Windows 右 Alt / macOS Option）录音转写**这一核心交互的总开关；
   *  · showVoiceButton 仅控制输入框里那个**可见的麦克风按钮**是否渲染。
   * 默认（不传）跟随 voiceEnabled，保持旧行为；宿主可显式区分二者 ——
   * 按住说话始终可用（这是 AgentOS 的核心入口），但可见按钮仍受「显示语音按钮」设置控制。
   */
  showVoiceButton?: boolean;
  /** 语音令牌端点覆盖（默认 basePath/api/voice/token）。
   *  Electron 本地宿主的页面 origin 上没有后端，需指向本机服务。 */
  voiceTokenEndpoint?: string;
  /** 语音转写端点覆盖（默认 basePath/api/voice/transcribe） */
  voiceTranscribeEndpoint?: string;
  /** 实时转录开关：按住语音键走腾讯云 WebSocket 边说边出字（默认 false，录完整段再上传）。 */
  voiceRealtimeTranscription?: boolean;
  /** 实时转录会话签发端点（POST 后返回 wss URL）；缺省 basePath/api/audio/session。 */
  voiceRealtimeSessionEndpoint?: string;
  /** 是否启用附件上传 */
  uploadEnabled?: boolean;
  /** 顶栏标题 */
  title?: string;
  /** 顶栏 Logo */
  logoSrc?: string | null;
  /** 左栏顶部 Logo（宿主传入；不传时显示「会话」标题） */
  sidebarLogo?: string | null;
  /** 左侧主导航项配置。key 决定 URL ?view=、高亮与内容索引；内置 key（home/library/timer/
   *  workbench/contacts）可省略 label/icon/render 用默认实现，自定义 key 需三者自备。
   *  只有 home（或为空）时不渲染导航栏。 */
  sidebar?: readonly SidebarEntry[];
  /** 桌面端主导航初始是否展开并常显各项文字；默认收起，仅悬停显示文字。
   *  用户拖拽右缘过阈值折叠/展开后，以 localStorage（agent-kit:nav-expanded）为准，覆盖此 prop。 */
  sidebarExpanded?: boolean;
  /** 桌面端展开导航栏的宽度，单位 px；默认 160。拖拽只做过阈值切换，不单独持久化宽度。 */
  sidebarWidth?: number;
  /** 可选模型列表（ENABLE_MODEL_SELECT 未设为 false 且列表非空时可显示模型下拉）。
   *  宿主可显式传入以覆盖默认来源；不传时由 agent-kit 前端自动从后端
   *  GET /api/models/list 拉取（按 CodeBuddy 登录状态合并内置模型与 models.json）。
   *  每项可为纯 id 字符串（env 兜底）或 { id, name, meta }（models.json 自定义模型，
   *  下拉显示 name、悬停展示 meta 详情；meta 已剔除 apiKey）。
   *  用户选择后每轮发送 body 携带 model（始终为 id），服务端 session 流 setModel 运行中切换。 */
  models?: ModelOption[];
  /** 宿主模型列表仍在加载；空数组此时不代表确认没有可用算力。 */
  modelsLoading?: boolean;
  /** 宿主模型列表读取失败；不能据此断言没有可用算力。 */
  modelsLoadFailed?: boolean;
  /** “显示模型”的初始值；用户在菜单中手动切换后的偏好优先。默认 true。 */
  defaultShowModel?: boolean;
  /** 宿主允许使用的框架；服务端配置仍决定最终可用范围。 */
  agentModesOverride?: ("codebuddy" | "codex" | "dsh")[];
  /** 宿主正在后台检查框架状态；输入框仍可立即显示。 */
  agentModesPending?: boolean;
  /** 在当前会话的消息列表末尾渲染一次宿主内容（如人工联系人卡片）。
   *  按 sessionFooterVisibility 指定的时机调用；切换会话时传入对应会话 ID 与消息。 */
  renderSessionFooter?: (context: { sessionId: string; messages: readonly UiMessage[] }) => ReactNode;
  /** 宿主卡片的显示时机。默认等当前答复结束后显示。 */
  sessionFooterVisibility?: "always" | "after-response";
  /** 宿主卡片出现时是否播放透明度渐入动画。默认播放。 */
  sessionFooterAppearing?: boolean;
}

export interface AgentWindowPanels {
  conversation: ReactNode;
  chat: ReactNode;
  operation: ReactNode;
  activeSessionId: string;
  selectSession: (id: string) => Promise<unknown>;
}

/** 应用提供的模型上下文引用；同一来源内 id 唯一。 */
export interface ComposerReference {
  id: string;
  label: string;
  /** 发送给模型的文本。应用应在这里提供模型可读的内容，而非仅提供展示 ID。 */
  context: string;
}

export interface ComposerReferenceSource {
  id: string;
  label: string;
  /** 应用打开自己的选择 UI；可多次调用 add，也可在异步操作后调用。 */
  onSelect: (args: { sessionId: string; add: (reference: ComposerReference) => void }) => void | Promise<void>;
  /** 加号右侧引用条目的展示；省略时显示 label。移除按钮由 kit 统一提供。 */
  renderReference?: (reference: ComposerReference) => ReactNode;
}

/** 附件（输入框挂载态 / 消息附带） */
export interface UiAttachment {
  url: string;
  name: string;
  /** 本机引用的真实类型；不根据文件名或大小推断文件夹。 */
  kind?: "file" | "folder";
  fileId?: string;
  size?: number;
  /** 本地文件对象（发送时转 base64 供多模态识别） */
  file?: File;
  /** 本地预览用 object URL（仅上传后、发送前有效） */
  previewUrl?: string;
}

export interface UiImage {
  base64: string;
  media_type: string;
}

export interface UiVoiceRecording {
  fileId: string;
  durationMs: number;
  mimeType: string;
}

export interface UiQuestionOption {
  label: string;
  description?: string;
}

/** AskUserQuestion 卡片的问题 */
export interface UiQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: UiQuestionOption[];
}

export interface UiTool {
  name: string;
  input?: string;
  /** 从 SDK 完整工具入参提取的运行内容；独立于截断的 JSON 入参。 */
  activity?: string;
  /** 文件编辑工具（Edit/Write/MultiEdit）的增删行统计：步骤卡片显示「已编辑文件 <path> +N -M」 */
  edit?: { file: string; addedLines: number; removedLines: number };
  /** 工具执行状态（豆包 Work 式就地更新）：running=执行中 / completed=成功 / failed=失败 */
  status?: "running" | "completed" | "failed";
  /** 关联 tool_use_id（SSE tool 事件与 tool_result 事件配对用） */
  toolUseId?: string;
  /** 工具结果极简摘要（超长内容不展示原文，仅失败时展示错误信息） */
  result?: string;
  /** 结果是否因超长被截断（仅作提示，不展示全文） */
  resultTruncated?: boolean;
}

/** 一条思考步骤（thinking/text/tool/ask 与用时） */
export interface UiStep {
  thinking?: string;
  text?: string;
  tool?: UiTool | null;
  ask?: UiQuestion[] | null;
  answered?: string | null;
  secs?: number | null;
  /** control_browser 过程展示（headless 无头浏览器，截图/动作实时进 thinking） */
  browser?: BrowserStepData | null;
}

/** control_browser 过程数据：浏览器会话 id + 截图（base64）+ 动作日志 + 状态。
 *  ask 人工接管时前端凭 id POST /api/chat/browser-answer 回传答案。 */
export interface BrowserStepData {
  id: string;
  /** base64 截图仅用于右侧边栏实时预览（不再渲染进消息列表） */
  screenshots: string[];
  actions: Array<{ step: number; action: string; params?: Record<string, unknown> }>;
  thinking?: string;
  ask?: { step: number; question: string } | null;
  status?: string;
  finalSummary?: string;
}

/** 本轮模型信息（是否走了 fallback 积分模型） */
export interface ModelInfo {
  usedFallback?: boolean;
  fallbackModel?: string;
  models?: string[];
  agentMode?: "codebuddy" | "codex" | "cc" | "dsh";
}

/** 对话消息（流式内存态 / 历史恢复态共用） */
export interface UiMessage {
  /** 数据库消息 id（历史恢复的消息有，流式新建无） */
  id?: number;
  revokedAt?: string | null;
  role: "user" | "assistant";
  senderSub?: string | null;
  senderName?: string | null;
  senderAvatar?: string | null;
  content: string;
  /** 语音消息的原始录音；content 仍是发送给模型的转写文字。 */
  voice?: UiVoiceRecording;
  /** 仅本地视觉时间戳，不写入历史；覆盖正文/结束被合并成一次 React 提交的情况。 */
  revealAt?: number;
  /** 遗留字段（消息级思考文本已拆到 steps），保留以兼容初始化对象 */
  thinking?: string;
  createdAt?: string | null;
  attachment?: UiAttachment;
  attachments?: UiAttachment[];
  images?: UiImage[];
  steps?: UiStep[];
  thinkingSecs?: number | null;
  /** 共用时：用户发送该消息开始计时，到全部答复完成 / 用户点击停止为止（秒） */
  elapsedSecs?: number | null;
  modelInfo?: ModelInfo | null;
  /** 本轮消耗信息（result 消息：token usage 与美元成本；积分字段 SDK 未返回） */
  costInfo?: { costUsd?: number | null; usage?: Record<string, number> | null } | null;
  /** 本轮产物变更（服务端 artifact 事件：added/modified/deleted + 新旧内容） */
  artifacts?: ArtifactChange[];
}

/** 待发消息队列项 */
export interface QueueItem {
  id: string;
  text: string;
  voice?: UiVoiceRecording;
  attachment: UiAttachment | null;
  attachments?: UiAttachment[];
  /** 入队时的应用引用快照，避免冲刷时读取到后来修改的输入框引用。 */
  references?: Array<{ sourceId: string; reference: ComposerReference }>;
  /** 场景建议级提示词：建议直发遇忙入队时透传，冲刷发送时随该条注入（见 SceneSuggestion.prompt） */
  prompt?: string;
  createdAt: string;
}

/** 每个会话独立的运行时状态（切走不杀旧流，旧会话在后台继续 SSE） */
export interface RtState {
  messages: UiMessage[];
  busy: boolean;
  queue: QueueItem[];
  abort: AbortController | null;
  thinkingTimer: ReturnType<typeof setInterval> | null;
  thinkingStart: number | null;
  stepStarts: Map<number, number>;
  pendingAnswer: QueueItem | null;
  errorMsg: string | null;
  runId?: string | null;
  reconnectAttempt?: number;
  reconnectExhausted?: boolean;
  openThinking: Set<string>;
  sessionStarted: boolean;
  sessionRegistered: boolean;
  /** SDK transcript 用的 sessionId：正常 = sid；编辑重发时换新 UUID */
  sdkSid: string;
  /** 共用时计时起点：本条用户消息发送时刻（毫秒时间戳）；流结束/停止时算出 elapsedSecs */
  elapsedStart?: number | null;
  /**
   * 本轮运行期间用户是否查看过该会话（处于会话页且本轮已有流式内容产出）。
   * 用于修正侧边栏「已完成未查看」小绿圈的判定：用户边看边等结论时，
   * 即使完成事件发生在切走之后，也不应再标绿圈（见 markBusy）。
   */
  viewedDuringRun?: boolean;
}

/** 侧边栏会话项 */
export interface SessionItem {
  id: string;
  title: string;
  workflows?: Array<{ workflowId: string; appId: string; iconUrl: string; collectionIconUrl: string }>;
  memberCount?: number;
  /** 曾是/已是群聊（≥2 真人成员过）即永久为 true：成员减少也保持群聊形态，不回退单聊 */
  coworkEverGroup?: boolean;
  unreadCount?: number;
  muted?: boolean;
  /** AI 消息免打扰：仅对 AI（assistant）消息的通知生效；muted=true 时必然一并打开 */
  aiMuted?: boolean;
  aiUnread?: boolean;
  modelId?: string;
  peerName?: string | null;
  peerAvatar?: string | null;
  coworkAvatar?: string | null;
  lastPreview?: string | null;
  lastAssistantText?: string | null;
  lastSenderName?: string | null;
  lastQuestionPreview?: string | null;
  /** Latest user message only, for sessions with workflow previews. */
  lastUserPreview?: string | null;
  /** 最后一条用户消息的发送者（与 lastQuestionPreview 配套，避免错配成 AI 回复的发送者） */
  lastQuestionSenderName?: string | null;
  /** 最后一条人类消息（非本人发送）是否 @ 了当前用户：会话列表第二行据此显示 [有人@了你] */
  lastMentionedMe?: boolean;
  /** 纯 1v1 单聊：我发出的最后一条消息是否已被对方阅读（会话列表在消息预览下方显示绿色已读 check） */
  lastMessageReadByPeer?: boolean;
  updatedAt?: string | null;
  createdAt?: string | null;
  /** 本会话工作目录（沙箱范围，宿主选择后由服务端返回） */
  workspaceDir?: string | null;
  /** Sidebar grouping only; a Web client cannot access this local directory. */
  projectDir?: string | null;
  viewLayout?: "single" | "split" | "compare";
  pinOrder?: number | null;
  /** 接入的群会话 id：本 1v1 人机会话的 AI 可访问该群 uploads（只读）与 artifacts（可读写） */
  refGroupId?: string | null;
}

/** 宿主桌面会话目录快照（标题 / 预览 / 模型 / 状态）。 */
export interface SessionCardSnapshot {
  sessionId: string;
  /** 会话标题（服务端自动生成或用户重命名） */
  title: string;
  /** 预览文本：最后一条 AI 消息（内存实时），缺省回退会话列表 lastPreview */
  lastText: string;
  /** 完整的用户与 AI 对话正文，按时间顺序。 */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Current run activity, suitable for a compact desktop status line. */
  progress?: string;
  /** 执行该会话的模型（快照时刻） */
  model: string;
  /** running=正在执行；waiting=待确认；done=跑完未读；idle=其他已保存会话。 */
  status: "running" | "waiting" | "done" | "idle";
  updatedAt?: string | null;
  /** 该会话是否正被用户查看（宿主可据此弱化卡片视觉） */
  active?: boolean;
}

/** 拖拽「群聊」进输入框接入的自定义 MIME：只有群会话行会写它，输入框据此判断是否允许落下
 *  （dragover 阶段读不到 getData，只能读 types）。人机会话不带它 → 拖进来无反应，符合预期。 */
export const GROUP_DRAG_MIME = "application/x-agent-group";

/** 输入框里的「会话引用」胶囊：拖群聊 / 1v1 聊天进来后显示，发送即生效（服务端按会话持久化）。 */
export interface GroupRef {
  id: string;
  title: string;
  /** 头像（相对路径需拼 basePath，同侧边栏逻辑） */
  avatar?: string | null;
  /** group=多人/曾成群的群聊；peer=1v1 聊天对象。缺省按群渲染。 */
  kind?: "group" | "peer";
}

