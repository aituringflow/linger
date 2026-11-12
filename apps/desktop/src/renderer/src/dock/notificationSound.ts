import type { NotificationSound } from "../../../shared/types";

/** 自定义提示音从 public/notification-sounds 读；同一通知 2 秒内不重复播（与 kit 的限流口径一致）。 */
const recentlyPlayed = new Map<string, number>();

export function playLauncherNotificationSound(sound: NotificationSound | undefined, tag: string): void {
  if (!sound || sound === "off" || sound === "system") return;
  const now = Date.now();
  if (now - (recentlyPlayed.get(tag) ?? 0) < 2000) return;
  recentlyPlayed.set(tag, now);
  const audio = new Audio(`notification-sounds/${sound}.wav`);
  void audio.play().catch(() => {});
}
