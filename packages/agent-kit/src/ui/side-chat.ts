/** Headless side chat client. Uses the same /api/chat SSE transport as AgentWindow. */
export interface SideChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SideChatEvent {
  type: string;
  data: Record<string, unknown>;
  text: string;
}

export interface SideChatResult<T = string> {
  text: string;
  result: T;
  sessionId: string;
  saved: boolean;
  messages: readonly SideChatMessage[];
}

export interface SideChatOptions<T = string> {
  basePath?: string;
  /** false keeps the conversation out of the app's session and message tables. */
  saveSession?: boolean;
  title?: string;
  systemPrompt?: string;
  /** Read the host app's latest state for every turn. */
  context?: () => string;
  model?: string;
  agentMode?: "codebuddy" | "codex";
  parseResult?: (text: string) => T;
  onEvent?: (event: SideChatEvent) => void;
  fetch?: typeof globalThis.fetch;
}

export interface SideChatClient<T = string> {
  readonly sessionId: string;
  readonly messages: readonly SideChatMessage[];
  send(text: string, options?: { signal?: AbortSignal; onEvent?: (event: SideChatEvent) => void }): Promise<SideChatResult<T>>;
}

function extractError(response: Response, fallback: string): Promise<string> {
  return response.text().then((body) => {
    try {
      const json = JSON.parse(body) as { error?: string; message?: string };
      return json.error || json.message || fallback;
    } catch { return body.trim() || fallback; }
  });
}

/** Create an isolated side conversation for an app workflow. */
export function createSideChat<T = string>(options: SideChatOptions<T> = {}): SideChatClient<T> {
  const root = (options.basePath ?? "").replace(/\/+$/, "");
  const saved = options.saveSession === true;
  const sessionId = saved ? crypto.randomUUID() : `side_${crypto.randomUUID().replace(/-/g, "")}`;
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  const messages: SideChatMessage[] = [];
  let registered = false;
  let busy = false;

  async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await request(`${root}${url}`, {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal,
    });
    if (!response.ok) throw new Error(await extractError(response, `请求失败（${response.status}）`));
    return response.json().catch(() => ({}));
  }

  async function send(input: string, turn: { signal?: AbortSignal; onEvent?: (event: SideChatEvent) => void } = {}): Promise<SideChatResult<T>> {
    const text = input.trim();
    if (!text) throw new Error("请输入内容");
    if (busy) throw new Error("上一轮聊天尚未结束");
    busy = true;
    try {
      if (saved && !registered) {
        await postJson("/api/sessions", { sessionId, title: options.title || text.slice(0, 30) || "临时聊天" }, turn.signal);
        registered = true;
      }
      const context = options.context?.().trim();
      const sentContent = context ? `[当前应用状态]\n${context}\n[/当前应用状态]\n\n${text}` : text;
      if (saved) await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { role: "user", content: text }, turn.signal);
      const response = await request(`${root}/api/chat`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, signal: turn.signal,
        body: JSON.stringify({
          messages: [
            ...(options.systemPrompt ? [{ role: "system", content: options.systemPrompt }] : []),
            ...messages,
            { role: "user", content: sentContent },
          ],
          sessionId, resume: messages.length > 0, temporary: !saved,
          model: options.model, agentMode: options.agentMode,
        }),
      });
      if (!response.ok || !response.body) throw new Error(await extractError(response, `聊天请求失败（${response.status}）`));
      let answer = "";
      let buffer = "";
      let completed = false;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const emitFrame = (frame: string) => {
        let type = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) return;
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>; }
        catch { throw new Error("聊天流返回了无效数据"); }
        if (type === "text") answer += String(data.text ?? "");
        const event = { type, data, text: answer };
        options.onEvent?.(event);
        turn.onEvent?.(event);
        if (type === "error") throw new Error(String(data.text ?? data.error ?? "聊天失败"));
        if (type === "done") completed = true;
      };
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          let end = buffer.indexOf("\n\n");
          while (end >= 0) {
            emitFrame(buffer.slice(0, end));
            buffer = buffer.slice(end + 2);
            end = buffer.indexOf("\n\n");
          }
        }
        buffer += decoder.decode().replace(/\r\n/g, "\n");
        if (buffer.trim()) emitFrame(buffer);
      } finally { reader.releaseLock(); }
      if (!completed) throw new Error("聊天连接提前中断");
      messages.push({ role: "user", content: text }, { role: "assistant", content: answer });
      if (saved) await postJson(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, { role: "assistant", content: answer }, turn.signal);
      const result = options.parseResult ? options.parseResult(answer) : answer as T;
      return { text: answer, result, sessionId, saved, messages: [...messages] };
    } finally { busy = false; }
  }

  return { sessionId, get messages() { return [...messages]; }, send };
}
