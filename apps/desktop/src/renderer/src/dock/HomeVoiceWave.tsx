"use client";
import { useEffect, useRef } from "react";

/**
 * Home 圆钮上的语音声波（按住 Windows 右 Alt / macOS Option 录音时出现）。
 *
 * 视觉参考：一枚深色圆盘 + 一圈细白竖线 + 外圈蓝色辉光。竖线**以圆盘边缘为对称中心**
 * 双向生长——出声时一头朝圆心伸、另一头穿出圆盘边缘往外拓；安静时是一圈很短的细齿，
 * 长度随麦克风音量起伏（既向内、也向外拓展）。
 *
 * 这版相对初版做了几处收敛（按验收反馈）：
 *  · 线更**短 / 细 / 稀疏**（根数按轨道周长动态算 ≈44、宽 1.5px、最长 11px，首尾均匀无大缝）；
 *  · 波的**起伏更小**：音量只调制不到一半的动态范围，不会有炸裂感；
 *  · **层次感**：绕圆叠加两条不同波长的行进波（3 与 5 个波长），两者错频形成摩尔纹；
 *    再给每根线加一个**余热（afterglow）**——波峰过去后亮度不会瞬间归零，而是缓慢衰减，
 *    像"前一个波震过之后还留着一点温度"，所以一圈里能同时看到好几层的余韵。
 *  · **双向生长**：不再把外端钉死在圆周（那样只会朝内长）；改为以边缘为对称中心 scaleY，
 *    音量越大线越长、同时往外拓，符合参考图"竖线跨在盘缘、向外探出"的观感。
 *
 * 性能：音量每帧都在变，**绝不能**走 React state（会把整棵 launcher 每帧重渲染）。
 * 全部在自己的 rAF 里直接写 DOM 的 transform / opacity。
 */

/** 竖线对称中心所在的半径（px）：以圆盘边缘为对称中心双向生长，
 *  所以这里取比盘缘（r≈25）略小的 21，给「往外拓」留出空间，外端最远可探到 r≈26.5。
 *  这个半径同时就是这圈竖线「轨道」的半径，下面用它来反推根数与线宽。 */
const ROOT_RADIUS = 21;
/** 竖线数量：**固定**（不再按周长动态取整），避免"周长÷线宽除不尽"导致首尾出现大缝。
 *  适当减少（44 → 36），让每根线更稀疏、间隙更均匀。 */
const BAR_COUNT = 36;
/**
 * 竖线宽度（px）：由「轨道周长 ÷ 固定数量」推导并取整像素——
 *  步距 pitch = 2π·R/N ≈ 4.01px，线宽 = round(pitch / 2) = 2px，间隙 = pitch − 线宽 ≈ 2px。
 *  整圈角度均匀 + 整数像素线宽，任意相邻两根的间隙都一致，不再有"某处突然多出一截缝"。
 *  以后圆钮变大（R 变大），线宽也会自动跟着变。
 */
const BAR_WIDTH = Math.max(1, Math.round((2 * Math.PI * ROOT_RADIUS) / BAR_COUNT / 2));
/** 竖线最大长度（px）：伸到接近圆心但不能压住图标。 */
const MAX_LENGTH = 10;
/** 安静时的初始长度（px）：很短的一圈细齿。 */
const MIN_LENGTH = 3;
/** 旋转周期（秒）：与中间光环反向。 */
const SPIN_PERIOD_SEC = 11;
/** 转写（ASR 处理中）时的旋转周期（秒）：明显加快，告诉用户"还在处理，别急"。 */
const TRANSCRIBE_SPIN_PERIOD_SEC = 2.6;
/** 转写时竖线的固定长度（px）：处理中不做任何幅度变化，保持一圈均匀恒定的细齿，
 *  只用「加速旋转 + 强烈辉光」传达"仍在处理"，不让线条自身抖动起伏。
 *  比录音态的平均长度更收敛，避免转写时整圈线显得过粗。 */
const TRANSCRIBE_LENGTH = 5;

/** 把 0..1 的音量映射到"波能"。×3 把正常说话推到可用区间。 */
function levelFromAmplitude(amplitude: number): number {
  return Math.min(1, Math.max(0, amplitude * 3));
}

export interface HomeVoiceWaveProps {
  /** 是否处于录音态（按住语音键）。false 时整体淡出。 */
  active: boolean;
  /**
   * 是否处于「转写中」（松手后、ASR 返回前）。
   * 录音一停麦克风音量就归零，若还按录音态渲染，竖线会齐刷刷退回初始长度、
   * 看起来像"没录上"。这里切到独立「处理中」状态：竖线**保持均匀恒定、无任何幅度变化**，
   * 全靠「加速旋转 + 强烈辉光脉动」来传达"仍在转文字"，不让线条自己抖动。
   */
  transcribing?: boolean;
  /** 读取实时音量的函数（0..1）。传函数而不是数值，组件内部在自己的 rAF 里轮询。 */
  readAmplitude: () => number;
  /** 竖线颜色。 */
  color?: string;
  /** 外围辉光颜色。 */
  glowColor?: string;
}

export default function HomeVoiceWave({ active, transcribing = false, readAmplitude, color, glowColor }: HomeVoiceWaveProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const barsRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const transcribingRef = useRef(transcribing);
  transcribingRef.current = transcribing;
  const readRef = useRef(readAmplitude);
  readRef.current = readAmplitude;

  useEffect(() => {
    const bars = barsRef.current;
    const glow = glowRef.current;
    if (!bars) return;
    const spans = Array.from(bars.querySelectorAll<HTMLElement>(".home-voice-wave-bar > i"));
    if (!spans.length) return;

    /** 每根线的长度偏好（0.85~1），避免一圈完全对称。 */
    const bias = Array.from({ length: BAR_COUNT }, (_, i) => 0.85 + 0.15 * Math.abs(Math.sin(i * 12.9898 + 4.1)));
    /** 每根线的余热记忆：波峰过去后缓慢衰减，制造"余温"。 */
    const after = new Array(BAR_COUNT).fill(0);
    const lengths = new Array(BAR_COUNT).fill(MIN_LENGTH);
    let level = 0;
    let spin = 0;
    let raf = 0;
    let last = 0;

    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
      last = now;
      const t = now / 1000;
      const isActive = activeRef.current;
      /** 转写中：录音已停、麦克风音量归零，改用独立的"处理中"动画。 */
      const isTranscribing = transcribingRef.current;

      // 电平整流：上升快、下降慢（像电平表）。转写中不用音量，恒为 0。
      const raw = isActive && !isTranscribing ? levelFromAmplitude(readRef.current()) : 0;
      const tau = raw > level ? 0.06 : 0.28;
      level += (raw - level) * (1 - Math.exp(-dt / tau));

      // 自带旋转，与中间光环反向（负向）。转写中明显加速。
      spin -= (360 / (isTranscribing ? TRANSCRIBE_SPIN_PERIOD_SEC : SPIN_PERIOD_SEC)) * dt;
      if (spin <= -360) spin += 360;

      // 余热衰减的时间常数：波过去后约 0.4s 才散掉。
      const afterDecay = Math.exp(-dt / 0.4);

      for (let i = 0; i < BAR_COUNT; i++) {
        const phi = (i / BAR_COUNT) * Math.PI * 2;
        const el = spans[i];
        if (isTranscribing) {
          // 「处理中」：竖线**不做任何幅度变化**——保持一圈均匀、恒定的长度，
          // 只用「加速旋转 + 强烈辉光」告诉用户仍在处理，而不是让线条自己抖动起伏。
          // 直接写整数像素高度（不走 scaleY 浮点缩放）：scaleY(0.4545) 会在放大时把个别线
          // 渲染成 4/6px 的亚像素长度差，视觉上就是"一根线忽长忽短、角度歪"。整数高度 + 固定
          // top（-2.5 = 5px 中心对齐 bar 原点）保证 36 根线长度、角度完全一致。
          el.style.height = `${TRANSCRIBE_LENGTH}px`;
          el.style.top = `${-TRANSCRIBE_LENGTH / 2}px`;
          el.style.transform = `translateY(${(-ROOT_RADIUS).toFixed(2)}px)`;
          el.style.opacity = (0.5 + 0.5 * (TRANSCRIBE_LENGTH / MAX_LENGTH)).toFixed(3);
          continue;
        }
        // 录音态：恢复标准几何（11px 高、top -5.5 中心对齐），长度随音量动画。
        el.style.height = `${MAX_LENGTH}px`;
        el.style.top = `${-MAX_LENGTH / 2}px`;
        // 两条不同波长的行进波：3 与 5 个波长绕圆一圈，错频 → 摩尔纹般的层次。
        const wA = 0.5 + 0.5 * Math.sin(3 * phi - t * 2.6);
        const wB = 0.5 + 0.5 * Math.sin(5 * phi - t * 4.1);
        // 当前波峰包络（0..1）。
        const env = 0.6 * wA + 0.4 * wB;
        // 余热：记住局部峰值，缓慢衰减；波过去了还留一点。
        const a = after[i];
        const nextA = Math.max(a * afterDecay, env);
        after[i] = nextA;
        // 当前包络占 7 成、余热余韵占 3 成；再乘 level → 没声音时回到极短。
        const drive = level * (env * 0.7 + nextA * 0.3);
        // 起伏收敛：音量调制的动态范围（0.6），比之前 0.45 更明显、但仍是"涨落"而非炸裂。
        const targetLen = MIN_LENGTH + drive * (MAX_LENGTH - MIN_LENGTH) * 0.6 * bias[i];
        lengths[i] += (targetLen - lengths[i]) * 0.3;
        const len = lengths[i];
        const ratio = Math.max(0.02, len / MAX_LENGTH);
        // 关键：translateY 把竖线对称中心钉在 ROOT_RADIUS（盘缘附近），
        // 再以中心为原点 scaleY → 音量越大线越长、一头朝圆心伸、一头穿出盘缘往外拓。
        el.style.transform = `translateY(${(-ROOT_RADIUS).toFixed(2)}px) scaleY(${ratio.toFixed(3)})`;
        // 透明度也给一个较高下限（0.5）：安静时线虽短但依旧清晰，
        // 避免出现"某段线又短又淡、看着像断了一截"的错觉。
        el.style.opacity = (0.5 + 0.5 * Math.min(1, ratio)).toFixed(3);
      }

      bars.style.transform = `rotate(${spin.toFixed(2)}deg)`;

      // 外围辉光：录音时随音量呼吸；转写时改为强烈脉动（"正在处理"）。
      if (glow) {
        if (isTranscribing) {
          const pulse = 0.5 + 0.5 * Math.sin(t * 5.6);
          glow.style.opacity = (0.45 + 0.55 * pulse).toFixed(3);
          glow.style.filter = `blur(${(9 + 8 * pulse).toFixed(1)}px)`;
        } else {
          const g = level;
          glow.style.opacity = (0.16 + g * 0.84).toFixed(3);
          glow.style.filter = `blur(${(7 + g * 8).toFixed(1)}px)`;
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={rootRef}
      className={`home-voice-wave${active ? " is-active" : ""}`}
      aria-hidden="true"
      style={{
        ...(color ? { "--home-wave-color": color } : null),
        ...(glowColor ? { "--home-wave-glow": glowColor } : null),
      } as React.CSSProperties}
    >
      {/* 外围辉光：贴在圆盘外缘的一圈光，音量越大越亮越散。 */}
      <div ref={glowRef} className="home-voice-wave-glow" />
      <div ref={barsRef} className="home-voice-wave-bars">
        {Array.from({ length: BAR_COUNT }, (_, i) => {
          const angle = (360 / BAR_COUNT) * i;
          return (
            <span className="home-voice-wave-bar" key={i} style={{ transform: `rotate(${angle}deg)` }}>
              <i style={{ width: BAR_WIDTH, left: `${-BAR_WIDTH / 2}px` }} />
            </span>
          );
        })}
      </div>
    </div>
  );
}
