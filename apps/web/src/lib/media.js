// 站点演示视频与配图不进仓库，托管在静态资源主机的 /static 下。
// 那两个 location 都是内联返回（不带 Content-Disposition），<video> / <img> 才能直接播放和显示。
// 换主机或换目录时用 NEXT_PUBLIC_MEDIA_BASE 覆盖，只需指向 /static 这一级。
const DEFAULT_BASE = "https://gcomply.aotsea.com/static";

function join(kind, file) {
  const base = (process.env.NEXT_PUBLIC_MEDIA_BASE || DEFAULT_BASE).replace(/\/+$/, "");
  return `${base}/${kind}/${file}`;
}

/** 演示视频地址，如 videoUrl("launcher-home.mp4") */
export function videoUrl(file) {
  return join("video", file);
}

/** 配图 / 封面地址，如 imageUrl("launcher-home.png") */
export function imageUrl(file) {
  return join("image", file);
}
