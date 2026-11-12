"use client";
/** Shared text / hold-to-talk mode switch for the two mobile composers. */
const STORAGE_KEY = "agent-kit:mobile-voice-mode";

export function readMobileVoiceMode(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(STORAGE_KEY) === "1"; }
  catch { return false; }
}

export function saveMobileVoiceMode(active: boolean): void {
  try { window.localStorage.setItem(STORAGE_KEY, active ? "1" : "0"); }
  catch { /* storage unavailable */ }
}

export function toggleMobileVoiceMode(
  active: boolean,
  setActive: (active: boolean) => void,
  dictation: { state: string; cancel: () => void },
  onExit: () => void,
  focusInput: () => void,
) {
  if (active) {
    onExit();
    dictation.cancel();
    setActive(false);
    requestAnimationFrame(focusInput);
  } else if (dictation.state === "idle") {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setActive(true);
  }
}
