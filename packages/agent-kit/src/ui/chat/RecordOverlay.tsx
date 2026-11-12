"use client";

import { useChatTranslation } from "./i18n.tsx";
import { useEffect, useRef, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/**
 * 移动端「按住说话」录制上弹层：实时波形 + 松开发送/松开取消文案。
 * 人机单聊与群聊共用，视觉与交互保持一致。
 *
 * 波形幅度由真实麦克风音量（amplitude，0..1）门控：无声时柱子≈静止，
 * 有声时按空间相位差形成横向行进波；柱高直写 height（无 transform，边缘清晰）。
 *
 * 两种喂数方式二选一：
 *  · amplitude prop：dictation SDK 按住说话路径，React state 驱动；
 *  · readAmplitude：实时转写路径，60fps 量走 ref，组件自己在 rAF 里读，
 *    不经过 React state（避免每帧重渲染）。
 */
export function RecordingWave({ amplitude, readAmplitude }: { amplitude: number; readAmplitude?: () => number }) {
  const N = 25;
  const targetRef = useRef(amplitude);
  const readRef = useRef(readAmplitude);
  readRef.current = readAmplitude;
  const waveRef = useRef<HTMLDivElement | null>(null);
  targetRef.current = amplitude;
  useEffect(() => {
    let raf = 0;
    let level = Math.min(1, Math.max(0, targetRef.current * 4));
    const seed = Array.from({ length: N }, (_, i) => 0.7 + 0.5 * Math.abs(Math.sin(i * 12.9898 + 4.1)));
    const freq = Array.from({ length: N }, (_, i) => 3.4 + (i % 5) * 0.22);
    const phase = Array.from({ length: N }, (_, i) => i * 0.5);
    const cur = new Array(N).fill(4);
    const tick = (now: number) => {
      const target = Math.min(1, Math.max(0, (readRef.current ? readRef.current() : targetRef.current) * 4));
      level += (target - level) * 0.15;
      const t = now / 1000;
      const spans = waveRef.current?.children;
      if (spans) {
        for (let i = 0; i < N; i++) {
          const envelope = Math.sin(Math.PI * (i + 1) / 26);
          const wave = 0.5 + 0.5 * Math.sin(t * freq[i] - phase[i]);
          const targetH = 4 + envelope * (level * 30) * seed[i] * (0.25 + 0.75 * wave);
          cur[i] += (targetH - cur[i]) * 0.35;
          const el = spans[i] as HTMLElement;
          el.style.height = `${Math.round(cur[i])}px`;
          el.style.opacity = (0.45 + envelope * 0.55).toFixed(2);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="chat-mobile-record-wave" ref={waveRef} aria-hidden="true">
      {Array.from({ length: N }, (_, index) => <span key={index} />)}
    </div>
  );
}

/** 语音按住键（Windows=右 Alt / macOS=Option）录音提示放在页面顶层，输入区隐藏时仍可见。 */
export function GlobalRecordingWave({ amplitude }: { amplitude: number }) {
  const t = useChatTranslation();
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="chat-global-record-wave" role="status" aria-label={t("voiceInput")}>
      <RecordingWave amplitude={amplitude} />
    </div>,
    document.body,
  );
}

/** 录制上弹层：cancelArmed=true 显示红色「松开取消」，否则绿色「松开发送」。 */
export default function RecordOverlay({ amplitude, cancelArmed }: { amplitude: number; cancelArmed: boolean }) {
  const t = useChatTranslation();
  // 绿「松开发送」/ 红「松开取消」：内联颜色变量，使声波柱不依赖是否位于 .chat-composer-stack 内继承。
  const recordStyle = { "--mobile-record-color": cancelArmed ? "#d95c5c" : "#2ea66a" } as CSSProperties;
  return (
    <div className="chat-mobile-record-overlay" style={recordStyle} role="status" aria-live="polite">
      <RecordingWave amplitude={amplitude} />
      <div className="chat-mobile-record-label">{cancelArmed ? t("releaseCancel") : t("releaseSend")}</div>
    </div>
  );
}
