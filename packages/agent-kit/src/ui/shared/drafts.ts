import type { UiAttachment } from "../chat/types.ts";
import type { ComposerReference } from "../chat/types.ts";

const keyFor = (sessionId: string) => `agent-chat-draft-${sessionId}`;
export const DRAFT_CHANGED_EVENT = "agent-chat-draft-change";
export const CHATMATE_ADOPT_EVENT = "agent-chatmate-adopt";
/** 伴聊自动回复：建议生成完成后由右侧面板派发，群聊面板收到后直接把最终建议文本发送到群里。 */
export const CHATMATE_AUTO_SEND_EVENT = "agent-chatmate-auto-send";
/** 群聊 AI 消息「查看产出物」：让主窗口打开右栏产物列表/预览。 */
export const AGENT_OPEN_ARTIFACTS_EVENT = "agent-open-artifacts";
/** 群聊 AI 消息「查看变更」：让主窗口打开右栏变更 diff。 */
export const AGENT_OPEN_DIFF_EVENT = "agent-open-diff";
/** 会话被外部更新（桌面卡片「重发最后一条消息」等）：所有 AgentWindow 实例收到后刷新会话
 *  列表；若正是当前显示中的会话则重载该会话消息，保证侧边栏与对话与卡片数据同源。 */
export const AGENT_SESSION_UPDATED_EVENT = "agent-session-updated";
/** 群聊输入框内容变更：CoworkPanel 广播当前草稿文本，右侧伴聊面板据此判断「用户有输入」。 */
export const COWORK_COMPOSER_TEXT_EVENT = "agent-cowork-composer-text";
/** 群聊消息撤回：CoworkPanel 撤回成功后广播，主窗口据此同步清理该会话 rt.messages 中
 *  对应消息的正文与附件（右栏「输入文件」聚合自主窗口消息，不同步会残留已撤回的文件）。 */
export const COWORK_MESSAGE_REVOKED_EVENT = "agent-cowork-message-revoked";
/** 群聊新消息到达：CoworkPanel 收到 SSE/轮询推送的新消息后广播，主窗口据此把该消息合并进
 *  对应会话 rt.messages——否则右栏「输入文件」只包含切会话时的历史快照，缺少群聊进行中新增的附件。 */
export const COWORK_MESSAGE_UPDATE_EVENT = "agent-cowork-message-update";
export type DraftReference = { sourceId: string; reference: ComposerReference };
export type ChatDraft = { text: string; attachments: UiAttachment[]; replyToId: number | null; references: DraftReference[] };

export function readChatDraft(sessionId: string): ChatDraft {
  try {
    const raw = localStorage.getItem(keyFor(sessionId));
    if (!raw) return { text: "", attachments: [], replyToId: null, references: [] };
    const value = JSON.parse(raw) as { text?: unknown; attachment?: UiAttachment; attachments?: UiAttachment[]; replyToId?: unknown; references?: DraftReference[] };
    return {
      text: typeof value.text === "string" ? value.text : "",
      attachments: Array.isArray(value.attachments) ? value.attachments : value.attachment ? [value.attachment] : [],
      replyToId: typeof value.replyToId === "number" && Number.isSafeInteger(value.replyToId) && value.replyToId > 0 ? value.replyToId : null,
      references: Array.isArray(value.references) ? value.references.filter((item) => item && typeof item.sourceId === "string" && typeof item.reference?.id === "string" && typeof item.reference.label === "string" && typeof item.reference.context === "string") : [],
    };
  } catch { return { text: "", attachments: [], replyToId: null, references: [] }; }
}

export function saveChatDraft(sessionId: string, text: string, attachments: UiAttachment[], options: { replyToId?: number | null; references?: DraftReference[] } = {}): void {
  const snapshot = attachments.map(({ url, name, size, fileId }) => ({ url, name, size, fileId }));
  const previous = readChatDraft(sessionId);
  const replyToId = options.replyToId === undefined ? previous.replyToId : options.replyToId;
  const references = options.references === undefined ? previous.references : options.references;
  try {
    if (text || attachments.length || replyToId || references.length) localStorage.setItem(keyFor(sessionId), JSON.stringify({
      text,
      attachments: snapshot,
      replyToId,
      references,
    }));
    else localStorage.removeItem(keyFor(sessionId));
    window.dispatchEvent(new CustomEvent(DRAFT_CHANGED_EVENT, { detail: sessionId }));
  } catch { /* Storage may be unavailable. */ }
}
