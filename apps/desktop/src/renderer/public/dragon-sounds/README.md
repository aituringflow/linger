# 小龙喷火音效

`apps/desktop/src/renderer/public/dragon-sounds/dragon-fire.wav` —— 小龙点击喷火时播放。

## 素材来源

原始素材来自 [Mixkit](https://mixkit.co/free-sound-effects/) 免费音效库，
采用 [Mixkit Sound Effects Free License](https://mixkit.co/license/#sfxFree)：
可用于商业与非商业项目，**无需署名**；不可单独转售、不可宣称为自己的创作。

| Mixkit id | 名称 | 在成音中的角色 |
| --- | --- | --- |
| [1963](https://mixkit.co/free-sound-effects/dinosaur/) | Dinosaur monster roar | 低通 820Hz 作胸腔共鸣垫底（张嘴瞬间起） |
| [1327](https://mixkit.co/free-sound-effects/fire/) | Aggressive fire flame | 高通 170Hz 作火焰嘶嘶主体（点火进入后自然衰减） |

## 后期处理

两个素材按 dragonpet 的**视觉时序**重新混音、塑形，烘焙成单个 WAV：

| 时间 | 视觉事件（`DragonPet.tsx` / `dragonBreath.ts`） | 音频事件 |
| --- | --- | --- |
| 0ms | 张嘴开始（`mouthOpen = smooth(age/170)`） | 低频龙吼起 |
| 130ms | — | 火焰主体点着（略早于视觉的 170ms，补偿视听感知延迟） |
| 170ms | 火焰首次可见（`growth` 从 0 起涨） | — |
| 440ms | 火焰长到最长（`growth = elapsed/270` 饱和） | — |
| 1000ms | — | 开始淡出 |
| 1020ms | 开始淡出（`fade = (1150-elapsed)/300`） | — |
| 1310ms | 火焰消失 | 声音收尾 |

其他处理：3ms 淡入防爆音、30ms 淡出防截断、直流偏置去除、
峰值归一化到 **-1.5 dBFS**（与项目现有提示音 `bright.wav` -1.4 / `calm.wav` -1.7 同量级）、
单声道 16bit 44.1kHz（与 `notification-sounds/*.wav` 格式一致）。

最终参数：时长 1.42s、125 KB。

## 开关

设置 → 宠物 → 「小龙喷火音效」。开启后点击小龙喷火时播放音效。
该偏好持久化在 launcher 状态的 `dragonFireSound` 字段（默认 `false`）。

实现见 `apps/desktop/src/renderer/src/dock/dragonSound.ts`。
