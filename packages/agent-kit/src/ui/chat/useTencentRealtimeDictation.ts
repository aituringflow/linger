"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../shared/apiFetch.ts";
import { createTencentRealtimeRecorder, type RealtimeRecorderHandle } from "./tencentRealtimeRecorder.ts";

export type TencentDictationState = "idle" | "recording";

export interface TencentRealtimeDictation {
  state: TencentDictationState;
  elapsedSec: number;
  amplitude: number;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  setFinishIntent: (intent: "send" | "cancel") => void;
}

export function useTencentRealtimeDictation({
  endpoint,
  enabled = true,
  onText,
  onFinished,
  onError,
  amplitudeRef,
}: {
  endpoint: string;
  enabled?: boolean;
  onText?: (text: string) => void;
  onFinished?: (text: string) => void;
  onError?: (error: Error) => void;
  amplitudeRef?: { current: number } | null;
}): TencentRealtimeDictation {
  const recorderRef = useRef<RealtimeRecorderHandle | null>(null);
  const textRef = useRef("");
  const startedAtRef = useRef(0);
  const finishIntentRef = useRef<"send" | "cancel">("send");
  const finishingRef = useRef(false);
  const callbacksRef = useRef({ onText, onFinished, onError, amplitudeRef });
  callbacksRef.current = { onText, onFinished, onError, amplitudeRef };
  const [state, setState] = useState<TencentDictationState>("idle");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [amplitude, setAmplitude] = useState(0);

  const reset = useCallback(() => {
    recorderRef.current = null;
    finishingRef.current = false;
    textRef.current = "";
    startedAtRef.current = 0;
    finishIntentRef.current = "send";
    setState("idle");
    setElapsedSec(0);
    setAmplitude(0);
    if (callbacksRef.current.amplitudeRef) callbacksRef.current.amplitudeRef.current = 0;
  }, []);

  const start = useCallback(async () => {
    if (!enabled || recorderRef.current || finishingRef.current || state !== "idle") return;
    if (!window.isSecureContext) throw new Error("当前环境无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）");
    textRef.current = "";
    finishIntentRef.current = "send";
    const response = await apiFetch(endpoint, { method: "POST" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      const error = new Error(data.error || "无法获取实时语音会话") as Error & { code?: string };
      if (response.status === 401 || response.status === 403) error.code = "auth";
      throw error;
    }
    const data = await response.json() as { connection?: { url?: string } };
    if (!data.connection?.url) throw new Error("语音服务启动失败，请稍后重试");
    const recorder = await createTencentRealtimeRecorder({
      url: data.connection.url,
      onResult: ({ text }) => {
        textRef.current = text;
        callbacksRef.current.onText?.(text);
      },
      onAmplitude: (value) => {
        setAmplitude(value);
        if (callbacksRef.current.amplitudeRef) callbacksRef.current.amplitudeRef.current = value;
      },
      onError: (error) => callbacksRef.current.onError?.(error),
    });
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setState("recording");
  }, [enabled, endpoint, state]);

  const finish = useCallback(async (cancel: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || finishingRef.current) return;
    recorderRef.current = null;
    finishingRef.current = true;
    // 立即结束录音态，让按钮和波形马上切换；腾讯云最终句仍在后台收尾。
    setState("idle");
    setAmplitude(0);
    if (callbacksRef.current.amplitudeRef) callbacksRef.current.amplitudeRef.current = 0;
    const intent = finishIntentRef.current;
    if (cancel) {
      await recorder.cancel();
      reset();
      return;
    }
    await recorder.stop();
    const text = textRef.current.trim();
    reset();
    if (text && intent === "send") callbacksRef.current.onFinished?.(text);
  }, [reset]);

  const stop = useCallback(() => finish(false), [finish]);
  const cancel = useCallback(() => finish(true), [finish]);
  const setFinishIntent = useCallback((intent: "send" | "cancel") => {
    finishIntentRef.current = intent;
  }, []);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [state]);

  useEffect(() => () => { void recorderRef.current?.cancel(); }, []);

  return { state, elapsedSec, amplitude, start, stop, cancel, setFinishIntent };
}
