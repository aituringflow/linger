"use client";

import { translateChat, useChatLocale, useChatTranslation } from "./i18n.tsx";

import type { ReactNode } from "react";
import type { UiTool } from "./types.ts";
import { activityDetail, isCommandTool, memoryToolLabel } from "../shared/toolActivity.ts";

// 工具调用用户友好标签 + 图标：SDK 工具名（WebFetch/Bash/mcp__xxx 等，无 description 字段）→
// 用户能读懂的短词 + 语义 inline SVG（黑白灰系、stroke 风格）。语义匹配按关键词分组，
// 覆盖大小写/下划线/前缀差异；未命中时原样返回工具名。
import { iconGlobe, iconTerminal, iconFilePlus, iconFile, iconSearch, iconPencil, iconNotebook, iconBrowser, iconAsk } from "../icons/ToolIcons.tsx";

export function toolMeta(tool?: UiTool | null, locale: "zh-CN" | "en" = "zh-CN"): { label: string; icon: ReactNode } {
  if (!tool) return { label: "", icon: null };
  const raw = String(tool.name || "");
  const memoryLabel = memoryToolLabel(raw);
  if (memoryLabel) {
    const memoryKeys = { "保存记忆": "toolMemorySave", "查看记忆": "toolMemoryList", "删除记忆": "toolMemoryDelete", "查找记忆文件": "toolMemoryFind" } as const;
    const key = memoryKeys[memoryLabel as keyof typeof memoryKeys];
    return { label: key ? translateChat(locale, key) : memoryLabel, icon: iconNotebook };
  }
  const base = raw.startsWith("mcp__") ? (raw.split("__").pop() || "") : raw;
  const b = base.toLowerCase();
  // 顺序敏感：browser 组必须先于 search（control_browser 含 "browser" 且不含 "search"）
  if (b.includes("browser")) return { label: translateChat(locale, "toolBrowser"), icon: iconBrowser };
  if (b.includes("knowledge") || b.includes("kb")) return { label: translateChat(locale, "toolKnowledge"), icon: iconNotebook };
  if (b.includes("search") || b.includes("fetch") || b.includes("browse")) {
    return { label: translateChat(locale, "toolWeb"), icon: iconGlobe };
  }
  if (isCommandTool(raw)) {
    return { label: translateChat(locale, "toolCommand"), icon: iconTerminal };
  }
  if (b.includes("write") || b.includes("create")) return { label: translateChat(locale, "toolWrite"), icon: iconFilePlus };
  if (b.includes("read") || b === "view") return { label: translateChat(locale, "toolRead"), icon: iconFile };
  if (b.includes("glob") || b.includes("find")) return { label: translateChat(locale, "toolFind"), icon: iconSearch };
  if (b.includes("grep")) return { label: translateChat(locale, "toolSearch"), icon: iconSearch };
  if (b.includes("edit") || b.includes("patch")) return { label: translateChat(locale, "toolEdit"), icon: iconPencil };
  if (b.includes("notebook")) return { label: translateChat(locale, "toolNotebook"), icon: iconNotebook };
  if (b.includes("ask") || b.includes("question")) return { label: translateChat(locale, "toolAsk"), icon: iconAsk };
  return { label: base || raw, icon: null };
}

// 胶囊等紧凑场景仅取中文标签
export function toolLabel(tool?: UiTool | null, locale: "zh-CN" | "en" = "zh-CN"): string {
  return toolMeta(tool, locale).label;
}

/** The same compact tool step and expanded details are used in single and group chat. */
export function ToolStepLabel({ tool }: { tool: UiTool }) {
  const locale = useChatLocale();
  const t = useChatTranslation();
  const detail = activityDetail(tool);
  const activity = t(tool.status === "running" ? "toolRunning" : tool.status === "failed" ? "toolFailed" : "toolCompleted", { label: toolLabel(tool, locale), detail: detail ? ` ${detail}` : "" });
  return <>
    {toolMeta(tool, locale).icon ? <span className="chat-thinking-tool-icon" aria-hidden="true">{toolMeta(tool, locale).icon}</span> : null}
    {tool.edit ? <>
      <span className="chat-thinking-tool-file" title={tool.edit.file}>
        {t(tool.status === "running" ? "toolEditing" : tool.status === "failed" ? "toolEditFailed" : "toolEdited", { file: tool.edit.file })}
      </span>
      {tool.status !== "running" && tool.status !== "failed" ? <EditBadge edit={tool.edit} /> : null}
    </> : <>
      {tool.status === "failed" ? <span className="chat-thinking-tool-status chat-thinking-tool-status--error" aria-hidden="true">✗</span> : null}
      <span className="chat-thinking-tool-name chat-thinking-activity" title={activity}>{activity}</span>
    </>}
  </>;
}

export function ToolStepDetails({ tool }: { tool: UiTool }) {
  const locale = useChatLocale();
  return <div className="chat-thinking-tool">
    {toolMeta(tool, locale).icon ? <span className="chat-thinking-tool-icon" aria-hidden="true">{toolMeta(tool, locale).icon}</span> : null}
    <span className="chat-thinking-tool-name">{toolLabel(tool, locale)}</span>
    {tool.edit ? <><span className="chat-thinking-tool-file" title={tool.edit.file}>{tool.edit.file}</span><EditBadge edit={tool.edit} /></> : null}
    {tool.activity || tool.input ? <span className="chat-thinking-tool-input" title={activityDetail(tool) || tool.input}>{activityDetail(tool) || tool.input}</span> : null}
    {tool.result ? <span className={`chat-thinking-tool-result${tool.status === "failed" ? " is-error" : ""}`} title={tool.result}>{tool.result}</span> : null}
  </div>;
}

/** 文件编辑增删徽标（Claude Code 风格「已编辑文件 xxx +N -M」）：+N 绿 / -M 红 */
export function EditBadge({ edit }: { edit: NonNullable<UiTool["edit"]> }) {
  return (
    <span className="chat-edit-badges">
      {edit.addedLines > 0 ? <span className="chat-edit-add">+{edit.addedLines}</span> : null}
      {edit.removedLines > 0 ? <span className="chat-edit-del">-{edit.removedLines}</span> : null}
    </span>
  );
}

/** control_browser 动作的可读描述（含参数：点击坐标/输入文本/滚动方向/打开地址等） */
export function describeBrowserAction(a: { action: string; params?: Record<string, unknown> }, locale: "zh-CN" | "en" = "zh-CN"): string {
  const p = a.params || {};
  switch (a.action) {
    case "click": return translateChat(locale, "browserClick", { x: String(p.x), y: String(p.y) });
    case "type": return translateChat(locale, "browserType", { text: String(p.text ?? "") });
    case "scroll": return translateChat(locale, p.direction === "up" ? "browserScrollUp" : "browserScrollDown", { amount: p.amount ? ` ${p.amount}px` : "" });
    case "navigate": return translateChat(locale, "browserNavigate", { url: String(p.url ?? "") });
    case "wait": return translateChat(locale, "browserWait", { ms: Number(p.ms) || 1500 });
    case "ask": return translateChat(locale, "browserAsk", { question: String(p.question ?? "") });
    case "done": return translateChat(locale, "browserDone", { summary: String(p.summary ?? "") });
    default: return String(a.action);
  }
}

/** control_browser 状态徽标文案 */
export function browserStatusText(status?: string, locale: "zh-CN" | "en" = "zh-CN"): string {
  switch (status) {
    case "done": return translateChat(locale, "statusDone");
    case "error": return translateChat(locale, "statusError");
    case "stopped": return translateChat(locale, "statusStopped");
    case "ask": return translateChat(locale, "statusAsk");
    case "finished": return translateChat(locale, "statusFinished");
    default: return translateChat(locale, "statusRunning");
  }
}

