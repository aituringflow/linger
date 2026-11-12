export type NotificationSound = "off" | "bright" | "calm" | "playful" | "system";

const KEY = "agent-kit:notification-sound";
const CACHE = "agent-notification-prefs";
const choices: readonly NotificationSound[] = ["off", "bright", "calm", "playful", "system"];
const recentlyPlayed = new Map<string, number>();

export function readNotificationSound(): NotificationSound {
  if (typeof window === "undefined") return "off";
  try {
    const value = window.localStorage.getItem(KEY);
    return choices.includes(value as NotificationSound) ? value as NotificationSound : "off";
  } catch { return "off"; }
}

export function writeNotificationSound(value: NotificationSound, basePath: string): void {
  try { window.localStorage.setItem(KEY, value); } catch { /* 本次页面仍使用所选值 */ }
  void syncNotificationSoundForPush(basePath, value);
}

export async function syncNotificationSoundForPush(basePath: string, value = readNotificationSound()): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window) || !window.isSecureContext) return;
  try {
    const url = new URL(`${basePath.replace(/\/$/, "")}/notification-sound-pref`, window.location.href);
    const cache = await caches.open(CACHE);
    await cache.put(url, new Response(value, { headers: { "content-type": "text/plain" } }));
  } catch { /* Cache Storage 不可用时，后台推送按默认静音处理 */ }
}

export function playNotificationSound(basePath: string, tag: string): void {
  const sound = readNotificationSound();
  if (sound === "off" || sound === "system") return;
  const now = Date.now();
  if (now - (recentlyPlayed.get(tag) ?? 0) < 2000) return;
  recentlyPlayed.set(tag, now);
  const audio = new Audio(`${basePath.replace(/\/$/, "")}/api/notification-sounds/${sound}.wav`);
  void audio.play().catch(() => {});
}
