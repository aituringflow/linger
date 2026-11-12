import { ARTIFACT_FILE_MIME, readArtifactFileDragItems, type UiAttachment } from "@turingflow/agent-kit/ui";

/**
 * 桌面文件拖放的公共入口。
 *
 * 「从文件管理组件拖文件」有三处落点（聊天窗 / 会话卡片 / Dock 的 home 按钮），
 * 三者共用同一套内核：
 *  1. 认出这是文件管理器的拖拽载荷（自定义 MIME）；
 *  2. 同步读出载荷（drop 事件一结束 dataTransfer 就被清空，必须当场读）；
 *  3. 让主进程把相对 home 的 rel 登记成本机引用（local-ref:// 句柄），
 *     转成 kit 认识的 UiAttachment。
 */

/** 这次拖拽是不是「文件管理组件里拖出来的本机文件」。 */
export function isArtifactFileDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types || []).includes(ARTIFACT_FILE_MIME);
}

/**
 * 同步读出拖拽载荷里的文件列表。
 * 必须在 drop 事件处理函数里当场调用：事件返回后 dataTransfer.getData 会拿不到东西。
 */
export function readDraggedFiles(dataTransfer: DataTransfer | null) {
  const items = readArtifactFileDragItems(dataTransfer);
  if (!items?.length) return [];
  // 同一个 rel 可能在一次拖拽里出现多次，去重后再登记。
  const rels = Array.from(new Set(items.map((item) => item.rel).filter(Boolean)));
  return rels.map((rel) => {
    const item = items.find((entry) => entry.rel === rel);
    return { rel, name: item?.name ?? rel.split("/").pop() ?? rel, size: item?.size ?? 0, isDir: item?.isDir ?? false };
  });
}

/**
 * 把本机文件列表转成 kit 的附件（本机引用句柄）。
 * 主进程会校验 rel 不许越出 home，越界/不存在的文件不会被登记。
 */
export async function toLocalAttachments(files: Array<{ rel: string; name: string; size: number; isDir: boolean }>): Promise<UiAttachment[]> {
  if (!files.length) return [];
  const refs = await window.launcher.registerLocalRefs(files.map((file) => file.rel));
  return refs.map((ref) => ({ url: ref.url, name: ref.name, size: ref.size, kind: ref.kind }));
}
