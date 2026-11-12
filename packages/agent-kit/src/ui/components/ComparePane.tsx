"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon } from "../icons/SharedIcons.tsx";
import Markdown from "./Markdown.tsx";
import FeedbackButtons from "./FeedbackButtons.tsx";
import ModelSelect, { modelOptionKey, type ModelMeta } from "./ModelSelect.tsx";
import { apiFetch } from "../shared/apiFetch.ts";
import ThinkingActivity from "./ThinkingActivity.tsx";
import { activityDetail, memoryToolLabel, toolActivityText } from "../shared/toolActivity.ts";

export type CompareSubmission = { id: number; sessionId: string; text: string; attachments?: { url: string; name: string }[] };
type Mode = "codebuddy" | "codex";
type Choice = { id: string; name?: string; meta?: ModelMeta };
type CompareTool = { id: string; name: string; input?: string; status: "running" | "completed" | "failed" };
type Entry = { role: "user" | "assistant"; content: string; revealAt?: number; attachment?: { url: string; name: string } | null; attachments?: { url: string; name: string }[]; model?: string; mode?: Mode; thinking?: string; tools?: (CompareTool | string)[]; error?: string; completed?: boolean; createdAt?: string; elapsedSecs?: number };

function duration(secs?: number): string {
  const value = Math.max(0, Math.floor(secs || 0));
  if (value < 60) return `${value} 秒`;
  const mins = Math.floor(value / 60);
  return value % 60 ? `${mins} 分 ${value % 60} 秒` : `${mins} 分`;
}

function toolTitle(name: string): string {
  const memoryLabel = memoryToolLabel(name);
  if (memoryLabel) return memoryLabel;
  if (name === "Command") return "运行命令";
  if (name === "FileChange") return "编辑文件";
  if (name === "WebSearch") return "搜索网页";
  if (name.includes("/")) return `MCP · ${name}`;
  return name;
}

function messageTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return date.toDateString() === new Date().toDateString() ? time : `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${time}`;
}

export default function ComparePane({ basePath, chatEndpoint, sessionId, submission, codebuddyModels, codexModels, agentModes, mode, modelKey, onModeChange, onModelChange, showHeader, onClose, showModel, workspaceDir, cancelSeq, onBusyChange }: {
  basePath: string;
  chatEndpoint?: string;
  sessionId: string;
  submission: CompareSubmission | null;
  codebuddyModels: Choice[];
  codexModels: Choice[];
  agentModes: Mode[];
  mode: Mode;
  modelKey: string;
  onModeChange: (mode: Mode) => void;
  onModelChange: (key: string) => void;
  showHeader: boolean;
  onClose: () => void;
  showModel: boolean;
  workspaceDir?: string | null;
  cancelSeq: number;
  onBusyChange: (busy: boolean) => void;
}) {
  const [messages, setMessages] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const [expandedProcesses, setExpandedProcesses] = useState<Set<number>>(() => new Set());
  const [now, setNow] = useState(Date.now());
  const messagesRef = useRef<Entry[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const lastSubmissionRef = useRef<number | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const storageKey = (selectedMode: Mode) => `agent-kit:compare:${sessionId}:${selectedMode}`;
  const choices = mode === "codex" ? codexModels : codebuddyModels;

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey(mode)) || "[]") as Entry[];
      messagesRef.current = Array.isArray(stored) ? stored.map((entry) => entry.role === "assistant" ? { ...entry, completed: true } : entry) : [];
      setMessages([...messagesRef.current]);
    } catch { messagesRef.current = []; setMessages([]); }
    setExpandedProcesses(new Set());
  }, [sessionId, mode]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => { if (cancelSeq > 0) abortRef.current?.abort(); }, [cancelSeq]);

  const publish = (next: Entry[], selectedMode: Mode) => {
    messagesRef.current = next;
    if (modeRef.current === selectedMode) setMessages([...next]);
    try { localStorage.setItem(storageKey(selectedMode), JSON.stringify(next.map(({ revealAt: _visualTime, ...entry }) => entry))); } catch { /* private mode */ }
  };

  async function execute(item: CompareSubmission, selectedMode: Mode, selectedModel: string) {
    setNow(Date.now());
    setBusy(true);
    onBusyChange(true);
    setQueued((count) => Math.max(0, count - 1));
    const history = messagesRef.current;
    const user: Entry = { role: "user", content: item.text, attachment: item.attachments?.[0], attachments: item.attachments, createdAt: new Date().toISOString() };
    const modelOption = (selectedMode === "codex" ? codexModels : codebuddyModels)
      .find((choice) => modelOptionKey(choice) === selectedModel);
    const assistant: Entry = {
      role: "assistant", content: "", mode: selectedMode, completed: false, createdAt: new Date().toISOString(),
      model: modelOption?.name || modelOption?.id || (selectedMode === "codex" ? "Codex 默认模型" : "默认模型"),
    };
    publish([...history, user, assistant], selectedMode);
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const response = await apiFetch(chatEndpoint || `${basePath}/api/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: abort.signal,
        body: JSON.stringify({
          messages: [...history, user].map((message) => ({ role: message.role, content: message.content })),
          attachments: item.attachments,
          sessionId: `${sessionId}_compare_${selectedMode}`,
          resume: history.some((message) => message.role === "assistant"),
          agentMode: selectedMode,
          comparisonRun: true,
          workspaceDir: workspaceDir || undefined,
          model: selectedMode === "codebuddy" ? modelOption?.id : undefined,
          codexModelKey: selectedMode === "codex" ? selectedModel : undefined,
        }),
      });
      if (!response.ok || !response.body) throw new Error(`请求失败（HTTP ${response.status}）`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = raw.match(/^event:\s*(.+)$/m)?.[1];
          const dataLine = raw.match(/^data:\s*(.+)$/m)?.[1];
          if (!dataLine) continue;
          let data: Record<string, unknown>;
          try { data = JSON.parse(dataLine) as Record<string, unknown>; } catch { continue; }
          if (event === "text" || event === "thinking" || event === "tool" || event === "tool_result" || event === "error" || event === "model_info") {
            const next = [...messagesRef.current];
            const current = { ...next[next.length - 1] };
            if (event === "text") { current.content += String(data.text || ""); current.revealAt = Date.now(); }
            if (event === "thinking") current.thinking = (current.thinking || "") + String(data.text || "");
            if (event === "tool") current.tools = [...(current.tools || []), {
              id: String(data.toolUseId || data.index || `${Date.now()}-${current.tools?.length || 0}`),
              name: String(data.name || "工具"), input: String(data.input || ""), status: "running",
            }];
            if (event === "tool_result") current.tools = (current.tools || []).map((tool) =>
              typeof tool !== "string" && tool.id === String(data.toolUseId || data.index)
                ? { ...tool, status: data.status === "failed" ? "failed" : "completed" } : tool);
            if (event === "error") current.error = String(data.text || "运行失败");
            if (event === "model_info" && Array.isArray(data.models) && data.models.length) current.model = String(data.models[0]);
            next[next.length - 1] = current;
            publish(next, selectedMode);
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        const next = [...messagesRef.current];
        next[next.length - 1] = { ...next[next.length - 1], error: error instanceof Error ? error.message : String(error) };
        publish(next, selectedMode);
      }
    } finally {
      const next = [...messagesRef.current];
      if (next[next.length - 1]?.role === "assistant") {
        const current = next[next.length - 1];
        next[next.length - 1] = { ...current, completed: true, elapsedSecs: current.createdAt
          ? Math.max(1, Math.round((Date.now() - new Date(current.createdAt).getTime()) / 1000)) : undefined };
        publish(next, selectedMode);
      }
      abortRef.current = null;
      setBusy(false);
      onBusyChange(false);
    }
  }

  useEffect(() => {
    if (!submission || lastSubmissionRef.current === submission.id) return;
    lastSubmissionRef.current = submission.id;
    const selectedMode = mode;
    const selectedModel = modelKey;
    setQueued((count) => count + 1);
    chainRef.current = chainRef.current.then(() => execute(submission, selectedMode, selectedModel));
  }, [submission]);

  return <section className="chat-compare-pane" aria-label="对比答复">
    {showHeader ? <div className="chat-split-pane-head">
      {agentModes.length > 1 ? <ModelSelect showIcon={false} options={agentModes.map((value) => ({ id: value, name: value === "codex" ? "Codex" : "CodeBuddy" }))}
        value={mode} title="选择右侧框架" disabled={busy || queued > 0} compact openOnHover onChange={(value) => onModeChange(value as Mode)} /> : null}
      {showModel && choices.length ? <ModelSelect options={choices} value={modelKey} onChange={(key) => {
        onModelChange(key);
      }} /> : null}
      {busy ? <span className="chat-compare-running">运行中…</span> : null}
      <button type="button" className="chat-split-close" aria-label="关闭右侧视图" title="关闭右侧视图" onClick={onClose}>×</button>
    </div> : null}
    <div className="chat-compare-scroll"><div className="chat-compare-list">
      {messages.map((message, index) => {
        const streaming = busy && index === messages.length - 1 && message.completed === false;
        const completed = message.role === "assistant" && message.completed !== false;
        const showProcess = !completed || expandedProcesses.has(index);
        return <div className={`msg ${message.role === "assistant" ? "bot" : "user"}`} key={index}>
        {completed ? <button type="button" className={`msg-process-card${showProcess ? " is-open" : ""}`}
          aria-expanded={showProcess} onClick={() => setExpandedProcesses((previous) => {
            const next = new Set(previous);
            if (next.has(index)) next.delete(index); else next.add(index);
            return next;
          })}>
          <span className="msg-process-label">已完成{message.elapsedSecs ? ` ${duration(message.elapsedSecs)}` : ""}</span>
          <span className="msg-process-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        </button> : null}
        {message.role === "assistant" && showProcess ? <ThinkingActivity
          active={streaming && !message.error}
          text={message.thinking}
          mode={message.mode}
          elapsedSecs={message.completed ? message.elapsedSecs : message.createdAt
            ? Math.max(0, Math.floor((now - new Date(message.createdAt).getTime()) / 1000)) : undefined}
        /> : null}
        {showProcess && message.tools?.length ? <div className="chat-compare-tools">{message.tools.map((item, toolIndex) => {
          const tool = typeof item === "string" ? { id: String(toolIndex), name: item, status: "completed" as const } : item;
          return <div className="chat-thinking-tool" key={`${tool.id}-${toolIndex}`}>
            <span className="chat-thinking-tool-name">{toolActivityText(tool, toolTitle(tool.name))}</span>
            {"input" in tool && tool.input ? <span className="chat-thinking-tool-input" title={tool.input}>{activityDetail(tool) || tool.input}</span> : null}
            {tool.status === "failed" ? <span className="chat-thinking-tool-status chat-thinking-tool-status--error" aria-label="失败">✗</span> : null}
          </div>;
        })}</div> : null}
        {message.role === "user" || message.content ? <div className="bubble">{(message.attachments ?? (message.attachment ? [message.attachment] : [])).map((file, i) => <a key={`${file.url}-${i}`} className="msg-attachment" href={`${basePath}${file.url}`} target="_blank" rel="noreferrer">{file.name}</a>)}{message.role === "assistant" ? <Markdown content={message.content} urlBasePath={basePath} streaming={busy && index === messages.length - 1} revealAt={message.revealAt} /> : message.content}</div> : null}
        {message.role === "user" ? <div className="msg-hover-actions">
          <span className="msg-time">{messageTime(message.createdAt)}</span>
          <button type="button" title={copiedIndex === index ? "已复制" : "复制"} aria-label={copiedIndex === index ? "已复制" : "复制"}
            className={copiedIndex === index ? "is-copied" : undefined}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(message.content);
                setCopiedIndex(index);
                window.setTimeout(() => setCopiedIndex((current) => current === index ? null : current), 1800);
              } catch { /* clipboard access can be unavailable */ }
            }}>
            {copiedIndex === index ? <CheckIcon />
              : <CopyIcon />}
          </button>
        </div> : null}
        {message.error ? <div className="chat-error" role="alert">{message.error}</div> : null}
        {message.role === "assistant" && message.completed !== false ? <div className="msg-footer">
          <FeedbackButtons basePath={basePath} sessionId={sessionId} answer={message.content} />
          <span className="msg-footer-model">{message.mode === "codex" ? "Codex" : "CodeBuddy"}</span>
          {showModel ? <span className="msg-footer-model">{message.model}</span> : null}
          <span className="msg-footer-time">{messageTime(message.createdAt)}</span>
        </div> : null}
      </div>;
      })}
    </div></div>
  </section>;
}
