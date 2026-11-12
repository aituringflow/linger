/** Keep a choice for the current conversation and use it for new conversations. */
export function saveAgentMode(sessionId: string, mode: string): void {
  try {
    localStorage.setItem(`agent-kit:mode:${sessionId}`, mode);
    localStorage.setItem("agent-kit:mode", mode);
  } catch { /* storage may be unavailable */ }
}

export function readAgentMode(sessionId: string, available: readonly string[]): string | undefined {
  try {
    const sessionMode = localStorage.getItem(`agent-kit:mode:${sessionId}`);
    if (sessionMode && available.includes(sessionMode)) return sessionMode;
    const defaultMode = localStorage.getItem("agent-kit:mode");
    if (defaultMode && available.includes(defaultMode)) return defaultMode;
  } catch { /* use the first available framework */ }
  return undefined;
}
