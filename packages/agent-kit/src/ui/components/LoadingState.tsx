"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import { useEffect, useState } from "react";

/** One accessible loading state; skeletons give slow responses a stable layout. */
export function LoadingState({ label, variant = "session" }: {
  label: string;
  variant?: "session" | "sidebar" | "artifacts";
}) {
  const t = useChatTranslation();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [label, variant]);
  return (
    <div className={`chat-loading-state chat-loading-state--${variant}`} role="status" aria-live="polite" aria-label={label}>
      <div className="chat-loading-caption">
        <span className="chat-loading-spinner" aria-hidden="true" />
        <span>{slow ? t("loadingSlow") : label}</span>
      </div>
      {variant !== "session" ? (
        <div className="chat-loading-skeleton" aria-hidden="true">
          {Array.from({ length: variant === "sidebar" ? 5 : 3 }, (_, index) => (
            <div className="chat-loading-skeleton-row" key={index}>
              {variant === "artifacts" ? <span className="chat-loading-skeleton-icon" /> : null}
              <span className="chat-loading-skeleton-lines">
                <span className="chat-loading-skeleton-line" />
                {variant === "artifacts" ? <span className="chat-loading-skeleton-line is-short" /> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 延迟出现的页面居中 loading 转圈：进入会话详情后 delay（默认 1s）内不显示任何 loading，
 *  超过 delay 仍未加载完成才显示无文字的居中转圈，避免快速加载时闪烁或文字闪现。
 *  容器复用 .chat-loading-state--session 的居中布局（配合父级 .chat-body.is-loading 的
 *  内层 min-height:100% 达到页面正中）；父级加载完成即卸载，计时器随之清除。 */
export function SlowPageSpinner({ delay = 1000, className = "" }: {
  delay?: number;
  className?: string;
}) {
  const t = useChatTranslation();
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(false);
    const timer = window.setTimeout(() => setShow(true), delay);
    return () => window.clearTimeout(timer);
  }, [delay]);
  if (!show) return null;
  return (
    <div className={`chat-loading-state chat-loading-state--session chat-loading-state--slow ${className}`} role="status" aria-live="polite" aria-label={t("loading")}>
      <span className="chat-loading-spinner" aria-hidden="true" />
    </div>
  );
}
