import type { Wallpaper } from "../../shared/types";
import { localFileUrl } from "./localFile";

/** 跟随明暗主题切换的系统默认壁纸。 */
export const BUILTIN_WALLPAPER = { id: "default", name: "默认几何壁纸", url: "wallpapers/default" };

export const WALLPAPER_SKINS = [
  { id: "wp1", name: "石墨夜色", url: "wallpapers/wp1.jpg" },
  { id: "wp2", name: "冰蓝晨光", url: "wallpapers/wp2.jpg" },
  { id: "wp3", name: "深林绿影", url: "wallpapers/wp3.jpg" },
  { id: "wp4", name: "熔火龙境", url: "wallpapers/wp4.jpg" },
  { id: "wp5", name: "静海听潮", url: "wallpapers/wp5.jpg" },
  { id: "wp6", name: "鎏金华庭", url: "wallpapers/wp6.jpg" },
] as const;

export type WallpaperSkinId = (typeof WALLPAPER_SKINS)[number]["id"];
export const DYNAMIC_WALLPAPER_IDS = new Set<string>(["wp4", "wp5", "wp6"]);
export function isDynamicWallpaper(wallpaper: Wallpaper): boolean {
  return wallpaper.kind === "builtin" && WALLPAPER_SKINS.some(skin => DYNAMIC_WALLPAPER_IDS.has(skin.id) && skin.url === wallpaper.value);
}

export function wallpaperSkinId(wallpaper: Wallpaper): WallpaperSkinId {
  return WALLPAPER_SKINS.find((skin) => wallpaper.kind === "builtin" && wallpaper.value === skin.url)?.id ?? "wp1";
}

export const GRADIENTS: { id: string; name: string; css: string }[] = [
  {
    id: "aurora",
    name: "极光",
    css: "radial-gradient(140% 100% at 20% 10%, #1c2a5e 0%, #0b1a3a 45%, #05070f 100%)",
  },
  {
    id: "sunset",
    name: "日落",
    css: "linear-gradient(160deg, #2b1a4e 0%, #7a3b69 45%, #d96c4a 78%, #f2a65a 100%)",
  },
  {
    id: "ocean",
    name: "深海",
    css: "radial-gradient(120% 120% at 80% 0%, #06324d 0%, #04202f 55%, #02070c 100%)",
  },
  {
    id: "forest",
    name: "森林",
    css: "linear-gradient(170deg, #123524 0%, #0c2a1a 50%, #04120b 100%)",
  },
  {
    id: "mono",
    name: "石墨",
    css: "linear-gradient(180deg, #1c1c22 0%, #101014 60%, #0a0a0d 100%)",
  },
];

export const COLORS: { id: string; name: string; css: string }[] = [
  { id: "c1", name: "深空黑", css: "#0b0b0e" },
  { id: "c2", name: "午夜蓝", css: "#0d1526" },
  { id: "c3", name: "墨绿", css: "#0d1a14" },
  { id: "c4", name: "酒红", css: "#200d13" },
];

export function wallpaperCss(wp: Wallpaper): string {
  if (wp.kind === "gradient") {
    const g = GRADIENTS.find((x) => x.id === wp.value);
    if (g) return g.css;
    return GRADIENTS[0].css;
  }
  if (wp.kind === "color") return wp.value;
  if (wp.kind === "builtin") return `url("${wp.value === BUILTIN_WALLPAPER.url ? "wallpapers/default-dark.svg" : wp.value}")`;
  // 本地图片：经主进程 local-file:// 协议提供
  return `url("${localFileUrl(wp.value)}")`;
}
