import path from "node:path";

/**
 * 知识库派生资源（图片副本 / 缩略图）的路径约定。
 *
 * 目录结构：
 *   libraries/<id>/images/<sha256>.<ext>   原图副本（解析时按内容哈希落盘）
 *   libraries/<id>/thumbs/<sha256>.webp    列表/详情用的缩略图（384px）
 *
 * 单独放一个不依赖 canvas / sqlite 的小模块：解析子进程、store、runtime 都要拼这些路径，
 * 谁都不该为了一行 path.join 去加载原生模块。
 */

/** 缩略图文件名：与原图同名、扩展名换成 .webp */
export function assetThumbPath(assetPath: string): string {
  const dir = path.dirname(path.dirname(assetPath)); // <library>/images -> <library>
  const name = path.basename(assetPath).replace(/\.[^.]+$/, "");
  return path.join(dir, "thumbs", `${name}.webp`);
}

/**
 * 独立图片文件的缩略图：按「原文件 sha256」命名。
 *
 * 这条路径不依赖索引产物 —— 还没解析（pending）的照片也有 sha256，
 * 因此图库可以直接从原图生成缩略图，用户不用等几万张照片索引完才能看到画面。
 */
export function fileThumbPath(libraryDir: string, fileSha256: string): string {
  return path.join(libraryDir, "thumbs", `${fileSha256}.webp`);
}
