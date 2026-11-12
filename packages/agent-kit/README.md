# agent-kit（Agent 前后端一体 SDK）

## 通知音效与本机会话存储

Kit 内置 `bright`、`calm`、`playful` 三种通知音效。使用 `createAgentKitApi` 的宿主会通过现有 API 路由提供 `GET /api/notification-sounds/<name>.wav`（路径前面加宿主的 `basePath`）；宿主无需复制 WAV 到 `public`。音效 UI 会从该路由加载文件。

Electron 等 Node 宿主可从 `@turingflow/agent-kit/local-chat` 导入 `LocalChatStore`。构造函数可传入本机会话目录；不传时默认使用应用主目录 `~/.<AGENT_APP_NAME>/chats`（应用未声明名字时为 `~/.agent/chats`）。**命名策略：应用层指定了名字就优先用名字**——宿主在加载 kit 前设置 `AGENT_APP_NAME` 即可，例如 `AGENT_APP_NAME=myapp` 时全部本机数据落到 `~/.myapp`。不同应用应声明各自的目录，以免会话数据混用：

```ts
import { LocalChatStore } from "@turingflow/agent-kit/local-chat";

const chats = new LocalChatStore("/path/to/app/chats");
```

音效 WAV 直接放在 `src/assets/notification-sounds/`，宿主通过 kit 的 API 路由从源码位置读取，无需构建或复制。

## 群聊试验

每个群只有一个共享容器（群内所有 AI 共用），默认关闭，由群主在「群 AI」首页右侧的“云电脑”开关控制。开启请求等待容器启动和目录读写检查完成后才保存开启状态；启动失败时开关保持关闭。慢思考使用 CodeBuddy 时，群内启用的 AI 都会获得 `group_bash` 工具，内置 Bash 仍禁用。关闭开关会移除容器；删除单个 AI 不影响群容器。

1v1 聊天（发起人 + 恰好 1 名成员）时双方均为群管理员：都能添加/编辑/删除群 AI、开关云电脑、修改群设置，也都能解散群组。3 人及以上群仍只有发起人可管理。

运行服务所在机器需要 Docker CLI 和可访问的 Docker daemon。默认镜像由 `Dockerfile.group` 首次自动构建，包含 Node.js、npm 和 Git；也可通过 `GROUP_BASH_IMAGE` 指定已准备的镜像（需包含 `sh`、`sleep`、`timeout`、`ip`、`iptables`）。容器挂载群 uploads 到 `/group/uploads`（只读），artifacts 到 `/group/artifacts`（读写）；根文件系统只读，npm 缓存放在 artifacts。容器可访问公网，但由独立网络命名空间中的规则阻断到宿主机的**新建连接**；规则无法建立时启动失败。容器同时限制进程数、内存、CPU、权限和单次命令执行时间。Docker daemon 的访问权限只应授予可信的运行服务进程。

群 AI 可调用 `start_preview` 启动监听 `0.0.0.0:3000` 的应用。启动成功后，请求者的右侧面板自动打开“应用预览”浏览器标签；再次启动会聚焦并刷新该标签。对外分享地址为同域的 `/linger/preview/<publicId>/`，无需登录；随机 publicId 属于长期分享链接，关闭并重新开启容器不会改变它。容器重新开启时尝试用群内最近一次保存的命令恢复应用服务；未运行时链接显示暂不可用。群成员也可从详情页的“打开预览”进入。前端应用的资源 base path 要设为 `start_preview` 工具给出的完整路径。持有完整链接的人均可访问，删除群 AI 会使该 AI 的预览链接失效（容器为群共享，不受影响）。非本地预览响应设置 CSP sandbox，隔离应用脚本与主站登录态；localhost、127.0.0.1 和 ::1 上的本地预览按普通浏览器页面运行。当前代理支持 HTTP 请求，开发服务器的 WebSocket 热更新尚未接入。

配置 PostgreSQL 后显示添加成员入口并开放群聊 API。群聊使用独立的消息发送和运行状态通道。每轮先由关闭思考与工具的 CodeBuddy 快思考私下决定沉默、短答或委托慢思考；仅慢思考共享单聊格式的思考与工具流。所有成员可在 AI 生成期间继续发消息，并通过服务端 SSE 推送看到同一份流式回复；客户端只在首次加载和重连时获取状态快照，不再定时轮询。正式回复按数据库消息 ID 排序，并标出所回应的消息。群设置由发起人选择框架和模型。记忆管理可配置是否在群聊向 Agent 公开个人记忆，测试阶段默认公开。

## Side chat：嵌入式 / 临时聊天

`@turingflow/agent-kit/ui` 同时导出无界面的 `createSideChat()` 和可放在任意容器里的 `<SideChat />`。UI 直接渲染 `ChatWindow` 的中间聊天区，沿用消息、附件、模型选择、语音、流式回复及断线续接的现有实现。宿主通过 `context()` 把当前页面状态送进每轮聊天，通过 `parseResult()` 提取业务结果。`send()` 的返回值或组件的 `onResult` 都带完整回复、解析结果和会话 ID。

```tsx
import { createSideChat, SideChat } from "@turingflow/agent-kit/ui";

const chat = createSideChat({
  basePath: "/linger",
  saveSession: false,
  context: () => `当前邮件主题：${subject}`,
  parseResult: (text) => ({ draft: text }),
});
const { result, text, sessionId } = await chat.send("帮我起草一封邀请邮件");

<SideChat
  basePath="/linger"
  saveSession={false}
  context={() => `当前邮件主题：${subject}`}
  parseResult={(text) => ({ draft: text })}
  onResult={({ result }) => setMailBody(result.draft)}
/>;
```

`saveSession` 默认 `false`：服务端保留有归属校验的短期会话及附件，不写应用的会话/消息表，也不出现在会话列表；空闲 30 分钟后清理。多进程通过短期归属标记共享访问控制；进程重启后的模型运行态不保证可恢复。`saveSession: true` 会先注册正式会话，再保存用户和助手消息，要求数据库可用。两种模式都要求登录。临时模式不接入长期记忆和工作目录；底层模型 SDK 可能仍生成运行时 transcript，不能将此选项理解为模型侧零留存。宿主若要从 UI 模式切换保存策略，应重新挂载组件，开启一段新聊天。

`apps/web` 的“工作台”提供邮件草稿演示：右侧 SideChat 和“纯接口起草”按钮都能写入左侧主题/正文；“模拟发送”不会调用真实邮箱。

普通聊天和 SideChat 共用附件处理：可搜索的 PDF 会在服务端提取带页码的正文，短文直接送入本轮上下文，完整提取结果保留为会话内的 `.pdf.txt` 文件供后续轮次读取。扫描件若没有可提取文字会返回明确错误；当前不提供 OCR。

## 桌面应用 OTA（可选）

`@turingflow/agent-kit/ota/server` 提供 `createOtaReleaseHandlers({ storageDir, uploadToken, basePath })`，返回 `latest(request)`、`upload(request)`、`artifact(filename)`，由宿主挂载到自己的 HTTP 路由。上传需 Bearer token，Windows 产物为完整 NSIS `.exe` 安装包，macOS 为 `.dmg`。

`@turingflow/agent-kit/ota` 提供 `OtaClient`。宿主传入 `baseUrl`、`platform`、自己的应用 `version`、`downloadDir` 和 `installArtifact(file, release)`；`check()` 查版本，`status()` 读当前状态，`install()` 下载并校验 SHA-256 后调用宿主安装回调。Electron 的 IPC 和启动安装器由宿主实现。agent-kit UI 检测到 `window.agentDesktop.updater` 桥接时，会在侧栏显示更新入口，并在用户菜单显示宿主应用版本与“检查更新”。

基于 CodeBuddy 订阅（`@tencent-ai/agent-sdk`）+ hy3 模型、面向 Next.js（App Router）的一体化 Agent 聊天套件。**目标：第三方应用开箱即用**——宿主工程只需「配环境变量 → 挂 12 个薄路由文件 → 一行装配前端」，全部公共能力（对话 / 产物 / 上传 / 语音 / OAuth 登录 / 会话持久化 / workbuddy 风格三栏 UI）都在 kit 内。

> 本文档写给**应用开发者的 AI**（如 Codex）。所有步骤都是可直接复制执行的样板，请按顺序完成并用末尾「验证清单」自检。

---

## 1. 能力清单

| 能力 | 说明 |
|---|---|
| 订阅式对话 | SSE 流式输出，多轮上下文自动续接（前端按页面生成稳定 sessionId） |
| 断线恢复 | 每轮使用 runId 和事件序号；断线最多重连 5 次，刷新页面可回放尚未保存的答复 |
| 多模态 | 最后一条 user 消息带 `imageUrls[]` 即传图给模型 |
| 工具调用 | 默认 `[Read, Bash, Write]` 白名单，可配置 |
| 产物收集/预览 | 会话内 html / markdown / image / pdf 产物，右侧面板 + 内嵌预览 + 下载 |
| 上传 | 图片/文件上传（落盘 public/uploads + attachments 双份，删会话自动清理） |
| 语音输入 | 录音 → `/api/voice/token` + `/api/voice/transcribe`（小米 MiMo ASR，可换） |
| 组织登录 | 钉钉 / 飞书 OAuth + 客户端 JSAPI 免登 + dev 免登 + 游客模式 |
| 会话持久化 | PostgreSQL：users / agent_sessions / agent_messages，**自动幂等迁移** |
| 聊天 UI | workbuddy 风格三栏（会话列表 / 聊天 / 文件面板），全部参数化 |
| 一站式装配 | `<AgentApp basePath="/linger" />`：登录态 → 聊天 or 登录页自动分流 |
| 链接预览卡（Unfurl） | 用户消息 URL 自动预览：favicon / 域名 / 标题 / 描述 / 缩略图（每条消息仅第一条）；轻量 fetch + Playwright 渲染兜底，SSRF 防护 + 内存缓存 |

对话重连会接回同一个执行实例，不重新提交用户请求。服务端将事件保存在 `AGENT_KIT_RUN_JOURNAL_ROOT`（应用声明了 `AGENT_APP_NAME` 时默认 `~/.<应用名>/run-journal`，否则 `~/.agent-kit/run-journal`）；Web 有多个服务进程时，这个目录必须是共享的持久目录。已结束任务的事件日志保留 7 天。进程中断后超过 45 秒仍无心跳的任务会标为失败，执行结果不明时由用户检查产物后手动重试。模型明确返回的任务错误也直接保留为失败，避免重复执行工具。使用独立 `createChatHandler` 路由的宿主还需挂载 `createChatRunHandler` 的 `GET/POST /api/chat/run`；`createAgentKitApi` 已包含该路由。

## 2. 链接预览卡（链接 Unfurl，可选）

用户消息里的 URL 会在气泡下方渲染一张预览卡（Telegram 口径：每条消息只预览第一条链接，其余保持行内可点）：favicon + 域名 + 标题 + 描述 + 右侧缩略图，抓取失败整体静默，行内链接不受影响。

- **零路由配置**：端点 `GET /api/link-preview?url=...` 由 `createAgentKitApi`（主 catch-all 路由 4.1）一并提供，宿主**无需新增任何文件**；前端 `UserBubble` 已内置。
- **两层抓取**：① 先轻量 `fetch`（超时 6s、≤3 跳重定向、读前 256KB）解析 `og:*` / `twitter:*` / `<title>` / `description` / favicon；② 若静态解析**拿不到标题或描述**（MSN、SPA 等纯 JS 壳页，静态 HTML 只有壳），自动起 **Playwright Chromium** 渲染页面后再取——见下「Playwright 浏览器安装」。
- **SSRF 防护**：只收 http/https；`localhost` / `.local` / `.internal` / `.lan` 及私网 IPv4/IPv6 一律拒绝；重定向每跳重校验；域名解析复核**豁免代理 TUN 的 fake-IP 段**（`198.18.0.0/15`、`fdfe:dcba:9876::/48`），否则开着代理的机器会全站误拦。
- **缓存**：成功 6h / 失败 10min / 上限 500 条；同 URL 并发共享在途请求。
- **内存安全**：Chromium 渲染**串行执行**（promise 链），避免 pro 低内存机器上并发尖峰把内存吃爆；单个页面约 ~200MB 瞬时峰值、首次 ~7s（结果缓存后秒回）。
- **关闭兜底**：设 `AGENT_LINK_PREVIEW_RENDER=0` 可整体禁用无头渲染（降级为静态抓取）。

### 2.1 Playwright 浏览器安装（渲染兜底必看）

`playwright` 已是 kit 的依赖（`npm install` 已装包），但**浏览器二进制需单独下载**，否则兜底拿不到标题/描述时会静默降级（卡片退回静态抓取结果，不报错）。

```bash
# 在 monorepo 根目录（playwright 已随依赖安装）执行：
npx playwright install chromium

# Linux 服务器还需系统库，否则 Chromium 起不来：
npx playwright install-deps chromium    # Debian/Ubuntu 推荐
# 手动装依赖（无 root / 精简镜像）：
# apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
#   libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
#   libpango-1.0-0 libcairo2 libasound2
```

> 本机开发（Electron）通常已通过 `web-fetch` 装过浏览器；**上 pro 等 Linux 服务器前务必补一步 `npx playwright install chromium` + `install-deps`**，否则 JS 壳页（MSN 等）只能拿到壳标题。

---

## 3. 集成架构（宿主只做薄胶水）

```
你的 Next.js 应用
├── 环境变量（复制 kit 的 .env.example）
├── app/layout.js           # 引 agent-kit/styles.css（1 行）
├── app/page.js             # <AgentApp basePath="/linger" />（约 5 行）
├── app/login/page.js       # <LoginPage basePath="/linger" />（server 组件，约 10 行）
└── app/api/**/route.js     # 12 个薄路由文件（每个 3~10 行，全部转发 agent-kit 工厂）
```

kit 侧提供（无需改动）：
- 服务端工厂：`createAgentApiRoute`（chat/upload/voice/artifact）、`createLoginHandlers`、`createSessionHandlers`、`runSdkQuery`/`createAgentStream`
- 前端组件：`AgentApp` / `AgentChat` / `LoginPage` / `DingTalkAutoLogin` / `useAgentAuth`
- 样式：`agent-kit/styles.css`（单文件，含全部聊天/登录样式）

---

## Step 0 — 前置条件

- Node.js ≥ 18，目标工程为 **Next.js App Router**（`next.config.mjs` 需支持 `basePath`）
- 一次性完成 CodeBuddy 登录（浏览器登录，凭据存 `~/.codebuddy`，SDK 持久化、之后自动复用，无需 API Key）。agent-kit 提供安装即用的命令，宿主无需实现认证脚本：
  ```bash
  # 在宿主应用目录下，以运行服务的同一个系统账号执行
  npm run login
  npm run logout
  ```
  在仓库根目录执行这些命令。无桌面的服务器会打印登录链接供手动打开；`--no-open` 可跳过尝试启动浏览器。只有服务账号需要执行，应用最终用户无需逐人登录。
- 国内网络默认 `CODEBUDDY_INTERNET_ENVIRONMENT=internal`（**SDK 已内置默认值，可不配**；国际版设置为 `external`）
- （推荐，否则无会话持久化）PostgreSQL 8+，账号可建库

## Step 0.5 — Agent 模式

`AGENT_PROVIDER` 默认 `codebuddy`。可选 `codebuddy`、`codex`、`cc`、`dsh`；后两者目前是占位，调用会返回 501。聊天请求也可传 `agentMode` 覆盖默认模式，界面支持选择 CodeBuddy 或 Codex。Codex 使用 `@openai/codex-sdk`，复用运行服务的系统账号下的 Codex 登录状态；其原生 thread ID 独立保存以便续接。若 SDK 找不到 CLI，可设置 `CODEX_CLI_PATH=/path/to/codex`。当前 Codex 模式支持文本、工具事件、取消和续接；交互提问、运行中插话与当前图片附件格式尚未接入。

Codex 模式的模型下拉会列出本机 Codex 模型目录和自定义模型。自定义模型文件按 `AGENT_MODELS_PATH`（应用指定的文件或目录）→ 应用主目录 `~/.<AGENT_APP_NAME>/models.json`（未声明名字时为 `~/.agent/models.json`）的顺序查找；找到第一个文件即停止，不合并多个文件。选择自定义模型时，服务端从 `chat/completions` URL 推导 API 根地址，以 Codex 的 `model_providers` 配置和 Responses 协议发起请求；API Key 仅在服务端进程中传给 Codex CLI，不下发前端。该模型的服务端必须支持 `/responses` 与 Codex 所需的工具调用。已用 OpenRouter 条目完成真实调用验证；其他厂商须由其接口能力决定。Codex 自身也可通过 `~/.codex/config.toml` 的 `model_provider`、`[model_providers.<id>]`、`model` 配置默认模型。

## Step 1 — 安装

同一 monorepo 内（`"agent-kit": "workspace:*"` 或相对路径依赖均可）：

```bash
npm install                                   # 根目录安装，或
npm install agent-kit --workspace=your-app    # 给指定应用装
```

peerDependencies：`react >= 18`、`react-dom >= 18`（宿主已有则无需重复安装）。

## Step 2 — 环境变量

把宿主的 `apps/web/.env.example` 复制为 `apps/web/.env` 并填写（agent-kit 本身不再维护 `.env.example`）。**最小可用配置**：

```env
# —— Agent 框架通道（缺省即 codebuddy，一般无需改）——
AGENT_PROVIDER=codebuddy                      # codebuddy（默认）| codex | cc | dsh；决定 agent 运行时

# —— LLM / Agent ——
# 以下两项 SDK 已内置默认值（internal + hy3），**不配也能直接跑**；仅在有特殊需求时显式覆盖。
# CODEBUDDY_INTERNET_ENVIRONMENT=internal     # 国内版默认值（国际版留空）；可省略
# AGENT_MODEL=hy3                              # 允许模型选择时的 SDK 默认值
CODEBUDDY_INTERNET_ENVIRONMENT=internal
AGENT_MODEL=hy3                                # 订阅内免费
# ENABLE_MODEL_SELECT=false                   # 默认允许选择；设为 false 才关闭模型选择
# CODEBUDDY_FALLBACK_MODEL=deepseek-v4.1-flash # 主模型 429 时 CLI 自动切换的兜底（走积分计费，不可与主模型相同）
# 模型下拉：登录 CodeBuddy 后显示本机 SDK 内置模型 + 按上述顺序选中的单个 models.json；
# 未登录时仅显示 models.json。自定义模型不跨文件合并，每次加载重新读取文件。
# 设置 CUSTOM_MODEL_ONLY=true 后，无论登录状态如何，CodeBuddy 模型下拉仅显示选中的 models.json 自定义模型。

# —— 日志（可选，排查问题时建议开 debug）——
# AGENT_KIT_LOG_LEVEL=info

# —— 认证方式 ——
# 支持多值（, 或 | 分隔）。guest（游客模式）与 dev（开发免登）已移除，必须真实登录：
#   feishu            → 单方式：登录页直接 302 到飞书 OAuth，不出现选择器
#   dingtalk|feishu   → 多方式：登录页渲染黑白灰登录方式选择器
#   none              → 关闭登录
AUTH_PROVIDER=feishu

# 内置账号登录示例：AUTH_PROVIDER=builtin|dingtalk|feishu
# 配好 POSTGRES_* 后，登录页支持自助注册（用户名 3–128 位，密码至少 6 位）。
# 内置账号与钉钉/飞书账号按 provider 分区，默认互不合并；同一人使用不同方式登录
# 会获得不同的会话、文件和分享归属。账号合并需要后续单独设计与迁移。
AUTH_COOKIE_PATH=/linger    # 必须与 Next basePath 完全一致
AUTH_SESSION_SECRET=replace_with_a_long_random_secret
AUTH_SECURE_COOKIE=false   # 本地 http 必须 false；生产 https 必须 true

# —— 数据库（PostgreSQL；必填，数据强制落库，无开关）——
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_DB=linger
POSTGRES_PASSWORD=your_password

# —— 语音（可选；不填则语音按钮自动禁用）——
AGENT_KIT_ASR_PROVIDER=xiaomi
AGENT_KIT_ASR_HOST=https://your-asr-host.example.com
AGENT_KIT_ASR_API_KEY=

# —— 钉钉 OAuth（AUTH_PROVIDER=dingtalk 时必填）——
DD_CLIENT_ID=xxx
DD_CLIENT_SECRET=xxx
DD_CORP_ID=xxx
# 企业内部应用微应用 AgentId：分享到钉钉会话（H5 JSAPI dd.config 前端鉴权）必填，缺失报「无效的agentid」
DD_AGENT_ID=xxx

# —— 飞书 OAuth（AUTH_PROVIDER=feishu 时必填）——
# 仅支持企业内部应用（ISV 应用商店应用未实现）
# FS_APP_ID=xxx
# FS_APP_SECRET=xxx
# 可选：国际版改 https://app.feishu.com（国内默认 open.feishu.cn）
# FS_BASE_URL=https://open.feishu.cn
# 可选：OAuth 回调地址，默认自动拼接为 <origin><AUTH_COOKIE_PATH>/api/auth/callback
# web（:3100，basePath /linger）：http://localhost:3100/linger/api/auth/callback
# local（:17800，cookiePath /）：http://127.0.0.1:17800/api/auth/callback
# FS_REDIRECT_URI=
```

> 提示：`APP_PUBLIC_URL` 不填时自动从请求推断（本地开发无需配置）；生产部署建议显式设置外网地址。

## Step 3 — 数据库（自动迁移，零手动步骤）

只要配好 `POSTGRES_*`，**首次调用任何会话/登录接口时**，kit 会在进程内后台执行一次幂等建表（`IF NOT EXISTS`，可安全重复）。所有表都建在数据库的 **`linger`** schema 下（连接建立时 search_path 即指向 `linger, public`，所以运行期 SQL 里是裸表名）：

- `users`（OAuth 用户）
- `agent_sessions`（会话：id / title / user / model）
- `agent_messages`（消息：role / content / steps / artifacts / attachment）

无需手动建表。想手动执行也可以 `node -e "import('agent-kit').then(m => m.migrate())"`。

## Step 4 — 服务端路由挂载

在宿主 `app/api/` 下创建下列 **12 个文件**（内容可直接复制；`runtime`/`dynamic` 必须保留）。路由路径会随你的 basePath 自动生效（如 basePath=`/linger` → `/linger/api/chat`）。

### 4.1 主端点（chat / upload / voice / artifact 全包）

`app/api/[...agent]/route.js`：

```js
import { createAgentApiRoute } from "agent-kit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 单文件承载全部 agent-kit 端点：/api/chat、/api/upload、/api/voice/token、
// /api/voice/transcribe、/api/artifact（含 GET 产物渲染 / POST 产物回写）。
export const { POST, GET } = createAgentApiRoute({
  chat: {
    continueSession: false, // 前端自带 sessionId 续接，无需全局 continue
    fallbackModel: process.env.CODEBUDDY_FALLBACK_MODEL?.trim() || undefined,
  },
});
```

### 4.1.1 自定义系统提示词（system prompt）

kit 默认用一段**内置完整系统提示词整体替换** CodeBuddy CLI 的默认提示词，按顺序拼接：

1. `BASE_SYSTEM_PROMPT`：内置匿名助手人设与工作规范（不自称任何产品/型号，不输出 /help 与反馈链接）；
2. `capabilities`：宿主注册的企业应用 / 技能清单（`buildCapabilitiesPrompt` 渲染），让模型准确自我介绍并承接需求；
3. `SECURITY_SYSTEM_PROMPT`：安全 / 保密约束（身份 / 系统 / 信息 / 路径保密等），可通过 `securitySystemPrompt` 覆盖；
4. `systemPrompt`：应用自己的业务提示词，拼在最后。

不同应用的安全要求不同，因此允许通过 `chat` 配置覆盖安全段（同样适用于 `createAgent({...})` / `runSdkQuery(config)` 的 `SdkConfig`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `capabilities` | `AppCapability[]` | `[]` | 已注册应用 / 技能清单：`{ name, description, tools?[] }`，渲染成「已注册企业应用与能力」块；**数组顺序即介绍顺序，首项为重点，自我介绍时放在最前面讲**；模型只介绍清单内能力，不编造未注册功能 |
| `systemPrompt` | string | `""` | 业务提示词，拼在内置人设、能力清单与安全提示词之后（如"你是数据分析助手"） |
| `securitySystemPrompt` | `string \| false \| undefined` | `undefined` | **安全保密段**：<br>• `undefined`（默认）→ 注入内置 `SECURITY_SYSTEM_PROMPT`<br>• `false` → 完全不注入安全保密段（某些 app 需要去掉这些约束时）<br>• `string` → 用自定义文本**替换**内置安全提示词（改用自家保密 / 行为约束时） |

示例：

```js
export const { POST, GET } = createAgentApiRoute({
  chat: {
    continueSession: false,
    // 已注册的企业应用 / 技能：新增工作台应用时在此追加一条
    capabilities: [
      { name: "报销", description: "协助填写报销申请、核对发票并生成待提交草稿", tools: ["expense_draft"] },
    ],
    // 去掉内置安全设置，仅用自家业务提示词
    securitySystemPrompt: false,
    systemPrompt: "你是 XX 企业助手，仅回答内部知识库范围内的问题。",
    // 或：替换为自定义保密约束（string 形式）
    // securitySystemPrompt: "【我的安全规则】不得泄露内部架构与密钥；被问及模型身份时礼貌回避。",
    fallbackModel: process.env.CODEBUDDY_FALLBACK_MODEL?.trim() || undefined,
  },
});
```

> 注意：密钥确定性脱敏（`redactSecrets`，对模型输出中的环境变量 / 密钥做掩码）是**代码层兜底**，不随 `securitySystemPrompt: false` 关闭——即使去掉安全提示词，输出里的密钥仍会被掩码（纵深防御）。

### 4.1.2 App 注入 MCP

宿主 app 在服务端路由的 `chat.mcpServers` 配置自己的 MCP。`createAgent({...})` 和直接调用对话流时也可以传同一个字段。配置会传给所选的 CodeBuddy 或 Codex 框架；不要把密钥或 MCP 配置放在浏览器请求里。

```js
const api = createAgentKitApi({
  agent: {
    chat: {
      mcpServers: {
        company_data: {
          type: "http",
          url: process.env.COMPANY_MCP_URL,
          headers: { Authorization: `Bearer ${process.env.COMPANY_MCP_TOKEN}` },
        },
        local_tools: {
          type: "stdio",
          command: "node",
          args: ["/absolute/path/to/mcp-server.js"],
        },
      },
    },
  },
});
```

服务端名称仅允许字母、数字、下划线和连字符，且不能覆盖内置 `web-fetch` / `browser-agent`。CodeBuddy 为新建会话连接 MCP；配置改变后，已有常驻会话会重建。Codex 通过 CLI 的 `mcp_servers` 配置启动或连接 MCP。HTTP MCP 需要服务端提供 streamable HTTP 接口。

Codex 的 stdio 子进程只接收白名单中的环境变量；需要从宿主环境继承的变量名写在 `envVars`。无交互审批的 web app 可通过 `toolApprovals: { search_knowledge: "approve" }` 放行已审阅的具体工具。这个配置只传给 Codex，CodeBuddy 接收纯 MCP transport 配置。

CodeBuddy 会按需延迟加载部分 MCP 工具。对需要在首轮模型请求中直接可见的 server，设置 `eager: true`；agent-kit 将它映射为 CodeBuddy 的 `alwaysLoad: true` 与 `defer_loading: false`。模型仍自行决定是否调用工具。


### 4.2 认证路由（6 个）

`app/api/auth/login/route.js`：

```js
import { createLoginHandlers } from "agent-kit";
export const runtime = "nodejs";
export const { GET } = createLoginHandlers().login;   // 跳 OAuth 授权页 / dev 免登
```

`app/api/auth/callback/route.js`：

```js
import { createLoginHandlers } from "agent-kit";
export const runtime = "nodejs";
export const { GET } = createLoginHandlers().callback; // code 换用户 → 落库 → 写 Cookie → 重定向
```

`app/api/auth/sso/route.js`：

```js
import { createLoginHandlers } from "agent-kit";
export const runtime = "nodejs";
export const { POST } = createLoginHandlers().sso;     // 客户端 JSAPI 免登
```

`app/api/auth/session/route.js`：

```js
import { createLoginHandlers } from "agent-kit";
export const runtime = "nodejs";
export const { GET } = createLoginHandlers().session;  // 当前登录态
```

`app/api/auth/logout/route.js`：

```js
import { createLoginHandlers } from "agent-kit";
export const runtime = "nodejs";
export const { POST } = createLoginHandlers().logout;  // 清除会话 Cookie
```

`app/api/auth/profile/route.js`：

```js
import { createLoginHandlers } from "agent-kit";
export const runtime = "nodejs";
export const { PATCH } = createLoginHandlers().profile; // 改自己的展示名 / 头像
```

`PATCH` body 只接受 `{ name?: string; avatar?: string }`：

- `name`：去空白后 1–24 字符，直接覆盖 `users.name`。
- `avatar`：`data:image/(png|jpeg|webp);base64,...`，解码后 ≤ 256KB，直接覆盖 `users.avatar`。
- 覆盖后不会被下次登录冲掉：登录 upsert 只在库里该列为空时才写入本次档案（`name = COALESCE(NULLIF(users.name,''), EXCLUDED.name)`）。代价是认证提供方（钉钉 / 飞书）之后改昵称、换头像不会再同步到已有用户。
- `user_code`（工号 / 内置账号用户名）属于身份主数据，**不可改**；`/api/auth/session` 会以 `userCode` 字段返回它，供界面只读展示。
- 会话 Cookie 会随响应重签（Set-Cookie），网页端其他读取 cookie 的位置立刻看到新值；`/api/auth/session` 本身以 `users` 表为准，桌面端不依赖 cookie 快照。

### 4.3 会话管理路由（6 个）

`app/api/sessions/route.js`：

```js
import { createSessionHandlers } from "agent-kit";
export const runtime = "nodejs";
const { list, create } = createSessionHandlers();
export const GET = list;      // 会话列表
export const POST = create;   // 注册新会话
```

`app/api/sessions/[id]/route.js`：

```js
import { createSessionHandlers } from "agent-kit";
export const runtime = "nodejs";
const { rename, remove } = createSessionHandlers();
export const PATCH = rename;  // 重命名
export const DELETE = remove; // 删除（含清理磁盘产物/附件）
```

`app/api/sessions/[id]/messages/route.js`：

```js
import { createSessionHandlers } from "agent-kit";
export const runtime = "nodejs";
const { messages, appendMessage } = createSessionHandlers();
export const GET = messages;   // 历史消息
export const POST = appendMessage;
```

`app/api/sessions/[id]/auto-title/route.js`：

```js
import { createSessionHandlers } from "agent-kit";
export const runtime = "nodejs";
const { autoTitle } = createSessionHandlers();
export const POST = autoTitle;
```

`app/api/sessions/[id]/close-sdk/route.js`：

```js
import { createSessionHandlers } from "agent-kit";
export const runtime = "nodejs";
const { closeSdk } = createSessionHandlers();
export const POST = closeSdk;
```

`app/api/sessions/[id]/truncate/route.js`：

```js
import { createSessionHandlers } from "agent-kit";
export const runtime = "nodejs";
const { truncate } = createSessionHandlers();
export const POST = truncate;
```

## Step 5 — 前端装配

### 5.1 `next.config.mjs`（basePath 与 AUTH_COOKIE_PATH 一致）

```js
const nextConfig = {
  basePath: "/linger",
  // ...其余配置
};
export default nextConfig;
```

### 5.2 `app/layout.js`

```jsx
// 聊天 UI 全部样式来自 agent-kit 单一来源；应用级覆盖写在自己的 globals.css
import "agent-kit/styles.css";
import "./globals.css";

export const metadata = { title: "AI 助手", description: "agent-kit 聊天" };

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
```

### 5.3 `app/page.js`（一站式装配，宿主最少代码）

```jsx
"use client";
// 登录态 / 游客模式 / 聊天 UI / 登录页分流全部由 agent-kit 处理
import { AgentApp } from "agent-kit/ui";

export default function HomePage() {
  return (
    <div style={{ position: "relative", minHeight: "100vh" }}>
      <AgentApp
        basePath="/linger"
        title="AI 助手"                       // 聊天顶栏标题
        sidebarLogo="/linger/logo.png"         // 左栏顶部 Logo（可选）
        defaultShowModel={false}               // 默认隐藏模型，用户仍可在菜单中手动开启
        // 可继续透传 ChatWindowProps：scenes / logoSrc / uploadEnabled / voiceEnabled ...
      />
    </div>
  );
}
```

### 5.4 `app/login/page.js`（登录页，AUTH_PROVIDER 驱动）

```jsx
import { redirect } from "next/navigation";
import { getLoginOptions } from "agent-kit";
import { LoginPage } from "agent-kit/ui";

// AUTH_PROVIDER 决定登录页行为：
//   - 单个真实登录方式（不含 guest）→ 服务端直接 302 到该方式 OAuth，无选择器
//   - 仅 guest → 302 到 ?guest=1
//   - 多个（如 feishu|guest）→ 渲染黑白灰登录方式选择器
export default function LoginPageRoute({ searchParams }) {
  const params = searchParams || {};
  const options = getLoginOptions();
  const root = options.cookiePath; // = Next basePath，如 /linger

  const rawNext = typeof params.next === "string" ? params.next : "";
  const safeNext = rawNext.startsWith(root) ? rawNext : `${root}/`;
  const total = options.providers.length + (options.hasGuest ? 1 : 0);

  if (total === 1) {
    if (options.hasGuest) redirect(`${root}/?guest=1`);
    redirect(
      `${root}/api/auth/login?provider=${encodeURIComponent(options.providers[0].id)}&next=${encodeURIComponent(safeNext)}`,
    );
  }

  return (
    <LoginPage
      basePath={root}
      title="AI 助手"
      error={typeof params.error === "string" ? params.error : undefined}
      next={safeNext}
      providers={options.providers}
      hasGuest={options.hasGuest}
    />
  );
}
```

钉钉 App 内免登：把 `<DingTalkAutoLogin basePath="/linger" clientId={process.env.DD_CLIENT_ID} corpId={process.env.DD_CORP_ID} />` 作为 `LoginPage` 的 children 传入（`LoginPage` 由服务端页面渲染，直接在服务端读取 env 传入即可，无需 NEXT_PUBLIC_ 前缀）。

> 登录页不再绘制标题：`title` 只作为 `<main>` 的无障碍名称，卡片顶部直接是登录表单（桌面端登录窗口的标题栏同时留空）。
> 深浅色由 `LoginPage` 内置的首帧脚本决定，优先级 `?theme=light|dark`（桌面端按当前外观传入）→ `localStorage["agent-kit:theme"]` → 系统偏好。

### 5.5 `LoginPage` 的 `providers` / `hasGuest`

`getLoginOptions()`（服务端）返回：

| 字段 | 说明 |
|---|---|
| `providers` | 可用的真实登录方式（`[{id, name}]`，id ∈ dingtalk/feishu/dev；OAuth 已按 env 过滤是否配置完整） |
| `hasGuest` | `AUTH_PROVIDER` 是否含 `guest` |
| `cookiePath` | 会话 Cookie 路径（= basePath），登录跳转均基于它 |

`LoginPage` 只负责渲染选择器（多方式场景）；单方式由上面的 `redirect` 处理，不会走到组件。

## Step 6 — 验证清单（AI 自检）

按顺序执行，全部通过即集成成功：

1. **安装/编译**：`npm run typecheck -w agent-kit` 无 TS 错误；宿主 `npm run dev` 启动无编译报错
2. **页面可达**：`curl -I http://localhost:3100/linger` → 200；`/linger/login` → 200
3. **游客模式**：访问 `/linger?guest=1` → 出现三栏聊天 UI（左栏会话列表、中栏输入框、右栏按钮）
4. **发送消息**：发一条消息 → 用户消息立即置顶、模型 SSE 流式回复逐字出现；回复结束出现负责人卡片
5. **产物链路**：让模型生成一份 html → 回复内出现产物卡片；右侧「输出产物」面板出现该文件；点击打开内嵌预览；下载按钮可下载
6. **会话持久化**（需数据库）：刷新页面 → 历史消息恢复；左侧会话列表出现新会话并带自动标题；发送第二条消息 → 标题更新
7. **登录态**（AUTH_PROVIDER=dev）：访问 `/linger` → 直接进入已登录聊天；点击用户区域 → 退出登录 → 跳 `/linger/login`
8. **删除清理**：删除会话 → 对应产物/附件文件从磁盘移除（public/uploads、attachments）
9. **安全隔离**：未登录直接请求 `GET /linger/api/artifact?session=<任意>&list=1` → 403；游客续接他人会话（无令牌/错令牌）→ 403；正常登录/游客对话与产物预览不受影响

## Step 7 — 安全隔离模型（集成 AI 必读）

kit 内置**按用户隔离**的会话访问控制：任何用户只能访问**自己**会话的数据（消息 / 产物 / 常驻 CLI 会话），
且**智能体（模型工具链）不能被绕过**。分四层实现：

### 7.1 端点鉴权矩阵

| 端点 | 登录用户 | 游客（guest=1） | 无登录 |
|---|---|---|---|
| `POST /api/chat`（首轮 resume=false） | 会话 Cookie → DB `agent_sessions.user_id` 归属校验 | 须带 `sessionToken`（`guest-` 前缀会话，首轮自动绑定） | 403 |
| `POST /api/chat`（续接 resume=true） | 同上（DB 无此会话 → 403） | 令牌必须匹配首轮绑定值 | 403 |
| `POST /api/chat/answer` | 同上 | 同令牌 | 403 |
| `POST /api/chat/steer` | 同上 | 同令牌 | 403 |
| `GET /api/artifact?session=...&file=...` | 会话 Cookie → DB 归属 | URL 须带 `ticket`（HMAC 签名，24h 过期） | 403 |
| `GET /api/artifact?...&list=1` | 同上 | 同 ticket | 403 |

403 响应体统一为 `{ "error": "无权限访问该会话..." }`，前端不需要特殊处理。

### 7.2 游客两层凭证（无登录场景）

游客会话不落库（内存态 `guest-<uuid>`），因此用两层凭证取代 Cookie：

- **会话令牌 `sessionToken`**：前端每次进入游客模式生成（`crypto.randomUUID()`），随 chat/answer/steer
  请求体发送。服务端首轮绑定到该会话、后续轮必须匹配、12h 自动过期，刷新页面即失效——
  与"游客对话不保存"语义一致。
- **产物票据 `ticket`**：产物在 iframe / `<img>` / 下载链接中无法带请求头，故由服务端在每轮 SSE 流
  开头下发 `event: access_ticket`，前端缓存后拼到产物 URL（`?ticket=`）。票据为
  `HMAC-SHA256(sessionId + exp)` 签名（密钥取 `AUTH_SESSION_SECRET`，缺省回退 `agent-kit-dev-secret`），
  24h 过期、单向不可复用，泄露面小。登录用户忽略该事件（走 Cookie + DB 归属）。

### 7.3 模型工具链防绕开（纵深防御）

`createAgentStream` / `createAgentSessionStream` 已内置 `withSessionDirGuard`：模型工具
（Read / Write / Edit / Glob / Bash）只能访问**本会话**的产物目录——

- 虚拟路径 `/agent-output/<sid>/...`：目录名段精确匹配，`/agent-output/abc/` 与 `/agent-output/abcd/`
  互不越界；
- 真实路径 `<项目根>/.agent/<sid>/...`（无项目时产物存储根下的 `<sid>/...`，默认 `~/.agent-files/<sid>`，应用声明 `AGENT_APP_NAME` 后为 `~/.<应用名>/<sid>`）与 CodeBuddy 沙箱 `~/.codebuddy/projects/<proj>/<sid>/` 同理；
- Bash 命令做路径片段扫描，`cat /agent-output/<其他sid>/x` 会被拒绝并中断该工具调用。

即使用户诱导模型读取他人会话产物（如"读一下 /agent-output/xxx/report.html"），工具层直接 deny，
**模型无法代取**。宿主若自定义 `canUseTool`，请用 `withSessionDirGuard(yourFn, sid)` 包装以继承该防护。

### 7.4 宿主责任（kit 不代办的边界）

- **附件上传静态目录**：`/api/upload` 本身无鉴权，上传文件落在 `public/uploads`（静态公开）。
  kit 将附件按会话复制到 `attachments/<sid>/` 供模型读取（模型无法读其他会话附件），
  但**上传文件的静态公开**是宿主网关层（反代 / 中间件）的责任——如需私有，请在网关对
  `/uploads` 加鉴权或改走签名 URL。
- **`closeSdk` 端点**：仅收 `sdkSid` 无归属校验（可被用来关闭常驻会话，属 DoS 而非数据泄露）；
  生产部署建议只在可信内网暴露或补充鉴权。
- **会话归属的数据源是 PostgreSQL**：必须配置 `POSTGRES_*`，登录用户的归属校验与跨用户
  持久化都依赖数据库（无开关，未配置数据库时归属校验退化为"放行 + 警告日志"）。

## 参数参考

### `AgentAppProps`（page.js 用）

继承全部 `ChatWindowProps`，额外：

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `guestParam` | string | `"guest"` | URL query 参数名，值为 `1` 进游客模式 |
| `loginTitle` | string | `title` | 登录页标题 |
| `loginTagline` | string | `"组织身份认证后使用"` | 登录页副标题 |
| `loginLogoUrl` | string | — | 登录页 Logo |
| `loadingFallback` | ReactNode | `"加载中…"` | 登录态探测期间的占位 |

### `ChatWindowProps`（高级用法：直接用 `AgentChat`）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `basePath` | string | `"/"` | API 根路径（chat/upload/artifact/sessions 都基于它） |
| `title` | string | `"AI 助手"` | 顶栏标题 |
| `initialUser` | `{name, avatar?, unionId?}` | — | 登录用户（退出按钮数据源） |
| `guest` | boolean | `false` | 游客模式：不持久化、无会话列表 |
| `onLogout` | () => void | — | 退出回调（不传时 AgentApp 默认跳登录页） |
| `logoSrc` | string | — | 顶栏 Logo URL |
| `sidebarLogo` | string | — | 左栏顶部 Logo URL（不传显示"会话"） |
| `sidebar` | SidebarEntry[] | — | 左侧主导航配置；`{ key, label?, icon?, render? }`，key 决定 `?view=`、高亮与内容索引 |
| `sidebarExpanded` | boolean | `false` | 桌面端展开主导航并常显文字；移动端仍使用底部导航 |
| `sidebarWidth` | number | `160` | 展开时桌面端主导航宽度，单位 px |

宿主侧栏应用可以调用 `useAppFullscreen()`：

```tsx
import { useAppFullscreen } from "@turingflow/agent-kit/ui";

function MyApp() {
  const { isFullscreen, setFullscreen } = useAppFullscreen();
  return <button onClick={() => setFullscreen(!isFullscreen)}>
    {isFullscreen ? "取消全屏" : "全屏"}
  </button>;
}
```

全屏时主导航隐藏；按 Esc 或切换导航会退出全屏。应用可以自行隐藏内部工具栏并在鼠标移到顶边时显示。
| `scenes` | Scene[] | 内置 | 场景 tab（传 `null` 隐藏）；每项 `{ key, label, suggestions, prompt? }`，`prompt` 为该场景专属系统提示词，切换后随每轮消息注入 AI。`suggestions` 为 `SceneSuggestion[]`：`{ label, sendOnClick?, prompt? }`，`label` 为建议文案；`sendOnClick` 缺省 `true`（点击即发送），`false` 时点击仅把 `label` 放入输入框、由用户补充后手动发送；建议级 `prompt` 随该建议触发的发送注入（与场景级按序拼接） |
| `uploadEnabled` | boolean | `true` | 是否启用附件上传 |
| `voiceEnabled` | boolean | `true` | 是否启用语音输入 |
| `defaultShowModel` | boolean | `true` | “显示模型”的默认值；用户手动设置的偏好优先 |
| `chatEndpoint` / `uploadEndpoint` | string | 由 basePath 推导 | 端点覆盖 |
| `renderSessionFooter` | `(context: { sessionId, messages }) => ReactNode` | — | 在会话底部渲染一次宿主内容，可按会话决定是否显示 |
| `sessionFooterVisibility` | `"always" \| "after-response"` | `"after-response"` | 宿主卡片始终显示，或等当前答复结束后显示 |
| `sessionFooterAppearing` | boolean | `true` | 宿主卡片出现时播放透明度渐入动画 |

例如，宿主可以在热线会话底部放置人工联系卡片：

```jsx
<AgentApp
  basePath="/linger"
  renderSessionFooter={({ sessionId }) => (
    <div className="hotline-contact-card" data-session-id={sessionId}>
      <strong>需要人工帮助？</strong>
      <a href="tel:12345">联系热线 12345</a>
    </div>
  )}
/>
```

#### 自定义左侧导航

`sidebar` 接受完整配置，宿主可以增删导航项、换文案与图标，或挂载自己的页面（不再依赖环境变量）：

```jsx
<AgentApp
  basePath="/linger"
  sidebarExpanded
  sidebarWidth={180}
  sidebar={[
    { key: "home", label: "协同中心" },                    // 内置项：可覆盖 label/icon
    { key: "library" },
    { key: "workbench", label: "工作台", render: () => <Workbench /> },
    // 自定义 key：label、icon、render 三者自备
    { key: "approvals", label: "审批", icon: <ApprovalIcon />, render: () => <Approvals /> },
  ]}
/>
```

- `key` 是唯一标识，同时决定 URL 的 `?view=<key>`、激活态与内容索引；刷新或前进/后退都能恢复。
- `icon` 可以是节点，也可以是 `({ selected }) => ReactNode` 以响应选中态。
- `home` 与其他内置项一样，可用 `label` 和 `icon` 覆盖默认文字与图标。
- `render` 决定中栏内容，同 key 可覆盖内置页面（`home` 始终是对话视图）。
- `render` 的内容也能被 `openWorkPanelSurface({ kind: "app", id })` 按 id 调到，嵌进右栏面板。
- 只有 `home`（或为空）时不渲染导航栏。

### 公共导出清单

```
agent-kit            → createAgentApiRoute / createLoginHandlers / createSessionHandlers /
                        createAgentStream / runSdkQuery / Agent / createUploadHandler /
                        createArtifactHandler / WebFetch / migrate / isAuthEnabled ...
agent-kit/ui         → AgentApp / AgentChat(ChatWindow) / LoginPage / DingTalkAutoLogin /
                        useAgentAuth / Markdown / FeedbackButtons / 全部 TS 类型
agent-kit/styles.css → 全部样式（聊天 + 登录），单文件引入
```

## 目录结构

```
packages/agent-kit/
├── README.md
├── package.json           # exports: "."(server) / "./ui" / "./styles.css"
├── tsconfig.json          # 服务端
├── tsconfig.ui.json       # UI（DOM lib + react-jsx）
└── src/
    ├── server/
    │   ├── index.ts        # 主入口（工厂 + SDK 导出）
    │   ├── sdk.ts          # runSdkQuery / createAgentStream / createAgentSessionStream
    │   ├── agent.ts        # Agent 工厂（多工具轮 / steer / resume）
    │   ├── handlers.ts     # createAgentApiRoute（chat/upload/voice/artifact）
    │   ├── artifacts.ts    # 产物类型推断 / 渲染 / 列表 / 下载
    │   ├── upload.ts       # 上传落盘（public/uploads + attachments）
    │   ├── voice.ts        # 语音令牌
    │   ├── transcription/  # ASR 提供方（xiaomi-mimo）
    │   ├── sessions.ts     # createSessionHandlers（列表/改名/删除/消息/标题）
    │   ├── session-store.ts
    │   ├── link-preview.ts # 链接预览卡（OG 解析 + Playwright 渲染兜底 + SSRF + 缓存）
    │   ├── web-fetch.ts    # WebFetch MCP 工具
    │   ├── cli.ts          # 交互式订阅对话 CLI；登录命令见宿主应用
    │   └── auth/
    │       ├── schema.sql  # 幂等建表（自动迁移）
    │       ├── db.ts       # 连接池 / migrate / 会话与消息 CRUD
    │       ├── handlers.ts # createLoginHandlers（login/callback/sso/session/logout）
    │       ├── session.ts  # Cookie / 会话令牌
    │       ├── config.ts   # env 解析（AUTH_PROVIDER 等）
    │       └── providers/  # dingtalk / feishu 抽象
    └── ui/
        ├── index.ts        # /ui 入口
        ├── AgentApp.tsx    # 一站式装配（认证分流）
        ├── useAgentAuth.ts # 登录态 hook
        ├── LoginPage.tsx   # 登录页（server-safe）
        ├── DingTalkAutoLogin.tsx
        ├── ChatWindow.tsx  # 主聊天组件（全部 UI 逻辑）
        ├── Markdown.tsx / FeedbackButtons.tsx
        └── styles.css
```

## Web Push（离线推送，可选）

用于页面不在前台时弹出系统级通知。开箱即用，**宿主无需任何额外文件**。

- 服务端 env 配齐 `WEB_PUSH_PUBLIC_KEY` / `WEB_PUSH_PRIVATE_KEY` / `WEB_PUSH_SUBJECT`（vapid 密钥 + 主题邮箱）即启用；缺任意一项则不注册、不报警。
- Service Worker 脚本由 agent-kit 自带并自托管：宿主 catch-all 路由会响应 `GET {basePath}/api/sw`，并设置 `Service-Worker-Allowed: {cookiePath}` 把 scope 放开到 `{basePath}/`。**不要再在 `public/` 里放 `sw.js`**。
- 脚本路径与 scope 完全由 `self.registration.scope` 推导，basePath 为 `/linger`、`/si`、`/` 等任意部署均正确。
- 想用宿主自己的脚本，可传 `ensureWebPushSubscription(basePath, { serviceWorkerUrl: "${basePath}/sw.js" })` 覆盖。
- 推送 payload 的回跳地址自动取 `AUTH_COOKIE_PATH`（= 部署 basePath），不再写死部署子路径。

## FAQ

### 群 AI 与连接授权

群 AI 在右侧面板管理。群创建者可添加、重命名、编辑提示词、停用和删除 AI；启用的 AI 出现在群输入框的 `@` 列表。独白记录按 AI 显示。群成员均可为某个 AI 添加连接，连接默认仅添加者可用，添加者可授权当前群的指定成员。退出或被移出群时，其授权会清除，自己添加的连接会停用。

连接凭据使用 AES-256-GCM 加密后写库。`COWORK_SECRET_KEY` 可选，填写 32 字节随机值的 base64（可用 `openssl rand -base64 32` 生成）；未配置时使用系统内置默认密钥。生产环境建议配置独立密钥，所有实例保持一致并安全备份；内置默认密钥公开于源码，不提供部署间的凭据隔离。配置的密钥格式无效时新增连接返回 503。列表 API 不返回凭据明文。当前连接用于保管与授权登记；具体服务的发布执行器需要独立接入，并在执行前重新校验发起人、授权、目标与确认，不得把明文传给模型。

- **登录页报"认证应用配置不完整"**：检查 `AUTH_PROVIDER` 与对应提供方 env（DD_* / FS_*）是否齐全。
- **模型 429**：配置 `CODEBUDDY_FALLBACK_MODEL`（不可与主模型相同），CLI 自动切换。
- **历史消息为空**：确认 `POSTGRES_*` 可达（自动迁移只在首次连接时跑一次，若此前连失败需重启进程）。
- **语音按钮不可用**：`AGENT_KIT_ASR_HOST/API_KEY` 未配置（预期行为）。
- **产物/附件磁盘**：声明了 `AGENT_APP_NAME` 时产物存储根就是应用主目录 `~/.<应用名>`（与 `chats/`、`models.json` 同级），未声明时为 `~/.agent-files`；选了项目时交付文件直接写项目，中间草稿留在产物存储根 `artifacts/<sid>/_drafts`；附件在 `public/uploads/`、`attachments/`；删除会话时按消息记录清理。
- **改完代码**：宿主（web / launcher）直接编译 kit 的 `src`，dev 下热更新即可；kit 是私有源码 workspace 包，不发布 npm，也没有 `dist/` 构建步骤。

### 界面语言

`AgentApp` 和 `AgentWindow` 接受 `locale` 参数（`"zh-CN"` 或 `"en"`），由宿主传入当前界面语言；未指定时默认简体中文。切换参数会更新已接入翻译的聊天组件。翻译资源由 kit 自行维护，位于 `src/ui/chat/locales/`。
