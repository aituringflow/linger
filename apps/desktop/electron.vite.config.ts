import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";

const KIT_ROOT = resolve(__dirname, "../../packages/agent-kit");
const KIT_SRC = resolve(KIT_ROOT, "src");

// agent-kit 开源后，Launcher 直接编译它的 TS/TSX 源码（dev 与 build 一致）：
// - main：源码随主进程 bundle 一起编译，无需预编译产物，--watch 下改 SDK
//   服务端源码会触发 Electron 重启；
// - renderer：UI 与样式都指向源码，Vite dev server 直接 HMR。
// kit 自身的第三方依赖仍从 node_modules 运行时加载：原生模块、按 __dirname 定位
// 资源的 CLI 等不适合被 esbuild 打进 bundle。
const kitDependencies: string[] = Object.keys(
  JSON.parse(readFileSync(resolve(KIT_ROOT, "package.json"), "utf8")).dependencies ?? {},
);
/**
 * 纯 ESM 依赖：package.json 的 "." 导出只有 import（没有 require / default），
 * 或者 type: module 且没有可供 CJS 入口的 main。这类包一旦被外部化，运行期 require
 * 必抛 ERR_PACKAGE_PATH_NOT_EXPORTED（@openai/codex-sdk、@summersmile/voice-dictation 都是这样），
 * 所以必须交给 rollup 打进 bundle，不能留在 node_modules 里等 require。
 */
function isEsmOnly(name: string): boolean {
  try {
    // 不能用 require.resolve(`${name}/package.json`)：这类包通常不导出 package.json，
    // 会直接抛错，于是被误判成"非 ESM"。直接按目录读文件。
    const pkgPath = [
      resolve(__dirname, "../../node_modules", name, "package.json"),
      resolve(__dirname, "node_modules", name, "package.json"),
    ].find((p) => existsSync(p));
    if (!pkgPath) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const dot = pkg.exports && typeof pkg.exports === "object" ? pkg.exports["."] : undefined;
    if (dot && typeof dot === "object") {
      if (dot.require || dot.default) return false;
      return Boolean(dot.import);
    }
    return pkg.type === "module" && !pkg.main;
  } catch {
    return false;
  }
}

const ESM_ONLY_DEPS = kitDependencies.filter(isEsmOnly);
const bundledKitDeps = kitDependencies.filter((name) => !ESM_ONLY_DEPS.includes(name));
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const kitDepExternals = bundledKitDeps.map(
  (name) => new RegExp(`^${escapeRegExp(name)}(?:/|$)`),
);

// 精确匹配：Vite 的字符串 alias 是前缀替换，`@turingflow/agent-kit` 会把
// `agent-kit/ui` 误指向 `<server/index.ts>/ui`。
const exact = (specifier: string, file: string) => ({
  find: new RegExp(`^${escapeRegExp(specifier)}$`),
  replacement: resolve(KIT_SRC, file),
});

const kitMainAliases = [
  exact("@turingflow/agent-kit", "server/index.ts"),
  exact("@turingflow/agent-kit/local-chat", "server/local-chat-store.ts"),
  exact("@turingflow/agent-kit/ota", "server/ota-client.ts"),
  exact("@turingflow/agent-kit/ota/server", "server/ota-server.ts"),
];

const kitRendererAliases = [
  exact("@turingflow/agent-kit/ui", "ui/index.ts"),
  exact("@turingflow/agent-kit/styles.css", "ui/style/styles.css"),
];

/**
 * kit 源码被打进 main bundle 后，Vite 会把 import.meta.url 改写成
 * pathToFileURL(__filename)（指向 out/main/chunks/*.js），kit 里按源码目录定位的
 * schema.sql、通知音、子脚本等资源会全部错位。这里把每个 kit 模块的
 * import.meta.url 固定为它自己的源码位置；Electron 打包后改用
 * resources/agent-kit-src（见 electron-builder.yml）。
 */
function kitSourceUrlPlugin(): Plugin {
  const repoSrc = resolve(KIT_SRC);
  const repoBase = pathToFileURL(resolve(repoSrc, "__kit__")).href.replace(/__kit__$/, "");
  return {
    name: "agent-kit-source-url",
    enforce: "pre",
    transform(code, id) {
      if (!id.startsWith(repoSrc + sep) || !code.includes("import.meta.url")) return null;
      const rel = relative(repoSrc, id).split(sep).join("/");
      const rootExpr = `(() => {
        const p = require("node:path");
        const asDirectoryUrl = (root) => require("node:url").pathToFileURL(p.join(root, "__kit__")).href.replace(/__kit__$/, "");
        if (process.env.AGENT_KIT_SRC_ROOT) {
          const r = process.env.AGENT_KIT_SRC_ROOT;
          return r.startsWith("file:") ? (r.endsWith("/") ? r : r + "/") : asDirectoryUrl(r);
        }
        const fs = require("node:fs");
        const packed = process.resourcesPath ? p.join(process.resourcesPath, "agent-kit-src") : "";
        if (packed && fs.existsSync(p.join(packed, "server"))) {
          process.env.AGENT_KIT_SRC_ROOT = packed;
          return asDirectoryUrl(packed);
        }
        return ${JSON.stringify(repoBase)};
      })()`;
      const inject = `const __kitSrcUrl = new URL(${JSON.stringify(rel)}, ${rootExpr}).href;\n`;
      return { code: inject + code.replaceAll("import.meta.url", "__kitSrcUrl"), map: null };
    },
  };
}

/**
 * Codex CLI 现在不打进安装包，首次使用时按需下载（见 src/main/codex-runtime.ts）。
 * 下载地址要带版本号，而版本号只能来自构建机的 node_modules，所以在构建期注入成常量。
 */
function codexCliVersion(): string {
  const pkgPath = resolve(__dirname, "../../node_modules/@openai/codex/package.json");
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    console.warn("[launcher] 读不到 @openai/codex 版本，Codex 按需下载会退回内置兜底版本");
    return "";
  }
}

/**
 * LibreOfficeKit 引擎包同样按需下载（见 src/main/libreoffice-runtime.ts）。
 * 下载地址形如 @deepseek-ai/libreoffice-kit-win32-x64/-/libreoffice-kit-win32-x64-<ver>.tgz，
 * 版本号必须与 node_modules 里装的一致（libreoffice-kit 会校验 manifest 版本），
 * 所以和 Codex 一样在构建期从 package.json 注入。
 */
function libreOfficeKitVersion(): string {
  const pkgPath = resolve(__dirname, "../../node_modules/@deepseek-ai/libreoffice-kit/package.json");
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    console.warn("[launcher] 读不到 @deepseek-ai/libreoffice-kit 版本，office 组件按需下载会退回内置兜底版本");
    return "";
  }
}

// Packaging uses a private output directory so dev --watch cannot replace its files.
const packageOutDir = process.env.LINGER_PACKAGE_OUT_DIR;

export default defineConfig({
  main: {
    define: {
      __CODEX_CLI_VERSION__: JSON.stringify(codexCliVersion()),
      __LIBREOFFICE_KIT_VERSION__: JSON.stringify(libreOfficeKitVersion()),
    },
    // exclude：让 kit 的 bare import 不被外部化，交给下面的 alias 打进 bundle。
    plugins: [
      kitSourceUrlPlugin(),
      externalizeDepsPlugin({ exclude: ["@turingflow/agent-kit", ...ESM_ONLY_DEPS] }),
    ],
    resolve: { alias: kitMainAliases },
    build: {
      ...(packageOutDir ? { outDir: resolve(packageOutDir, "main"), emptyOutDir: true } : {}),
      rollupOptions: {
        // Keep Transformers.js in node_modules; dev rebuilds can invalidate hashed dynamic chunks.
        external: [
          "ffmpeg-static", "@napi-rs/canvas", "@huggingface/transformers", "@huggingface/tokenizers",
          "onnxruntime-node", "better-sqlite3", "tesseract.js", "unzipper", "sax",
          ...kitDepExternals,
        ],
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          "knowledge-runtime": resolve(__dirname, "src/main/knowledge-base/runtime.ts"),
          "knowledge-worker": resolve(__dirname, "src/main/knowledge-base/worker.ts"),
          "knowledge-host": resolve(__dirname, "src/main/knowledge-base/host-process.ts"),
          "knowledge-parser": resolve(__dirname, "src/main/knowledge-base/parser-process.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      ...(packageOutDir ? { outDir: resolve(packageOutDir, "preload"), emptyOutDir: true } : {}),
      rollupOptions: {
        // index：Launcher 自己的渲染层；login：登录窗专用（只暴露「记住的账号」）。
        input: {
          index: resolve(__dirname, "src/preload/index.ts"),
          login: resolve(__dirname, "src/preload/login.ts"),
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5182,
      strictPort: true,
      watch: {
        // alias 指向 packages/agent-kit/src（在项目 root 之外），vite 默认不 watch；
        // 不加这段，改 agent-kit UI 源码后 HMR 不触发，必须手动清缓存重启。
        ignored: [],
      },
      fs: {
        allow: [resolve(__dirname, "../../../")],
      },
    },
    // dev 与 build 都走源码。UI 与样式必须同时 alias 到 src，否则样式解析会偏离源码
    // （曾表现为 kit 新增的移动端专属元素在桌面端漏出来）。
    resolve: { alias: kitRendererAliases },
    optimizeDeps: { exclude: ["@turingflow/agent-kit/ui"] },
    build: {
      ...(packageOutDir ? { outDir: resolve(packageOutDir, "renderer"), emptyOutDir: true } : {}),
      rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } },
    },
  },
});
