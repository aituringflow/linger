/**
 * agent-kit · Agent 工厂与高级会话封装
 *
 * createAgent(config) 返回一个带状态（多轮历史由 SDK 会话延续）的 Agent 实例，
 * 供服务端应用直接使用：
 *
 *   const agent = createAgent({ systemPrompt: "你是数据分析助手" });
 *   const reply = await agent.chat("分析 ./data 下的数据");
 */

import type { SdkConfig } from "./sdk.js";
import { getAgentAdapter, resolveAgentMode } from "./agent-runtime.js";

export interface AgentConfig extends SdkConfig {
  /** 会话级追加提示词（同 SdkConfig.systemPrompt） */
  systemPrompt?: string;
}

export class Agent {
  private config: AgentConfig;

  constructor(config: AgentConfig = {}) {
    this.config = config;
  }

  /**
   * 发起一轮订阅对话并返回模型最终文本。
   * 多轮上下文由 SDK 会话（continue:true）自动延续。
   */
  async chat(message: string): Promise<string> {
    const adapter = getAgentAdapter(resolveAgentMode(this.config.llmProvider));
    const stream = adapter.stream({ messages: [{ role: "user", content: message }], config: this.config });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let answer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const event = frame.match(/^event: (.+)$/m)?.[1];
        const payload = frame.match(/^data: (.+)$/m)?.[1];
        if (!payload) continue;
        const data = JSON.parse(payload) as { text?: string };
        if (event === "text") answer += data.text ?? "";
        if (event === "error") throw new Error(data.text ?? "Agent 执行失败");
      }
    }
    return answer;
  }

  /** 当前配置（只读） */
  getConfig(): AgentConfig {
    return { ...this.config };
  }
}

/** 创建 Agent 实例 */
export function createAgent(config: AgentConfig = {}): Agent {
  return new Agent(config);
}
