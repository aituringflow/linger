// /linger/sitemap.xml —— 只收公开的介绍页；登录、后台、接口不进 sitemap。
import { absoluteUrl } from "../lib/seo";

const PAGES = [
  { path: "/", priority: 1.0, changeFrequency: "weekly" },
  // 下载页必须带 appId：不带参数时服务端渲染的是「页面不存在」，收进 sitemap 等于提交一个空页
  { path: "/download?appId=launcher", priority: 0.9, changeFrequency: "weekly" },
  { path: "/desktop", priority: 0.8, changeFrequency: "monthly" },
  { path: "/knowledge", priority: 0.8, changeFrequency: "monthly" },
  { path: "/collaboration", priority: 0.7, changeFrequency: "monthly" },
  { path: "/insight", priority: 0.7, changeFrequency: "monthly" },
];

export default function sitemap() {
  const lastModified = new Date();
  return PAGES.map(page => ({
    url: absoluteUrl(page.path),
    lastModified,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
