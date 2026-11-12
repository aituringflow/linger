/**
 * agent-kit · 认证提供方工厂
 *
 * 按 method / 指定方式返回对应的认证提供方实例；未配置或非具体平台时返回 null。
 * 上层只依赖 AuthProvider 抽象，不感知具体平台。
 */
import type { AuthConfig, AuthProvider, AuthProviderId } from "../types.js";
import { createDingTalkProvider } from "./dingtalk.js";
import { createFeishuProvider } from "./feishu.js";

/** 按指定平台 id 构造提供方实例（不依赖 config.method；多方式场景下按按钮逐个取）。 */
export function createProviderFor(config: AuthConfig, id: AuthProviderId): AuthProvider | null {
  if (id === "dingtalk") {
    const p = createDingTalkProvider(config.dingtalk);
    return p.isConfigured() ? p : null;
  }
  if (id === "feishu") {
    const p = createFeishuProvider(config.feishu);
    return p.isConfigured() ? p : null;
  }
  return null;
}

/** 根据认证配置构造当前主启用的提供方；method 非具体平台或对应平台未配置时返回 null。 */
export function createProvider(config: AuthConfig): AuthProvider | null {
  if (config.method === "dingtalk") return createProviderFor(config, "dingtalk");
  if (config.method === "feishu") return createProviderFor(config, "feishu");
  return null;
}

export { createDingTalkProvider } from "./dingtalk.js";
export { createFeishuProvider } from "./feishu.js";
