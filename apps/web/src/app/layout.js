// 站内还会用到 kit 的 UI 组件（登录页、下载页图标、后台控制台），样式统一从 kit 引入；
// 产品介绍页各自的样式写在各页的 *.module.css 里，应用层不再有全局覆盖文件。
import "@turingflow/agent-kit/styles.css";
import SiteStructuredData from "../components/structured-data";
import { GITHUB_URL, ORG_NAME, SEO_DESCRIPTION, SEO_KEYWORDS, SEO_TITLE, SITE_NAME, SITE_URL } from "../lib/seo";

export const metadata = {
  // metadataBase 只取 origin（不带 /linger）：og:image / canonical 里写的是 "/linger/..." 这种
  // 根相对路径，URL 解析时会以 origin 为准；若把 basePath 也塞进 base，反而会被解析成 origin 根上。
  metadataBase: new URL(SITE_URL),
  // 子页面自带 title 时套成「页面名｜灵儿 Linger」，让品牌词跟着每条搜索结果出现
  title: { default: SEO_TITLE, template: `%s｜${SITE_NAME}` },
  description: SEO_DESCRIPTION,
  keywords: SEO_KEYWORDS,
  applicationName: "Linger",
  category: "technology",
  authors: [{ name: ORG_NAME, url: GITHUB_URL }],
  creator: ORG_NAME,
  publisher: ORG_NAME,
  alternates: { canonical: "/linger" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "zh_CN",
    url: "/linger",
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: [
      {
        url: "/linger/icons/og-linger.png",
        width: 1200,
        height: 630,
        alt: "灵儿 Linger · 开源桌面个人智能体 · 图灵环流 TuringFlow",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: SEO_TITLE,
    description: SEO_DESCRIPTION,
    images: ["/linger/icons/og-linger.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 },
  },
  manifest: "/linger/manifest.webmanifest",
  appleWebApp: { capable: true, title: "灵儿 Linger", statusBarStyle: "black-translucent" },
  // 必须显式给出 icon/shortcut：否则浏览器会退回请求 origin 根路径的 /favicon.ico，
  // 而该路径在网关上是站点首页兜底（返回 HTML），标签页图标就会沿用浏览器里
  // 该 origin 的历史缓存（本站域名早期跑过 Dify，缓存里是 Dify 的 if 图标）。
  icons: {
    icon: [
      { url: "/linger/icons/linger-mark-192.png", sizes: "192x192", type: "image/png" },
      { url: "/linger/icons/linger-mark-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/linger/icons/linger-mark-192.png",
    apple: "/linger/icons/linger-mark-180.png",
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#202020",
};

export default function RootLayout({ children }) {
  return (
    // suppressHydrationWarning：主题（data-theme）由客户端在 hydrate 后写入 <html>，
    // SSR 无此属性，属性不一致属预期（Next.js 官方推荐处理方式），避免控制台 hydration 误报
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        {children}
        <SiteStructuredData />
      </body>
    </html>
  );
}
