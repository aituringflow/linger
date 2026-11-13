"use client";

import { useRef } from "react";
import { ASSISTANT_NAME } from "../../shared/assistant-name.ts";
import AgentWindow from "../AgentWindow.tsx";
import { useAgentAuth } from "../useAgentAuth.ts";
import type { ChatUser, Scene, UiMessage } from "../chat/types.ts";
import type { SideChatOptions, SideChatResult } from "../side-chat.ts";

export interface SideChatProps<T = string> extends Omit<SideChatOptions<T>, "onEvent" | "fetch"> {
  heading?: string;
  placeholder?: string;
  emptyMessage?: string;
  onResult?: (result: SideChatResult<T>) => void;
  onError?: (error: Error) => void;
  /** Host-provided identity for a separately authenticated workspace. */
  authUser?: ChatUser;
  /** Host-specific SSE chat endpoint. */
  chatEndpoint?: string;
  /** Suggested questions grouped by the kit's scene tabs. */
  scenes?: Scene[] | null;
}

/** An isolated instance of the same conversation pane used by AgentWindow. */
export function SideChat<T = string>({
  basePath = "", saveSession = false, title, heading = ASSISTANT_NAME, placeholder,
  emptyMessage, systemPrompt, context, model, agentMode, parseResult, onResult, onError, authUser, chatEndpoint, scenes = null,
}: SideChatProps<T>) {
  const { loading, user: sessionUser } = useAgentAuth(basePath);
  const user = authUser ?? sessionUser;
  const sessionId = useRef("");
  if (!sessionId.current) sessionId.current = saveSession ? crypto.randomUUID() : `side_${crypto.randomUUID().replace(/-/g, "")}`;
  const current = useRef({ context, parseResult, onResult, onError });
  current.current = { context, parseResult, onResult, onError };

  function emit(text: string, messages: readonly UiMessage[]) {
    try {
      const result = current.current.parseResult ? current.current.parseResult(text) : text as T;
      current.current.onResult?.({
        text, result, sessionId: sessionId.current, saved: saveSession,
        messages: messages.filter((message): message is UiMessage & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
          .map(({ role, content }) => ({ role, content })),
      });
    } catch (error) {
      current.current.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (loading && !authUser) return <div className="side-chat-loading">正在加载聊天…</div>;
  if (!user) return <div className="side-chat-loading" role="alert">请先登录后使用聊天。</div>;
  return <AgentWindow
    basePath={basePath} chatEndpoint={chatEndpoint} initialUser={user} title={heading} scenes={scenes}
    composerPlaceholder={placeholder}
    embedded={{ sessionId: sessionId.current, temporary: !saveSession, title, model, agentMode,
      systemPrompt, context: () => current.current.context?.() ?? "",
      emptyMessage, onResult: emit, onError: (error) => current.current.onError?.(error) }}
  />;
}
