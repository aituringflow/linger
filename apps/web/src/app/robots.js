// /linger/robots.txt —— 注意：Next 的 basePath 会让这个文件挂在 /linger 下，
// 而爬虫只认 origin 根的 /robots.txt（那个文件属于同域下另一个产品）。
// 因此这里主要作用是「给能读到它的抓取器一份规则 + sitemap 地址」，
// 真正的收录仍要靠根 robots.txt 指过来，或在 Search Console 手动提交 sitemap。
import { absoluteUrl } from "../lib/seo";

export default function robots() {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // 后台与接口对搜索没有价值，且会被抓出大量无意义 URL
        disallow: ["/linger/api/", "/linger/login", "/linger/agent-kit-admin", "/linger/updates-admin", "/linger/preview", "/linger/admin"],
      },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: absoluteUrl("/"),
  };
}
