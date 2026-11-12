/** view 为宿主侧栏 key（内置或自定义）；session/new 为 kit 保留视图。 */
export type AgentLocation = { view: string; sessionId?: string };

const MAX_KEY = "agent-kit:navigation-max";
const PENDING_DRAFT_KEY = "agent-kit:pending-new-draft";
const CHANGE_EVENT = "agent-kit:navigation-change";

/** 未传入宿主侧栏 key 时认可的默认视图。 */
const DEFAULT_VIEWS = ["library", "timer", "workbench", "contacts"];

/** 读取当前 URL 位置。views 为宿主侧栏 key 白名单（不含 home，它走 new/session）；不传则只认内置视图。 */
export function readAgentLocation(views?: readonly string[]): AgentLocation | null {
  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get("session");
  if (sessionId) return { view: "session", sessionId };
  const view = params.get("view");
  if (!view) return null;
  if (view === "new") return { view, sessionId: params.get("draft") || undefined };
  if ((views ?? DEFAULT_VIEWS).includes(view)) return { view };
  return null;
}

export function writeAgentLocation(location: AgentLocation, mode: "push" | "replace" = "push") {
  const current = window.history.state?.agentNav;
  const index = mode === "push" ? (typeof current?.index === "number" ? current.index + 1 : 1) : (current?.index ?? 0);
  const url = new URL(window.location.href);
  url.searchParams.delete("view");
  url.searchParams.delete("session");
  url.searchParams.delete("draft");
  if (location.view === "session" && location.sessionId) url.searchParams.set("session", location.sessionId);
  else {
    url.searchParams.set("view", location.view);
    if (location.view === "new" && location.sessionId) url.searchParams.set("draft", location.sessionId);
  }
  const state = { ...window.history.state, agentNav: { index } };
  window.history[mode === "push" ? "pushState" : "replaceState"](state, "", url);
  if (mode === "push" || typeof current?.index !== "number") sessionStorage.setItem(MAX_KEY, String(index));
  if (location.view === "new" && location.sessionId) sessionStorage.setItem(PENDING_DRAFT_KEY, location.sessionId);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function agentNavigationAvailability() {
  const index = window.history.state?.agentNav?.index ?? 0;
  const max = Number(sessionStorage.getItem(MAX_KEY) ?? index);
  return { canGoBack: index > 0, canGoForward: index < max };
}

export function consumeAgentDraft() {
  sessionStorage.removeItem(PENDING_DRAFT_KEY);
  const agentNav = window.history.state?.agentNav ?? { index: 0 };
  window.history.replaceState({ ...window.history.state, agentNav: { ...agentNav, draftConsumed: true } }, "");
}

export function pendingAgentDraft() {
  return sessionStorage.getItem(PENDING_DRAFT_KEY);
}

export function isAgentDraftConsumed() {
  return window.history.state?.agentNav?.draftConsumed === true;
}

export const agentNavigationChangeEvent = CHANGE_EVENT;
