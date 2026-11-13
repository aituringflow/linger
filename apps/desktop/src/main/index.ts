// 应用身份：必须排在所有 agent-kit / agent-sdk 模块之前 —— 它把 AGENT_APP_NAME=linger
// 写进 env，kit 才会把本应用数据放到 ~/.linger。
import { APP_HOME_DIR } from "./app-name.js";
import { app, BrowserWindow, ipcMain, dialog, shell, screen, protocol, Menu, session, Notification, nativeTheme, nativeImage, clipboard, net } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { FILE_TOOLS, collectAgentText, fetchCodexModelOptions, getAgentAdapter, getConfiguredCodeBuddyModels, summarizeSessionTitle, transcribeVoice, type AgentMessage } from "@turingflow/agent-kit";
import { LocalChatStore } from "@turingflow/agent-kit/local-chat";
import { LauncherStore, DOMAIN_IDS } from "./store.js";
import { clearSavedLoginCredential, readSavedLoginCredential, saveLoginCredential } from "./login-credentials.js";
import { WechatWindowOrder } from "./wechat-window-order.js";
import { startLocalAgentServer } from "./local-agent.js";
import { LocalReferenceStore } from "./local-references.js";
import { currentSystemStatus, startSystemStatusWatch } from "./system-status.js";
import { releaseKeepAwake, setKeepAwake } from "./keep-awake.js";
import { listComputeProviders, loginComputeProvider, logoutComputeProvider, invalidateComputeProviders } from "./compute-providers.js";
import { saveDshKey, deleteDshKey, readDshKey } from "./dsh-credentials.js";
import { createDirectory, homeDir, listDirectory, movePath, renamePath, resolveInHome, trashTarget, watchDirectory } from "./home-files.js";
import { createLauncherUpdater } from "./updater.js";
import { APP_BUNDLE_ID } from "../shared/app-identity.js";
import { modelsFileStatus, watchModelsFile } from "./models-watch.js";
import { registerKnowledgeBase } from "./knowledge-base/index.js";
import { setupConsoleEncoding } from "./console-encoding.js";
import type { LauncherNotificationOpen, LauncherNotificationPayload, LauncherState } from "../shared/types";

// Windows 控制台中文日志乱码修复（macOS 不受影响）：必须在任何 console 输出之前生效。
// 详细原理见 console-encoding.ts。
setupConsoleEncoding();

// —— 自定义模型（应用主目录 `~/.linger/models.json`）——
// 设置面板里的 CustomModels 组件（来自 agent-kit）通过 window.agentHost.models 读写这里，
// AGENT_MODELS_PATH 可覆盖目录或文件名。
function modelsPath(): string {
  const configured = process.env.AGENT_MODELS_PATH?.trim();
  const candidates = [
    ...(configured ? [configured.endsWith(".json") ? configured : path.join(configured, "models.json")] : []),
    path.join(APP_HOME_DIR, "models.json"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function readModels(): { path: string; models: Record<string, unknown>[] } {
  const file = modelsPath();
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { models: [] };
  if (!data || typeof data !== "object" || !Array.isArray(data.models)) throw new Error("models.json 格式错误：缺少 models 数组");
  return { path: file, models: data.models };
}

// 本地壁纸图片协议：渲染层用 local-file://<绝对路径> 加载，规避 http 页面直接引用 file:// 被拦
// 部分机器上 Electron 的 GPU 进程会直接崩掉（"GPU process isn't usable. Goodbye."），
// 表现为窗口白屏或动画不刷新。设 LAUNCHER_DISABLE_GPU=1 可退回软件渲染排查/绕过。
if (process.env.LAUNCHER_DISABLE_GPU === "1") app.disableHardwareAcceleration();
// 窗口被别的窗口完全遮住时 Chromium 会判定 occluded → 页面 hidden、rAF 冻结、动画停摆。
// 正常使用没问题（看不见就不画），但用 CDP 远程测性能时会把窗口当成"隐藏"而测不到帧。
// 设 LAUNCHER_NO_OCCLUSION=1 关掉这个节流（只用于调试）。
if (process.env.LAUNCHER_NO_OCCLUSION === "1") {
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
}

protocol.registerSchemesAsPrivileged([
  { scheme: "local-file", privileges: { secure: true, standard: false, supportFetchAPI: true, stream: true } },
]);

// —— 应用图标跟随系统外观 ——
// macOS Dock 图标与 Windows 窗口/任务栏图标在运行时随系统深浅色切换，两端统一使用
// 圆形背景撑满 1024 画布的圆盘图（dark/light），与打包 .icns/.ico 同源；
// 静态 .icns/.ico 只决定打包 exe / 快捷方式图标，这里只影响运行中的 Dock / 窗口图标。
const APP_ICON_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "app-icon")
  : path.join(app.getAppPath(), "resources", "app-icon");
function resolveAppIconPath(dark: boolean): string {
  const variant = dark ? "dark" : "light";
  return path.join(APP_ICON_DIR, `agentos-launcher-${variant}.${process.platform === "win32" ? "ico" : "png"}`);
}
function loadAppIcon(dark: boolean): ReturnType<typeof nativeImage.createFromPath> {
  return nativeImage.createFromPath(resolveAppIconPath(dark));
}
function applyAppIcon(): void {
  const icon = loadAppIcon(nativeTheme.shouldUseDarkColors);
  if (process.platform === "darwin" && app.dock) app.dock.setIcon(icon);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setIcon(icon);
  }
}

// 开发态（electron-vite dev，未打包）使用独立 userData 目录，避免与已安装版互抢进程锁与数据。
if (!app.isPackaged) {
  const primaryDir = path.join(app.getPath("appData"), "launcher");
  const devDir = path.join(app.getPath("appData"), "launcher-dev");
  app.setPath("userData", devDir);
  void primaryDir;
}

// Desktop reads client configuration only; session signing stays on the server.
const ENV_KEYS = ["AGENT_KIT_ASR_PROVIDER", "AGENT_KIT_ASR_HOST", "AGENT_KIT_ASR_API_KEY", "WEB_SERVER_URL", "APP_PUBLIC_URL", "AUTH_PROVIDER", "PORT"] as const;
const envFiles = [
  path.join(app.getAppPath(), ".env"),
  // Packaged builds include only public client configuration.
  ...(app.isPackaged ? [path.join(process.resourcesPath, ".env")] : [path.resolve(app.getAppPath(), "../web/.env")]),
];
for (const envFile of envFiles) {
  if (!fs.existsSync(envFile)) continue;
  let env: Record<string, string | undefined>;
  try { env = parseEnv(fs.readFileSync(envFile, "utf8")); } catch { continue; }
  for (const key of ENV_KEYS) if (!process.env[key] && env[key]) process.env[key] = env[key];
}

/**
 * Web 服务根地址（登录 / 会话账号由 apps/web 的 /linger 提供，约定与本地宿主一致）。
 * 优先级：WEB_SERVER_URL 环境变量 > APP_PUBLIC_URL 环境变量（dev 下自动并入 ../web/.env 的值）。
 * 返回形如 http://127.0.0.1:3100/linger；未配置或非法时返回 null（设置弹层头像点击退化为不可用）。
 */
function webAuthBaseUrl(): string | null {
  const configured = (process.env.WEB_SERVER_URL || process.env.APP_PUBLIC_URL || `http://127.0.0.1:${process.env.PORT || 3100}`).trim();
  if (!configured) return null;
  let url: URL;
  try { url = new URL(configured); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const root = url.pathname.replace(/\/+$/, "");
  // WEB_SERVER_URL is the complete client base URL; APP_PUBLIC_URL is an origin fallback.
  url.pathname = process.env.WEB_SERVER_URL ? root : (root.endsWith("/linger") ? root : `${root}/linger`);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

type WebSessionUser = { name: string; avatar?: string; provider: string; unionId: string; sub: string; userCode?: string; deptName?: string };

// contacts / chat / 资料等 IPC 每次鉴权都会问一次登录态。会话接口是个额外的本地往返，
// 用 1.5s 短缓存吸收同一操作链里的重复调用；登录态或资料发生变化时会主动清空。
let webSessionCache: { at: number; value: WebSessionUser | null } | null = null;
const WEB_SESSION_CACHE_MS = 1500;
function invalidateWebSessionCache(): void { webSessionCache = null; }

async function webSessionUser(): Promise<WebSessionUser | null> {
  if (webSessionCache && Date.now() - webSessionCache.at < WEB_SESSION_CACHE_MS) return webSessionCache.value;
  const value = await resolveWebSessionUser();
  webSessionCache = { at: Date.now(), value };
  return value;
}

async function resolveWebSessionUser(): Promise<WebSessionUser | null> {
  const base = webAuthBaseUrl();
  if (!base) return null;
  const token = (await session.defaultSession.cookies.get({ url: base })).find(cookie => cookie.name === "agent_session")?.value;
  if (!token) return null;
  const cookie = `agent_session=${encodeURIComponent(token)}`;
  // Only the web service can verify its session cookie.
  try {
    // Bound the session request so an unavailable service does not hang IPC calls.
    const response = await fetch(`${base}/api/auth/session`, { headers: { cookie }, signal: AbortSignal.timeout(3000) });
    if (response.status === 401) return null;
    if (response.ok) {
      const data = await response.json() as {
        authenticated?: boolean;
        user?: { name?: string; avatar?: string; provider?: string; unionId?: string; sub?: string; userCode?: string; deptName?: string };
      };
      const user = data.user;
      if (data.authenticated && user?.sub) {
        return {
          name: user.name || "用户",
          avatar: user.avatar || undefined,
          provider: user.provider || "builtin",
          unionId: user.unionId || user.sub,
          sub: user.sub,
          userCode: user.userCode,
          deptName: user.deptName,
        };
      }
    }
  } catch {
    /* The session cannot be verified while the service is unavailable. */
  }
  return null;
}

async function webCookieHeader(): Promise<string> {
  const base = webAuthBaseUrl();
  if (!base) return "";
  const cookies = await session.defaultSession.cookies.get({ url: base });
  return cookies.map(cookie => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
}

// 打包版的微信数域复用同一个 Electron 可执行文件，但在独立进程中运行自己的入口。
// 必须先于主窗口的单实例锁分流，否则子进程会被当作第二个 Launcher 退出。
const wechatViewerChild = app.isPackaged && process.argv.includes("--wechat-viewer");
if (wechatViewerChild) {
  app.setPath("userData", path.join(app.getPath("appData"), "launcher-wechat-viewer"));
  require(path.join(app.getAppPath(), "prototypes", "wechat-window-cua", process.platform === "darwin" ? "mac-viewer.cjs" : "viewer.cjs"));
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  let mainWindow: BrowserWindow | null = null;
  let loginWindow: BrowserWindow | null = null;
  let wechatPoc: ChildProcess | null = null;
  const wechatOrder = new WechatWindowOrder();
  let localAgentUrl = "";
  let localChats: LocalChatStore | null = null;
  const announceDesktopSessions = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("launcher:desktop-sessions-changed");
  };
  /** 最近一次 local-chat 访问用的 owner（base64url 用户键）：auto-title 落库时回写同一 owner 的会话。 */
  let lastChatOwner: string | null = null;
  /** 本机文件引用登记表：输入框「+」选中的文件/文件夹以 local-ref:// 句柄走完全链路。 */
  let refs: LocalReferenceStore | null = null;
  /** 每扇虚拟窗口 + 会话只保留最新一条通知，避免通知中心堆积同一会话的多轮回复。 */
  const notificationsByRoute = new Map<string, Notification>();
  /** 已展示过的 runId（按来源页面 + 路由）：流重连/React 重渲染触发的重复回调不再弹第二条。 */
  const deliveredRunIds = new Map<string, string>();
  /** 点击通知时页面可能正在加载：先暂存，did-finish-load 后再投递，避免事件丢失。 */
  const pendingNotificationRoutes = new Map<number, LauncherNotificationOpen>();

  /** 把被最小化/隐藏在后台的原生窗口拉回前台。 */
  function focusMainWindow(): void {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
  }

  /** 通知点击 -> 渲染层定向路由（虚拟窗口 + 会话）。 */
  function sendNotificationOpen(contents: Electron.WebContents, payload: LauncherNotificationOpen): void {
    if (contents.isDestroyed()) return;
    if (contents.isLoading()) {
      pendingNotificationRoutes.set(contents.id, payload);
      return;
    }
    contents.send("launcher:notification-open", payload);
  }

  function validNotificationWindow(windowId: string): boolean {
    return windowId === "primary" || /^primary-[1-9]\d{0,4}$/.test(windowId) || windowId === "workspace" || (DOMAIN_IDS as readonly string[]).includes(windowId);
  }

  const isMac = process.platform === "darwin";

  function isWindowFullScreen(win: BrowserWindow): boolean {
    return win.isFullScreen();
  }

  function applyWindowFullScreen(win: BrowserWindow, next: boolean): void {
    if (next) {
      // macOS：全屏 Space 中 setBounds 会被系统锁定回 workArea（顶部 30px 菜单栏区不覆盖，
      // 表现为黑条）。先铺满整个 display 再进入全屏，让系统以全屏尺寸创建 Space。
      win.setBounds(screen.getPrimaryDisplay().bounds);
    }
    win.setFullScreen(next);
  }

  function createWindow(): void {
    const { x, y, width, height } = screen.getPrimaryDisplay().workArea;

    mainWindow = new BrowserWindow({
      width,
      height,
      minWidth: 1024,
      minHeight: 700,
      x,
      y,
      show: false,
      backgroundColor: "#101014",
      title: "Linger",
      // 让网页内容延伸到 macOS 标题栏区域，自绘状态栏在原生全屏 Space 中仍可贴顶。
      ...(isMac ? { titleBarStyle: "hidden" as const } : {}),
      // Windows：构造时直接给定圆盘图标，避免窗口创建到 applyAppIcon() 之间先显示 Electron 默认图标；
      // macOS 图标由 app.dock.setIcon 管理，窗口构造不设 icon。
      ...(isMac ? {} : { icon: resolveAppIconPath(nativeTheme.shouldUseDarkColors) }),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        // 右侧面板内置浏览器（agent-kit 桌面端用 <webview> 加载网页）：必须启用 webviewTag，
        // 否则 <webview> 元素不渲染内容，外部网页（如 bing.com）打不开。
        webviewTag: true,
      },
    });

    mainWindow.once("ready-to-show", () => {
      mainWindow?.show();
    });

    // macOS 全屏 Space 的经典坑：Electron 进入原生全屏后窗口 bounds 仍停在 workArea
    // （从菜单栏下方开始），顶部 30px 菜单栏区域不被内容覆盖，显示成黑条。
    // 进入全屏时把窗口强制铺满整个 display（y=0 起、含菜单栏高度），
    // 退出全屏时恢复 workArea，避免非全屏态内容顶到菜单栏下面。
    // 同时把全屏状态推给渲染层：自绘状态栏只在全屏时显示（窗口态有系统任务栏/菜单栏）。
    mainWindow.on("enter-full-screen", () => {
      const win = mainWindow;
      if (!win) return;
      if (isMac) {
        const bounds = screen.getPrimaryDisplay().bounds;
        win.setBounds(bounds);
        // macOS 全屏动画期间 setBounds 可能被动画覆盖，动画结束后补一次。
        setTimeout(() => { if (!win.isDestroyed() && win.isFullScreen()) win.setBounds(bounds); }, 300);
      }
      win.webContents.send("launcher:fullscreen-changed", true);
    });
    mainWindow.on("leave-full-screen", () => {
      const win = mainWindow;
      if (!win) return;
      if (isMac) {
        const { x, y, width, height } = screen.getPrimaryDisplay().workArea;
        win.setBounds({ x, y, width, height });
      }
      win.webContents.send("launcher:fullscreen-changed", false);
    });

    // 页面加载完成后再投递「点击通知」路由：加载期间点通知不会丢事件。
    mainWindow.webContents.on("did-finish-load", () => {
      const contents = mainWindow?.webContents;
      if (!contents) return;
      const pending = pendingNotificationRoutes.get(contents.id);
      if (!pending) return;
      pendingNotificationRoutes.delete(contents.id);
      contents.send("launcher:notification-open", pending);
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    // 右侧面板内置浏览器（<webview>）安全加固：只允许 http(s) 网页，
    // 不带宿主 preload、无 Node 能力（与 local app 同一策略）。
    mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
      if (!/^https?:\/\//i.test(params.src)) { event.preventDefault(); return; }
      delete webPreferences.preload;
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
    });
    mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
      contents.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:/i.test(target)) void shell.openExternal(target);
        return { action: "deny" };
      });
    });

    // 全屏切换：Ctrl/Cmd + Enter 切换（mac 用 Cmd），F11 同样保留。
    // 必须在主进程这一层拦 —— 输入框自己的 Enter 是"发送消息"，不 preventDefault 的话
    // 页面会先把它当发送处理（kit 的 ChatComposer 只判断 !shiftKey）。这里拦住后
    // keydown 不会进渲染层，两边不会打架。
    // macOS 使用原生全屏 Space，保留触控板在桌面和全屏窗口之间切换的能力。
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      // 开发态热刷新：Menu.setApplicationMenu(null) 移除了默认菜单后，
      // Electron 自带的 Ctrl+R / Ctrl+Shift+R reload 加速器随之失效；
      // 这里在非打包环境手动恢复，改完渲染层代码一键刷新生效。
      if (!app.isPackaged && input.key === "r" && input.control && !input.alt && !input.meta) {
        event.preventDefault();
        void mainWindow?.webContents.reload();
        return;
      }
      const toggle = input.key === "F11"
        || (input.key === "Enter" && (input.control || input.meta) && !input.shift && !input.alt);
      if (!toggle) return;
      event.preventDefault();
      const win = mainWindow;
      if (win) applyWindowFullScreen(win, !isWindowFullScreen(win));
    });

    /**
     * 文本的右键菜单。
     *
     * 这个壳没有系统应用菜单（`Menu.setApplicationMenu(null)`），而 Chromium 默认也不弹
     * 右键菜单，所以聊天正文即使能选中，用户右键也拿不到「复制」—— 而他选字的唯一目的
     * 往往就是拷走。这里只在**两种**情况下弹原生菜单：
     *  · 落在可编辑控件上（输入框）→ 剪切 / 复制 / 粘贴 / 全选；
     *  · 落在有选中文字的地方（例如消息正文）→ 复制。
     * 其他区域（桌面、卡片、会话组）直接 return，渲染层自己的右键菜单照常工作。
     * 注意：DOM 里 `onContextMenu` 的 preventDefault 拦不住主进程这个事件，所以判空必须准。
     */
    mainWindow.webContents.on("context-menu", (_event, params) => {
      const hasSelection = params.selectionText.trim().length > 0;
      if (!params.isEditable && !hasSelection) return;
      const template: Electron.MenuItemConstructorOptions[] = params.isEditable
        ? [{ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" }, { role: "selectAll" }]
        : [{ role: "copy" }];
      Menu.buildFromTemplate(template).popup({ window: mainWindow ?? undefined });
    });

    // 开发态由 electron-vite 注入 ELECTRON_RENDERER_URL
    const devUrl = process.env["ELECTRON_RENDERER_URL"];    if (!app.isPackaged && devUrl) {
      void mainWindow.loadURL(devUrl);
    } else {
      void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
    }

    mainWindow.on("closed", () => {
      mainWindow = null;
      // 窗口没了就没人上报任务了：把电源断言还给系统，别让机器的休眠策略停在被拦住的状态。
      releaseKeepAwake();
    });

    // 渲染进程崩溃 / 被系统回收时同样没人上报任务，兜底释放保持唤醒。
    mainWindow.webContents.on("render-process-gone", () => { releaseKeepAwake(); });

    // 新窗口（含 Windows 的 activate 重建）套用当前外观对应的图标
    applyAppIcon();
  }

  /** 只接受自己的渲染页面（打包后的 index.html 或 electron-vite dev 源）发起的 IPC。
   *  本机文件引用会拿到任意路径句柄，属于高权限操作，不能只靠"页面内脚本"的假设。 */
  function trustedSender(senderUrl: string): boolean {
    try {
      const sender = new URL(senderUrl);
      if (sender.protocol === "file:") return sender.pathname.endsWith("/out/renderer/index.html");
      const devUrl = process.env["ELECTRON_RENDERER_URL"];
      return Boolean(devUrl && sender.origin === new URL(devUrl).origin);
    } catch {
      return false;
    }
  }

  function registerIpc(): void {
    ipcMain.handle("launcher:get-state", () => LauncherStore.get().get());
    ipcMain.handle("agent:clipboard-write", (_event, text: string) => clipboard.writeText(text));
    // 自绘状态栏：渲染层挂载时先要一份当前值，之后靠 launcher:system-status-changed 增量更新。
    ipcMain.handle("launcher:system-status", () => currentSystemStatus());
    // 渲染层挂载时问一次全屏初始态（enter/leave 事件只推增量，页面重载后需重新对齐）。
    ipcMain.handle("launcher:is-fullscreen", () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen()));
    // 「关于」窗口：只暴露静态的应用/运行时版本信息，不含任何可执行内容。
    ipcMain.handle("launcher:app-info", () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      node: process.versions.node ?? "",
      platform: process.platform,
    }));

    // —— 会话完成通知：由主进程创建原生通知，才能拿到可靠的点击事件 ——
    // 渲染层只传「窗口 + 会话 + 文案」，点击后原样回传这两个 id，
    // 不接收 URL 或任意可执行内容，避免通知变成跳转任意页面的入口。
    ipcMain.handle("launcher:notification-show", (event, payload: unknown) => {
      console.log("[launcher:notify] handler called, payload:", payload);
      if (!trustedSender(event.sender.getURL())) { console.warn("[launcher:notify] rejected: trustedSender failed, url=", event.sender.getURL()); return false; }
      if (!Notification.isSupported()) { console.warn("[launcher:notify] rejected: Notification.isSupported()=false"); return false; }
      const value = payload as Partial<LauncherNotificationPayload> | null;
      const windowId = typeof value?.windowId === "string" ? value.windowId : "";
      const sessionId = typeof value?.sessionId === "string" ? value.sessionId : "";
      const runId = typeof value?.runId === "string" ? value.runId : "";
      if (!validNotificationWindow(windowId)) { console.warn("[launcher:notify] rejected: invalid windowId=", windowId); return false; }
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) { console.warn("[launcher:notify] rejected: bad sessionId format=", sessionId); return false; }
      if (runId && !/^[a-zA-Z0-9_-]{1,128}$/.test(runId)) { console.warn("[launcher:notify] rejected: bad runId format=", runId); return false; }
      const title = typeof value?.title === "string" ? value.title.trim().slice(0, 160) : "";
      const body = typeof value?.body === "string" ? value.body.trim().slice(0, 500) : "";
      if (!title) { console.warn("[launcher:notify] rejected: empty title"); return false; }

      const source = event.sender;
      const routeKey = `${source.id}:${windowId}:${sessionId}`;
      // 同一轮回复只弹一次：重连 / 重渲染会重复触发完成回调。
      if (runId && deliveredRunIds.get(routeKey) === runId) return false;

      let notification: Notification;
      try {
        notification = new Notification({ title, body, silent: value?.silent !== false });
      } catch (error) {
        console.warn("[launcher] 创建系统通知失败：", error);
        return false;
      }
      // 创建成功后才记 runId：否则创建失败会被误判成「已提醒」而永远不再提醒。
      if (runId) {
        deliveredRunIds.set(routeKey, runId);
        // 长跑进程里会话会越攒越多：只保留最近一段，防止这张表无限增长。
        if (deliveredRunIds.size > 500) {
          const oldest = deliveredRunIds.keys().next().value;
          if (oldest) deliveredRunIds.delete(oldest);
        }
      }
      // 同一会话连发多轮：关掉上一条，通知中心只保留最新一轮。
      const previous = notificationsByRoute.get(routeKey);
      if (previous && previous !== notification) previous.close();
      notificationsByRoute.set(routeKey, notification);
      notification.on("click", () => {
        notificationsByRoute.delete(routeKey);
        focusMainWindow();
        sendNotificationOpen(source, { windowId, sessionId });
      });
      notification.on("close", () => {
        if (notificationsByRoute.get(routeKey) === notification) notificationsByRoute.delete(routeKey);
      });
      notification.on("show", () => {
        console.log("[launcher:notify] 系统已报告通知显示", { routeKey });
      });
      notification.on("failed", (_event, error) => {
        console.warn("[launcher:notify] 系统通知失败", { routeKey, error });
        if (notificationsByRoute.get(routeKey) === notification) notificationsByRoute.delete(routeKey);
      });
      try {
        console.log("[launcher:notify] 请求显示系统通知", { routeKey, packaged: app.isPackaged, executable: process.execPath });
        notification.show();
        console.log("[launcher:notify] 已提交通知请求，等待系统结果");
      } catch (error) {
        console.warn("[launcher:notify] 显示系统通知失败：", error);
        return false;
      }
      return true;
    });

    // macOS Dock 未读数 badge：渲染层算好总未读数后推过来，主进程统一设置。
    ipcMain.on("launcher:set-unread-badge", (event, count: unknown) => {
      if (!trustedSender(event.sender.getURL())) return;
      const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
      if (process.platform === "darwin" && app.dock) {
        app.dock.setBadge(n > 0 ? String(n) : "");
      }
    });

    ipcMain.handle("launcher:save-state", (_event, state: LauncherState) => {
      try {
        if (!state || typeof state !== "object" || !Array.isArray(state.domains)) {
          return { ok: false, error: "状态格式不合法" };
        }
        LauncherStore.get().replace(state);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });

    // 「有任务运行时保持唤醒」：渲染层把「开关开着 && 还有会话在跑」算成一个布尔值推过来，
    // 主进程只负责向系统申请 / 释放电源断言（细节见 keep-awake.ts）。
    // 只接受 trustSender，避免任意页面把机器钉在唤醒状态。
    ipcMain.handle("launcher:keep-awake", (event, active: unknown) => {
      if (!trustedSender(event.sender.getURL())) return false;
      return setKeepAwake(active === true);
    });

    ipcMain.handle("launcher:pick-wallpaper-image", async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
        title: "选择桌面壁纸图片",
        properties: ["openFile"],
        filters: [
          { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "heic"] },
        ],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return result.filePaths[0];
    });

    const openWechatPoc = (theme: "light" | "dark" = "light"): { ok: boolean; error?: string } => {
      if (process.platform !== "win32" && process.platform !== "darwin") return { ok: false, error: "微信数域目前仅支持 Windows 和 macOS" };
      if (wechatPoc && wechatPoc.exitCode === null && !wechatPoc.killed) {
        wechatOrder.setForeground(true);
        if (wechatPoc.connected) wechatPoc.send({ type: "show" });
        return { ok: true };
      }
      const pocDir = app.isPackaged
        ? path.join(app.getAppPath(), "prototypes", "wechat-window-cua")
        : path.resolve(__dirname, "../../prototypes/wechat-window-cua");
      const entry = path.join(pocDir, process.platform === "darwin" ? "mac-viewer.cjs" : "viewer.cjs");
      if (!fs.existsSync(entry)) return { ok: false, error: "找不到微信原型入口" };
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        const child = spawn(process.execPath, [
          ...(app.isPackaged ? ["--wechat-viewer"] : [entry]),
          `--theme=${theme === "dark" ? "dark" : "light"}`,
        ], {
          cwd: app.isPackaged ? app.getPath("userData") : path.resolve(pocDir, "../../../.."),
          env, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        wechatPoc = child;
        wechatOrder.setForeground(true);
        child.on("message", (message: unknown) => {
          if (wechatPoc !== child || !message || typeof message !== "object" || !("type" in message)) return;
          const event = message as { type: string; at?: number };
          const at = typeof event.at === "number" && Number.isFinite(event.at) ? event.at : Date.now();
          if (event.type === "focus") wechatOrder.focus(at);
          if (event.type === "blur") wechatOrder.blur(at);
          if (event.type === "minimize") wechatOrder.minimize(at);
        });
        let reportedClosed = false;
        const closed = () => {
          if (reportedClosed) return;
          reportedClosed = true;
          if (wechatPoc === child) { wechatPoc = null; wechatOrder.setForeground(false); }
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("launcher:wechat-poc-closed");
        };
        child.once("error", (error) => { console.error("[launcher] 微信原型启动失败", error); closed(); });
        child.once("exit", closed);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };
    ipcMain.handle("launcher:open-wechat-poc", (_event, theme: "light" | "dark" = "light") => openWechatPoc(theme));
    ipcMain.on("launcher:wechat-dock-press", () => wechatOrder.beginDockPress());
    ipcMain.on("launcher:wechat-dock-press-cancel", () => wechatOrder.cancelDockPress());
    ipcMain.on("launcher:wechat-launcher-interaction", () => {
      if (!wechatPoc) return;
      wechatOrder.setForeground(false);
      if (wechatPoc.connected) wechatPoc.send({ type: "background" });
    });
    ipcMain.handle("launcher:toggle-wechat-poc", (_event, theme: "light" | "dark", usePress: boolean) => {
      if (!wechatPoc || wechatPoc.exitCode !== null || wechatPoc.killed) {
        const result = openWechatPoc(theme);
        return { ...result, foreground: result.ok };
      }
      const foreground = wechatOrder.toggle(Boolean(usePress));
      if (wechatPoc.connected) wechatPoc.send({ type: foreground ? "show" : "background" });
      if (!foreground && mainWindow && !mainWindow.isDestroyed()) {
        focusMainWindow();
        mainWindow.moveTop();
      }
      return { ok: true, foreground };
    });
    ipcMain.handle("launcher:close-wechat-poc", () => {
      if (!wechatPoc || wechatPoc.exitCode !== null) return;
      if (wechatPoc.connected) wechatPoc.send({ type: "close" });
    });
    ipcMain.handle("launcher:bring-home-forward", () => {
      if (!wechatPoc || wechatPoc.exitCode !== null || !mainWindow || mainWindow.isDestroyed()) return;
      wechatOrder.setForeground(false);
      if (wechatPoc.connected) wechatPoc.send({ type: "background" });
      focusMainWindow();
      mainWindow.moveTop();
    });
    ipcMain.handle("launcher:open-external", (_event, url: string) => {
      if (typeof url === "string" && /^https?:\/\//.test(url)) {
        return shell.openExternal(url);
      }
    });

    ipcMain.handle("launcher:list-models", async () => {
      return getConfiguredCodeBuddyModels();
    });
    // models.json 的版本信息：设置页可显示「上次更新于」，渲染层也用它做兜底判断
    ipcMain.handle("launcher:models-file-status", (event) => {
      if (!trustedSender(event.sender.getURL())) return null;
      const { current, record, changed } = modelsFileStatus();
      return { file: current.file, mtimeMs: current.mtimeMs, seenAt: record?.seenAt ?? null, changed };
    });
    ipcMain.handle("launcher:list-codex-models", async (event) => {
      if (!trustedSender(event.sender.getURL())) return [];
      return fetchCodexModelOptions().catch(() => []);
    });

    ipcMain.handle("launcher:list-dsh-models", async (event) => {
      if (!trustedSender(event.sender.getURL())) return [];
      const key = readDshKey();
      if (!key) return [];
      try {
        const response = await fetch("https://api.deepseek.com/models", { headers: { "x-api-key": key, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error("model listing failed");
        const body = await response.json() as { data?: unknown };
        if (!Array.isArray(body.data)) throw new Error("invalid model listing");
        const models = body.data.flatMap((entry: unknown) => {
          if (!entry || typeof entry !== "object") return [];
          const model = entry as { id?: unknown; name?: unknown };
          return typeof model.id === "string" && model.id.trim() ? [{ id: model.id, name: typeof model.name === "string" ? model.name : model.id }] : [];
        });
        if (models.length) return models;
      } catch { /* SDK built-in catalog is the fallback when discovery fails. */ }
      return [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }, { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" }];
    });

    // —— 自定义模型（与本地 app 个人中心同一套；落到 ~/.linger/models.json）——
    // list 返回 { path, models }，models 已剔除 apiKey、附加 hasApiKey；
    // save 接收整个模型对象（originalId 标记改名前的 id，apiKey 留空表示沿用旧密钥）；
    // delete 按 id 移除。写入走 .tmp + rename，原子替换避免半截文件。
    ipcMain.handle("launcher:models:list", (event) => {
      if (!trustedSender(event.sender.getURL())) return { path: modelsPath(), models: [] as Record<string, unknown>[] };
      const result = readModels();
      return { path: result.path, models: result.models.map(({ apiKey, ...model }) => ({ ...model, hasApiKey: Boolean(apiKey) })) };
    });
    ipcMain.handle("launcher:models:save", (event, payload: unknown) => {
      if (!trustedSender(event.sender.getURL())) return false;
      if (!payload || typeof payload !== "object") return false;
      const input = payload as Record<string, unknown>;
      const id = typeof input.id === "string" ? input.id.trim() : "";
      const originalId = typeof input.originalId === "string" ? input.originalId : "";
      if (!id || typeof input.url !== "string" || !/^https?:\/\//.test(input.url)) return false;
      const file = modelsPath();
      const document = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { models: [] };
      if (!document || !Array.isArray(document.models)) return false;
      const index = originalId ? document.models.findIndex((m: { id?: string }) => m.id === originalId) : -1;
      if (document.models.some((m: { id?: string }, i: number) => m.id === id && i !== index)) return false;
      const previous = index >= 0 ? document.models[index] : {};
      const { originalId: _originalId, hasApiKey: _hasApiKey, apiKey, ...fields } = input;
      const model = { ...previous, ...fields, id, apiKey: typeof apiKey === "string" && apiKey ? apiKey : previous.apiKey };
      if (!model.apiKey) delete model.apiKey;
      if (index >= 0) document.models[index] = model; else document.models.push(model);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(document, null, 2) + "\n", "utf8");
      fs.renameSync(temp, file);
      return true;
    });
    ipcMain.handle("launcher:models:delete", (event, id: unknown) => {
      if (!trustedSender(event.sender.getURL()) || typeof id !== "string") return false;
      try {
        const file = modelsPath();
        const document = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Array.isArray(document.models)) return false;
        document.models = document.models.filter((model: { id?: string }) => model.id !== id);
        const temp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(document, null, 2) + "\n", "utf8");
        fs.renameSync(temp, file);
        return true;
      } catch {
        return false;
      }
    });

    // —— 系统设置 →「算力提供商」——
    // 登录态由 CodeBuddy SDK 探测（带 20s 缓存）；登录时把授权链接丢给系统浏览器，
    // 用户在浏览器里点完授权后 SDK 才会 resolve —— 所以这个 invoke 会挂住一段时间，属正常。
    ipcMain.handle("launcher:compute-providers", async (event, refresh: unknown) => {
      if (!trustedSender(event.sender.getURL())) return [];
      return listComputeProviders(refresh === true);
    });
    // The old safeStorage credential cannot be read without invoking Keychain.
    // Remove it only after a replacement is saved or the user deletes the key.
    const removeLegacyDshKey = () => {
      try { fs.unlinkSync(path.join(app.getPath("userData"), "dsh-credentials.json")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    };
    const notifyComputeProvidersChanged = (provider: "workbuddy" | "codex" | "dsh") => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send("launcher:compute-providers-changed", provider);
      }
    };
    ipcMain.handle("launcher:dsh-save-key", (event, key: unknown) => {
      if (!trustedSender(event.sender.getURL()) || typeof key !== "string") return { ok: false, error: "无权操作或密钥无效" };
      try { saveDshKey(key); removeLegacyDshKey(); invalidateComputeProviders(); notifyComputeProvidersChanged("dsh"); return { ok: true }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "保存失败" }; }
    });
    ipcMain.handle("launcher:dsh-delete-key", (event) => {
      if (!trustedSender(event.sender.getURL())) return { ok: false, error: "无权操作" };
      try { deleteDshKey(); removeLegacyDshKey(); invalidateComputeProviders(); notifyComputeProvidersChanged("dsh"); return { ok: true }; }
      catch { return { ok: false, error: "删除失败" }; }
    });
    ipcMain.handle("launcher:compute-login", async (event, provider: unknown) => {
      if (!trustedSender(event.sender.getURL())) return { ok: false, error: "无权操作" };
      if (provider !== "workbuddy" && provider !== "codex") return { ok: false, error: "未知的算力提供商" };
      const result = await loginComputeProvider(provider, (url) => {
        // 只放行 https 授权页，避免 SDK 返回异常协议时被拿去拉起本地程序。
        if (/^https:\/\//i.test(url)) void shell.openExternal(url);
      });
      notifyComputeProvidersChanged(provider);
      return result;
    });
    ipcMain.handle("launcher:compute-logout", async (event, provider: unknown) => {
      if (!trustedSender(event.sender.getURL())) return { ok: false, error: "无权操作" };
      if (provider !== "workbuddy" && provider !== "codex") return { ok: false, error: "未知的算力提供商" };
      const result = await logoutComputeProvider(provider);
      notifyComputeProvidersChanged(provider);
      return result;
    });

    ipcMain.handle("launcher:transcribe-voice", async (_event, audio: ArrayBuffer | Uint8Array, mimeType: string, fileName: string) => {
      const bytes = audio instanceof ArrayBuffer ? Buffer.from(audio) : audio instanceof Uint8Array ? Buffer.from(audio) : null;
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024 || typeof mimeType !== "string" || !mimeType.startsWith("audio/") || typeof fileName !== "string" || !/^dictation\.(webm|m4a|mp4|ogg|wav|mp3)$/i.test(fileName)) {
        return { ok: false, error: "录音数据无效" };
      }
      try {
        const result = await transcribeVoice({ bytes, mimeType, fileName });
        return { ok: true, text: result.text ?? "" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "语音识别暂时不可用" };
      }
    });

    ipcMain.handle("launcher:chat-send", async (_event, sessionId: string, input: AgentMessage[], model?: string) => {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || !Array.isArray(input) || input.length > 100 ||
        input.some((message) => !message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string" || message.content.length > 100_000) ||
        (model !== undefined && (typeof model !== "string" || model.length > 128))) {
        return { ok: false, error: "会话内容无效" };
      }
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("模型响应超时，请重试"));
        }, 20 * 60_000);
      });
      try {
        const stream = getAgentAdapter("codebuddy").stream({
          messages: input,
          signal: controller.signal,
          config: {
            sessionId,
            model: model || undefined,
            allowBash: true,
            allowedTools: [...FILE_TOOLS, "AskUserQuestion", "Bash", "PowerShell", "Task"],
            webFetch: true,
            browserAgent: true,
            cliExecutable: process.execPath,
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
        });
        return { ok: true, text: await Promise.race([collectAgentText(stream), deadline]) };
      } catch (error) {
        return { ok: false, error: controller.signal.aborted ? "模型响应超时，请重试" : error instanceof Error ? error.message : String(error) };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });

    ipcMain.handle("launcher:chat-title", async (_event, firstMessage: string, model?: string) => {
      if (typeof firstMessage !== "string" || !firstMessage.trim() || firstMessage.length > 100_000 ||
        (model !== undefined && (typeof model !== "string" || model.length > 128))) {
        return { ok: false, error: "标题输入无效" };
      }
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<string>((resolve) => {
        timeout = setTimeout(() => { controller.abort(); resolve(""); }, 45_000);
      });
      try {
        const title = await Promise.race([summarizeSessionTitle(firstMessage, {
          agentMode: "codebuddy",
          model,
          cliExecutable: process.execPath,
          env: { ELECTRON_RUN_AS_NODE: "1" },
          signal: controller.signal,
        }), deadline]);
        return title ? { ok: true, title } : { ok: false, error: "标题生成失败" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    });

    // —— 渲染层 AgentWindow 的本地 Agent 服务地址 ——
    ipcMain.handle("launcher:agent-host", () => ({ url: localAgentUrl }));

    // —— 渲染层登录/会话账号的 Web 服务根地址（未配置返回 null）——
    ipcMain.handle("launcher:web-auth", () => {
      const url = webAuthBaseUrl();
      return url ? { url } : null;
    });
    ipcMain.handle("launcher:web-session", (event) => trustedSender(event.sender.getURL()) ? webSessionUser() : null);
    // 修改自己的展示名 / 头像。user_code 是身份主数据，服务端只接受 name / avatar。
    // 登录窗是远端页面、不走这条通道（它有自己的 preload），只有受信的应用内页面可调用。
    ipcMain.handle("launcher:update-profile", async (event, patch: unknown) => {
      if (!trustedSender(event.sender.getURL())) return { ok: false, error: "无权修改资料" };
      const base = webAuthBaseUrl();
      if (!base) return { ok: false, error: "Web 登录地址未配置" };
      const current = await webSessionUser();
      if (!current) return { ok: false, error: "请先登录" };
      if (!patch || typeof patch !== "object") return { ok: false, error: "无效的修改内容" };
      const input = patch as { name?: unknown; avatar?: unknown };
      const body: { name?: string; avatar?: string } = {};
      if (typeof input.name === "string") body.name = input.name;
      if (typeof input.avatar === "string") body.avatar = input.avatar;
      if (!body.name && !body.avatar) return { ok: false, error: "没有需要更新的内容" };
      // data URL 的粗略上限：服务端按解码后 256KB 卡，这里先拦明显超标的请求体。
      if (body.avatar && body.avatar.length > 400_000) return { ok: false, error: "头像图片过大" };
      try {
        const response = await fetch(`${base}/api/auth/profile`, {
          method: "PATCH",
          headers: { cookie: await webCookieHeader(), "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({})) as { error?: string; user?: { name?: string; avatar?: string; userCode?: string } };
        if (!response.ok) return { ok: false, error: data.error || "保存失败，请重试" };
        invalidateWebSessionCache();
        mainWindow?.webContents.send("launcher:web-session-changed");
        return {
          ok: true,
          user: { name: data.user?.name || current.name, avatar: data.user?.avatar, userCode: data.user?.userCode ?? current.userCode },
        };
      } catch (error) {
        console.error("[launcher] 修改个人资料失败", error);
        return { ok: false, error: "无法连接登录服务，请稍后重试" };
      }
    });
    ipcMain.handle("launcher:web-logout", async (event) => {
      if (!trustedSender(event.sender.getURL())) return { ok: false, error: "无权退出登录" };
      const base = webAuthBaseUrl();
      if (!base) return { ok: false, error: "Web 登录地址未配置" };
      try {
        const response = await fetch(`${base}/api/auth/logout`, {
          method: "POST", headers: { cookie: await webCookieHeader() },
        });
        if (!response.ok) return { ok: false, error: "退出登录失败，请重试" };
        await session.defaultSession.cookies.remove(base, "agent_session");
        await session.defaultSession.cookies.remove(base, "agent_oauth_state");
        await session.defaultSession.cookies.remove(base, "agent_login_next");
        invalidateWebSessionCache();
        mainWindow?.webContents.send("launcher:web-session-changed");
        return { ok: true };
      } catch (error) {
        console.error("[launcher] Web 退出登录失败", error);
        return { ok: false, error: "无法连接登录服务，请稍后重试" };
      }
    });
    // 彻底删除当前账号（不可恢复）：调 web 端 /api/auth/delete-account（服务端删 DB + 用户文件区），
    // 成功后清理本机：会话 Cookie、记住的登录凭据、该用户的本机聊天落盘，并刷新界面登录态。
    ipcMain.handle("launcher:web-delete-account", async (event) => {
      if (!trustedSender(event.sender.getURL())) return { ok: false, error: "无权删除账号" };
      const base = webAuthBaseUrl();
      if (!base) return { ok: false, error: "Web 登录地址未配置" };
      const current = await webSessionUser();
      if (!current) return { ok: false, error: "请先登录" };
      try {
        const response = await fetch(`${base}/api/auth/delete-account`, {
          method: "POST",
          headers: { cookie: await webCookieHeader(), "content-type": "application/json" },
          body: JSON.stringify({ confirm: "删除账号" }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          return { ok: false, error: data.error || "删除账号失败，请重试" };
        }
        await session.defaultSession.cookies.remove(base, "agent_session");
        await session.defaultSession.cookies.remove(base, "agent_oauth_state");
        await session.defaultSession.cookies.remove(base, "agent_login_next");
        clearSavedLoginCredential();
        invalidateWebSessionCache();
        // 清理该用户的本机聊天数据（owner = base64url("<provider>:<unionId>")，与 chats IPC 同口径）
        const owner = Buffer.from(`${current.provider}:${current.unionId}`).toString("base64url");
        localChats?.removeOwner(owner);
        announceDesktopSessions();
        mainWindow?.webContents.send("launcher:web-session-changed");
        return { ok: true };
      } catch (error) {
        console.error("[launcher] Web 删除账号失败", error);
        return { ok: false, error: "无法连接登录服务，请稍后重试" };
      }
    });
    ipcMain.handle("launcher:domain-ticket", async (event) => {
      if (!trustedSender(event.sender.getURL()) || !await webSessionUser()) return null;
      const base = webAuthBaseUrl();
      if (!base) return null;
      const response = await fetch(`${base}/api/realtime-ticket`, { headers: { cookie: await webCookieHeader() } });
      if (!response.ok) return null;
      const data = await response.json() as { ticket?: string };
      return data.ticket || null;
    });
    ipcMain.handle("launcher:contacts-api", async (event, method: unknown, pathSuffix: unknown, body: unknown) => {
      if (!trustedSender(event.sender.getURL())) return { ok: false, status: 403, data: { error: "无权访问" } };
      const base = webAuthBaseUrl();
      if (!base || !await webSessionUser()) return { ok: false, status: 401, data: { error: "请先登录" } };
      if (method !== "GET" && method !== "POST" && method !== "DELETE") return { ok: false, status: 405, data: { error: "操作不支持" } };
      if (typeof pathSuffix !== "string" || !/^\/?(?:users\?q=[a-zA-Z0-9._%-]{2,128}|invitations(?:\/\d+\/respond)?|friends\/[0-9a-f-]{36}(?:\/session)?|group-session\?ids=[0-9a-f%,-]{73,1200})?$/.test(pathSuffix))
        return { ok: false, status: 400, data: { error: "无效路径" } };
      const response = await fetch(`${base}/api/domain/contacts/${pathSuffix.replace(/^\//, "")}`, {
        method, headers: { cookie: await webCookieHeader(), "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({ error: "服务响应错误" })) };
    });
    ipcMain.handle("launcher:web-chat-api", async (event, method: unknown, pathSuffix: unknown, body: unknown) => {
      if (!trustedSender(event.sender.getURL())) return { status: 403, contentType: "application/json", body: '{"error":"forbidden"}' };
      const base = webAuthBaseUrl();
      if (!base || !await webSessionUser()) return { status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' };
      if (typeof method !== "string" || !["GET", "POST", "PATCH", "DELETE"].includes(method) ||
          typeof pathSuffix !== "string" || !/^\/api\/(?:sessions(?:\/[^?#]*)?|cowork\/[^?#]*|realtime-ticket|audio\/session)(?:\?[^#]*)?$/.test(pathSuffix) ||
          pathSuffix.includes("..") || (body != null && (typeof body !== "string" || body.length > 1_000_000)))
        return { status: 400, contentType: "application/json", body: '{"error":"invalid_request"}' };
      try {
        const response = await fetch(`${base}${pathSuffix}`, {
          method, headers: { cookie: await webCookieHeader(), "content-type": "application/json" },
          ...(method !== "GET" && body != null ? { body } : {}),
        });
        return { status: response.status, contentType: response.headers.get("content-type") || "application/json", body: await response.text() };
      } catch {
        return { status: 503, contentType: "application/json", body: '{"error":"unavailable"}' };
      }
    });
    ipcMain.handle("launcher:open-login", async (event, theme?: unknown) => {
      const senderUrl = event.sender.getURL();
      if (!trustedSender(senderUrl)) return { ok: false, error: `无权打开登录窗口（senderUrl: ${senderUrl}）` };
      const base = webAuthBaseUrl();
      if (!base) return { ok: false, error: `Web 登录地址未配置（APP_PUBLIC_URL=${process.env.APP_PUBLIC_URL || "未设置"}, PORT=${process.env.PORT || "3100"}）` };
      if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.show(); loginWindow.focus(); return { ok: true }; }
      // 主题：优先用渲染层传上来的 Launcher 外观（浅/深），没有则跟随系统。
      // Launcher 外观可能与系统相反（例如系统深色但选了浅色外观），登录窗要跟前一个一致。
      const dark = theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors);
      // 登录窗口：登录页自带卡片，标题栏不再显示文字——窗口标题留空，并拦住页面的
      // <title>（web 端 metadata 是 "Agent"）回写标题栏，否则页签/标题栏仍会冒出 "Agent"。
      // 底色跟随主题，避免加载瞬间闪一屏反色。
      // 尺寸按内容给：登录卡片 328px、注册态卡片 435px（+ 上下 24px 内边距、≈28px 标题栏），
      // 540 能完整容纳注册态且不空一大片；原先 680 会留出小半屏空白。
      // 部分系统 SOCKS5 配置会令打包版 Chromium 加载登录页直接 ERR_FAILED。
      // 登录窗口先尝试直连；无法直连时改用系统代理重试，不改变其他窗口的代理。
      const authSession = session.fromPartition(`launcher-auth-${randomUUID()}`);
      await authSession.setProxy({ mode: "direct" });
      const win = new BrowserWindow({
        parent: mainWindow ?? undefined, width: 500, height: 540, minWidth: 420, minHeight: 460,
        title: "", backgroundColor: dark ? "#1a1a1a" : "#f4f6fb",
        // Windows：登录窗构造时同样给定圆盘图标；macOS 由 app.dock 统一管理。
        ...(process.platform === "darwin" ? {} : { icon: resolveAppIconPath(dark) }),
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false, contextIsolation: true, sandbox: true,
          session: authSession,
          // 唯一一个挂 preload 的 web 窗口：只把「上次登录的账号（加密后的密码）」这一个能力
          // 递给登录页。Electron 不带浏览器的密码管理器，自动填充只能自己补（见 login-credentials.ts）。
          preload: path.join(__dirname, "../preload/login.js"),
        },
      });
      loginWindow = win;
      win.on("page-title-updated", (event) => { event.preventDefault(); win.setTitle(""); });
      win.on("closed", () => { if (loginWindow === win) loginWindow = null; invalidateWebSessionCache(); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("launcher:web-session-changed"); });

      // 登录窗只该停在登录页（以及 /api/auth/* 的 OAuth 往返）。登录/注册成功后服务端会
      // 跳到 next（默认 /linger，应用本体），如果放它导航，用户会看到登录窗"变成"聊天界面，
      // 而不是关掉。这里在 will-navigate / will-redirect 阶段就拦下（早于文档提交，
      // 不会先闪一帧应用 UI 再关），关窗后主窗口收到 web-session-changed 自行刷新会话。
      const baseUrl = new URL(base);
      const loginPath = `${baseUrl.pathname}/login`;
      const authApiPath = `${baseUrl.pathname}/api/auth`;
      let closing = false;
      let loginRequestSucceeded = false;
      const showLoginDiagnostic = (message: string) => {
        if (win.isDestroyed()) return;
        console.error(`[launcher login] ${message}`);
        void win.webContents.executeJavaScript(`(() => {
          const id = 'launcher-login-diagnostic';
          let box = document.getElementById(id);
          if (!box) {
            box = document.createElement('div'); box.id = id;
            Object.assign(box.style, { position: 'fixed', left: '12px', right: '12px', bottom: '12px', zIndex: '2147483647', padding: '12px', background: '#531c1c', color: '#fff', borderRadius: '8px', font: '12px/1.5 system-ui', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '35vh', overflowY: 'auto' });
            document.body.appendChild(box);
          }
          box.textContent = ${JSON.stringify(message)};
        })()`).catch(() => {});
      };
      const checkLoginBeforeClose = () => {
        if (!loginRequestSucceeded) {
          showLoginDiagnostic("登录页尝试跳转，但本次登录请求尚未成功。窗口已保留，以便查看错误。");
          return;
        }
        void authSession.cookies.get({ url: base }).then(async (cookies) => {
          const cookie = cookies.find((item) => item.name === "agent_session");
          if (!cookie) { showLoginDiagnostic("登录接口已成功，但未发现登录会话。窗口已保留。"); return; }
          await session.defaultSession.cookies.set({
            url: base, name: cookie.name, value: cookie.value,
            ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
            path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite, expirationDate: cookie.expirationDate,
          });
          invalidateWebSessionCache();
          finishLogin();
        }).catch((error) => showLoginDiagnostic(`检查登录会话失败：${String(error)}`));
      };
      const finishLogin = () => {
        if (closing || win.isDestroyed()) return;
        closing = true;
        mainWindow?.webContents.send("launcher:web-session-changed");
        win.close();
      };
      const isLoginWindowUrl = (raw: string): boolean => {
        let target: URL;
        try { target = new URL(raw); } catch { return false; }
        // 第三方 OAuth 页面（钉钉 / 飞书）先放行；回跳时会再进 /api/auth/callback
        if (target.origin !== baseUrl.origin) return true;
        return target.pathname === loginPath || target.pathname === authApiPath || target.pathname.startsWith(`${authApiPath}/`);
      };
      const guardNavigation = (navEvent: Electron.Event, url: string) => {
        if (isLoginWindowUrl(url)) return;
        navEvent.preventDefault();
        checkLoginBeforeClose();
      };
      win.webContents.on("will-navigate", guardNavigation);
      win.webContents.on("will-redirect", guardNavigation);
      win.webContents.setWindowOpenHandler(({ url }) => {
        if (!/^https?:\/\//i.test(url)) return { action: "deny" };
        // 站内新窗口链接也按"离开登录页 = 登录完成"处理，避免在登录窗里打开应用本体
        if (isLoginWindowUrl(url)) void win.loadURL(url); else checkLoginBeforeClose();
        return { action: "deny" };
      });
      // 兜底：只有离开登录页时才检查会话。打开登录页时可能仍有旧 cookie，
      // 若此时直接关闭窗口，用户只会看到页面闪一下，无法查看失败原因。
      const settle = (url: string) => {
        if (!isLoginWindowUrl(url)) { checkLoginBeforeClose(); return; }
      };
      win.webContents.on("did-navigate", (_event, url) => settle(url));
      win.webContents.on("did-navigate-in-page", (_event, url) => settle(url));
      win.webContents.on("did-fail-load", (_event, code, description, validatedURL, isMainFrame) => {
        if (code === -3) return; // 导航被主动取消
        const route = (() => { try { return new URL(validatedURL).pathname; } catch { return "未知地址"; } })();
        showLoginDiagnostic(`页面加载失败：${route}\n${description} (${code})${isMainFrame ? "" : " [子资源]"}`);
      });
      const authFilter = { urls: [`${baseUrl.origin}${authApiPath}/*`] };
      const onAuthError = (details: Electron.OnErrorOccurredListenerDetails) => {
        if (win.isDestroyed() || details.webContentsId !== win.webContents.id) return;
        const route = new URL(details.url).pathname;
        showLoginDiagnostic(`登录请求失败：${route}\n${details.error}`);
      };
      authSession.webRequest.onErrorOccurred(authFilter, onAuthError);
      authSession.webRequest.onCompleted(authFilter, (details) => {
        if (win.isDestroyed() || details.webContentsId !== win.webContents.id) return;
        const route = new URL(details.url).pathname;
        if (details.method === "POST" && route === `${authApiPath}/login` && details.statusCode >= 200 && details.statusCode < 300) loginRequestSucceeded = true;
        if (details.statusCode >= 500) showLoginDiagnostic(`登录接口返回 HTTP ${details.statusCode}：${route}`);
      });
      // ?theme= 由登录页的主题引导脚本读取，首帧前就落到 <html data-theme>，
      // 早于 CSS 绘制 —— 不会出现「先白一屏再变深色」。
      // ?providers= 把「App 自己的 AUTH_PROVIDER」带给 web 登录页，使其优先级高于
      // web 服务自身的 AUTH_PROVIDER；不传则登录页仅显示 builtin。
      //
      // Launcher 登录窗只保留「账号登录」（builtin）：飞书 / 钉钉这类第三方 OAuth 需要
      // 跳出桌面窗口去浏览器完成授权回调，在桌面端体验割裂，故在此统一剔除。
      // 即使 .env 里 AUTH_PROVIDER 配了 dingtalk / feishu，或配成 adaptive（会展开成
      // 钉钉+飞书两项），传出去的清单里也不会再出现这两个方式。
      // 剔除后为空（如原本只配了第三方登录）→ 回落 builtin，保证登录窗始终能登录。
      const appProviders = (process.env.AUTH_PROVIDER || "")
        .split(/[,|]/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s && s !== "dingtalk" && s !== "feishu" && s !== "adaptive")
        .join(",") || "builtin";
      const loginUrl = `${base}/login?theme=${dark ? "dark" : "light"}&providers=${encodeURIComponent(appProviders)}`;
      let loadError: unknown;
      try { await win.loadURL(loginUrl); }
      catch (directError) {
        console.warn("[launcher login] 直连加载失败，尝试系统代理：", directError);
        try {
          await authSession.setProxy({ mode: "system" });
          await authSession.closeAllConnections();
          await win.loadURL(loginUrl);
        } catch (proxyError) {
          loadError = `直连：${directError instanceof Error ? directError.message : String(directError)}；系统代理：${proxyError instanceof Error ? proxyError.message : String(proxyError)}`;
        }
      }
      if (loadError) {
        const message = `无法连接登录服务：${loadError}`;
        if (!win.isDestroyed()) {
          await win.loadURL(`data:text/html,${encodeURIComponent('<meta charset="utf-8"><body style="font:14px system-ui;padding:24px">登录页加载失败。请检查网络连接。</body>')}`).catch(() => {});
          showLoginDiagnostic(message);
        }
        return { ok: true };
      }
      return { ok: true };
    });

    // —— 登录窗凭据（记住上次登录的账号）——
    // 登录窗里跑的是远端 http 页面，不是本机渲染层，所以不能用 trustedSender 判权；
    // 这里改成「必须是当前登录窗的 webContents」，其它窗口/页面一律拿不到。
    const fromLoginWindow = (sender: Electron.WebContents) =>
      !!loginWindow && !loginWindow.isDestroyed() && loginWindow.webContents === sender;
    ipcMain.handle("launcher:login-credential-get", (event) =>
      (fromLoginWindow(event.sender) ? readSavedLoginCredential() : null));
    ipcMain.handle("launcher:login-credential-save", (event, payload: unknown) => {
      if (!fromLoginWindow(event.sender)) return false;
      const value = (payload ?? {}) as { username?: unknown; password?: unknown };
      const username = typeof value.username === "string" ? value.username.slice(0, 128) : "";
      const password = typeof value.password === "string" ? value.password.slice(0, 256) : "";
      return saveLoginCredential(username, password);
    });
    ipcMain.handle("launcher:login-credential-clear", (event) =>
      (fromLoginWindow(event.sender) ? clearSavedLoginCredential() : false));

    // —— 本机会话落盘（替代云端 /api/sessions、/messages）——
    ipcMain.handle("launcher:desktop-sessions", async () => {
      const user = await webSessionUser().catch(() => null);
      const owner = Buffer.from(user ? `${user.provider}:${user.unionId}` : "local:guest").toString("base64url");
      return (localChats?.list(owner) ?? [])
      .filter((item) => typeof item.id === "string")
      .map((item) => ({
        id: item.id as string,
        title: typeof item.title === "string" ? item.title : "新会话",
        lastPreview: typeof item.lastPreview === "string" ? item.lastPreview : null,
        lastAssistantText: typeof item.lastAssistantText === "string" ? item.lastAssistantText : null,
        history: (localChats?.get(owner, item.id as string)?.messages ?? [])
          .filter((message): message is { role: "user" | "assistant"; content: string } => {
            if (!message || typeof message !== "object") return false;
            const value = message as { role?: unknown; content?: unknown };
            return (value.role === "user" || value.role === "assistant") && typeof value.content === "string" && Boolean(value.content.trim());
          })
          .map((message) => ({ role: message.role, content: message.content })),
        modelId: typeof item.modelId === "string" ? item.modelId : null,
        aiUnread: item.aiUnread === true,
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
      }));
    });
    // owner = base64url("<provider>:<unionId>")，由渲染层按当前登录用户传入；
    // 主进程只认这个键，缺省/非法一律拒绝。
    ipcMain.handle("launcher:chats-list", (_event, owner: unknown) => {
      if (typeof owner === "string" && owner) lastChatOwner = owner;
      return localChats?.list(owner) ?? [];
    });
    ipcMain.handle("launcher:chats-get", (_event, payload: unknown) => {
      const value = payload as { owner?: unknown; id?: unknown } | null;
      if (typeof value?.owner === "string" && value.owner) lastChatOwner = value.owner;
      return localChats?.get(value?.owner, typeof value?.id === "string" ? value.id : "") ?? null;
    });
    // Snapshot knowledge images into the owning chat before persisting its message.
    const snapshotChatImages = (owner: unknown, sessionId: string, messages: unknown[]): unknown[] => {
      if (typeof owner !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(owner) || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return messages;
      const knowledgeRoot = process.env.LAUNCHER_KNOWLEDGE_DIR?.trim() ? path.resolve(process.env.LAUNCHER_KNOWLEDGE_DIR.trim()) : path.join(APP_HOME_DIR, "knowledge");
      let registry: Record<string, string | { path: string; sha256: string }>;
      try { registry = JSON.parse(fs.readFileSync(path.join(knowledgeRoot, "chat-images.json"), "utf8")); } catch { return messages; }
      return messages.map(message => {
        if (!message || typeof message !== "object") return message;
        const item = message as Record<string, unknown>;
        if (item.role !== "assistant" || typeof item.content !== "string") return message;
        const content = item.content.replace(/(!\[[^\]]*\]\()http:\/\/127\.0\.0\.1:\d+\/images\/([a-f0-9]{48})(\))/g, (whole, prefix: string, token: string, suffix: string) => {
          try {
            const entry = registry[token];
            if (!entry || (typeof entry !== "string" && (typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)))) return whole;
            const source = fs.realpathSync(typeof entry === "string" ? entry : entry.path);
            if (typeof entry === "string") {
              const root = fs.realpathSync(path.join(knowledgeRoot, "libraries"));
              if (!source.startsWith(root + path.sep)) return whole;
            }
            const data = fs.readFileSync(source);
            const hash = createHash("sha256").update(data).digest("hex");
            if (typeof entry !== "string" && hash !== entry.sha256) return whole;
            const ext = path.extname(source).toLowerCase();
            if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return whole;
            const directory = path.join(APP_HOME_DIR, "chats", owner, `${sessionId}.assets`);
            fs.mkdirSync(directory, { recursive: true });
            const target = path.join(directory, `${hash}${ext}`);
            if (!fs.existsSync(target)) { const temp = `${target}.${randomUUID()}.tmp`; try { fs.writeFileSync(temp, data, { mode: 0o600 }); fs.renameSync(temp, target); } finally { fs.rmSync(temp, { force: true }); } }
            return `${prefix}https://local-knowledge.invalid/v1/chat-image/${owner}/${sessionId}/${hash}${ext}${suffix}`;
          } catch { return whole; }
        });
        return content === item.content ? message : { ...item, content };
      });
    };
    ipcMain.handle("knowledge:resolveChatSnapshot", (event, owner: unknown, sessionId: unknown, name: unknown) => {
      if (!trustedSender(event.sender.getURL()) || typeof owner !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(owner) || typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId) || typeof name !== "string" || !/^[a-f0-9]{64}\.(png|jpe?g|webp)$/.test(name)) return null;
      const file = path.join(APP_HOME_DIR, "chats", owner, `${sessionId}.assets`, name);
      if (!fs.existsSync(file)) return null;
      const normalized = file.replace(/\\/g, "/");
      return `local-file://${encodeURI(normalized.startsWith("/") ? normalized : `/${normalized}`).replace(/[?#]/g, c => c === "?" ? "%3F" : "%23")}`;
    });
    ipcMain.handle("launcher:chats-save", (_event, payload: unknown) => {
      const value = payload as { owner?: unknown; id?: unknown; meta?: unknown; messages?: unknown };
      if (!value || typeof value.id !== "string" || !value.meta || typeof value.meta !== "object") return false;
      if (typeof value.owner === "string" && value.owner) lastChatOwner = value.owner;
      localChats?.save(value.owner, value.id, value.meta as Record<string, unknown>, snapshotChatImages(value.owner, value.id, Array.isArray(value.messages) ? value.messages : []));
      announceDesktopSessions();
      return true;
    });
    ipcMain.handle("launcher:chats-patch", (_event, payload: unknown) => {
      const value = payload as { owner?: unknown; id?: unknown; patch?: unknown };
      if (!value || typeof value.id !== "string" || !value.patch || typeof value.patch !== "object") return false;
      if (typeof value.owner === "string" && value.owner) lastChatOwner = value.owner;
      localChats?.patchMeta(value.owner, value.id, value.patch as Record<string, unknown>);
      announceDesktopSessions();
      return true;
    });
    ipcMain.handle("launcher:chats-remove", (_event, payload: unknown) => {
      const value = payload as { owner?: unknown; id?: unknown } | null;
      if (typeof value?.id !== "string") return false;
      if (typeof value?.owner === "string" && value.owner) lastChatOwner = value.owner;
      localChats?.remove(value.owner, value.id);
      if (typeof value.owner === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value.owner) && /^[a-zA-Z0-9_-]{1,128}$/.test(value.id)) fs.rmSync(path.join(APP_HOME_DIR, "chats", value.owner, `${value.id}.assets`), { recursive: true, force: true });
      announceDesktopSessions();
      return true;
    });

    // —— 本机文件引用（输入框「+」/拖放）：渲染层只能拿到 File，真实路径在 preload 里取，
    // 这边只负责登记成 local-ref:// 句柄；后续预览与模型读取都靠它解析回绝对路径。——
    ipcMain.handle("local:register-paths", (event, paths: unknown) => {
      if (!trustedSender(event.sender.getURL()) || !refs || !Array.isArray(paths) || paths.length > 100) return [];
      if (paths.some((item) => typeof item !== "string")) return [];
      return refs.register(paths as string[]).map((ref) => ({ id: ref.id, name: ref.name, path: ref.path, kind: ref.kind, size: ref.size, url: refs!.url(ref) }));
    });
    // 剪贴板粘贴的截图只存在于内存，没有磁盘路径 —— webUtils.getPathForFile 拿不到值，
    // 直接 register 会被丢掉。这里先把字节落盘到应用主目录 pasted-files 下，返回绝对路径，
    // 再由 preload 交给 register-paths 登记成 local-ref:// 句柄。
    ipcMain.handle("local:save-pasted-file", async (event, payload: unknown) => {
      if (!trustedSender(event.sender.getURL())) return null;
      const value = payload as { name?: unknown; data?: unknown } | null;
      const raw = typeof value?.name === "string" ? path.basename(value.name) : "";
      const bytes = value?.data instanceof Uint8Array ? value.data : null;
      if (!bytes || !bytes.length || bytes.length > 25_000_000) return null;
      const safe = (raw || "pasted-image.png").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 120) || "pasted-image.png";
      const directory = path.join(APP_HOME_DIR, "pasted-files");
      await fs.promises.mkdir(directory, { recursive: true });
      const target = path.join(directory, `${Date.now()}-${randomUUID().slice(0, 8)}-${safe}`);
      await fs.promises.writeFile(target, bytes);
      return target;
    });
    ipcMain.handle("local:list-refs", (event) => trustedSender(event.sender.getURL()) && refs
      ? refs.list().map((ref) => ({ ...ref, url: refs!.url(ref) })) : []);
    ipcMain.handle("local:reveal-ref", (event, url: unknown) => {
      if (!trustedSender(event.sender.getURL()) || typeof url !== "string") return false;
      const ref = refs?.resolve(url);
      if (!ref) return false;
      try { shell.showItemInFolder(ref.path); return true; } catch { return false; }
    });
    ipcMain.handle("local:remove-ref", (event, id: unknown) =>
      trustedSender(event.sender.getURL()) && typeof id === "string" ? refs?.remove(id) ?? false : false);
    ipcMain.handle("local:set-workspace", (event, payload: unknown) => {
      if (!trustedSender(event.sender.getURL()) || !refs) return false;
      const value = payload as { sessionId?: unknown; path?: unknown } | null;
      if (typeof value?.sessionId !== "string" || (value.path !== null && typeof value.path !== "string")) return false;
      try { refs.setWorkspace(value.sessionId, value.path as string | null); return true; } catch { return false; }
    });
    ipcMain.handle("local:workspaces", (event) => trustedSender(event.sender.getURL()) && refs ? refs.workspaceMap() : {});
    // 工作目录选择（kit 的「选择工作空间」按钮走 agentHost.pickDirectory）：弹系统目录框，
    // 选中即登记成 local-ref:// 句柄（与 local app 的 dialog:pick-directory 同口径）。
    ipcMain.handle("launcher:pick-directory", async (event, payload: unknown) => {
      if (!trustedSender(event.sender.getURL()) || !refs) return null;
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return null;
      const defaultPath = (payload as { defaultPath?: unknown } | null)?.defaultPath;
      const result = await dialog.showOpenDialog(win, {
        title: "选择工作目录",
        defaultPath: typeof defaultPath === "string" && defaultPath ? defaultPath : undefined,
        properties: ["openDirectory", "createDirectory"],
      });
      const selected = result.canceled ? null : result.filePaths[0] ?? null;
      if (selected) refs.register([selected]);
      return selected;
    });
    // 在系统文件管理器中打开一个目录（kit「打开文件夹」按钮走 agentHost.openPath）。
    ipcMain.handle("shell:open-path", async (event, payload: unknown) => {
      if (!trustedSender(event.sender.getURL()) || typeof payload !== "string" || !path.isAbsolute(payload)) {
        return { ok: false, error: "invalid path" };
      }
      const error = await shell.openPath(payload);
      return error ? { ok: false, error } : { ok: true };
    });
    // 启动器没有云端资料库：扫描/上传到资料库一律降级（只保留本机引用本身可用）。
    ipcMain.handle("local:scan-ref", () => null);
    ipcMain.handle("local:upload-ref", () => ({ uploaded: 0, failed: ["启动器不支持上传到资料库"] }));
    ipcMain.handle("local:cache-cloud-file", () => null);

    // —— 桌面「文件管理」组件（根目录 = 用户 home）——
    // 只做本机浏览/整理；路径隔离与越界校验都在 home-files.ts 里，删除一律进系统废纸篓。
    ipcMain.handle("fs:home", (event) => trustedSender(event.sender.getURL()) ? homeDir() : "");
    ipcMain.handle("fs:list", async (event, rel: unknown) => {
      if (!trustedSender(event.sender.getURL())) return [];
      try { return await listDirectory(rel); } catch { return []; }
    });
    ipcMain.handle("fs:rename", async (event, rel: unknown, name: unknown) =>
      trustedSender(event.sender.getURL()) ? renamePath(rel, name) : false);
    ipcMain.handle("fs:mkdir", async (event, rel: unknown, name: unknown) =>
      trustedSender(event.sender.getURL()) ? createDirectory(rel, name) : "error");
    ipcMain.handle("fs:move", async (event, rel: unknown, destDir: unknown) =>
      trustedSender(event.sender.getURL()) ? movePath(rel, destDir) : false);
    ipcMain.handle("fs:trash", async (event, rel: unknown) => {
      if (!trustedSender(event.sender.getURL())) return false;
      const target = trashTarget(rel);
      if (!target) return false;
      try { await shell.trashItem(target); return true; } catch { return false; }
    });
    ipcMain.handle("fs:reveal", async (event, rel: unknown) => {
      if (!trustedSender(event.sender.getURL())) return false;
      const target = trashTarget(rel);
      if (!target) return false;
      try { shell.showItemInFolder(target); return true; } catch { return false; }
    });
    // 把桌面文件管理组件里的条目登记成本机引用句柄（local-ref://）：
    // 会话消息的附件只认这个句柄，拖文件进会话前要先过这一道。
    ipcMain.handle("fs:local-ref", (event, rels: unknown) => {
      if (!trustedSender(event.sender.getURL()) || !refs || !Array.isArray(rels) || rels.length > 50) return [];
      const paths: string[] = [];
      for (const rel of rels) {
        const abs = resolveInHome(rel);
        if (abs) paths.push(abs);
      }
      if (!paths.length) return [];
      return refs.register(paths).map((ref) => ({ id: ref.id, url: refs!.url(ref), name: ref.name, size: ref.size, kind: ref.kind }));
    });

    // —— 文件系统变化监听（文件管理组件自动刷新）——
    // 渲染进程告诉主进程它正在浏览哪个目录，主进程监听那个目录的变化，
    // 有变化时发 fs:directory-changed 事件通知渲染进程刷新。
    let currentWatcher: (() => void) | null = null;
    let watcherDebounce: NodeJS.Timeout | null = null;
    ipcMain.handle("fs:watch-directory", (event, rel: unknown) => {
      if (!trustedSender(event.sender.getURL())) return false;
      // 停止旧的监听
      if (currentWatcher) {
        currentWatcher();
        currentWatcher = null;
      }
      if (watcherDebounce) {
        clearTimeout(watcherDebounce);
        watcherDebounce = null;
      }
      // 开始监听新目录
      const sender = event.sender;
      currentWatcher = watchDirectory(rel, () => {
        // 防抖：连续多次变化只触发一次（100ms 内合并）
        if (watcherDebounce) clearTimeout(watcherDebounce);
        watcherDebounce = setTimeout(() => {
          if (!sender.isDestroyed()) {
            sender.send("fs:directory-changed", rel);
          }
          watcherDebounce = null;
        }, 150);
      });
      return Boolean(currentWatcher);
    });

  }

  app.whenReady().then(async () => {
    /**
     * 实时语音转写（腾讯云 ASR）由渲染进程**直连** wss://asr.cloud.tencent.com。
     *
     * 若本机或系统配了代理，Chromium 会把 wss 也走 CONNECT —— 而多数代理不支持对外部主机的
     * wss，握手直接失败，报「无法连接腾讯云实时转写（网络不通）」。
     *
     * 关键判据：**签名 / 凭据错误不会走到这一步**。按腾讯云文档，签名校验是在 socket 建立
     * （HTTP 101 升级）之后进行的，失败会收到 {code:4002 鉴权失败} 之类的具体错误码。
     * 所以「握手就失败」基本可以断定是代理 / 网络 / 防火墙层，不是签名问题。
     *
     * 这里让 ASR 域名绕过代理直连；其余请求（web 服务、内置浏览器）仍沿用系统代理。
     * 确需强制 ASR 走代理时，设 LAUNCHER_ASR_PROXY=1 关闭此绕过。
     */
    if (process.env.LAUNCHER_ASR_PROXY !== "1") {
      try {
        session.defaultSession.setProxy({
          mode: "system",
          proxyBypassRules: "asr.cloud.tencent.com",
        });
      } catch (error) {
        console.warn("[launcher] 设置 ASR 代理绕过失败：", error);
      }
    }
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "media");
    });
    protocol.handle("local-file", async (request) => {
      try {
        let filePath = decodeURIComponent(new URL(request.url).pathname);
        // 渲染层为兼容 Windows 盘符路径会发成 "/C:/Users/a.png"（前导斜杠 + 盘符），
        // 这里归一化为 "C:/..."，否则 Node 在 Windows 上读不到。
        filePath = filePath.replace(/^\/([A-Za-z]:)/, "$1");
        const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
        if (["mp4", "m4v", "mov", "webm"].includes(ext)) {
          const size = (await fs.promises.stat(filePath)).size;
          const range = request.headers.get("range");
          const match = range?.match(/^bytes=(\d*)-(\d*)$/);
          if (range && (!match || (!match[1] && !match[2]))) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
          const start = match ? (match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))) : 0;
          const end = match && match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
          if (start >= size || end < start) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
          const headers: Record<string, string> = { "Content-Type": ext === "webm" ? "video/webm" : ext === "mov" ? "video/quicktime" : "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "no-store", "Content-Length": String(end - start + 1) };
          if (match) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
          // Delegate disk reads to Chromium's native file loader. It handles
          // cancelled/restarted media reads and seeks without bridging a Node
          // Readable stream into Electron's custom-protocol response.
          const fileHeaders = new Headers();
          if (match) fileHeaders.set("Range", `bytes=${start}-${end}`);
          const fileResponse = await net.fetch(pathToFileURL(filePath).toString(), { headers: fileHeaders });
          if (!fileResponse.ok || !fileResponse.body) throw new Error(`无法读取视频：${fileResponse.status}`);
          return new Response(fileResponse.body, { status: match ? 206 : 200, headers });
        }
        const data = await fs.promises.readFile(filePath);
        const type =
          // 文件管理组件的预览要按真实类型给 content-type：给成 octet-stream 时浏览器
          // 不认图片/文本/PDF，只会弹下载或渲染空白。
          ext === "png" ? "image/png"
          : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
          : ext === "webp" ? "image/webp"
          : ext === "gif" ? "image/gif"
          : ext === "svg" ? "image/svg+xml"
          : ext === "avif" ? "image/avif"
          : ext === "bmp" ? "image/bmp"
          : ext === "pdf" ? "application/pdf"
          : ext === "mp4" || ext === "m4v" ? "video/mp4"
          : ext === "webm" ? "video/webm"
          : ext === "mov" ? "video/quicktime"
          : ext === "mp3" ? "audio/mpeg"
          : ext === "wav" ? "audio/wav"
          : ext === "m4a" ? "audio/mp4"
          : ext === "ogg" ? "audio/ogg"
          : ext === "txt" || ext === "md" || ext === "markdown" || ext === "log" ? "text/plain; charset=utf-8"
          : ext === "json" ? "application/json; charset=utf-8"
          : ext === "csv" ? "text/csv; charset=utf-8"
          : ext === "html" || ext === "htm" ? "text/html; charset=utf-8"
          : ext === "css" ? "text/css; charset=utf-8"
          : ext === "js" || ext === "mjs" || ext === "ts" || ext === "tsx" || ext === "jsx" ? "text/plain; charset=utf-8"
          : "application/octet-stream";
        return new Response(data, { headers: { "content-type": type } });
      } catch {
        return new Response("Not Found", { status: 404 });
      }
    });

    const userDataDir = app.getPath("userData");
    const storeFile = path.join(userDataDir, "agentos-launcher.json");
    LauncherStore.init(storeFile);
    // Prewarm in the background; the composer must never wait for these probes.
    void listComputeProviders().catch(() => {});
    // 本机会话落盘 + 本地 Agent 服务（AgentWindow 的 chat/artifact 端点）
    localChats = new LocalChatStore(path.join(APP_HOME_DIR, "chats"));
    // 本机文件引用表：与 local app 同布局（local-references.json 落在 userData）。
    refs = new LocalReferenceStore(userDataDir);
    const localAgent = await startLocalAgentServer(path.join(APP_HOME_DIR, "artifacts"), refs, {
      onProviderUnavailable: (provider) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send("launcher:compute-providers-changed", provider);
        }
      },
      // auto-title 端点生成标题成功后回写本机会话存储：侧边栏/重启后都显示 LLM 标题。
      onAutoTitle: (sid, title, owner) => { const targetOwner = owner ?? lastChatOwner; if (targetOwner) { localChats?.rename(targetOwner, sid, title); announceDesktopSessions(); } },
    });
    localAgentUrl = localAgent.url;
    app.on("before-quit", () => { localChats?.flushAll(); void localAgent.close(); });
    // 本地知识库：初始化 SQLite 存储 + 索引调度 + 检索引擎，注册 knowledge:* IPC
    const knowledgeModule = registerKnowledgeBase(APP_HOME_DIR);
    app.on("before-quit", () => knowledgeModule.destroy());
    registerIpc();
    // Windows 通知归属：没有稳定的 AppUserModelId 时，通知可能不显示或点击无法回到应用。
    if (process.platform === "win32") app.setAppUserModelId(app.isPackaged ? APP_BUNDLE_ID : `${APP_BUNDLE_ID}.dev`);
    // Windows 下移除默认菜单栏，避免窗口顶部出现 File/Edit 等菜单
    Menu.setApplicationMenu(null);
    createWindow();

    // models.json 变更监视：用户运行期手改配置（新拉了模型、加了条目）后，
    // 不重启也能让输入框里的模型下拉刷新。启动时先比一次上次记录，变化了只写日志
    // —— 此刻的列表本来就会按最新文件加载，不需要再推一次事件。
    const beforeWatch = modelsFileStatus();
    if (beforeWatch.record && beforeWatch.changed) {
      console.log(`[launcher] models.json 自上次加载后已更新（记录于 ${beforeWatch.record.seenAt ?? "未知"}），模型列表按最新文件加载`);
    }
    const stopModelsWatch = watchModelsFile((next) => {
      console.log(`[launcher] models.json 已更新：${next.mtimeMs ? new Date(next.mtimeMs).toISOString() : "时间未知"}，通知渲染层刷新模型列表`);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("launcher:models-file-changed");
    });
    app.on("before-quit", stopModelsWatch);

    // OTA 自动更新：连接 Web 服务的 /linger/api/updates 通道（appId=launcher）
    // 启动 3 秒后首次检查，之后每小时检查一次；有新版本自动下载到临时目录。
    try {
      const webBase = webAuthBaseUrl();
      if (webBase && mainWindow) {
        // 注意：OtaClient 用 new URL("api/updates", base) 拼路径，base 必须以 / 结尾
        // 否则 "agent" 会被替换成 "api"，导致请求打到 /api/updates 而非 /linger/api/updates。
        const otaBase = new URL(webBase);
        if (!otaBase.pathname.endsWith("/")) otaBase.pathname += "/";
        const updater = createLauncherUpdater(otaBase, mainWindow);
        ipcMain.handle("update:status", () => updater.status());
        ipcMain.handle("update:check", () => updater.check());
        ipcMain.handle("update:install", async () => {
          try {
            const result = await updater.install();
            if (!result.ok) console.error("[launcher] 更新安装失败:", result.error);
            return result;
          } catch (e) {
            console.error("[launcher] 更新安装异常:", e);
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        });
        const autoCheck = () => void updater.check().catch((e) => console.error("[launcher] 自动检查更新失败:", e));
        const firstCheck = setTimeout(autoCheck, 3000);
        const hourlyCheck = setInterval(autoCheck, 60 * 60 * 1000);
        app.once("before-quit", () => { clearTimeout(firstCheck); clearInterval(hourlyCheck); });
      }
    } catch (e) {
      console.error("[launcher] OTA 更新初始化失败:", e);
    }

    // 启动即按当前系统外观设一次图标；之后系统深浅色切换时实时跟随。
    applyAppIcon();
    nativeTheme.on("updated", applyAppIcon);

    // 状态栏的系统数据（电量 / Wi-Fi / 输入法）：长驻一个原生采集器，变化了才推一行，
    // 渲染层只负责画。采集器起不来会自动退回命令行采集，见 system-status.ts。
    const stopSystemStatus = startSystemStatusWatch((status) => {
      const win = mainWindow;
      if (win && !win.isDestroyed()) win.webContents.send("launcher:system-status-changed", status);
    });
    app.on("before-quit", stopSystemStatus);
    // 退出时一定要把电源断言还给系统：否则进程没了、休眠策略还挂在「保持唤醒」上。
    app.on("before-quit", releaseKeepAwake);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
