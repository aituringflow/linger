"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import { Fragment, useCallback, useRef } from "react";
import HumanMessage from "../chat/HumanMessage.tsx";
import UserBubble from "../chat/UserBubble.tsx";
import AiResponse from "../chat/AiResponse.tsx";
import TimeMarker, { shouldShowTimeMarker } from "../chat/TimeMarker.tsx";
import { useBottomJump } from "../chat/useBottomJump.ts";
import { ChatPanelGlyph21 } from "../icons/PageIcons.tsx";

export interface ChatTranscriptMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** ISO timestamp or Unix milliseconds, used by the shared chat time markers. */
  createdAt?: string | number;
}

export interface ChatTranscriptProps {
  messages: readonly ChatTranscriptMessage[];
  busy?: boolean;
  /** Changes when the host switches conversations, so the list opens at its latest message. */
  sessionKey?: string;
  basePath?: string;
  className?: string;
}

/** Kit message list for hosts that own their session and composer. */
export function ChatTranscript({ messages, busy = false, sessionKey = "", basePath = "/", className = "" }: ChatTranscriptProps) {
  const t = useChatTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const getScroller = useCallback(() => scrollRef.current, []);
  const getContent = useCallback(() => contentRef.current, []);
  const last = messages.at(-1);
  const version = `${messages.length}:${last?.id ?? ""}:${last?.content ?? ""}:${busy}`;
  const { showJump, jumpToBottom } = useBottomJump({ enabled: true, entryKey: sessionKey, version, getScroller, getContent });
  const timestamp = (message?: ChatTranscriptMessage) => message?.createdAt == null
    ? undefined
    : typeof message.createdAt === "number" ? new Date(message.createdAt).toISOString() : message.createdAt;

  return (
    <div className={`chat-transcript ${className}`}>
      <div className="chat-body" ref={scrollRef} role="log" aria-live="polite" tabIndex={0}>
        <div className="chat-body-inner" ref={contentRef}>
          {messages.map((message, index) => {
            const at = timestamp(message);
            const previousAt = timestamp(messages[index - 1]);
            const running = busy && index === messages.length - 1 && message.role === "assistant";
            return <Fragment key={message.id}>
              {at && shouldShowTimeMarker(at, previousAt) ? <TimeMarker at={at} /> : null}
              {message.role === "user" ? (
                <div className="chat-message-row">
                  <HumanMessage own messageIndex={index} bubble={<div className="bubble"><UserBubble text={message.content} basePath={basePath} /></div>} />
                </div>
              ) : (
                <div className="msg bot" data-msg-index={index}>
                  <AiResponse scene="direct" running={running} basePath={basePath} content={message.content} />
                </div>
              )}
            </Fragment>;
          })}
          {busy && last?.role !== "assistant" ? (
            <div className="msg bot" role="status">
              <AiResponse scene="direct" running basePath={basePath} content="" startedAt={timestamp(last)} />
            </div>
          ) : null}
        </div>
      </div>
      {showJump ? <div className="chat-body-overlay">
        <div className="chat-body-fade" aria-hidden="true" />
        <button type="button" className={`chat-bottom-btn${busy ? " is-live" : ""}`} onClick={jumpToBottom} aria-label={t("backToBottom")}><ChatPanelGlyph21 /></button>
      </div> : null}
    </div>
  );
}
