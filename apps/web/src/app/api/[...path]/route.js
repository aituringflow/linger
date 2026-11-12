import { createAgentKitApi } from "@turingflow/agent-kit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 单一 catch-all 承载 agent-kit 全部端点：chat / upload / voice / artifact /
// sessions（含 messages / auto-title / truncate / close-sdk）/ share（含 token）/
// realtime-ticket / cowork（群 AI、AI 伴聊）/ contacts-domain / auth（login / callback /
// sso / session / profile / logout）。端点逻辑 100% 在 agent-kit，新增端点无需改应用端。
//
// 这个 Web 应用本身不提供聊天界面：站点只做产品介绍与 launcher 后台。但 launcher 的 IM
// （群聊、群 AI、AI 伴聊、语音）都跑在这里，所以后端端点必须完整保留——删掉任何一个都会
// 让桌面端的对应功能直接 404。
const api = createAgentKitApi({
  agent: {
    chat: {
      continueSession: false,
      fallbackModel: process.env.CODEBUDDY_FALLBACK_MODEL?.trim() || undefined,
      // allowBash 只在服务端会话里生效；桌面端本地会话走 launcher 自己的运行时。
      allowBash: true,
      // 已注册的能力清单：渲染进基础系统提示词，供模型准确自我介绍与承接需求。
      capabilities: [
        {
          name: "IM 群聊协同",
          description: "人机协同参与群聊：自动结合群聊上下文理解讨论，被 @ 或有明确需要时直接回复，或先生成回复建议由你确认后发出；主动捕捉关键遗漏、误解和待办事项。",
        },
      ],
    },
  },
});

// 显式具名导出（而非解构），确保 Next 静态分析稳定识别 GET/POST/PUT/PATCH/DELETE 方法。
export const GET = api.GET;
export const POST = api.POST;
export const PUT = api.PUT;
export const PATCH = api.PATCH;
export const DELETE = api.DELETE;
export const OPTIONS = api.OPTIONS;
