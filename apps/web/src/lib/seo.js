// 站点级 SEO 常量：metadata、robots、sitemap、JSON-LD 共用一处，避免域名/路径各处手写漂移。
// APP_PUBLIC_URL 由部署环境提供（pro 上为 https://gcomply.aotsea.com），本地开发回落到同一域名，
// 保证 canonical / og:url 始终是绝对地址 —— 相对地址在 OG 抓取器（微信、Slack）里会被当成无效 URL。

export const SITE_URL = (process.env.APP_PUBLIC_URL || "https://gcomply.aotsea.com").replace(/\/+$/, "");

/** Next 的 basePath，站点挂在 /linger 下 */
export const BASE_PATH = "/linger";

export const SITE_NAME = "灵儿 Linger";
export const ORG_NAME = "图灵环流 TuringFlow";
export const GITHUB_URL = "https://github.com/aituringflow/linger";

/** 站内路径（不带 basePath）→ 绝对 URL */
export function absoluteUrl(path = "/") {
  const p = path === "/" ? "" : path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL}${BASE_PATH}${p}`;
}

/** 首页与分享卡片复用的文案，title / og / twitter 三处必须一致，否则分享预览会与标题打架 */
export const SEO_TITLE = "灵儿 Linger｜开源桌面个人智能体（Personal Agent）";
export const SEO_DESCRIPTION =
  "灵儿（Linger）是图灵环流（TuringFlow）开源的桌面个人智能体（Personal Agent）：把微信、订单、账单、文件里散落的信息汇聚到一处，一句话把事办完，重要的事才来找你。支持 macOS 与 Windows，数据默认留在本机。";

/** 关键词：中文词 + 英文词成对出现，覆盖「智能体 / agent / personal agent / AI」这组同义检索 */
export const SEO_KEYWORDS = [
  "灵儿",
  "Linger",
  "图灵环流",
  "TuringFlow",
  "个人智能体",
  "Personal Agent",
  "桌面智能体",
  "AI 智能体",
  "AI Agent",
  "数字分身",
  "AI 助手",
  "开源智能体",
  "本地 AI",
  "桌面 AI",
  "macOS",
  "Windows",
];
