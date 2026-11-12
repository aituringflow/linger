"use client";

/**
 * 通道无关的宿主能力注册表（HostCapability）。
 *
 * 单聊（chat /api/chat）与群聊（cowork /api/cowork）共用同一套生命周期钩子，
 * 未来新增 skill / MCP 能力时只需注册一个 HostCapability 对象，无需在两条链路各写一遍。
 *
 * 生命周期：
 *  - buildContext：每轮发送前生成能力上下文（格式要求 / 当前草稿 / 附件清单），双通道一致注入；
 *  - onReply：任一通道助手回复完成后触发，用于抽取草稿、写状态；
 *  - renderCard：在两个面板统一的卡片槽渲染（chat 底部 / cowork composer 上方）。
 */
import { Fragment, type ReactNode } from "react";

/** 通道标识：chat=单聊，cowork=群聊人机协同。 */
export type CapChannel = "chat" | "cowork";

export interface CapAttachment {
  url: string;
  name: string;
  fileId?: string;
  size?: number;
}

/** 通道无关的统一消息形状；各通道在传入前把自身消息适配成该形状。 */
export interface CapMessage {
  role: "user" | "assistant" | "system";
  content: string;
  attachment?: CapAttachment | null;
  attachments?: CapAttachment[];
}

export interface CapContextArgs {
  sessionId: string;
  messages: readonly CapMessage[];
  channel: CapChannel;
}

export interface HostCapability {
  /** 能力唯一标识，如 "expense"。 */
  id: string;
  /** 每轮发送前生成能力上下文；返回空串表示本轮无需补充。 */
  buildContext?(args: CapContextArgs): string;
  /** 任一通道助手回复完成后触发（reply 为本次助手回复全文）。 */
  onReply?(args: CapContextArgs & { reply: string }): void;
  /** 统一卡片槽渲染；返回 null/undefined 表示本轮不渲染。 */
  renderCard?(args: CapContextArgs): ReactNode;
}

/** 聚合所有能力的逐轮上下文，非空段落用空行拼接。 */
export function buildCapabilitiesContext(
  capabilities: readonly HostCapability[] | undefined,
  args: CapContextArgs,
): string {
  if (!capabilities?.length) return "";
  return capabilities
    .map((cap) => cap.buildContext?.(args)?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/** 把助手回复完成事件分发给所有注册能力。 */
export function dispatchCapabilityReply(
  capabilities: readonly HostCapability[] | undefined,
  args: CapContextArgs & { reply: string },
): void {
  capabilities?.forEach((cap) => {
    try {
      cap.onReply?.(args);
    } catch (error) {
      console.error(`[capabilities] ${cap.id} onReply failed`, error);
    }
  });
}

/** 收集所有能力的卡片节点，供统一卡片槽渲染。 */
export function renderCapabilityCards(
  capabilities: readonly HostCapability[] | undefined,
  args: CapContextArgs,
): ReactNode[] {
  if (!capabilities?.length) return [];
  return capabilities
    .map((cap) => {
      try {
        const card = cap.renderCard?.(args);
        return card == null ? null : <Fragment key={cap.id}>{card}</Fragment>;
      } catch (error) {
        console.error(`[capabilities] ${cap.id} renderCard failed`, error);
        return null;
      }
    })
    .filter((node): node is Exclude<typeof node, null> => node !== null);
}

/** 把任意通道的消息适配成 CapMessage（兼容 UiMessage 的 attachments 与 cowork 的 attachment）。 */
export function toCapMessage(message: unknown): CapMessage {
  const m = (message ?? {}) as Record<string, unknown>;
  const role = m.role === "assistant" || m.role === "system" ? m.role : "user";
  const content = typeof m.content === "string" ? m.content : "";
  const attachments = Array.isArray(m.attachments)
    ? (m.attachments as unknown[]).map(toCapAttachment).filter(Boolean) as CapAttachment[]
    : undefined;
  const attachment = m.attachment ? toCapAttachment(m.attachment) : null;
  return { role, content, attachment, ...(attachments?.length ? { attachments } : {}) };
}

export function toCapMessages(list: readonly unknown[] | undefined): CapMessage[] {
  return (list ?? []).map(toCapMessage);
}

function toCapAttachment(value: unknown): CapAttachment | null {
  const a = (value ?? {}) as Record<string, unknown>;
  const url = typeof a.url === "string" ? a.url : "";
  const name = typeof a.name === "string" ? a.name : "";
  if (!url && !name) return null;
  return {
    url,
    name,
    ...(typeof a.fileId === "string" ? { fileId: a.fileId } : {}),
    ...(typeof a.size === "number" ? { size: a.size } : {}),
  };
}
