/**
 * 管理控制台配置的前端类型（与 server/admin-settings.ts 的结构保持一致，
 * 但刻意不 import 服务端模块，避免把 pg 等 Node 依赖打进浏览器包）。
 */
export interface SkillItem {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface ConnectorItem {
  id: string;
  name: string;
  type: string;
  endpoint: string;
  enabled: boolean;
}

export interface AdminSettings {
  basic: {
    prompts: { systemPrompt: string; groupPrompt: string };
    skills: SkillItem[];
    connectors: ConnectorItem[];
  };
  compute: {
    resourcePool: { totalConcurrency: number; models: string; note: string };
    allocation: { strategy: "fair" | "priority" | "fixed"; perUserQuota: number; burst: boolean; note: string };
  };
}

export const DEFAULT_SETTINGS: AdminSettings = {
  basic: {
    prompts: { systemPrompt: "", groupPrompt: "" },
    skills: [],
    connectors: [],
  },
  compute: {
    resourcePool: { totalConcurrency: 0, models: "", note: "" },
    allocation: { strategy: "fair", perUserQuota: 0, burst: false, note: "" },
  },
};

/** 生成一个足够唯一的本地 id（无需服务端参与）。 */
export function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}
