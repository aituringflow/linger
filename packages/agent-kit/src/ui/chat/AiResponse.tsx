"use client";

import { useChatLocale, useChatTranslation } from "./i18n.tsx";

import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import Markdown from "../components/Markdown.tsx";
import FeedbackButtons from "../components/FeedbackButtons.tsx";
import ThinkingActivity from "../components/ThinkingActivity.tsx";
import { ChevronRightIcon } from "../icons/SharedIcons.tsx";
import { ThinkingChevronIcon } from "../icons/DynamicIcons.tsx";
import { ToolStepDetails, ToolStepLabel, browserStatusText, describeBrowserAction, toolMeta } from "./ToolUi.tsx";
import { formatDuration } from "./messageUtils.ts";
import { hasVisibleProcessStep, processStepSummary } from "./processSteps.ts";
import { visibleThinkingText } from "../shared/thinkingText.ts";
import { imeCompositionEnd, imeCompositionStart, isImeConfirmKey } from "../shared/ime.ts";
import type { UiStep } from "./types.ts";

type Props = {
  scene: "direct" | "group";
  steps?: UiStep[] | null;
  elapsedSecs?: number | null;
  startedAt?: string;
  running: boolean;
  mode?: string;
  basePath: string;
  content: string;
  /** @提及高亮名单：正文中的 @名字 渲染为品牌色（与群聊用户消息一致） */
  mentions?: string[];
  answer?: ReactNode;
  afterAnswer?: ReactNode;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  isStepOpen?: (index: number) => boolean;
  onToggleStep?: (index: number) => void;
  browserAskText?: string;
  onBrowserAskText?: (value: string) => void;
  onBrowserAnswer?: (browserId: string, answer: string) => void;
  footer?: {
    feedback: ComponentProps<typeof FeedbackButtons>;
    extra?: ReactNode;
  };
};

/** Shared assistant reply presentation; transports and run state stay in their chat owners. */
export default function AiResponse({ scene, steps, elapsedSecs, startedAt, running, mode, basePath, content, mentions,
  answer, afterAnswer, expanded, onToggleExpanded, isStepOpen, onToggleStep, browserAskText = "", onBrowserAskText, onBrowserAnswer, footer }: Props) {
  const t = useChatTranslation();
  const locale = useChatLocale();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !startedAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  const shownElapsed = running && Number.isFinite(startMs)
    ? Math.max(1, Math.round((now - startMs) / 1000)) : elapsedSecs;
  const [localExpanded, setLocalExpanded] = useState(false);
  const [localOpenSteps, setLocalOpenSteps] = useState<Set<number>>(() => new Set());
  const processExpanded = expanded ?? localExpanded;
  const toggleProcess = onToggleExpanded ?? (() => setLocalExpanded(value => !value));
  const visibleSteps = (steps ?? []).map((step, index) => ({ step, index })).filter(({ step, index }) =>
    hasVisibleProcessStep(step, mode) || (running && index === (steps?.length ?? 0) - 1 && !step.tool));
  const showProcess = running || visibleSteps.length > 0;
  const showSteps = running || processExpanded || visibleSteps.some(({ step }) => step.ask?.length);
  const submitBrowserAnswer = (step: UiStep) => {
    const answerText = browserAskText.trim();
    if (!answerText || !step.browser) return;
    onBrowserAnswer?.(step.browser.id, answerText);
    onBrowserAskText?.("");
  };
  return <>
    {showProcess ? running ? <div className="msg-process-card is-running" aria-live="off"><span className="msg-process-label">{t("thinkingTime", { duration: formatDuration(shownElapsed, locale) || (locale === "zh-CN" ? "0 秒" : new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "short" }).format(0)) })}</span></div>
      : <button type="button" className={`msg-process-card${processExpanded ? " is-open" : ""}`} onClick={toggleProcess} aria-expanded={processExpanded} title={t("durationTitle")}>
        <span className="msg-process-label">{elapsedSecs ? t("completedTime", { duration: formatDuration(elapsedSecs, locale) }) : t("completed")}</span>
        <span className="msg-process-chevron" aria-hidden="true"><ChevronRightIcon /></span>
      </button> : null}
    {showProcess && showSteps ? visibleSteps.map(({ step, index }, visibleIndex) => {
      const active = running && visibleIndex === visibleSteps.length - 1 && !step.tool;
      const opened = isStepOpen ? isStepOpen(index) : localOpenSteps.has(index);
      const toggleStep = () => onToggleStep ? onToggleStep(index) : setLocalOpenSteps(current => {
        const next = new Set(current);
        if (next.has(index)) next.delete(index); else next.add(index);
        return next;
      });
      const summary = processStepSummary(step);
      const thinking = visibleThinkingText(step.thinking, mode);
      return <div className="chat-thinking chat-thinking--done" key={index}>
        {active ? <>
          <ThinkingActivity active text={step.thinking} mode={mode} showStatus={false} />
          {step.browser ? <div className="chat-browser chat-browser--live">
            <div className="chat-browser-head"><span className={`chat-browser-status chat-browser-status--${step.browser.status || "running"}`}>{browserStatusText(step.browser.status, locale)}</span></div>
            {step.browser.actions.length ? <div className="chat-browser-live">{step.browser.actions.slice(-4).map((action, actionIndex) => <div className="chat-browser-live-item" key={actionIndex}><span className="chat-browser-live-step">#{action.step}</span><span className="chat-browser-live-action">{describeBrowserAction(action, locale)}</span></div>)}</div>
              : <div className="chat-browser-live-empty">{t("waitingBrowser")}</div>}
          </div> : null}
        </> : <>
          <button type="button" className={`chat-thinking-done-toggle${running && step.tool?.status === "running" ? " is-running" : ""}${step.tool?.status === "failed" ? " is-error" : ""}`} onClick={toggleStep} aria-expanded={opened}>
            <span className="chat-thinking-done-label">
              {step.ask?.length ? t("askUser") : step.browser ? <>{toolMeta(step.tool).icon ? <span className="chat-thinking-tool-icon" aria-hidden="true">{toolMeta(step.tool).icon}</span> : null}<span className="chat-thinking-browser-label">{step.browser.actions.length ? t("browserSteps", { count: step.browser.actions.length }) : t("browser")}</span></> : step.tool ? <ToolStepLabel tool={step.tool} /> : t("thought")}
            </span>
            <span className="chat-thinking-icon" aria-hidden="true"><ThinkingChevronIcon open={opened} /></span>
          </button>
          {!opened && summary.text ? <div className="chat-thinking-summary">{summary.isOutput ? <Markdown content={summary.text} urlBasePath={basePath} /> : summary.text}</div> : null}
          {opened ? <div className="chat-thinking-body">
            {step.secs ? <div className="chat-thinking-secs">{t("elapsed", { duration: formatDuration(step.secs, locale) })}</div> : null}
            {step.tool ? <ToolStepDetails tool={step.tool} /> : null}
            {step.browser ? <div className="chat-browser">
              <div className="chat-browser-head"><span className={`chat-browser-status chat-browser-status--${step.browser.status || "running"}`}>{browserStatusText(step.browser.status, locale)}</span></div>
              {step.browser.thinking ? <div className="chat-browser-think">{step.browser.thinking}</div> : null}
              {step.browser.actions.length ? <div className="chat-browser-actions">{step.browser.actions.map((action, actionIndex) => <span className="chat-browser-action" key={actionIndex}>#{action.step} {describeBrowserAction(action, locale)}</span>)}</div> : null}
              {step.browser.finalSummary ? <div className="chat-browser-summary">{step.browser.finalSummary}</div> : null}
              {step.browser.ask ? <div className="chat-browser-ask"><div className="chat-browser-ask-q">{step.browser.ask.question}</div><div className="chat-browser-ask-row">
                <input className="chat-browser-ask-input" value={browserAskText} onChange={event => onBrowserAskText?.(event.target.value)} onCompositionStart={imeCompositionStart} onCompositionEnd={imeCompositionEnd} placeholder={t("browserAnswer")} onKeyDown={event => { if (isImeConfirmKey(event)) return; if (event.key === "Enter") { event.preventDefault(); submitBrowserAnswer(step); } }} />
                <button type="button" className="chat-browser-ask-btn" disabled={!browserAskText.trim()} onClick={() => submitBrowserAnswer(step)}>{t("submit")}</button>
              </div></div> : null}
            </div> : null}
            {step.text ? <div className="chat-thinking-step-text"><Markdown content={step.text} urlBasePath={basePath} /></div> : null}
            {thinking}
          </div> : null}
        </>}
      </div>;
    }) : null}
    {answer !== undefined ? answer : content || scene === "direct" ? <div className="bubble"><Markdown content={content} urlBasePath={basePath} streaming={running} mentions={scene === "group" ? mentions : undefined} /></div> : null}
    {afterAnswer}
    {!running && footer ? <div className="msg-footer"><FeedbackButtons {...footer.feedback} />{footer.extra}</div> : null}
  </>;
}
