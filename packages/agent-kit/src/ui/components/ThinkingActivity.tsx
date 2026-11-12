import { useChatTranslation } from "../chat/i18n.tsx";
import { useEffect, useRef } from "react";
import { ChevronRightIcon } from "../icons/SharedIcons.tsx";
import { visibleThinkingText } from "../shared/thinkingText.ts";
import { StreamingText } from "./TextReveal.tsx";

/** Framework independent presentation for an assistant's thinking state. */
export default function ThinkingActivity({ active, text, elapsedSecs, mode, showStatus = true }: {
  active: boolean;
  text?: string;
  elapsedSecs?: number;
  mode?: string;
  /** 宿主已在答复首行显示总计时状态时，只保留思考正文。 */
  showStatus?: boolean;
}) {
  const t = useChatTranslation();
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [active, text]);

  const visibleText = visibleThinkingText(text, mode);
  const hasText = Boolean(visibleText);
  if ((!active || !showStatus) && !hasText) return null;
  return <div className={`chat-thinking${active ? "" : " chat-thinking--done"}`}>
    {active && showStatus ? <div className="chat-thinking-head" role="status">
      <span className="chat-thinking-spinner" aria-hidden="true" />
      <span className="chat-thinking-label">{t("thinking")}</span>
      {elapsedSecs ? <span className="chat-thinking-timer">{t("thinkingElapsed", { seconds: elapsedSecs })}</span> : null}
    </div> : !active ? <details className="chat-thinking-completed">
      <summary className="chat-thinking-done-toggle">
        <span className="chat-thinking-done-label">{t("thought")}</span>
        <span className="chat-thinking-icon" aria-hidden="true"><ChevronRightIcon /></span>
      </summary>
      {hasText ? <div className="chat-thinking-body">{visibleText}</div> : null}
    </details> : null}
    {active && hasText ? <div className="chat-thinking-live" ref={boxRef}><StreamingText text={visibleText} active /></div> : null}
  </div>;
}
