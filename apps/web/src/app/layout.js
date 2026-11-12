// 站内还会用到 kit 的 UI 组件（登录页、下载页图标、后台控制台），样式统一从 kit 引入；
// 产品介绍页各自的样式写在各页的 *.module.css 里，应用层不再有全局覆盖文件。
import "@turingflow/agent-kit/styles.css";

export const metadata = {
  title: "灵儿 Linger",
  description: "你的桌面数字分身：替你汇聚、替你办事、替你把关。",
  applicationName: "Linger",
  manifest: "/linger/manifest.webmanifest",
  appleWebApp: { capable: true, title: "灵儿 Linger", statusBarStyle: "black-translucent" },
  icons: { apple: "/linger/icons/apple-touch-icon.png" },
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
      <body>{children}</body>
    </html>
  );
}
