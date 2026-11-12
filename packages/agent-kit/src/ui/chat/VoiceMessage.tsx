"use client";

import { useChatTranslation } from "./i18n.tsx";

import { useRef, useState } from "react";
import type { UiVoiceRecording } from "./types.ts";

/** 用户语音条：播放状态由 audio 事件驱动，结束和暂停时自动停止波纹。 */
export default function VoiceMessage({ recording, basePath }: { recording: UiVoiceRecording; basePath: string }) {
  const t = useChatTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const seconds = Math.max(1, Math.round(recording.durationMs / 1000));
  const width = Math.max(110, Math.min(260, 80 + seconds * 7));
  const url = `${basePath}/api/file?fileId=${encodeURIComponent(recording.fileId)}`;

  const toggle = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    setFailed(false);
    if (!audio.paused) { audio.pause(); return; }
    try {
      if (audio.ended) audio.currentTime = 0;
      await audio.play();
    } catch {
      setFailed(true);
      setPlaying(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={`msg-voice-play${playing ? " is-playing" : ""}`}
        style={{ width }}
        onClick={toggle}
        aria-label={t(playing ? "pauseVoice" : "playVoice", { seconds })}
        aria-pressed={playing}
      >
        <span className="msg-voice-duration">{seconds}″</span>
        <svg className="msg-voice-wave" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="4" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <path d="M8 8a6 6 0 0 1 0 8M12 4a11 11 0 0 1 0 16" />
        </svg>
      </button>
      {failed ? <span className="msg-voice-error" role="alert">{t("voiceFailed")}</span> : null}
      <audio
        ref={audioRef}
        src={url}
        preload="none"
        onPlay={() => {
          document.querySelectorAll<HTMLAudioElement>("audio[data-voice-message]").forEach((other) => {
            if (other !== audioRef.current) other.pause();
          });
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => { setPlaying(false); setFailed(true); }}
        data-voice-message
      />
    </>
  );
}
