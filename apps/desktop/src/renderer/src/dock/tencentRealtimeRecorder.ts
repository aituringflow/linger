/**
 * 腾讯云实时语音识别录音器（launcher renderer 侧）。
 *
 * 链路：
 *   1. 调用方先 POST <web>/api/audio/session（带登录 cookie）拿一个带签名的 wss URL；
 *   2. 本模块 getUserMedia 拿麦克，AudioContext + ScriptProcessor 把输入降采样到
 *      16kHz/单声道/PCM16，每 4096 采样推一帧给腾讯云；
 *   3. 腾讯云推回 { code:0, result: { voice_text_str, slice_type, index } }：
 *        - slice_type===2 表示这一句是最终结果（前面的中间结果会被它替换）；
 *        - onResult({ text, final }) 把当前完整识别文本回调给调用方，由调用方灌进输入框。
 *
 * 凭据（SecretId/Key）不下发；本模块只拿一个 10 分钟有效的签名 URL。
 */

export interface RealtimeAsrResult {
  /** 当前累计识别文本（含中间结果，调用方直接 setText 即可）。 */
  text: string;
  /** 是否是一句的最终结果（slice_type===2）。 */
  final: boolean;
}

export interface RealtimeRecorderHandle {
  /**
   * 结束录音，并**等腾讯云把最后一句识别结果推回来**（最多 1.5s），返回累计识别文本。
   *
   * 为什么不是「发完 end 就返回」：语音优先要「松手即发送」，最后一句常常是在松手
   * 之后才 final 的（尤其是说完立刻松手）。不等这一步，发出去的消息就会少最后半句。
   */
  stop: () => Promise<string>;
  cancel: () => Promise<void>;
}

/** 把 AudioContext 的浮点输入降采样到 16kHz PCM16。 */
function pcm16Buffer(input: Float32Array, inputRate: number, outputRate = 16000): ArrayBuffer {
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const output = new Int16Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let total = 0;
    for (let cursor = start; cursor < end; cursor += 1) total += input[cursor];
    const sample = Math.max(-1, Math.min(1, total / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}

export interface CreateRealtimeRecorderOptions {
  /** 服务端签好的 wss://... URL。 */
  url: string;
  /** 每收到一帧识别文本就回调（含中间结果）。text 是累计全文。 */
  onResult: (result: RealtimeAsrResult) => void;
  onError?: (error: Error) => void;
  /** 实时音量（-1..1），用于 Home 声波动画。 */
  onAmplitude?: (value: number) => void;
}

/**
 * 预览用假录音器：不连腾讯云、不申请麦克风，只把一段演示文案「逐字流式」灌进输入框，
 * 并合成一个音量曲线驱动 Home 声波，让语音优先的完整交互（转圈 → 声波 → 首字浮出输入框 →
 * 松手自动发）在没有 ASR 凭据 / 网络不通时也能本地验收。
 *
 * 行为刻意贴近真录音器：stop() 返回累计文本（这里直接给完整演示文案），finishVoiceFirst
 * 据此自动发出；过程中先推空（首字前 Home 只转圈 + 声波），再分几段吐字，最后整段 final。
 */
export function createFakeRealtimeRecorder({
  onResult,
  onAmplitude,
}: {
  onResult: (result: RealtimeAsrResult) => void;
  onAmplitude?: (value: number) => void;
}): Promise<RealtimeRecorderHandle> {
  const demo =
    "这是语音优先模式的本地演示，松手后会作为一条新对话直接发出，全程不连接腾讯云。";
  let cancelled = false;
  let acc = "";
  // 慢起伏正弦 + 抖动，听起来像在说话；不申请真实麦克风，避免预览也弹权限框。
  const ampTimer = window.setInterval(() => {
    if (cancelled) return;
    onAmplitude?.(0.35 + 0.22 * Math.sin(Date.now() / 210) + Math.random() * 0.08);
  }, 60);
  const chunks = [demo.slice(0, 14), demo.slice(14, 28), demo.slice(28, 42), demo.slice(42)];
  let i = 0;
  const textTimer = window.setInterval(() => {
    if (cancelled) return;
    if (i < chunks.length) {
      acc += chunks[i];
      i += 1;
      onResult({ text: acc, final: i === chunks.length });
    }
  }, 360);
  const cleanup = () => {
    cancelled = true;
    window.clearInterval(ampTimer);
    window.clearInterval(textTimer);
  };
  return Promise.resolve({
    stop: async () => {
      cleanup();
      // 演示：松手即给完整文案，确保发出去的是一句完整的话。
      acc = demo;
      onResult({ text: acc, final: true });
      return acc;
    },
    cancel: async () => {
      cleanup();
    },
  });
}

/** getUserMedia 的失败原因翻成人话：权限被拒 / 没有设备 / 其它。
 *  调用方会拿这句直接显示在 Home 上方的错误条里，所以必须是可操作的表述，
 *  不能只说「无法启动语音」。 */
function describeMicError(error: unknown): Error {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new Error("麦克风权限被拒绝");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new Error("没有可用的麦克风设备");
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return new Error("麦克风被其它程序占用");
  }
  const message = error instanceof Error && error.message ? error.message : "无法打开麦克风";
  return new Error(message);
}

export async function createTencentRealtimeRecorder({
  url,
  onResult,
  onError,
  onAmplitude,
}: CreateRealtimeRecorderOptions): Promise<RealtimeRecorderHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
  } catch (error) {
    throw describeMicError(error);
  }
  const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioContextClass();
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close().catch(() => {});
    throw new Error(`实时转写连接地址无效：${error instanceof Error ? error.message : String(error)}`);
  }
  socket.binaryType = "arraybuffer";
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const silent = context.createGain();
  silent.gain.value = 0;
  let active = true;
  // 累计文本：中间结果替换当前句，最终结果保留并换行。
  let cumulative = "";
  /** 启动阶段的失败只由「握手」那条路径上报，避免和下面的常驻 error 监听重复弹两次错误。 */
  let opened = false;
  /**
   * 是否已发起收尾（stop() 里发了 {"type":"end"}）。
   *
   * 腾讯云推完最后一句 + {final:1} 之后是**直接 TCP 断开**的，不走 WebSocket close 握手，
   * 于是 close 事件的 code 是 1006（异常关闭）。这是正常收尾，不是故障 ——
   * 早先把它当错误上报，一松手就弹「连接已断开」并把 Home 动画和输入框一起收掉。
   */
  let stopping = false;
  /**
   * 「服务端已经把这轮说完」的等待者。
   * 腾讯云在收完 end 之后会推一帧 `{ final: 1 }`，表示不会再有任何识别结果 ——
   * 语音优先的「松手即发」必须等到这一帧，否则最后一句会被截掉。
   */
  let endWaiters: Array<() => void> = [];
  const markEnded = () => {
    const waiters = endWaiters;
    endWaiters = [];
    for (const resolve of waiters) resolve();
  };
  const fail = (error: Error) => { if (opened) onError?.(error); };
  /** 握手失败时把麦克风、AudioContext、socket 全收干净 —— 否则静默占着麦克风，
   *  用户会以为「没录上」，下次再按还可能因为设备被占而二次失败。 */
  const teardown = () => {
    try { processor.disconnect(); } catch { /* 未连接时忽略 */ }
    try { source.disconnect(); } catch { /* 未连接时忽略 */ }
    try { silent.disconnect(); } catch { /* 未连接时忽略 */ }
    stream.getTracks().forEach((track) => track.stop());
    void context.close().catch(() => undefined);
    try { socket.close(); } catch { /* 已关闭时忽略 */ }
  };

  socket.addEventListener("message", (event) => {
    let payload: { code?: number; message?: string; final?: number; result?: { voice_text_str?: string; slice_type?: number; index?: number } };
    try { payload = JSON.parse(event.data as string); } catch { return; }
    if (payload.code !== 0) {
      fail(new Error("语音转写失败，请重试"));
      return;
    }
    // `final: 1` = 这一轮彻底结束（end 之后服务端不再推结果）。它没有 result，先处理掉。
    if (payload.final === 1) {
      markEnded();
      return;
    }
    const result = payload.result;
    if (!result || typeof result.voice_text_str !== "string") return;
    const isFinal = result.slice_type === 2;
    // voice_text_str 是「当前句」文本（中间结果会整句覆盖）；final 时把它并入累计。
    if (isFinal) {
      cumulative = cumulative ? `${cumulative}${/\s$/.test(cumulative) ? "" : " "}${result.voice_text_str}` : result.voice_text_str;
      onResult({ text: cumulative, final: true });
    } else {
      onResult({ text: cumulative ? `${cumulative}${/\s$/.test(cumulative) ? "" : " "}${result.voice_text_str}` : result.voice_text_str, final: false });
    }
  });
  // 已经在跑了才谈「中断」：握手阶段的 error 由下面那个 once 监听负责，否则一次连接失败会报两遍。
  // stopping 之后也不算中断：那是我们自己发 end 让服务端收尾，断开是预期的。
  socket.addEventListener("error", () => { if (!stopping) fail(new Error("语音转写连接中断")); });
  socket.addEventListener("close", event => {
    // 连接关掉就说明不可能再有结果了：等 stop() 的地方要立刻放行（否则会白等满 1.5s）。
    markEnded();
    // 自己发起的收尾（已发 end）之后的断开是正常终局，哪怕 code 是 1006 也不报错。
    if (opened && !stopping && event.code !== 1000) onError?.(new Error("语音转写连接已断开"));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("语音服务连接超时")), 10_000);
      socket.addEventListener("open", () => { window.clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("语音服务暂时连不上"));
      }, { once: true });
    });
  } catch (error) {
    teardown();
    throw error;
  }
  opened = true;

  processor.onaudioprocess = (event) => {
    if (!active || socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    // 实时音量：取 RMS，归一化到 0..1。
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
    stream.getTracks().forEach((track) => track.stop());
    await context.close().catch(() => {});
  };
  return {
    stop: async () => {
      await release();
      if (socket.readyState === WebSocket.OPEN) {
        // 告诉服务端「我说完了」；它会先把剩下的识别结果推完，再回一帧 { final: 1 }。
        // 置位 stopping：此后服务端断开（含 1006）都算正常收尾，不当成连接故障。
        stopping = true;
        socket.send(JSON.stringify({ type: "end" }));
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = () => { if (!settled) { settled = true; resolve(); } };
          endWaiters.push(settle);
          // 兜底：网络抖动 / 服务端不回 final 时不能让界面一直挂在「识别中」。
          window.setTimeout(settle, 1500);
        });
      }
      try { socket.close(); } catch { /* 已关闭时忽略 */ }
      return cumulative;
    },
    cancel: async () => {
      // 主动取消同样是「我们发起收尾」：别把随后的断开算成故障。
      stopping = true;
      await release();
      socket.close();
      return;
    },
  };
}
