import type { UiStep } from "./types.ts";
import { summarizeThinking } from "./messageUtils.ts";
import { visibleThinkingText } from "../shared/thinkingText.ts";

/** Shared presentation rules; each chat transport still owns its run and message state. */
export function hasVisibleProcessStep(step: UiStep, mode?: string): boolean {
  return Boolean(visibleThinkingText(step.thinking, mode) || step.text?.trim() || step.tool || step.browser || step.ask?.length);
}

export function processStepSummary(step: UiStep): { text: string; isOutput: boolean } {
  const output = (step.text || "").trim();
  const summary = step.browser?.finalSummary || output || summarizeThinking(step.thinking);
  if (step.tool && !step.browser && !output) return { text: "", isOutput: false };
  return { text: summary, isOutput: Boolean(output && summary === output) };
}

export function lastProcessFallback(steps: readonly UiStep[]): string {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (step.thinking) return summarizeThinking(step.thinking);
    if (step.text) return step.text;
  }
  return "";
}
