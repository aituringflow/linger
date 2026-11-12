import type { SessionItem, UiMessage } from "./types.ts";
import { AGENT_HOST } from "./platform.ts";

/**
 * 本机会话落盘适配层（桌面壳）：只替代「用户 ↔ AI」单聊的云端 /api/sessions、/messages。
 * 与其他人的 1v1 / 群聊仍走云端，不经此存储。
 *
 * 按用户隔离：所有函数都要传 `owner`（= encodeUserKey(provider, unionId)），
 * 主进程落到 ~/.agent/chats/<owner>/ 下。owner 为空一律视为不可用（返回空 / 空操作），
 * **不要**兜底成"全局共享"——那正好会造成一个账号看到另一个账号的会话。
 *
 * 会话元数据与完整消息经 preload 桥写入主进程（fs 落盘，无 localStorage 容量限制）。
 * 非桌面环境（web）这些函数返回空/null，调用方回退云端逻辑。
 */

export function localChatAvailable(): boolean {
  return Boolean(AGENT_HOST?.localChat);
}

/** 是否为「用户 ↔ AI」单聊：无真人成员（memberCount 为 0/缺省）且从未成过群；其余（1v1、群聊）走云端。 */
export function isAiOnlyChat(session: SessionItem | null | undefined): boolean {
  return (session?.memberCount ?? 0) === 0 && !session?.coworkEverGroup;
}

/** 列出当前用户的全部本机会话元数据（主进程已按 updatedAt 倒序）。 */
export async function localChatList(owner: string): Promise<SessionItem[]> {
  const bridge = AGENT_HOST?.localChat;
  if (!bridge || !owner) return [];
  const rows = await bridge.list(owner);
  return rows.map((row) => row as unknown as SessionItem);
}

/** 读取当前用户某会话的完整消息；无记录返回 null（调用方据此回退）。 */
export async function localChatMessages(owner: string, id: string): Promise<UiMessage[] | null> {
  const bridge = AGENT_HOST?.localChat;
  if (!bridge || !owner) return null;
  const got = await bridge.get(owner, id);
  return got ? (got.messages as UiMessage[]) : null;
}

/** 整体保存会话元数据 + 消息。 */
export async function localChatSave(owner: string, session: SessionItem, messages: UiMessage[]): Promise<void> {
  if (!owner) return;
  await AGENT_HOST?.localChat?.save(
    owner,
    session.id,
    session as unknown as Record<string, unknown>,
    messages,
  );
}

/** 局部更新元数据（标题/置顶/工作目录等），保留已有消息。 */
export async function localChatPatch(owner: string, id: string, patch: Partial<SessionItem>): Promise<void> {
  if (!owner) return;
  await AGENT_HOST?.localChat?.patch(owner, id, patch as unknown as Record<string, unknown>);
}

/** 删除当前用户的本机会话及其消息文件。 */
export async function localChatRemove(owner: string, id: string): Promise<void> {
  if (!owner || !AGENT_HOST?.localChat) throw new Error("本地会话存储不可用");
  if (!await AGENT_HOST.localChat.remove(owner, id)) throw new Error(`删除本地会话失败: ${id}`);
}
