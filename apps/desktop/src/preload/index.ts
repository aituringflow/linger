import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { CodexRuntimeState, LauncherApi, LauncherComputeProvider, LauncherDesktopSession, LauncherFsEntry, LauncherLocalRef, LauncherNotificationOpen, LauncherState, LauncherSystemStatus } from "../shared/types";

/**
 * 通知点击可能在 React 还没挂上监听时就到达（刚启动就点通知）：
 * 在 preload 阶段先接住并缓存，等渲染层订阅时再补发，避免这次跳转石沉大海。
 */
const notificationOpenListeners = new Set<(payload: LauncherNotificationOpen) => void>();
const notificationOpenBuffer: LauncherNotificationOpen[] = [];
ipcRenderer.on("launcher:notification-open", (_event, payload: LauncherNotificationOpen) => {
  if (!payload || typeof payload.windowId !== "string" || typeof payload.sessionId !== "string") return;
  if (notificationOpenListeners.size === 0) {
    notificationOpenBuffer.push(payload);
    if (notificationOpenBuffer.length > 10) notificationOpenBuffer.shift();
    return;
  }
  for (const listener of notificationOpenListeners) listener(payload);
});

const api: LauncherApi = {
  getState: () => ipcRenderer.invoke("launcher:get-state") as Promise<LauncherState>,
  saveState: (state: LauncherState) =>
    ipcRenderer.invoke("launcher:save-state", state) as Promise<{ ok: boolean; error?: string }>,
  listDesktopSessions: () => ipcRenderer.invoke("launcher:desktop-sessions") as Promise<LauncherDesktopSession[]>,
  onDesktopSessionsChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("launcher:desktop-sessions-changed", handler);
    return () => ipcRenderer.removeListener("launcher:desktop-sessions-changed", handler);
  },
  pickWallpaperImage: () =>
    ipcRenderer.invoke("launcher:pick-wallpaper-image") as Promise<string | null>,
  openExternal: (url: string) => ipcRenderer.invoke("launcher:open-external", url) as Promise<void>,
  openWechatPoc: (theme) => ipcRenderer.invoke("launcher:open-wechat-poc", theme) as Promise<{ ok: boolean; error?: string }>,
  toggleWechatPoc: (theme, usePress) => ipcRenderer.invoke("launcher:toggle-wechat-poc", theme, usePress) as Promise<{ ok: boolean; foreground: boolean; error?: string }>,
  beginWechatDockPress: () => ipcRenderer.send("launcher:wechat-dock-press"),
  cancelWechatDockPress: () => ipcRenderer.send("launcher:wechat-dock-press-cancel"),
  noteLauncherInteraction: () => ipcRenderer.send("launcher:wechat-launcher-interaction"),
  closeWechatPoc: () => ipcRenderer.invoke("launcher:close-wechat-poc") as Promise<void>,
  bringHomeForward: () => ipcRenderer.invoke("launcher:bring-home-forward") as Promise<void>,
  onWechatPocClosed: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("launcher:wechat-poc-closed", handler);
    return () => ipcRenderer.removeListener("launcher:wechat-poc-closed", handler);
  },
  listModels: () => ipcRenderer.invoke("launcher:list-models"),
  getModelsFileStatus: () => ipcRenderer.invoke("launcher:models-file-status") as ReturnType<LauncherApi["getModelsFileStatus"]>,
  onModelsFileChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("launcher:models-file-changed", handler);
    return () => ipcRenderer.removeListener("launcher:models-file-changed", handler);
  },
  listCodexModels: () => ipcRenderer.invoke("launcher:list-codex-models"),
  listDshModels: () => ipcRenderer.invoke("launcher:list-dsh-models"),
  transcribeVoice: (audio, mimeType, fileName) => ipcRenderer.invoke("launcher:transcribe-voice", audio, mimeType, fileName),
  chatSend: (sessionId, messages, model) => ipcRenderer.invoke("launcher:chat-send", sessionId, messages, model),
  chatTitle: (firstMessage, model) => ipcRenderer.invoke("launcher:chat-title", firstMessage, model),
  getAgentHost: () => ipcRenderer.invoke("launcher:agent-host") as Promise<{ url: string }>,
  getWebAuth: () => ipcRenderer.invoke("launcher:web-auth") as Promise<{ url: string } | null>,
  getWebSession: () => ipcRenderer.invoke("launcher:web-session") as ReturnType<LauncherApi["getWebSession"]>,
  updateProfile: (patch) => ipcRenderer.invoke("launcher:update-profile", patch) as ReturnType<LauncherApi["updateProfile"]>,
  logoutWebSession: () => ipcRenderer.invoke("launcher:web-logout") as ReturnType<LauncherApi["logoutWebSession"]>,
  deleteWebSession: () => ipcRenderer.invoke("launcher:web-delete-account") as ReturnType<LauncherApi["deleteWebSession"]>,
  getDomainTicket: () => ipcRenderer.invoke("launcher:domain-ticket") as Promise<string | null>,
  contactsApi: (method, path, body) => ipcRenderer.invoke("launcher:contacts-api", method, path, body) as ReturnType<LauncherApi["contactsApi"]>,
  webChatApi: (method, path, body) => ipcRenderer.invoke("launcher:web-chat-api", method, path, body) as ReturnType<LauncherApi["webChatApi"]>,
  openLogin: (theme) => ipcRenderer.invoke("launcher:open-login", theme) as ReturnType<LauncherApi["openLogin"]>,
  onWebSessionChanged: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("launcher:web-session-changed", handler);
    return () => ipcRenderer.removeListener("launcher:web-session-changed", handler);
  },
  showNotification: (payload) => ipcRenderer.invoke("launcher:notification-show", payload) as Promise<boolean>,
  setUnreadBadge: (count: number) => { ipcRenderer.send("launcher:set-unread-badge", count); },
  onNotificationOpen: (listener) => {
    notificationOpenListeners.add(listener);
    // 补发订阅前到达的点击（例如冷启动时点了通知）。
    while (notificationOpenBuffer.length) {
      const pending = notificationOpenBuffer.shift();
      if (pending) listener(pending);
    }
    return () => { notificationOpenListeners.delete(listener); };
  },
  getAppInfo: () => ipcRenderer.invoke("launcher:app-info") as ReturnType<LauncherApi["getAppInfo"]>,
  getSystemStatus: () => ipcRenderer.invoke("launcher:system-status") as Promise<LauncherSystemStatus>,
  onSystemStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: LauncherSystemStatus) => listener(status);
    ipcRenderer.on("launcher:system-status-changed", handler);
    return () => { ipcRenderer.removeListener("launcher:system-status-changed", handler); };
  },
  isFullscreen: () => ipcRenderer.invoke("launcher:is-fullscreen") as Promise<boolean>,
  // 「有任务运行时保持唤醒」：把「开关开着 && 有任务在跑」推给主进程申请 / 释放电源断言。
  setKeepAwake: (active: boolean) => ipcRenderer.invoke("launcher:keep-awake", active) as Promise<boolean>,
  onFullscreenChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, fullscreen: boolean) => listener(fullscreen);
    ipcRenderer.on("launcher:fullscreen-changed", handler);
    return () => { ipcRenderer.removeListener("launcher:fullscreen-changed", handler); };
  },
  platform: process.platform,
  // 桌面「文件管理」组件：主进程只认相对 home 的 rel 路径，绝对路径不落到渲染层。
  getHomeDir: () => ipcRenderer.invoke("fs:home") as Promise<string>,
  listDirectory: (rel: string) => ipcRenderer.invoke("fs:list", rel) as Promise<LauncherFsEntry[] | null>,
  renamePath: (rel: string, name: string) => ipcRenderer.invoke("fs:rename", rel, name) as Promise<boolean>,
  createDirectory: (rel: string, name: string) => ipcRenderer.invoke("fs:mkdir", rel, name) as Promise<"ok" | "exists" | "error">,
  movePath: (rel: string, destDir: string) => ipcRenderer.invoke("fs:move", rel, destDir) as Promise<boolean>,
  trashPath: (rel: string) => ipcRenderer.invoke("fs:trash", rel) as Promise<boolean>,
  revealPath: (rel: string) => ipcRenderer.invoke("fs:reveal", rel) as Promise<boolean>,
  registerLocalRefs: (rels: string[]) => ipcRenderer.invoke("fs:local-ref", rels) as Promise<LauncherLocalRef[]>,
  // 文件系统变化监听：设置要监听的目录，目录变化时触发回调
  watchDirectory: (rel: string) => ipcRenderer.invoke("fs:watch-directory", rel) as Promise<boolean>,
  onDirectoryChanged: (handler: (rel: string) => void) => {
    const listener = (_event: unknown, rel: string) => handler(rel);
    ipcRenderer.on("fs:directory-changed", listener);
    return () => { ipcRenderer.removeListener("fs:directory-changed", listener); };
  },
  // 算力提供商：登录态由主进程用 CodeBuddy SDK 探测，登录走系统浏览器授权。
  getComputeProviders: (force) => ipcRenderer.invoke("launcher:compute-providers", force === true) as Promise<LauncherComputeProvider[]>,
  loginComputeProvider: (id) => ipcRenderer.invoke("launcher:compute-login", id) as ReturnType<LauncherApi["loginComputeProvider"]>,
  logoutComputeProvider: (id) => ipcRenderer.invoke("launcher:compute-logout", id) as ReturnType<LauncherApi["logoutComputeProvider"]>,
  saveDshKey: (key) => ipcRenderer.invoke("launcher:dsh-save-key", key),
  deleteDshKey: () => ipcRenderer.invoke("launcher:dsh-delete-key"),
  // Codex CLI 平台包不打进安装包：首次启用时按需下载（压缩包约 157MB / 解开 437MB）。
  getCodexRuntime: () => ipcRenderer.invoke("launcher:codex-runtime") as Promise<CodexRuntimeState>,
  installCodexRuntime: () => ipcRenderer.invoke("launcher:codex-runtime-install") as ReturnType<LauncherApi["installCodexRuntime"]>,
  onCodexRuntimeState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, next: CodexRuntimeState) => listener(next);
    ipcRenderer.on("launcher:codex-runtime-state", handler);
    return () => { ipcRenderer.removeListener("launcher:codex-runtime-state", handler); };
  },
  // office→PDF 预览引擎（LibreOfficeKit）同样不打进安装包：解开约 184MB，
  // 启动后空闲时静默补齐，也可以从这里立刻触发。
  getLibreOfficeRuntime: () => ipcRenderer.invoke("launcher:libreoffice-runtime") as Promise<{ installed: boolean }>,
  installLibreOfficeRuntime: () => ipcRenderer.invoke("launcher:libreoffice-runtime-install") as ReturnType<LauncherApi["installLibreOfficeRuntime"]>,
  onComputeProvidersChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, provider?: "workbuddy" | "codex" | "dsh") => listener(provider);
    ipcRenderer.on("launcher:compute-providers-changed", handler);
    return () => { ipcRenderer.removeListener("launcher:compute-providers-changed", handler); };
  },
  updater: {
    status: () => ipcRenderer.invoke("update:status"),
    check: () => ipcRenderer.invoke("update:check"),
    install: () => ipcRenderer.invoke("update:install"),
    onAvailable: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, release: unknown) => listener(release as { version: string; filename: string; size: number } | null);
      ipcRenderer.on("update:available", handler);
      return () => { ipcRenderer.removeListener("update:available", handler); };
    },
    onDownloadState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: { phase: string; downloaded: number; total: number; error?: string }) => listener(state);
      ipcRenderer.on("update:download-state", handler);
      return () => { ipcRenderer.removeListener("update:download-state", handler); };
    },
  },
  knowledge: {
    listLibraries: () => ipcRenderer.invoke("knowledge:listLibraries"),
    listLibrariesStats: () => ipcRenderer.invoke("knowledge:listLibrariesStats"),
    createLibrary: (name) => ipcRenderer.invoke("knowledge:createLibrary", name),
    selectLibrary: (id) => ipcRenderer.invoke("knowledge:selectLibrary", id),
    updateLibrary: (id, changes) => ipcRenderer.invoke("knowledge:updateLibrary", id, changes),
    deleteLibrary: (id) => ipcRenderer.invoke("knowledge:deleteLibrary", id),
    pickFolder: () => ipcRenderer.invoke("knowledge:pickFolder") as Promise<string | null>,
    addFolder: (folderPath: string) => ipcRenderer.invoke("knowledge:addFolder", folderPath) as Promise<{ ok: boolean; error?: string }>,
    removeFolder: (folderPath: string) => ipcRenderer.invoke("knowledge:removeFolder", folderPath) as Promise<{ ok: boolean }>,
    listFolders: () => ipcRenderer.invoke("knowledge:listFolders") as Promise<Array<{ path: string; addedAt: string }>>,
    setFolder: (folderPath) => ipcRenderer.invoke("knowledge:setFolder", folderPath),
    setPaused: (paused: boolean) => ipcRenderer.invoke("knowledge:setPaused", paused) as Promise<{ ok: boolean }>,
    videoSource: (filePath, convert) => ipcRenderer.invoke("knowledge:videoSource", filePath, convert),
    prepareVideoPreview: (filePath) => ipcRenderer.invoke("knowledge:prepareVideoPreview", filePath),
    revealDocument: (libraryId, chunkId, hash) => ipcRenderer.invoke("knowledge:revealDocument", libraryId, chunkId, hash),
    resolveChatSnapshot: (owner, sessionId, name) => ipcRenderer.invoke("knowledge:resolveChatSnapshot", owner, sessionId, name),
    resolveChatImage: (id) => ipcRenderer.invoke("knowledge:resolveChatImage", id),
    chatVideo: (libraryId, chunkId, hash, startMs, endMs, kind) => ipcRenderer.invoke("knowledge:chatVideo", libraryId, chunkId, hash, startMs, endMs, kind),
    videoThumbnail: (chunkId) => ipcRenderer.invoke("knowledge:videoThumbnail", chunkId),
    excludeFile: (fileId) => ipcRenderer.invoke("knowledge:excludeFile", fileId),
    trashFile: (fileId: number) => ipcRenderer.invoke("knowledge:trashFile", fileId) as Promise<{ ok: boolean }>,
    getFileChunks: (fileId) => ipcRenderer.invoke("knowledge:getFileChunks", fileId),
    listModels: () => ipcRenderer.invoke("knowledge:listModels"),
    openModelFolder: (model) => ipcRenderer.invoke("knowledge:openModelFolder", model),
    getModelStatus: (model) => ipcRenderer.invoke("knowledge:getModelStatus", model),
    downloadModel: (model) => ipcRenderer.invoke("knowledge:downloadModel", model),
    onModelStatus: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: import("../shared/types").KnowledgeModelStatus) => listener(state);
      ipcRenderer.on("knowledge:modelState", handler);
      return () => { ipcRenderer.removeListener("knowledge:modelState", handler); };
    },
    listFiles: (offset) => ipcRenderer.invoke("knowledge:listFiles", offset) as Promise<Array<{ id: number; path: string; title: string; type: string; status: string; size: number; chunkCount: number; error?: string | null; dateTakenMs?: number | null; mtimeMs: number; camera?: string | null; lat?: number | null; lon?: number | null }>>,
    queryFiles: (query) => ipcRenderer.invoke("knowledge:queryFiles", query) as Promise<import("../shared/types").KnowledgeFilePage>,
    fileThumbnails: (fileIds: number[]) => ipcRenderer.invoke("knowledge:fileThumbnails", fileIds) as Promise<Array<{ fileId: number; path: string }>>,
    chunkThumbnails: (chunkIds: number[]) => ipcRenderer.invoke("knowledge:chunkThumbnails", chunkIds) as Promise<Array<{ chunkId: number; path: string }>>,
    stats: () => ipcRenderer.invoke("knowledge:stats") as Promise<import("../shared/types").KnowledgeStats>,
    getSettings: () => ipcRenderer.invoke("knowledge:settings:get") as Promise<import("../shared/types").KnowledgeSettings>,
    saveSettings: (patch) => ipcRenderer.invoke("knowledge:settings:save", patch) as Promise<import("../shared/types").KnowledgeSettings>,
    listImageModels: () => ipcRenderer.invoke("knowledge:image-models") as Promise<import("../shared/types").KnowledgeFrameworkModels[]>,
    getProgress: () => ipcRenderer.invoke("knowledge:getProgress") as Promise<import("../shared/types").KnowledgeIndexProgress>,
    reindex: () => ipcRenderer.invoke("knowledge:reindex") as Promise<{ ok: boolean }>,
    reindexFile: (fileId: number) => ipcRenderer.invoke("knowledge:reindexFile", fileId) as Promise<{ ok: boolean }>,
    clearAll: () => ipcRenderer.invoke("knowledge:clearAll") as Promise<{ ok: boolean; files: number; chunks: number }>,
    openFile: (filePath: string) => ipcRenderer.invoke("knowledge:openFile", filePath) as Promise<{ ok: boolean; error?: string }>,
    search: (query, options) => ipcRenderer.invoke("knowledge:search", query, options) as Promise<import("../shared/types").KnowledgeSearchResult[]>,
    searchAudio: (audio: Float32Array, options) => ipcRenderer.invoke("knowledge:searchAudio", audio, options) as Promise<import("../shared/types").KnowledgeSearchResult[]>,
    onProgress: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, p: import("../shared/types").KnowledgeIndexProgress) => listener(p);
      ipcRenderer.on("knowledge:progress", handler);
      return () => { ipcRenderer.removeListener("knowledge:progress", handler); };
    },
    onChunkStage: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, e: import("../shared/types").KnowledgeChunkStageEvent) => listener(e);
      ipcRenderer.on("knowledge:chunkStage", handler);
      return () => { ipcRenderer.removeListener("knowledge:chunkStage", handler); };
    },
  },
};

contextBridge.exposeInMainWorld("launcher", api);

// kit AgentWindow/AgentApp 的宿主桥：本机会话落盘（localChat）+ 本机文件引用（localFiles）
// + 本地 Agent 服务地址。截图/工作区选择等桥暂未接入（渲染层相应能力自动降级）。
const agentHost = {
  clipboard: {
    writeText: (text: string) => ipcRenderer.invoke("agent:clipboard-write", text),
  },
  localChat: {
    list: (owner: string) => ipcRenderer.invoke("launcher:chats-list", owner) as Promise<Record<string, unknown>[]>,
    get: (owner: string, id: string) => ipcRenderer.invoke("launcher:chats-get", { owner, id }) as Promise<{ meta: Record<string, unknown>; messages: unknown[]; updatedAt: string } | null>,
    save: (owner: string, id: string, meta: Record<string, unknown>, messages: unknown[]) => ipcRenderer.invoke("launcher:chats-save", { owner, id, meta, messages }) as Promise<boolean>,
    patch: (owner: string, id: string, patch: Record<string, unknown>) => ipcRenderer.invoke("launcher:chats-patch", { owner, id, patch }) as Promise<boolean>,
    remove: (owner: string, id: string) => ipcRenderer.invoke("launcher:chats-remove", { owner, id }) as Promise<boolean>,
  },
  /**
   * 本机文件引用：渲染层选中的 File 在内核里拿不到绝对路径，webUtils 取出真实路径后
   * 由主进程登记成 local-ref:// 句柄。附件、预览、模型读取全都走这个句柄。
   */
  localFiles: {
    register: async (files: File[]) => {
      const paths: string[] = [];
      for (const file of files) {
        let target = "";
        try { target = webUtils.getPathForFile(file); } catch { target = ""; }
        // 剪贴板粘贴的截图只存在于内存，没有磁盘路径：先交给主进程落盘，拿到绝对路径。
        if (!target) {
          const buffer = await file.arrayBuffer();
          target = (await ipcRenderer.invoke("local:save-pasted-file", {
            name: file.name || `pasted-image-${Date.now()}.png`,
            data: new Uint8Array(buffer),
          })) as string;
        }
        if (target) paths.push(target);
      }
      return ipcRenderer.invoke("local:register-paths", paths) as Promise<Array<{ id: string; name: string; path: string; kind: "file" | "folder"; size: number; url: string }>>;
    },
    list: () => ipcRenderer.invoke("local:list-refs") as Promise<Array<{ id: string; name: string; kind: "file" | "folder"; size: number; url: string; available: boolean; sourceFileId?: string }>>,
    reveal: (url: string) => ipcRenderer.invoke("local:reveal-ref", url) as Promise<boolean>,
    remove: (id: string) => ipcRenderer.invoke("local:remove-ref", id) as Promise<boolean>,
    setWorkspace: (sessionId: string, path: string | null) => ipcRenderer.invoke("local:set-workspace", { sessionId, path }) as Promise<boolean>,
    workspaces: () => ipcRenderer.invoke("local:workspaces") as Promise<Record<string, string>>,
    scan: (id: string) => ipcRenderer.invoke("local:scan-ref", id) as Promise<{ count?: number; bytes?: number; oversized?: number; error?: string } | null>,
    upload: (id: string) => ipcRenderer.invoke("local:upload-ref", id) as Promise<{ uploaded: number; failed: string[] }>,
    onUploadProgress: (listener: (value: { id: string; current: number; total: number }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, value: { id: string; current: number; total: number }) => listener(value);
      ipcRenderer.on("local:upload-progress", handler);
      return () => ipcRenderer.removeListener("local:upload-progress", handler);
    },
    cacheCloudFile: (fileId: string, name: string) => ipcRenderer.invoke("local:cache-cloud-file", { fileId, name }) as Promise<{ id: string; name: string; kind: "file"; size: number; url: string } | null>,
  },
  /** 弹系统目录选择框，返回绝对路径；取消返回 null（kit 的 canPickWorkspace 据此启用工作目录按钮）。 */
  pickDirectory: (defaultPath?: string) =>
    ipcRenderer.invoke("launcher:pick-directory", { defaultPath }) as Promise<string | null>,
  /** 在系统文件管理器中打开路径（kit「打开文件夹」按钮）。 */
  openPath: (path: string) => ipcRenderer.invoke("shell:open-path", path) as Promise<{ ok: boolean; error?: string }>,
  /**
   * 自定义模型：读写应用主目录的 models.json（`~/.linger/models.json`）。
   * list 返回 { path, models }（models 已剔除 apiKey、附加 hasApiKey）；
   * save 接收整个模型对象（originalId 标记改名前的 id，apiKey 留空表示沿用旧密钥）；
   * delete 按 id 移除。
   */
  models: {
    list: () => ipcRenderer.invoke("launcher:models:list") as Promise<{ path: string; models: Record<string, unknown>[] }>,
    save: (model: Record<string, unknown>) => ipcRenderer.invoke("launcher:models:save", model) as Promise<boolean>,
    delete: (id: string) => ipcRenderer.invoke("launcher:models:delete", id) as Promise<boolean>,
  },
} as const;

contextBridge.exposeInMainWorld("agentHost", agentHost);
