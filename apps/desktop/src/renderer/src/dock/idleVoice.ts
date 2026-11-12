/**
 * 待机态（没有任何应用/窗口打开）下，由 Launcher 自己接管「按住语音键 → 听麦克风 → 驱动 Home 声波」。
 *
 * 为什么需要它：kit 的语音按住逻辑在 ChatComposer 里，而 ChatComposer 只有在 AgentWindow
 * 挂载时才存在。纯待机时 Home 底下没有任何窗口，kit 根本没在监听按键 —— 所以「待机按右 Alt
 * 就出声波」必须由 Launcher 在全局自己实现（这才是 AgentOS 该有的手感）。
 *
 * 设计：
 *  · 用户按住语音键、且当前没有任何窗口在跑（openWindows 为空、也没有 hover 预览），
 *    Launcher 直接标记 Home 进入录音态，并自己开麦克风读音量（驱动 Home 声波）。
 *  · 同时用 MediaRecorder 录下真实音频；松手 → 关麦、清状态，Home 声波淡出。
 *  · **真实转写**：若调用方提供了 token / transcribe 端点，松手后会先把录到的音频
 *    过一遍本机 Agent 服务的 /api/voice/transcribe，拿到文字后回调 onTranscribed ——
 *    这样「待机按 Ctrl 说话、松手出文字」与窗口内的体验一致（that's the whole point of AgentOS）。
 *  · 只听不转的「预览」模式由 voicePreviewOnly 控制：此时不传 transcribe 端点，
 *    松手只淡出声波、不产生费用。
 *  · 麦克风被拒（无权限等）时静默失败：声波仍会出现，只是线是平的、且不转写。
 */

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let rafId = 0;
let ampRef: { current: number } | null = null;

/** 真实录音（用于松手转写）。 */
let mediaRecorder: MediaRecorder | null = null;
type RecordingJob = { chunks: BlobPart[]; cfg: NonNullable<typeof transcribeCfg>; mimeType: string; cancelled: boolean };
let recordingJob: RecordingJob | null = null;
/** 松手时要做的转写配置；不传 = 仅预览（不转写）。 */
let transcribeCfg: {
  tokenUrl: string;
  transcribeUrl: string;
  onTranscribed: (text: string) => void;
  onTranscribeEnd?: () => void;
} | null = null;
/** 当前是否还在录音（避免重复开关）。 */
let recording = false;
let captureGeneration = 0;

/** 平台相关的语音按住键（与 kit shared/platform.ts 的 isVoiceHoldKey 同口径）。 */
export function isVoiceHoldKey(event: Pick<globalThis.KeyboardEvent, "key" | "code" | "location">): boolean {
  const ua = navigator.userAgent || "";
  const isMac = /Mac|Darwin/.test(ua) || document.documentElement.dataset.desktopPlatform === "darwin";
  if (isMac) return event.key === "Alt" || event.code === "AltLeft" || event.code === "AltRight";
  return event.code === "AltRight" || ((event.key === "Alt" || event.key === "AltGraph") && event.location === 2);
}

export interface IdleVoiceOptions {
  /** 转写完成后回调（拿到识别文字）。不传 = 仅预览、不转写。 */
  onTranscribed?: (text: string) => void;
  /**
   * 转写流程结束（成功/失败/没录到音都会调用）。宿主用它关掉"处理中"状态，
   * 避免 Home 声波永远卡在转写动画上。
   */
  onTranscribeEnd?: () => void;
  /** 取短时令牌的端点（POST 返回 { token }）。 */
  tokenUrl?: string;
  /** 转写端点（multipart file + Bearer token）。 */
  transcribeUrl?: string;
}

/** 选择一个浏览器支持且端点接受的录音格式。 */
function pickMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const t of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

/** 开始捕获麦克风：把实时音量写进 ampRef（驱动 Home 声波），并录下音频供松手转写。 */
export async function startIdleVoiceCapture(amp: { current: number }, opts?: IdleVoiceOptions): Promise<void> {
  if (rafId || ampRef) return;
  const generation = ++captureGeneration;
  ampRef = amp;
  if (opts?.onTranscribed && opts.tokenUrl && opts.transcribeUrl) {
    transcribeCfg = {
      tokenUrl: opts.tokenUrl,
      transcribeUrl: opts.transcribeUrl,
      onTranscribed: opts.onTranscribed,
      onTranscribeEnd: opts.onTranscribeEnd,
    };
  } else {
    transcribeCfg = null;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (generation !== captureGeneration) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    mediaStream = stream;
  } catch {
    // 拿不到麦克风：不报错，Home 声波照常淡入（线是短的、平的），也不转写。
    return;
  }
  try {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(mediaStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      if (!analyser || !ampRef) return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const v = Math.abs(data[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      ampRef.current = peak;
      rafId = requestAnimationFrame(loop);
    };
    loop();

    // 真实录音：MediaRecorder 兼容性很好，失败也不影响声波（只是松手不转写）。
    if (transcribeCfg) {
      try {
        const mimeType = pickMimeType();
        mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
        const job: RecordingJob = { chunks: [], cfg: transcribeCfg, mimeType: mediaRecorder.mimeType || "audio/webm", cancelled: false };
        recordingJob = job;
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) job.chunks.push(e.data); };
        mediaRecorder.onstop = () => { void handleRecorderStop(job); };
        mediaRecorder.start();
        recording = true;
      } catch {
        mediaRecorder = null;
        recording = false;
      }
    }
  } catch {
    stopIdleVoiceCapture({ transcribe: false });
  }
}

/** MediaRecorder 停止后：若有待转写配置，取 token → 调 transcribe → 回传文字。 */
async function handleRecorderStop(job: RecordingJob) {
  if (job.cancelled) return;
  const { cfg, chunks, mimeType } = job;
  if (chunks.length === 0) {
    cfg.onTranscribeEnd?.();
    return;
  }
  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) {
    cfg.onTranscribeEnd?.();
    return;
  }
  try {
    const tokResp = await fetch(cfg.tokenUrl, { method: "POST" });
    const tokJson = (await tokResp.json()) as { token?: string };
    const token = tokJson.token;
    if (!token) return;
    const fd = new FormData();
    fd.append("file", blob, "voice.webm");
    const resp = await fetch(cfg.transcribeUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const data = (await resp.json()) as { text?: string; error?: string };
    const text = (data.text || "").trim();
    if (text) cfg.onTranscribed(text);
  } catch {
    // 转写失败（网络/服务不可用）静默忽略：声波已淡出，不影响其它功能。
  } finally {
    // 无论成功失败都要通知宿主结束"处理中"状态，否则 Home 声波会永远卡在转写动画。
    cfg.onTranscribeEnd?.();
  }
}

/** 停止捕获并清理。transcribe 默认 true（松手正常转写）；失焦等场景可传 false 跳过。 */
export function stopIdleVoiceCapture(opts?: { transcribe?: boolean }): void {
  captureGeneration++;
  const doTranscribe = opts?.transcribe !== false;
  if (mediaRecorder && recording) {
    try {
      if (!doTranscribe && recordingJob) recordingJob.cancelled = true;
      mediaRecorder.stop(); // Final dataavailable is delivered before onstop.
    } catch {
      mediaRecorder = null;
      recording = false;
    }
  } else if (!doTranscribe) {
    transcribeCfg = null;
  }
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  if (audioCtx) {
    audioCtx.close().catch(() => undefined);
    audioCtx = null;
  }
  analyser = null;
  recordingJob = null;
  transcribeCfg = null;
  mediaRecorder = null;
  recording = false;
  if (ampRef) ampRef.current = 0;
  ampRef = null;
}
