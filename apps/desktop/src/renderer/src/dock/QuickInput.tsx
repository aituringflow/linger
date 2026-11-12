import { useEffect, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type MouseEvent } from "react";
import { CHAT_MIN_WIDTH, summarizeForNotify } from "@turingflow/agent-kit/ui";
import { useLauncher, isHomeChatWindow } from "../state";
import { isArtifactFileDrag, readDraggedFiles, toLocalAttachments } from "../fileDrop";
import { wallpaperSkinId } from "../wallpapers";
import { LauncherApp } from "../LauncherApp";
import { localAgentUrl } from "../localAgentUrl";
import FocusWindowFrame from "./FocusWindowFrame";
import { clearSavedWindowGeometry } from "./WindowFrame";
import DynamicComposer from "./DynamicComposer";
import DragonPet from "./DragonPet";
import { voiceAmplitudeRefFor } from "./voiceLevel";
import { playLauncherNotificationSound } from "./notificationSound";

/** home chat 窗口的排序键：主窗口在前，primary-<n> 按序号升序。 */
const homeWindowOrder = (id: string): number => (id === "primary" ? 0 : Number(/^primary-(\d+)$/.exec(id)?.[1] ?? 0));

/**
 * 一个 launcher 窗口（= 操作系统里的一个应用窗口），由 kit AgentWindow 承担内容：
 *  - windowId="primary"：Home 主窗口。hover 预览态只显示输入区，点击/发消息后展开为完整三栏。
 *  - windowId=<数域 id>：数域窗口（钉钉 / 飞书）。每个数域一个独立 frame，输入卡片用数域色描边。
 * 会话、消息、草稿、产物均在 kit（本地 Agent 服务 + localChat 桥）内管理。
 */
export default function QuickInput({ onTextPresenceChange, onContentPresenceChange, onMouseLeave, windowId, layer, preview, minimized = false, keepSidebarOpenWhenUnread = false, focused = false }: {
  onTextPresenceChange: (has: boolean) => void;
  /** 输入框「有内容」（文字**或**附件）。宿主据此决定预览浮层该不该自动收起。 */
  onContentPresenceChange?: (has: boolean) => void;
  onMouseLeave: (event: MouseEvent<HTMLDivElement>) => void;
  windowId: string;
  layer?: number;
  preview?: boolean;
  /** 最小化（隐藏但会话继续后台跑）：由 Dock 根据 state.minimizedWindows 传入。 */
  minimized?: boolean;
  /** 有未读消息时，打开聊天窗默认展开左侧会话列表面板。 */
  keepSidebarOpenWhenUnread?: boolean;
  /** 是否为当前聚焦（最上层）窗口：多窗口时给更亮的边框。 */
  focused?: boolean;
}) {
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const skinId = wallpaperSkinId(launcher.wallpaper);
  const agentHost = state.agentHost;
  /* 登录身份取全局 state：桌面那些隐藏实例（拖文件发消息 / 刷新卡片）用的是同一份。
   * 身份不一致 → 本机会话目录对不上 → kit 报「会话不存在或不支持发送」。 */
  const cloud = state.webUser && state.webAuth ? { base: state.webAuth.url, user: state.webUser } : null;
  /* 已登录但 Web 服务地址还没到时不能急着以访客身份挂载（会话列表会读错目录）。 */
  const cloudResolved = state.webUserResolved && (!state.webUser || Boolean(state.webAuth));
  // Initial identity discovery must not remount the composer and erase early typing.
  // Later account switches still remount it to keep account sessions isolated.
  const identityRef = useRef<{ resolved: string | null; key: string }>({ resolved: null, key: "initial" });
  if (cloudResolved) {
    const identity = cloud ? `${cloud.user.provider}:${cloud.user.unionId}` : "local:guest";
    if (identityRef.current.resolved !== null && identityRef.current.resolved !== identity) identityRef.current.key = identity;
    identityRef.current.resolved = identity;
  }
  const localHostUrl = agentHost?.url ?? "http://127.0.0.1:1";
  const [homeContacts, setHomeContacts] = useState<Array<{ id: string; name: string; avatar?: string }>>([]);
  useEffect(() => {
    /* kit 的 apiFetch 靠这个全局变量把 <base>/api/* 请求转给主进程走登录态。 */
    (globalThis as typeof globalThis & { __agentKitCloudBase?: string }).__agentKitCloudBase = cloud ? cloud.base : undefined;
  }, [cloud]);
  useEffect(() => {
    if (!cloud || cloud.user.provider !== "builtin") { setHomeContacts([]); return; }
    let active = true;
    const refresh = () => { void window.launcher.contactsApi("GET", "").then(result => {
      if (active) setHomeContacts(result.ok && Array.isArray(result.data?.friends) ? result.data.friends : []);
    }); };
    refresh();
    window.addEventListener("launcher:contacts-event", refresh);
    return () => { active = false; window.removeEventListener("launcher:contacts-event", refresh); };
  }, [cloud?.user.unionId, cloud?.user.provider]);
  const domain = windowId === "primary" ? null : launcher.domains.find((item) => item.id === windowId) ?? null;
  // 数域窗口用数域色把输入卡片描一圈（钉钉蓝 / 飞书紫），Home 窗口沿用主题 --line。
  // composerBorder 由 LauncherStore 的 domains 配置提供，便于以后加数域时只改配置。
  const domainBorder = domain?.composerBorder
    ?? (domain?.composerBorderColor ? `1px solid ${domain.composerBorderColor}` : undefined);
  /**
   * 附加 home chat 窗口（primary-<n>）的级联序号：主窗口恒为 0。
   * 只看**当前已打开的 home 窗口**排出来的次序，不看 z-order（layer）——
   * layer 会随置顶/重排变来变去，拿它算偏移窗口会横向乱跳一格；
   * 而场上只剩一个 home 窗口时序号就是 0，窗口水平居中（不再莫名往右偏）。
   */
  const homeCascadeStep = windowId === "primary"
    ? 0
    : Math.max(0, state.openWindows.filter(isHomeChatWindow).sort((a, b) => homeWindowOrder(a) - homeWindowOrder(b)).indexOf(windowId));
  /**
   * 全屏时 kit 必须切到 fixed 布局：grow 模式下侧栏是"窗口向外生长"（--grow-left + clip 左扩），
   * 全屏后窗口已经贴满屏幕，再往外长会把面板推到屏幕外。fixed 下侧栏在窗口内部挤压中栏，
   * 这才是操作系统全屏窗口该有的行为。
   */
  const [maximized, setMaximized] = useState(false);
  /**
   * 右栏相关的两个量必须分开，这是"展开时中栏不动、拖动时只改相对大小"的关键：
   *  · rightWidth —— 右栏的真实宽度（跟踪值）。拖分隔线、拖窗口右边框都会更新它。
   *  · windowInc  —— 窗口相对基准宽的增量，**只在右栏展开的那一刻锁定**（并受屏幕右沿约束）。
   * chat 宽 = 基准宽 + windowInc − rightWidth：
   *   展开 → windowInc 刚等于 rightWidth，chat 正好等于基准宽（不动）；
   *   展开但窗口已贴近屏幕右边 → windowInc 只到屏幕右沿，差的那部分反向挤压 chat；
   *   拖分隔线 → rightWidth 变、windowInc 不变，chat 跟着变（这就是"调整两者相对大小"）；
   *   收起 → windowInc 归 0，chat 回到基准宽；
   *   拖窗口右边框 → 两个值同步加减，chat 始终不动。
   */
  const [rightWidth, setRightWidth] = useState(340);
  const [windowInc, setWindowInc] = useState(0);
  const [rightOpen, setRightOpen] = useState(false);
  /**
   * 右栏是否展开。**不能**用 `windowInc === 0` 判断 —— 窗口右侧没有空间时增量会被压到 0，
   * 那时右栏明明是展开的，再拿 0 当"收起"会让后续每次宽度上报都重新锁定一次增量，窗口乱跳。
   */
  const rightOpenRef = useRef(false);
  /** 窗口基准几何（右栏收起时的外框），由 FocusWindowFrame 上报；用于算"右边还剩多少屏幕空间"。 */
  const geometryRef = useRef<{ left: number; right: number; baseWidth: number; viewport: number } | null>(null);
  const rightWidthRef = useRef(rightWidth);
  rightWidthRef.current = rightWidth;

  /**
   * 展开右栏时窗口能向右长多少。
   * 理想值是右栏完整宽度（中栏不动），但窗口右缘不能越过屏幕右沿：
   *  · 空间够 → 增量 = 右栏宽（正常 grow）；
   *  · 空间不够 → 增量只到屏幕右沿，剩下的宽度反向从**中栏**里拿（中栏变窄）；
   *  · 中栏已到最小宽度(CHAT_MIN_WIDTH) 还放不下 → 不再挤压中栏，宁可让窗口超出屏幕右边，
   *    保证中栏和右栏都还有最小可用空间。
   * 全屏时窗口恒为 100vw、与增量无关，右栏自然是挤压中栏，直接返回目标值。
   */
  function resolveWindowInc(target: number) {
    if (maximized) return target;
    const geo = geometryRef.current;
    if (!geo) return target;
    const room = geo.viewport - geo.right;                            // 右边缘到屏幕右沿的剩余空间（可能为负）
    const keepChat = Math.max(0, CHAT_MIN_WIDTH + target - geo.baseWidth); // 中栏保底所需的最小增量
    return Math.min(target, Math.max(room, keepChat));
  }

  function handleRightPanelWidth(width: number | null) {
    if (width == null) {
      // 收起右栏：窗口缩回基准宽，但记住右栏宽度，下次展开还用它
      rightOpenRef.current = false;
      setRightOpen(false);
      setWindowInc(0);
      return;
    }
    setRightWidth(width);
    // 只在"从收起变为展开"的那一刻锁定窗口增量；拖分隔线/窗口边框连续上报时保持不动
    if (!rightOpenRef.current) {
      rightOpenRef.current = true;
      setRightOpen(true);
      setWindowInc(resolveWindowInc(width));
    }
  }

  // 实例卸载（关窗/退出聚焦）时把本窗口的运行中会话清空：AgentWindow 没了，流也就断了，
  // 否则 Dock 上的数字角标会一直挂着旧计数。
  useEffect(() => () => { dispatch({ type: "SET_RUNNING_SESSIONS", windowId, sessions: [] }); }, [dispatch, windowId]);
  // 窗口卸载时同时清掉本窗口的桌面会话快照：会话流已断，桌面「进行中」卡片不该残留。
  useEffect(() => () => { dispatch({ type: "SET_SESSION_CARDS", windowId, cards: [] }); }, [dispatch, windowId]);

  /**
   * 语音录音态 → Dock 的 Home 声波。
   *  · 「是否在录音」是低频状态：走 reducer，让 Dock 切 UI（淡入/淡出声波层）。
   *  · 「实时音量」是 60fps 的量：写进 voiceLevel 的 ref，Home 声波在自己的 rAF 里读，
   *    不经过 React —— 否则每帧都要重渲染整棵 launcher。
   */
  const amplitudeRef = useRef(voiceAmplitudeRefFor(windowId));
  // 防线：Dock 全局按住 Option 时，Dock 自己 dispatch 了 SET_VOICE_RECORDING；
  // QuickInput 浮出后挂载 AgentWindow，它的语音 effect 可能因为初始化/re-render 误报一次
  // false。如果照单全收 CLEAR，就会把 Dock 设的 voiceWindow 清掉，Home 声波和光环全灭——
  // 而用户还按着 Option 在说话。只有 kit 自己点麦克风按钮（先报过 true）后的 false 才是真停止。
  const kitVoiceOnRef = useRef(false);
  const kitTranscribingOnRef = useRef(false);
  useEffect(() => () => {
    // 窗口卸载时清零，避免 Dock 读到一个卡住不动的旧音量。
    amplitudeRef.current.current = 0;
    if (kitVoiceOnRef.current) dispatch({ type: "CLEAR_VOICE_RECORDING", windowId });
    if (kitTranscribingOnRef.current) dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId });
  }, [dispatch, windowId]);

  // 退出全屏时窗口从 100vw 回到 base + 增量：若原来贴满屏幕，缩回来的窗口可能仍越过屏幕右沿
  // （全屏那会儿右栏是靠挤压中栏显示的，增量没受屏幕约束）。这里按当前几何重算一次，
  // 让还原后的浮动窗口落在屏幕内。进入全屏时窗口由 100vw 接管，无需处理。
  useEffect(() => {
    if (maximized || !rightOpenRef.current) return;
    setWindowInc(resolveWindowInc(rightWidthRef.current));
    // 只在 maximized 变化时重算；rightWidth 用 ref 读最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maximized]);

  useEffect(() => {
    if (!preview) return;
    const focusWhenReady = () => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".quick-input.window-preview .chat-input-zone textarea");
      if (!textarea || textarea.disabled) return false;
      textarea.focus({ preventScroll: true });
      return document.activeElement === textarea;
    };
    const observer = new MutationObserver(() => { if (focusWhenReady()) observer.disconnect(); });
    if (!focusWhenReady()) observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    return () => observer.disconnect();
  }, [preview, agentHost]);

  // 从 hover 预览展开（点击 Home / 发送消息自动展开）时，焦点会被按钮或点击抢走；这里统一还给输入框。
  const wasPreviewRef = useRef(preview);
  useEffect(() => {
    const wasPreview = wasPreviewRef.current;
    wasPreviewRef.current = preview;
    if (!wasPreview || preview) return;
    const textarea = document.querySelector<HTMLTextAreaElement>(`[data-window-id="${windowId}"] .chat-input-zone textarea`);
    if (textarea && !textarea.disabled) textarea.focus({ preventScroll: true });
  }, [preview, windowId]);

  /**
   * 预览态里点输入区内的按钮（加号 / 项目 / 模型 / 权限 / 发送…）不再展开完整窗口
   * （见 FocusWindowFrame 的 pointerdown 判定），因此也不会再经过上面那条"展开即回填焦点"的路径。
   * 这里补回来：点完按钮、没有菜单/对话框需要键盘操作时，把焦点还给输入框 ——
   * 预览态的意义就是"随手问一句"，选完项目/传完附件应该能接着打字。
   */
  useEffect(() => {
    if (!preview) return;
    const onClick = (event: Event) => {
      const target = event.target as HTMLElement | null;
      // 点的是输入框本身：由浏览器原生聚焦处理，不用管
      if (!target || target.closest("textarea") || !target.closest(".chat-input-zone")) return;
      // 等这次 click 的处理跑完再判断（它可能刚打开一个菜单 / 权限对话框）
      window.setTimeout(() => {
        const frame = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
        const textarea = frame?.querySelector<HTMLTextAreaElement>(".chat-input-zone textarea");
        if (!frame || !textarea || textarea.disabled) return;
        // 菜单 / 列表 / 对话框开着时不抢焦点：Esc 关闭、方向键选项都要留在弹层上
        if (frame.querySelector(".chat-input-zone [role='menu'], .chat-input-zone [role='listbox'], .chat-input-zone [role='dialog'], .chat-input-zone .chat-modal-backdrop, .chat-input-zone .chat-model-picker-popup")) return;
        textarea.focus({ preventScroll: true });
      }, 0);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [preview, windowId]);

  /**
   * 把文件管理组件里的文件拖到这个聊天窗 → 文件作为**待发附件**进本窗口的输入框。
   *
   * 与「拖到会话卡片 = 直接在那个会话末尾发一条只含附件的消息」不同：这里不发送，
   * 用户可以接着打字再发。附件最终由 kit 挂进 composer（attachRequest 协议），
   * 所以「拖到卡片停留 2 秒后松手」与「拖到 home 按钮」复用的是同一条内核。
   */
  const [fileDropActive, setFileDropActive] = useState(false);
  function onArtifactDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!isArtifactFileDrag(event.dataTransfer)) return;
    // 不 preventDefault 浏览器就不允许在这里落。
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setFileDropActive(true);
  }
  function onArtifactDragLeave() {
    setFileDropActive(false);
  }
  function onArtifactDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!isArtifactFileDrag(event.dataTransfer)) return;
    // drop 事件一返回，dataTransfer 就被清空：载荷必须当场读出来。
    const files = readDraggedFiles(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    setFileDropActive(false);
    void (async () => {
      try {
        const attachments = await toLocalAttachments(files);
        if (!attachments.length) return;
        dispatch({ type: "QUEUE_ATTACH_REQUEST", windowId, attachments });
      } catch (error) {
        console.error("[launcher] 拖拽文件进聊天窗失败：", error);
      }
    })();
  }

  return (
    <>
    <FocusWindowFrame
      windowId={windowId}
      /* 级联偏移**只给附加窗口**（primary-<n>），主窗口永远居中、底边贴 Dock 之上。
         踩过的坑：
         1. 主窗口一旦最小化（ChatGPT 式"关闭=隐藏"，仍留在 openWindows 里），
            hover Home 时 Dock 传下来的 layer = 101 + openWindows.length = 102，
            于是 initialOffset 变成 (26, 22) —— 窗口每次都往右偏 26px、往下沉 22px，
            下沉后底边正好压进 Dock 区域，输入卡被 home 图标挡住。
            所以偏移只按窗口自己的序号算（homeCascadeStep），跟 z-order 彻底解耦。
         2. y 方向不再级联：这些窗口都是"贴满 Dock 以上"的全高窗，往下挪必然顶到 Dock，
            只用 x 方向错开就够区分了。 */
      initialOffset={windowId === "primary"
        ? { x: 0, y: 0 }
        : { x: homeCascadeStep * 26, y: 0 }}
      skinId={skinId}
      preview={preview}
      onMouseLeave={onMouseLeave}
      onArtifactDragOver={onArtifactDragOver}
      onArtifactDrop={onArtifactDrop}
      onArtifactDragLeave={onArtifactDragLeave}
      artifactDropActive={fileDropActive}
      onMaximizeChange={setMaximized}
      onGeometryChange={(geometry) => { geometryRef.current = geometry; }}
      rightPanelWidth={rightOpen ? rightWidth : 0}
      windowExtra={rightOpen ? windowInc : 0}
      onRightPanelResize={(width, windowInc) => {
        // 右栏展开时拖窗口右边框：中栏宽度保持不变，多出来/少掉的全给右栏
        setRightWidth(width);
        setWindowInc(windowInc);
      }}
      style={{ zIndex: layer, "--launcher-right-width": `${windowInc}px`, ...(domainBorder ? { "--domain-border": domainBorder } : null) } as CSSProperties}
      onFocus={() => {
        // 预览态被点击 = 把这个 Home 会话真正打开；已打开的窗口则只是置顶。
        if (preview) dispatch({ type: "OPEN_FOCUS_CHAT" });
        else dispatch({ type: "FOCUS_CHAT_WINDOW", windowId });
      }}
      // 关闭 = 真正关闭窗口（卸载组件），下次打开时重置位置和大小为初始值。
      // 区别于最小化：最小化只是隐藏，下次打开保持上次的位置/大小/会话。
      onClose={() => { clearSavedWindowGeometry(windowId); dispatch({ type: "CLOSE_CHAT", windowId }); }}
      onMinimize={() => dispatch({ type: "MINIMIZE_CHAT", windowId })}
      focused={focused}
      minimized={minimized}
      voiceFirstMinimal={state.voiceFirstMinimal.includes(windowId)}
      voiceFirstSurface={state.voiceFirstMinimal.includes(windowId) || Boolean(preview && launcher.voiceFirst && (state.voiceRecordingWindow === windowId || state.voiceTranscribingWindow === windowId))}
    >
      {/* 动态壁纸（熔火龙境）的燃烧特效：主窗口与「新建窗口」实例都叠火焰输入卡；          数域窗口不叠（数域有自己的主题色描边）。 */}
      <DynamicComposer skin={isHomeChatWindow(windowId) ? skinId === "wp4" ? "fire" : skinId === "wp5" ? "water" : skinId === "wp6" ? "gold" : null : null}
        fireParams={launcher.fireParams} goldParams={launcher.goldParams} waterParams={launcher.waterParams} windowId={windowId} />
      <DragonPet active={isHomeChatWindow(windowId) && skinId === "wp4" && (launcher.dragonVisible ?? true)} preview={preview} minimized={minimized} windowId={windowId}
        fireSound={launcher.dragonFireSound ?? false}
        onHideDragon={() => dispatch({ type: "SET_DRAGON_VISIBLE", visible: false })} />
        <LauncherApp
          key={isHomeChatWindow(windowId) ? identityRef.current.key : "local:guest"}
          authMode="local-guest"
          basePath={isHomeChatWindow(windowId) ? cloud?.base || "/" : "/"}
          cloudEnabled={isHomeChatWindow(windowId) && Boolean(cloud)}
          localGuestUser={isHomeChatWindow(windowId) ? cloudResolved ? cloud?.user : { name: "", provider: "", unionId: "" } : undefined}
          agentModesPending={!agentHost || (isHomeChatWindow(windowId) && !cloudResolved)}
          homeContacts={isHomeChatWindow(windowId) ? homeContacts : undefined}
          resolveHomeContactSession={async contactId => {
            const result = await window.launcher.contactsApi("GET", `friends/${encodeURIComponent(contactId)}/session`);
            if (!result.ok) throw new Error(result.data?.error || "联系人会话查询失败");
            return typeof result.data?.sessionId === "string" ? result.data.sessionId : null;
          }}
          resolveHomeGroupSession={async contactIds => {
            const result = await window.launcher.contactsApi("GET", `group-session?ids=${encodeURIComponent(contactIds.join(","))}`);
            if (!result.ok) throw new Error(result.data?.error || "群聊查询失败");
            return typeof result.data?.sessionId === "string" ? result.data.sessionId : null;
          }}
          onExistingPersonChatOpened={() => dispatch({ type: "OPEN_FOCUS_CHAT" })}
          mentionRequest={isHomeChatWindow(windowId) ? state.mentionRequests[windowId] : undefined}
          onMentionRequestHandled={(nonce) => dispatch({ type: "CLEAR_MENTION_REQUEST", windowId, nonce })}
          onHomeMessageSubmitted={() => {
            if (preview) dispatch({ type: "OPEN_FOCUS_CHAT" });
            const root = document.querySelector<HTMLElement>(`[data-window-id="${windowId}"]`);
            if (root?.dataset.voiceMode === "realtime") root.dataset.voiceMessageSent = "true";
            root?.removeAttribute("data-voice-sending");
          }}
          onHomeMentionCleared={() => dispatch({ type: "COLLAPSE_FOCUS_CHAT" })}
          keepSidebarOpenWhenUnread={isHomeChatWindow(windowId) && keepSidebarOpenWhenUnread}
          keepSidebarOnNewChat={isHomeChatWindow(windowId)}
          layoutMode={maximized ? "fixed" : "grow"}
          chatEndpoint={localAgentUrl(localHostUrl, "/chat")}
          artifactEndpoint={localAgentUrl(localHostUrl, "/artifact")}
          scenes={null}
          models={state.models}
          modelsLoading={state.modelsLoading}
          modelsLoadFailed={state.modelsLoadFailed}
          // 语音能力不随按钮显示开关变化；本地服务就绪后即可使用。
          // 「输入框显示语音按钮」只控制输入框里那个可见的麦克风按钮（showVoiceButton），
          // 二者在此解耦：按钮可藏，但按住说话永远能转文字。
          // 语音端点必须指向本机 Agent 服务：页面 origin（dev server / file://）上没有 /api/voice。
          voiceEnabled={Boolean(agentHost)}
          voiceTokenEndpoint={localAgentUrl(localHostUrl, "/api/voice/token")}
          voiceTranscribeEndpoint={localAgentUrl(localHostUrl, "/api/voice/transcribe")}
          // 实时转录（腾讯云 wss）：必须走远程 web 拿签名 URL，凭据在 web env；
          // 本机 local-agent 没有登录态，verifySession 会 401。
          // 这里传的是语音优先的总开关：kit 只关心"实时 ASR 开不开"（开了它就把按住说话让给
          // Launcher 的全局接管），自动发送 / 窗口自动消失都由 launcher 自己实现。
          voiceRealtimeTranscription={launcher.voiceFirst ?? false}
          voiceRealtimeSessionEndpoint={cloud ? `${cloud.base}/api/audio/session` : undefined}
          // 录音态 + 实时音量上报给 Dock：Home 圆钮上播声波。
          // 音量走 ref（每帧变），录音态走回调（按下/松开各一次）。
          onVoiceStateChange={(active) => {
            if (active) {
              kitVoiceOnRef.current = true;
              dispatch({ type: "SET_VOICE_RECORDING", windowId });
            } else if (kitVoiceOnRef.current) {
              kitVoiceOnRef.current = false;
              dispatch({ type: "CLEAR_VOICE_RECORDING", windowId });
            }
            // 没报过 true 就收到 false = Dock 全局按住 Option 时 kit 挂载误报，忽略，不清 Dock 设的。
          }}
          // 转写阶段（松手 → ASR 返回）：Home 声波显示"处理中"（线条继续动、旋转加快、
          // 辉光更明显），而不是录音一停动画就退回初始长度、像什么都没录到。
          onVoiceTranscribingChange={(transcribing) => {
            if (transcribing) {
              kitTranscribingOnRef.current = true;
              dispatch({ type: "SET_VOICE_TRANSCRIBING", windowId });
            } else if (kitTranscribingOnRef.current) {
              kitTranscribingOnRef.current = false;
              dispatch({ type: "CLEAR_VOICE_TRANSCRIBING", windowId });
            }
          }}
          voiceAmplitudeRef={amplitudeRef.current}
          // 「输入框显示语音按钮」设置只控制输入框可见麦克风按钮；按住说话始终可用（见 voiceEnabled）。
          showVoiceButton={launcher.showVoiceButton ?? true}
          // 预览模式：麦克风照常录音（音量/波形是真的），但转写通道被换成空实现 ——
          // 松手后不请求转写端点、不落音频、不扣费。验收声波动画时用。
          voicePreviewOnly={launcher.voicePreviewOnly ?? false}
          /**
           * 会话完成通知：交给主进程发原生通知。
           * 只有主进程才能可靠拿到「点击」事件并唤回窗口；渲染层的网页 Notification
           * 既受权限限制，也无法在多个虚拟聊天窗之间定向跳转。
           * 是否接收通知由用户在系统设置里决定，应用侧始终发送。
           */
          onReplyNotification={({ sessionId, title, text, runId }) => {
            const sound = launcher.notificationSound ?? "system";
            playLauncherNotificationSound(sound, `launcher-${windowId}-${sessionId}`);
            void window.launcher.showNotification({
              windowId,
              sessionId,
              runId,
              title: title || "AI 助手",
              body: summarizeForNotify(text),
              // 自定义音效 / 静音由渲染层自己处理，系统不要再叠一声。
              silent: sound !== "system",
            }).catch((error) => console.warn("[launcher] 发送通知失败：", error));
          }}
          // 点击通知后的定向跳转：由 LauncherProvider 存进 sessionRequests，这里取本窗口那条。
          sessionRequest={state.sessionRequests[windowId]}
          onSessionRequestHandled={(nonce) => {
            if (state.sessionRequests[windowId]?.nonce !== nonce) return;
            dispatch({ type: "CLEAR_SESSION_REQUEST", windowId, nonce });
          }}
          /**
           * 「把附件放进输入框」请求（桌面把文件拖到聊天窗 / 卡片停留后松手 / home 按钮）。
           * 存在全局 state 里而不是组件内：窗口可能还没挂载（home 悬浮输入框是拖到按钮上
           * 才浮出来的），请求先入队，等窗口起来由 kit 消费。
           */
          attachRequest={state.attachRequests[windowId]?.[0] ?? null}
          onAttachRequestHandled={(nonce, error) => {
            if (error) console.warn("[launcher] 附件放进输入框失败：", error);
            dispatch({ type: "CLEAR_ATTACH_REQUEST", windowId, nonce });
          }}
          /**
           * 「直接发一轮消息」请求（语音优先：松手即发）。
           * 不传 sessionId = 让 kit 新开一条对话再发 —— 语音优先的核心口径「一句一对话」。
           */
          sendRequest={state.sendRequests[windowId]?.[0] ?? null}
          onSendRequestHandled={(nonce, error) => {
            if (error) console.warn("[launcher] 语音消息发送失败：", error);
            dispatch({ type: "CLEAR_SEND_REQUEST", windowId, nonce });
          }}
          // 右键 Home → 设置里的「显示模型」开关：受控传给 kit，输入框里的模型选择器实时跟随
          showModel={launcher.showModel ?? false}
          onShowModelChange={(show) => dispatch({ type: "SET_SHOW_MODEL", show })}
          showContextUsage={launcher.showContextUsage ?? false}
          onShowContextUsageChange={(show) => dispatch({ type: "SET_SHOW_CONTEXT_USAGE", show })}
          preview={Boolean(preview)}
          /**
           * 「看得见才算已读」：窗口被关掉（最小化，实例仍挂载供会话继续跑）或只是 hover 预览
           * （只露出输入框、看不到消息区）时，宿主这边一律读不到任何内容，所以禁止 kit 把会话
           * 标成已读 —— 否则关着窗口跑完的那一轮会被判成已读，桌面「进行中」卡片直接消失。
           */
          readSuppressed={Boolean(preview) || minimized}
          // Home 主窗口（含 hover 预览与点击展开）与「新建窗口」实例都始终开新会话：
          // 两种形态共用同一「空输入框」，输入框底下的工具栏（含项目/文件夹选择）保持一致。
          // 数域窗口不传，沿用 preview 旧行为。
          newChatOnMount={isHomeChatWindow(windowId)}
          onRunningSessionsChange={(_count, sessions) => dispatch({ type: "SET_RUNNING_SESSIONS", windowId, sessions })}
          onSessionSnapshotsChange={(cards) => dispatch({ type: "SET_SESSION_CARDS", windowId, cards })}
          // 内置快捷键（Ctrl/Cmd+N 新建、B 左栏、O 右栏）只给最上层窗口开启：
          // Launcher 会同时挂多个 AgentWindow，不限制的话一次按键会把所有窗口的面板都翻一遍。
          shortcutsActive={state.focusDockItemId === windowId}
          onRightPanelWidthChange={handleRightPanelWidth}
          rightPanelWidth={rightWidth}
          onComposerTextPresenceChange={onTextPresenceChange}
          /** 「有内容」= 文字**或**附件：只挂了附件时 home 悬浮输入框也不能自动收起。 */
          onComposerContentPresenceChange={onContentPresenceChange}
        />
    </FocusWindowFrame>
    </>
  );
}
