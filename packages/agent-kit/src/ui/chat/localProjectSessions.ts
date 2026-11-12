import type { SessionItem, UiMessage } from "./types.ts";

type SavedSession = { session: SessionItem; messages: UiMessage[] };

function key(userId: string): string { return `agent-kit:local-project-sessions:${userId}`; }

function read(userId: string): Record<string, SavedSession> {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export function localProjectSessions(userId: string, workspaces: Record<string, string>): SessionItem[] {
  return Object.values(read(userId)).flatMap(({ session }) => {
    const dir = workspaces[session?.id];
    return dir ? [{ ...session, workspaceDir: dir, projectDir: dir }] : [];
  });
}

export function localProjectMessages(userId: string, id: string): UiMessage[] | null {
  const messages = read(userId)[id]?.messages;
  return Array.isArray(messages) ? messages : null;
}

export function saveLocalProjectSession(userId: string, session: SessionItem, messages: UiMessage[]): void {
  try {
    const all = read(userId);
    all[session.id] = { session, messages };
    localStorage.setItem(key(userId), JSON.stringify(all));
  } catch { /* UI keeps the live conversation when local storage is unavailable */ }
}

export function removeLocalProjectSession(userId: string, id: string): void {
  try {
    const all = read(userId);
    delete all[id];
    localStorage.setItem(key(userId), JSON.stringify(all));
  } catch { /* ignore */ }
}
