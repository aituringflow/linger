import { createContext, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { AppearanceMode, ComputeProviderId, DesktopFileWidget, DesktopSessionGroup, DesktopWidgetPlacement, FireParams, LauncherDesktopSession, LauncherState, NotificationSound, Wallpaper } from "../../shared/types";
import type { ModelOption, SessionCardSnapshot, UiAttachment } from "@turingflow/agent-kit/ui";
import { BUILTIN_WALLPAPER, WALLPAPER_SKINS, wallpaperSkinId, isDynamicWallpaper } from "./wallpapers";

type View = "desktop" | "workspace";

interface UiState {
  launcher: LauncherState | null;
  models: Array<Exclude<ModelOption, string>>;
  modelsLoading: boolean;
  modelsLoadFailed: boolean;
  view: View;
  quickInput: boolean;
  focusMode: boolean;
  /** 渲染层 AgentWindow 的本地 Agent 服务地址（含鉴权 token），未就绪时渲染层等待。 */
  agentHost: { url: string } | null;
  /** Web 服务根地址（登录/会话账号，如 http://127.0.0.1:3100/linger）；未配置为 null。 */
  webAuth: { url: string } | null;
  /**
   * 登录账号身份（provider + unionId）；未登录为 null。
   *
   * 本机会话是**按账号分目录**落盘的（<userData>/chats/<base64url(provider:unionId)>），
   * kit 用 encodeUserKey(provider, unionId) 算出这个 owner 再去列会话。
   * 所以任何要读写会话的 kit 实例都必须拿到同一个身份 —— 桌面那些隐藏实例
   * （拖文件发消息 / 刷新卡片）漏传身份时会落到访客目录 local:guest，
   * 读不到账号下的会话，kit 就会报「会话不存在或不支持发送」。
   */
  webUser: { name: string; avatar?: string; provider: string; unionId: string } | null;
  /**
   * 账号身份是否已解析完（已登录 or 确认未登录）。
   * 隐藏实例要等这个标志为 true 才挂载，否则会先以访客身份跑一遍、白白失败一次。
   */
  webUserResolved: boolean;
  draggingDomain: { id: string; x: number; y: number; side: "left" | "right" | null; source?: "sidebar" | "dock"; remove?: boolean } | null;
  /**
   * 已打开的窗口 id，末尾 = 最上层（获得焦点）。
   * "primary" 是 Home 的主窗口，其余是数域窗口（每个数域一个独立 frame，像操作系统里的多个应用窗口）。
   */
  openWindows: string[];
  /**
   * 最小化（收起）的窗口 id：窗口**不卸载**（AgentWindow 挂着，会话继续跑），只是不可见。
   * 收起要「记住状态」：当前打开的会话、左右侧面板开合、输入框草稿全在 kit 组件实例里，
   * 所以最小化一律只隐藏、不销毁；点 Dock 图标从 这里 恢复。
   * 与 CLOSE_CHAT 的区别是「关掉就忘」：真关闭会卸载实例，下次打开是全新窗口。
   */
  minimizedWindows: string[];
  /** 启动过的数域：未固定的数域窗口关掉后要从 Dock 上消失，所以「运行中」不能只看 openWindows 的历史。 */
  launchedDomains: string[];
  /**
   * 聚焦窗口当前归属的 Dock 项："primary" = Home 主入口，其余为数域 id；null = 没有任何窗口。
   * 仅供「哪块是高亮/当前窗口」使用；Dock 的灰点请用 openWindows（所有开着的窗口都有灰点）。
   */
  focusDockItemId: string | null;
  /**
   * 每个上报方（聊天窗 / 工作区 / 桌面后台实例）各自上报的运行中会话 id（含切走后仍在后台跑的）。
   * Dock 上的数字取**去重后的会话数**：同一轮任务可能同时被两个实例上报（桌面拖文件发起的那轮，
   * 打开 home chat 后又被聊天窗接管），按窗口求和会把一轮算成两个任务。
   */
  runningSessionsByWindow: Record<string, string[]>;
  /**
   * 每个窗口各自上报的运行中会话快照（标题/最后消息/模型/状态）：桌面「进行中」行的卡片数据源。
   * 会话完成后保留未读卡片，打开会话后才从快照里消失。
   */
  sessionCardsByWindow: Record<string, SessionCardSnapshot[]>;
  desktopCatalog: LauncherDesktopSession[];
  /**
   * 正在录音的窗口 id（按住 Windows 右 Alt / macOS Option 期间）。低频状态：
   * Dock 用它决定要不要在 Home 图标上播声波；音量本身不走 state（见 dock/voiceLevel.ts）。
   */
  voiceRecordingWindow: string | null;
  /** 正在把录音转成文字的窗口（转写中）：Home 声波要显示"处理中"而不是退回初始值。 */
  voiceTranscribingWindow: string | null;
  /**
   * 语音链路的失败提示（非空时 Dock 在 Home 上方浮一条错误条）。
   *
   * 为什么必须进 state 而不是 Dock 的局部变量：失败点全在异步链路里（签发会话 / 连 wss /
   * 开麦克风），回调可能在本次 keydown 处理结束之后才回来，用局部状态容易「写进没人读的闭包」。
   * 目前只有主入口（primary）会写；录音失败本身就是全局事件，不按窗口区分。
   */
  voiceError: { message: string; detail?: string; action?: "login"; at: number } | null;
  /**
   * 语音优先「一句一对话」松手即发后，进入极简态的窗口 id 列表。
   * 极简态：输入区只留文字+背景、不显示框架控制按钮与标题栏，答复区直接展示回答。
   * 窗口关闭时清掉（见 CLOSE_CHAT），下次打开就是普通完整窗口。
   */
  voiceFirstMinimal: string[];
  /**
   * 每个窗口待处理的「跳到指定会话」请求（来源：点击系统通知）。
   * 窗口可能还没挂载 / 正在启动，所以请求先存在这里，由重新挂载的 AgentWindow 消费。
   */
  sessionRequests: Record<string, { sessionId: string; nonce: number }>;
  /**
   * 每个窗口待处理的「把联系人 @ 进 home 输入框」请求（来源：联系人窗口点「发消息」）。
   * 与 sessionRequests 同模式：窗口可能还没挂载，请求先存这儿，由 AgentWindow 消费后清掉。
   */
  mentionRequests: Record<string, { person: { id: string; name: string; avatar: string }; nonce: number }>;
  /**
   * 每个窗口待处理的「把附件放进输入框」请求。
   * 来源：桌面把文件管理里的文件拖到聊天窗 / 会话卡片停留 2 秒后松手 / Dock 的 home 按钮。
   *
   * 存队列而不是单条，两个原因：
   *  · 窗口可能还没挂载（home 悬浮输入框是拖到按钮上才浮出来的），请求先存这儿，等它起来再消费；
   *  · 连着拖两三次时不能互相覆盖。
   */
  attachRequests: Record<string, Array<{ nonce: number; sessionId?: string; attachments: UiAttachment[] }>>;
  /**
   * 每个窗口待处理的「直接发一轮消息」请求（来源：语音优先的自动发送）。
   * 与 attachRequests 同样的思路：窗口可能还没挂载 / 正在启动，请求先落在这里，
   * 由挂载后的 AgentWindow 消费（`newChat` 时它先新建对话再发）。
   */
  sendRequests: Record<string, Array<{ nonce: number; text: string; sessionId?: string }>>;
  /**
   * 「卡片已停留够久」的提示：告诉用户此刻松手，文件会进**这个窗口**的输入框。
   * 提示挂在聊天窗上而不是卡片上 —— 停留到点时卡片本身往往已经从桌面消失了
   * （打开会话后那张「进行中」卡片就没了），挂卡片上等于没人看得到。
   */
  fileAttachHint: { windowId: string; sessionId: string } | null;
  /**
   * 「选择数域」窗口是否打开。它本身也是一个 WindowFrame 窗口（只是只有关闭按钮），
   * 所以开关状态必须放在这里，由桌面层统一渲染，而不是挂在某个聊天窗的局部 state 上。
   */
  domainPickerOpen: boolean;
  /**
   * 「系统设置」窗口是否打开。与选择数域同一类：本身是一个 WindowFrame 窗口（只有关闭按钮），
   * 内容就是右键 Home 弹出的那一整套设置（AppearanceMenu），开关状态放这里由桌面层统一渲染。
   */
  settingsWindowOpen: boolean;
  /**
   * 「关于」窗口是否打开。与系统设置同一类：本身是一个 WindowFrame 窗口（只有关闭按钮），
   * 内容只有静态的版本信息，开关状态放这里由桌面层统一渲染。
   */
  aboutWindowOpen: boolean;
}

/**
 * home chat 窗口判定：主窗口 "primary"（Home 主入口，含 hover 预览）+
 * 多窗口实例 "primary-<n>"（右键菜单「新建窗口」创建，独立会话/独立 frame）。
 */
export function isHomeChatWindow(windowId: string): boolean {
  return windowId === "primary" || windowId.startsWith("primary-");
}

/**
 * 当前存在的 home chat 窗口，按「已打开 / 已收起」分组。
 *
 * Dock 的灰点、Home 左键行为、多窗口预览和右键菜单的「关闭全部」共用这一份口径 ——
 * 以前各处自己 `[...openWindows, ...minimizedWindows].filter(isHomeChatWindow)` 拼一遍，
 * 加一个「只算收起的」需求就得改四五处，很容易口径分叉。
 */
export function homeChatWindows(openWindows: readonly string[], minimizedWindows: readonly string[]) {
  return {
    /** 可见的（含最上层顺序）。 */
    open: openWindows.filter(isHomeChatWindow),
    /** 收起的（隐藏但实例还活着）。 */
    minimized: minimizedWindows.filter(isHomeChatWindow),
    /** 全部（已打开在前、收起的在后）。 */
    all: [...openWindows, ...minimizedWindows].filter(isHomeChatWindow),
  };
}

/** 系统设置里「算力提供商」的全部条目（顺序 = 面板里的排列顺序）。 */
export const COMPUTE_PROVIDER_IDS: readonly ComputeProviderId[] = ["workbuddy", "codex", "dsh"];

/**
 * 未设置启用状态时默认启用 WorkBuddy 和 DeepSeek Harness。
 * 未配置密钥的提供商仍不会出现在可用框架中。
 */
const DEFAULT_ENABLED_COMPUTE_PROVIDERS: readonly ComputeProviderId[] = ["workbuddy", "dsh"];

/**
 * 已启用的算力提供商；没有持久化配置时使用默认值。
 * 只保留已知 id，避免手改 state 文件塞进来串味的值。
 */
export function enabledComputeProviders(launcher: LauncherState | null): ComputeProviderId[] {
  const configured = launcher?.enabledComputeProviders;
  if (!Array.isArray(configured)) return [...DEFAULT_ENABLED_COMPUTE_PROVIDERS];
  const valid = COMPUTE_PROVIDER_IDS.filter((id) => configured.includes(id));
  // 一个都不剩时回落到默认：聊天窗总得有个框架能开口。
  return valid.length ? valid : [...DEFAULT_ENABLED_COMPUTE_PROVIDERS];
}

/**
 * 已启用的框架（kit 的 agentMode 口径），作为 AgentWindow 的 agentModesOverride。
 * workbuddy → codebuddy：面板里叫 WorkBuddy，kit 内部叫 codebuddy。
 */
export function enabledAgentModes(launcher: LauncherState | null): ("codebuddy" | "codex" | "dsh")[] {
  return enabledComputeProviders(launcher).map((id) => id === "workbuddy" ? "codebuddy" : id);
}

type Action =
  | { type: "STATE_LOADED"; state: LauncherState }
  | { type: "SET_MODELS"; models: Array<Exclude<ModelOption, string>> }
  | { type: "SET_MODELS_LOADING" }
  | { type: "SET_MODELS_FAILED" }
  | { type: "SET_AGENT_HOST"; url: string }
  | { type: "SET_WEB_AUTH"; url: string | null }
  | { type: "SET_WEB_USER"; user: { name: string; avatar?: string; provider: string; unionId: string } | null }
  | { type: "SET_VIEW"; view: View }
  | { type: "SET_QUICK_INPUT"; open: boolean }
  | { type: "OPEN_FOCUS_CHAT" }
  /**
   * 把 Home 主窗口从「悬浮预览」提升为「完整打开」（加入 openWindows、置顶），
   * 但**不**像 OPEN_FOCUS_CHAT 那样跳到未读会话。
   * 语音优先「一句一对话」松手即发时用：窗口在第一个文字出现时以预览形态浮出，
   * 此刻要升级成完整窗口好让回答有地方显示，但绝不能跳走——这一轮语音要落在新建的对话里。
   */
  | { type: "PROMOTE_PRIMARY" }
  | { type: "COLLAPSE_FOCUS_CHAT" }
  | { type: "OPEN_NEW_HOME_CHAT" }
  | { type: "OPEN_DOMAIN_FOCUS_CHAT"; domainId: string }
  | { type: "FOCUS_CHAT_WINDOW"; windowId: string }
  | { type: "CLOSE_CHAT"; windowId?: string }
  | { type: "MINIMIZE_CHAT"; windowId: string }
  /** 从最小化恢复（回到 openWindows 末尾 = 置顶，窗口实例一直是活的）。 */
  | { type: "RESTORE_CHAT"; windowId: string }
  | { type: "SET_ACTIVE_DOMAIN"; domainId: string }
  | { type: "SET_DOMAIN_DRAG"; drag: UiState["draggingDomain"] }
  | { type: "PIN_DOCK_DOMAIN"; domainId: string; side: "left" | "right" }
  | { type: "UNPIN_DOCK_DOMAIN"; domainId: string }
  /**
   * Dock 内拖动排序：把图标插到某侧的 index（**已经把自己摘掉之后**的下标）。
   * `preview` = 拖动过程中的即时换位：只动位置、不结束拖拽（幽灵图标还要跟着指针）。
   */
  | { type: "MOVE_DOCK_DOMAIN"; domainId: string; side: "left" | "right"; index: number; preview?: boolean }
  | { type: "SET_WALLPAPER"; wallpaper: Wallpaper }
  | { type: "SET_LANGUAGE"; language: "system" | "zh-CN" | "en" }
  | { type: "SET_APPEARANCE"; appearance: AppearanceMode }
  | { type: "SET_RUNNING_WIDGET"; widget: DesktopWidgetPlacement | undefined }
  | { type: "ADD_SESSION_GROUP"; group: DesktopSessionGroup }
  | { type: "UPDATE_SESSION_GROUP"; id: string; title?: string; placement?: DesktopWidgetPlacement }
  | { type: "DELETE_SESSION_GROUP"; id: string }
  | { type: "ADD_FILE_WIDGET"; widget: DesktopFileWidget }
  | { type: "UPDATE_FILE_WIDGET"; id: string; placement?: DesktopWidgetPlacement; view?: "icons" | "list" | "columns"; dir?: string }
  | { type: "DELETE_FILE_WIDGET"; id: string }
  | { type: "MOVE_SESSION_TO_GROUP"; sessionId: string; groupId: string | null; index?: number }
  | { type: "SET_FIRE_PARAMS"; fireParams: Partial<FireParams> }
  | { type: "SET_GOLD_PARAMS"; goldParams: Partial<import("../../shared/types").GoldParams> }
  | { type: "SET_WATER_PARAMS"; waterParams: Partial<import("../../shared/types").WaterParams> }
  | { type: "SET_SHOW_MODEL"; show: boolean }
  | { type: "SET_SHOW_CONTEXT_USAGE"; show: boolean }
  | { type: "SET_SHOW_VOICE_BUTTON"; show: boolean }
  | { type: "SET_RIGHT_CTRL_VOICE"; enabled: boolean }
  | { type: "SET_VOICE_PREVIEW_ONLY"; enabled: boolean }
  | { type: "SET_VOICE_FIRST"; enabled: boolean }
  /** 语音优先模式下聊天窗的自动消失时间（分钟，0 = 不消失）。 */
  | { type: "SET_VOICE_FIRST_WINDOW_MINUTES"; minutes: number }
  | { type: "SET_NOTIFICATION_SOUND"; sound: NotificationSound }
  | { type: "SET_DRAGON_FIRE_SOUND"; enabled: boolean }
  | { type: "SET_DRAGON_VISIBLE"; visible: boolean }
  | { type: "SET_AUTO_HIDE_DOCK"; enabled: boolean }
  | { type: "SET_DOCK_DOMAIN_ENTRY"; enabled: boolean }
  | { type: "SET_KEEP_AWAKE_ON_TASK"; enabled: boolean }
  | { type: "SET_COMPUTE_PROVIDER_ENABLED"; provider: ComputeProviderId; enabled: boolean }
  | { type: "OPEN_NOTIFICATION_SESSION"; windowId: string; sessionId: string; nonce: number }
  | { type: "CLEAR_SESSION_REQUEST"; windowId: string; nonce: number }
  | { type: "QUEUE_MENTION_REQUEST"; windowId: string; person: { id: string; name: string; avatar: string } }
  | { type: "CLEAR_MENTION_REQUEST"; windowId: string; nonce: number }
  | { type: "QUEUE_ATTACH_REQUEST"; windowId: string; sessionId?: string; attachments: UiAttachment[] }
  | { type: "CLEAR_ATTACH_REQUEST"; windowId: string; nonce: number }
  /**
   * 语音优先：把一轮识别好的话**直接发出去**（不经过回车）。
   * `sessionId` 省略 = 新开一条对话（语音优先的核心口径：一句一对话）。
   */
  | { type: "QUEUE_SEND_REQUEST"; windowId: string; text: string; sessionId?: string }
  | { type: "CLEAR_SEND_REQUEST"; windowId: string; nonce: number }
  | { type: "SET_FILE_ATTACH_HINT"; hint: { windowId: string; sessionId: string } | null }
  | { type: "SET_SELECTED_MODEL"; model: string }
  | { type: "SET_SKIN"; domainId: string; skinColor: string }
  | { type: "SET_RUNNING_SESSIONS"; windowId: string; sessions: readonly string[] }
  | { type: "SET_SESSION_CARDS"; windowId: string; cards: SessionCardSnapshot[] }
  | { type: "SET_DESKTOP_CATALOG"; sessions: LauncherDesktopSession[] }
  | { type: "SET_VOICE_RECORDING"; windowId: string }
  | { type: "CLEAR_VOICE_RECORDING"; windowId: string }
  | { type: "SET_VOICE_TRANSCRIBING"; windowId: string }
  | { type: "CLEAR_VOICE_TRANSCRIBING"; windowId: string }
  | { type: "SET_VOICE_ERROR"; message: string; detail?: string; action?: "login" }
  | { type: "SET_VOICE_FIRST_MINIMAL"; windowId: string; value: boolean }
  | { type: "CLEAR_VOICE_ERROR" }
  | { type: "SET_DOMAIN_PICKER"; open: boolean }
  | { type: "SET_SETTINGS_WINDOW"; open: boolean }
  | { type: "SET_ABOUT_WINDOW"; open: boolean };

/** 把某个窗口移到数组末尾 = 置顶（z-index 与焦点都按这个顺序）。 */
function raiseWindow(state: UiState, windowId: string): string[] {
  return state.openWindows.includes(windowId)
    ? [...state.openWindows.filter((id) => id !== windowId), windowId]
    : [...state.openWindows, windowId];
}

/** 窗口集合变化后重新推导派生态（有没有窗口 / 谁在最前 / 输入浮层是否显示）。
 *  runningSessionsByWindow 原样带过：计数由各窗口自己上报、自己卸载时归零，
 *  这里再按 openWindows 清一次会误删全屏工作区（它不占 openWindows）的上报。 */
function windowPatch(openWindows: string[], runningSessionsByWindow: Record<string, string[]>) {
  const front = openWindows.at(-1) ?? null;
  return {
    openWindows,
    focusMode: openWindows.length > 0,
    // Home 的悬停输入框只属于 primary；数域窗口打开不应把它标成已打开。
    quickInput: openWindows.includes("primary"),
    focusDockItemId: front,
    runningSessionsByWindow,
  };
}

/**
 * 真正关闭一个窗口（从 openWindows / minimizedWindows 移除 → frame 卸载）。
 * 区别于「最小化」：卸载会终止 AgentWindow 及其所有会话流，窗口的会话/面板/草稿状态一起丢掉
 * （这就是「关闭不需要记住状态」的实现方式）。
 */
function closeWindow(state: UiState, windowId: string): UiState {
  const s = state.launcher;
  const openWindows = state.openWindows.filter((id) => id !== windowId);
  const pins = s?.dockPins ?? { left: [], right: [] };
  const pinned = pins.left.includes(windowId) || pins.right.includes(windowId);
  // 窗口关掉就丢弃它的待跳转请求：否则下次普通打开会莫名其妙跳到一条旧通知的会话上。
  const sessionRequests = { ...state.sessionRequests };
  delete sessionRequests[windowId];
  // 同样丢弃这个窗口没消费完的「@联系人」请求（窗口都没了，请求留着也没人接）。
  const mentionRequests = { ...state.mentionRequests };
  delete mentionRequests[windowId];
  // 同样丢弃这个窗口没消费完的「附件进输入框」请求：窗口都没了，请求留着也没人接。
  const attachRequests = { ...state.attachRequests };
  delete attachRequests[windowId];
  // 「直接发一轮消息」同理（窗口关掉后重开是全新实例，旧请求不该在下次打开时补发）。
  const sendRequests = { ...state.sendRequests };
  delete sendRequests[windowId];
  // 真关闭会终止此窗口的会话流；同步清掉它的运行计数，Home 光环才能立即进入减速流程。
  const runningSessionsByWindow = { ...state.runningSessionsByWindow };
  delete runningSessionsByWindow[windowId];
  return {
    ...state,
    ...windowPatch(openWindows, runningSessionsByWindow),
    sessionRequests,
    mentionRequests,
    attachRequests,
    sendRequests,
    // 没固定过的数域窗口一关就从 Dock 消失；固定过的留着图标（灰点随 openWindows 自动灭掉）。
    launchedDomains: windowId === "primary" || pinned
      ? state.launchedDomains
      : state.launchedDomains.filter((id) => id !== windowId),
    minimizedWindows: state.minimizedWindows.filter((id) => id !== windowId),
  };
}

function reducer(state: UiState, action: Action): UiState {
  const s = state.launcher;
  switch (action.type) {
    case "STATE_LOADED":
      return { ...state, launcher: action.state };
    case "SET_MODELS":
      return { ...state, models: action.models, modelsLoading: false, modelsLoadFailed: false };
    case "SET_MODELS_LOADING":
      return { ...state, modelsLoading: true, modelsLoadFailed: false };
    case "SET_MODELS_FAILED":
      return { ...state, modelsLoading: false, modelsLoadFailed: true };
    case "SET_AGENT_HOST":
      return { ...state, agentHost: { url: action.url } };
    case "SET_WEB_AUTH":
      return { ...state, webAuth: action.url ? { url: action.url } : null };
    case "SET_WEB_USER":
      return { ...state, webUser: action.user, webUserResolved: true };
    case "SET_VIEW":
      // 进入全屏工作区时收起桌面浮层与所有窗口，避免同一页面挂多个 AgentWindow 实例。
      return action.view === "workspace"
        ? { ...state, view: action.view, ...windowPatch([], state.runningSessionsByWindow), launchedDomains: [], domainPickerOpen: false, settingsWindowOpen: false, aboutWindowOpen: false }
        : { ...state, view: action.view };
    case "SET_QUICK_INPUT":
      return { ...state, quickInput: action.open };
    case "OPEN_FOCUS_CHAT": {
      // 从最小化恢复时保持之前的会话状态，不强制跳转未读；
      // 只有从关闭状态重新打开时，才跳到未读会话。
      const wasMinimized = state.minimizedWindows.includes("primary");
      const activeUnread = !wasMinimized
        ? state.sessionCardsByWindow.primary?.find((card) => card.status === "done" && card.active)
        : null;
      return {
        ...state,
        ...windowPatch(raiseWindow(state, "primary"), state.runningSessionsByWindow),
        minimizedWindows: state.minimizedWindows.filter((id) => id !== "primary"),
        sessionRequests: activeUnread
          ? { ...state.sessionRequests, primary: { sessionId: activeUnread.sessionId, nonce: Date.now() } }
          : state.sessionRequests,
      };
    }
    case "PROMOTE_PRIMARY":
      // 与 OPEN_FOCUS_CHAT 的唯一差别：不检查未读会话、不设 sessionRequest。
      // 语音优先松手即发必须停在「新建对话」上，跳到未读会话会把这一轮语音追加进旧对话。
      return {
        ...state,
        ...windowPatch(raiseWindow(state, "primary"), state.runningSessionsByWindow),
        minimizedWindows: state.minimizedWindows.filter((id) => id !== "primary"),
      };
    // 「新建窗口」：再开一个独立的 home chat 窗口（primary-<n>）。id 从现有窗口推断，
    // 避免关掉又重建后序号回落（两个窗口同时开着时序号必须唯一）。
    case "OPEN_NEW_HOME_CHAT": {
      let max = 1;
      for (const id of [...state.openWindows, ...state.minimizedWindows]) {
        const match = /^primary-(\d+)$/.exec(id);
        if (match) max = Math.max(max, Number(match[1]) + 1);
      }
      const windowId = `primary-${max}`;
      return {
        ...state,
        ...windowPatch([...state.openWindows, windowId], state.runningSessionsByWindow),
        minimizedWindows: state.minimizedWindows.filter((id) => id !== windowId),
      };
    }
    case "OPEN_DOMAIN_FOCUS_CHAT": {
      if (!s || (action.domainId !== "settings" && !s.domains.some((domain) => domain.id === action.domainId))) return state;
      return {
        ...state,
        launcher: { ...s, activeDomainId: action.domainId },
        ...windowPatch(raiseWindow(state, action.domainId), state.runningSessionsByWindow),
        // 打开过的数域要留在 Dock 上（未固定的窗口关掉后才移除，见 CLOSE_CHAT）
        launchedDomains: state.launchedDomains.includes(action.domainId) ? state.launchedDomains : [...state.launchedDomains, action.domainId],
        minimizedWindows: state.minimizedWindows.filter((id) => id !== action.domainId),
      };
    }
    case "FOCUS_CHAT_WINDOW":
      // 已经在最上层就不动：FocusWindowFrame 每次 pointerdown 都会调它，
      // 无脑重排会白推一次全窗口重渲染。
      return state.openWindows.includes(action.windowId) && state.openWindows.at(-1) !== action.windowId
        ? { ...state, ...windowPatch(raiseWindow(state, action.windowId), state.runningSessionsByWindow), minimizedWindows: state.minimizedWindows.filter((id) => id !== action.windowId) }
        : { ...state, minimizedWindows: state.minimizedWindows.filter((id) => id !== action.windowId) };
    case "MINIMIZE_CHAT": {
      if (!state.openWindows.includes(action.windowId)) return state;
      /**
       * 最小化 = 收起（**永远不销毁实例**）。
       * 窗口要「记住」当前打开的会话、左右侧面板开合、草稿，这些都活在 kit 的组件实例里，
       * 所以只能隐藏不能卸载 —— 空闲窗口也一样。
       * （旧行为是「没有运行中会话就直接关掉」，那会让用户收起再打开就换成了一个新窗口。）
       */
      const openWindows = state.openWindows.filter((id) => id !== action.windowId);
      return {
        ...state,
        ...windowPatch(openWindows, state.runningSessionsByWindow),
        minimizedWindows: state.minimizedWindows.includes(action.windowId)
          ? state.minimizedWindows
          : [...state.minimizedWindows, action.windowId],
      };
    }
    case "RESTORE_CHAT": {
      // 从最小化恢复：重新回到 openWindows 末尾（= 置顶）。窗口实例一直挂着，恢复即原样。
      const minimizedWindows = state.minimizedWindows.filter((id) => id !== action.windowId);
      if (state.openWindows.at(-1) === action.windowId && minimizedWindows.length === state.minimizedWindows.length) return state;
      return {
        ...state,
        view: "desktop",
        ...windowPatch(raiseWindow(state, action.windowId), state.runningSessionsByWindow),
        minimizedWindows,
      };
    }
    case "CLOSE_CHAT": {
      // 无参 = 收掉 hover 预览 / 关最前那个窗口（Desktop 点空白收起浮层走的就是这条）。
      const windowId = action.windowId ?? state.focusDockItemId;
      if (!windowId) return state.quickInput ? { ...state, quickInput: false } : state;
      // 收起的窗口也能直接关（多窗口预览里的关闭按钮走这条）：它不在 openWindows 里，
      // 但实例还挂着，必须同样走 closeWindow 卸载掉。
      if (!state.openWindows.includes(windowId) && !state.minimizedWindows.includes(windowId)) return state;
      const closed = closeWindow(state, windowId);
      // 极简态是挂在某个具体窗口实例上的，关掉就不再是极简窗，下次打开是普通完整窗口。
      if (!closed.voiceFirstMinimal.includes(windowId)) return closed;
      return { ...closed, voiceFirstMinimal: closed.voiceFirstMinimal.filter((id) => id !== windowId) };
    }
    case "SET_RUNNING_SESSIONS": {
      const current = state.runningSessionsByWindow[action.windowId] ?? [];
      // 会话集合没变就不更新 state：kit 每次渲染都可能重报一次，别让整棵 launcher 白刷。
      if (current.length === action.sessions.length && current.every((sid) => action.sessions.includes(sid))) return state;
      const runningSessionsByWindow = { ...state.runningSessionsByWindow };
      if (action.sessions.length > 0) runningSessionsByWindow[action.windowId] = [...action.sessions];
      else delete runningSessionsByWindow[action.windowId];
      return { ...state, runningSessionsByWindow };
    }
    case "SET_SESSION_CARDS": {
      // 注意：这里**不能**再顺手关掉「已收起的空闲窗口」。收起 = 记住状态，跑完也不该自己消失
      // （否则最小化后一轮跑完窗口就没了，恢复出来的窗口和收起前不是同一个）。
      const sessionCardsByWindow = { ...state.sessionCardsByWindow };
      if (action.cards.length > 0) sessionCardsByWindow[action.windowId] = action.cards;
      else delete sessionCardsByWindow[action.windowId];
      return { ...state, sessionCardsByWindow };
    }
    case "SET_DESKTOP_CATALOG":
      return { ...state, desktopCatalog: action.sessions };
    case "SET_VOICE_RECORDING":
      return state.voiceRecordingWindow === action.windowId
        ? state
        : { ...state, voiceRecordingWindow: action.windowId };
    case "CLEAR_VOICE_RECORDING":
      // 只清自己：窗口卸载时别的窗口可能正在录音
      return state.voiceRecordingWindow === action.windowId
        ? { ...state, voiceRecordingWindow: null }
        : state;
    case "SET_VOICE_TRANSCRIBING":
      return state.voiceTranscribingWindow === action.windowId
        ? state
        : { ...state, voiceTranscribingWindow: action.windowId };
    case "CLEAR_VOICE_TRANSCRIBING":
      return state.voiceTranscribingWindow === action.windowId
        ? { ...state, voiceTranscribingWindow: null }
        : state;
    case "SET_VOICE_ERROR":
      // at 用于「旧错误不能盖住新错误」的排序判断由渲染侧负责；这里只记最后一次。
      return { ...state, voiceError: { message: action.message, detail: action.detail, action: action.action, at: Date.now() } };
    case "CLEAR_VOICE_ERROR":
      return state.voiceError ? { ...state, voiceError: null } : state;
    case "SET_VOICE_FIRST_MINIMAL": {
      const has = state.voiceFirstMinimal.includes(action.windowId);
      if (action.value === has) return state;
      const voiceFirstMinimal = action.value
        ? [...state.voiceFirstMinimal, action.windowId]
        : state.voiceFirstMinimal.filter((id) => id !== action.windowId);
      return { ...state, voiceFirstMinimal };
    }
    case "SET_ACTIVE_DOMAIN":
      return s ? { ...state, launcher: { ...s, activeDomainId: action.domainId } } : state;
    case "SET_DOMAIN_DRAG":
      return { ...state, draggingDomain: action.drag };
    case "SET_DOMAIN_PICKER":
      // 关掉选择数域窗口时顺手清掉半途的拖拽态，避免留下一个幽灵图标。
      return { ...state, domainPickerOpen: action.open, draggingDomain: action.open ? state.draggingDomain : null };
    case "SET_SETTINGS_WINDOW":
      return { ...state, settingsWindowOpen: action.open };
    case "SET_ABOUT_WINDOW":
      return { ...state, aboutWindowOpen: action.open };
    case "PIN_DOCK_DOMAIN": {
      if (!s || (action.domainId !== "settings" && !s.domains.some((domain) => domain.id === action.domainId))) return state;
      const pins = s.dockPins ?? { left: [], right: [] };
      const left = pins.left.filter((id) => id !== action.domainId);
      const right = pins.right.filter((id) => id !== action.domainId);
      if (action.side === "left") left.push(action.domainId);
      else right.unshift(action.domainId);
      return { ...state, launcher: { ...s, dockPins: { left, right } }, draggingDomain: null };
    }
    case "UNPIN_DOCK_DOMAIN": {
      if (!s) return state;
      const pins = s.dockPins ?? { left: [], right: [] };
      return {
        ...state,
        launcher: { ...s, dockPins: { left: pins.left.filter((id) => id !== action.domainId), right: pins.right.filter((id) => id !== action.domainId) } },
        draggingDomain: null,
      };
    }
    /**
     * Dock 内拖动换位。语义与 PIN 一致（都是「固定在这一侧的某个位置」），
     * 只是位置由拖动落点决定。index 的基准是**从两侧摘掉自己之后**的数组，
     * 所以同侧往前/往后挪、跨过 Home 换到另一侧，都走这一条分支。
     * 未固定（临时停在 Dock 右侧）的图标被拖到某个位置，等同于固定在那儿。
     */
    case "MOVE_DOCK_DOMAIN": {
      if (!s) return state;
      if (action.domainId !== "settings" && !s.domains.some((domain) => domain.id === action.domainId)) return state;
      const pins = s.dockPins ?? { left: [], right: [] };
      const left = pins.left.filter((id) => id !== action.domainId);
      const right = pins.right.filter((id) => id !== action.domainId);
      const list = action.side === "left" ? left : right;
      list.splice(Math.max(0, Math.min(list.length, action.index)), 0, action.domainId);
      return {
        ...state,
        launcher: { ...s, dockPins: { left, right } },
        // 预览（拖动中）保留拖拽态：幽灵图标要一直跟着指针，直到松手才收。
        draggingDomain: action.preview ? state.draggingDomain : null,
      };
    }
    case "SET_WALLPAPER":
      // 选壁纸即切换外观分类：wp4 / wp5 属于动态壁纸。
      return s ? { ...state, launcher: { ...s, wallpaper: action.wallpaper, appearance: isDynamicWallpaper(action.wallpaper) ? "dynamic" : "static", customWallpaper: action.wallpaper.kind === "builtin" ? action.wallpaper.value : s.customWallpaper } } : state;
    case "SET_RUNNING_WIDGET":
      return s ? { ...state, launcher: { ...s, runningWidget: action.widget } } : state;
    case "ADD_SESSION_GROUP":
      return s && !(s.sessionGroups ?? []).some((group) => group.id === action.group.id)
        ? { ...state, launcher: { ...s, sessionGroups: [...(s.sessionGroups ?? []), action.group] } } : state;
    case "UPDATE_SESSION_GROUP":
      return s ? { ...state, launcher: { ...s, sessionGroups: (s.sessionGroups ?? []).map((group) => group.id === action.id
        ? { ...group, title: action.title ?? group.title, placement: action.placement ?? group.placement } : group) } } : state;
    case "DELETE_SESSION_GROUP":
      return s ? { ...state, launcher: { ...s, sessionGroups: (s.sessionGroups ?? []).filter((group) => group.id !== action.id) } } : state;
    case "ADD_FILE_WIDGET":
      // 同一个 id 不重复入列：右键「添加文件管理」刚点完又点一次时兜底。
      return s && !(s.fileWidgets ?? []).some((widget) => widget.id === action.widget.id)
        ? { ...state, launcher: { ...s, fileWidgets: [...(s.fileWidgets ?? []), action.widget] } } : state;
    case "UPDATE_FILE_WIDGET":
      return s ? { ...state, launcher: { ...s, fileWidgets: (s.fileWidgets ?? []).map((widget) => widget.id === action.id
        ? { ...widget, ...(action.placement ? { placement: action.placement } : {}), ...(action.view ? { view: action.view } : {}), ...(action.dir !== undefined ? { dir: action.dir } : {}) } : widget) } } : state;
    case "DELETE_FILE_WIDGET":
      return s ? { ...state, launcher: { ...s, fileWidgets: (s.fileWidgets ?? []).filter((widget) => widget.id !== action.id) } } : state;
    case "MOVE_SESSION_TO_GROUP": {
      if (!s) return state;
      const groups = (s.sessionGroups ?? []).map((group) => ({ ...group, sessionIds: group.sessionIds.filter((id) => id !== action.sessionId) }));
      const target = groups.find((group) => group.id === action.groupId);
      if (target) target.sessionIds.splice(Math.max(0, Math.min(action.index ?? target.sessionIds.length, target.sessionIds.length)), 0, action.sessionId);
      return { ...state, launcher: { ...s, sessionGroups: groups } };
    }
    case "SET_LANGUAGE":
      return s ? { ...state, launcher: { ...s, language: action.language } } : state;
    case "SET_APPEARANCE": {
      if (!s) return state;
      if (action.appearance === "light" || action.appearance === "dark") {
        return { ...state, launcher: { ...s, appearance: action.appearance, wallpaper: { kind: "builtin" as const, value: BUILTIN_WALLPAPER.url } } };
      }
      if (action.appearance === "dynamic") {
        return { ...state, launcher: { ...s, appearance: "dynamic", wallpaper: { kind: "builtin" as const, value: WALLPAPER_SKINS[3].url } } };
      }
      // static：沿用当前静态壁纸（非熔火龙境），否则回到默认静态壁纸 wp1。
      const staticWallpaper = s.wallpaper.kind === "builtin" && !isDynamicWallpaper(s.wallpaper) && s.wallpaper.value !== BUILTIN_WALLPAPER.url
        ? s.wallpaper
        : { kind: "builtin" as const, value: WALLPAPER_SKINS[0].url };
      return { ...state, launcher: { ...s, appearance: "static", wallpaper: staticWallpaper } };
    }
    case "SET_FIRE_PARAMS":
      return s ? { ...state, launcher: { ...s, fireParams: { ...(s.fireParams ?? { intensity: 2, amplitude: 50 }), ...action.fireParams } } } : state;
    case "SET_GOLD_PARAMS":
      return s ? { ...state, launcher: { ...s, goldParams: { ...(s.goldParams ?? { speed: 1, sparkle: 1 }), ...action.goldParams } } } : state;
    case "SET_WATER_PARAMS":
      return s ? { ...state, launcher: { ...s, waterParams: { ...(s.waterParams ?? { intensity: 1, amplitude: .2, tint: "#4a9fca" }), ...action.waterParams } } } : state;
    case "SET_SHOW_MODEL":
      return s ? { ...state, launcher: { ...s, showModel: action.show } } : state;
    case "SET_SHOW_CONTEXT_USAGE":
      return s ? { ...state, launcher: { ...s, showContextUsage: action.show } } : state;
    case "SET_SHOW_VOICE_BUTTON":
      return s ? { ...state, launcher: { ...s, showVoiceButton: action.show } } : state;
    case "SET_RIGHT_CTRL_VOICE":
      return s ? { ...state, launcher: { ...s, rightCtrlVoice: action.enabled } } : state;
    case "SET_VOICE_PREVIEW_ONLY":
      return s ? { ...state, launcher: { ...s, voicePreviewOnly: action.enabled } } : state;
    case "SET_VOICE_FIRST":
      return s ? { ...state, launcher: { ...s, voiceFirst: action.enabled } } : state;
    case "SET_VOICE_FIRST_WINDOW_MINUTES":
      // 只接受非负整数（0 = 不消失）：面板里是固定选项，这里防的是手改状态文件。
      return s ? { ...state, launcher: { ...s, voiceFirstWindowMinutes: Math.max(0, Math.round(action.minutes)) } } : state;
    case "SET_NOTIFICATION_SOUND":
      return s ? { ...state, launcher: { ...s, notificationSound: action.sound } } : state;
    case "SET_DRAGON_FIRE_SOUND":
      return s ? { ...state, launcher: { ...s, dragonFireSound: action.enabled } } : state;
    case "SET_DRAGON_VISIBLE":
      return s ? { ...state, launcher: { ...s, dragonVisible: action.visible } } : state;
    case "SET_AUTO_HIDE_DOCK":
      return s ? { ...state, launcher: { ...s, autoHideDock: action.enabled } } : state;
    case "SET_DOCK_DOMAIN_ENTRY":
      // 关掉入口时顺手收掉拖动态：拖出 Dock 那一刻幽灵图标不能留在屏幕上。
      return s ? { ...state, launcher: { ...s, dockDomainEntry: action.enabled }, draggingDomain: null } : state;
    case "SET_KEEP_AWAKE_ON_TASK":
      // 只是记下用户偏好；「现在要不要真的保持唤醒」由 App 里那个 effect 按
      // 「开关 && 有任务在跑」推给主进程。
      return s ? { ...state, launcher: { ...s, keepAwakeOnTask: action.enabled } } : state;
    case "SET_COMPUTE_PROVIDER_ENABLED": {
      if (!s) return state;
      const current = enabledComputeProviders(s);
      const next = action.enabled
        ? (current.includes(action.provider) ? current : [...current, action.provider])
        : current.filter((id) => id !== action.provider);
      // 至少留一个：全禁用等于聊天没有可用框架，面板里最后一个开关也是 disabled。
      if (next.length === 0) return state;
      // 顺序固定按 COMPUTE_PROVIDER_IDS，避免「关掉再打开」后顺序漂移。
      return { ...state, launcher: { ...s, enabledComputeProviders: COMPUTE_PROVIDER_IDS.filter((id) => next.includes(id)) } };
    }
    case "OPEN_NOTIFICATION_SESSION": {
      if (action.windowId === "contacts") {
        if (!s) return state;
        return {
          ...state, view: "desktop",
          launcher: { ...s, activeDomainId: "contacts" },
          ...windowPatch(raiseWindow(state, "contacts"), state.runningSessionsByWindow),
          launchedDomains: state.launchedDomains.includes("contacts") ? state.launchedDomains : [...state.launchedDomains, "contacts"],
          minimizedWindows: state.minimizedWindows.filter(id => id !== "contacts"),
        };
      }
      const sessionRequests = { ...state.sessionRequests, [action.windowId]: { sessionId: action.sessionId, nonce: action.nonce } };
      // 点击通知：先让对应窗口真正可见（取消最小化 / 重新打开），再交给它切会话。
      if (action.windowId === "workspace") {
        // 与 SET_VIEW 一致：进工作区时收起桌面浮层，避免同一页面挂两套 AgentWindow。
        return { ...state, view: "workspace", ...windowPatch([], state.runningSessionsByWindow), launchedDomains: [], sessionRequests };
      }
      if (isHomeChatWindow(action.windowId)) {
        // 任意 home chat 窗口（主窗口或「新建窗口」实例）：恢复可见后交给它切会话。
        return {
          ...state,
          view: "desktop",
          ...windowPatch(raiseWindow(state, action.windowId), state.runningSessionsByWindow),
          minimizedWindows: state.minimizedWindows.filter((id) => id !== action.windowId),
          sessionRequests,
        };
      }
      if (!s || !s.domains.some((domain) => domain.id === action.windowId)) return state;
      return {
        ...state,
        view: "desktop",
        launcher: { ...s, activeDomainId: action.windowId },
        ...windowPatch(raiseWindow(state, action.windowId), state.runningSessionsByWindow),
        launchedDomains: state.launchedDomains.includes(action.windowId) ? state.launchedDomains : [...state.launchedDomains, action.windowId],
        minimizedWindows: state.minimizedWindows.filter((id) => id !== action.windowId),
        sessionRequests,
      };
    }
    case "CLEAR_SESSION_REQUEST": {
      const current = state.sessionRequests[action.windowId];
      // 只清对应 nonce：用户连点多条通知时，旧通知的回调不能把新请求抹掉。
      if (!current || current.nonce !== action.nonce) return state;
      const sessionRequests = { ...state.sessionRequests };
      delete sessionRequests[action.windowId];
      return { ...state, sessionRequests };
    }
    case "QUEUE_MENTION_REQUEST": {
      const mentionRequests = { ...state.mentionRequests, [action.windowId]: { person: action.person, nonce: Date.now() } };
      return { ...state, mentionRequests };
    }
    case "CLEAR_MENTION_REQUEST": {
      const current = state.mentionRequests[action.windowId];
      if (!current || current.nonce !== action.nonce) return state;
      const mentionRequests = { ...state.mentionRequests };
      delete mentionRequests[action.windowId];
      return { ...state, mentionRequests };
    }
    case "SET_FILE_ATTACH_HINT":
      return { ...state, fileAttachHint: action.hint };
    case "QUEUE_ATTACH_REQUEST": {
      const list = state.attachRequests[action.windowId] ?? [];
      const attachRequests = {
        ...state.attachRequests,
        [action.windowId]: [...list, { nonce: nextAttachNonce(), sessionId: action.sessionId, attachments: action.attachments }],
      };
      return { ...state, attachRequests };
    }
    case "CLEAR_ATTACH_REQUEST": {
      const list = state.attachRequests[action.windowId];
      if (!list?.length) return state;
      // 只清对应 nonce：同一窗口可能连着排了好几条，清错会把别的请求搞丢。
      const rest = list.filter((item) => item.nonce !== action.nonce);
      const attachRequests = { ...state.attachRequests };
      if (rest.length) attachRequests[action.windowId] = rest;
      else delete attachRequests[action.windowId];
      return { ...state, attachRequests };
    }
    case "QUEUE_SEND_REQUEST": {
      const list = state.sendRequests[action.windowId] ?? [];
      return {
        ...state,
        sendRequests: {
          ...state.sendRequests,
          [action.windowId]: [...list, { nonce: nextSendNonce(), text: action.text, sessionId: action.sessionId }],
        },
      };
    }
    case "CLEAR_SEND_REQUEST": {
      const list = state.sendRequests[action.windowId];
      if (!list?.length) return state;
      const rest = list.filter((item) => item.nonce !== action.nonce);
      const sendRequests = { ...state.sendRequests };
      if (rest.length) sendRequests[action.windowId] = rest;
      else delete sendRequests[action.windowId];
      return { ...state, sendRequests };
    }
    case "SET_SELECTED_MODEL":
      return s ? { ...state, launcher: { ...s, selectedModel: action.model } } : state;
    case "SET_SKIN": {
      if (!s) return state;
      return {
        ...state,
        launcher: { ...s, domains: s.domains.map((d) => (d.id === action.domainId ? { ...d, skinColor: action.skinColor } : d)) },
      };
    }
    default:
      return state;
  }
}

interface Ctx {
  state: UiState;
  dispatch: (a: Action) => void;
}

/**
 * 跨上报方去重后的「运行中会话数」——Dock 上 Home 图标底部的数字角标。
 *
 * 为什么不是各窗口相加：同一轮任务可能被两个实例同时上报。
 * 典型场景是桌面上拖文件到会话卡片：这一轮跑在隐藏实例（DesktopSendRunner）里，
 * 打开 home chat 后 kit 会让聊天窗接管同一条 run，于是两个实例都说「这个 sid 在跑」。
 * 相加会把一轮任务算成两个。
 *
 * 导出是为了让验收脚本能直接跑这段逻辑（Dock 与测试共用同一份公式）。
 */
export function runningSessionCount(byWindow: Record<string, readonly string[]>): number {
  const all = new Set<string>();
  for (const list of Object.values(byWindow)) for (const sid of list) all.add(sid);
  return all.size;
}

const LauncherCtx = createContext<Ctx | null>(null);
/** 失败时 resolve 成 null（而不是 reject），调用方据此显示「模型列表加载失败」。 */
let launcherModelsPromise: Promise<Array<Exclude<ModelOption, string>> | null> | null = null;
/**
 * 通知点击的 nonce：单调递增。
 * 主进程只负责唤回原生窗口，虚拟窗口与目标会话由渲染层按 windowId 定向路由；
 * nonce 保证连点同一会话的两次通知也能各触发一次跳转（值相同不会重复触发）。
 */
let notificationNonce = 0;
function nextNotificationNonce(): number {
  notificationNonce = Math.max(notificationNonce + 1, Date.now());
  return notificationNonce;
}

/**
 * 「附件进输入框」请求的 nonce：单调递增。
 * kit 侧用 nonce 判断「这是不是一次新请求」（值相同不重复处理），
 * 宿主回调用它精确清掉已消费的那一条。
 */
let attachNonce = 0;
function nextAttachNonce(): number {
  attachNonce = Math.max(attachNonce + 1, Date.now());
  return attachNonce;
}

/**
 * 「直接发一轮消息」请求的 nonce：单调递增。
 * kit 侧用 nonce 判断「这是不是一次新请求」，宿主回调再用它精确清掉已消费的那一条。
 */
let sendNonce = 0;
function nextSendNonce(): number {
  sendNonce = Math.max(sendNonce + 1, Date.now());
  return sendNonce;
}

function loadLauncherModels(): Promise<Array<Exclude<ModelOption, string>> | null> {
  launcherModelsPromise ??= window.launcher.listModels()
    .then((list) => (list as ModelOption[])
      .map((model) => typeof model === "string" ? { id: model } : model)
      .filter((model) => model.id.trim().length > 0))
    .catch((error) => {
      console.error("[launcher] 加载模型列表失败：", error);
      return null;
    });
  return launcherModelsPromise;
}

/**
 * 重新拉一次模型列表（丢掉缓存的 Promise）。
 * 登录 / 退出 WorkBuddy 后可用模型范围会变（未登录只有 models.json 的自定义模型），
 * 设置面板据此把新列表 dispatch 回 state，聊天窗不用重启。
 */
export function reloadLauncherModels() {
  launcherModelsPromise = null;
  return loadLauncherModels();
}

export function useLauncher(): Ctx {
  const ctx = useContext(LauncherCtx);
  if (!ctx) throw new Error("useLauncher 必须在 LauncherProvider 内使用");
  return ctx;
}

export function LauncherProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, {
    launcher: null,
    models: [],
    modelsLoading: true,
    modelsLoadFailed: false,
    view: "desktop",
    quickInput: false,
    focusMode: false,
    agentHost: null,
    webAuth: null,
    webUser: null,
    webUserResolved: false,
    draggingDomain: null,
    openWindows: [],
    minimizedWindows: [],
    launchedDomains: [],
    focusDockItemId: null,
    runningSessionsByWindow: {},
    sessionCardsByWindow: {},
    desktopCatalog: [],
    voiceRecordingWindow: null,
    voiceTranscribingWindow: null,
    voiceError: null,
    voiceFirstMinimal: [],
    sessionRequests: {},
    mentionRequests: {},
    attachRequests: {},
    sendRequests: {},
    fileAttachHint: null,
    domainPickerOpen: false,
    settingsWindowOpen: false,
    aboutWindowOpen: false,
  });
  const [ready, setReady] = useState(false);
  const launcherReady = Boolean(state.launcher);

  useEffect(() => {
    let alive = true;
    void loadLauncherModels().then((models) => { if (alive) dispatch(models === null ? { type: "SET_MODELS_FAILED" } : { type: "SET_MODELS", models }); });
    void window.launcher.getAgentHost().then(({ url }) => { if (alive) dispatch({ type: "SET_AGENT_HOST", url }); })
      .catch((err) => console.error("[launcher] 加载本地 Agent 服务失败：", err));
    void window.launcher.getWebAuth().then((result) => { if (alive) dispatch({ type: "SET_WEB_AUTH", url: result?.url ?? null }); })
      .catch((err) => console.error("[launcher] 加载 Web 服务地址失败：", err));
    /* 登录身份：本机会话按 owner 分目录，隐藏实例必须拿到同一个身份才读得到会话。 */
    const refreshUser = () => {
      void window.launcher.getWebSession()
        .then((user) => {
          if (!alive) return;
          dispatch({ type: "SET_WEB_USER", user: user ? { name: user.name, avatar: user.avatar, provider: user.provider, unionId: user.unionId } : null });
        })
        .catch((err) => {
          console.error("[launcher] 加载登录身份失败：", err);
          if (alive) dispatch({ type: "SET_WEB_USER", user: null });
        });
    };
    refreshUser();
    const offSession = window.launcher.onWebSessionChanged(refreshUser);
    /* models.json 被改动（如新拉了一个 ollama 模型）：主进程轮询到签名变化后通知，
       这里丢掉缓存的 Promise 重新拉一次，输入框的模型下拉即刻生效，不用重启。 */
    const offModels = window.launcher.onModelsFileChanged(() => {
      console.log("[launcher] 检测到 models.json 更新，刷新模型列表");
      void reloadLauncherModels().then((models) => {
        if (alive && models !== null) dispatch({ type: "SET_MODELS", models });
      });
    });
    return () => { alive = false; offSession(); offModels(); };
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void window.launcher.listDesktopSessions()
        .then((sessions) => { if (alive) dispatch({ type: "SET_DESKTOP_CATALOG", sessions }); })
        .catch((error) => console.error("[launcher] 加载桌面会话目录失败：", error));
    };
    const unsubscribe = window.launcher.onDesktopSessionsChanged(refresh);
    const unsubscribeSession = window.launcher.onWebSessionChanged(refresh);
    refresh();
    return () => { alive = false; unsubscribe(); unsubscribeSession(); };
  }, []);

  useEffect(() => {
    // 等设置状态加载完再订阅：冷启动直接点通知时，数域校验需要 launcher.domains，
    // 提前派发会被 reducer 当成「数域已删除」丢掉。preload 会缓存订阅前到达的点击。
    if (!launcherReady) return;
    return window.launcher.onNotificationOpen(({ windowId, sessionId }) => {
      dispatch({ type: "OPEN_NOTIFICATION_SESSION", windowId, sessionId, nonce: nextNotificationNonce() });
    });
  }, [launcherReady]);

  useEffect(() => {
    function onPresetShortcut(event: KeyboardEvent) {
      if (event.repeat || event.altKey || event.shiftKey) return;
      // macOS 用 Cmd+数字，Windows 用 Ctrl+数字：
      // 1 浅色 / 2 深色 / 3-5 静态壁纸 / 6-8 动态壁纸。
      const isMac = navigator.userAgent.includes("Mac");
      if (isMac ? (!event.metaKey || event.ctrlKey) : (!event.ctrlKey || event.metaKey)) return;
      const index = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8"].indexOf(event.code);
      if (index < 0 && event.code !== "Digit0") return;
      event.preventDefault();
      event.stopPropagation();
      // Ctrl+0 沿用旧行为：回到浅色（与 Ctrl+1 一致）。
      if (event.code === "Digit0" || index === 0) dispatch({ type: "SET_APPEARANCE", appearance: "light" });
      else if (index === 1) dispatch({ type: "SET_APPEARANCE", appearance: "dark" });
      else dispatch({ type: "SET_WALLPAPER", wallpaper: { kind: "builtin", value: WALLPAPER_SKINS[index - 2].url } });
    }
    window.addEventListener("keydown", onPresetShortcut, true);
    return () => window.removeEventListener("keydown", onPresetShortcut, true);
  }, []);

  useEffect(() => {
    const launcher = state.launcher;
    if (!launcher) return;
    const appearance = launcher.appearance ?? "light";
    // 静态 / 动态是壁纸模式：外观映射回 "custom"（复用其窗口控件配色），皮肤由所选壁纸决定；
    // 浅色 / 深色则直接是主题本身。旧持久化的 "custom" 也按壁纸模式兜底。
    const rawAppearance = appearance as string;
    const wallpaperMode = rawAppearance === "static" || rawAppearance === "dynamic" || rawAppearance === "custom";
    const theme = wallpaperMode
      ? (launcher.wallpaper.kind === "builtin" && launcher.wallpaper.value === WALLPAPER_SKINS[1].url ? "light" : "dark")
      : appearance;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.appearance = wallpaperMode ? "custom" : appearance;
    document.documentElement.dataset.skin = wallpaperMode ? wallpaperSkinId(launcher.wallpaper) : appearance;
  }, [state.launcher?.appearance, state.launcher?.wallpaper]);

  useEffect(() => {
    let alive = true;
    window.launcher
      .getState()
      .then((st) => {
        if (alive) {
          dispatch({ type: "STATE_LOADED", state: st });
          setReady(true);
        }
      })
      .catch((err) => {
        console.error("[launcher] 加载状态失败：", err);
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // 持久化：launcher 数据变化后 500ms 防抖整体保存
  const saveTimer = useRef<number | null>(null);
  const serialized = state.launcher ? JSON.stringify(state.launcher) : "";
  useEffect(() => {
    if (!state.launcher || !ready) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void window.launcher.saveState(state.launcher as LauncherState).catch((err) => {
        console.error("[launcher] 保存状态失败：", err);
      });
    }, 500);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, ready]);

  return <LauncherCtx.Provider value={{ state, dispatch }}>{children}</LauncherCtx.Provider>;
}
