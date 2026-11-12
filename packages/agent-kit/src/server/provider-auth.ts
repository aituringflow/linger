/**
 * 算力提供商（框架）认证：目前只有 WorkBuddy（= CodeBuddy 订阅）。
 *
 * 三个动作全部走 @tencent-ai/agent-sdk，不读、不猜本地凭据文件：
 *   · 状态：query().accountInfo()（见 model-sources.isCodeBuddyAuthenticated）
 *   · 登录：unstable_v2_authenticate —— 已登录会直接返回 userinfo，未登录才回调 onAuthUrl 走浏览器授权
 *   · 登出：unstable_v2_logout —— 清掉该环境的缓存凭据
 *
 * 宿主（桌面 / web）只关心「是不是已登录 + 打开哪个网址」，不关心凭据落在哪。
 */
import { unstable_v2_authenticate, unstable_v2_logout } from "@tencent-ai/agent-sdk";
import { codeBuddyAuthEnvironment, codeBuddyRuntimeOptions, isCodeBuddyAuthenticated } from "./model-sources.js";

/** 登录成功后能拿到的账号信息（SDK 的 userinfo 可能字段缺失，这里统一成字符串）。 */
export interface ProviderAccount {
  /** 展示名：昵称优先，其次账号名。 */
  name: string;
  userId: string;
  enterprise?: string;
}

export interface ProviderAuthStatus {
  authenticated: boolean;
  account?: ProviderAccount;
}

export type ProviderLoginResult =
  | { ok: true; account: ProviderAccount }
  | { ok: false; error: string };

export interface ProviderLoginOptions {
  /** 拿到授权链接时回调：宿主负责用系统浏览器打开它。 */
  onAuthUrl?: (url: string) => void | Promise<void>;
  /** 等待用户在浏览器完成授权的上限（毫秒），默认 3 分钟。 */
  timeoutMs?: number;
}

/** 登录态查询（SDK 探测，10s 内必定返回；失败按未登录处理）。 */
export async function getWorkBuddyAuthStatus(): Promise<ProviderAuthStatus> {
  return { authenticated: await isCodeBuddyAuthenticated() };
}

/**
 * 发起（或直接复用）WorkBuddy 登录。
 *
 * 已登录时 SDK 立刻返回账号，不会弹浏览器；未登录时先回调 onAuthUrl，
 * 之后一直等浏览器授权完成 —— 所以宿主 UI 要按「等待中」处理。
 */
export async function loginWorkBuddy(options: ProviderLoginOptions = {}): Promise<ProviderLoginResult> {
  try {
    const result = await unstable_v2_authenticate({
      environment: codeBuddyAuthEnvironment(),
      ...codeBuddyRuntimeOptions(),
      timeout: options.timeoutMs ?? 180_000,
      onAuthUrl: (state) => {
        if (state?.authUrl) void options.onAuthUrl?.(state.authUrl);
      },
    });
    const info = result?.userinfo;
    return {
      ok: true,
      account: {
        name: info?.userNickname?.trim() || info?.userName?.trim() || "已登录",
        userId: info?.userId ?? "",
        enterprise: info?.enterprise?.trim() || undefined,
      },
    };
  } catch (error) {
    return { ok: false, error: describeAuthError(error) };
  }
}

/** 退出 WorkBuddy 登录（清掉该环境的缓存凭据）。 */
export async function logoutWorkBuddy(): Promise<{ ok: boolean; error?: string }> {
  try {
    await unstable_v2_logout({ environment: codeBuddyAuthEnvironment(), ...codeBuddyRuntimeOptions() });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeAuthError(error) };
  }
}

/** SDK 的 AuthenticationError 只带英文枚举类型，这里翻译成宿主能直接展示的文案。 */
function describeAuthError(error: unknown): string {
  const type = (error as { type?: string } | null)?.type;
  switch (type) {
    case "timeout": return "登录超时，请重试";
    case "cancelled": return "登录已取消";
    case "network_error": return "网络异常，无法连接登录服务";
    case "invalid_method": return "当前环境不支持该登录方式";
    case "auth_failed": return "登录失败，请重试";
    default: return error instanceof Error && error.message ? error.message : "登录失败，请重试";
  }
}
