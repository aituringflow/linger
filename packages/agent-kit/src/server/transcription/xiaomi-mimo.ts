/**
 * 旧的录音上传 ASR 入口已废弃。
 * 当前语音输入统一使用腾讯云实时语音识别（/api/audio/session）。
 */
export async function transcribeWithXiaomiMimo(): Promise<never> {
  throw new Error("录音上传转写已停用，请使用腾讯云实时语音识别");
}
