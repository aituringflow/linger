/**
 * agent-kit · 登录页组件（server-safe，无 hooks）
 *
 * 由 AUTH_PROVIDER 驱动：宿主服务端用 getLoginOptions() 拿到登录方式清单后，
 * 本组件只负责渲染：
 *   - providers 有多个 → 登录方式选择列表（每个按钮带 ?provider=xxx）
 *   - 都为空 → 提示无可用的登录方式
 *
 * 单个真实登录方式不应走到本组件——宿主服务端直接 redirect 到
 * /api/auth/login?provider=xxx 即可（见 apps/web/src/app/login/page.js 样板）。
 *
 * 若要接入钉钉 App 内 JSAPI 免登，把 <DingTalkAutoLogin ... /> 作为 children 传入。
 */
import type { ReactNode } from "react";
import { BuiltinLoginForm } from "./BuiltinLoginForm.tsx";

export interface LoginProviderOption {
  /** 登录方式标识：dingtalk | feishu | builtin（builtin 自建登录待实现，类型先留口子） */
  id: "dingtalk" | "feishu" | "builtin";
  /** 按钮文案，如"飞书登录" */
  name: string;
}

export interface LoginPageProps {
  /** API 根路径（= cookiePath，如 /agent；登录端点都基于它） */
  basePath: string;
  /**
   * 页面标题（默认 "AI 助手"）。
   * 登录页不再绘制标题——只作为 <main> 的无障碍名称，避免卡片顶部再出现一行 "Agent"。
   */
  title?: string;
  /** 登录页 Logo URL（可选） */
  logoUrl?: string;
  /** 登录失败错误码：config/state/network/organization（内置文案映射）或任意文案 */
  error?: string;
  /** 登录成功后的回跳路径（仅接受以 basePath 开头的路径，防开放重定向） */
  next?: string;
  /** 可用的真实登录方式列表（getLoginOptions().providers） */
  providers?: LoginProviderOption[];
  /**
   * App 通过 URL 传入的登录方式（?providers= 的原始值）。
   * 透传给 builtin 表单，使其提交时带上，让登录 API 与登录页用同一套解析规则校验
   * （否则会出现「页面显示了账号登录，API 却拒绝 → 登录方式不可用」）。
   */
  loginProviders?: string;
  /** 可选平台图标 URL；未提供时显示文字图标。 */
  providerIcons?: Partial<Record<"dingtalk" | "feishu", string>>;
  /**
   * 宿主服务端检测的客户端环境（adaptive 场景）：
   *   - "dingtalk"：已在钉钉 App 内 → 不渲染选择器，只显示免登状态与钉钉回退按钮（先检测后登录）
   *   - "none" / 缺省：普通浏览器（既不在飞书也不在钉钉）→ 渲染登录方式选择器
   *   - "feishu"：飞书 App 内由宿主直接 302 OAuth，不会走到本组件渲染
   */
  detected?: "dingtalk" | "feishu" | "none";
  /** 额外内容（如钉钉免登组件），插在登录按钮列表下方 */
  children?: ReactNode;
}

const ERROR_MESSAGES: Record<string, string> = {
  config: "认证应用配置不完整，请联系管理员",
  state: "登录请求已失效，请重新发起登录",
  network: "暂时无法连接认证服务，请稍后重试",
  organization: "当前账号不属于本企业组织",
};

/**
 * 主题引导脚本：登录页是服务端渲染页面，不经过 AgentApp，缺少 initTheme()，
 * 因此首屏拿不到 data-theme —— 深色用户会先看到一整屏亮色卡片再被刷新。
 *
 * 这里在文档流最早处同步执行（浏览器解析 HTML 时就跑，早于首帧绘制），优先级：
 *   1) ?theme=light|dark —— 桌面端（登录窗）按宿主当前外观显式传入；
 *   2) localStorage 的 agent-kit:theme —— 与 AgentApp 同一个 key（同一 origin 共享）；
 *   3) prefers-color-scheme —— 浏览器里第一次访问，跟随系统。
 * 结果写成 <html data-theme="light|dark">，与聊天页共用同一套 CSS 变量。
 */
const THEME_BOOT_SCRIPT = `(function(){try{
var t=null;try{var q=/[?&]theme=(light|dark)(?:&|$)/.exec(location.search);if(q)t=q[1];}catch(e){}
if(!t){var m=null;try{m=localStorage.getItem("agent-kit:theme")}catch(e){}
t=(m==="light"||m==="dark")?m:((window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light");}
document.documentElement.setAttribute("data-theme",t);
}catch(e){}})();`;

export function LoginPage({
  basePath,
  title = "AI 助手",
  logoUrl,
  error,
  next,
  providers = [],
  providerIcons = {},
  loginProviders = "",
  detected,
  children,
}: LoginPageProps) {
  const root = basePath.replace(/\/+$/, "");
  const safeNext = typeof next === "string" && (next === root || next.startsWith(`${root}/`)) ? next : `${root}/`;
  const nextQuery = encodeURIComponent(safeNext);
  const errText = error ? ERROR_MESSAGES[error] || error : "";
  const empty = providers.length === 0;
  const builtin = providers.some(p => p.id === "builtin");
  const oauthProviders = providers.filter(p => p.id !== "builtin");
  // 钉钉客户端内：检测已完成 → 不渲染副标题，直接进入免登状态（children 负责 loading 与跳转）
  const inDingTalk = detected === "dingtalk";

  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      <main className="login-page" aria-label={title}>
        <div className="login-shell">
          {/* 品牌区只保留 Logo：登录卡片本身已足够表达「这是登录页」，
              标题（title）不再渲染，避免窗口标题栏和卡片顶部重复出现同一行文字。 */}
          {logoUrl ? (
            <div className="login-brand">
              <img className="login-brand-logo" src={logoUrl} alt="" />
            </div>
          ) : null}

          <section className="login-card">
            <div className="login-card-line" aria-hidden="true" />

            {inDingTalk ? (
              <>
                {/* 钉钉免登：DingTalkAutoLogin 先显示 loading（正在使用钉钉身份免登…），成功后自动跳转 */}
                {children}
                {/* 免登失败回退：单个钉钉登录按钮（不渲染多方式选择器） */}
                <a
                  className="login-provider-button"
                  href={`${root}/api/auth/login?provider=dingtalk&next=${nextQuery}`}
                >
                  钉钉登录
                </a>
              </>
            ) : empty ? (
              <div className="login-error" role="alert">
                暂无可用登录方式，请联系管理员
              </div>
            ) : (
              <div className="login-provider-list">
                {builtin && <BuiltinLoginForm basePath={root} next={safeNext} loginProviders={loginProviders} />}
                {builtin && oauthProviders.length > 0 && <div className="login-divider">其他登录方式</div>}
                <div className={builtin ? "login-oauth-icons" : "login-oauth-buttons"}>
                  {oauthProviders.map((p) => (
                    <a
                      key={p.id}
                      className={builtin ? "login-oauth-icon-button" : "login-provider-button"}
                      href={`${root}/api/auth/login?provider=${encodeURIComponent(p.id)}&next=${nextQuery}`}
                      aria-label={p.name}
                      title={p.name}
                    >
                      {providerIcons[p.id as "dingtalk" | "feishu"]
                        ? <img className="login-provider-image" src={providerIcons[p.id as "dingtalk" | "feishu"]} alt="" />
                        : <span className={`login-provider-icon login-provider-icon-${p.id}`} aria-hidden="true">{p.id === "dingtalk" ? "钉" : "飞"}</span>}
                      {!builtin && p.name}
                    </a>
                  ))}
                </div>
              </div>
            )}

            {errText ? (
              <div className="login-error" role="alert">
                {errText}
              </div>
            ) : null}
          </section>
        </div>
      </main>
    </>
  );
}
