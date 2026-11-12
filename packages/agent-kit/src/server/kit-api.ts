/**
 * 统一 API 路由工厂：一个 catch-all 文件挂载 agent-kit 的全部 HTTP 端点。
 *
 * 集成方只需建一个文件 app/api/[...path]/route.js：
 *   import { createAgentKitApi } from "agent-kit";
 *   export const runtime = "nodejs";
 *   export const dynamic = "force-dynamic";
 *   export const { GET, POST, PATCH, DELETE } = createAgentKitApi({
 *     agent: { chat: { allowBash: false } },
 *   });
 *
 * 内部复用现有端点工厂（createAgentApiRoute / createSessionHandlers /
 * createShareHandlers / createLoginHandlers），按 [方法, 路径段] 分发；
 * 未知路径 → 404，未导出的方法 → 由 Next 自动 405。
 * 以后 kit 新增任何端点只改 agent-kit，应用端零改动。
 */
import { getCompanyContacts, searchOaContacts } from "./contacts.js";
import { createAgentApiRoute } from "./handlers.js";
import type { AgentKitHandlersOptions } from "./handlers.js";
import { createSessionHandlers } from "./sessions.js";
import { createShareHandlers } from "./share.js";
import { createLoginHandlers } from "./auth/handlers.js";
import { loadAuthConfig } from "./auth/config.js";
import type { LoginHandlersOptions } from "./auth/handlers.js";
import { createUserFilesHandlers } from "./user-files.js";
import { createFileHandlers } from "./library.js";
import { createMemoryHandlers } from "./memory.js";
import { getCodeBuddyModelGroups, mergeCodeBuddyModels, getModelOptions, getDefaultModel, isModelSelectEnabled, isCustomModelOnly } from "./model-sources.js";
import { getConfiguredAgentModes, resolveAgentMode } from "./agent-runtime.js";
import { fetchCodexModelOptions, getCodexModelOptions } from "./codex-models.js";
import { createCoworkHandlers } from "./cowork.js";
import { createPromptEnhanceHandler } from "./prompt-enhance.js";
import { createLinkPreviewHandler } from "./link-preview.js";
import { issueRealtimeTicket } from "./realtime-ticket.js";
import { contactsDomainApi } from "./contacts-domain.js";
import { webPushApi } from "./web-push.js";
import { serveServiceWorker } from "./sw.js";
import { getSettings, adminGetSettings, adminSaveSettings } from "./admin-settings.js";
import { adminComponentsList, adminComponentInstall, adminComponentJob } from "./deployment-health.js";
import { serveNotificationSound } from "./notification-sounds.js";
import { createAudioSessionHandler } from "./audio-session.js";

export interface AgentKitApiOptions {
  /** 透传给对话 / 上传 / 语音端点工厂（含 allowBash、fallbackModel、userResolver 等） */
  agent?: AgentKitHandlersOptions;
  /** 透传给认证端点工厂（覆盖 env 读取的认证配置） */
  login?: LoginHandlersOptions;
}

/** Next.js 路由上下文（params 在 Next 15 为 Promise，需兼容） */
interface KitRouteContext {
  params?: { path?: string[] } | Promise<{ path?: string[] }>;
}

const METHOD_NOT_ALLOWED = () => Response.json({ error: "method_not_allowed" }, { status: 405 });

const SUPPORTED =
  "/api/chat、/api/chat/answer、/api/chat/steer、/api/chat/browser-answer、/api/upload、" +
  "/api/voice/token、/api/voice/transcribe、/api/artifact、/api/file、/api/files、/api/memories、" +
  "/api/sessions(+子资源，含 /api/sessions/search)、/api/cowork/:id/(state|send|reaction|settings)、/api/models/list、/api/models/context、" +
  "/api/share(+token)、/api/shares/file/[fileId]、/api/auth/*、" +
  "/api/user-files(+raw/mkdir/rename)、/api/contacts、/api/contacts/search、/api/domain/contacts、/api/prompt-enhance、/api/link-preview、/api/notification-sounds/:name、/api/health";

export function createAgentKitApi(options: AgentKitApiOptions = {}) {
  // 复用现有端点工厂，不重写任何业务逻辑
  const agentRoute = createAgentApiRoute(options.agent ?? {});
  const cowork = createCoworkHandlers(agentRoute);
  const session = createSessionHandlers();
  // 认证配置可能由宿主在模块初始化后补齐；首次请求时再读取 env。
  let share: ReturnType<typeof createShareHandlers> | undefined;
  let login: ReturnType<typeof createLoginHandlers> | undefined;
  const getShare = () => (share ??= createShareHandlers(cowork.send));
  const getLogin = () => (login ??= createLoginHandlers(options.login));
  const userFiles = createUserFilesHandlers();
  const fileApi = createFileHandlers();
  const memory = createMemoryHandlers();
  const promptEnhance = createPromptEnhanceHandler();
  const linkPreview = createLinkPreviewHandler();
  const audioSession = createAudioSessionHandler();

  const notFound = (detail: string) =>
    Response.json({ error: `未找到该端点（${detail}）。agent-kit 支持：${SUPPORTED}` }, { status: 404 });

  async function dispatch(method: string, request: Request, context: KitRouteContext = {}) {
    const raw = (await Promise.resolve(context.params ?? {})) as { path?: string[] };
    const segments = raw.path ?? [];
    const [a, b, c, d] = segments;
    if (a === "health" && !b && method === "GET") {
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (a === "notification-sounds" && b && !c && method === "GET") {
      return serveNotificationSound(b.endsWith(".wav") ? b.slice(0, -4) : "");
    }
    if (a === "public-preview" && b && ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) {
      return cowork.publicPreview(request, b, segments.slice(2));
    }
    if (a === "realtime-ticket" && !b && method === "GET") return issueRealtimeTicket(request);
    if (a === "domain" && b === "contacts") return contactsDomainApi(request, segments.slice(2));
    if (a === "push" && !b && ["GET", "POST", "DELETE"].includes(method)) return webPushApi(request);
    // 自带 Service Worker：消除宿主缺失 sw.js 导致的 404（详见 ./sw.ts）
    if (a === "sw" && !b && method === "GET") return serveServiceWorker(loadAuthConfig().cookiePath);
    const idCtx = { params: { id: b } }; // /sessions/:id/*
    const tokenCtx = { params: { token: b } }; // /share/:token

    if (a === "contacts" && !b) return method === "GET" ? getCompanyContacts(request) : METHOD_NOT_ALLOWED();
    if (a === "contacts" && b === "search" && !c) return method === "POST" ? searchOaContacts(request) : METHOD_NOT_ALLOWED();

    // ---- 提示词增强（输入框「增强提示词」按钮：独立一次性临时会话，thinking 关闭、无工具） ----
    if (a === "prompt-enhance" && !b) {
      if (method === "POST") return promptEnhance.POST(request);
      return METHOD_NOT_ALLOWED();
    }

    // ---- 链接预览卡（unfurl）：用户消息第一条链接的 OG 摘要，带缓存与 SSRF 防护 ----
    if (a === "link-preview" && !b && method === "GET") return linkPreview.GET(request);

    if (a === "cowork" && b && c) {
      if (c === "agents" && ["GET", "POST", "PATCH", "DELETE"].includes(method)) return cowork.agents(request, b);
      if (c === "admins" && ["GET", "POST", "DELETE"].includes(method)) return cowork.admins(request, b);
      if (c === "container" && ["GET", "PATCH"].includes(method)) return cowork.container(request, b);
      if (c === "exec" && method === "POST") return cowork.exec(request, b);
      if (c === "complete" && method === "POST") return cowork.complete(request, b);
      if (c === "preview" && d && ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) return cowork.preview(request, b, d, segments.slice(4));
      if (c === "connections" && ["GET", "POST", "PATCH", "DELETE"].includes(method)) return cowork.connections(request, b);
      if (c === "state" && method === "GET") return cowork.state(request, b);
      if (c === "monologues" && method === "GET") return cowork.monologues(request, b);
      if (c === "chatmate" && method === "GET") return cowork.chatmate(request, b);
      if (c === "chatmate" && method === "PATCH") return cowork.setChatmate(request, b);
      if (c === "chatmate" && method === "POST" && d === "act") return cowork.chatmateAct(request, b);
      if (c === "chatmate" && method === "POST") return cowork.stopChatmate(request, b);
      if (c === "stop" && method === "POST") return cowork.stopAgent(request, b);
      if (c === "stream" && method === "GET") return cowork.stream(request, b);
      if (c === "send" && method === "POST") return cowork.send(request, b);
      if (c === "forward" && method === "POST") return cowork.forward(request, b);
      if (c === "revoke" && method === "POST") return cowork.revoke(request, b);
      if (c === "reaction" && method === "POST") return cowork.reaction(request, b);
      if (c === "settings" && method === "PATCH") return cowork.settings(request, b);
      return METHOD_NOT_ALLOWED();
    }

    // ---- agent group（chat / upload / voice / artifact）：复用现有 catch-all ----
    if (a === "chat" || a === "upload" || a === "voice") {
      if (method === "POST") return agentRoute.POST(request, { params: { agent: segments } });
      if (a === "chat" && b === "run" && method === "GET") return agentRoute.GET(request, { params: { agent: segments } });
      if (a === "upload" && method === "GET") return agentRoute.GET(request, { params: { agent: segments } });
      return notFound(`POST /api/${segments.join("/")}`);
    }
    // ---- 实时语音会话：登录后签腾讯云 wss URL，客户端直连 ASR ----
    if (a === "audio" && b === "session" && !c && method === "POST") return audioSession(request);
    if (a === "artifact") {
      if (method === "GET") return agentRoute.GET(request, { params: { agent: segments } });
      if (method === "POST") return agentRoute.POST(request, { params: { agent: segments } });
      return METHOD_NOT_ALLOWED();
    }

    // ---- 资料库 / 文件 / 文件分享管理 ----
    if (a === "file") {
      if (method === "GET") return fileApi.file.GET(request);
      return METHOD_NOT_ALLOWED();
    }
    if (a === "files") {
      if (method === "GET") return fileApi.files.GET(request);
      if (method === "POST") return fileApi.files.POST(request);
      if (method === "PATCH") return fileApi.files.PATCH(request);
      if (method === "DELETE") return fileApi.files.DELETE(request);
      return METHOD_NOT_ALLOWED();
    }
    if (a === "memories" && b === "file" && method === "GET") return memory.FILE(request);
    if (a === "memories" && b === "visibility" && (method === "GET" || method === "PATCH")) return memory.VISIBILITY(request);
    if (a === "memories" && !b) {
      if (method === "GET") return memory.GET(request);
      if (method === "POST") return memory.POST(request);
      if (method === "PATCH") return memory.PATCH(request);
      if (method === "DELETE") return memory.DELETE(request);
      return METHOD_NOT_ALLOWED();
    }
    // ---- shares/file（文件级分享管理，仅 owner） ----
    if (a === "shares" && b === "file" && c) {
      if (method === "GET") return fileApi.sharesFile.GET(request, { params: { fileId: c } });
      if (method === "POST") return fileApi.sharesFile.POST(request, { params: { fileId: c } });
      if (method === "DELETE") return fileApi.sharesFile.DELETE(request, { params: { fileId: c } });
      return METHOD_NOT_ALLOWED();
    }

    // ---- sessions ----
    if (a === "sessions") {
      // 跨会话搜索必须排在 `sessions/:id` 通用分支之前：`search` 不是会话 id，
      // 落进去会被当作 /api/sessions/search 的 PATCH/DELETE 挡回来（GET → 405）。
      if (b === "search" && !c && method === "GET") return session.search(request);
      if (b === "pinned-order" && !c && method === "POST") return session.pinnedOrder(request);
      // 全部已读：与 search/pinned-order 同为无 :id 特殊段，必须排在 `sessions/:id` 通用分支之前
      if (b === "read-all" && !c && method === "POST") return session.readAll(request);
      if (!b) {
        if (method === "GET") return session.list(request);
        if (method === "POST") return session.create(request);
        return METHOD_NOT_ALLOWED();
      }
      if (!c) {
        if (method === "PATCH") return session.rename(request, idCtx);
        if (method === "DELETE") return session.remove(request, idCtx);
        return METHOD_NOT_ALLOWED();
      }
      if (c === "messages") {
        if (method === "GET") return session.messages(request, idCtx);
        if (method === "POST") return session.appendMessage(request, idCtx);
        if (method === "PATCH") return session.revokeMessage(request, idCtx);
        return METHOD_NOT_ALLOWED();
      }
      if (c === "workflows" && method === "POST") return session.recordWorkflow(request, idCtx);
      if (c === "read" && method === "POST") return session.read(request,idCtx);
      if (c === "readers" && method === "GET") return session.readers(request,idCtx);
      if (c === "members" && d === "remove" && method === "POST") return session.removeMembers(request, idCtx);
      if (c === "members") {
        if (method === "GET" || method === "POST") return session.members(request, idCtx);
        return METHOD_NOT_ALLOWED();
      }
      if (c === "leave" && method === "POST") return session.leave(request, idCtx);
      if (c === "auto-title" && method === "POST") return session.autoTitle(request, idCtx);
      if (c === "truncate" && method === "POST") return session.truncate(request, idCtx);
      if (c === "fork" && method === "POST") return session.fork(request, idCtx);
      if (c === "close-sdk" && method === "POST") return session.closeSdk(request, idCtx);
      return notFound(`/api/sessions/${b}/${c}`);
    }

    // ---- user-files（用户可操作区：目录名 = 登录用户 id，跨会话共享）----
    if (a === "user-files") {
      if (method === "GET") return userFiles.GET(request);
      if (method === "POST") return userFiles.POST(request);
      if (method === "DELETE") return userFiles.DELETE(request);
      return METHOD_NOT_ALLOWED();
    }

    // ---- share ----
    if (a === "share") {
      if (b === "chat") {
        if (!c && method === "POST") return getShare().chat.POST(request);
        if (c && !d && method === "GET") return getShare().chat.GET(request, c);
        return METHOD_NOT_ALLOWED();
      }
      if (!b) {
        if (method === "POST") return getShare().create.POST(request);
        return METHOD_NOT_ALLOWED();
      }
      if (b === "jsapi-sign") {
        if (method === "POST") return getShare().jsapiSign.POST(request);
        return METHOD_NOT_ALLOWED();
      }
      // /share/:token
      if (method === "GET") return getShare().view.GET(request, tokenCtx);
      if (method === "POST") return getShare().send.POST(request, tokenCtx);
      return METHOD_NOT_ALLOWED();
    }

    // ---- models（模型上下文窗口上限） ----
    if (a === "models" && b === "context" && method === "GET") return session.modelContext(request);
    // ---- models/list（SDK 内置模型 + 优先级最高的 models.json） ----
    if (a === "models" && b === "list" && method === "GET") {
      const groups = getConfiguredAgentModes().includes("codebuddy")
        ? await getCodeBuddyModelGroups()
        : { native: [], custom: getModelOptions() };
      const models = mergeCodeBuddyModels(groups.native, groups.custom);
      const firstModel = models[0];
      const defaultModel = typeof firstModel === "string" ? firstModel : firstModel?.id;
      await fetchCodexModelOptions().catch(() => []);
      return Response.json({ models, nativeModels: groups.native, customModels: groups.custom, customModelOnly: isCustomModelOnly(), modelError: models.length ? null : "没有可用模型", codexModels: getCodexModelOptions(), enableModelSelect: isModelSelectEnabled(), defaultModel: defaultModel || getDefaultModel(), defaultAgentMode: resolveAgentMode(), agentModes: getConfiguredAgentModes() });
    }

    // ---- admin（用量页登录保护：admin/admin，未登录 401） ----
    if (a === "feedback" && method === "POST") return session.submitFeedback(request);
    if (a === "feedback" && method === "GET") return session.getFeedback(request);
    if (a === "agent-kit-admin") {
      if (b === "login" && method === "POST") return session.adminLogin(request);
      if (b === "logout" && method === "POST") return session.adminLogout();
      if (b === "usage" && method === "GET") return session.adminUsage(request);
      if (b === "feedback" && method === "GET") return session.adminFeedback(request);
      if (b === "ask" && method === "POST") return session.adminAsk(request);
      // 普通登录用户读取配置（SDK 运行时拉取提示词/技能等）
      if (b === "settings" && method === "GET") return getSettings(request);
      // 管理员读写配置（需 admin Cookie）
      if (b === "admin" && c === "settings" && method === "GET") return adminGetSettings(request);
      if (b === "admin" && c === "settings" && method === "PUT") return adminSaveSettings(request);
      // 部署组件健康检查与安装（需 admin Cookie）
      if (b === "admin" && c === "components" && !d && method === "GET") return adminComponentsList(request);
      if (b === "admin" && c === "components" && d === "install" && method === "POST") return adminComponentInstall(request);
      if (b === "admin" && c === "components" && d === "install" && method === "GET") return adminComponentJob(request, segments[4] ?? "");
      return notFound(`/api/agent-kit-admin/${b ?? ""}`);
    }

    // ---- auth ----
    if (a === "auth") {
      if (b === "login" && method === "GET") return getLogin().login.GET(request);
      if (b === "login" && method === "POST") return getLogin().login.POST(request);
      if (b === "register" && method === "POST") return getLogin().register.POST(request);
      if (b === "callback" && method === "GET") return getLogin().callback.GET(request);
      if (b === "sso" && method === "POST") return getLogin().sso.POST(request);
      if (b === "session" && method === "GET") return getLogin().session.GET(request);
      if (b === "profile" && method === "PATCH") return getLogin().profile.PATCH(request);
      if (b === "logout" && method === "POST") return getLogin().logout.POST(request);
      if (b === "delete-account" && method === "POST") return getLogin().deleteAccount.POST(request);
      return notFound(`/api/auth/${b ?? ""}`);
    }

    return notFound(`/api/${segments.join("/") || ""}`);
  }

  const GET = (request: Request, context: KitRouteContext = {}) => dispatch("GET", request, context);
  const POST = (request: Request, context: KitRouteContext = {}) => dispatch("POST", request, context);
  const PUT = (request: Request, context: KitRouteContext = {}) => dispatch("PUT", request, context);
  const PATCH = (request: Request, context: KitRouteContext = {}) => dispatch("PATCH", request, context);
  const DELETE = (request: Request, context: KitRouteContext = {}) => dispatch("DELETE", request, context);
  const OPTIONS = (request: Request, context: KitRouteContext = {}) => dispatch("OPTIONS", request, context);

  return { GET, POST, PUT, PATCH, DELETE, OPTIONS };
}
