# 开发指南

[English](development.md) | 简体中文

本文说明如何在本地把仓库跑起来、三个包之间如何协作，以及提 PR 前应该跑哪些检查。

## 环境要求

| 工具 | 版本 | 用途 |
|---|---|---|
| Node.js | 24.9+（见 `.nvmrc`） | 全部 |
| 操作系统 | macOS / Windows | 桌面应用；Linux 未验证 |
| npm | 10+ | workspaces |
| PostgreSQL | 近期任意版本 | Web 应用的登录、会话、群聊（可选） |
| Docker | 近期任意版本 | 群沙箱 / `group_bash`（可选） |
| clang（Xcode CLT） | — | 桌面应用的 macOS 状态栏采集器（可选） |
| PowerShell | Windows PowerShell 5.1+ | 桌面应用的 Windows 窗口控制助手（可选） |

按功能另需、同样可选：Codex 模式的 Codex CLI、自定义模型要的本地 OpenAI 兼容服务、语音输入要的 ASR 服务。

## 仓库结构

```
packages/agent-kit/    SDK：服务端运行时 + React UI + OTA 服务
  src/server/          路由、会话、登录、产物、终端、群聊
  src/ui/              以 @turingflow/agent-kit/ui 导出的 React 组件
apps/web/              Next.js 产品站 + 桌面端后台，basePath /linger，端口 3100
  server.mjs           自定义 server：Next + 1 小时请求超时（OTA 上传）
apps/desktop/         Electron 应用（main / preload / renderer，electron-vite）
docs/                  长文档（本文、产品规则、OTA 说明）
```

SDK 的解析方式：

- **workspace**：两个 app 都声明 `"@turingflow/agent-kit": "*"`，npm 在仓库内解析到 `packages/agent-kit`。
- **Web**：`apps/web/next.config.mjs` 在 dev 与生产构建中把全部 SDK 入口（`.`、`/ui`、`/styles.css`、`/ota*`、`/local-chat`）alias 到 `packages/agent-kit/src/**`；`server.mjs` 通过 `tsx` 加载同一份源码入口。
- **桌面应用**：`electron.vite.config.ts` 把 SDK 服务端源码编进 main bundle，renderer 的 UI 与样式也指向源码。改 UI 走 Vite HMR，改服务端源码由 `--watch` 重启主进程。
- **源码包**：`@turingflow/agent-kit` 是私有包，不发布 npm；`exports` 直接指向 `src/**/*.ts`，没有 `dist/` 构建，也没有发布流程。

## 快速开始

在仓库根目录安装依赖，并按需调整环境变量：

```bash
npm install
cp apps/web/.env.example apps/web/.env
cp apps/desktop/.env.example apps/desktop/.env
```

在 `apps/web/.env` 中将 `AUTH_SESSION_SECRET` 设置为随机值（可用 `openssl rand -hex 32` 生成）；密钥只供 Web 服务使用。在两个终端分别启动 Web 和桌面应用：

```bash
npm run dev:web       # http://localhost:3100/linger
npm run dev:desktop
```

对话能力不用 API Key，走订阅登录，凭据缓存在 `~/.codebuddy`：

```bash
npm run login            # 打印一个链接，手动到浏览器完成登录
```

`npm run login` 读的是进程环境变量，不会去读 `apps/web/.env`。需要指向别的后端环境时，在命令行上显式传变量。

## 运行各个目标

### Web 应用

```bash
npm run dev:web          # http://localhost:3100/linger
```

自定义 server（`apps/web/server.mjs`）只跑 Next，并把请求超时放宽到 1 小时，避免大体积 OTA 上传被掐断。web 负责产品站、下载页和桌面端后台（账号、OTA），站内没有对话，因此不再挂实时网关。需要 HTTPS（部分麦克风、剪贴板 API 要求）：

```bash
npm run dev:web:https    # 自签证书
```

生产：

```bash
npm run build:web
npm run start -w web     # node server.mjs --production
```

### 桌面应用

```bash
npm run dev:desktop
```

dev 入口会先尝试编译两个可选的原生助手——macOS 状态栏采集器（clang）与 Windows 窗口控制助手（PowerShell），工具链缺失时只告警不中断——然后启动 `electron-vite dev`。

桌面应用的登录与账号走 Web 应用，因此要同时跑着 `npm run dev:web`，并让 `WEB_SERVER_URL` 指向它。桌面端通过 Web 服务验证会话，不需要签名密钥。

打包：

```bash
npm run build -w desktop          # 构建原生助手及 Electron 应用
npm run dist -w desktop           # 经 scripts/build-launcher.mjs 调 electron-builder
```

### 只做 SDK

```bash
npm run typecheck -w @turingflow/agent-kit
npm run cli -w @turingflow/agent-kit   # 命令行交互式对话
```

SDK 没有构建或发布流程，两个 app 都直接编译 `src`。

## 配置

配置通过环境变量提供。完整选项见 [Web 配置示例](../apps/web/.env.example)和[桌面端配置示例](../apps/desktop/.env.example)：

| 文件 | 读取方 |
|---|---|
| `apps/web/.env` | Web 应用（Next 启动时加载） |
| `apps/desktop/.env` | 桌面应用；开发态会从 `apps/web/.env` 补齐缺失的键 |

最常改的变量：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `AUTH_SESSION_SECRET` | — | Web 服务的会话 cookie 签名密钥，不应放在客户端 |
| `AUTH_COOKIE_PATH` | `/linger` | Web 服务的 cookie 路径，需与 `basePath` 对齐 |
| `AUTH_PROVIDER` | `builtin` | `builtin`、`feishu`、`dingtalk`、`adaptive` 或 `none` |
| `AUTH_SECURE_COOKIE` | — | 本地 HTTP 使用 `false`；HTTPS 部署使用 `true` |
| `AGENT_PROVIDER` | `codebuddy` | 默认引擎 |
| `AGENT_APP_NAME` | — | 声明应用名，本机数据随下落 `~/.<应用名>` |
| `AGENT_DATA_DIR` | — | 可选，覆盖本机数据根目录 |
| `AGENT_MODELS_PATH` | — | `models.json` 文件或其所在目录 |
| `AGENT_ARTIFACT_DIR_NAME` | `.agent-files` | 产物根目录名；声明了应用名时为 `.<应用名>` |
| `TENCENT_CLOUD_APP_ID`、`TENCENT_CLOUD_SECRET_ID`、`TENCENT_CLOUD_SECRET_KEY` | — | 腾讯云实时语音识别凭据，保留在服务端 |
| `AGENT_KIT_ASR_PROVIDER`、`AGENT_KIT_ASR_HOST`、`AGENT_KIT_ASR_API_KEY` | — | 可选的通用语音转写服务 |
| `AGENT_KIT_LOG_LEVEL` | `info` | 服务端详细日志设 `debug` |
| `POSTGRES_HOST/PORT/USER/DB/PASSWORD` | — | 开启服务端持久化与群聊；建表落在 `linger` schema |
| `PORT` | `3100` | Web 端口 |
| `APP_PUBLIC_URL` | — | 对外基础地址，用于 OAuth 回调与链接 |
| `WEB_SERVER_URL` | `http://127.0.0.1:3100/linger` | 桌面应用访问的 Web 根地址 |
| `LAUNCHER_APP_NAME` | `linger` | 覆盖桌面应用的数据目录名 |

桌面端的登录、账号和更新依赖 Web 服务。部署时在 Web 端设置 `APP_PUBLIC_URL`，并在打包前将 `apps/desktop/.env` 的 `WEB_SERVER_URL` 指向同一服务的 `/linger` 路径。桌面端 `.env` 会完整打包进安装包，只能放公开的客户端配置。客户端无法访问 Web 服务时，无法验证登录态。

Web 应用的建表：

```bash
npm run db:migrate -w web
```

SDK 在首次连库时也会跑一次幂等建表，这条命令主要用于提前初始化空库。

### 数据落在哪

```
~/.<AGENT_APP_NAME>/models.json      # 自定义模型列表
~/.<AGENT_APP_NAME>/chats/           # 本机会话（桌面应用）
~/.<AGENT_APP_NAME>/artifacts/<sid>/ # 每会话的产物
~/.<AGENT_APP_NAME>/knowledge/       # 知识库：库、OCR 缓存、嵌入模型
~/.<AGENT_APP_NAME>/terminal-home/   # 每会话的 shell 状态（rc 文件、历史、npm 缓存）
```

未声明应用名时回退到 `~/.agent` 与 `~/.agent-files`。桌面应用声明了 `linger`，数据落在 `~/.linger`。任何数据都不写进仓库。

## 提交前的检查

```bash
npm run typecheck -w @turingflow/agent-kit    # 服务端 + UI
npm run typecheck -w desktop                 # main/preload + renderer
npm run build -w web
```

`apps/desktop` 的 renderer 类型检查目前有一批与近期改动无关的既有错误，见整改清单。构建不走类型检查，build 通过不代表 `tsc` 通过。

## 排错

| 现象 | 原因与处理 |
|---|---|
| `Authentication required. Please use /login command to sign in` | 本机没有订阅登录态或已过期。跑 `npm run login`，然后**重启 dev server**——服务端持有长驻引擎会话，不重开读不到新凭据 |
| 改了 SDK 源码，Web 没变化 | Next dev 应从 `src` 热更新。若模块图陈旧，重启 dev server（或清 `.next/`）；已无 `dist` 回退 |
| 改了 SDK 源码，桌面应用表现没变 | renderer 走 HMR，main 由 `electron-vite dev --watch` 重启；watcher 漏掉时重启 `npm run dev:desktop` |
| 桌面应用启动无输出直接退出 | 环境里存在 `ELECTRON_RUN_AS_NODE=1` 会让 Electron 退化成纯 Node。dev 入口会删掉它；手动启动 Electron 时需自己 unset |
| 3100 端口被占用 | 改 `PORT`，同时把 `WEB_SERVER_URL` 改成同一端口 |
| Electron 打包报 `EPERM ... rename win-unpacked.tmp` | 索引服务或杀软占着刚解包的文件。打包脚本默认输出到工作区外，`--out` 不要指向仓库内 |
| 登录成功但仍返回 401 | 检查桌面端 Web 地址、cookie 路径及 Web 服务的会话配置 |

## 约定

- 注释只解释「为什么这么做」，不写这段代码怎么演变来的。不写迁移叙事。
- `packages/agent-kit` 是独立的 SDK：不得提及或 import 本仓库里的任何应用。宿主统一称 host / desktop host / web。
- 本机数据目录一律由 `AGENT_APP_NAME` 推导，新代码不要硬编码 `~/.agent`。
- 长文档成对维护（`*.md` 英文、`*.zh-CN.md` 中文），两边必须同步。
