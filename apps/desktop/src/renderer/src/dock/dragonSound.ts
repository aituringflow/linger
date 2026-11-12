/**
 * 小龙喷火音效。
 *
 * 素材：Mixkit 免费音效（Mixkit Sound Effects Free License，可商用、无需署名）。
 *   - "Dinosaur monster roar"（id 1963）→ 低通 820Hz 作胸腔共鸣垫底
 *   - "Aggressive fire flame"（id 1327）→ 高通 170Hz 作火焰嘶嘶主体
 * 两个素材按 dragonpet 的视觉时序重新混音、塑形后烘焙成单个 WAV：
 *   0ms     张嘴（低频吼声起）
 *   130ms   点火（火焰主体进入，略早于视觉的 170ms，补偿视听感知延迟）
 *   1000ms  开始淡出
 *   1310ms  火焰消失（与视觉火焰收尾对齐）
 * 峰值归一化到 -1.5 dBFS，与项目现有提示音（bright -1.4 / calm -1.7）同一量级。
 */

/** 音效文件（相对 renderer 根；public/dragon-sounds 会被 electron-vite 拷进 out/renderer）。 */
const DRAGON_FIRE_SOUND = "dragon-sounds/dragon-fire.wav";

/**
 * 复用同一个 Audio 实例：反复 new Audio() 每次都要重新解码，首播延迟明显；
 * 复用后第二次起就是零延迟。
 */
let audio: HTMLAudioElement | null = null;

/** 上次播放时间；喷火动画本身约 1.15s，连点时不该叠出多层火声。 */
let lastPlayedAt = -Infinity;

/** 同一音效的最小间隔（ms）——与动画时长一致，防止连点叠音。 */
const MIN_INTERVAL = 900;

/**
 * 播放小龙喷火音效。播放失败（被系统策略拦截等）时静默忽略，不影响喷火动画。
 *
 * enabled 传 false 时直接跳过 —— 交给调用方（设置面板的开关）决定，
 * 这样「关闭音效」这个偏好只有一处判断，不会散落到各个触发点。
 */
export function playDragonFireSound(enabled = true): void {
  if (!enabled) return;
  const now = Date.now();
  if (now - lastPlayedAt < MIN_INTERVAL) return;
  lastPlayedAt = now;
  try {
    if (!audio) {
      audio = new Audio(DRAGON_FIRE_SOUND);
      audio.preload = "auto";
    }
    audio.currentTime = 0;
    audio.volume = 0.85;
    void audio.play().catch(() => {});
  } catch {
    /* 音效不可用不应打断交互 */
  }
}
