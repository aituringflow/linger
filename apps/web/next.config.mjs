/** @type {import('next').NextConfig} */

/**
 * ── agent-kit 源码直连 ────────────────────────────────────────────────────────
 *
 * agent-kit 已开源，web 的 dev / build / start 一律直接编译 packages/agent-kit/src，
 * 不经过任何构建产物：agent-kit 是私有源码 workspace 包，不发布 npm，
 * 没有 dist/ 构建步骤；改 SDK 源码，Next dev 即时热更新。
 *
 * 踩过的坑：
 *   1. `transpilePackages: ["agent-kit"]` 只让 Next「转译语法」，**不改变模块解析路径**。
 *      服务端入口、UI、CSS 各是独立子路径，必须显式 alias 到 src 下的具体文件，
 *      否则打包器按包名解析拿不到 TS/TSX 源码入口。
 *   2. Turbopack 的 resolveAlias 是前缀匹配，长键优先，且键名不能带 `$`；
 *      webpack 的 alias 是前缀替换，必须给每个键补 `$` 做精确匹配。
 */
const KIT_SRC = "../../packages/agent-kit/src";

// 从长到短排列，主入口 `@turingflow/agent-kit` 必须放最后，否则前缀会抢走子路径。
const kitAliases = {
  "@turingflow/agent-kit/ota/server": `${KIT_SRC}/server/ota-server.ts`,
  "@turingflow/agent-kit/local-chat": `${KIT_SRC}/server/local-chat-store.ts`,
  "@turingflow/agent-kit/styles.css": `${KIT_SRC}/ui/style/styles.css`,
  "@turingflow/agent-kit/ota": `${KIT_SRC}/server/ota-client.ts`,
  // UI 客户端组件（page.js / admin / login 里的 AgentApp、LoginPage、AdminUsage）
  "@turingflow/agent-kit/ui": `${KIT_SRC}/ui/index.ts`,
  // 服务端主入口（API catch-all、login page 的 getLoginOptions）
  "@turingflow/agent-kit": `${KIT_SRC}/server/index.ts`,
};

const webpackKitAliases = Object.fromEntries(
  Object.entries(kitAliases).map(([k, v]) => [k.endsWith("$") ? k : `${k}$`, v]),
);

const nextConfig = {
  reactStrictMode: true,
  experimental: { proxyClientMaxBodySize: "1gb" },
  // 子路径部署：所有路由（页面 /api/静态资源）都挂在 /linger 下，
  // 本地访问 http://localhost:3100/linger，pro 上由 nginx 把 /linger 反代到本服务。
  basePath: "/linger",
  // 局域网/内网开发访问，避免 dev server 按主机名拦截 192.168.* 网段。
  allowedDevOrigins: ["192.168.*.*", "127.0.0.1"],
  // 关键：不让 Turbopack 打包这些「运行时应从 node_modules 直接加载」的包。
  // - @tencent-ai/agent-sdk：通过 __dirname 定位内置 CLI（.../cli/bin/codebuddy），
  //   被打包进 bundle 后 __dirname 变成虚拟路径，会报 "CodeBuddy CLI not found"。
  // - pg（Postgres 驱动）：原生网络驱动，保持外部依赖由运行时加载。
  // - @napi-rs/canvas：原生 napi 二进制（js-binding.js 是 .node 占位），Turbopack 无法
  //   把它放进 ESM chunk，会报 "non-ecmascript placeable asset" 导致 next build 失败。
  // - dockerode：群沙箱走 Docker，它依赖 ssh2；ssh2 的 crypto.js 会在存在预编译
  //   sshcrypto.node 时直接 require 原生插件，同样触发 "non-ecmascript placeable asset"。
  serverExternalPackages: ["@tencent-ai/agent-sdk", "pg", "@napi-rs/canvas", "dockerode"],
  // 转译 agent-kit 源码中的 TS/TSX；不改变解析路径，解析由上面的 alias 决定。
  transpilePackages: ["@turingflow/agent-kit"],
  turbopack: {
    resolveAlias: kitAliases,
  },
  // webpack 兜底（若某些命令/版本回退到 webpack 构建）
  webpack: (config) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      ...webpackKitAliases,
    };
    return config;
  },
};

export default nextConfig;
