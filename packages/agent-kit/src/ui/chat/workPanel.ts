/** A session-scoped job shown in the right-hand work panel. */
export type WorkPanelSurface = {
  kind: "website" | "app";
  /** Stable application identity within a session; opening it again focuses the existing tab. */
  id: string;
  /** Stable identity of this workflow instance; distinct instances may reuse one app tab. */
  workflowId?: string;
  title: string;
  /** Show a URL-backed surface as an application without browser controls. */
  presentation?: "browser" | "app";
  /** Host-provided application icon URL, also used in the session list. */
  iconUrl?: string;
  /** Host-provided collection icon URL when a session has opened multiple apps. */
  collectionIconUrl?: string;
  /** HTTP(S) URL. Omit when id matches a sidebar entry's render. */
  url?: string;
  sessionId?: string;
  /** Reuse a tab at the same origin and path, even if an older host gave it a different id. */
  reusePath?: boolean;
  /** Previous paths for the same host app, used when upgrading an existing tab. */
  reusePaths?: string[];
  /** Reload the existing frame when opening this surface again. */
  reload?: boolean;
};

export type SessionWorkflow = { workflowId: string; appId: string; iconUrl: string; collectionIconUrl: string };

/** Persist a workflow as a session attribute, independently of right-panel tab state. */
export async function recordSessionWorkflow(basePath: string, sessionId: string, workflow: SessionWorkflow): Promise<SessionWorkflow[]> {
  const response = await fetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/workflows`, {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(workflow),
  });
  if (!response.ok) throw new Error(`保存作业流失败（HTTP ${response.status}）`);
  const data = await response.json() as { workflows?: SessionWorkflow[] };
  const workflows = Array.isArray(data.workflows) ? data.workflows : [];
  window.dispatchEvent(new CustomEvent("agent-kit:session-workflows-updated", { detail: { sessionId, workflows } }));
  return workflows;
}

/** Hosts and workbench apps can request a panel job without coupling to AgentWindow state. */
export function openWorkPanelSurface(surface: WorkPanelSurface): void {
  window.dispatchEvent(new CustomEvent("agent-kit:open-work-panel", { detail: surface }));
}
