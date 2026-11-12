/**
 * agent-kit · 登录方式清单（服务端）
 *
 * 由 AUTH_PROVIDER 解析出「登录页应如何呈现」的完整决策输入：
 *   - providers：可用的真实登录方式（OAuth 平台已按 env 过滤是否配置完整）
 *
 * 宿主登录页使用范式：
 *   const options = getLoginOptions();
 *   const total = options.providers.length;
 *   if (total === 1) {
 *     // 单个真实登录方式 → 服务端直接 302 到 /api/auth/login?provider=xxx
 *   }
 *   // total > 1 → 渲染 <LoginPage providers={options.providers} />
 */
import { loadAuthConfig, isMethodConfigured, parseAuthProviders } from "./config.js";
import type { AuthConfig, AuthMethod } from "./types.js";

export interface LoginOption {
  /** 登录方式标识（OAuth 平台 / 自建 builtin；builtin 待实现，类型上先留口子） */
  id: "dingtalk" | "feishu" | "builtin";
  /** 展示名（登录页按钮文案） */
  name: string;
}

export interface LoginOptions {
  /** 可用的真实登录方式（已过滤未配置项），空表示无可点选的登录按钮 */
  providers: LoginOption[];
  /** 会话 Cookie 路径（= Next basePath，如 /agent），登录页跳转均基于它 */
  cookiePath: string;
}

const OPTION_NAMES: Record<LoginOption["id"], string> = {
  dingtalk: "钉钉登录",
  feishu: "飞书登录",
  // builtin：自建账号登录（注册/登录表单，由 POSTGRES 用户表支撑）
  builtin: "账号登录",
};

/**
 * 按显式给定的登录方式清单生成登录选项（不读 web 服务自身的 AUTH_PROVIDER）。
 * 主要用于：桌面端 App 通过 URL 参数 `?providers=` 把自己
 * 的环境变量（AUTH_PROVIDER）传给 web 登录页，使「App 的 env 优先级更高」。
 * 仍会经过 isMethodConfigured 过滤——env 实际未配齐的方式不会出现在清单里（安全）。
 */
export function getLoginOptionsForMethods(methods: AuthMethod[], config?: AuthConfig): LoginOptions {
  const cfg = config ?? loadAuthConfig();
  const providers: LoginOption[] = [];
  const seen = new Set<string>();
  for (const m of methods) {
    if (m === "none") continue;
    // adaptive：展开为两个候选 OAuth 平台，各自按 env 是否齐全过滤。
    // 展开后的清单驱动登录页：钉钉/飞书客户端内自动定向，普通浏览器渲染选择器。
    if (m === "adaptive") {
      for (const cand of ["dingtalk", "feishu"] as const) {
        if (!isMethodConfigured(cfg, cand)) continue;
        if (seen.has(cand)) continue;
        seen.add(cand);
        providers.push({ id: cand, name: OPTION_NAMES[cand] });
      }
      continue;
    }
    if (!isMethodConfigured(cfg, m)) continue; // OAuth env 不全 / dev 未开启 → 不可选
    if (seen.has(m)) continue;
    seen.add(m);
    providers.push({ id: m, name: OPTION_NAMES[m as LoginOption["id"]] });
  }
  return { providers, cookiePath: cfg.cookiePath };
}

export function getLoginOptions(config?: AuthConfig): LoginOptions {
  const cfg = config ?? loadAuthConfig();
  return getLoginOptionsForMethods(cfg.methods, cfg);
}

/**
 * 登录方式解析的唯一入口：登录页渲染与登录 API 校验都必须走这里，否则会出现
 * 「页面按 App 的 ?providers= 显示了账号登录，API 却按 web 自身 AUTH_PROVIDER 拒绝」
 * 的分裂（报错：登录方式不可用）。
 *
 *   - raw 非空 → 用 App 传来的清单（App 的 env 优先）；
 *   - raw 为空/未传 → 仅 builtin。
 */
export function resolveLoginOptions(rawProviders: string | undefined | null, config?: AuthConfig): LoginOptions {
  const raw = typeof rawProviders === "string" ? rawProviders.trim() : "";
  return raw
    ? getLoginOptionsForMethods(parseAuthProviders(raw), config)
    : getLoginOptionsForMethods(["builtin"], config);
}
