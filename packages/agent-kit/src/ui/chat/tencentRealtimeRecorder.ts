"use client";

/**
 * 腾讯云实时 ASR WebSocket 录音器（浏览器 / Electron renderer 通用）。
 *
 * 服务端 POST /api/audio/session 已签好 wss URL；本模块只负责：
 *   getUserMedia → AudioContext 降采样 16k PCM16 → 推 wss → 解析 voice_text_str。
 *
 * slice_type===2 是一句的最终结果；中间结果会整句覆盖当前句文本。
 */

export interface RealtimeAsrResult {
  /** 累计全文（含已 final 的句子 + 当前句中间结果）。 */
  text: string;
  final: boolean;
}

export interface RealtimeRecorderHandle {
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
}

function pcm16Buffer(input: Float32Array, inputRate: number, outputRate = 16000): ArrayBuffer {
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let c = start; c < end; c += 1) sum += input[c];
    const s = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output.buffer;
}

export interface CreateRealtimeRecorderOptions {
  url: string;
  onResult: (result: RealtimeAsrResult) => void;
  onError?: (error: Error) => void;
  onAmplitude?: (value: number) => void;
}

export async function createTencentRealtimeRecorder({
  url,
  onResult,
  onError,
  onAmplitude,
}: CreateRealtimeRecorderOptions): Promise<RealtimeRecorderHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new Ctx();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silent = context.createGain();
  silent.gain.value = 0;
  let active = true;
  let cumulative = "";
  /**
   * 是否已发起收尾（stop()/cancel()）。
   * 腾讯云推完 {final:1} 后直接 TCP 断开、不走 close 握手 → code 1006。
   * 这是正常终局，不能当「连接中断」上报（否则一松手就报错、还把 Home 动画收掉）。
   */
  let stopping = false;

  socket.addEventListener("message", (event) => {
    let payload: { code?: number; message?: string; result?: { voice_text_str?: string; slice_type?: number } };
    try { payload = JSON.parse(event.data as string); } catch { return; }
    if (payload.code !== 0) { onError?.(new Error("语音转写失败，请重试")); return; }
    const r = payload.result;
    if (!r || typeof r.voice_text_str !== "string") return;
    const isFinal = r.slice_type === 2;
    if (isFinal) {
      cumulative = cumulative ? `${cumulative}${/\s$/.test(cumulative) ? "" : " "}${r.voice_text_str}` : r.voice_text_str;
      onResult({ text: cumulative, final: true });
    } else {
      onResult({ text: cumulative ? `${cumulative}${/\s$/.test(cumulative) ? "" : " "}${r.voice_text_str}` : r.voice_text_str, final: false });
    }
  });
  socket.addEventListener("error", () => { if (!stopping) onError?.(new Error("语音转写连接中断")); });

  await new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error("语音服务连接超时")), 10_000);
    socket.addEventListener("open", () => { window.clearTimeout(t); resolve(); }, { once: true });
    socket.addEventListener("error", () => { window.clearTimeout(t); reject(new Error("语音服务暂时连不上")); }, { once: true });
  });

  processor.onaudioprocess = (event) => {
    if (!active || socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    if (onAmplitude) {
      let sum = 0;
      for (let i = 0; i < input.length; i += 8) sum += input[i] * input[i];
      onAmplitude(Math.min(1, Math.sqrt(sum / (input.length / 8)) * 3));
    }
    socket.send(pcm16Buffer(input, context.sampleRate));
  };
  source.connect(processor);
  processor.connect(silent);
  silent.connect(context.destination);

  const release = async () => {
    active = false;
    processor.disconnect();
    source.disconnect();
    silent.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    await context.close().catch(() => {});
  };
  return {
    stop: async () => {
      stopping = true;
      await release();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "end" }));
      window.setTimeout(() => socket.close(), 1500);
    },
    cancel: async () => {
      stopping = true;
      await release();
      socket.close();
    },
  };
}
