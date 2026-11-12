/**
 * 文件管理器（Finder 风格）拖拽载荷协议。
 *
 * 单独抽到 shared，是为了让输入框（ChatComposer）等
 * 只需要"识别载荷"的轻量组件不必把整个 ArtifactFileManager 拉进模块图。
 */

/** 拖拽载荷的 MIME。载荷是 JSON 数组，元素见 {@link ArtifactFileDragItem}。 */
export const ARTIFACT_FILE_MIME = "application/x-agent-file";

/** 单个被拖拽的文件/文件夹。rel 是相对根目录的路径，isDir 标记文件夹。 */
export type ArtifactFileDragItem = { rel: string; name: string; size: number; isDir: boolean };

/** 读取拖拽事件里的文件管理器载荷；不是该协议时返回 null。 */
export function readArtifactFileDragItems(dataTransfer: DataTransfer | null): ArtifactFileDragItem[] | null {
  if (!dataTransfer) return null;
  const types = Array.from(dataTransfer.types || []);
  if (!types.includes(ARTIFACT_FILE_MIME)) return null;
  const raw = dataTransfer.getData(ARTIFACT_FILE_MIME);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item.rel === "string") as ArtifactFileDragItem[];
  } catch {
    return [];
  }
}
