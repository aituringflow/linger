/**
 * 各窗口的实时麦克风音量（0..1）。
 *
 * kit 每帧直接写这些 ref，Dock 在自己的动画帧里读 —— 全程不经过 React：
 * 音量是 60fps 的量，走 state 会把整棵 launcher 每帧重渲染一遍。
 * 「是否正在录音」是低频状态，走 reducer（`voiceRecordingWindow`），只有它切 UI。
 */
const amplitudeByWindow = new Map<string, { current: number }>();

export function voiceAmplitudeRefFor(windowId: string): { current: number } {
  let ref = amplitudeByWindow.get(windowId);
  if (!ref) {
    ref = { current: 0 };
    amplitudeByWindow.set(windowId, ref);
  }
  return ref;
}

export function currentVoiceAmplitude(windowId: string): number {
  return amplitudeByWindow.get(windowId)?.current ?? 0;
}
