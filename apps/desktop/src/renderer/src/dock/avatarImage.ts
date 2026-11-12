/**
 * 头像图片处理：把用户选中的任意图片裁成方形、缩到 128×128，输出 WebP data URL。
 *
 * 为什么要在这里压缩，而不是直接把原图交给服务端：
 *   - users.avatar 是随 /api/auth/session 一起下发的字段，几 MB 的原图会拖慢每次会话请求；
 *   - 头像展示最大只有 44px（设置面板）/ 32px（联系人），128px 足够 2x 屏；
 *   - 服务端只接受 PNG / JPEG / WebP 的 data URL，这里统一转 WebP，顺带兼容
 *     用户从「照片」里选到的 HEIC 之类（浏览器解不了的格式由调用方提示换一张）。
 */
const AVATAR_SIZE = 128;
const AVATAR_QUALITY = 0.9;

export async function fileToAvatarDataUrl(file: File, size = AVATAR_SIZE): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("无法读取这张图片，换一张试试");
  }
  try {
    // 居中裁成正方形（object-fit: cover 的等价效果），避免头像被拉变形。
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法处理这张图片，换一张试试");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
    // Chromium 支持 WebP 编码；万一环境不支持（返回 png data URL）就退回 PNG。
    const webp = canvas.toDataURL("image/webp", AVATAR_QUALITY);
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/png");
  } finally {
    bitmap.close?.();
  }
}
