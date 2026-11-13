"use client";

import { ASSISTANT_NAME } from "../shared/assistant-name.ts";

import { ChatLocaleProvider, useChatTranslation } from "./chat/i18n.tsx";

// agent-kit · AgentWindow（对话状态与内容页装配）
// 自 hotline 项目拷贝改造：所有端点/场景/行为参数化为 props，
// 宿主只需 <AgentChat basePath="/your-app" scenes={...} /> 即可使用。
// 图片附件发送时自动转 base64 随消息传给 /api/chat（模型多模态识别）。

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, type CSSProperties, type ChangeEvent, type DragEvent as ReactDragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useClickOutside } from "./useClickOutside.ts";
import Markdown from "./components/Markdown.tsx";
import ConversationPanel from "./panel/ConversationPanel.tsx";
import SessionSearchPanel, { type SessionSearchPersonRow } from "./components/SessionSearchPanel.tsx";
import UserMenu from "./components/UserMenu.tsx";
import { ContentPage } from "./components/ContentPanel.tsx";
import ChatPanel from "./panel/ChatPanel.tsx";
import { NavigationSidebar, hasSidebar, resolveSidebar } from "./components/NavigationSidebar.tsx";
import { FullscreenContext } from "./components/FullscreenContext.tsx";

import ContactsView from "./components/ContactsView.tsx";
import LibraryView, { type LibraryFile } from "./components/LibraryView.tsx";
import { localFilesApi, isLocalReference, type LocalReference } from "./shared/localFiles.ts";
import MemoryView from "./components/MemoryView.tsx";
import OperationPanel, {  CHAT_LINK_OPEN_EVENT, fileArtifactType } from "./panel/OperationPanel.tsx";
import type { CoworkMonologue } from "./components/CoworkPanel.tsx";
import { relativeTime } from "./shared/relativeTime.ts";
import { apiFetch } from "./shared/apiFetch.ts";
import { CHAT_MIN_WIDTH } from "./shared/layout.ts";
import { resolveAttachmentUrl } from "./shared/attachmentUrl.ts";
import { getConnectionState, isServerOnline, subscribeConnection } from "./shared/connectionStatus.ts";
import { Avatar } from "./shared/AvatarView.tsx";
import { realtimeClient } from "./shared/realtime.ts";
import { buildCapabilitiesContext, dispatchCapabilityReply, toCapMessages } from "./capabilities/index.tsx";
import { ensureWebPushSubscription, installPushProbe, removeWebPushSubscription } from "./shared/webPush.ts";
import { playNotificationSound, syncNotificationSoundForPush } from "./shared/notificationSound.ts";
import ChatComposer, { type ChatComposerHandle } from "./components/ChatComposer.tsx";
import ContactPickerDialog from "./components/ContactPickerDialog.tsx";
import ShareToChatDialog from "./components/ShareToChatDialog.tsx";

import CoworkPanel from "./components/CoworkPanel.tsx";

import { useVoiceHold } from "./chat/useVoiceHold.ts";
import { useNavStack } from "./shared/useNavStack.ts";
import { readMobileVoiceMode, saveMobileVoiceMode, toggleMobileVoiceMode as switchMobileVoiceMode } from "./chat/mobileVoiceMode.ts";
import { quickSessionTitle } from "./chat/quickTitle.ts";
import { localProjectMessages, localProjectSessions, saveLocalProjectSession, removeLocalProjectSession } from "./chat/localProjectSessions.ts";
import { listLocalProjectDirs, rememberLocalProjectDir, ensureLocalProjectDir, forgetLocalProjectDir, mergeProjectGroups } from "./chat/localProjectDirs.ts";
import { localChatAvailable, localChatList, localChatMessages, localChatSave, localChatPatch, localChatRemove, isAiOnlyChat } from "./chat/localChatStore.ts";
import { publishRunEvent, subscribeRunEvents } from "./chat/runBus.ts";
import { encodeUserKey } from "./chat/userKey.ts";
import { useContacts } from "./shared/useContacts.ts";

import { useChatScroll } from "./useChatScroll.ts";
import { useAtMention, type MentionCandidate } from "./shared/useAtMention.ts";

import { modelOptionKey, normalizeModelOption, type ModelOption, type ModelMeta } from "./components/ModelSelect.tsx";
import { MobileChoiceDialog } from "./components/MobileChoiceDialog.tsx";
import { type CompareSubmission } from "./components/ComparePane.tsx";
import { copyTextToClipboard } from "./shared/clipboard.ts";
import { readChatDraft, saveChatDraft, AGENT_OPEN_ARTIFACTS_EVENT, AGENT_OPEN_DIFF_EVENT, AGENT_SESSION_UPDATED_EVENT, COWORK_MESSAGE_REVOKED_EVENT, COWORK_MESSAGE_UPDATE_EVENT } from "./shared/drafts.ts";
import {  type ArtifactChange } from "./components/ArtifactDiff.tsx";
import { aggregateArtifactChanges } from "./shared/artifactDiffModel.ts";
import { applyTheme, readTheme, type ThemeMode } from "./shared/theme.ts";
import { DesktopHistoryControls } from "./components/DesktopHistoryControls.tsx";
import { consumeAgentDraft, isAgentDraftConsumed, pendingAgentDraft, readAgentLocation, writeAgentLocation } from "./shared/navigation.ts";
import {
  readShowContextUsage,
  writeShowContextUsage,
  readShowModel,
  writeShowModel,
  readMultiFramework,
  writeMultiFramework,
  subscribeUiPrefs,
  SHOW_CONTEXT_USAGE_KEY,
  SHOW_MODEL_KEY,
  MULTI_FRAMEWORK_KEY,
  RIGHT_CTRL_VOICE_KEY,
  readRightCtrlVoice,
  writeRightCtrlVoice,
  readLastSession,
  writeLastSession,
  clearLastSession,
} from "./shared/uiPrefs.ts";
import type { ArtifactType, ArtifactMeta, Scene, SceneSuggestion, ChatUser, ChatUserRole, AgentWindowProps, ComposerReference, UiAttachment, UiImage, UiVoiceRecording, UiQuestionOption, UiQuestion, UiTool, UiStep, BrowserStepData, ModelInfo, UiMessage, QueueItem, RtState, SessionItem, GroupRef, SessionCardSnapshot } from "./chat/types.ts";
export type { ArtifactType, ArtifactMeta, Scene, ChatUser, ChatUserRole, AgentWindowProps, ComposerReference, ComposerReferenceSource, UiAttachment, UiImage, UiQuestionOption, UiQuestion, UiTool, UiStep, BrowserStepData, ModelInfo, UiMessage, QueueItem, RtState, SessionItem, GroupRef, SessionCardSnapshot } from "./chat/types.ts";
import { readAgentMode, saveAgentMode } from "./chat/agentModePreference.ts";
import { modelListSnapshot, fetchModelList, clearModelListSnapshot, type ModelListSnapshot } from "./chat/modelList.ts";
import { DD_SDK_URL, FEISHU_SDK_URL, ShareCancelledError, loadScript, isInDingTalk, isDesktopApp, isDingTalkNotificationWebView, summarizeForNotify, isGroupSession, notificationTitleForSession, showNotification, canNotify, type ShareState } from "./chat/platform.ts";
import {  isImageFile, isLikelyNonVisionModel, generateSessionId, parseSseFrame } from "./chat/messageUtils.ts";
import { browserCdp } from "./chat/browserCdp.ts";
import { openWorkPanelSurface, type SessionWorkflow, type WorkPanelSurface } from "./chat/workPanel.ts";

import QuestionCard from "./chat/QuestionCard.tsx";
import { CheckIcon } from "./icons/SharedIcons.tsx";
import { ContextMeterIcon } from "./icons/DynamicIcons.tsx";
import { isInvalidGeneratedTitle } from "./chat/modelList.ts";
import { fileToBase64, messagePreviewText } from "./chat/messageUtils.ts";
import { IS_ELECTRON, AGENT_HOST, canPickWorkspace } from "./chat/platform.ts";
import { compactTokens, contextUsedTokens } from "./chat/usage.ts";
import { useVoiceDictation, createDictationTranscriber, type VoiceTranscriber, type VoiceDictationError } from "@summersmile/voice-dictation";
import { createTencentRealtimeRecorder, type RealtimeRecorderHandle } from "./chat/tencentRealtimeRecorder.ts";
import { ChatSessionContext } from "./chatSession.tsx";
// ==================== 类型定义 ====================

/** SSE 帧数据：服务端自由字段，按事件类型取用 */
type SseData = Record<string, any>;

/**
 * @ 命中规则，与服务端保持同一口径（cowork.ts explicitlyMentioned / db.ts messageMentionsMe）：
 * @名字 / @所有人 / @all，支持全角＠、@ 与名字间空白，名字后须为边界（空白/标点/结尾）。
 */
function mentionMatchesMe(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`[@＠]\\s*(?:${escaped}|所有人|all)(?=$|[\\s，。！？?,.!:：；;])`, "i").test(text);
}

/**
 * 实时/本地乐观更新时同步计算会话列表的 lastMentionedMe：
 * 最后一条人类消息（非 system、非本人发送）的内容是否 @ 了我的显示名。
 * 返回 null 表示无法可靠判断（AI 回复不改变最后一条人类消息 / 不知道我的名字），
 * 调用方应保持该会话已有值，最终由服务端刷新兜底。
 */
function computeLastMentionedMe(message: { role?: string; content?: string; senderSub?: string | null }, selfSub: string, selfName: string): boolean | null {
  if (message.role === "system") return false;
  if (message.role === "assistant") return null;
  const content = String(message.content ?? "").trim();
  if (!content) return false;
  const senderSub = String(message.senderSub ?? "");
  if (senderSub && senderSub === selfSub) return false;
  const name = (selfName || "").trim();
  if (!name) return null;
  return mentionMatchesMe(content, name);
}

/**
 * 去掉末尾的「空答复占位」。
 *
 * 一轮对话开始时，内存里会先插一条 content 为空的 assistant 占位（等流式填充）。
 * 这条占位如果被写进落盘历史，别的实例/刷新后打开会话就会看到一个永远不填内容的空气泡，
 * 而且它挡在末尾会让「是否还在跑」的判断失真（末尾应当是这一轮的用户消息）。
 * 判定从严：只有正文、步骤正文、思路、工具全空才算占位，任何真实内容都不会被误删。
 */
function trimEmptyAssistantTail(messages: UiMessage[]): UiMessage[] {
  let end = messages.length;
  while (end > 0) {
    const last = messages[end - 1];
    if (!last || last.role !== "assistant" || String(last.content ?? "").trim()) break;
    const steps = Array.isArray(last.steps) ? last.steps : [];
    const hasStepContent = steps.some((step) => Boolean(step?.text?.trim?.() || step?.thinking?.trim?.() || step?.tool || step?.ask?.length));
    if (hasStepContent) break;
    end -= 1;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

/** 本机「正在跑的那一轮」记录（send() 开头写入，收尾删除）；跨实例接管 run 时用它。 */
function readActiveRunRecord(sid: string): { runId: string; sdkSid: string; mode: NonNullable<ModelInfo["agentMode"]> } | null {
  try {
    const saved = JSON.parse(window.localStorage.getItem(`agent-kit:active-run:${sid}`) || "null") as
      { runId?: unknown; sdkSid?: unknown; mode?: unknown; startedAt?: unknown } | null;
    if (!saved || typeof saved.runId !== "string" || typeof saved.sdkSid !== "string" || typeof saved.mode !== "string") return null;
    if (!["codebuddy", "codex", "cc", "dsh"].includes(saved.mode)) return null;
    if (typeof saved.startedAt !== "number" || Date.now() - saved.startedAt > 24 * 60 * 60 * 1000) return null;
    return { runId: saved.runId, sdkSid: saved.sdkSid, mode: saved.mode as NonNullable<ModelInfo["agentMode"]> };
  } catch {
    return null;
  }
}

// 合并密集 SSE 更新，每次排空全部增量（32ms 批次，不按字数限速）。
// 渐入和片段错峰由 Markdown/CSS 完成，网络读取、完成状态、持久化不等待动画。
const STREAM_TICK_MS = 32;
// 中栏真正的最小宽度（正常手机宽度）与左栏固定宽：右栏拖拽/初始宽度都不能把中间 chat 挤到其下。
// 与 styles.css 的 .chat-main min-width、.chat-pane-right flex-basis 上限保持一致。
const CHAT_MIN_W = CHAT_MIN_WIDTH;
const LEFT_PANE_W = 280;
/** 原地编辑用户消息时的宽度下限（px）。
 *  编辑框宽度原则 =原气泡宽度（与编辑前同宽），但短消息（如"Hi"）的气泡本身很窄，
 *  直接沿用会把底部「提示语 + 取消/发送」按钮挤成竖排一字一行。故设下限，
 *  取能舒展放下底部元素（约 420px：提示语 + 两个按钮 + 换行余量）的经验值。
 *  与 styles.css 里 .msg.user.is-editing 的 min-width 保持一致。 */
const EDIT_MIN_WIDTH = 420;
// 主导航栏（图标侧栏）拖拽折叠：展开态拖右缘往左，假想宽度低于阈值即折叠为纯图标；
// 折叠态往右拖越过阈值即恢复展开。拖拽只做过阈值切换，不自由调宽、不单独持久化宽度。
// 折叠固定 52px（见 styles-navigation.css .agent-navigation-sidebar 默认宽），展开宽回落 prop/默认 200。
const NAV_COLLAPSE_THRESHOLD = 96;
const NAV_COLLAPSED_W = 52;
const NAV_DEFAULT_W = 200;
// 与参考工程完全一致：单次最长 10 分钟，超时自动转写。
const MAX_RECORDING_MS = 10 * 60 * 1000;

// 清洗助手文本里的限流噪音（显示层兜底，覆盖已存的脏历史）：
//  - CLI transcript 会给消息加 trace 前缀（(32hex/uuid)），剥离前缀、保留正文；
//  - 429 频率限制错误整段（可能带 trace 前缀/后缀）直接丢弃，不展示给用户。

/** 上下文容量环形指示（输入框右侧、模型名左侧，对标 WorkBuddy）：
 *  已用 = 最新一轮 result.usage.input_tokens（CLI 每次请求发送全量上下文，近似当前上下文大小）；
 *  上限 = /api/models/context 返回的模型上下文窗口；服务端拿不到时仍显示环（整环中性 + token 数，
 *  不显示百分比），只有完全没有用量时才不显示。
 *  三档状态色：<70% 中性绿、70-90% 警示黄、≥90% 危险红；压缩中（compact_status）呼吸闪烁。 */
function ContextMeter({
  usedTokens,
  maxTokens,
  compacting,
  lastCompactAt,
}: {
  usedTokens: number | null;
  maxTokens: number | null;
  compacting?: boolean;
  lastCompactAt?: number | null;
}) {
  const used = usedTokens ?? 0;
  // 只在有实际用量时显示；上限未知（服务端拿不到模型窗口）时仍显示——给出 token 数与整环中性提示，
  // 不再因为「拿不到上限」而整环消失（此前的硬隐藏是圆环显示不了的直接原因）。
  if (used <= 0) return null;
  const known = typeof maxTokens === "number" && maxTokens > 0;
  const pct1 = known ? Math.min(100, (used / maxTokens) * 100) : null;
  const pct = pct1 == null ? null : Math.round(pct1);
  const tone = pct == null ? "neutral" : pct >= 90 ? "danger" : pct >= 70 ? "warn" : "ok";
  const r = 7.5;
  const circ = 2 * Math.PI * r;
  // 上限未知：dashoffset=0 → 整环中性显示（表示"有用量、容量未知"）；已知：按比例留缺口
  const off = pct == null ? 0 : circ * (1 - pct / 100);
  const tipParts = [
    pct1 != null
      ? `上下文已使用 ${pct1.toFixed(1)}% · ${compactTokens(used)} / ${compactTokens(maxTokens as number)} tokens`
      : `上下文已使用 ${compactTokens(used)} tokens（模型上限未知）`,
  ];
  if (compacting) tipParts.push("上下文压缩中…");
  else if (lastCompactAt) {
    const secs = Math.max(0, Math.round((Date.now() - lastCompactAt) / 1000));
    tipParts.push(secs < 60 ? `最近压缩于 ${secs} 秒前` : `最近压缩于 ${Math.round(secs / 60)} 分钟前`);
  }
  const tip = tipParts.join(" ");
  return (
    <span
      className={`ctx-meter ctx-meter--${tone}${compacting ? " is-compacting" : ""}`}
      data-tip={tip}
      aria-label={tip}
    >
      <ContextMeterIcon radius={r} circumference={circ} offset={off} />
    </span>
  );
}

// 底部答复进度条右侧的幽默文案池（黑白幽默，不低俗）；进入忙碌时随机取一条、本轮固定
const PROGRESS_TIPS = [
  "Agent 还在线，放心划水",
  "正在把零散想法拼成答案",
  "AI 正在燃烧脑细胞",
  "别急，好饭不怕晚",
  "码字中，请勿投喂",
  "思考得比看起来深",
  "马上就好，真的",
  "先想想，再说话",
] as const;

// 默认场景：通用示例（宿主可传入自己的 scenes 覆盖）。
export const DEFAULT_SCENES = [
  {
    key: "general",
    label: "通用",
    suggestions: [
      { label: "你好" },
      { label: "你能做什么？" },
      { label: "帮我写一个 hello.py" },
    ],
  },
];

/**
 * 执行场景建议的命令动作（SceneSuggestion.command）。设置了 command 的建议点击后
 * 不发送消息，只触发动作；未支持的命令安全忽略并告警。
 * - open <url>：在右侧面板新 tab 打开该网址（http/https；缺省协议自动补 https://）。
 */
export function runSuggestionCommand(command: string, title: string): void {
  const trimmed = command.trim();
  if (!trimmed) return;
  const space = trimmed.indexOf(" ");
  const verb = space === -1 ? trimmed : trimmed.slice(0, space);
  const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
  if (verb === "open") {
    if (!arg) { console.warn("[agent-kit] 场景建议命令 open 缺少 URL"); return; }
    const urlText = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(arg) ? arg : `https://${arg}`;
    let url: URL;
    try { url = new URL(urlText); } catch { console.warn("[agent-kit] 场景建议命令 open 的 URL 无效", arg); return; }
    if (url.protocol !== "http:" && url.protocol !== "https:") { console.warn("[agent-kit] 场景建议命令 open 仅支持 http/https", arg); return; }
    openWorkPanelSurface({ kind: "website", id: url.href, title, url: url.href, presentation: "browser" });
    return;
  }
  console.warn(`[agent-kit] 未支持的场景建议命令: ${command}`);
}

/**
 * 场景快捷问题按钮（空态建议使用）：
 * - command：触发动作（如 open <url>），不发送消息；
 * - sendOnClick:false：仅把 label 放入输入框并聚焦，等待用户补充后手动发送；
 * - 其他：点击即发送（suggestion.prompt 随本次请求注入 system）。
 */
function SuggestionButton({ s, onSend, onFill }: { s: SceneSuggestion; onSend: (label: string, prompt?: string | null) => void; onFill: (label: string, prompt?: string | null) => void }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (s.command) {
          runSuggestionCommand(s.command, s.label);
          return;
        }
        if (s.sendOnClick === false) {
          onFill(s.label, s.prompt);
        } else {
          onSend(s.label, s.prompt);
        }
      }}
    >
      {s.label}
    </button>
  );
}

/** 工具栏「+」右侧的接入群胶囊条：名称放得下就放名称，放不下转纯头像，再放不下裁剪；最右 › 弹框列出全部并可删除。 */
function RefChipBar({ refs, basePath, onRemove }: { refs: GroupRef[]; basePath?: string; onRemove: (id: string) => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(refs.length);
  const [showName, setShowName] = useState<Set<number>>(new Set());
  const [overflow, setOverflow] = useState(false);
  const ARROW_W = 30;

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const measure = measureRef.current;
    if (!wrap || !measure) return;
    const compute = () => {
      const W = wrap.clientWidth;
      const nodes = Array.from(measure.children) as HTMLElement[];
      const GAP = 6;
      const greedy = (reserve: number) => {
        let used = 0;
        let count = 0;
        const names = new Set<number>();
        for (let i = 0; i < refs.length; i++) {
          const nameW = nodes[i * 2]?.offsetWidth ?? 0;
          const avW = nodes[i * 2 + 1]?.offsetWidth ?? 0;
          const pad = used === 0 ? 0 : GAP;
          if (used + pad + nameW <= W - reserve) { used += pad + nameW; names.add(i); count++; }
          else if (used + pad + avW <= W - reserve) { used += pad + avW; count++; }
          else break;
        }
        return { count, names };
      };
      // 第一遍不预留箭头：全部放得下就完整显示名字、不显示 ›；
      // 放不下再第二遍预留箭头位，压缩到只显示能容纳的。
      let res = greedy(0);
      if (res.count < refs.length) res = greedy(ARROW_W);
      setVisible(res.count);
      setShowName(res.names);
      setOverflow(res.count < refs.length);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [refs]);

  if (!refs.length) return null;
  const avatarSrc = (r: GroupRef) => r.avatar ? (r.avatar.startsWith("/") ? `${basePath ?? ""}${r.avatar}` : r.avatar) : undefined;

  return (
    <div className="ref-chip-wrap">
      {/* 隐藏测量层：每个接入项两个节点（名称胶囊宽 / 纯头像胶囊宽） */}
      <div ref={measureRef} className="ref-chip-measure" aria-hidden="true">
        {refs.map((r) => (
          <Fragment key={r.id}>
            <span className="ref-chip ref-chip--name">
              <span className="ref-chip-av"><Avatar name={r.title} src={avatarSrc(r)} isGroup={r.kind !== "peer"} size={18} className="chat-ref-avatar" /></span>
              <span className="ref-chip-name">{r.title}</span>
            </span>
            <span className="ref-chip ref-chip--avatar">
              <span className="ref-chip-av"><Avatar name={r.title} src={avatarSrc(r)} isGroup={r.kind !== "peer"} size={18} className="chat-ref-avatar" /></span>
            </span>
          </Fragment>
        ))}
      </div>
      <div className="ref-chip-bar" ref={wrapRef}>
        <div className="ref-chip-scroll">
          {refs.slice(0, visible).map((r, i) => (
            <span
              key={r.id}
              className={`ref-chip${showName.has(i) ? " ref-chip--name" : " ref-chip--avatar"}`}
              title={r.title}
            >
              <span className="ref-chip-av">
                <Avatar name={r.title} src={avatarSrc(r)} isGroup={r.kind !== "peer"} size={18} className="chat-ref-avatar" />
                <button
                  type="button"
                  className="ref-chip-x"
                  onClick={() => onRemove(r.id)}
                  aria-label="移除接入"
                  title="移除接入"
                >×</button>
              </span>
              {showName.has(i) ? <span className="ref-chip-name">{r.title}</span> : null}
            </span>
          ))}
        </div>
        {overflow ? (
          <button
            type="button"
            className="ref-chip-more"
            onClick={() => setOpen((v) => !v)}
            aria-label="查看全部接入的群/聊天"
            aria-expanded={open}
          >›</button>
        ) : null}
      </div>
      {open ? (
        <div className="ref-chip-pop">
          <div className="ref-chip-pop-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="ref-chip-pop-inner">
            <div className="ref-chip-pop-title">已接入 {refs.length} 个群/聊天</div>
            {refs.map((r) => (
              <div className="ref-chip-row" key={r.id}>
                <Avatar name={r.title} src={avatarSrc(r)} isGroup={r.kind !== "peer"} size={18} className="chat-ref-avatar" />
                <span className="ref-chip-row-name" title={r.title}>{r.title}</span>
                <button type="button" className="ref-chip-row-remove" onClick={() => onRemove(r.id)}>移除</button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function AgentWindow(props: AgentWindowProps) {
  return <ChatLocaleProvider locale={props.locale}><AgentWindowContent {...props} /></ChatLocaleProvider>;
}

function AgentWindowContent({
  loginProviders = "",
  toolbar,
  renderCoworkToolbar,
  layoutMode = "fixed",
  themeManagedByHost = false,
  showNavigation = false,
  renderPanels,
  embedded,
  className = "",
  onComposerTextPresenceChange,
  localGuest = false,
  cloudEnabled = false,
  homeContacts,
  resolveHomeContactSession,
  resolveHomeGroupSession,
  onExistingPersonChatOpened,
  onHomeMentionCleared,
  onHomeMessageSubmitted,
  newChatOnMount = false,
  closePanelsOnNewChat = false,
  keepSidebarOnNewChat = false,
  openSidebarOnMount = false,
  defaultPermissionMode = "default",
  permissionPreferenceKey = "agent-kit:permission-mode",
  /** 锁定为「完全访问」：权限恒为 full，且不渲染输入框内的权限切换按钮（桌面宿主用）。 */
  permissionLocked = false,
  shortcutsActive = true,
  onVoiceStateChange,
  onVoiceTranscribingChange,
  voiceAmplitudeRef,
  onRunningSessionsChange,
  onSessionSnapshotsChange,
  onRightPanelWidthChange,
  rightPanelWidth: controlledRightPanelWidth,
  composerPlaceholder,
  emptyMessage,
  initialUser = {},
  basePath: basePathProp = "/",
  scenes = DEFAULT_SCENES,
  onLogout,
  chatEndpoint,
  artifactEndpoint,
  uploadEndpoint,
  voiceEnabled = true,
  voiceHoldEnabled,
  voiceTokenEndpoint,
  voiceTranscribeEndpoint,
  voicePreviewOnly = false,
  /** 实时转录开关：按住语音键走腾讯云 WebSocket 边说边出字，而非录完整段再上传。 */
  voiceRealtimeTranscription = false,
  /** 实时转录会话签发端点（POST 后返回 wss URL）；缺省用 basePath/api/audio/session。 */
  voiceRealtimeSessionEndpoint,
  showVoiceButton,
  uploadEnabled = true,
  title: titleProp,
  logoSrc = null,
  sidebarLogo = null,
  sidebar,
  sidebarExpanded = false,
  sidebarWidth,
  models: modelsProp,
  modelsLoading = false,
  modelsLoadFailed = false,
  defaultShowModel = true,
  showModel: controlledShowModel,
  showContextUsage: controlledShowContextUsage,
  onShowContextUsageChange,
  onShowModelChange,
  agentModesOverride,
  agentModesPending = false,
  renderSessionFooter,
  onAssistantResponse,
  onReplyNotification,
  onUnreadCountChange,
  sessionRequest,
  onSessionRequestHandled,
  mentionRequest,
  onMentionRequestHandled,
  rerunRequest,
  onRerunRequestHandled,
  sendRequest,
  onSendRequestHandled,
  attachRequest,
  onAttachRequestHandled,
  onComposerContentPresenceChange,
  backgroundMode = false,
  /**
   * 宿主 UI 当前不可见（宿主关闭 / 最小化 Home 后实例仍挂载、会话继续在后台跑）。
   * 与 backgroundMode 的区别：backgroundMode 表示"这个实例本来就只做后台任务"
   * （挂载期不恢复会话、不处理会话更新事件）；readSuppressed 只关掉"已读"判定，
   * 其余 UI 行为完全照旧 —— 只用来保证"看不见的时候绝不把会话标成已读"。
   */
  readSuppressed = false,
  conversationContext,
  capabilities,
  referenceSources = [],
  roles,
  sessionFooterVisibility = "after-response",
  sessionFooterAppearing = true,
}: AgentWindowProps) {
  const t = useChatTranslation();
  const title = titleProp ?? t("assistant");
  const embeddedMode = Boolean(embedded);
  const shellRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const shell = shellRef.current;
    const viewport = window.visualViewport;
    if (!shell || !viewport) return;
    const mobile = window.matchMedia("(max-width: 767.98px)");
    const syncViewport = () => {
      if (mobile.matches) {
        shell.style.setProperty("--mobile-viewport-height", `${Math.round(viewport.height)}px`);
        shell.style.setProperty("--mobile-viewport-top", `${Math.round(viewport.offsetTop)}px`);
      } else {
        shell.style.removeProperty("--mobile-viewport-height");
        shell.style.removeProperty("--mobile-viewport-top");
      }
    };
    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    mobile.addEventListener("change", syncViewport);
    return () => {
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
      mobile.removeEventListener("change", syncViewport);
    };
  }, []);
  // basePath 归一化：去掉尾部斜杠。否则 "/" 与 "/api/chat" 拼接成 "//api/chat"，
  // 会被浏览器当成协议相对地址解析到 http://api/...，导致请求全部失败（Failed to fetch）。
  const basePath = (basePathProp ?? "/").replace(/\/+$/, "");
  const localFiles = localFilesApi();
  // 桌面壳：AI 单聊本地落盘；真人会话在登录后走账号服务。
  const localChat = localChatAvailable();
  // 本机会话的属主键：同一台机器换账号登录时，各自只看 ~/.agent/chats/<owner>/ 下的会话。
  // 空串（未登录/缺 provider）→ 本地会话功能整体不可用，绝不兜底成"全局共享"。
  const localOwner = encodeUserKey(initialUser?.provider, initialUser?.unionId);
  const localOwnerWarnedRef = useRef(false);
  if (localChat && !localOwner && !localOwnerWarnedRef.current) {
    localOwnerWarnedRef.current = true;
    console.warn("[agent-kit] 本地会话不可用：登录用户缺少 provider/unionId，无法定位 ~/.agent/chats/<owner>");
  }
  const endpointUrl = (endpoint: string, params: Record<string, string>): string => {
    const url = new URL(endpoint, window.location.href);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  };
  const localChatRoute = (suffix: string): string => {
    if (!chatEndpoint) return `${basePath}/api/chat${suffix}`;
    const url = new URL(chatEndpoint, window.location.href);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${suffix}`;
    return url.toString();
  };
  const localApiRoute = (pathname: string): string => {
    if (!chatEndpoint) return `${basePath}${pathname}`;
    const url = new URL(chatEndpoint, window.location.href);
    url.pathname = pathname;
    return url.toString();
  };
  const artifactUrl = (params: Record<string, string>): string => endpointUrl(artifactEndpoint || `${basePath}/api/artifact`, params);
  const navigationEntries = useMemo(() => resolveSidebar(sidebar), [sidebar]);
  const navigationKeys = useMemo(() => navigationEntries.map((entry) => entry.key), [navigationEntries]);
  const hasNavigation = showNavigation && hasSidebar(navigationEntries);
  // 宿主自定义 key 也要能被 ?view=xxx 恢复，故白名单用配置项而非内置字面量。
  const [activeNavigation, setActiveNavigation] = useState<string>(() => {
    if (embeddedMode) return "home";
    const view = typeof window === "undefined" ? null : readAgentLocation(navigationKeys)?.view;
    return view && view !== "session" && view !== "new" && navigationKeys.includes(view) ? view : "home";
  });
  const pendingMobileTabRef = useRef<string | null>(null);
  const tabLocationsRef = useRef<Record<string, { view: "session" | "new"; sessionId?: string }>>({});
  // 宿主为侧栏项提供的页面内容。同 key 可覆盖内置页面（home 例外，对话视图始终由 kit 渲染）。
  const renderNavigationEntry = (key: string): React.ReactNode => {
    if (key === "home") return null;
    return navigationEntries.find((entry) => entry.key === key)?.render?.() ?? null;
  };
  const customNavigationViews: Record<string, React.ReactNode> = {};
  for (const entry of navigationEntries) {
    if (entry.key !== "home" && entry.render) customNavigationViews[entry.key] = entry.render();
  }
  const [conversationView, setConversationView] = useState(() =>
    !embeddedMode && typeof window !== "undefined" && ["session", "new"].includes(readAgentLocation(navigationKeys)?.view ?? ""));
  const [mobilePicker, setMobilePicker] = useState<"framework" | "model" | "compare-framework" | "compare-model" | null>(null);
  // 消息级点赞/点踩状态提升到 AgentWindow 顶层，按 messageId 存；切换会话（本组件不卸载）再回来仍保留。
  const [msgVotes, setMsgVotes] = useState<Record<number, "up" | "down" | null>>({});
  // 附件/上传文件 URL 解析：web 部署同源（相对路径即可）；桌面宿主开发模式页面在 vite(5173)，
  // 引擎在 127.0.0.1:17800（经 basePath 传入），相对 /uploads 必须拼 basePath 才能到达引擎，
  // 否则 img/下载全指向 vite 404。绝对 URL / data: / blob: 原样返回。
  // 幂等：已带 basePath 前缀（openInputFile 已 resolve、或从 localStorage 恢复的标签页）时
  // 直接返回，避免二次拼接成 /linger/linger/... 导致输入文件预览 404（web 部署 basePath=/linger）。
  const resolveFileUrl = (url: string | undefined | null, fileId?: string): string => {
    if (!url) return "";
    if (isLocalReference(url) && chatEndpoint) {
      const local = new URL(chatEndpoint, window.location.href);
      local.pathname = "/file-ref";
      local.searchParams.set("ref", url);
      return local.toString();
    }
    return resolveAttachmentUrl(url, basePath, fileId);
  };
  // 模型下拉来源：优先用宿主传入的 models prop；未传入时由 agent-kit 前端自动从后端
  // GET /api/models/list 拉取（按 CodeBuddy 登录状态合并内置模型与 models.json）。
  // 这样模型来源逻辑完全沉淀在 agent-kit，应用端零感知。
  // 归一化：纯字符串 id 或 {id,name,meta} 统一成 {id,name?,meta?}，按 id 匹配与发送。
  const normalizeOpts = (
    list: ModelOption[],
  ): { id: string; name?: string; meta?: ModelMeta }[] =>
    list
      .map((m) =>
        typeof m === "string"
          ? { id: m.trim() }
          : { id: (m.id || "").trim(), name: m.name ? m.name.trim() : undefined, meta: m.meta },
      )
      .filter((o) => o.id);

  // 懒初始化：若本应用会话已经拉过模型列表（modelListSnapshot 已落地），直接以快照值
  // 起步——重进聊天页时不会先渲染一帧「模型加载中」再翻成已加载，从而无灰屏闪烁。
  const hostModels = modelsProp !== undefined;
  const [modelOptions, setModelOptions] = useState<{ id: string; name?: string; meta?: ModelMeta }[]>(
    () => (hostModels ? normalizeOpts(modelsProp) : modelListSnapshot?.list ?? []),
  );
  const [codexModelOptions, setCodexModelOptions] = useState<{ id: string; name?: string; meta?: ModelMeta }[]>(
    () => (!hostModels && modelListSnapshot ? modelListSnapshot.codexList : []),
  );
  const [codexModelsLoaded, setCodexModelsLoaded] = useState(!hostModels);
  const [codexModelsFailed, setCodexModelsFailed] = useState(false);
  const [selectedCodexModel, setSelectedCodexModel] = useState("__codex_default__");
  const [dshModelOptions, setDshModelOptions] = useState<Array<{ id: string; name?: string }>>([
    { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" },
  ]);
  const [selectedDshModel, setSelectedDshModel] = useState(() => {
    try { return localStorage.getItem("agent-kit:dsh-model") || "deepseek-flash"; } catch { return "deepseek-flash"; }
  });
  useEffect(() => { try { localStorage.setItem("agent-kit:dsh-model", selectedDshModel); } catch { /* storage unavailable */ } }, [selectedDshModel]);
  useEffect(() => {
    if (!agentModesOverride?.includes("dsh")) return;
    let active = true;
    const launcher = (window as unknown as { launcher?: { listDshModels?: () => Promise<Array<{ id: string; name?: string }>> } }).launcher;
    const refresh = () => { void launcher?.listDshModels?.().then((models) => {
      if (!active) return;
      if (!models.length) return;
      setDshModelOptions(models);
      setSelectedDshModel((current) => models.some((model) => model.id === current) ? current : models[0].id);
    }).catch(() => { /* keep the built-in or last successfully loaded models */ }); };
    refresh();
    window.addEventListener("launcher:dsh-models-changed", refresh);
    return () => { active = false; window.removeEventListener("launcher:dsh-models-changed", refresh); };
  }, [agentModesOverride?.join(",")]);
  const [modelSelectionEnabled, setModelSelectionEnabled] = useState(() => (hostModels ? modelsProp.length > 0 : modelListSnapshot?.enabled ?? false));
  const [modelError, setModelError] = useState<string | null>(() => (!hostModels && modelListSnapshot ? modelListSnapshot.modelError : null));
  const [modelListLoaded, setModelListLoaded] = useState(() => hostModels || !!modelListSnapshot);
  // 宿主传 models 时（桌面 / 启动器）不会去请求 /api/models/list，也就拿不到服务端下发的框架列表；
  // agentModesOverride 就此成为唯一来源：宿主要「关掉某个算力提供商」时把模式从这里摘掉即可。
  // 用 join 后的字符串做依赖，避免宿主每帧新建数组把下面那个 effect 打成死循环。
  const overrideKey = agentModesOverride?.join(",") ?? "";
  const hostAgentModes = (): ("codebuddy" | "codex" | "dsh")[] =>
    agentModesOverride ? [...agentModesOverride] : ["codebuddy"];
  const [agentModes, setAgentModes] = useState<("codebuddy" | "codex" | "dsh")[]>(
    () => (!hostModels && modelListSnapshot
      ? (agentModesOverride
        ? modelListSnapshot.agentModes.filter((mode) => agentModesOverride.includes(mode))
        : modelListSnapshot.agentModes)
      : hostAgentModes()),
  );
  const [agentModesLoaded, setAgentModesLoaded] = useState(() => hostModels || !!modelListSnapshot);
  const codexEnabled = agentModesOverride?.includes("codex") ?? agentModes.includes("codex");
  const modelsLoaded = modelListLoaded && !modelsLoading && !modelsLoadFailed &&
    (!hostModels || !codexEnabled || (codexModelsLoaded && !codexModelsFailed));
  // 宿主调整启用框架后即时生效（不必重挂整棵聊天窗）：当前选中的框架被摘掉时回落到第一个可用项。
  useEffect(() => {
    if (!hostModels) return;
    const next = agentModesOverride ? [...agentModesOverride] : ["codebuddy" as const];
    setAgentModes((current) => (current.join(",") === next.join(",") ? current : next));
    setAgentMode((current) => (!next.length || next.includes(current as "codebuddy" | "codex" | "dsh") ? current : next[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrideKey, hostModels]);
  const [defaultModel, setDefaultModel] = useState(() => (hostModels ? normalizeOpts(modelsProp)[0]?.id ?? "hy3" : modelListSnapshot?.defaultModel ?? "hy3"));
  // 只有完全不传 models 时才使用 kit 的远端模型列表。空数组也是宿主明确提供的状态。
  const autoFetchModels = !hostModels;
  useEffect(() => {
    if (!hostModels) return;
    const launcher = (window as unknown as { launcher?: { listCodexModels?: () => Promise<Array<{ id: string; name?: string; meta?: ModelMeta }>> } }).launcher;
    if (!launcher?.listCodexModels) { setCodexModelsLoaded(true); return; }
    let active = true;
    void launcher.listCodexModels().then((models) => {
      if (active && models.length) setCodexModelOptions(models);
    }).catch(() => { if (active) setCodexModelsFailed(true); })
      .finally(() => { if (active) setCodexModelsLoaded(true); });
    return () => { active = false; };
  }, [hostModels]);
  useEffect(() => {
    if (!hostModels) return;
    const options = normalizeOpts(modelsProp);
    setModelOptions(options);
    setModelSelectionEnabled(options.length > 0);
    setDefaultModel(options[0]?.id ?? "hy3");
    setModelError(null);
    setModelListLoaded(true);
  }, [modelsProp, hostModels]);

  // 自动拉取：宿主未显式传入 models 时，从后端获取「一次」（应用启动时）。
  // 由模块级单例 Promise 保证整会话只打一次 GET /api/models/list——
  // 组件重挂载（StrictMode 双挂载 / 会话切换 / 热更新 / 窗口聚焦）都复用同一份结果，
  // 不再重复请求、也不再闪烁「模型加载中」。已落地快照同步应用，重进聊天页无灰屏。
  useEffect(() => {
    if (!autoFetchModels) return;
    let cancelled = false;
    const applySnapshot = (snap: ModelListSnapshot) => {
      setModelError(snap.modelError);
      setModelListLoaded(true);
      setModelSelectionEnabled(snap.enabled);
      setDefaultModel(snap.defaultModel);
      setCodexModelOptions(snap.codexList);
      const available = agentModesOverride
        ? snap.agentModes.filter((mode) => agentModesOverride.includes(mode))
        : snap.agentModes;
      setAgentModes(available);
      setAgentModesLoaded(true);
      if (available.length) setAgentMode((current) => available.some((mode) => mode === current) ? current : available[0]);
      setModelOptions(snap.list);
    };
    const onModelsChanged = () => {
      clearModelListSnapshot();
      void fetchModelList(basePath).then((snap) => { if (!cancelled) applySnapshot(snap); })
        .catch(() => { if (!cancelled) setModelError("模型列表加载失败，当前无法对话"); });
    };
    window.addEventListener("agent-kit:models-changed", onModelsChanged);
    window.addEventListener("focus", onModelsChanged);
    (async () => {
      try {
        const snap = await fetchModelList(basePath);
        if (cancelled) return;
        applySnapshot(snap);
      } catch {
        if (!cancelled) { setModelOptions([]); setModelError("模型列表加载失败，当前无法对话"); setModelListLoaded(true); }
      }
    })();
    return () => {
      cancelled = true;
      window.removeEventListener("agent-kit:models-changed", onModelsChanged);
      window.removeEventListener("focus", onModelsChanged);
    };
  }, [basePath, autoFetchModels, agentModesOverride]);

  // —— 模型选择：按会话隔离 ——
  // 每个会话各自记住选中的模型（A 会话用甲、B 会话用乙），切换会话时恢复该会话上次的选择。
  // 记忆值是条目的**身份 key**（`vendor::id`，见 modelOptionKey）而非纯 id：不同 provider 可能提供
  // 相同 id 的模型（deepseek / 华为云都叫 deepseek-v4-flash），用 key 才能分别记住、分别高亮。
  // localStorage 结构：
  //   agent-kit:model            → 默认模型（新会话的初始值，也作旧版单值的兼容回退）
  //   agent-kit:model-by-session → { [sessionId]: modelKey } 各会话独立记忆
  // 注意：本区块在 sessionId state 之前，故用 initialSidRef 持有首个 sid（sessionId 初始化时复用它，保持单一数据源）。
  const initialSidRef = useRef<string>("");
  if (!initialSidRef.current) {
    const location = typeof window !== "undefined" ? readAgentLocation(navigationKeys) : null;
    // newChatOnMount（宿主 hover 预览等）：每次挂载从新会话开始——无窗口时 hover/点击
    // Home 进入的是新对话；最小化场景的「继续会话」由同实例预览（不重新挂载）承担，与此无关。
    initialSidRef.current = embedded?.sessionId
      || (location?.view === "new" && location.sessionId ? location.sessionId : generateSessionId());
  }
  const DEFAULT_MODEL_KEY = "agent-kit:model";
  const MODEL_BY_SESSION_KEY = "agent-kit:model-by-session";
  const readSessionModelMap = (): Record<string, string> => {
    try {
      const raw = window.localStorage.getItem(MODEL_BY_SESSION_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  const writeSessionModelMap = (map: Record<string, string>) => {
    try { window.localStorage.setItem(MODEL_BY_SESSION_KEY, JSON.stringify(map)); } catch { /* ignore */ }
  };
  /** 该会话是否已有明确选择过模型（区分"没选过"与"选过但列表里已不存在"） */
  const sessionModelMapRef = useRef<Record<string, string>>(readSessionModelMap());
  /** 默认模型（尚无会话上下文时用）：localStorage 偏好 → 首项。返回身份 key。 */
  const pickDefaultModel = (opts: { id: string; meta?: ModelMeta }[]): string => {
    if (!opts.length) return "";
    let saved = "";
    try { saved = window.localStorage.getItem(DEFAULT_MODEL_KEY) || ""; } catch { /* ignore */ }
    // 兼容旧版存的纯 id：身份 key 未命中时按 id 再匹配一次
    const hit = opts.find((o) => modelOptionKey(o) === saved) ?? opts.find((o) => o.id === saved);
    return hit ? modelOptionKey(hit) : modelOptionKey(opts[0]);
  };
  /** 按当前会话恢复模型：会话记忆优先 → 默认模型 → 首项；列表里都不存在则回落到可用首项。返回身份 key。 */
  const pickModelForSession = (sid: string, opts: { id: string; meta?: ModelMeta }[]): string => {
    if (!opts.length) return "";
    if (embedded?.model) {
      const preferred = opts.find((o) => modelOptionKey(o) === embedded.model || o.id === embedded.model);
      if (preferred) return modelOptionKey(preferred);
    }
    const remembered = sessionModelMapRef.current[sid];
    const hit = remembered
      ? opts.find((o) => modelOptionKey(o) === remembered) ?? opts.find((o) => o.id === remembered)
      : undefined;
    if (hit) return modelOptionKey(hit);
    return pickDefaultModel(opts);
  };
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    pickModelForSession(initialSidRef.current, modelOptions),
  );
  // 模型列表变更后，旧会话记住的模型可能已被移除；回落到当前可用列表。
  useEffect(() => {
    if (!modelOptions.length) return;
    if (selectedModel && modelOptions.some((option) => modelOptionKey(option) === selectedModel)) return;
    setSelectedModel(pickModelForSession(activeSidRef.current, modelOptions));
  }, [modelOptions, selectedModel]);
  // 纯模型 id（发送给引擎 / 能力判定用）：由身份 key 在当前列表里反查得到——
  // 不用字符串切分解析，避免模型 id 自身含 `::` 时误判；列表未加载时回退为 key 本身。
  const selectedModelId = modelSelectionEnabled
    ? (modelOptions.find((o) => modelOptionKey(o) === selectedModel)?.id ?? modelOptions[0]?.id ?? "")
    : defaultModel;
  // 当前模型的图片能力：以模型列表下发的 meta.supportsImages 为准（CLI/云端是权威来源），
  // 没有该字段时才退回按名字猜。不能只按名字前缀判断——deepseek-v4.1-flash 实际支持图片，
  // 旧的前缀规则会把它误判成纯文本模型，发图前给出错误提醒。
  const selectedModelSupportsImages = modelOptions.find((o) => modelOptionKey(o) === selectedModel)?.meta?.supportsImages;
  function changeModel(key: string) {
    if (!modelSelectionEnabled) return;
    setSelectedModel(key);
    maxTokensRef.current = null; // 模型变化 → 上限可能不同（如 hy3 192k / 1M 模型）：重置，下一轮补拉
    // 写入该会话的独立记忆 + 默认模型（新会话沿用最近一次选择）
    const sid = activeSidRef.current;
    if (sid) {
      sessionModelMapRef.current = { ...sessionModelMapRef.current, [sid]: key };
      writeSessionModelMap(sessionModelMapRef.current);
    }
    if (!embeddedMode) try { window.localStorage.setItem(DEFAULT_MODEL_KEY, key); } catch { /* ignore */ }
  }
  /** 切换/新建会话时同步模型选择（会话记忆优先，无记忆则用默认模型，并写回会话记忆避免下次切回时仍走全局默认） */
  const syncModelForSession = (sid: string) => {
    if (!modelOptions.length) return;
    setSelectedModel((prev) => {
      const next = pickModelForSession(sid, modelOptions);
      if (next && next !== prev) {
        sessionModelMapRef.current = { ...sessionModelMapRef.current, [sid]: next };
        writeSessionModelMap(sessionModelMapRef.current);
        return next;
      }
      return prev;
    });
  };
  const [messages, setMessages] = useState<UiMessage[]>([]);
  // 当前会话「卡在提问环节」的活跃提问卡片（固定在输入框上方渲染）：
  // 取最后一条 assistant 消息末位未作答的 ask step；与 hasPendingQuestion 判定口径一致，
  // 用户提交答案（answered 置位）后此值变 null，卡片随之消失。
  const activeQuestion = useMemo(() => {
    const last = messages[messages.length - 1];
    if (!last || last.role !== "assistant") return null;
    const steps = last.steps;
    if (!Array.isArray(steps) || !steps.length) return null;
    const stepIdx = steps.length - 1;
    const step = steps[stepIdx];
    if (!step || !Array.isArray(step.ask) || !step.ask.length || step.answered) return null;
    return { messageIdx: messages.length - 1, stepIdx, questions: step.ask as UiQuestion[] };
  }, [messages]);
  // 输入框文字已移入独立组件 ChatComposer（打字时仅该组件重渲染，避免每次按键全量重渲整个界面）；
  // 父组件通过 composerRef 桥接 setText/appendText/sendNow，通过 onDraftSave 接收草稿变化。
  const composerRef = useRef<ChatComposerHandle | null>(null);
  // 场景建议「仅放入输入框」（sendOnClick=false）时的建议级提示词：
  // 点击时暂存，用户补充后手动发送（ChatComposer 提交）时随该次请求注入，注入后清空。
  const fillSuggestionPromptRef = useRef<string | null>(null);
  // 场景快捷问题按钮渲染（空态建议）
  const renderSuggestion = (s: SceneSuggestion) => (
    <SuggestionButton
      key={s.label}
      s={s}
      onSend={(label, prompt) => {
        fillSuggestionPromptRef.current = null; // 清除残留的 fill 提示词，避免串到下次手动发送
        void send(label, undefined, undefined, undefined, prompt);
      }}
      onFill={(label, prompt) => {
        fillSuggestionPromptRef.current = prompt?.trim() || null;
        composerRef.current?.setText(label);
        composerRef.current?.focus();
      }}
    />
  );
  const [attachments, setAttachments] = useState<UiAttachment[]>([]);
  const [composerReferences, setComposerReferences] = useState<Array<{ sourceId: string; reference: ComposerReference }>>([]);
  const [draftHydratedSid, setDraftHydratedSid] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<({
    id: string;
    name: string;
    size?: number;
    file: File;
    previewUrl?: string;
    progress: number;
  })[]>([]);
  const activeAttachments = [...attachments, ...pendingFiles];
  const cancelledUploadIdsRef = useRef(new Set<string>());
  const activeUploadIdRef = useRef<string | null>(null);
  // 附件是图片 + 当前模型疑似不支持图片时的提醒（仅提示不拦截；换模型/移除附件即清除）
  const [visionWarning, setVisionWarning] = useState<string | null>(null);
  // 切换模型时重算提醒（用户挂好图片后换模型，提醒要跟着变）
  useEffect(() => {
    if (attachments.some(isImageFile) && isLikelyNonVisionModel(selectedModelId, selectedModelSupportsImages)) {
      setVisionWarning(
        `当前模型「${selectedModelId}」可能不支持图片识别`,
      );
    } else if (visionWarning) {
      setVisionWarning(null);
    }
  }, [selectedModelId, selectedModelSupportsImages, attachments]);
  // 待发消息队列（当前会话）：回复生成中输入的不会发送，先排在这里；可点击"插话"立即插入当前轮
  const [pendingQueue, setPendingQueue] = useState<QueueItem[]>([]);
  // 防止同一条队列消息在插话请求卡住时被重复提交。
  const steerInFlightRef = useRef<Set<string>>(new Set());
  const [steerInFlight, setSteerInFlight] = useState<Set<string>>(new Set());
  // 队列区域的轻提示（非错误）：如点插话时当前轮已接近尾声（CLI 返回 idle），告知消息将自动发送
  const [queueNotice, setQueueNotice] = useState("");
  const queueNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 队列拖拽排序：记录正在拖拽的条目 id
  const queueDragRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  // busy 的 ref 镜像：看门狗计时器（setInterval 闭包）需要读取最新值，useState 在闭包里是旧的。
  const busyRef = useRef(false);
  // 正在运行中的会话集合（sid）：每个会话独立转圈，切走不杀旧流，后台仍在跑的会话也需在侧边栏显示转圈
  const runningSidsRef = useRef<Set<string>>(new Set());
  const [runningSids, setRunningSids] = useState<Set<string>>(() => new Set());
  const completedCardSidsRef = useRef<Set<string>>(new Set());
  const [completedCardSids, setCompletedCardSids] = useState<Set<string>>(() => new Set());
  // 运行中会话数上报给宿主（Dock 角标等）。回调走 ref：宿主多半传内联箭头函数，
  // 直接进依赖数组会导致每次渲染都触发一次上报。
  const runningReportRef = useRef(onRunningSessionsChange);
  runningReportRef.current = onRunningSessionsChange;
  useEffect(() => {
    runningReportRef.current?.(runningSids.size, [...runningSids]);
  }, [runningSids]);
  // 「已完成未查看」会话集合（sid）：在后台跑完、当前未查看的会话，时间位显示小绿圈；点进该会话即清除
  const unseenDoneSidsRef = useRef<Set<string>>(new Set());
  const [unseenDoneSids, setUnseenDoneSids] = useState<Set<string>>(() => new Set());
  // 「卡在提问环节、等待用户确认」的会话集合（sid）：该会话最后一条 AI 消息含有未回答的
  // AskUserQuestion 卡片（steps 末位 ask 存在且 answered 为空）。侧边栏会话条目据此显示「待确认」tag。
  const pendingQuestionSidsRef = useRef<Set<string>>(new Set());
  const [pendingQuestionSids, setPendingQuestionSids] = useState<Set<string>>(() => new Set());
  const [uploading, setUploading] = useState(false);
  const [sessionAuxErrors, setSessionAuxErrors] = useState<Record<string, string>>({});
  const setUploadError = (message: string) => setSessionAuxErrors((previous) => ({ ...previous, [activeSidRef.current]: message }));
  const uploadAbortRef = useRef<(() => void) | null>(null);
  const setVoiceError = (message: string) => setSessionAuxErrors((previous) => ({ ...previous, [activeSidRef.current]: message }));
  // 左栏底部用户区：点击头像/名字区域后，用户菜单（外观 segment + 退出登录）在其上方弹出（默认隐藏）
  const [userOpen, setUserOpen] = useState(false);
  // 用户菜单关闭：点菜单外任意处关闭。不渲染全屏 backdrop——透明 fixed 遮罩会拦截消息区滚轮，
  // 造成"菜单开着时鼠标悬停消息区无法滚动、要点一下才恢复"（WorkBuddy 悬停即可滚）。
  // 改用 document 级 pointerdown：滚轮事件穿透到消息区（原生滚动），点击菜单外仍可关闭。
  useClickOutside({
    enabled: userOpen,
    exceptSelectors: [".chat-user-menu", ".chat-sidebar-user-trigger"],
    onDismiss: () => setUserOpen(false),
  });
  // 主题：存储系统/浅色/深色三态；system 实时读取操作系统颜色偏好。
  const [theme, setTheme] = useState<ThemeMode>(readTheme);
  useEffect(() => { if (!themeManagedByHost) applyTheme(theme); }, [theme, themeManagedByHost]);
  // 界面显示偏好：模型可由宿主设置默认值，仅用户手动切换时持久化。
  const [showContextUsageState, setShowContextUsageState] = useState<boolean>(readShowContextUsage);
  const showContextUsage = controlledShowContextUsage ?? showContextUsageState;
  const setShowContextUsage: React.Dispatch<React.SetStateAction<boolean>> = (value) => {
    const next = typeof value === "function" ? value(showContextUsage) : value;
    if (controlledShowContextUsage !== undefined) { onShowContextUsageChange?.(next); return; }
    setShowContextUsageState(next);
    writeShowContextUsage(next);
  };
  const [showModelState, setShowModelState] = useState<boolean>(() => readShowModel(defaultShowModel));
  /**
   * 显示模型选择器：宿主传了 showModel 就完全受控（宿主设置里已经有这个开关，
   * 它必须能实时反映到输入框上）；否则沿用内部的 ui-prefs / localStorage。
   * 受控时 setShowModel 只回传，不写盘，避免两套记忆互相覆盖。
   */
  const showModel = controlledShowModel ?? showModelState;
  const setShowModel = (value: boolean) => {
    if (controlledShowModel !== undefined) { onShowModelChange?.(value); return; }
    setShowModelState(value);
    writeShowModel(value);
  };
  const [multiFramework, setMultiFramework] = useState<boolean>(readMultiFramework);
  const [rightCtrlVoicePreference, setRightCtrlVoiceState] = useState<boolean>(readRightCtrlVoice);
  const rightCtrlVoice = voiceHoldEnabled ?? rightCtrlVoicePreference;
  const setRightCtrlVoice = (value: boolean) => {
    setRightCtrlVoiceState(value);
    writeRightCtrlVoice(value);
  };
  useEffect(() => subscribeUiPrefs((key, value) => {
    if (key === SHOW_CONTEXT_USAGE_KEY) setShowContextUsageState(value ?? readShowContextUsage());
    if (key === SHOW_MODEL_KEY) setShowModelState(value ?? readShowModel(defaultShowModel));
    if (key === MULTI_FRAMEWORK_KEY) setMultiFramework(value ?? readMultiFramework());
    if (key === RIGHT_CTRL_VOICE_KEY) setRightCtrlVoiceState(value ?? readRightCtrlVoice());
  }), [defaultShowModel]);
  const [split, setSplit] = useState(false);
  const [compareOnly, setCompareOnly] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767.98px)");
    const syncViewport = () => {
      setIsMobileViewport(media.matches);
      if (media.matches) {
        setSplit(false);
        setCompareOnly(false);
        setCompareSubmission(null);
      }
    };
    syncViewport();
    media.addEventListener("change", syncViewport);
    return () => media.removeEventListener("change", syncViewport);
  }, []);
  const [compareMode, setCompareMode] = useState<"codebuddy" | "codex">("codex");
  const [compareModelKey, setCompareModelKey] = useState("__codex_default__");
  useEffect(() => { const modes = agentModes.filter((mode): mode is "codebuddy" | "codex" => mode !== "dsh"); if (modes.length && !modes.includes(compareMode)) setCompareMode(modes[0]); }, [agentModes, compareMode]);
  const [compareSubmission, setCompareSubmission] = useState<CompareSubmission | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareCancelSeq, setCompareCancelSeq] = useState(0);
  useEffect(() => { writeMultiFramework(multiFramework); if (!multiFramework || (agentModesLoaded && agentModes.length < 2)) { setSplit(false); setCompareOnly(false); setCompareSubmission(null); if (!multiFramework && agentModes.length) setAgentMode(agentModes[0]); } }, [multiFramework, agentModes, agentModesLoaded]);
  // 思考过程折叠状态：已展开的「消息下标:步下标」集合（null 表示全部收起）
  const [openThinking, setOpenThinking] = useState<Set<string>>(new Set());
  // 场景栏策略：空态（新建对话）显示全部场景供选择（含 sticky=false）；进入会话后
  // 仅当当前场景 sticky=true 时在场景栏显示该场景作为“我在此场景”指示，否则场景栏隐藏。
  const allScenes = scenes ?? [];
  const [scene, setScene] = useState<string | null>(allScenes[0]?.key ?? null); // 默认第一个场景
  // 多轮上下文续接：页面级会话 ID + 是否已建立会话标记。
  // 会话持久化（数据库）：登录用户的会话列表/消息由后端存 PostgreSQL（agent_sessions / agent_messages）。
  // 当前 sessionId 进入时先保持新生成的 UUID；发首条消息前注册到数据库，刷新后从会话列表恢复。
  const isLoggedIn = Boolean(initialUser?.unionId);
  const remoteAuthenticated = isLoggedIn && (!localGuest || cloudEnabled);
  // 启动加载锁：登录用户进入时先拉会话列表+最近会话历史，加载完前禁用输入框/显示 loading。
  const [booting, setBooting] = useState(isLoggedIn && !embeddedMode && !newChatOnMount);
  const [sessionsLoading, setSessionsLoading] = useState(isLoggedIn && !embeddedMode);
  const [sessionsLoadError, setSessionsLoadError] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [historyLoadError, setHistoryLoadError] = useState<string | null>(null);
  const sessionHistoryRequestRef = useRef(0);
  const sessionListRequestRef = useRef(0);
  // 解散成功后，忽略仍在途的列表请求中携带的旧会话快照。
  const endedSessionIdsRef = useRef<Set<string>>(new Set());
  const contentLoading = booting || loadingSessionId !== null;
  const [sessionId, setSessionId] = useState<string>(() => initialSidRef.current);
  useEffect(() => {
    const saved = localStorage.getItem(`agent-kit:compare-model:${sessionId}:${compareMode}`);
    setCompareModelKey(saved || (compareMode === "codex" ? "__codex_default__" : modelOptions[0] ? modelOptionKey(modelOptions[0]) : ""));
  }, [sessionId, compareMode, modelOptions]);
  useEffect(() => {
    const saved = localStorage.getItem(`agent-kit:codex-model:${sessionId}`);
    setSelectedCodexModel(saved && codexModelOptions.some((o) => modelOptionKey(o) === saved) ? saved : codexModelOptions[0]?.id || "__codex_default__");
  }, [sessionId, codexModelOptions]);
  const [agentMode, setAgentMode] = useState<"codebuddy" | "codex" | "cc" | "dsh">("codebuddy");
  useEffect(() => {
    if (!agentModes.length) return;
    const saved = readAgentMode(sessionId, agentModes);
    setAgentMode(embedded?.agentMode && agentModes.includes(embedded.agentMode) ? embedded.agentMode : readMultiFramework() && saved ? saved as "codebuddy" | "codex" | "dsh" : agentModes[0]);
  }, [sessionId, agentModes]);
  // 当前查看/对话的会话（切会话只切这个，不 abort 旧流——旧会话在后台继续跑）
  const [activeSid, setActiveSid] = useState<string>(sessionId);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const activeSidRef = useRef(sessionId);
  useEffect(() => { activeSidRef.current = activeSid; }, [activeSid]);
  /**
   * 本实例的唯一 id：跨实例运行态广播里用来忽略「自己发出的事件」。
   * 同一页面可能同时挂着多个 AgentWindow（宿主的隐藏发送器 + 真实聊天窗），
   * 它们共享模块级的运行态总线，只有来源不同才需要互相唤醒。
   */
  const runEventOriginRef = useRef<string>(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `run-${Math.random().toString(36).slice(2)}`,
  );
  /** 实例是否还挂着：接管 run 里有延时重试，卸载后不能再往死实例里灌消息。 */
  const aliveRef = useRef(true);
  /**
   * 宿主 UI 不可见（宿主把 Home 关掉/最小化后，实例仍挂着让会话在后台跑）。
   * 用 ref 是因为一轮对话的收尾发生在 send() 的异步 finally 里：那时读闭包里的 prop 还是
   * "点发送那一刻"的值（当时窗口是可见的），会漏掉"跑到一半才被关掉"的情况。
   */
  const readSuppressedRef = useRef(readSuppressed);
  readSuppressedRef.current = readSuppressed;
  // 切换会话时从数据库读回当前用户对该会话各消息的投票（点赞/点踩持久化，刷新页面也在）。
  useEffect(() => {
    if (!activeSid) return;
    let cancelled = false;
    fetch(`${basePath}/api/feedback?sessionId=${encodeURIComponent(activeSid)}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && data && data.votes) setMsgVotes(data.votes as Record<number, "up" | "down">); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeSid, basePath]);
  // 切会话时恢复该会话草稿（含附件 url/name）：文字经 composerRef 桥接进 ChatComposer，
  // 附件仍在父组件（attachment state 属于父组件，发送时由父组件组装）。
  useEffect(() => {
    for (const item of pendingFiles) cancelledUploadIdsRef.current.add(item.id);
    uploadAbortRef.current?.();
    setPendingFiles([]);
    const draft = readChatDraft(activeSid);
    composerRef.current?.setText(draft.text);
    setAttachments(draft.attachments);
    setComposerReferences(draft.references);
    setDraftHydratedSid(activeSid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSid]);
  // 草稿变化时写回当前会话 key：文字由 ChatComposer 防抖后回调 onDraftSave（父组件写 localStorage，
  // 含附件快照；不触发父组件 setState，避免打字时重渲父级）。防抖避免每次按键同步写 localStorage。
  const handleDraftSave = useCallback((text: string) => {
    saveChatDraft(activeSid, text, attachments, { references: composerReferences });
  }, [activeSid, attachments, composerReferences]);
  const flushDraft = () => {
    composerRef.current?.flushDraft();
  };
  /** 新建对话空态只选了 1 人且存在「真 1:1」会话时，返回该会话 id；否则 null。
   *  真 1:1 = memberCount===1 且从未成过群（coworkEverGroup=false）；群聊即使成员被移除到只剩 1 人也不复用。 */
  function findOneToOneReuse(pending: Array<{ contactId: string; name: string }>): string | null {
    if (pending.length !== 1) return null;
    const name = (pending[0]?.name || "").trim().toLowerCase();
    if (!name) return null;
    const existing = sessions.find(session =>
      session.memberCount === 1 && !session.coworkEverGroup && (session.peerName || "").trim().toLowerCase() === name);
    return existing?.id ?? null;
  }
  // 输入框发送桥接：ChatComposer 提交文字 → send(text)；附件仍由父组件状态（attachment）组装
  const handleSend = (text: string, voice?: UiVoiceRecording) => {
    if (uploading || uploadAbortRef.current) return;
    onHomeMessageSubmitted?.();
    if (homeGroupRecipients.length > 1 && !conversationMembers.length && !voice) {
      if (!text.trim() && !attachments.length) return;
      if (homeFanoutSendingRef.current) return;
      homeFanoutSendingRef.current = true;
      const recipients = [...homeGroupRecipients];
      const outgoing = attachments.map(({ url, name, fileId, size }) => ({ url, name, fileId, size }));
      setNewSessionNotice("正在分别发送…");
      void (async () => {
        const failures: typeof recipients = [];
        for (const recipient of recipients) {
          try {
            let sid = await resolveHomeContactSession?.(recipient.contactId);
            if (!sid) {
              sid = generateSessionId();
              const created = await apiFetch(`${basePath}/api/sessions`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ sessionId: sid, title: recipient.name, contactIds: [recipient.contactId] }),
              });
              if (!created.ok) throw new Error("创建单聊失败");
            }
            await realtimeClient(basePath).request(sid, "send", {
              content: text.trim(), title: recipient.name, clientMessageId: crypto.randomUUID(), attachments: outgoing,
            });
          } catch { failures.push(recipient); }
        }
        homeFanoutSendingRef.current = false;
        void refreshSessions();
        if (failures.length) {
          setHomeGroupRecipients(failures);
          setPendingMembers(failures);
          composerRef.current?.setText(text);
          saveChatDraft(activeSid, text, attachments);
          setNewSessionNotice(`发送失败：${failures.map(person => person.name).join("、")}。请重试`);
          return;
        }
        setNewSessionNotice(`已分别发送给 ${recipients.map(person => person.name).join("、")}`);
        setHomeGroupRecipients([]);
        setPendingMembers([]);
        clearAttachment();
        composerRef.current?.setText("");
        saveChatDraft(activeSid, "", []);
      })();
      return;
    }
    if (pendingMembers.length && !conversationMembers.length && !voice) {
      if (!text.trim() && !attachments.length) return;
      const oneToOneId = findOneToOneReuse(pendingMembers);
      setConversationView(true);
      if (homeContacts && pendingMembers.length === 1) onExistingPersonChatOpened?.();
      if (oneToOneId) {
        // 点发送才跳转：先切到已有 1:1（不建新会话），切换完成后再投递消息，
        // 避免占位会话的 CoworkPanel 抢先消费掉 initialSubmission。
        consumeAgentDraft();
        const toSendText = text;
        const toSendAtts = attachments;
        void (async () => {
          try {
            await switchSession(oneToOneId);
          } catch { /* 目标会话加载失败：回退为新建会话流程 */ }
          setCoworkSubmission({ text: toSendText, attachments: toSendAtts });
        })();
      } else {
        setCoworkSubmission({ text, attachments });
        if (readAgentLocation(navigationKeys)?.view === "new") {
          consumeAgentDraft();
          writeAgentLocation({ view: "session", sessionId: activeSid });
        }
      }
      return;
    }
    const submission = { id: Date.now() + Math.random(), sessionId: activeSid, text, attachments: attachments.map(({ url, name, fileId }) => ({ url, name, fileId })) };
    if (compareOnly && !voice) {
      setConversationView(true);
      if (readAgentLocation(navigationKeys)?.view === "new") {
        consumeAgentDraft();
        writeAgentLocation({ view: "session", sessionId: submission.sessionId });
      }
      clearAttachment();
      void (async () => {
        if (isLoggedIn) {
          try {
            await apiFetch(`${basePath}/api/sessions`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sessionId: submission.sessionId, title: text.trim().slice(0, 30) || "新任务", workspaceDir: localFiles ? null : workspaceDir || null, projectDir: localFiles ? workspaceDir : null, viewLayout: "compare" }),
            });
            void refreshSessions();
          } catch { /* 对比请求仍可继续 */ }
        }
        if (activeSidRef.current === submission.sessionId) setCompareSubmission(submission);
      })();
    } else {
      if (split) setCompareSubmission(submission);
      void send(text, undefined, undefined, voice, fillSuggestionPromptRef.current);
      fillSuggestionPromptRef.current = null;
    }
  };
  // 每个会话独立的运行时状态（messages/busy/abort/timer...），workbuddy 式：
  // 切走不杀旧流，旧会话在后台继续 SSE 推送；切回时能看到最新进展。
  const rtMapRef = useRef(new Map<string, RtState>());
  const getRt = (sid: string): RtState => {
    let rt = rtMapRef.current.get(sid);
    if (!rt) {
      rt = {
        messages: [],
        busy: false,
        queue: [], // 待发消息队列（回复生成中输入的）：{id, text, attachment, createdAt}
        abort: null,
        thinkingTimer: null,
        thinkingStart: null,
        stepStarts: new Map(),
        pendingAnswer: null,
        errorMsg: (() => {
          try { return window.localStorage.getItem(`agent-kit:run-failure:${sid}`); } catch { return null; }
        })(),
        runId: null,
        reconnectAttempt: 0,
        reconnectExhausted: false,
        viewedDuringRun: false,
        openThinking: new Set(),
        sessionStarted: false,
        sessionRegistered: false,
        // SDK transcript 用的 sessionId：正常 = sid；编辑重发时换新 UUID，让 SDK 不加载旧 transcript
        sdkSid: sid,
      };
      rtMapRef.current.set(sid, rt);
    }
    return rt;
  };
  // 判定会话是否「卡在提问环节」：只看最后一条消息——AskUserQuestion 卡片所在 AI 消息未结束时，
  // 它就是会话的最后一条消息（steps 末位为 ask 且未 answered）；用户提交答案后 answered 置位、
  // 新一轮发送时新消息追加/替换，判定随即解除。
  const hasPendingQuestion = (rt: RtState): boolean => {
    const last = rt.messages[rt.messages.length - 1];
    if (!last || last.role !== "assistant") return false;
    const steps = last.steps;
    if (!Array.isArray(steps) || !steps.length) return false;
    const lastStep = steps[steps.length - 1];
    return Boolean(lastStep && Array.isArray(lastStep.ask) && lastStep.ask.length > 0 && !lastStep.answered);
  };
  // 从 rtMap 全量重算「待确认」集合（单一事实来源 = 各会话的内存消息；仅在集合变化时 setState）
  const syncPendingQuestionSids = () => {
    const next = new Set<string>();
    for (const [sid, rt] of rtMapRef.current) {
      if (hasPendingQuestion(rt)) next.add(sid);
    }
    const prev = pendingQuestionSidsRef.current;
    if (next.size === prev.size && [...next].every((sid) => prev.has(sid))) return;
    pendingQuestionSidsRef.current = next;
    setPendingQuestionSids(next);
  };
  // 统一入口：切换某会话的 busy 态，并同步驱动侧边栏「转圈 / 小绿圈」所需的状态。
  // 只在状态真正翻转时更新（避免重复 setState）；后台会话的翻转也能即时反映到侧边栏。
  const markBusy = (sid: string, value: boolean) => {
    const rt = getRt(sid);
    if (rt.busy === value) return;
    rt.busy = value;
    const nextRun = new Set(runningSidsRef.current);
    if (value) nextRun.add(sid);
    else nextRun.delete(sid);
    runningSidsRef.current = nextRun;
    setRunningSids(nextRun);
    const nextCards = new Set(completedCardSidsRef.current);
    if (value) nextCards.delete(sid);
    else nextCards.add(sid);
    completedCardSidsRef.current = nextCards;
    setCompletedCardSids(nextCards);
    // 结束态：非当前查看的会话在后台跑完 → 标记「已完成未查看」（小绿圈）；
    //          当前查看的会话跑完 / 又开始跑 → 清除完成标记（该会话不会误显绿圈）。
    // 补充：本轮运行期间用户已查看过（viewedDuringRun，内容产出时在场）的会话，
    // 即使完成事件发生在切走之后，也不算「未查看」，不标绿圈——修复「读完输出切走后误显未读」。
    // readSuppressed（宿主 UI 不可见）：一律算未查看，视觉上表现为「完成后停在未读」。
    const nextDone = new Set(unseenDoneSidsRef.current);
    if (!value) {
      if (!readSuppressedRef.current && ((!backgroundMode && activeSidRef.current === sid) || rt.viewedDuringRun)) nextDone.delete(sid);
      else nextDone.add(sid);
    } else {
      nextDone.delete(sid);
    }
    unseenDoneSidsRef.current = nextDone;
    setUnseenDoneSids(nextDone);
  };
  // 切 activeSid 时把对应会话的 runtime 同步到渲染用的全局 state
  useEffect(() => {
    const rt = getRt(activeSid);
    setMessages(rt.messages);
    setBusy(rt.busy);
    setPendingQueue(rt.queue ? [...rt.queue] : []);
    setErrorMsg(rt.errorMsg);
    setReconnectAttempt(rt.reconnectAttempt ?? 0);
    setOpenThinking(rt.openThinking);
    // 切进正在运行的会话：用户已处于该会话页，本轮后续完成不应再标「已完成未查看」绿圈。
    // （发送后立刻切走、内容到达时不在场的会话不置位——applyUpdate 只在在场时标记。）
    // readSuppressed（宿主 UI 不可见）时不置位：看不见就不算已查看。
    if (rt.busy && !readSuppressedRef.current) rt.viewedDuringRun = true;
    // 切会话时清掉「正在编辑的消息」状态：editingIdx 是消息数组下标，若不重置会指向
    // 新会话的同一下标消息，导致在新会话里误入编辑态（bug：跨会话编辑态残留）。
    setEditingIdx(null);
    setEditingText("");
    setEditingWidth(null);
    // 折叠态兜底：按当前会话消息重建（有 steps 的助手消息默认折叠）。
    // 防止「切走后该会话后台完成」时 finally 自动折叠污染其他会话的 index。
    setFoldedProcess(
      new Set(
        rt.messages.flatMap((m, idx) =>
          m.role === "assistant" && Array.isArray(m.steps) && m.steps.length > 0 ? [idx] : [],
        ),
      ),
    );
  }, [activeSid]);
  // 侧边栏会话列表（登录用户）。左/右栏展开状态持久化到 localStorage，刷新后保持
  // 首次运行（无保存记录）默认展开；之后按用户选择持久化
  /** 程序化收起左右面板（closePanelsOnNewChat）的时间窗：窗内不写全局偏好，
   *  否则「只是划过 Home 悬停输入框」也会把用户上次的面板偏好改成收起。
   *  用时间窗而非一次性布尔，是因为 React StrictMode 在 dev 会把 mount effect 跑两遍。 */
  const panelPersistSkipUntilRef = useRef(
    closePanelsOnNewChat || openSidebarOnMount ? Date.now() + 500 : 0,
  );
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => {
    if (openSidebarOnMount) return true;
    if (closePanelsOnNewChat) return false;
    if (typeof localStorage === "undefined") return true;
    const saved = localStorage.getItem("agent-kit:sidebar-left");
    return saved === null ? true : saved === "1";
  });
  // 收起时鼠标悬浮顶栏按钮：侧边栏以悬浮面板形式出现（方便切换会话）。仅桌面（可悬停）设备生效。
  const [sidebarHover, setSidebarHover] = useState(false);
  const sidebarHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sidebarHoverSuppressedUntil = useRef(0);
  const canHoverSidebar = () =>
    typeof window !== "undefined" && window.matchMedia("(min-width: 768px) and (hover: hover) and (pointer: fine)").matches;
  function clearSidebarHoverTimer() {
    if (sidebarHoverTimer.current) { clearTimeout(sidebarHoverTimer.current); sidebarHoverTimer.current = null; }
  }
  function openSidebarHover() {
    if (!canHoverSidebar()) return;
    // local 顶栏在侧栏收起时会重新让出原生窗口按钮区域；侧栏宽度动画经过鼠标下方
    // 会额外触发一次 mouseenter。忽略这次事件，避免悬浮侧栏闪现。
    if (IS_ELECTRON && Date.now() < sidebarHoverSuppressedUntil.current) return;
    clearSidebarHoverTimer();
    setSidebarHover(true);
  }
  function toggleSidebar() {
    if (IS_ELECTRON && sidebarOpen) sidebarHoverSuppressedUntil.current = Date.now() + 350;
    clearSidebarHoverTimer();
    setSidebarHover(false);
    setSidebarOpen((open) => !open);
  }
  function leaveSidebarHover() {
    closeSidebarHover();
  }
  function closeSidebarHover() {
    if (!canHoverSidebar()) return;
    clearSidebarHoverTimer();
    // 延迟隐藏，给用户时间从按钮移向侧边栏
    sidebarHoverTimer.current = setTimeout(() => setSidebarHover(false), 180);
  }
  // 卸载时清理悬浮隐藏定时器，避免在已卸载组件上 setState
  useEffect(() => () => clearSidebarHoverTimer(), []);
  // 豆包 Work 式过程折叠：每条助手消息一个折叠位（key = messages 数组 index）。
  // 流式完成自动折叠该消息 → 过程收进顶部「已完成 用时 · N次工具」卡片；点击卡片展开/收起。
  // 切换会话时按该会话历史重建（历史消息默认全折叠）。
  const [foldedProcess, setFoldedProcess] = useState<Set<number>>(new Set());
  useEffect(() => {
    if (embeddedMode) return;
    if (Date.now() < panelPersistSkipUntilRef.current) return;
    try { localStorage.setItem("agent-kit:sidebar-left", sidebarOpen ? "1" : "0"); } catch { /* 隐私模式等场景忽略 */ }
  }, [sidebarOpen, embeddedMode]);
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // 桌面会话目录：手动组需要保留已读会话；进行中组件按状态筛选。
  const sessionSnapshotsReportRef = useRef(onSessionSnapshotsChange);
  sessionSnapshotsReportRef.current = onSessionSnapshotsChange;
  useEffect(() => {
    const report = sessionSnapshotsReportRef.current;
    if (!report) return;
    const byId = new Map(sessions.map((item) => [item.id, item]));
    const cards: SessionCardSnapshot[] = [];
    for (const sid of new Set([...runningSids, ...unseenDoneSids, ...sessions.map((item) => item.id)])) {
      const item = byId.get(sid);
      const rt = rtMapRef.current.get(sid);
      const last = rt?.messages[rt.messages.length - 1];
      const lastReply = [...(rt?.messages ?? [])].reverse().find((message) => message.role === "assistant" && message.content?.trim());
      const lastText = lastReply?.content || item?.lastAssistantText || "";
      const runningTool = [...(last?.steps ?? [])].reverse().find((step) => step.tool?.status === "running")?.tool;
      cards.push({
        sessionId: sid,
        title: item?.title || last?.content?.slice(0, 24) || "新会话",
        lastText,
        history: (rt?.messages ?? []).filter((message) => message.content?.trim()).map((message) => ({ role: message.role, content: message.content })),
        progress: pendingQuestionSids.has(sid) ? "等待确认" : runningTool ? `正在使用 ${runningTool.name}` : runningSids.has(sid) ? "正在生成回复" : undefined,
        model: item?.modelId || (runningSids.has(sid) ? selectedModelId : ""),
        status: runningSids.has(sid) ? pendingQuestionSids.has(sid) ? "waiting" : "running" : unseenDoneSids.has(sid) || item?.aiUnread ? "done" : "idle",
        updatedAt: item?.updatedAt ?? null,
        active: !backgroundMode && sid === activeSid,
      });
    }
    report(cards);
    // 会话目录和运行态变化都要重建：新会话、标题刷新、待确认、完成未读等。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningSids, unseenDoneSids, sessions, pendingQuestionSids, selectedModelId, activeSid, messages]);

  /**
   * 接管「同一个会话正在别的实例里跑」的那一轮。
   *
   * 场景：桌面宿主把文件拖到会话卡片上，真正发消息的是隐藏实例（自己的 rt）。
   * 用户随后点开同一个会话，真实聊天窗的 rt 里只有落盘历史（用户消息），答复一个字节都没有——
   * 桌面卡片却一直在滚（它读的是隐藏实例的快照）。所以这里沿着 send() 里已有的
   * 「刷新页面接管 run」通道（/chat/run 重放，after=0），把这轮从头补上并继续跟实时流。
   * 接管前必须确保 rt 末尾是这一轮的用户消息，否则 replay 会接在一条已有答复后面（重复一轮）。
   */
  async function attachExternalRun(sid: string, attempt = 0) {
    if (!aliveRef.current) return;
    const rt = getRt(sid);
    if (rt.busy || activeSidRef.current !== sid) return;
    const record = readActiveRunRecord(sid);
    if (!record) return; // 这一轮已经结束（或不是本机 run）：等 end 事件重读历史即可
    if (!rt.messages.length || rt.messages[rt.messages.length - 1]?.role !== "user") {
      let history: UiMessage[] | null = null;
      try { history = await localChatMessages(localOwner, sid); } catch { return; }
      const next = trimEmptyAssistantTail(history ?? rt.messages);
      if (!next.length || next[next.length - 1]?.role !== "user") {
        // 落盘还没跟上（旁观实例可能比本轮的首次保存更早收到通知）：短暂重试几次，
        // 还没等到就交给 end 事件兜底，不做无谓的轮询。
        if (attempt < 4) window.setTimeout(() => { void attachExternalRun(sid, attempt + 1); }, 200);
        return;
      }
      rt.messages = next;
      if (activeSidRef.current === sid) setMessages([...next]);
    }
    void send(undefined, null, { sid, ...record });
  }

  /**
   * 重读某会话的落盘历史（本机会话）。
   *
   * 用途：另一个实例把这一轮跑完了，正在看这个会话的窗口要立刻看到最终答复——
   * 不然要手动切走再切回来（重进会话）才会刷新。只在本实例没在跑、且确实有差异时才覆盖，
   * 避免把正在流式写入的内容冲掉，也避免无意义的重渲染。
   */
  async function reloadSessionFromStore(sid: string) {
    if (!aliveRef.current) return;
    if (!localChat) return;
    const rt = getRt(sid);
    if (rt.busy) return;
    if (!isAiOnlyChat(sessionsRef.current.find((item) => item.id === sid))) return;
    let history: UiMessage[] | null = null;
    try { history = await localChatMessages(localOwner, sid); } catch { return; }
    const next = trimEmptyAssistantTail(history ?? []);
    if (!next.length) return;
    const same = next.length === rt.messages.length
      && next.every((message, index) => message.role === rt.messages[index]?.role && (message.content ?? "") === (rt.messages[index]?.content ?? ""));
    if (same) return;
    rt.messages = next;
    rt.openThinking = new Set();
    syncPendingQuestionSids();
    if (activeSidRef.current === sid) {
      setMessages([...rt.messages]);
      // 与切会话一致：历史里有正文的助手消息默认折叠过程。
      const folded = new Set<number>();
      rt.messages.forEach((message, index) => {
        if (message.role === "assistant" && Array.isArray(message.steps) && message.steps.length > 0 && (message.content || "").trim()) folded.add(index);
      });
      setFoldedProcess(folded);
    }
    // 窗口看得见就算已读：否则桌面卡片会停在「已完成未读」，而这轮答复明明已经摆在眼前。
    if (!readSuppressedRef.current && activeSidRef.current === sid) {
      setSessions((list) => list.map((item) => (item.id === sid ? { ...item, aiUnread: false } : item)));
      void localChatPatch(localOwner, sid, { aiUnread: false });
    }
    void refreshSessions();
  }

  /**
   * 会话运行态广播（见 chat/runBus.ts）：同页面里别的 AgentWindow 实例跑某个会话时，
   * 正在看这个会话的窗口跟上去，保证「桌面卡片」和「聊天窗」看到的是同一轮答复。
   *  · start → 接管那条 run（从头重放 + 继续实时），实现流式同步；
   *  · end   → 重读落盘历史，把最终答复补齐（宿主不可见时只走这条，不做无用的实时接管）。
   */
  useEffect(() => {
    aliveRef.current = true;
    if (backgroundMode || embeddedMode) return () => { aliveRef.current = false; };
    const unsubscribe = subscribeRunEvents((event) => {
      if (event.origin === runEventOriginRef.current) return;
      if (event.sessionId !== activeSidRef.current) return;
      const sid = event.sessionId;
      if (event.type === "start") {
        if (readSuppressedRef.current) return; // 窗口不可见：不接管流，等 end 补历史
        void attachExternalRun(sid);
        return;
      }
      void reloadSessionFromStore(sid);
    });
    return () => { aliveRef.current = false; unsubscribe(); };
    // 只订阅一次：事件处理读的都是 ref / 闭包内的稳定引用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundMode, embeddedMode]);
  /** 已处理的宿主会话跳转 nonce：保证同一通知重复渲染只跳一次。 */
  const handledSessionRequestRef = useRef(0);
  const handledMentionRequestRef = useRef(0);
  useEffect(() => {
    if (localChat || !localFiles || !isLoggedIn) return;
    const persist = () => {
      for (const session of sessionsRef.current) {
        if (!session.workspaceDir || !localProjectMessages(initialUser.unionId || "", session.id)) continue;
        const live = rtMapRef.current.get(session.id)?.messages;
        saveLocalProjectSession(initialUser.unionId || "", session, live?.length ? live : localProjectMessages(initialUser.unionId || "", session.id) || []);
      }
    };
    const timer = window.setInterval(persist, 2000);
    window.addEventListener("pagehide", persist);
    return () => { persist(); window.clearInterval(timer); window.removeEventListener("pagehide", persist); };
  }, [localFiles, isLoggedIn, initialUser.unionId]);
  const initialSessionsLoadedRef = useRef(false);
  const [newSessionNotice, setNewSessionNotice] = useState<string | null>(null);
  const newSessionNoticeTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (newSessionNoticeTimerRef.current !== null) window.clearTimeout(newSessionNoticeTimerRef.current);
  }, []);
  useEffect(() => {
    if (!remoteAuthenticated || embeddedMode || isDesktopApp()) return;
    const removeProbe = installPushProbe(basePath);
    void syncNotificationSoundForPush(basePath);
    const onPushSound = (event: MessageEvent) => {
      if (event.data?.type === "agent-notification-sound" && typeof event.data.tag === "string")
        playNotificationSound(basePath, event.data.tag);
    };
    navigator.serviceWorker?.addEventListener("message", onPushSound);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") void ensureWebPushSubscription(basePath);
    return () => { removeProbe(); navigator.serviceWorker?.removeEventListener("message", onPushSound); };
  }, [basePath, isLoggedIn, embeddedMode]);
  useEffect(() => {
    if (!remoteAuthenticated || embeddedMode || isDesktopApp() || isDingTalkNotificationWebView()
      || typeof Notification === "undefined" || Notification.permission !== "default") return;
    // 接收方可能从未发送消息；在其首次操作页面时申请权限并建立推送订阅。
    const request = () => {
      document.removeEventListener("pointerdown", request, true);
      void Notification.requestPermission().then(permission => {
        if (permission === "granted") void ensureWebPushSubscription(basePath);
      }).catch(() => {});
    };
    document.addEventListener("pointerdown", request, true);
    return () => document.removeEventListener("pointerdown", request, true);
  }, [basePath, isLoggedIn, embeddedMode]);
  const selfSub = initialUser?.provider && initialUser?.unionId ? `${initialUser.provider}:${initialUser.unionId}` : "";
  const notifiedMessageIdsRef = useRef(new Map<string, number>());
  const groupChannelIds = sessions.filter(item => (item.memberCount ?? 0) > 0).map(item => item.id).join("\u0000");
  useEffect(() => {
    if (!remoteAuthenticated || embeddedMode || !groupChannelIds) return;
    const client = realtimeClient(basePath);
    const unsubscribe = groupChannelIds.split("\u0000").map(channel => client.subscribe(channel, {
      onEvent: frame => {
        if (frame.event !== "message") return;
        const message = frame.data.message as { id?: number; role?: string; content?: string; attachment?: unknown; senderSub?: string; senderName?: string; createdAt?: string } | undefined;
        if (!message?.id) return;
        const name = message.role === "assistant" ? "Agent" : message.senderName || "成员";
        // 有人参与的会话第二行只显示人输入的：新用户消息同步覆盖 lastQuestionPreview，
        // AI 回复不动它，避免列表第二行被 Agent 的输出顶掉。
        // 系统消息（role='system'，群事件）覆盖 lastQuestionPreview 保留为最近消息，但发送者置空——
        // 其 content 已自带操作者名（"xx 将 a、b、c 移除了群组"），避免前缀重复（与后端 SQL 口径一致）。
        const preview = messagePreviewText(message.content, message.attachment);
        // 正在查看该会话（活动 + 页面聚焦可见）时新消息视为已读：[有人@了你] 只对未读消息显示
        const viewing = channel === activeSid && !document.hidden && document.hasFocus();
        setSessions(list => list.map(item => item.id === channel ? { ...item,
          lastPreview: preview || "[附件]", lastSenderName: message.role === "system" ? "" : name,
          ...(message.role === "assistant" ? null : { lastQuestionPreview: preview || "[附件]", lastQuestionSenderName: message.role === "system" ? "" : name,
            lastMentionedMe: viewing ? false : (computeLastMentionedMe(message, selfSub, initialUser?.name ?? "") ?? item.lastMentionedMe) }),
          ...(message.role === "user" ? { lastUserPreview: preview || "[附件]" } : null),
          updatedAt: message.createdAt || new Date().toISOString() } : item));
      },
    }));
    return () => unsubscribe.forEach(stop => stop());
  // Reattach only when the set of group channels or selected session changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, groupChannelIds, activeSid, selfSub, isLoggedIn, embeddedMode]);
  const [conversationMembers, setConversationMembers] = useState<Array<{ provider: string; contactId: string; name: string; avatar: string; sub?: string }>>([]);
  const [conversationOwnerSub, setConversationOwnerSub] = useState("");
  // 连接状态：连不上服务器（断网等网络层失败）时顶栏显示警示横幅；任意请求成功送达即恢复
  const [serverOnline, setServerOnline] = useState(() => isServerOnline());
  // 通道明细：区分 HTTP / 实时连接（WS）哪一半不通，用于横幅文案
  const [connDetail, setConnDetail] = useState<{ http: boolean; ws: boolean }>(() => getConnectionState());
  useEffect(() => subscribeConnection((online) => {
    setServerOnline(online);
    setConnDetail(getConnectionState());
  }), []);
  // 横幅「重试」按钮的进行中态
  const [retrying, setRetrying] = useState(false);
  // 离线期间每 8s 双通道探测：HTTP 探健康端点 + 强制触发 WS 重连。
  // 两个都恢复后（apiFetch 上报成功 / realtime 上报已连接）→ 横幅自动消失。
  // 在线时不轮询；任何业务请求的成功送达也会立刻恢复横幅，两者互补。
  useEffect(() => {
    if (serverOnline) return;
    const timer = window.setInterval(() => {
      apiFetch(`${basePath}/api/health`, { cache: "no-store" }).catch(() => {});
      realtimeClient(basePath).retryNow();
    }, 8_000);
    return () => window.clearInterval(timer);
  }, [serverOnline, basePath]);
  // 手动重试：同时验证 HTTP 与 WS 两条通道；任一仍不通则横幅保留
  const retryConnection = () => {
    if (retrying) return;
    setRetrying(true);
    apiFetch(`${basePath}/api/health`, { cache: "no-store" }).catch(() => {});
    realtimeClient(basePath).retryNow();
    // fetch 在断网时会挂起较久，按钮反馈用固定时长复位，避免一直显示"重试中…"
    window.setTimeout(() => setRetrying(false), 1500);
  };
  const [inviteOpen, setInviteOpen] = useState(false);
  // 弹窗模式：empty=新建任务空态选人（确认仅记内存，发送时才建会话）；session=已有会话内邀请（确认即写入成员）
  const [inviteMode, setInviteMode] = useState<"empty" | "session">("session");
  // 新建任务空态「新建」确认后的待发送成员：仅内存暂存，发送首轮消息时随会话注册一并落库
  const [pendingMembers, setPendingMembers] = useState<Array<{ provider?: string; contactId: string; name: string; avatar: string }>>([]);
  const [homeGroupRecipients, setHomeGroupRecipients] = useState<typeof pendingMembers>([]);
  const homeFanoutSendingRef = useRef(false);
  const homeMentionKeyRef = useRef("");
  const homeMentionRequestRef = useRef(0);
  const homeSelectedGroupRef = useRef<{ id: string; name: string } | null>(null);
  const homeRoutedNamesRef = useRef<string[] | null>(null);
  const homeSelectedContactsRef = useRef<Array<{ id: string; name: string; avatar?: string }>>([]);
  const [homeSelectedChips, setHomeSelectedChips] = useState<Array<{ id: string; name: string; avatar: string }>>([]);
  const homeMentionGroups = useMemo(() => sessions.filter(session =>
    (session.memberCount ?? 0) > 1 || session.coworkEverGroup).map(session => ({ id: session.id, name: session.title })), [sessions]);
  const homeMentionInputActive = Boolean(homeContacts && !conversationMembers.length &&
    (!conversationView || readAgentLocation(navigationKeys)?.view === "new" || pendingMembers.length > 0 || homeGroupRecipients.length > 0));
  const [homeMentionFilter, setHomeMentionFilter] = useState<"all" | "contacts" | "groups">("all");
  // 新建对话空态：@ 候选只包含联系人和已有群聊，普通文字直接发给 AI。
  const pendingMentionCandidates = useMemo<MentionCandidate[]>(
    () => homeMentionInputActive
      ? [...(homeMentionFilter !== "groups" ? (homeContacts ?? []).map(person => ({ id: person.id, name: person.name, avatar: person.avatar || "" })) : []),
          ...(homeMentionFilter !== "contacts" ? homeMentionGroups.map(group => ({ id: `group:${group.id}`, name: group.name, avatar: "" })) : [])]
      : pendingMembers.map(member => ({ id: member.contactId, name: member.name, avatar: member.avatar })),
    [pendingMembers, homeContacts, homeMentionGroups, homeMentionInputActive, homeMentionFilter],
  );
  const {
    mentionActive: pendingMentionActive,
    visibleMentionOptions: pendingMentionOptions,
    mentionIndex: pendingMentionIndex,
    setMentionIndex: setPendingMentionIndex,
    mentionRefs: pendingMentionRefs,
    chooseMention: choosePendingMention,
    consumeMention: consumePendingMention,
    onValueChange: onPendingValueChange,
    onEnter: onPendingEnter,
    onKeyDownIntercept: onPendingKeyDownIntercept,
  } = useAtMention(composerRef, pendingMentionCandidates);
  const syncHomeMentions = (draft: string, caret: number, selected = homeSelectedContactsRef.current, selectedGroup = homeSelectedGroupRef.current, transferredAttachments = attachments) => {
    const key = selectedGroup ? `group:${selectedGroup.id}` : selected.map(person => person.id).sort().join(",");
    if (key === homeMentionKeyRef.current) return;
    homeMentionKeyRef.current = key;
    const request = ++homeMentionRequestRef.current;
    const transferred = { text: draft, caret, attachments: [...transferredAttachments] };
    if (!selected.length && !selectedGroup) {
      if (homeGroupRecipients.length || conversationMembers.length || pendingMembers.length || homeRoutedNamesRef.current) {
        const previousSid = activeSid;
        const sid = newSession(false);
        saveChatDraft(previousSid, "", []);
        saveChatDraft(sid, draft, transferred.attachments);
        requestAnimationFrame(() => composerRef.current?.setText(draft, caret));
        setHomeGroupRecipients([]);
        setHomeSelectedChips([]);
        onHomeMentionCleared?.();
        return true;
      }
      return;
    }
    if (selectedGroup && !selected.length) {
      setHomeGroupRecipients([]);
      saveChatDraft(selectedGroup.id, draft, transferred.attachments);
      setTransferredDraftCaret({ sid: selectedGroup.id, caret });
      void switchSession(selectedGroup.id);
      homeSelectedGroupRef.current = selectedGroup;
      setHomeSelectedChips([{ id: `group:${selectedGroup.id}`, name: selectedGroup.name, avatar: "" }]);
      homeRoutedNamesRef.current = [selectedGroup.name];
      homeMentionKeyRef.current = key;
      onExistingPersonChatOpened?.();
      return;
    }
    const members = selected.map(person => ({ provider: "builtin", contactId: person.id, name: person.name, avatar: person.avatar || "" }));
    if (selected.length === 1) {
      setHomeGroupRecipients([]);
      void resolveHomeContactSession?.(selected[0].id).then(async candidateId => {
        let sessionId = candidateId;
        if (sessionId) {
          const history = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/messages`, { cache: "no-store" });
          const data = history.ok ? await history.json().catch(() => null) as { messages?: Array<{ role?: string }> } | null : null;
          if (!data?.messages?.some(message => message.role === "user")) sessionId = null;
        }
        if (request !== homeMentionRequestRef.current) return;
        openPersonChat({ ...selected[0], avatar: selected[0].avatar || "", provider: "builtin", department: "", title: "", email: "", sessionId }, transferred);
        homeSelectedContactsRef.current = selected;
        setHomeSelectedChips(selected.map(person => ({ id: person.id, name: person.name, avatar: person.avatar || "" })));
        if (sessionId) homeRoutedNamesRef.current = [selected[0].name];
        if (sessionId) homeMentionKeyRef.current = key;
        if (sessionId) onExistingPersonChatOpened?.();
      }).catch(() => setNewSessionNotice("联系人会话查询失败，请重试"));
      return;
    }
    void resolveHomeGroupSession?.(selected.map(person => person.id)).then(sessionId => {
      if (request !== homeMentionRequestRef.current) return;
      if (sessionId) {
        setHomeGroupRecipients([]);
        saveChatDraft(sessionId, draft, transferred.attachments);
        setTransferredDraftCaret({ sid: sessionId, caret });
        void switchSession(sessionId);
        homeSelectedContactsRef.current = selected;
        setHomeSelectedChips(selected.map(person => ({ id: person.id, name: person.name, avatar: person.avatar || "" })));
        homeRoutedNamesRef.current = selected.map(person => person.name);
        homeMentionKeyRef.current = key;
      } else {
        const sid = newSession();
        saveChatDraft(sid, draft, transferred.attachments);
        setPendingMembers(members);
        setHomeGroupRecipients(members);
        homeSelectedContactsRef.current = selected;
        setHomeSelectedChips(selected.map(person => ({ id: person.id, name: person.name, avatar: person.avatar || "" })));
        homeMentionKeyRef.current = key;
        requestAnimationFrame(() => composerRef.current?.setText(draft, caret));
      }
      onExistingPersonChatOpened?.();
    }).catch(() => { setNewSessionNotice(null); });
  };
  const removeHomeRecipient = (id: string, currentDraft?: string, currentCaret?: number, currentAttachments?: UiAttachment[]) => {
    const selected = homeSelectedContactsRef.current.filter(person => person.id !== id);
    const group = homeSelectedGroupRef.current?.id === id.slice(6) ? null : homeSelectedGroupRef.current;
    homeSelectedContactsRef.current = selected;
    homeSelectedGroupRef.current = group;
    setHomeSelectedChips(group ? [{ id: `group:${group.id}`, name: group.name, avatar: "" }]
      : selected.map(person => ({ id: person.id, name: person.name, avatar: person.avatar || "" })));
    const draft = currentDraft ?? composerRef.current?.getText() ?? readChatDraft(activeSid).text;
    syncHomeMentions(draft, currentCaret ?? draft.length, selected, group, currentAttachments ?? attachments);
  };
  const selectPendingMention = (name: string, id?: string) => {
    const group = id?.startsWith("group:") ? homeMentionGroups.find(item => item.id === id.slice(6)) : null;
    if (group) {
      const completed = consumePendingMention();
      homeSelectedGroupRef.current = group;
      homeSelectedContactsRef.current = [];
      setHomeSelectedChips([{ id: `group:${group.id}`, name: group.name, avatar: "" }]);
      syncHomeMentions(completed?.text ?? composerRef.current?.getText() ?? "", completed?.caret ?? 0, [], group);
      return;
    }
    const person = homeContacts?.find(item => id ? item.id === id : item.name === name);
    if (!person) { choosePendingMention(name); return; }
    const completed = consumePendingMention();
    const draft = completed?.text ?? composerRef.current?.getText() ?? "";
    const caret = completed?.caret ?? draft.length;
    homeSelectedGroupRef.current = null;
    const selected = [...homeSelectedContactsRef.current.filter(item => item.id !== person.id), person];
    homeSelectedContactsRef.current = selected;
    setHomeSelectedChips(selected.map(item => ({ id: item.id, name: item.name, avatar: item.avatar || "" })));
    syncHomeMentions(draft, caret, selected, null);
  };
  const selectPendingEnter = () => {
    if (homeContacts && pendingMentionOptions.length) {
      const candidate = pendingMentionOptions[pendingMentionIndex] || pendingMentionOptions[0];
      selectPendingMention(candidate.name, candidate.id);
      return true;
    }
    return onPendingEnter();
  };
  const selectPendingKeyDown = (key: string) => {
    if (homeContacts && key === "Tab" && pendingMentionOptions.length) {
      const candidate = pendingMentionOptions[pendingMentionIndex] || pendingMentionOptions[0];
      selectPendingMention(candidate.name, candidate.id);
      return true;
    }
    return onPendingKeyDownIntercept(key);
  };
  const [coworkSubmission, setCoworkSubmission] = useState<{ text: string; attachments: UiAttachment[] } | null>(null);
  const [transferredDraftCaret, setTransferredDraftCaret] = useState<{ sid: string; caret: number } | null>(null);
  const pendingMembersRef = useRef<HTMLDivElement>(null);
  const [pendingMembersWidth, setPendingMembersWidth] = useState(0);
  useLayoutEffect(() => {
    const element = pendingMembersRef.current;
    if (!element) return;
    const measure = () => setPendingMembersWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [pendingMembers.length > 0]);
  // 头像项 52px、间距 12px；溢出时为带编辑图标的「共 X 人」预留 88px。
  const pendingMemberSlots = pendingMembersWidth
    ? Math.max(0, Math.floor((pendingMembersWidth - 24 + 12) / 64))
    : pendingMembers.length;
  const visiblePendingMembers = pendingMembers.length <= pendingMemberSlots
    ? pendingMembers.length
    : Math.max(0, Math.floor((pendingMembersWidth - 24 - 88) / 64));
  const [inviteLoading, setInviteLoading] = useState(false);
  // session 模式确认（邀请）失败提示：显示在弹窗 footer 上方
  const [inviteActionError, setInviteErrorText] = useState("");
  // 邀请弹窗只向服务端搜索，不下载全量通讯录。
  const [inviteQuery, setInviteQuery] = useState("");
  const [debouncedInviteQuery, setDebouncedInviteQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedInviteQuery(inviteQuery), 250);
    return () => window.clearTimeout(timer);
  }, [inviteQuery]);
  const { contacts: inviteContacts, loading: contactsLoading, error: contactsError, reload: reloadContacts } = useContacts(basePath, { enabled: inviteOpen, search: true, query: debouncedInviteQuery, provider: initialUser?.provider === "builtin" ? "builtin" : initialUser?.provider === "feishu" ? "feishu" : initialUser?.provider === "dingtalk" ? "dingtalk" : undefined });
  const inviteContactDetails = useRef(new Map<string, (typeof inviteContacts)[number]>());
  for (const contact of inviteContacts) inviteContactDetails.current.set(contact.id, contact);
  /** 打开联系人选择弹窗：按当前视图决定模式——
   *  新建任务空态（empty）：确认按钮为「确认」，只记内存不建会话；
   *  已有会话（session）：确认按钮为「邀请」，确认即写入会话成员。 */
  function openInvite() {
    // 搜索词与防抖值都要清：只清 inviteQuery 的话，debouncedInviteQuery 仍是上一次的词，
    // useContacts 的 cacheKey 不变 -> 旧结果会先渲染一帧（可见的「闪一下」）。
    // 防抖 effect 挂在 inviteQuery 上，清空后它会在 250ms 后再把值置成 ""（幂等，无害）。
    setInviteQuery("");
    setDebouncedInviteQuery("");
    const empty = isEmptyView && conversationMembers.length === 0;
    setInviteMode(empty ? "empty" : "session");
    if (initialUser?.provider === "dingtalk" && isInDingTalk()) {
      void chooseDingTalkContacts(empty ? "empty" : "session");
      return;
    }
    setInviteOpen(true);
  }
  async function chooseDingTalkContacts(mode: "empty" | "session") {
    try {
      await loadScript(DD_SDK_URL);
      const signed = await fetchJsapiSign();
      const dd = (window as unknown as { dd?: {
        config?: (options: Record<string, unknown>) => void;
        ready?: (callback: () => void) => void;
        error?: (callback: (error: unknown) => void) => void;
        biz?: { contact?: { complexPicker?: (options: Record<string, unknown>) => void } };
      } }).dd;
      if (!dd?.config || !dd.ready || !dd.biz?.contact?.complexPicker) throw new Error("当前钉钉客户端不支持原生选人");
      const cfg = signed.config;
      await new Promise<void>((resolve, reject) => {
        dd.error?.(error => reject(new Error(`钉钉鉴权失败：${String(error)}`)));
        dd.ready?.(resolve);
        dd.config?.({ agentId: cfg.agentId, corpId: cfg.corpId, timeStamp: cfg.timeStamp, nonceStr: cfg.nonceStr, signature: cfg.signature, jsApiList: ["biz.contact.complexPicker"] });
      });
      const result = await new Promise<{ users?: Array<{ emplId?: string; userId?: string; name?: string; avatar?: string }> }>((resolve, reject) => {
        dd.biz?.contact?.complexPicker?.({
          title: mode === "empty" ? "选择联系人" : "邀请成员加入会话",
          corpId: cfg.corpId,
          multiple: true,
          maxUsers: 100,
          pickedUsers: mode === "empty" ? pendingMembers.map(member => member.contactId) : [],
          disabledUsers: mode === "session" ? conversationMembers.map(member => member.contactId) : [],
          pickedDepartments: [], disabledDepartments: [], requiredUsers: [], requiredDepartments: [],
          responseUserOnly: true,
          onSuccess: resolve,
          onFail: reject,
        });
      });
      const chosen = (result.users || []).map(person => ({
        id: String(person.emplId || person.userId || ""), name: String(person.name || ""), avatar: String(person.avatar || ""),
        department: "", title: "", email: "", mobile: "", provider: "dingtalk" as const,
      })).filter(person => person.id);
      for (const contact of chosen) inviteContactDetails.current.set(contact.id, contact);
      await confirmInvite(chosen.map(contact => contact.id), mode);
    } catch (error) {
      const cancelled = String(error).toLowerCase();
      if (cancelled.includes("cancel") || cancelled.includes("取消")) return;
      setInviteErrorText(error instanceof Error ? error.message : "钉钉选人失败");
      setInviteOpen(true);
    }
  }
  /** 弹窗确认：empty 模式仅更新内存 pendingMembers（发送时才落库）；session 模式立即邀请成员入会。 */
  async function confirmInvite(selectedIds: string[], mode = inviteMode) {
    if (mode === "empty") {
      // 新建对话空态选人：只记内存（pendingMembers），不在此处建会话、也不在此处复用 1:1。
      // 复用判定挪到「发送」时进行（见 findOneToOneReuse / handleSend）：
      // 选人后仍停留在新建界面，点发送才跳转到已有 1:1 并把消息带过去。
      // 群聊一经创建即永久独立（coworkEverGroup 永不回退），即使成员被移除到只剩 1 人也绝不复用为单聊。
      setPendingMembers(selectedIds.map(id => {
        const contact = inviteContactDetails.current.get(id);
        return { contactId: id, name: contact?.name || "", avatar: contact?.avatar || "" };
      }));
      setInviteOpen(false);
      return;
    }
    if (!selectedIds.length) return;
    setInviteLoading(true);
    try {
      // 人机聊天（含带业务流的聊天）/ 单聊 / 群聊加人：一律在当前会话原地写入成员——
      // 当前会话立即升级为群聊，历史消息与上下文保持不变，不新建群、不切换会话。
      // 升级标记（coworkEverGroup）由服务端在写成员时置位，只升不降，此后不再回退为单聊。
      // 升级人机聊天为群：把当前框架/模型一并交给服务端写入群设置（仅首次），
      // 保证增强群沿用升级前的模型（如 hy3），而不是回落到群默认模型（hy4 preview）。
      const invited = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(activeSid)}/members`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactIds: selectedIds,
          mode: agentMode,
          model: selectedModelId || "",
          codexModel: codexModelOptions.find((o) => modelOptionKey(o) === selectedCodexModel)?.id || "",
        }),
      });
      if (!invited.ok) throw new Error("邀请失败");
      const data = await invited.json();
      setConversationMembers((Array.isArray(data.members) ? data.members : []).map((m: { provider?: string; contactId: string; name: string; avatar: string }) => ({ provider: m.provider ?? "", contactId: m.contactId, name: m.name, avatar: m.avatar })));
      setInviteOpen(false);
      await refreshSessions();
    } catch (error) { setInviteErrorText(error instanceof Error ? error.message : "邀请失败"); }
    finally { setInviteLoading(false); }
  }
  const [renameId, setRenameId] = useState<string | null>(null);
  // —— 工作目录（沙箱范围，桌面宿主）：当前会话选中的目录；切换会话时按会话记录恢复 ——
  const [workspaceDir, setWorkspaceDir] = useState<string | null>(null);
  const [localRefAvailability, setLocalRefAvailability] = useState<Record<string, boolean>>({});
  const [localRefKinds, setLocalRefKinds] = useState<Record<string, "file" | "folder">>({});
  const [pickingWorkspace, setPickingWorkspace] = useState(false);
  // 最近一次选中的工作目录：作为下次打开目录选择框的默认位置
  const lastWorkspaceRef = useRef("");
  // —— 选择工作空间 popup（WB 风格，仅新建任务空态显示）——
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  // messages 的 ref 镜像：异步回调里读取最新长度（恢复最近会话时判断是否已有消息）
  const messagesRef = useRef<UiMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    if (!localFiles) return;
    const urls = [...attachments, ...messages.flatMap((message) => message.attachments ?? (message.attachment ? [message.attachment] : []))]
      .map((file) => file.url).filter(isLocalReference);
    if (!urls.some((url) => !(url in localRefAvailability) || !(url in localRefKinds))) return;
    void localFiles.list().then((refs) => {
      const available = new Map(refs.map((ref) => [ref.url, ref.available !== false]));
      const kinds = new Map(refs.map((ref) => [ref.url, ref.kind]));
      setLocalRefAvailability((current) => ({ ...current, ...Object.fromEntries(urls.map((url) => [url, available.get(url) ?? false])) }));
      setLocalRefKinds((current) => ({ ...current, ...Object.fromEntries(urls.map((url) => [url, kinds.get(url) ?? "file"])) }));
    });
  }, [messages, attachments, localRefAvailability, localRefKinds]);
  // 用户消息复制成功反馈：记录刚复制的消息下标，按钮短暂显示 checked（1.8s 后恢复）
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [messageMoreIdx, setMessageMoreIdx] = useState<number | null>(null);
  // 消息「更多」菜单：点击菜单/⋯ 之外任意处关闭
  useClickOutside({
    enabled: messageMoreIdx !== null,
    exceptSelectors: ["[data-message-more]"],
    onDismiss: () => setMessageMoreIdx(null),
  });
  // ---- 顶栏工具：对话内搜索 / 分享 ----
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);
  const [shareOpen, setShareOpen] = useState(false);
  const [artifactToShare, setArtifactToShare] = useState<{ sessionId: string; artifact: ArtifactMeta } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const mobileWorkNav = useNavStack(["home"]);
  const mobileWorkTop = mobileWorkNav.top();
  const mobileWorkPage = mobileWorkTop?.type === "artifact-preview" ? "artifacts" : mobileWorkTop?.type;
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const toolbarCenterRef = useRef<HTMLDivElement | null>(null);
  const sharePopupRef = useRef<HTMLDivElement | null>(null);
  const [sharePopupPosition, setSharePopupPosition] = useState({ top: 0, left: 0 });
  /** 分享链接状态：provider 为当前登录方式（dingtalk | feishu | builtin | ""），
      oa 为钉钉 H5 JSAPI 前端鉴权所需的 agentId/corpId。 */
  const [shareState, setShareState] = useState<ShareState | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareSending, setShareSending] = useState(false);
  const [shareSendMsg, setShareSendMsg] = useState("");
  // 本地引用附件在网页端点击打开时的拦截提示（3s 自动消失）
  const [localRefOpenMsg, setLocalRefOpenMsg] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  useLayoutEffect(() => {
    if (!shareOpen) return;
    const positionPopup = () => {
      const anchor = window.matchMedia("(max-width: 767.98px)").matches ? moreButtonRef.current : shareButtonRef.current;
      const rect = anchor?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(window.innerWidth <= 600 ? 340 : 360, window.innerWidth - 16);
      setSharePopupPosition({
        top: rect.bottom + 8,
        left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)),
      });
    };
    positionPopup();
    window.addEventListener("resize", positionPopup);
    return () => {
      window.removeEventListener("resize", positionPopup);
    };
  }, [shareOpen]);
  // 分享面板关闭：点击面板 / 分享按钮 / 更多按钮之外任意处关闭（更多按钮在窄屏时复用为分享锚点）
  useClickOutside({
    enabled: shareOpen,
    refs: [sharePopupRef, moreButtonRef, shareButtonRef],
    capture: true,
    onDismiss: () => setShareOpen(false),
  });
  // 更多菜单：点击菜单/⋯ 之外任意处关闭
  useClickOutside({
    enabled: moreOpen,
    refs: [moreButtonRef, moreMenuRef],
    capture: true,
    onDismiss: () => setMoreOpen(false),
  });
  // ---- 回复完成通知：并入下方 [busy] effect 的「答复刚结束」分支 ----
  // Web 通知被浏览器拒绝时的一次性引导条（关闭后本次会话不再出现）
  const [notifyBanner, setNotifyBanner] = useState(false);
  const notifyBannerDismissedRef = useRef(false);

  /** 答复刚结束时调用：按环境弹通知 / 显示权限引导条（并入 1667 行的 [busy] effect）。 */
  function onAnswerFinished() {
    // Web 且通知被拒绝：展示引导条（如何开启浏览器通知权限）
    if (
      !isDesktopApp() &&
      !isDingTalkNotificationWebView() &&
      typeof Notification !== "undefined" &&
      Notification.permission === "denied" &&
      !notifyBannerDismissedRef.current
    ) {
      setNotifyBanner(true);
    }
    // 页面可见且聚焦时不打扰（用户在看着）；否则弹通知（仅在有助手回复时）。
    // 宿主接管了回复通知（桌面壳走主进程 Notification）时这里让路，避免重复弹。
    if (
      !onReplyNotification &&
      canNotify() &&
      (typeof document === "undefined" || document.hidden || !document.hasFocus())
    ) {
      const last = [...messages].reverse().find((m) => m.role === "assistant");
      if (last && last.content && last.content.trim()) {
        showNotification(
          currentSessionTitle || ASSISTANT_NAME,
          summarizeForNotify(last.content),
          `agent-notify-${activeSid}`,
          { kind: "ai-reply", sessionId: activeSid },
          basePath,
        );
      }
    }
  }
  // ---- 顶栏工具：派生数据与行为 ----

  /** 当前会话标题：优先会话列表标题，无则用应用默认标题。 */
  const currentSessionTitle = useMemo(() => {
    const s = sessions.find((x) => x.id === activeSid);
    return s && s.title ? s.title : title;
  }, [sessions, activeSid, title]);
  const currentSessionError = rtMapRef.current.get(activeSid)?.errorMsg || sessionAuxErrors[activeSid];

  /** 空态（新建任务首页）：中栏为居中输入区，顶栏不显示 logo/会话标题。 */
  const isEmptyView = !contentLoading && messages.length === 0;
  // 当前激活场景：始终等于用户选中的场景（空态可切换任意场景；非空态保持所选场景，
  // 其 prompt/技能随场景生效）。sticky 只影响非空态场景栏是否显示该场景作为“我在此场景”的指示。
  const activeScene = allScenes.find((s) => s.key === scene) ?? allScenes[0] ?? null;
  // 已选或已加入的成员决定会话通道；功能开关只控制新建群聊入口。
  const coworkActive = !embeddedMode && !contentLoading && (conversationMembers.length > 0 || coworkSubmission !== null);
  /** 终端提示符主机名：1v1 用对方名字，群聊用群名（与会话列表口径一致：memberCount===1 取 peerName，否则取 title）。 */
  const terminalHost = conversationMembers.length === 1 ? conversationMembers[0].name || currentSessionTitle : currentSessionTitle;
  const [coworkMonologues, setCoworkMonologues] = useState<CoworkMonologue[]>([]);

  /** 搜索命中的消息下标（按消息顺序）。 */
  const searchHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as number[];
    const hits: number[] = [];
    messages.forEach((m, i) => {
      const text = `${m.content || ""} ${(m.attachments ?? (m.attachment ? [m.attachment] : [])).map((file) => file.name).join(" ")}`.toLowerCase();
      if (text.includes(q)) hits.push(i);
    });
    return hits;
  }, [messages, searchQuery]);

  /** 滚动到指定消息（元素带 data-msg-index），并尽量垂直居中；委托给 useChatScroll，
   *  由它关闭「跟随底部」并停止初始化钉底，使视图稳定停在该消息而不被重新钉回底部。 */
  function scrollToMsg(i: number, behavior: ScrollBehavior = "smooth") {
    return scrollToMessage(i, behavior);
  }

  /** 搜索框输入变化：定位到第一个命中。 */
  useEffect(() => {
    if (searchOpen && searchQuery.trim() && searchHits.length) {
      setSearchIdx(0);
      scrollToMsg(searchHits[0]);
    }
  }, [searchOpen, searchQuery]); // 只依赖输入，命中列表由 query 派生
  /** 搜索下标越界时收拢（消息列表可能被清空/切换会话）。 */
  useEffect(() => {
    if (searchIdx >= searchHits.length) setSearchIdx(0);
  }, [searchHits.length, searchIdx]);

  /**
   * 全局搜索（会话列表入口）的跨会话跳转。
   *
   * 搜索结果可能落在别的会话，也可能落在当前会话的历史深处，所以分成两步：
   *  ① 记录 jumpTarget（目标会话 + 目标消息 id）并切换会话；
   *  ② 等该会话历史渲染完（contentLoading=false 且 activeSid 已切换）再按下标定位。
   * 历史里查不到（消息已被删除/截断）就放弃，不留悬空目标反复重算。
   */
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const sessionSearchPendingRef = useRef<(() => void) | null>(null);
  const sessionSearchHistoryRef = useRef(false);
  const closeSessionSearch = () => {
    if (sessionSearchHistoryRef.current) window.history.back();
    else setSessionSearchOpen(false);
  };
  const openSessionSearch = () => {
    setActiveNavigation("home");
    if (window.matchMedia("(max-width: 767.98px)").matches) {
      window.history.pushState({ ...window.history.state, sessionSearchDialog: true }, "", window.location.href);
      sessionSearchHistoryRef.current = true;
    }
    setSessionSearchOpen(true);
  };
  const [jumpTarget, setJumpTarget] = useState<{ sid: string; messageId: number } | null>(null);
  const [jumpHighlightId, setJumpHighlightId] = useState<number | null>(null);
  // 跨会话搜索跳转定位时，抑制「切会话自动滚底」（交由 useChatScroll 在 init 分支消费一次后清回 false）
  const jumpScrollSuppressRef = useRef(false);

  function openSearchedSession(sessionId: string, hitMessageId: number | null) {
    if (sessionSearchHistoryRef.current) {
      sessionSearchPendingRef.current = () => navigateSearchedSession(sessionId, hitMessageId);
      window.history.back();
      return;
    }
    navigateSearchedSession(sessionId, hitMessageId);
  }

  function navigateSearchedSession(sessionId: string, hitMessageId: number | null) {
    setSessionSearchOpen(false);
    setActiveNavigation("home");
    setLibraryOpen(false);
    if (window.matchMedia("(max-width: 767.98px)").matches) setSidebarOpen(false);
    // 无正文命中（只有标题命中）：按常规切会话即可（视图落到最新消息）
    if (hitMessageId != null) {
      // 目标会话≠当前会话时，先抑制「切会话自动滚底」，否则 init 安定窗口的 ResizeObserver
      // 会把 scrollToMsg 的定位结果重新钉回底部，看起来就只是「跳到了会话」。
      if (sessionId !== activeSid) jumpScrollSuppressRef.current = true;
      setJumpTarget({ sid: sessionId, messageId: hitMessageId });
    }
    if (sessionId !== activeSid) void switchSession(sessionId);
  }

  function openSearchedMessage(sessionId: string, messageId: number) {
    openSearchedSession(sessionId, messageId);
  }

  /**
   * 搜索结果点击「联系人」：有已有 1v1 会话直接跳转；没有则进入新建对话界面，
   * 把该联系人预选进草稿（pendingMembers）——**不直接创建会话**。
   * 发送第一条消息时，既有「空态选人」流程会创建会话并把成员落库（成员随会话一起加入），
   * 界面上的提示语让用户知道这一点。
   */
  function openSearchedPerson(person: SessionSearchPersonRow) {
    if (sessionSearchHistoryRef.current) {
      sessionSearchPendingRef.current = () => openPersonChat(person);
      window.history.back();
      return;
    }
    openPersonChat(person);
  }

  function openPersonChat(person: SessionSearchPersonRow, transferredDraft?: { text: string; caret: number; attachments: UiAttachment[] }) {
    if (person.sessionId) {
      if (transferredDraft) {
        saveChatDraft(person.sessionId, transferredDraft.text, transferredDraft.attachments);
        setTransferredDraftCaret({ sid: person.sessionId, caret: transferredDraft.caret });
      }
      navigateSearchedSession(person.sessionId, null);
      return;
    }
    setSessionSearchOpen(false);
    // Home 快捷输入框里的 @ 仅预选联系人；首次发送时才展开并建立单聊。
    const newSid = newSession(!transferredDraft);
    if (transferredDraft) homeMentionKeyRef.current = person.id;
    if (transferredDraft) {
      saveChatDraft(newSid, transferredDraft.text, transferredDraft.attachments);
      requestAnimationFrame(() => {
        composerRef.current?.setText(transferredDraft.text, transferredDraft.caret);
        composerRef.current?.focus();
      });
    }
    // 仅加入草稿：newSession() 已清空上一草稿，这里写入本次预选成员；
    // 发送首条消息时由既有流程创建会话并落库成员，不在点击时建会话。
    setPendingMembers([{ contactId: person.id, name: person.name, avatar: person.avatar }]);
  }

  useEffect(() => {
    if (!jumpTarget) return;
    if (contentLoading || jumpTarget.sid !== activeSid || coworkActive) return;
    const { messageId } = jumpTarget;
    // 先找位置、找到才释放目标：activeSid 可能已切到目标会话但 messages 还是上一个会话的
    // （RT → state 的同步发生在下一次提交），此时 findIndex 必然 -1，若先清空就把这次跳转丢了。
    // 消息 id 是全表 BIGSERIAL，跨会话不可能重复，因此「没找到就继续等」不会误命中。
    const index = messages.findIndex((message) => message.id === messageId);
    if (index === -1) return;
    setJumpTarget(null);
    setJumpHighlightId(messageId);
    // 先平滑居中滚到目标；再在 400ms 后做一次校正（图片/字体落定后若位置明显漂移才瞬时重定位）。
    // scrollToMessage 内部会关闭「跟随底部」，确保定位后不被重新钉回底部。
    // 若首帧元素尚未挂载（极少数异步布局），retry 兜底多试几次，避免「跳不过去」。
    let tries = 0;
    const attempt = () => {
      if (scrollToMsg(index, tries === 0 ? "smooth" : "auto")) {
        if (tries === 0) {
          window.setTimeout(() => {
            const el = document.querySelector<HTMLElement>(`.msg[data-msg-index="${index}"]`);
            const scroller = el?.closest<HTMLElement>(".chat-body");
            if (el && scroller) {
              const elRect = el.getBoundingClientRect();
              const scRect = scroller.getBoundingClientRect();
              const drift = Math.abs(elRect.top - scRect.top + elRect.height / 2 - scroller.clientHeight / 2);
              // 距面板中点 >4px 视为漂移（图片/字体落定导致），才瞬时重定位；否则保持平滑落点。
              if (drift > 4) scrollToMsg(index, "auto");
            }
          }, 400);
        }
        return;
      }
      if (tries++ < 8) window.setTimeout(attempt, 60);
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(attempt));
  }, [jumpTarget, contentLoading, activeSid, messages, coworkActive]);

  // 定位高亮短暂 appearance（4s 后自动消失，呼吸描边只跑前 2.4s，余下时间是静默淡底）：
  // 告诉用户「跳到的是这一条」，又不长期污染样式。
  useEffect(() => {
    if (jumpHighlightId == null) return;
    const timer = window.setTimeout(() => setJumpHighlightId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [jumpHighlightId]);

  /** 搜索上一条/下一条命中。 */
  function goSearch(delta: number) {
    if (!searchHits.length) return;
    const next = (searchIdx + delta + searchHits.length) % searchHits.length;
    setSearchIdx(next);
    scrollToMsg(searchHits[next]);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIdx(0);
  }

  /** 只保留一个顶栏面板打开（搜索/分享互斥）。 */
  function togglePanel(panel: "search" | "share") {
    setSearchOpen(panel === "search" ? (o) => !o : false);
    setShareOpen(panel === "share" ? (o) => !o : false);
    if (panel !== "search") closeSearchStateOnly();
  }
  function closeSearchStateOnly() {
    setSearchQuery("");
    setSearchIdx(0);
  }

  /**
   * 打开分享：先为当前会话创建分享链接（未创建时），随后总是弹出分享面板，
   * 由用户选择：复制链接 / 浏览器打开 / 发送到 OA（钉钉或飞书）聊天。
   */
  async function openShare() {
    setSearchOpen(false);
    // 面板已打开 → 关闭（toggle）
    if (shareOpen) {
      setShareOpen(false);
      return;
    }
    // 未创建链接 → 先创建；已创建但缺聊天摘要（旧缓存/旧版本代码生成）→ 重新创建刷新
    let st = shareState;
    if (!st || !st.summary) {
      setShareLoading(true);
      setShareError("");
      try {
        const res = await fetch(`${basePath}/api/share`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ sessionId: activeSid }),
        });
        const data = (await res.json()) as { url?: string; token?: string; provider?: string; title?: string; text?: string; summary?: string; error?: string; message?: string };
        if (!res.ok) throw new Error(data.error || data.message || "创建分享失败");
        st = {
          url: data.url || "",
          token: data.token || "",
          provider: data.provider || "",
          title: data.title || "",
          text: data.text || "",
          summary: data.summary || "",
          oa: (data as { oa?: { dingtalk?: { agentId: string; corpId: string } } }).oa,
        };
        setShareState(st);
      } catch (e) {
        setShareError(e instanceof Error ? e.message : String(e));
        setShareOpen(true); // 创建失败：面板展示错误
        return;
      } finally {
        setShareLoading(false);
      }
    }
    // 统一弹选择面板（复制链接 / 浏览器打开 / OA 聊天）
    setShareOpen(true);
  }

  async function copyShareLink() {
    if (!shareState) return;
    const ok = await copyTextToClipboard(shareState.url);
    setCopiedLink(ok);
    setTimeout(() => setCopiedLink(false), 1800);
  }

  /** 在浏览器打开分享链接：Electron 下 window.open 会被主进程转发到系统默认浏览器（shell.openExternal）。 */
  function openShareInBrowser() {
    if (!shareState?.url) return;
    setShareOpen(false);
    window.open(shareState.url, "_blank", "noopener,noreferrer");
  }

  /** 请求服务端生成 H5 JSAPI 鉴权参数（当前登录方式）。 */
  async function fetchJsapiSign(): Promise<{ provider: string; config: Record<string, unknown> }> {
    const res = await fetch(`${basePath}/api/share/jsapi-sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ url: window.location.href.split("#")[0] }),
    });
    const data = (await res.json()) as { provider?: string; config?: Record<string, unknown>; error?: string; message?: string };
    if (!res.ok || !data.config) throw new Error(data.error || data.message || "JSAPI 鉴权参数获取失败");
    return { provider: data.provider || "", config: data.config };
  }

  /** 发送分享到 OA（share 可显式传入；缺省用 shareState）。 */
  async function chooseAndSend(share?: ShareState) {
    const st = share ?? shareState;
    if (!st) return;
    setShareSending(true);
    setShareSendMsg("");
    try {
      if (st.provider === "dingtalk") {
        await sendViaDingTalk(st);
        // 钉钉：用户已在原生分享面板完成发送动作并返回，以"已发送 ✓"作完成反馈
        setShareSendMsg("已发送 ✓");
        setTimeout(() => setShareSendMsg(""), 3000);
      } else if (st.provider === "feishu") {
        const chatId = await sendViaFeishu(st);
        // 记录目标会话 openChatId：分享面板据此展示「查看已分享的会话」跳转入口
        if (chatId) setShareState((prev) => (prev ? { ...prev, chatId } : prev));
        // 飞书成功后有「查看已分享的会话」按钮作为反馈，不再重复显示"已发送 ✓"
      } else throw new Error("当前登录方式不支持直接发送");
    } catch (e) {
      if (e instanceof ShareCancelledError) {
        // 用户主动取消选择：正常行为，静默结束（不展示红色"发送失败"）
        setShareSendMsg("");
        return;
      }
      setShareSendMsg(`发送失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setShareSending(false);
    }
  }

  /** 钉钉链路：唤起钉钉客户端原生分享面板（dd.share / 旧版 biz.util.share）。
   *  用户可在面板内选择「单聊 / 群聊 / 动态」等目标，以用户身份发送链接卡片；
   *  官方文档（2024-12-17）网页应用全端支持、无需鉴权——不需要卡片模板、不需要选人/选会话 JSAPI。
   */
  async function sendViaDingTalk(st: ShareState) {
    await loadScript(DD_SDK_URL);
    const dd = (window as unknown as {
      dd?: {
        share?: (args: Record<string, unknown>) => void;
        biz?: { util?: { share?: (args: Record<string, unknown>) => void } };
      };
    }).dd;
    if (!dd) throw new Error("钉钉 JS SDK 加载失败");
    // 新版一段式 dd.share 优先（PC 端支持），旧版 biz.util.share 作为兼容回退
    const shareFn = dd.share || dd.biz?.util?.share;
    if (typeof shareFn !== "function") {
      throw new Error("当前钉钉 SDK 不支持 share（需 dingtalk-jsapi ≥ 3.0.27）");
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const once = (fn: (...args: unknown[]) => void) => () => {
        if (settled) return;
        settled = true;
        fn();
      };
      // 兼容旧版三段式回调（部分客户端只走回调）
      const callbacks = {
        onSuccess: once(() => resolve()),
        onFail: once(() => reject(new ShareCancelledError())),
        success: once(() => resolve()),
        fail: once(() => reject(new ShareCancelledError())),
      };
      const params = {
        type: 1, // 1 = 只能分享到钉钉（单聊/群聊/动态），聚焦会话分享
        url: st.url,
        title: st.title || "AI 对话分享",
        // 正文参考飞书分享卡片结构：聊天摘要（最近 5 条）在上、点击提示收尾
        content: st.summary ? `${st.summary}\n\n点击查看完整内容` : st.text || "点击查看完整对话内容",
        ...callbacks,
      };
      let ret: unknown;
      try {
        ret = shareFn(params);
      } catch (e) {
        once(() => reject(new Error(`钉钉分享失败：${e instanceof Error ? e.message : String(e)}`)))();
      }
      // 新版一段式 API 返回 Promise：用户取消面板时 reject { errorCode:'-1', errorMessage:'Cancel' }，
      // 必须消费掉（否则 unhandledRejection），取消按 ShareCancelledError 静默处理。
      if (ret && typeof (ret as PromiseLike<unknown>).then === "function") {
        Promise.resolve(ret).then(
          once(() => resolve()),
          once((err: unknown) => {
            const obj = (typeof err === "object" && err !== null ? err : {}) as { errorCode?: unknown; errorMessage?: unknown };
            const code = String(obj.errorCode ?? "");
            const msg = String(obj.errorMessage ?? "");
            if (code === "-1" || /cancel/i.test(msg)) reject(new ShareCancelledError());
            else reject(new Error(`钉钉分享失败：${JSON.stringify(err)}`));
          }),
        );
      }
      // 兜底：面板调起后无任何回调/Promise 未 settle（部分客户端行为差异），3s 后视为已打开
      setTimeout(once(() => resolve()), 3000);
    });
    // 分享面板由钉钉客户端渲染，发送动作与结果由用户在面板内完成：
    // 不显示任何过程提示（用户已进入钉钉面板，返回时也不做"已分享"声明）
  }

  /** 飞书 H5 JSAPI 鉴权：加载 SDK → 服务端签名 → h5sdk.config → ready。
   *  jsApiList 声明本次要用到的 JSAPI（chooseChat / enterChat 等）；返回 window.tt 供业务调用。 */
  async function feishuAuth(jsApiList: string[]): Promise<{ tt: any }> {
    await loadScript(FEISHU_SDK_URL);
    const win = window as unknown as { h5sdk?: any; tt?: any };
    const h5sdk = win.h5sdk;
    if (!h5sdk || !win.tt) throw new Error("飞书 H5 SDK 加载失败或当前不在飞书客户端内");
    const { config } = await fetchJsapiSign();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("飞书鉴权超时")), 8000);
      h5sdk.error((err: unknown) => {
        clearTimeout(timer);
        reject(new Error(`飞书鉴权失败：${JSON.stringify(err)}`));
      });
      try {
        h5sdk.config({
          appId: config.appId,
          timestamp: config.timestamp,
          nonceStr: config.nonceStr,
          signature: config.signature,
          jsApiList,
          onSuccess: () => clearTimeout(timer),
        });
      } catch (e) {
        clearTimeout(timer);
        reject(new Error(`飞书鉴权配置失败：${e instanceof Error ? e.message : String(e)}`));
      }
      h5sdk.ready(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { tt: win.tt };
  }

  /** 飞书链路：选择会话（tt.chooseChat）→ 服务端以用户身份代发 → 返回目标会话 openChatId。
   *  注意：H5 JSAPI 的业务方法（chooseChat 等）挂在 window.tt 上，h5sdk 仅提供 config/ready/error 鉴权方法。 */
  async function sendViaFeishu(st: ShareState): Promise<string> {
    const { tt } = await feishuAuth(["chooseChat"]);
    if (typeof tt.chooseChat !== "function") {
      throw new Error("飞书 H5 SDK 加载失败或当前不在飞书客户端内");
    }
    const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("选择会话超时")), 60000);
      tt.chooseChat({
        success: (r: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(r || {});
        },
        fail: () => {
          clearTimeout(timer);
          reject(new ShareCancelledError());
        },
      });
    });
    // chooseChat 返回 { errMsg, data: [{ id: openChatId, chatType }] }：id 在数组首元素。
    // 兼容 openChatId / chatId / id / open_chat_id / chat_id / data.id / data[].id
    const dataArr = Array.isArray(raw.data) ? (raw.data as Array<Record<string, unknown>>) : [];
    const first = dataArr[0];
    const chatId = [raw.openChatId, raw.chatId, raw.id, raw.open_chat_id, raw.chat_id, (raw.data as Record<string, unknown> | undefined)?.id, first?.id]
      .find((v): v is string => typeof v === "string" && v.length > 0);
    if (!chatId) {
      // 字段未命中时把原始返回带进错误，便于精确定位实际字段名
      throw new Error(`未获取到会话（chooseChat 返回：${JSON.stringify(raw)}）`);
    }
    await sendToOa(st, { provider: "feishu", chatId });
    return chatId;
  }

  /** 跳转到飞书内已分享的目标会话（tt.enterChat，官方 H5 JSAPI「打开指定会话」）。
   *  仅当分享成功且记录了 chatId 时可跳；需在飞书客户端内。 */
  async function openFeishuChat(openChatId: string) {
    try {
      const { tt } = await feishuAuth(["enterChat"]);
      if (typeof tt.enterChat !== "function") throw new Error("当前飞书版本不支持打开会话");
      await new Promise<void>((resolve, reject) => {
        tt.enterChat({
          openChatId,
          success: () => resolve(),
          fail: (err: unknown) => reject(new Error(`打开会话失败：${JSON.stringify(err)}`)),
        });
      });
      // 跳转成功由飞书客户端接管页面，不显示提示
    } catch (e) {
      setShareSendMsg(`打开会话失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 服务端代发分享链接（钉钉 cid / 飞书 chatId）。 */
  async function sendToOa(st: ShareState, body: { provider: string; cid?: string; chatId?: string }) {
    const res = await fetch(`${basePath}/api/share/${encodeURIComponent(st.token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; message?: string };
    if (!res.ok || !data.ok) throw new Error(data.message || data.error || "发送失败");
  }

  // 产物预览：当前打开预览抽屉的产物对象（null 表示关闭）
  const [preview, setPreview] = useState<{ sid: string; meta: ArtifactMeta } | null>(null);
  // 产物条目「⋯」菜单：当前打开菜单的产物 id（null = 全关）
  const [artifactMenuId, setArtifactMenuId] = useState<string | null>(null);
  // 浮层菜单：点击外部或按 Esc 关闭。
  useEffect(() => {
    if (!artifactMenuId) return;
    const onDown = (ev: MouseEvent) => {
      const t = ev.target as HTMLElement | null;
      if (t?.closest(".artifact-list-menu") || t?.closest(".artifact-list-more")) return;
      setArtifactMenuId(null);
    };
    const onKeyDown = (ev: KeyboardEvent) => { if (ev.key === "Escape") setArtifactMenuId(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKeyDown); };
  }, [artifactMenuId]);
  /** 产物预览全屏（toggle）：右栏占满 app 宽度，左栏/中栏让位；再点还原 */
  const [previewFull, setPreviewFull] = useState(false);
  const [appFull, setAppFull] = useState(false);
  useEffect(() => {
    if (!appFull && !previewFull) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setAppFull(false); setPreviewFull(false); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [appFull, previewFull]);
  useEffect(() => { setAppFull(false); }, [activeNavigation]);
  /** 输入文件预览（点击右栏「输入文件」列表的 md/html 条目打开）：与输出产物预览互斥 */
  const [inputFilePreview, setInputFilePreview] = useState<{ url: string; name: string; type: ArtifactType } | null>(null);
  const [workSurface, setWorkSurface] = useState<WorkPanelSurface | null>(null);
  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; workflows: SessionWorkflow[] }>).detail;
      if (!detail?.sessionId || !Array.isArray(detail.workflows)) return;
      setSessions((current) => current.map((session) => session.id === detail.sessionId ? { ...session, workflows: detail.workflows } : session));
    };
    window.addEventListener("agent-kit:session-workflows-updated", onUpdated);
    return () => window.removeEventListener("agent-kit:session-workflows-updated", onUpdated);
  }, []);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<WorkPanelSurface>).detail;
      if (!detail || !["website", "app"].includes(detail.kind) || !detail.id || !detail.title) return;
      if (!detail.url && !(detail.kind === "app" && renderNavigationEntry(detail.id))) return;
      let url: URL | undefined;
      if (detail.url) {
        try { url = new URL(detail.url, window.location.href); } catch { return; }
        if (!["http:", "https:"].includes(url.protocol)) return;
      }
      setWorkSurface({ ...detail, url: url?.href, sessionId: detail.sessionId || activeSidRef.current });
      setPreview(null);
      setDiffView(null);
      setInputFilePreview(null);
      setRightOpen(true);
    };
    window.addEventListener("agent-kit:open-work-panel", onOpen);
    return () => window.removeEventListener("agent-kit:open-work-panel", onOpen);
  }, [navigationEntries]);
  /** 右栏输出区滚动容器 ref：打开预览时回滚到顶部（列表滚动到底部时点击，预览不从中间开始） */
  const rightBodyRef = useRef<HTMLDivElement | null>(null);
  /** 变更视图只保存选择，内容由会话变更派生，后续编辑自动更新。 */
  const [diffView, setDiffView] = useState<{ sid: string; activeId: string } | null>(null);
  useEffect(() => {
    if (preview || diffView || inputFilePreview) setWorkSurface(null);
  }, [preview, diffView, inputFilePreview]);
  /** 上下文容量（输入框模型名左侧环形指示）：usedTokens = 最新一轮 result.usage 输入 token
   *  （CLI 每次请求发送全量上下文，近似当前上下文大小）；maxTokens = /api/models/context 模型上限；
   *  compacting = CLI 压缩中；lastCompactAt = 最近一次压缩结束时间戳（headless 不发 compact_boundary，由 compact_status 回落识别，提示用） */
  const [ctxUsage, setCtxUsage] = useState<{
    usedTokens: number | null;
    maxTokens: number | null;
    compacting: boolean;
    lastCompactAt: number | null;
  }>({ usedTokens: null, maxTokens: null, compacting: false, lastCompactAt: null });
  /** maxTokens 同步 ref：事件处理器（cost_info 等）读最新上限，判断是否需要补拉 */
  const maxTokensRef = useRef<number | null>(null);
  /** control_browser 实时截图（base64，右侧预览面板显示；browser_screenshot 事件更新） */
  const [browserShot, setBrowserShot] = useState<string | null>(null);
  const [browserShotSid, setBrowserShotSid] = useState<string | null>(null);
  /** 当前会话浏览器的 CDP 端口（browser_cdp 事件下发；右侧预览点击转发用） */
  const [cdpPort, setCdpPort] = useState<number>(0);
  const [cdpSid, setCdpSid] = useState<string | null>(null);
  // 右栏（文件列表）开关：默认隐藏，顶栏右上角按钮唤起；展开状态同样持久化
  const [rightOpen, setRightOpen] = useState<boolean>(() => {
    if (closePanelsOnNewChat || openSidebarOnMount) return false;
    if (embeddedMode) return false;
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem("agent-kit:sidebar-right") === "1";
  });
  useEffect(() => {
    if (embeddedMode) return;
    if (Date.now() < panelPersistSkipUntilRef.current) return;
    try { localStorage.setItem("agent-kit:sidebar-right", rightOpen ? "1" : "0"); } catch { /* 隐私模式等场景忽略 */ }
  }, [rightOpen, embeddedMode]);
  // 挂载时面板状态决策（只执行一次，空依赖是刻意的，读的是挂载瞬间的 prop 值）：
  //  · openSidebarOnMount（有未读消息时打开 chat）：强制展开左侧会话列表，让用户一眼看到未读会话。
  //    不写入全局面板偏好（panelPersistSkipUntilRef），避免覆盖用户之前收起侧栏的选择。
  //  · closePanelsOnNewChat（空白入口新建会话）：左右面板一律收起，不继承上一次会话的展开状态。
  // 两者互斥（宿主层保证），同时为 true 时 openSidebarOnMount 优先。
  useEffect(() => {
    if (openSidebarOnMount) {
      panelPersistSkipUntilRef.current = Date.now() + 500;
      setSidebarOpen(true);
      return;
    }
    if (closePanelsOnNewChat) collapsePanelsForNewChat();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** 新建会话：左右面板回到默认收起态。只改当前渲染状态，不写全局偏好
   *  （写盘窗口见 panelPersistSkipUntilRef）——这是会话初始化，不是用户对面板的选择。
   *  keepSidebarOnNewChat（宿主 Home 主窗口）时保留左栏会话列表，仅收起右栏。 */
  function collapsePanelsForNewChat() {
    panelPersistSkipUntilRef.current = Date.now() + 500;
    if (!keepSidebarOnNewChat) setSidebarOpen(false);
    setRightOpen(false);
  }
  // 切换会话运算期间冻结右栏显示决策：await 后的多次渲染会让 rightShown 的中间态反复跳变，
  // 表现为「右栏开一半又立即关闭」的闪烁。冻结时右栏保持切换前的真实显示态（快照），
  // 等 loadHistory + 拉产物列表运算完成后（switchSession 末尾解冻）一次性给出最终显示态。
  const [rightFrozen, setRightFrozen] = useState<boolean>(false);
  const rightShownSnapshotRef = useRef<boolean>(false);
  const rightShownBase = rightOpen;
  // 冻结期间用快照（不响应中间态）；否则用实时派生值
  const rightShown = rightFrozen ? rightShownSnapshotRef.current : rightShownBase;
  const openMobileWorkPage = (page: "settings" | "artifacts" | "chatmate" | "monologue") => {
    if (mobileWorkNav.top()?.type === "root") mobileWorkNav.push({ type: "session", sessionId: activeSid });
    mobileWorkNav.push({ type: page });
    const index = (window.history.state?.agentNav?.index ?? 0) + 1;
    window.history.pushState({ ...window.history.state, agentNav: { index }, agentMobileWorkPage: page }, "", window.location.href);
    setConversationView(true);
    setSidebarOpen(false);
    if (page !== "settings") setRightOpen(true);
  };
  const closeMobileWorkPage = () => {
    window.history.back();
  };
  const openMobileArtifactPreview = (artifactId: string) => {
    if (mobileWorkNav.top()?.type === "artifacts") {
      mobileWorkNav.push({ type: "artifact-preview", artifactId });
      const index = (window.history.state?.agentNav?.index ?? 0) + 1;
      window.history.pushState({ ...window.history.state, agentNav: { index }, agentMobileWorkPage: "artifact-preview" }, "", window.location.href);
    }
  };
  useEffect(() => { mobileWorkNav.resetRoot(); }, [activeSid]); // 新会话不继承旧会话的移动端页面
  // 右侧拖动宽度：null = 默认 50% 平分；拖动 resizer 时实时更新。
  // 收起期间不重置宽度，重新打开时恢复之前的宽度。
  // 持久化：首次渲染从 localStorage 读取用户上次拖拽的宽度（key: agent-kit:right-width）。
  const [storedRightW, setStoredRightW] = useState<number | null>(() => {
    try {
      const raw = window.localStorage.getItem("agent-kit:right-width");
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  /**
   * 右栏宽度：宿主传了 rightPanelWidth 就完全受控（宿主会自己维护它，
   * 因为拖窗口右边框时也要改右栏宽度）；否则用内部 state + localStorage 记忆。
   * setRightW 因此不能直接用 useState 的 setter —— 受控时只回传、不落地。
   */
  const controlled = controlledRightPanelWidth !== undefined;
  const rightW = controlled ? controlledRightPanelWidth : storedRightW;
  const setRightW = (width: number) => {
    if (controlled) { rightWidthReportRef.current?.(width); return; }
    setStoredRightW(width);
  };
  const growRight = rightShown && !embeddedMode && !libraryOpen && activeNavigation === "home" && !previewFull;
  const growLeft = sidebarOpen && !embeddedMode && !previewFull;
  useLayoutEffect(() => {
    if (layoutMode !== "grow") return;
    const host = shellRef.current?.closest<HTMLElement>(".quick-input") ?? shellRef.current?.parentElement;
    if (!host) return;
    host.style.setProperty("--focus-left-extension", growLeft ? `${LEFT_PANE_W}px` : "0px");
    host.style.setProperty("--focus-right-extension", growRight ? `${rightW ?? 340}px` : "0px");
    return () => {
      host.style.removeProperty("--focus-left-extension");
      host.style.removeProperty("--focus-right-extension");
    };
  }, [layoutMode, growLeft, growRight, rightW]);
  // 右栏实际宽度上报给宿主（展示时为 px，隐藏时为 null）。
  // 宿主用它把窗口宽 = 基准宽 + 右栏宽，实现"展开右栏时窗口整体变宽、中栏纹丝不动"。
  // 回调走 ref：宿主多半传内联箭头函数，直接进依赖会让每次渲染都触发一次上报。
  //
  // **必须是 useLayoutEffect**：宿主收到后要 setState 改窗口宽度，如果放在 useEffect 里，
  // 窗口宽度的 CSS 过渡会比 --grow-right 的过渡**晚一帧**才开始 —— 动画期间
  // 「窗口已变宽、右栏还没长出来」，中栏就被挤得先窄后宽地抖一下。layout effect 里的
  // setState 会在同一帧内同步 flush，两条过渡同帧起步、逐帧相等。
  const rightWidthReportRef = useRef(onRightPanelWidthChange);
  rightWidthReportRef.current = onRightPanelWidthChange;
  useLayoutEffect(() => {
    rightWidthReportRef.current?.(growRight ? rightW ?? 340 : null);
  }, [growRight, rightW]);
  // 宽度持久化：只要 rightW 变化（拖拽实时）就落盘，不依赖 onResizeEnd 的 pointerup
  // （拖拽中途 resizer 被卸载 / pointerup 丢失时也不会漏存）。受控模式下宽度归宿主所有，不写盘。
  useEffect(() => {
    if (rightW == null || controlled) return;
    try {
      window.localStorage.setItem("agent-kit:right-width", String(rightW));
    } catch {
      /* ignore */
    }
  }, [rightW, controlled]);
  const [rightDragging, setRightDragging] = useState(false);
  const resizeDragRef = useRef<{ startX: number; startW: number } | null>(null);

  // 主导航栏展开/折叠：localStorage 优先，无记录（首次）回落宿主 sidebarExpanded prop。
  // 仅记录「展开/折叠」布尔，宽度不持久化（展开宽 = sidebarWidth prop ?? 默认 160）。
  const [navExpanded, setNavExpanded] = useState<boolean>(() => {
    if (typeof window === "undefined") return sidebarExpanded;
    try {
      const saved = window.localStorage.getItem("agent-kit:nav-expanded");
      if (saved === "1") return true;
      if (saved === "0") return false;
    } catch { /* 隐私模式等场景忽略，回落 prop */ }
    return sidebarExpanded;
  });
  useEffect(() => {
    if (embeddedMode) return;
    try { window.localStorage.setItem("agent-kit:nav-expanded", navExpanded ? "1" : "0"); } catch { /* ignore */ }
  }, [navExpanded, embeddedMode]);
  // 展开固定宽度：prop sidebarWidth 优先，否则默认 160（与 CSS var 缺省一致）。
  const navExpandW = typeof sidebarWidth === "number" && Number.isFinite(sidebarWidth) && sidebarWidth > 0 ? sidebarWidth : NAV_DEFAULT_W;
  const [navDragging, setNavDragging] = useState(false);
  const navDragRef = useRef<{ startX: number; startExpanded: boolean } | null>(null);
  // 导航栏右缘拖拽：仅桌面精确指针（hover/pointer:fine）生效；只做过阈值切换，不跟手改宽。
  const onNavResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (typeof window !== "undefined" && !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    e.preventDefault();
    navDragRef.current = { startX: e.clientX, startExpanded: navExpanded };
    setNavDragging(true);
    document.body.style.userSelect = "none";
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onNavResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = navDragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    // 假想宽度 = 基准宽 + 指针位移：右拖（dx>0）变宽，左拖（dx<0）变窄。
    // 展开态左拖到阈值以下折叠；折叠态右拖到阈值以上展开。过阈值即切换，
    // 并以新态重置基准，避免停在阈值附近来回抖动。
    const baseW = d.startExpanded ? navExpandW : NAV_COLLAPSED_W;
    const hypothetical = baseW + dx;
    if (d.startExpanded && hypothetical < NAV_COLLAPSE_THRESHOLD) {
      setNavExpanded(false);
      navDragRef.current = { startX: e.clientX, startExpanded: false };
    } else if (!d.startExpanded && hypothetical > NAV_COLLAPSE_THRESHOLD) {
      setNavExpanded(true);
      navDragRef.current = { startX: e.clientX, startExpanded: true };
    }
  };
  const onNavResizeEnd = () => {
    if (!navDragRef.current) return;
    navDragRef.current = null;
    setNavDragging(false);
    document.body.style.userSelect = "";
  };

  // busy 上一次的值（判断「答复刚结束」）
  const prevBusyRef = useRef(false);
  // 滚动条自动隐藏：任何滚动（capture 阶段捕获 chat-body / 右栏滚动）显示 thumb，
  // 1.5s 无操作后隐藏（webkit ::-webkit-scrollbar 不支持 CSS 动画，故用 .sb-active 切换）
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = () => {
      document.querySelectorAll(".chat-body, .chat-right-section-body").forEach((el) => el.classList.add("sb-active"));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        document.querySelectorAll(".chat-body, .chat-right-section-body").forEach((el) => el.classList.remove("sb-active"));
      }, 1500);
    };
    document.addEventListener("scroll", show, { capture: true, passive: true });
    return () => {
      document.removeEventListener("scroll", show, { capture: true } as EventListenerOptions);
      if (timer) clearTimeout(timer);
    };
  }, []);
  // 会话产物总数缓存（按钮计数）：{ [sessionId]: N }，由列表端点拉取后更新
  const [artifactCounts, setArtifactCounts] = useState<Record<string, number>>({});
  // 会话产物列表缓存（右侧面板数据）：{ [sessionId]: ArtifactMeta[] }
  const [artifactLists, setArtifactLists] = useState<Record<string, ArtifactMeta[]>>({});
  const [artifactLoadErrors, setArtifactLoadErrors] = useState<Record<string, boolean>>({});
  const artifactListRequests = useRef(new Map<string, Promise<void>>());
  const artifactListsDirty = useRef(new Set<string>());
  /** 本轮刚产生新产物 → 下次列表刷新后自动聚焦第一个预览（避免切换会话时误触发） */
  const autoFocusNewArtifactsRef = useRef(false);
  // 优雅错误提示：error 事件或请求异常时展示（null 表示无）
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  // 取消控制：本轮请求的 AbortController
  const abortRef = useRef<AbortController | null>(null);
  // 构造产物隔离 URL（session 与 file 编码，服务端二次校验防穿越；登录用户走会话 Cookie + DB 归属校验）
  const buildArtifactUrl = (id: string): string => {
    return artifactUrl({ session: sessionId, file: id });
  };
  // 聊天区滚动控制（置顶 / 跟随底部 / 空白排空 / 初始化滚底）已抽到 useChatScroll，避免其余改动误伤滚动逻辑。
  const { bodyRef, bindBodyRef, spacerRef, atBottom, jumpToBottom, scrollToMessage, onUserScrollIntent, markSend, resetScrollState } = useChatScroll({
    messages,
    busy,
    booting: contentLoading,
    initScrollDisabledRef: jumpScrollSuppressRef,
  });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [recentScreenshot, setRecentScreenshot] = useState<{ id: string; name: string; thumbnail: string } | null>(null);
  const screenshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenshotHoveredRef = useRef(false);
  useEffect(() => {
    const desktop = (window as unknown as { agentHost?: { screenshots?: {
      onNew(listener: (notice: { id: string; name: string; thumbnail: string }) => void): () => void;
    } } }).agentHost;
    if (!desktop?.screenshots || !uploadEnabled) return;
    const unsubscribe = desktop.screenshots.onNew((notice) => {
      setRecentScreenshot(notice);
      if (screenshotTimerRef.current) clearTimeout(screenshotTimerRef.current);
      screenshotTimerRef.current = screenshotHoveredRef.current ? null : setTimeout(() => setRecentScreenshot(null), 10000);
    });
    return () => { unsubscribe(); if (screenshotTimerRef.current) clearTimeout(screenshotTimerRef.current); };
  }, [uploadEnabled]);
  async function addRecentScreenshot() {
    if (!recentScreenshot || uploading) return;
    const notice = recentScreenshot;
    setRecentScreenshot(null);
    const desktop = (window as unknown as { agentHost?: { screenshots?: {
      take(id: string): Promise<{ id: string; name: string; size: number; url: string } | null>;
    } } }).agentHost;
    const ref = await desktop?.screenshots?.take(notice.id);
    if (!ref) return;
    setAttachments((current) => [...current, { url: ref.url, name: ref.name, size: ref.size, kind: "file", previewUrl: notice.thumbnail }]);
    composerRef.current?.focus();
  }
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  // 无应用扩展时保留文件选择器；注册了来源时展示统一的添加引用菜单。
  function onAttachClick() {
    if (referenceSources.length) setReferenceMenuOpen((open) => !open);
    else fileRef.current?.click();
  }
  // 新建任务空态自动聚焦：PC / 本地桌面端（含点击会话列表 + 号进入）聚焦输入框；
  // 触控设备（手机 / 平板，系统键盘会随聚焦弹出）则不聚焦，等用户主动点输入框。
  // 以「是否触控设备」判定而非视口宽度：桌面壳窗口无论宽窄都视为桌面应聚焦，
  // 宽屏触控板设备则不应弹出系统键盘。
  useEffect(() => {
    if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
    if (!contentLoading && messages.length === 0 && !busy) {
      composerRef.current?.focus();
    }
  }, [contentLoading, messages.length, busy]);
  // 思考计时：thinkingStartRef 记录起点（发送时刻），thinkingTimerRef 每秒更新「已用时」，
  // 流结束后 stop 并定格为「总用时」。stepStartRefs 记录每个思考步的开始时刻（步1 = 发送时刻）。
  const thinkingStartRef = useRef<number | null>(null);
  const thinkingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepStartRefs = useRef(new Map<number, number>());

  function stopThinkingTimer(rt: RtState) {
    if (rt && rt.thinkingTimer) {
      clearInterval(rt.thinkingTimer);
      rt.thinkingTimer = null;
    }
  }

  function startThinkingTimer(rt: RtState) {
    if (!rt || rt.thinkingTimer) return;
    rt.thinkingTimer = setInterval(() => {
      const start = rt.thinkingStart;
      if (!start) return;
      const now = Date.now();
      const secs = Math.max(1, Math.round((now - start) / 1000));
      // 更新 rt.messages 里最后一条 assistant 的 thinkingSecs、活动步用时与实时共用时
      const msgs = rt.messages;
      if (!msgs.length) return;
      const last = msgs[msgs.length - 1];
      if (last?.role !== "assistant") return;
      const steps = (last.steps || []).map((s, si) => {
        if (si === (last.steps?.length || 0) - 1 && !s.tool) {
          const st = rt.stepStarts.get(si + 1);
          if (st) return { ...s, secs: Math.max(1, Math.round((now - st) / 1000)) };
        }
        return s;
      });
      // 共用时实时显示：流式中始终从发送时刻 live 递增（不读 last.elapsedSecs，否则会卡在首秒）；
      // 仅在 rt.elapsedStart 已清空（收尾后）才回退到已定稿的最终值
      const elapsedSecs = rt.elapsedStart
        ? Math.max(1, Math.round((now - rt.elapsedStart) / 1000))
        : last.elapsedSecs ?? null;
      msgs[msgs.length - 1] = { ...last, thinkingSecs: secs, steps, elapsedSecs };
      if (activeSidRef.current === sidOf(rt)) setMessages([...msgs]);
    }, 1000);
  }
  // 由 rt 反查 sid（rtMap 反向查找，用于 timer 闭包里判断是否当前 active）
  const sidOf = (rt: RtState): string | null => {
    for (const [k, v] of rtMapRef.current) if (v === rt) return k;
    return null;
  };
  // IME 组合态标记已随输入框移入 ChatComposer（中文输入法下输入英文/候选词时，回车应先确认输入而非发送）。

  // 回答完成后（busy 变 false）才渲染负责人卡片；滚动收尾（置顶排空/跟随底部）已移入 useChatScroll。
  useEffect(() => {
    const justFinished = prevBusyRef.current && !busy;
    prevBusyRef.current = busy;
    if (busy) return;
    if (justFinished) {
      onAnswerFinished();
      // 答复完全输出后底部「查看全部产物 / 查看所有变更」重新出现：
      // 强制重拉产物列表，检查产物是否仍在磁盘——被用户手动删除的文件
      // 会从列表与总数中剔除（服务端 list 按磁盘存在过滤），变更集引用随之减少。
      void refreshArtifactList(sessionId);
    }
  }, [busy]);

  // —— 右栏一律「不自动展开」——
  // 旧行为（已移除）：答复结束拉到产物列表就 setRightOpen(true) 强行拉开右栏，
  // 且「恰好 1 个产物」时自动预览 list[0]。两个副作用：
  //   ① 用户手动收起后，只要产物 id 集合有变化（例如下一轮多出一个文件）就被强行拉回来；
  //   ② 产物列表会混入工作目录里**既有的工程配置文件**（见 artifacts.ts 的 ensureWorkRegistered），
  //      于是纯聊天轮次会凭空出现「输出产物 (1)」并自动预览一个模型根本没碰过的文件。
  // SDK（@tencent-ai/agent-sdk）没有「判断本轮是否该预览某个文件」的内置工具：
  // Artifact / ArtifactControl 只负责把 HTML/Markdown 发布成公网分享链接，
  // Message 流里也没有 artifact / file-change 事件。
  // 因此右栏只由用户显式操作打开（顶栏开关 /「查看全部产物」按钮 / 左上产物数按钮），
  // 无产物时保留用户的右栏展开偏好，作业选择器可直接使用。

  // 打开预览 / 变更 diff / 输入文件预览时：右栏滚动回顶部
  // （产物列表滚动到底部时点击，预览不从列表滚动位置开始显示）
  useEffect(() => {
    if (preview || diffView || inputFilePreview) {
      rightBodyRef.current?.scrollTo({ top: 0 });
    }
  }, [preview, diffView, inputFilePreview]);

  // 右栏与中栏之间拖动改宽（resizer）：Pointer 捕获保证移出元素也能持续拖动
  const onResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!rightShown) return;
    e.preventDefault();
    // 以右栏当前真实宽度为基准（默认 50% 时也正确，而非写死常量）
    const pane = e.currentTarget.closest(".chat-pane-right") as HTMLElement | null;
    const cur = pane ? Math.round(pane.getBoundingClientRect().width) : (rightW ?? 340);
    resizeDragRef.current = { startX: e.clientX, startW: cur };
    setRightDragging(true);
    document.body.style.userSelect = "none";
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = resizeDragRef.current;
    if (!d) return;
    // 往左拖（handle 左移）→ 右栏变宽、中间变小；往右拖 → 右栏变窄、中间变大（与 wb 一致）。
    // 上限 = 窗口 − 左栏(280) − 中栏最小宽(375)：右栏可以一直压到中间只剩 375px 最小宽，
    // 不再用「右栏 ≤ 屏宽 55%」的经验限制（那会让大屏下中间永远压不到最小值）。
    const leftUsed = sidebarOpen ? LEFT_PANE_W : 0;
    const maxRight = layoutMode === "grow"
      ? Math.max(220, window.innerWidth - CHAT_MIN_W)
      : Math.max(0, window.innerWidth - leftUsed - CHAT_MIN_W);
    const w = Math.round(
      Math.min(
        Math.max(d.startW - (e.clientX - d.startX), Math.min(220, maxRight)),
        maxRight,
      ),
    );
    setRightW(w);
  };
  const onResizeEnd = () => {
    if (!resizeDragRef.current) return;
    resizeDragRef.current = null;
    setRightDragging(false);
    document.body.style.userSelect = "";
    // 持久化已由 useEffect(rightW) 实时落盘，这里无需重复写
  };

  // 输入框随内容自适应高度已随 textarea 移入 ChatComposer（autoGrow 读 scrollHeight 强制布局，
  // 只发生在输入区内部，不再波及整个界面）。

  // 登录用户进入：拉取会话列表；无消息时恢复最近会话（会话/消息存数据库）
  useEffect(() => {
    if (!isLoggedIn || embeddedMode) return;
    let cancelled = false;
    const requestId = ++sessionListRequestRef.current;
    const selectionAtStart = sessionHistoryRequestRef.current;
    const controller = new AbortController();
    setSessionsLoading(true);
    setSessionsLoadError(false);
    const startTimer = window.setTimeout(() => { void (async () => {
      try {
        const cloud = await loadCloudSessions(controller.signal);
        let list = await mergeLocalChatSessions(cloud);
        if (cancelled || requestId !== sessionListRequestRef.current) return;
        list = list.filter((session) => !endedSessionIdsRef.current.has(session.id));
        setSessions(list);
        initialSessionsLoadedRef.current = true;
        setSessionsLoading(false);
        if (backgroundMode) return;
        if (newChatOnMount) {
          // 挂载即新对话（宿主 hover 入口等）：每次挂载都从空白新会话开始。
          // 不恢复上次会话、不读取历史消息，也不清掉真实会话的 last-session 记录。
          writeAgentLocation({ view: "new", sessionId: initialSidRef.current }, "replace");
          return;
        }
        // 首屏会话选择：优先恢复上次打开的会话；若该会话已被删除（不在列表），
        // 则清除记录并停留在首页（初始新会话空态）；列表为空同样清记录。
        const location = readAgentLocation(navigationKeys);
        if (location?.view === "library") {
          setActiveNavigation("library");
          setMemoryOpen(false);
          setLibraryOpen(true);
          clearLastSession();
          return;
        }
        // 其余侧栏 key（内置 timer/workbench/contacts 与宿主自定义 key）直接切到对应页面。
        if (location && location.view !== "session" && location.view !== "new") {
          setActiveNavigation(location.view);
          return;
        }
        if (location?.view === "new") {
          if (isAgentDraftConsumed()) newSession(false, location.sessionId);
          else writeAgentLocation({ view: "new", sessionId: location.sessionId ?? initialSidRef.current }, "replace");
          setConversationView(true);
          clearLastSession();
          return;
        }
        // 移动端从主页进入时，按会话数量决定首屏；带 session 参数的链接仍直达会话。
        if (window.matchMedia("(max-width: 767.98px)").matches && location?.view !== "session") {
          if (list.length === 0) {
            setConversationView(true);
            clearLastSession();
            writeAgentLocation({ view: "new", sessionId: initialSidRef.current }, "replace");
          } else {
            setConversationView(false);
          }
          return;
        }
        const last = location?.view === "session" ? location.sessionId : readLastSession();
        const lastExists = !!last && list.some((s: { id: string }) => s.id === last);
        if (last && !lastExists) clearLastSession();
        if (lastExists && messagesRef.current.length === 0 && selectionAtStart === sessionHistoryRequestRef.current) {
          await switchSession(last as string, list.find((session: SessionItem) => session.id === last), false);
          if (!location) writeAgentLocation({ view: "session", sessionId: last as string }, "replace");
        } else if (!lastExists) {
          // 没有恢复旧会话：停留在新建任务空态。
          writeAgentLocation({ view: "new", sessionId: initialSidRef.current }, "replace");
        }
      } catch {
        if (!cancelled && requestId === sessionListRequestRef.current) setSessionsLoadError(true);
      } finally {
        if (!cancelled && requestId === sessionListRequestRef.current) {
          setSessionsLoading(false);
          setBooting(false);
        }
      }
    })(); }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      controller.abort();
    };
  }, [isLoggedIn, basePath, embeddedMode, localOwner]);

  // ============ 语音输入（voice-dictation SDK，端点由宿主 basePath 决定）============
  const [mobileVoiceMode, setMobileVoiceMode] = useState(() => voiceEnabled && readMobileVoiceMode());
  const [mobileHolding, setMobileHolding] = useState(false);
  const [rightCtrlRecording, setRightCtrlRecording] = useState(false);
  const [mobileCancelArmed, setMobileCancelArmed] = useState(false);
  // 实时转录（腾讯云 WebSocket）专用：recorder 句柄 + 累计文本。
  const realtimeRecorderRef = useRef<RealtimeRecorderHandle | null>(null);
  const realtimeTextRef = useRef("");
  // 实时转录（点按麦克风按钮）是否在录音中：用于驱动输入框麦克风按钮的「录音/停止」态，
  // 与 dictation 的 recording/transcribing 相互独立（二者不会同时走）。
  const [realtimeActive, setRealtimeActive] = useState(false);
  const voiceSendPendingRef = useRef(false);
  const voiceStartSidRef = useRef("");
  const voiceStartedAtRef = useRef(0);
  const pendingVoiceRef = useRef<UiVoiceRecording | null>(null);
  /**
   * 语音预览模式：**只录音不转写**。
   *
   * 麦克风照常打开，所以 amplitude（音量）是真实的、波形会跟着人说话动；
   * 但转写通道被换成一个永远返回空串的本地实现 —— 松手后不请求转写端点、
   * 不落音频文件、不产生任何费用。用来在没有 ASR 凭据、或只想先看动画效果时用。
   *
   * 注意：不能靠"把 endpoint 指到无效地址"来达到同样目的 —— 那仍会发一次网络请求
   * （可能真的扣费），所以这里必须在**调用方**就把通道换掉。
   */
  const previewTranscriber = useMemo<VoiceTranscriber>(
    () => async () => "",
    []
  );
  const dictationTranscriber = useMemo(
    () =>
      voiceEnabled
        ? voicePreviewOnly
          ? previewTranscriber
          : createDictationTranscriber({
            // 端点可被宿主覆盖：Electron 本地版页面 origin 上没有后端，
            // 需要指向它自己启动的本机 Agent 服务；Web/local 默认走 basePath 同源即可。
            endpoint: voiceTranscribeEndpoint ?? `${basePath}/api/voice/transcribe`,
            fetchImpl: async (input, init) => {
              const persist = voiceSendPendingRef.current && voiceStartSidRef.current === activeSidRef.current;
              if (persist && init?.body instanceof FormData) {
                init.body.append("persist", "1");
                init.body.append("durationMs", String(Date.now() - voiceStartedAtRef.current));
              }
              const response = await apiFetch(input, init);
              if (persist && response.ok) {
                const data = await response.clone().json().catch(() => ({})) as { recording?: UiVoiceRecording };
                pendingVoiceRef.current = data.recording ?? null;
              }
              return response;
            },
            getToken: async () => {
              const response = await apiFetch(voiceTokenEndpoint ?? `${basePath}/api/voice/token`, { method: "POST" });
              if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.error || "无法获取语音令牌");
              }
              const data = await response.json();
              return data.token;
            },
          })
        : null,
    [basePath, voiceEnabled, voiceTokenEndpoint, voiceTranscribeEndpoint, voicePreviewOnly, previewTranscriber]
  );

  const dictation = useVoiceDictation({
    // voiceEnabled=false 时 transcriber 为 null：SDK 运行时对 null 通道安全跳过（初始化不触发录音）；
    // 类型层面 VoiceTranscriber 为非空，这里按运行时语义断言即可。
    transcribe: dictationTranscriber as unknown as VoiceTranscriber,
    // 单次录音硬上限 10 分钟：到点自动截断并转写，结果按当前输入方式处理。
    hardStopMs: MAX_RECORDING_MS,
    onTranscribed: (text: string) => {
      setRightCtrlRecording(false);
      const trimmed = (text || "").trim();
      setVoiceError("");
      if (!trimmed) return;
      if (voiceSendPendingRef.current) {
        voiceSendPendingRef.current = false;
        const voice = pendingVoiceRef.current;
        pendingVoiceRef.current = null;
        if (voiceStartSidRef.current !== activeSidRef.current) return;
        if (!voice?.fileId) {
          setVoiceError("录音未能保存，请重试");
          return;
        }
        if (modelSendBlocked || contentLoading || uploading) {
          setVoiceError("当前暂时无法发送，请稍后重录");
          return;
        }
        handleSend(trimmed, voice);
      } else {
        composerRef.current?.appendText(trimmed); // 桌面端及移动端听写键沿用原行为
      }
    },
    onError: (error: VoiceDictationError) => {
      setRightCtrlRecording(false);
      voiceSendPendingRef.current = false;
      pendingVoiceRef.current = null;
      setMobileHolding(false);
      setMobileCancelArmed(false);
      console.error("[voice-input] error", error);
      setVoiceError(!window.isSecureContext && error?.kind === "unsupported"
        ? "当前局域网 HTTP 地址无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）"
        : error?.message || "语音输入暂时不可用，请稍后重试");
    },
  });

  const recording = dictation.state === "recording" || (voiceRealtimeTranscription && realtimeActive);
  const transcribing = dictation.state === "transcribing";
  const recordingSeconds = dictation.elapsedSec;
  useEffect(() => {
    if (transcribing) setRightCtrlRecording(false);
    if (transcribing && mobileHolding) {
      setMobileHolding(false);
      setMobileCancelArmed(false);
    }
  }, [transcribing, mobileHolding]);

  // 语音录制状态 + 实时音量上报给宿主（用于 Dock 上的声波指示）：
  //  · 状态走回调：低频（按下/松开各一次），宿主可以 setState 切换 UI；
  //  · 音量走 ref：每帧都在变，走回调会让宿主每帧重渲染整棵树，所以只写 ref。
  //
  // 关键：**挂载时的初始 false 绝不上报**。按住 Option 走 Dock 全局接管时，Dock 自己
  // dispatch 了 SET_VOICE_RECORDING；第一段文字出来后 QuickInput 才浮出、才挂载本组件，
  // 此时 recording=false 是"初始值"不是"我停了录音"。如果挂载 effect 立刻上报 false，
  // 就会把 Dock 设的 voiceWindow 清掉，Home 声波在输入框刚出现时就灭了——而此时
  // 用户还按着 Option、ASR 还在跑。只有 kit 自己真正开始录过（上报过 true）之后，
  // 后续再变 false 才是真停止，才上报。
  const voiceStateReportRef = useRef(onVoiceStateChange);
  voiceStateReportRef.current = onVoiceStateChange;
  const voiceReportedOnRef = useRef(false);
  useEffect(() => {
    if (!recording && !voiceReportedOnRef.current) return; // 挂载初始态，不报
    voiceReportedOnRef.current = recording;
    voiceStateReportRef.current?.(recording);
  }, [recording]);
  // 转写阶段（松手 → ASR 返回）单独上报：宿主据此把声波切到"处理中"，
  // 而不是让动画因为录音结束（音量归零）退回初始长度、看起来像没录上。
  // 同样：挂载初始 false 不报，避免冲掉 Dock 自己设的转写态。
  const voiceTranscribingReportRef = useRef(onVoiceTranscribingChange);
  voiceTranscribingReportRef.current = onVoiceTranscribingChange;
  const transcribingReportedOnRef = useRef(false);
  useEffect(() => {
    if (!transcribing && !transcribingReportedOnRef.current) return;
    transcribingReportedOnRef.current = transcribing;
    voiceTranscribingReportRef.current?.(transcribing);
  }, [transcribing]);
  // 振幅转发：**只**负责 kit 自己的「按住说话」（dictation SDK）路径。
  // 另外两条路（Dock 全局按住 Option / 点麦克风走实时转写）都由各自的 onAmplitude 回调
  // 直接写 voiceAmplitudeRef，这里绝不能在 rightCtrlRecording=false 时顺手清零——
  // 否则每次 React re-render（onResult 每几百毫秒 setText 就触发一次）都会把那两条路
  // 刚写进去的真实音量冲成 0，Home 声波就只剩一串平线。
  useEffect(() => {
    if (!voiceAmplitudeRef) return;
    if (rightCtrlRecording) voiceAmplitudeRef.current = dictation.amplitude;
  });

  // ============ 实时转录（腾讯云 WebSocket，边说边出字） ============
  // 与 dictation SDK（录完整段再上传）互斥：voiceRealtimeTranscription=true 时走这条链。
  async function startRealtimeVoice() {
    if (!window.isSecureContext) {
      setVoiceError("当前环境无法使用麦克风");
      return false;
    }
    setVoiceError("");
    realtimeTextRef.current = "";
    // 输入框里已有文字要保留：语音是「接着说」，最终文本 = 已有草稿 + 识别结果，
    // 不是把用户打了一半的字冲掉（与 Dock 按住 Option 的 voiceDraftRef 同一口径）。
    const existingDraft = (composerRef.current?.getText() ?? "").trim();
    try {
      const endpoint = voiceRealtimeSessionEndpoint ?? `${basePath}/api/audio/session`;
      const res = await apiFetch(endpoint, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setVoiceError(data.error || "无法获取实时语音会话");
        return false;
      }
      const data = await res.json() as { connection?: { url?: string } };
      if (!data.connection?.url) throw new Error("语音服务启动失败，请稍后重试");
      realtimeRecorderRef.current = await createTencentRealtimeRecorder({
        url: data.connection.url,
        onResult: ({ text }) => {
          realtimeTextRef.current = text;
          composerRef.current?.setText(existingDraft ? `${existingDraft} ${text}` : text);
        },
        onAmplitude: (v) => {
          if (voiceAmplitudeRef) voiceAmplitudeRef.current = v;
        },
        onError: (e) => { setRealtimeActive(false); setVoiceError(e.message); },
      });
      setRealtimeActive(true);
      return true;
    } catch (e) {
      console.error("[realtime-asr] start failed", e);
      setVoiceError(e instanceof Error ? e.message : "实时语音启动失败");
      realtimeRecorderRef.current = null;
      setRealtimeActive(false);
      return false;
    }
  }
  async function stopRealtimeVoice() {
    const rec = realtimeRecorderRef.current;
    realtimeRecorderRef.current = null;
    setRealtimeActive(false);
    if (voiceAmplitudeRef) voiceAmplitudeRef.current = 0;
    try { await rec?.stop(); } catch { /* 忽略关闭异常 */ }
    // 停止后把累计文本保留在输入框里（composer 已经在 onResult 里实时 setText 过）。
  }

  const toggleVoiceInput = () => {
    // 实时转录（腾讯云 wss）开启时，输入框里的麦克风按钮也走这条链：点按开始录音（边说边出字），
    // 再点停止并保留文本，不再录完整段上传到本地 /api/voice/transcribe。
    if (voiceRealtimeTranscription) {
      if (realtimeActive) {
        void stopRealtimeVoice();
      } else {
        if (!window.isSecureContext) {
          setVoiceError("当前环境无法使用麦克风");
          return;
        }
        setVoiceError("");
        void startRealtimeVoice();
      }
      return;
    }
    if (dictation.state === "transcribing") {
      voiceSendPendingRef.current = false;
      pendingVoiceRef.current = null;
      dictation.cancel();
      return;
    }
    voiceSendPendingRef.current = false;
    if (dictation.state === "recording") dictation.stop();
    else {
      if (!window.isSecureContext) {
        setVoiceError("当前局域网 HTTP 地址无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）");
        return;
      }
      setVoiceError("");
      dictation.start();
    }
  };

  const toggleMobileVoiceMode = () => {
    switchMobileVoiceMode(mobileVoiceMode, (active) => {
      setMobileVoiceMode(active);
      saveMobileVoiceMode(active);
    }, dictation, () => {
      voiceSendPendingRef.current = false;
      pendingVoiceRef.current = null;
      setMobileHolding(false);
      setMobileCancelArmed(false);
    }, () => composerRef.current?.focus());
  };
  // 共享手势（useVoiceHold）：短按喇叭切按住说话模式，长按/大钮按住录音，移出取消、
  // 松开发送。persist 录音与转写发送链路由本组件 onBegin/onFinish 接管。
  const { speakerDown, speakerClick, holdAreaDown } = useVoiceHold({
    dictation,
    onError: (msg) => setVoiceError(msg),
    onTap: toggleMobileVoiceMode,
    onIntent: (cancel) => {
      setMobileCancelArmed(cancel);
      dictation.setFinishIntent(cancel ? "cancel" : "send");
      if (typeof navigator.vibrate === "function") navigator.vibrate(20);
    },
    onBegin: (bounds, x, y) => {
      if (dictation.state !== "idle") return;
      const cancelArmed = x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
      voiceStartSidRef.current = activeSidRef.current;
      voiceStartedAtRef.current = Date.now();
      pendingVoiceRef.current = null;
      voiceSendPendingRef.current = true;
      dictation.setFinishIntent(cancelArmed ? "cancel" : "send");
      setMobileCancelArmed(cancelArmed);
      setMobileHolding(true);
      setVoiceError("");
      void dictation.start();
    },
    onFinish: (cancel) => {
      setMobileHolding(false);
      setMobileCancelArmed(false);
      voiceSendPendingRef.current = !cancel;
      if (cancel) dictation.cancel();
      else dictation.stop();
    },
  });
  useEffect(() => {
    voiceSendPendingRef.current = false;
    pendingVoiceRef.current = null;
    setMobileHolding(false);
    setMobileCancelArmed(false);
    return () => { dictation.cancel(); };
    // Only a session change should reset an in-flight recording.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSid]);

  // ============ 附件上传 ============
  // 文件选择框与拖拽投放都支持批量；逐个发送请求，不限制文件数量。
  async function uploadFiles(files: File[]) {
    if (!files.length || uploadAbortRef.current || uploading) return;
    if (localFiles) {
      setUploading(true); setUploadError("");
      try {
        const refs = await localFiles.register(files);
        if (refs.length !== files.length) throw new Error("有文件或文件夹无法读取，请重新选择");
        setAttachments((current) => [...current, ...refs.map((ref, index) => ({
          url: ref.url, name: ref.name, size: ref.size, kind: ref.kind,
          previewUrl: ref.kind === "file" && isImageFile({ file: files[index] }) ? URL.createObjectURL(files[index]) : undefined,
        }))]);
      } catch (error) { setUploadError(error instanceof Error ? error.message : "本机文件添加失败"); }
      finally { setUploading(false); }
      return;
    }
    setUploadError("");
    const batch = files.map((file) => ({
      id: `${Date.now()}-${Math.random()}`,
      name: file.name,
      size: file.size,
      file,
      previewUrl: isImageFile({ file }) ? URL.createObjectURL(file) : undefined,
      progress: 0,
    }));
    setPendingFiles((current) => [...current, ...batch]);
    setUploading(true);

    // 新会话在首条消息发送前尚未入库；附件读写需要先确认会话归属。
    if (!embedded?.temporary) {
      try {
        const registered = await apiFetch(`${basePath}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: activeSid, title: embedded?.title || "新任务", workspaceDir: workspaceDir || null }),
        });
        if (!registered.ok) throw new Error(`会话注册失败（HTTP ${registered.status}）`);
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "会话注册失败");
        setUploading(false);
        setPendingFiles((current) => current.filter((item) => !batch.some((entry) => entry.id === item.id)));
        for (const item of batch) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        return;
      }
    }

    const url = `${uploadEndpoint || `${basePath}/api/upload`}?session=${encodeURIComponent(activeSid)}`;
    const failed: string[] = [];
    for (const item of batch) {
      if (cancelledUploadIdsRef.current.delete(item.id)) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        continue;
      }
      const xhr = new XMLHttpRequest();
      activeUploadIdRef.current = item.id;
      uploadAbortRef.current = () => xhr.abort();
      let succeeded = false;
      try {
        const data = await new Promise<{
        ok?: boolean;
        url?: string;
        name?: string;
        size?: number;
        fileId?: string;
        error?: string;
      }>((resolve, reject) => {
        const form = new FormData();
        form.append("file", item.file);
        xhr.open("POST", url);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = Math.min(99, Math.round((event.loaded / event.total) * 100));
            setPendingFiles((current) => current.map((entry) => entry.id === item.id ? { ...entry, progress } : entry));
          }
        };
        xhr.onload = () => {
          let response: { ok?: boolean; url?: string; name?: string; size?: number; error?: string };
          try {
            response = JSON.parse(xhr.responseText);
          } catch {
            reject(new Error(`附件上传失败（HTTP ${xhr.status}，响应不是有效 JSON）`));
            return;
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(response.error || `附件上传失败（HTTP ${xhr.status}）`));
            return;
          }
          resolve(response);
        };
        xhr.onerror = () => reject(new Error("网络连接失败，附件未能上传到服务器"));
        xhr.onabort = () => reject(new DOMException("上传已取消", "AbortError"));
        xhr.send(form);
      });
      if (cancelledUploadIdsRef.current.has(item.id)) throw new DOMException("上传已取消", "AbortError");
      if (!data.ok) throw new Error(data.error || "附件上传失败");
      succeeded = true;
      setAttachments((current) => [...current, {
        url: data.url || "",
        name: data.name || item.file.name,
        size: data.size,
        fileId: data.fileId,
        file: item.file,
        previewUrl: item.previewUrl,
      }]);

      // 图片附件 + 疑似不支持图片的模型：发图前就提醒（避免发送后模型说"看不到图片"、
      // 或静默空回复）。仅提示不拦截，用户可自行决定是否换模型。
      if (isImageFile({ file: item.file }) && isLikelyNonVisionModel(selectedModelId, selectedModelSupportsImages)) {
        setVisionWarning(`当前模型「${selectedModelId}」可能不支持图片识别`);
      } else {
        setVisionWarning(null);
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") failed.push(`${item.name}：${err instanceof Error ? err.message : "附件上传失败"}`);
    } finally {
      cancelledUploadIdsRef.current.delete(item.id);
      uploadAbortRef.current = null;
      activeUploadIdRef.current = null;
      setPendingFiles((current) => current.filter((entry) => entry.id !== item.id));
      if (!succeeded && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    }
    if (failed.length) setUploadError(failed.join("；"));
    setUploading(false);
  }

  function clearAttachment(index?: number) {
    if (index === undefined) {
      if (uploadAbortRef.current) uploadAbortRef.current();
      setAttachments((current) => {
        for (const item of current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        return [];
      });
      setPendingFiles((current) => {
        for (const item of current) {
          cancelledUploadIdsRef.current.add(item.id);
        }
        return [];
      });
    } else if (index < attachments.length) {
      setAttachments((current) => current.filter((item, i) => {
        if (i === index && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        return i !== index;
      }));
    } else {
      const item = pendingFiles[index - attachments.length];
      if (item) {
        cancelledUploadIdsRef.current.add(item.id);
        if (activeUploadIdRef.current === item.id) uploadAbortRef.current?.();
        setPendingFiles((current) => current.filter((entry) => entry.id !== item.id));
      }
    }
    setVisionWarning(null);
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    void uploadFiles(files);
    // 选完文件通常紧接着就要提问：把焦点交还输入框，PC / 移动端都直接可继续键入。
    composerRef.current?.focus();
  }
  // ============ 拖拽添加附件 ============
  // 只有中间聊天栏可以接收聊天附件；窗口其他区域仅阻止浏览器打开文件。
  const [dragOver, setDragOver] = useState(false);
  const uploadFileDisabledRef = useRef(!uploadEnabled);
  uploadFileDisabledRef.current = !uploadEnabled;
  const uploadFileRef = useRef(uploadFiles);
  uploadFileRef.current = uploadFiles;
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const isChatArea = (target: EventTarget | null) =>
      target instanceof Element && Boolean(target.closest(".chat-main[data-file-drop-target]"))
      && target.closest(".chat-shell") === shellRef.current;
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const accepts = isChatArea(e.target) && !uploadFileDisabledRef.current;
      if (!(e.target instanceof Element && e.target.closest(".chat-library-content[data-file-drop-target]"))) {
        e.dataTransfer!.dropEffect = accepts ? "copy" : "none";
      }
      setDragOver(accepts);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragOver(false);
      if (!isChatArea(e.target) || uploadFileDisabledRef.current) return;
      if (!localFiles && Array.from(e.dataTransfer?.items ?? []).some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
        setUploadError("Web 暂不支持添加文件夹，请选择单个文件上传");
        return;
      }
      void uploadFileRef.current(Array.from(e.dataTransfer?.files ?? []));
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragOver(false);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // ============ 接入会话（把左栏群聊 / 1v1 聊天拖进工具栏）============
  // 会话级持久接入：拖入后本会话后续每一轮都能访问这些群的 uploads（只读）/artifacts（可读写）。
  // 工具栏「+」右侧横向排列胶囊；放不下群名则转纯头像，再放不下则裁剪，最右 › 弹框列表删除。
  const [refs, setRefs] = useState<GroupRef[]>([]);
  useEffect(() => {
    if (draftHydratedSid !== activeSid) return;
    saveChatDraft(activeSid, composerRef.current?.getText() ?? "", attachments, { references: composerReferences });
  }, [activeSid, draftHydratedSid, attachments, composerReferences]);
  const [refDialogOpen, setRefDialogOpen] = useState(false);
  const addRef = (ref: GroupRef) =>
    setRefs((prev) => (prev.some((p) => p.id === ref.id) ? prev : [...prev, ref]));
  const removeRef = (id: string) =>
    setRefs((prev) => prev.filter((p) => p.id !== id));
  // 切换会话时清空接入列表，避免串到别的会话
  useEffect(() => {
    setRefs([]);
    setReferenceMenuOpen(false);
    setRefDialogOpen(false);
  }, [activeSid]);

  // ============ 发送 ============

  /** 拉取当前模型上下文窗口上限（/api/models/context，服务端缓存 5 分钟）。
   *  首轮 send 时该请求先于 /api/chat（服务端才创建 SDK 会话并后台预取）到达 → 缓存必空 → null；
   *  因此首轮 cost_info（usedTokens 首次有值）时若 maxTokens 仍为 null 会再补拉一次，
   *  此时预取已完成、缓存命中 → 圆环拿到真实上限。 */
  async function refreshContextLimit(sid: string) {
    if (agentMode !== "codebuddy") return;
    try {
      const mcRes = await apiFetch(
        `${basePath}/api/models/context?model=${encodeURIComponent(selectedModelId || "")}&sid=${encodeURIComponent(sid)}`,
        { cache: "no-store" },
      );
      if (mcRes.ok) {
        const mc = (await mcRes.json()) as { maxTokens?: number | null };
        const v = mc.maxTokens ?? null;
        if (v != null) {
          maxTokensRef.current = v;
          setCtxUsage((prev) => ({ ...prev, maxTokens: v }));
        }
      }
    } catch {
      /* 路由/网络失败：忽略（环形无上限时只显示 token 数） */
    }
  }

  async function send(text?: string, att?: UiAttachment[] | null, recovery?: { sid: string; runId: string; sdkSid: string; mode: NonNullable<ModelInfo["agentMode"]> }, voice?: UiVoiceRecording, extraPrompt?: string | null, queuedReferences?: Array<{ sourceId: string; reference: ComposerReference }>) {
    // Each concurrent request owns its stream buffers and ticker. A component-level
    // ref lets one session's SSE chunks be flushed into another session's message.
    const gotStreamRef = { current: false };
    const streamBufRef = { current: "" };
    const streamTickerRef: { current: ReturnType<typeof setInterval> | null } = { current: null };
    type ThinkingStreamBuf = { index: number; text: string };
    const thinkingBufRef: { current: ThinkingStreamBuf | null } = { current: null };
    // Explicit attachments come from already-submitted queue items; new
    // composer submissions must wait for the current upload to finish.
    if (att === undefined && (uploading || uploadAbortRef.current)) return;
    const sid = recovery?.sid ?? activeSid;
    const rt = getRt(sid);
    const runMode = recovery?.mode ?? agentMode;
    if (!recovery && (agentModesPending || !agentModes.some((mode) => mode === runMode))) return;
    if (!recovery && runMode === "codebuddy" && autoFetchModels && (!modelsLoaded || !modelOptions.length)) return;
    const runModel = runMode === "codebuddy" ? selectedModelId || undefined : runMode === "dsh" ? selectedDshModel : undefined;
    const runCodexModelKey = runMode === "codex" ? selectedCodexModel : undefined;
    // input 已移入 ChatComposer：调用方必须显式传 text（composer 发送/场景建议/队列冲刷/插话均带参）
    const content = (recovery ? [...rt.messages].reverse().find((message) => message.role === "user")?.content : text ?? "")?.trim() ?? "";
    const curAttachments = recovery ? [] : att !== undefined ? att ?? [] : attachments;
    const selectedReferences = queuedReferences ?? composerReferences;
    const curAttachment = curAttachments[0] ?? null;
    // 空内容不处理
    if (!content && !curAttachments.length) return;
    if (pendingMembers.length && !conversationMembers.length && !recovery && !voice) {
      if (!content) return;
      const oneToOneId = findOneToOneReuse(pendingMembers);
      setConversationView(true);
      if (homeContacts && pendingMembers.length === 1) onExistingPersonChatOpened?.();
      if (oneToOneId) {
        // 点发送才跳转：先切到已有 1:1（不建新会话），切换完成后再投递消息。
        consumeAgentDraft();
        try {
          await switchSession(oneToOneId);
        } catch { /* 目标会话加载失败：回退为新建会话流程 */ }
        setCoworkSubmission({ text: content, attachments: curAttachments });
      } else {
        setCoworkSubmission({ text: content, attachments: curAttachments });
        if (readAgentLocation(navigationKeys)?.view === "new") {
          consumeAgentDraft();
          writeAgentLocation({ view: "session", sessionId: sid });
        }
      }
      return;
    }
    setConversationView(true);
    if (!embeddedMode && !backgroundMode && readAgentLocation(navigationKeys)?.view === "new") {
      consumeAgentDraft();
      writeAgentLocation({ view: "session", sessionId: sid });
    }

    // Web 通知权限：首次发消息时顺带请求（发送按钮点击是用户手势；
    // 无手势的 requestPermission 在 Chrome/Edge 会被静默忽略）。桌面壳无需授权。
    if (
      !isDesktopApp() &&
      !isDingTalkNotificationWebView() &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      Notification.requestPermission().then(permission => { if (permission === "granted") void ensureWebPushSubscription(basePath); }).catch(() => {});
    }

    // 回复生成中：不直接发送，先进入待发队列（输入框保持可用，可继续输入/排队/插话）
    if (rt.busy && !recovery) {
      rt.queue = rt.queue || [];
      rt.queue.push({
        id: generateSessionId(),
        text: content,
        voice,
        attachment: curAttachment ? { url: curAttachment.url, name: curAttachment.name, size: curAttachment.size, kind: curAttachment.kind } : null,
        attachments: curAttachments,
        references: selectedReferences,
        prompt: extraPrompt?.trim() || undefined,
        createdAt: new Date().toISOString(),
      });
      // 输入框文字已由 ChatComposer 在提交时清空
      clearAttachment();
      if (activeSidRef.current === sid) setPendingQueue([...rt.queue]);
      return;
    }

    const parts: string[] = [];
    for (const file of curAttachments) parts.push(`[附件] ${file.name}`);
    if (content) parts.push(content);
    const fullText = parts.join("\n");

    const multiFileTurns: UiMessage[] = curAttachments.length > 1
      ? [
          ...curAttachments.map((file, index) => ({ role: "user" as const, senderSub: selfSub || null, senderName: initialUser?.name || null, senderAvatar: initialUser?.avatar || null,
            content: `[附件] ${file.name}`, attachment: file, attachments: [file], createdAt: new Date(Date.now() + index).toISOString() })),
          ...(content || voice ? [{ role: "user" as const, senderSub: selfSub || null, senderName: initialUser?.name || null, senderAvatar: initialUser?.avatar || null,
            content, voice, attachments: [], createdAt: new Date(Date.now() + curAttachments.length).toISOString() }] : []),
        ]
      : [];
    const userTurns: UiMessage[] = recovery
      ? [[...rt.messages].reverse().find((message) => message.role === "user")!]
      : curAttachments.length > 1
        ? multiFileTurns
        : [{ role: "user", senderSub: selfSub || null, senderName: initialUser?.name || null, senderAvatar: initialUser?.avatar || null, content: fullText, voice, attachment: curAttachment || undefined, attachments: curAttachments, createdAt: new Date().toISOString() }];
    // 会话首条用户消息判定：进入本轮的 rt.messages 里还没有任何 user 消息（恢复的历史会话则跳过）
    const isFirstTurn = !rt.messages.some((m) => m.role === "user");
    const imageFiles = localFiles ? [] : curAttachments.filter((file) => file.file && isImageFile(file));
    if (imageFiles.length) for (const turn of userTurns) {
      const files = (turn.attachments ?? []).filter(file => file.file && isImageFile(file));
      if (files.length) turn.images = await Promise.all(files.map(async file => ({ base64: await fileToBase64(file.file!), media_type: file.file!.type || "image/png" })));
    }
    const nextMessages = recovery ? [...rt.messages] : [...rt.messages, ...userTurns];
    const initialMsgs: UiMessage[] = [
      ...nextMessages,
      { role: "assistant", content: "", thinking: "", modelInfo: { agentMode: runMode }, steps: [{ thinking: "", text: "", tool: null, secs: null }] },
    ];
    rt.messages = initialMsgs;
    // 新一轮开始：重算「待确认」集合（新用户消息置尾后，旧提问卡片的挂起态随之解除）
    syncPendingQuestionSids();
    rt.openThinking = new Set();
    stopThinkingTimer(rt);
    rt.thinkingStart = Date.now();
    rt.elapsedStart = Date.now(); // 共用时：从用户发送消息开始计时
    rt.stepStarts = new Map([[1, Date.now()]]);
    startThinkingTimer(rt);
    // 输入框文字已由 ChatComposer 在提交时清空
    if (!recovery) clearAttachment();
    setUploadError("");
    rt.errorMsg = null;
    rt.reconnectAttempt = 0;
    rt.reconnectExhausted = false;
    // 新一轮运行开始：重置「本轮已查看」标记（上一轮的查看状态已随上轮完成结算）
    rt.viewedDuringRun = false;
    try { window.localStorage.removeItem(`agent-kit:run-failure:${sid}`); } catch { /* ignore */ }
    markBusy(sid, true);
    // 同步到渲染
    if (activeSidRef.current === sid) {
      // 发送后置顶刚发的用户消息，给 LLM 回复预留下方空间（等待渲染完成后执行置顶滚动）
      markSend();
      setMessages([...initialMsgs]);
      setOpenThinking(new Set());
      setErrorMsg(null);
      setBusy(true);
      // 本轮开始：重置首增量标记（首次流式内容到达时 markStreaming 置位）
      gotStreamRef.current = false;
    }

    const abortController = new AbortController();
    rt.abort = abortController;
    const runId = recovery?.runId ?? crypto.randomUUID();
    rt.runId = runId;
    // 桌面壳：仅「用户↔AI」单聊（无待选联系人、当前会话非人际）本地落盘，不注册云端；
    // 人际 1v1/群聊与 web 端保持云端逻辑
    const existingForRun = sessionsRef.current.find((item) => item.id === sid);
    const localProjectRun = localChat && pendingMembers.length === 0 && isAiOnlyChat(existingForRun);
    let initialLocalSave: Promise<void> | null = null;
    if (localProjectRun && !recovery) {
      const now = new Date().toISOString();
      const previous = sessionsRef.current.find((item) => item.id === sid);
      const session: SessionItem = {
        ...previous, id: sid, title: previous?.title || "新任务",
        ...(workspaceDir ? { workspaceDir, projectDir: workspaceDir } : {}),
        updatedAt: now, createdAt: previous?.createdAt || now, modelId: selectedModelId, aiUnread: false,
      };
      // 落盘用 nextMessages（本轮用户消息），**不能**带 initialMsgs 末尾那条空 assistant 占位：
      // 占位写进历史后，另一个实例/刷新后打开这个会话会拿到一个永不填充的空气泡，
      // 还会让「末尾是用户消息 = 这一轮还没落答复」的判定失效（桌面卡片与聊天窗因此不一致）。
      initialLocalSave = localChatSave(localOwner, session, nextMessages)
        .catch((error) => console.warn("[agent-kit] 新会话本地保存失败:", error));
      setSessions((list) => [session, ...list.filter((item) => item.id !== sid)]);
    }
    /**
     * 广播「这个会话开始跑了」：同页面里正在看这个会话的其它实例（宿主真实聊天窗）
     * 会顺着 /chat/run 接管这轮的流。
     *
     * 必须等「本轮用户消息」落盘之后再广播：旁观实例接到通知会先读历史确认末尾是这一轮的用户消息，
     * 读早了看到的还是上一轮的答复 → 判定成"这轮已经有答复"，接管直接放弃（只剩收尾时补历史）。
     * recovery（自己就是在接管别人的 run）不广播，避免实例之间互相唤醒。
     */
    if (!recovery) {
      const announceStart = () => publishRunEvent({ type: "start", sessionId: sid, origin: runEventOriginRef.current });
      if (initialLocalSave) void initialLocalSave.catch(() => {}).then(announceStart);
      else announceStart();
    }
    if (recovery) rt.sdkSid = recovery.sdkSid;
    let assistantSaved = false;
    /** 本机会话这一轮的落盘 promise：广播「跑完了」必须等它落地，否则旁观实例读到的是旧历史。 */
    let localRunPersisted: Promise<void> | null = null;
    let keepActiveRun = false;
    let turnCompleted = false;

    try {
      if (isLoggedIn && !embedded?.temporary && !recovery && !localProjectRun) {
        // 每次都 upsert 注册（后端幂等）：防止会话被删后 rt.sessionRegistered 仍为 true 导致 404；
        // 首条消息带上工作目录（沙箱范围），ON CONFLICT 不覆盖已存值。
        // 注册恒用「稳定会话 id」sid（= 侧边栏的一条会话 = 一行），绝不用编辑重发时临时换的 rt.sdkSid：
        // 后者形如 `${sid}_${后缀}`，鉴权时由服务端取 '_' 前的主会话 id 校验归属（见 session-access.ts）。
        // 若拿临时 sdkSid 注册，就会凭空多插一行空白会话——侧边栏每次编辑都冒出一个「新任务」。
        try {
          // 建会话时一并带上 contactIds：服务端在同一事务里写入成员，
          // 会话一落库就是群聊形态。若拆成「先建会话 → 再 POST /members」两次请求，
          // 中间那一瞬 member_count=0，会话列表会先按「人机聊天」渲染再跳成群聊。
          const regRes = await apiFetch(`${basePath}/api/sessions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: sid,
              title: embedded?.title || "新任务",
              workspaceDir: localFiles ? null : workspaceDir || null,
              projectDir: localFiles ? workspaceDir : null,
              viewLayout: split ? "split" : "single",
              contactIds: isFirstTurn ? pendingMembers.map(member => member.contactId) : [],
            }),
          });
          if (!regRes.ok) {
            // 注册失败必须让后续请求知道自己没落库：否则第二轮 resume=true 时
            // 服务端 assertChatAccess 查不到该 sessionId → 403，用户只看到
            // "会话不属于当前用户"，而真正原因（注册 401/503/500）被静默吞掉。
            console.error(`[agent-kit] 会话注册失败 HTTP ${regRes.status}（sessionId=${sid}），后续续轮可能 403`);
          } else {
            rt.sessionRegistered = true;
            // 群聊成员已在建会话时落库，直接同步本地状态（会话列表/顶栏据此显示群聊样式）
            if (isFirstTurn && pendingMembers.length) {
              const regData = await regRes.json().catch(() => null) as { members?: Array<{ provider: string; contactId: string; name: string; avatar: string }> } | null;
              if (Array.isArray(regData?.members) && regData.members.length) {
                setConversationMembers(regData.members);
                setConversationOwnerSub(selfSub);
              } else {
                setConversationMembers(pendingMembers.map(member => ({ provider: member.provider ?? "", contactId: member.contactId, name: member.name, avatar: member.avatar })));
                setConversationOwnerSub(selfSub);
              }
            }
          }
        } catch (e) {
          console.error("[agent-kit] 会话注册请求异常:", e);
        }
        // 兜底：仅当注册失败（或未走注册分支）时，才用旧的二次请求补写成员。
        // 正常路径已在上面随注册一并落库，这里不会再发一次。
        if (isFirstTurn && pendingMembers.length && !conversationMembers.length) {
          try {
            const membersRes = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/members`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contactIds: pendingMembers.map(member => member.contactId) }),
            });
            if (membersRes.ok) {
              const membersData = await membersRes.json().catch(() => null);
              if (Array.isArray(membersData?.members)) setConversationMembers(membersData.members);
              setConversationOwnerSub(selfSub);
            }
          } catch (e) { console.warn("[agent-kit] 会话成员写入异常:", e); }
        }
        if (isFirstTurn && pendingMembers.length) setPendingMembers([]);
        try {
          for (const turn of userTurns) {
          const turnAttachments = turn.attachments ?? (turn.attachment ? [turn.attachment] : []);
          const saveRes = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              role: "user",
              content: turn.content,
              voice: turn.voice ?? null,
              images: turn.images ?? null,
              // 附件随消息入库：刷新/重开后用户消息的附件条不消失；删会话时也据此清理磁盘文件
              attachment: turn.attachment
                ? { url: turn.attachment.url, name: turn.attachment.name, size: turn.attachment.size, fileId: turn.attachment.fileId, kind: turn.attachment.kind }
                : null,
              attachments: turnAttachments.map(({ url, name, size, fileId, kind }) => ({ url, name, size, fileId, kind })),
            }),
          });
          if (!saveRes.ok) {
            console.warn(`[agent-kit] 用户消息落库失败 HTTP ${saveRes.status}`, await saveRes.text().catch(() => ""));
            if (turn.voice) throw new Error("语音消息保存失败，请稍后重试");
          } else {
            const saved = await saveRes.json() as { id?: number };
            if (Number.isSafeInteger(saved.id) && saved.id! > 0) {
              turn.id = saved.id;
              if (activeSidRef.current === sid) setMessages([...rt.messages]);
            }
          }
          }
        } catch (e) {
          console.warn("[agent-kit] 用户消息落库异常:", e);
          if (voice) throw e;
        }
        // 发送即入库：会话行已 upsert（title 暂为"新对话"），立刻刷新侧边栏让新对话马上出现，
        // 不必等整轮 agent 跑完（长任务期间侧边栏就能看到记录）；
        // 标题随后由 auto-title 总结后更新，消息随每轮交互持续写入。
        refreshSessions();
      }
      // 首条用户消息：发送后立即异步生成 LLM 标题（不等答复完成）。
      // transport 已改为每次新建实例，标题 query 与主对话流并发不冲突；
      // 标题提前落库，即使此刻关闭应用，重启后也不再显示"新对话"。
      // 当前所选模型并发时可能 429：失败后按 5s / 15s 退避重试两次（429 多为瞬时，
      // 主对话建立后的间隙可成功）；仍失败则由答复流中 SDK 的 ai-title 兜底。
      if (isFirstTurn && !recovery && !embedded?.temporary && (localProjectRun || isLoggedIn)) {
        // 云端会话沿用快速占位；本机会话等待独立标题请求，避免把用户原文当成标题。
        const quickLocal = localProjectRun ? "" : quickSessionTitle(fullText);
        if (quickLocal) {
          setSessions((list) => list.map((x) => (x.id === sid ? { ...x, title: quickLocal } : x)));
        }
        const tryAutoTitle = (attempt: number) => {
          apiFetch(localProjectRun
            ? localApiRoute(`/api/sessions/${encodeURIComponent(sid)}/auto-title`)
            : `${basePath}/api/sessions/${encodeURIComponent(sid)}/auto-title`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userMessage: fullText, agentMode: runMode, model: runModel, codexModelKey: runCodexModelKey,
              ...(localProjectRun ? { owner: localOwner } : {}) }),
          })
            .then(async (r) => {
              if (!r.ok) {
                const body = await r.text().catch(() => "");
                throw new Error(`HTTP ${r.status} ${body.slice(0, 200)}`);
              }
              const data = await r.json().catch(() => null);
              if (typeof data?.title === "string" && !isInvalidGeneratedTitle(data.title)) {
                console.log(`[agent-kit] auto-title 成功 title="${data.title}"`);
                setSessions((list) => list.map((s) => (s.id === sid ? { ...s, title: data.title } : s)));
                return true;
              }
              console.warn("[agent-kit] auto-title 响应无 title 字段:", JSON.stringify(data));
              return false; // LLM 未返回标题（渠道失败/模型无输出）
            })
            .then((ok) => {
              if (ok) return;
              if (attempt < 2) {
                setTimeout(() => tryAutoTitle(attempt + 1), attempt === 0 ? 5000 : 15000);
              } else {
                console.warn("[agent-kit] auto-title 重试仍失败（LLM 未返回标题，答复流中 SDK ai-title 将兜底）");
              }
            })
            .catch((e) => {
              console.warn("[agent-kit] auto-title 请求失败:", e instanceof Error ? e.message : e);
              if (attempt < 2) {
                setTimeout(() => tryAutoTitle(attempt + 1), attempt === 0 ? 5000 : 15000);
              }
            });
        };
        // 等首条消息的本地会话记录创建完再请求标题，避免标题先返回却找不到落库目标。
        if (initialLocalSave) void initialLocalSave.then(() => tryAutoTitle(0));
        else tryAutoTitle(0);
      }
      // 上下文容量：拿当前模型上下文窗口上限（服务端缓存 5 分钟；CLI 不支持时 maxTokens=null → 只显示 token 数）
      // 注意时序：/api/chat 里服务端才创建 SDK 会话并后台预取模型上限（prefetchModelContext），
      // 本请求先于它到达 → 首轮缓存必空 → 返回 null；随后由首轮 cost_info 到达时补拉（见 cost_info 分支）。
      if (!embeddedMode) void refreshContextLimit(sid);
      const resume = rt.sessionStarted;
      if (!recovery) {
        try { window.localStorage.setItem(`agent-kit:active-run:${sid}`, JSON.stringify({ runId, sdkSid: rt.sdkSid, mode: runMode, startedAt: Date.now() })); } catch { /* ignore */ }
      }
      let res: Response | null = null;
      const legacyCtx = !embeddedMode ? conversationContext?.({ sessionId: sid, messages: nextMessages })?.trim() : "";
      const capCtx = !embeddedMode
        ? buildCapabilitiesContext(capabilities, { sessionId: sid, messages: toCapMessages(nextMessages), channel: "chat" })
        : "";
      const referenceContext = selectedReferences.map(({ sourceId, reference }) =>
        `[引用: ${sourceId}/${reference.id} · ${reference.label}]\n${reference.context}`).join("\n\n");
      const hostContext = [legacyCtx, capCtx, referenceContext].filter(Boolean).join("\n\n");
      try { res = recovery
        ? await apiFetch(endpointUrl(localChatRoute("/run"), { sessionId: rt.sdkSid, runId, after: "0" }), { cache: "no-store", signal: abortController.signal })
        : await apiFetch(chatEndpoint || `${basePath}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          messages: [
            ...(embedded?.systemPrompt ? [{ role: "system", content: embedded.systemPrompt }] : []),
            ...(hostContext ? [{ role: "system", content: hostContext }] : []),
            // 场景专属系统提示词：随每轮请求注入 AI（服务端把所有 system 消息拼进业务上下文）；
            // 建议级提示词仅随该建议触发的本次发送注入，与场景级按序拼接（场景在前、建议在后）
            ...(() => {
              const scenePrompt = activeScene?.prompt?.trim();
              const suggestionPrompt = extraPrompt?.trim();
              return scenePrompt || suggestionPrompt
                ? [{ role: "system" as const, content: [scenePrompt, suggestionPrompt].filter(Boolean).join("\n") }]
                : [];
            })(),
            ...nextMessages.map((m, index) => {
              const context = embedded && index === nextMessages.length - 1 && m.role === "user" ? embedded.context?.().trim() : "";
              return { role: m.role, content: context ? `[当前应用状态]\n${context}\n[/当前应用状态]\n\n${m.content}` : m.content, images: m.images };
            }),
          ],
          attachment: curAttachment ? { url: curAttachment.url, name: curAttachment.name } : undefined,
          attachments: curAttachments.map(({ url, name, fileId }) => ({ url, name, fileId })),
          scene,
          sessionId: rt.sdkSid,
          runId,
          resume,
          temporary: embedded?.temporary === true,
          // 用户选择的模型（未配置模型下拉时为空串，服务端忽略）
          model: runModel,
          agentMode: runMode,
          comparisonRun: split,
          permissionMode: canPickWorkspace ? permissionMode : undefined,
          codexModelKey: runCodexModelKey,
          // 工作目录（沙箱范围）：服务端以会话记录为权威，这里兜底首轮注册竞态
          workspaceDir: localFiles ? undefined : workspaceDir || undefined,
          // 会话级接入的群/1v1：每轮请求都带上全部接入 id，服务端逐个挂载目录
          refGroupIds: refs.map((r) => r.id),
        }),
      }); } catch (error) {
        if (abortController.signal.aborted) throw error;
        console.warn("[agent-kit] 初始任务连接中断，尝试按 runId 恢复:", error);
      }
      if (res && (!res.ok || !res.body) && res.status < 500 && !(recovery && res.status === 404)) {
        // 详细失败原因：读取服务端错误体（JSON error/message 或纯文本），拼进气泡与错误框。
        // 此前一律显示「（请求失败，请稍后重试）」，登录失效(401)、服务端异常(500)、
        // 网关错误(502/504) 等任何一层失败都被吞掉，用户无法判断问题出在哪。
        let errDetail = "";
        if (res.body) {
          const rawBody = await res.text().catch(() => "");
          try {
            const j = JSON.parse(rawBody) as { error?: unknown; message?: unknown };
            if (typeof j.message === "string" && j.message) errDetail = j.message;
            else if (typeof j.error === "string") errDetail = j.error;
            else if (j.error && typeof j.error === "object") {
              const eo = j.error as { message?: unknown };
              if (typeof eo.message === "string" && eo.message) errDetail = eo.message;
            }
          } catch {
            errDetail = rawBody.trim().slice(0, 300);
          }
        }
        const statusInfo = res.status ? `HTTP ${res.status}` : "无响应体";
        const reason = errDetail.trim() ? `：${errDetail.trim().slice(0, 300)}` : "：服务端未返回错误详情（可查看引擎日志）";
        const failText = `（请求失败，${statusInfo}${reason}）`;
        console.error("[agent-kit] /api/chat 请求失败:", statusInfo, errDetail.trim().slice(0, 500));
        rt.messages[rt.messages.length - 1] = { role: "assistant", content: failText, revealAt: Date.now() };
        rt.errorMsg = failText;
        if (activeSidRef.current === sid) {
          setMessages([...rt.messages]);
          setErrorMsg(failText);
        }
        return;
      }
      if (res?.ok && res.body) rt.sessionStarted = true;
      else res = null;
      let lastEventId = 0;
      let receivedDone = false;
      let receivedError = false;
      let receivedCancelled = false;
      let attempts = 0;
      let reconnectStartedAt: number | null = null;
      let retryAfterMs = 0;
      let steps: UiStep[] = [{ thinking: "", text: "", tool: null, secs: null }];
      let pendingText = "";
      // 每轮开始重置分片缓冲（防跨轮残留：上轮异常结束可能遗留未拼文本/常驻 ticker）
      streamBufRef.current = "";
      thinkingBufRef.current = null;
      if (streamTickerRef.current) {
        clearInterval(streamTickerRef.current);
        streamTickerRef.current = null;
      }
      /** 首个流式内容增量到达：幂等，仅第一次生效 */
      const markStreaming = () => {
        if (!gotStreamRef.current) {
          gotStreamRef.current = true;
        }
      };
      const ensureStep = (index: number): UiStep => {
        while (steps.length < index) steps.push({ thinking: "", text: "", tool: null, secs: null });
        return steps[index - 1];
      };
      const parkPendingText = (index: number) => {
        if (!pendingText && !streamBufRef.current) return;
        // 分片缓冲中未揭示的文本一并归入该步，防止 tool/thinking 事件切换时丢尾部字
        if (streamBufRef.current) {
          pendingText += streamBufRef.current;
          streamBufRef.current = "";
        }
        const step = ensureStep(index);
        step.text = (step.text || "") + pendingText;
        pendingText = "";
      };
      const applyUpdate = () => {
        const last = rt.messages[rt.messages.length - 1] || {};
        const prevSteps = last.steps || [];
        rt.messages[rt.messages.length - 1] = {
          ...last,
          role: "assistant",
          content: pendingText,
          revealAt: pendingText !== last.content ? Date.now() : last.revealAt,
          steps: steps.map((s, si) => ({
            ...s,
            answered: prevSteps[si]?.answered || s.answered,
          })),
          thinkingSecs: last.thinkingSecs,
        };
        // 本轮流式内容产出时用户正在查看该会话 → 视为已查看本轮（用于侧边栏绿圈判定）。
        // 只在「有内容落地且在场」时置位：发送后立刻切走（内容到达时不在场）不会误标已读。
        // 宿主 UI 不可见（readSuppressed）时一律不置位。
        if (!backgroundMode && !readSuppressedRef.current && activeSidRef.current === sid && (pendingText.trim() || steps.some((s) => s.text || s.tool))) {
          rt.viewedDuringRun = true;
        }
        if (activeSidRef.current === sid) setMessages([...rt.messages]);
        // 消息发生变化：同步侧边栏「待确认」集合（ask_question 到达 / 流继续 / 本轮收尾均经此刷新）
        syncPendingQuestionSids();
      };
      // 合并正文/思考的密集更新；空转自停，下次事件再启动。
      const ensureStreamTicker = () => {
        if (!streamTickerRef.current) streamTickerRef.current = setInterval(tickStreamBuf, STREAM_TICK_MS);
      };
      // 思考缓冲 flush：当前步未揭示的思考文本一次性拼入（步切换/流结束/中断时）
      const flushThinkingBuf = () => {
        const tb = thinkingBufRef.current as ThinkingStreamBuf | null;
        if (tb && tb.text) {
          ensureStep(tb.index).thinking += tb.text;
          tb.text = "";
        }
      };
      // 每次排空收到的增量，避免大块 SSE 积压成数秒的打字机队列。
      const tickStreamBuf = () => {
        let touched = false;
        const buf = streamBufRef.current;
        if (buf) {
          pendingText += buf;
          streamBufRef.current = "";
          touched = true;
        }
        const tb = thinkingBufRef.current as ThinkingStreamBuf | null;
        if (tb && tb.text) {
          ensureStep(tb.index).thinking += tb.text;
          tb.text = "";
          touched = true;
        }
        if (!touched) {
          if (streamTickerRef.current) {
            clearInterval(streamTickerRef.current);
            streamTickerRef.current = null;
          }
          return;
        }
        applyUpdate();
      };
      // 流结束/中断立即排空数据；Markdown 的尾部渐入独立收尾。
      const flushStreamBuf = () => {
        if (streamTickerRef.current) {
          clearInterval(streamTickerRef.current);
          streamTickerRef.current = null;
        }
        let touched = false;
        if (streamBufRef.current) {
          pendingText += streamBufRef.current;
          streamBufRef.current = "";
          touched = true;
        }
        if (thinkingBufRef.current?.text) {
          flushThinkingBuf();
          touched = true;
        }
        if (touched) applyUpdate();
      };
      // A lost reader never resends the user turn. It attaches to the same run
      // and replays only frames after the last fully processed event id.
      while (!receivedDone && !receivedError && !receivedCancelled) {
        if (abortController.signal.aborted) throw new DOMException("stopped", "AbortError");
        if (!res?.ok || !res.body) {
          reconnectStartedAt ??= Date.now();
          const remainingMs = 10 * 60 * 1000 - (Date.now() - reconnectStartedAt);
          if (remainingMs <= 0) {
            keepActiveRun = true;
            throw new Error("连接持续中断，已暂停自动重连。任务可能仍在执行；刷新会话可继续接收结果。");
          }
          attempts += 1;
          rt.reconnectAttempt = attempts;
          if (activeSidRef.current === sid) setReconnectAttempt(attempts);
          // 前五次快速恢复，之后降到最多每 30 秒一次；抖动避免多客户端同时冲击服务。
          const backoffCap = attempts <= 5 ? Math.min(1000 * 2 ** (attempts - 1), 8000) : 30_000;
          const delayMs = Math.min(remainingMs, Math.max(retryAfterMs, Math.round(backoffCap * (.5 + Math.random() * .5))));
          retryAfterMs = 0;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { abortController.signal.removeEventListener("abort", stopped); resolve(); }, delayMs);
            const stopped = () => { clearTimeout(timer); reject(new DOMException("stopped", "AbortError")); };
            abortController.signal.addEventListener("abort", stopped, { once: true });
            if (abortController.signal.aborted) stopped();
          });
          const reconnectUrl = endpointUrl(localChatRoute("/run"), {
            sessionId: rt.sdkSid, runId, after: String(lastEventId),
          });
          const reconnectAbort = new AbortController();
          const stopReconnect = () => reconnectAbort.abort();
          abortController.signal.addEventListener("abort", stopReconnect, { once: true });
          const reconnectTimeout = setTimeout(stopReconnect, 15_000);
          try {
            const next = await apiFetch(reconnectUrl, { cache: "no-store", signal: reconnectAbort.signal });
            if (next.status >= 400 && next.status < 500 && next.status !== 408 && next.status !== 429) {
              throw new Error(`重新连接被拒绝（HTTP ${next.status}）`);
            }
            if (next.status === 429 || next.status === 503) {
              const header = next.headers.get("Retry-After");
              const seconds = Number(header);
              const date = header ? Date.parse(header) : NaN;
              retryAfterMs = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 0;
              retryAfterMs = Math.max(0, Math.min(60_000, retryAfterMs));
            }
            res = next.ok && next.body ? next : null;
          } catch (error) {
            if (abortController.signal.aborted || (error instanceof Error && error.message.includes("被拒绝"))) throw error;
            res = null;
          } finally {
            clearTimeout(reconnectTimeout);
            abortController.signal.removeEventListener("abort", stopReconnect);
          }
          continue;
        }
        rt.sessionStarted = true;
        rt.reconnectAttempt = 0;
        if (activeSidRef.current === sid) setReconnectAttempt(0);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try { while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const eventId = Number(frame.match(/^id:\s*(\d+)$/m)?.[1] || 0);
          if (eventId && eventId <= lastEventId) continue;
          const msgEvent = parseSseFrame(frame);
          if (!msgEvent) continue;
          if (eventId) {
            lastEventId = eventId;
            attempts = 0;
            reconnectStartedAt = null;
          }
          const evData = msgEvent.data || {};
          if (msgEvent.event === "done") receivedDone = true;
          if (msgEvent.event === "cancelled") receivedCancelled = true;
          if (msgEvent.event === "thinking") {
            markStreaming();
            const index = Number(evData.index) || 1;
            if (index > steps.length) {
              if (index > 1) parkPendingText(index - 1);
              rt.stepStarts.set(index, Date.now());
            }
            // 思考增量参与同一个渲染批次，不按字数限速。
            const tb = thinkingBufRef.current as ThinkingStreamBuf | null;
            if (tb && tb.index === index) {
              // 同一思考步继续：追加缓冲
              tb.text += evData.text || "";
            } else {
              // 步切换：旧步未揭示的思考先拼完，再开新步缓冲
              if (tb) flushThinkingBuf();
              thinkingBufRef.current = { index, text: evData.text || "" };
            }
            ensureStreamTicker();
          } else if (msgEvent.event === "tool") {
            markStreaming();
            const index = Number(evData.index) || 1;
            const step = ensureStep(index);
            // 豆包 Work 式就地更新：同一步内连续工具调用时，上一个已完成卡片直接转成新的 running 卡片
            const prev = step.tool;
            step.tool = {
              name: evData.name || "",
              input: evData.input || "",
              activity: typeof evData.activity === "string" ? evData.activity : undefined,
              edit: evData.edit as UiTool["edit"],
              status: "running",
              toolUseId: String(evData.toolUseId || prev?.toolUseId || ""),
              result: undefined,
              resultTruncated: undefined,
            };
            parkPendingText(index);
            // 工具步开始：把该步未揭示的思考文本一次性拼完（避免思考与工具卡片竞态显示）
            flushThinkingBuf();
            const st = rt.stepStarts.get(index);
            if (st) step.secs = Math.max(1, Math.round((Date.now() - st) / 1000));
            applyUpdate();
          } else if (msgEvent.event === "tool_result") {
            markStreaming();
            const index = Number(evData.index) || 1;
            const step = ensureStep(index);
            // 就地更新：同一卡片从"正在执行"替换为"已执行 ✓/✗"，不新增行。
            // 校验 toolUseId：服务端已按 id 配对回原步，此处再兜一层——id 不一致时忽略，
            // 防止任何历史/并行错配把正在执行的卡片错误置为完成。
            if (step.tool && (!step.tool.toolUseId || !evData.toolUseId || step.tool.toolUseId === String(evData.toolUseId))) {
              step.tool.status = evData.status === "failed" ? "failed" : "completed";
              if (evData.toolUseId) step.tool.toolUseId = String(evData.toolUseId);
              if (evData.status === "failed") {
                // 失败保留一行错误摘要（超长截断，不展示原文）
                step.tool.result = String(evData.summary || "").slice(0, 300);
                step.tool.resultTruncated = Boolean(evData.truncated);
              } else {
                // 成功也保留结果摘要（服务端已脱敏截断 300），作为「动作 → 结果」的常驻摘要
                step.tool.result = String(evData.summary || "").slice(0, 300) || undefined;
                step.tool.resultTruncated = Boolean(evData.truncated);
              }
            }
            applyUpdate();
          } else if (msgEvent.event === "title") {
            // SDK 自动命名标题（topic / ai-title）：服务端已落库（用户手动改过则不覆盖），
            // 前端据此即时刷新侧边栏标题。本机会话由独立的临时标题会话负责，
            // 主对话流的标题事件不能把生成结果重新覆盖成用户首条输入。
            const tSid = String(evData.sessionId || "");
            const tTitle = String(evData.title || "");
            if (!localProjectRun && tSid && !isInvalidGeneratedTitle(tTitle)) {
              setSessions((list) => list.map((s) => (s.id === tSid ? { ...s, title: tTitle } : s)));
            }
          } else if (msgEvent.event === "ask_question") {
            // 等待你的回答：重置首增量标记，模型恢复输出（thinking/text）时自动切回 streaming
            gotStreamRef.current = false;
            let index = Number(evData.index) || 0;
            if (index === 0) index = Math.max(1, steps.length);
            const step = ensureStep(index);
            step.ask = Array.isArray(evData.questions) ? evData.questions : [];
            step.tool = null;
            parkPendingText(index);
            // ask 步：该步未揭示的思考一并拼完，避免 ask 卡片弹出时思考文字还在缓冲里
            flushThinkingBuf();
            const st = rt.stepStarts.get(index);
            if (st) step.secs = Math.max(1, Math.round((Date.now() - st) / 1000));
            applyUpdate();
          } else if (msgEvent.event === "text") {
            markStreaming();
            // 只合并渲染更新；每次 ticker 排空，不按字符数延迟收到的数据。
            streamBufRef.current += evData.text || "";
            ensureStreamTicker();
          } else if (msgEvent.event === "error") {
            receivedError = true;
            markStreaming();
            const errText = evData.text || "服务暂时不可用，请稍后重试";
            rt.errorMsg = errText;
            if (activeSidRef.current === sid) setErrorMsg(errText);
            // 错误原因也写入气泡正文：进历史、进 DB，刷新后仍可见
            // （之前只展示在错误框，刷新即丢失；且失败原因对用户判断“是否换模型/重试”很有用）
            const lastErr = rt.messages[rt.messages.length - 1];
            if (lastErr?.role === "assistant") {
              flushStreamBuf(); // 先把流中已收到的部分文本拼入
              pendingText = pendingText ? `${pendingText}\n\n${errText}` : errText;
              applyUpdate();
            }
          } else if (msgEvent.event === "artifact") {
            markStreaming();
            // 服务端 collectArtifacts 返回变更（added/modified/deleted + 新旧内容），挂到消息供「查看所有变更」diff
            const art = evData as ArtifactChange;
            if (art && art.id) {
              const last = rt.messages[rt.messages.length - 1];
              if (last?.role === "assistant") {
                const arts = last.artifacts ? [...last.artifacts] : [];
                const ai = arts.findIndex((a) => a.id === art.id);
                if (ai >= 0) arts[ai] = art; else arts.push(art);
                rt.messages[rt.messages.length - 1] = { ...last, artifacts: arts };
                if (activeSidRef.current === sid) setMessages([...rt.messages]);
              }
              // 同步刷新右侧列表：artifact 事件在服务端 collectArtifacts（搬移散落文件+扫描）完成后才发，
              // 而前端在 done 时已刷新过列表（可能早于搬移完成）。这里补刷，让「查看所有产物 (N)」与卡片一致。
              // 新增/修改产物 → 置位自动聚焦标志：列表刷新完成后右栏预览第一个文件（而非停留在列表）。
              if (art.change !== "deleted") autoFocusNewArtifactsRef.current = true;
              refreshArtifactList(sid, true);
            }
          } else if (msgEvent.event === "model_info") {
            markStreaming();
            const last = rt.messages[rt.messages.length - 1];
            if (last?.role === "assistant") {
              rt.messages[rt.messages.length - 1] = { ...last, modelInfo: { ...last.modelInfo, ...evData, agentMode: runMode } };
              if (activeSidRef.current === sid) setMessages([...rt.messages]);
            }
          } else if (msgEvent.event === "cost_info") {
            markStreaming();
            // 本轮消耗（usage token / costUsd）：答复底部展示（积分字段 SDK 未返回）
            const cUsage = (evData as { usage?: Record<string, number> | null }).usage;
            const used = cUsage && typeof cUsage === "object" ? contextUsedTokens(cUsage) : null;
            // 上下文统计跟着会话走：只反映当前激活会话，后台会话（如切换/新建后仍在跑的上一个任务）
            // 的 cost_info 不能写入全局用量，否则新任务的上下文圆圈会错误显示上一个任务的用量。
            if (typeof used === "number" && used > 0 && activeSidRef.current === sid) {
              // CLI 每次请求把全量上下文发给模型：最新一轮 input_tokens ≈ 当前上下文已用大小
              setCtxUsage((prev) => ({ ...prev, usedTokens: used }));
              // 首轮 cost_info 到达时，send 时预拉的上限大概率还是 null
              // （session 刚创建、服务端预取未完成）→ 补拉一次拿真实上限
              if (maxTokensRef.current == null) void refreshContextLimit(sid);
            }
            const last = rt.messages[rt.messages.length - 1];
            if (last?.role === "assistant") {
              rt.messages[rt.messages.length - 1] = {
                ...last,
                costInfo: evData as { costUsd?: number | null; usage?: Record<string, number> | null },
              };
              if (activeSidRef.current === sid) setMessages([...rt.messages]);
            }
          } else if (msgEvent.event === "compact") {
            // CLI 压缩上下文（compact_boundary）：preTokens = 压缩「前」token（是大值）。
            // 纠偏：不要把 preTokens 当“已用”写回环——那是压缩前的大值，会反向拉高环、制造假满。
            // 压缩后的真实用量由下一轮 cost_info.input_tokens（已含压缩后全量上下文）自然回落覆盖；
            // 这里只记录压缩事实（环形提示/动画用）。
            markStreaming();
            // 仅当前激活会话的压缩事实写入用量环（与 cost_info 同步：上下文统计跟着会话走）
            if (activeSidRef.current === sid) setCtxUsage((prev) => ({
              ...prev,
              compacting: false,
              lastCompactAt: Date.now(),
            }));
          } else if (msgEvent.event === "compact_status") {
            // status 消息（status=compacting）：上下文压缩进行中。
            // 注：headless CLI 不会下发 compact_boundary（compact 事件从不触发），
            // 因此“压缩结束”只能靠这里 status 从 compacting 回落到 null/false 来识别，
            // 借此记录最近压缩时间（替代永远不触发的 compact 分支）。
            const nowCompacting = Boolean((evData as { compacting?: boolean }).compacting);
            // 仅当前激活会话的压缩状态写入用量环（上下文统计跟着会话走）
            if (activeSidRef.current === sid) setCtxUsage((prev) => ({
              ...prev,
              compacting: nowCompacting,
              lastCompactAt: nowCompacting ? prev.lastCompactAt : Date.now(),
            }));
          } else if (msgEvent.event.startsWith("browser_")) {
            markStreaming();
            // control_browser 过程事件（headless 浏览器）：截图/动作/ask 挂到当前 tool 步骤，
            // thinking 展开区实时展示；ask 时前端凭 data.id 回传人工答案
            const be = msgEvent.event.slice("browser_".length);
            const bId = String(evData.id || "");
            if (bId) {
              const step = ensureStep(Math.max(1, steps.length));
              if (!step.browser) step.browser = { id: bId, screenshots: [], actions: [], ask: null };
              const b = step.browser;
              if (be === "screenshot" && typeof evData.image === "string" && evData.image) {
                b.screenshots.push(evData.image);
                if (b.screenshots.length > 8) b.screenshots.shift(); // 只保留最近 8 张，防内存膨胀
                b.status = "running";
                // 右侧面板实时预览浏览器画面（控制面板不再弹独立窗口）
                if (activeSidRef.current === sid) {
                  setBrowserShot(evData.image);
                  setBrowserShotSid(sid);
                  setPreview({ sid, meta: { id: "__browser__", name: "浏览器实时预览", type: "browser" } });
                  openRight();
                }
              } else if (be === "thinking") {
                b.thinking = String(evData.text || "");
              } else if (be === "action") {
                const a = evData.action as Record<string, unknown> | undefined;
                if (a && typeof a.action === "string") {
                  b.actions.push({ step: Number(evData.step) || 0, action: a.action, params: a });
                  if (b.actions.length > 40) b.actions.shift();
                }
              } else if (be === "cdp") {
                const port = Number(evData.port) || 0;
                if (port) {
                  setCdpPort(port);
                  setCdpSid(sid);
                  browserCdp.setPort(port);
                }
              } else if (be === "ask") {
                b.ask = { step: Number(evData.step) || 0, question: String(evData.question || "") };
                b.status = "ask";
              } else if (be === "ask_result") {
                b.ask = null;
                b.status = "running";
              } else if (be === "done") {
                b.status = "done";
                b.finalSummary = String(evData.summary || "");
              } else if (be === "error") {
                b.status = "error";
                b.finalSummary = String(evData.text || "");
              } else if (be === "stopped") {
                b.status = "stopped";
              } else if (be === "finished") {
                b.status = "finished";
              }
              applyUpdate();
            }
          }
        }
      } } catch (error) {
        if (abortController.signal.aborted) throw error;
        console.warn("[agent-kit] 任务流中断，准备按事件序号重新连接:", error);
      } finally { reader.releaseLock(); }
      if (!receivedDone && !receivedError && !receivedCancelled) res = null;
      }
      if (receivedCancelled && !abortController.signal.aborted) {
        rt.errorMsg = "任务已停止";
        if (activeSidRef.current === sid) setErrorMsg(rt.errorMsg);
      }
      if (receivedDone && rt.errorMsg?.startsWith("停止任务未送达")) {
        rt.errorMsg = null;
        if (activeSidRef.current === sid) setErrorMsg(null);
      }
      turnCompleted = receivedDone && !receivedError && !receivedCancelled;
      // 流正常结束立即提交剩余文本，不等待视觉动画。
      flushStreamBuf();
      // 注意：正文为空时**不注入任何兜底文案**——空正文的原因可能是模型不支持图片、
      // 模型选择不输出文字、异常中断等，写死归因（如「可能是模型不支持图片识别」）会误导用户。
      // 模型最后一步是工具调用/异常时中间文本已归位进步骤（含思考输出），
      // finally 折叠逻辑对空正文不折叠（见下），步骤默认展开，用户能看到完整过程。
      // 流结束兜底（无条件执行）：tool_result 未到（上游未回/中断）时不再显示"正在执行"，
      // 降级为 completed（无摘要），与保存到 DB 的步骤保持一致。此前包在 rt.thinkingStart
      // 条件内，thinking disabled 时 rt.thinkingStart 为空 → 兜底不执行 → UI 残留"正在执行"假状态。
      const lastMsg = rt.messages[rt.messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg.steps) {
        rt.messages[rt.messages.length - 1] = {
          ...lastMsg,
          steps: lastMsg.steps.map((s) =>
            s.tool && s.tool.status === "running"
              ? { ...s, tool: { ...s.tool, status: "completed" as const } }
              : { ...s },
          ),
        };
        if (activeSidRef.current === sid) setMessages([...rt.messages]);
      }
      if (rt.thinkingStart) {
        stopThinkingTimer(rt);
        const finalSecs = Math.max(1, Math.round((Date.now() - rt.thinkingStart) / 1000));
        const lastStep = steps[steps.length - 1];
        if (lastStep && !lastStep.tool) {
          const st = rt.stepStarts.get(steps.length);
          if (st) lastStep.secs = Math.max(1, Math.round((Date.now() - st) / 1000));
        }
        const last = rt.messages[rt.messages.length - 1];
        if (last?.role === "assistant") {
          rt.messages[rt.messages.length - 1] = {
            ...last,
            thinkingSecs: finalSecs,
            // 共用时：发送开始 → 本轮答复完成
            elapsedSecs: rt.elapsedStart
              ? Math.max(1, Math.round((Date.now() - rt.elapsedStart) / 1000))
              : last.elapsedSecs ?? null,
          };
          if (activeSidRef.current === sid) setMessages([...rt.messages]);
        }
      }
      // 落库条件：正文非空，或没有正文但有过程步骤（模型最后一步是工具调用/异常时正文为空，
      // 步骤里保留了中间文本与工具成败——不落库会导致刷新后整条消息消失，只剩「无回应的会话」）。
      if (isLoggedIn && !embedded?.temporary && !localProjectRun && (pendingText.trim() || steps.length > 0)) {
        const finalSecs = rt.thinkingStart
          ? Math.max(1, Math.round((Date.now() - rt.thinkingStart) / 1000))
          : null;
        try {
          const saveRes = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              role: "assistant",
              runId,
              content: pendingText,
              steps: steps.map((s, i) => {
                // answered 在 submitAnswer 里写在 rt.messages 的 steps 上，闭包 steps 不含，
                // 从 rt.messages 同步过来，保证存库后刷新页面历史不重复弹出卡片
                const persistedAnswered = rt.messages[rt.messages.length - 1]?.steps?.[i]?.answered;
                return {
                  thinking: s.thinking || "",
                  text: s.text || "",
                  // 与流结束 UI 兜底一致：仍 running 的工具降级为 completed（无结果摘要），
                  // 刷新历史后不再出现"正在执行"的假状态
                  tool: s.tool
                    ? { ...s.tool, status: s.tool.status === "running" ? ("completed" as const) : s.tool.status }
                    : null,
                  ask: s.ask && s.ask.length ? s.ask : null,
                  answered: persistedAnswered || s.answered || null,
                  secs: s.secs || null,
                  // 不持久化 browser 过程（含 base64 截图，体积过大）；历史恢复时不展示浏览器过程
                };
              }),
              thinkingSecs: finalSecs,
              // 持久化共用时：发送开始 → 全部答复完成
              elapsedSecs: rt.messages[rt.messages.length - 1]?.elapsedSecs || null,
              // 持久化本轮模型信息（是否走了 fallback 积分模型），刷新历史后提示仍保留
              modelInfo: rt.messages[rt.messages.length - 1]?.modelInfo || null,
              // 持久化本轮产物清单（SSE artifact 事件挂到当前消息上的），刷新历史后文件卡片与「查看所有产物」按钮不消失
              artifacts: Array.isArray(rt.messages[rt.messages.length - 1]?.artifacts)
                ? rt.messages[rt.messages.length - 1].artifacts
                : null,
              // 持久化本轮消耗（token usage / costUsd），刷新历史后底部消耗不消失；也是 admin 用量分析的数据源
              costInfo: rt.messages[rt.messages.length - 1]?.costInfo || null,
            }),
          });
          if (!saveRes.ok) {
            console.warn(`[agent-kit] 助手消息落库失败 HTTP ${saveRes.status}`, await saveRes.text().catch(() => ""));
          } else {
            assistantSaved = true;
            const saved = await saveRes.json().catch(() => null) as { content?: string } | null;
            if (typeof saved?.content === "string" && saved.content !== pendingText) {
              pendingText = saved.content;
              const last = rt.messages[rt.messages.length - 1];
              if (last?.role === "assistant") {
                rt.messages[rt.messages.length - 1] = { ...last, content: saved.content };
                if (activeSidRef.current === sid) setMessages([...rt.messages]);
              }
            }
          }
        } catch (e) { console.warn("[agent-kit] 助手消息落库异常:", e); }
        refreshSessions();
        // 本轮结束：刷新该会话的产物列表（新增文件后「查看所有产物」计数与面板同步更新）
        refreshArtifactList(sid);
      }
    } catch (err) {
      // 流中断/停止：把缓冲中未揭示文本拼入已生成内容（跨 try 闭包，用组件级 ref 兜底）
      if (streamBufRef.current) {
        const last = rt.messages[rt.messages.length - 1];
        if (last?.role === "assistant") {
          rt.messages[rt.messages.length - 1] = { ...last, content: (last.content || "") + streamBufRef.current, revealAt: Date.now() };
          streamBufRef.current = "";
          if (activeSidRef.current === sid) setMessages([...rt.messages]);
        }
      }
      // 思考缓冲兜底：未揭示的思考文本拼入对应步（跨 try 闭包，用组件级 ref + rt.messages）
      if (thinkingBufRef.current?.text) {
        const tb = thinkingBufRef.current;
        const last = rt.messages[rt.messages.length - 1];
        if (last?.role === "assistant" && Array.isArray(last.steps)) {
          const step = last.steps[tb.index - 1];
          if (step) {
            step.thinking = (step.thinking || "") + tb.text;
            tb.text = "";
            if (activeSidRef.current === sid) setMessages([...rt.messages]);
          }
        }
      }
      if (streamTickerRef.current) {
        clearInterval(streamTickerRef.current);
        streamTickerRef.current = null;
      }
      if (err instanceof Error && err.name === "AbortError") {
        console.warn("[agent-kit] 用户已取消本轮生成");
        // 用户主动停止：静默处理，不弹错误框
      } else {
        console.error("[agent-kit] 请求或流处理异常:", err);
        const rawMsg = err instanceof Error && err.message ? err.message : "未知错误";
        // 网络层失败（连接被拒/流中断）在 Chromium 下统一表现为 "Failed to fetch"，
        // 对用户而言是「本地引擎不可达」，直接给可操作的指引而不是技术文案。
        const isNetError =
          rawMsg === "Failed to fetch" ||
          rawMsg.includes("fetch") ||
          rawMsg.includes("NetworkError") ||
          rawMsg.includes("network");
        rt.errorMsg = isNetError
          ? "出错了：无法连接本地引擎（服务可能刚启动或已退出）。请稍等几秒重试；若持续出现，请重启应用。"
          : `出错了：${rawMsg}`;
      }
      if (activeSidRef.current === sid) setErrorMsg(rt.errorMsg);
    } finally {
      if (localProjectRun) {
        const session = sessionsRef.current.find((item) => item.id === sid);
        const aiUnread = readSuppressedRef.current || backgroundMode || (activeSidRef.current !== sid && !rt.viewedDuringRun);
        if (session) localRunPersisted = localChatSave(localOwner, { ...session, updatedAt: new Date().toISOString(), modelId: session.modelId || selectedModelId,
          // 宿主 UI 不可见（窗口被关/最小化）时一律落成未读：进行中卡片会停在「已完成未读」，
          // 而不是因为「其实没人看见」被判成已读后立刻从桌面上消失。
          aiUnread }, rt.messages);
        setSessions(list => list.map(item => item.id === sid ? { ...item, aiUnread } : item));
        if (!keepActiveRun) void refreshArtifactList(sid);
      }
      // A failed HTTP handshake or exhausted reconnect previously left only a
      // user message in history. Save a visible failure once per run as well.
      if (!keepActiveRun && !assistantSaved && rt.errorMsg && !abortController.signal.aborted) {
        const last = rt.messages[rt.messages.length - 1];
        if (last?.role === "assistant") {
          const content = last.content?.includes(rt.errorMsg) ? last.content : [last.content, rt.errorMsg].filter(Boolean).join("\n\n");
          rt.messages[rt.messages.length - 1] = { ...last, content, revealAt: Date.now() };
          if (activeSidRef.current === sid) setMessages([...rt.messages]);
          if (isLoggedIn && !embedded?.temporary && !localProjectRun) {
            try {
              const saved = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/messages`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: "assistant", runId, content }),
              });
              assistantSaved = saved.ok;
            } catch { /* local state below still remembers this failure */ }
          }
        }
      }
      rt.runId = keepActiveRun ? runId : null;
      rt.reconnectAttempt = 0;
      rt.reconnectExhausted = keepActiveRun;
      try {
        if (!keepActiveRun) window.localStorage.removeItem(`agent-kit:active-run:${sid}`);
        if (rt.errorMsg) window.localStorage.setItem(`agent-kit:run-failure:${sid}`, rt.errorMsg.slice(0, 500));
        else window.localStorage.removeItem(`agent-kit:run-failure:${sid}`);
      } catch { /* ignore */ }
      if (activeSidRef.current === sid) setReconnectAttempt(0);
      stopThinkingTimer(rt);
      markBusy(sid, keepActiveRun);
      // 共用时收尾兜底：正常完成已在 try 内写入；用户停止 / 网络中断走到这里补写最终值
      if (rt.elapsedStart && !keepActiveRun) {
        const last = rt.messages[rt.messages.length - 1];
        if (last?.role === "assistant") {
          rt.messages[rt.messages.length - 1] = {
            ...last,
            elapsedSecs: Math.max(1, Math.round((Date.now() - rt.elapsedStart) / 1000)),
          };
          if (activeSidRef.current === sid) setMessages([...rt.messages]);
        }
        rt.elapsedStart = null;
      }
      // 本轮收尾（完成 / 停止 / 中断）后重算「待确认」集合：ask 卡片的挂起态随之更新
      syncPendingQuestionSids();
      if (activeSidRef.current === sid) {
        setBusy(keepActiveRun);
      }
      const lastMsg = rt.messages[rt.messages.length - 1];
      if (turnCompleted && !rt.errorMsg && lastMsg?.role === "assistant" && lastMsg.content?.trim()) {
        // 通知标题必须取「本轮会话」的标题：用户可能早已切到别的会话，
        // 用当前 activeSid 会在通知里显示错误的名字。
        const notifySession = sessionsRef.current.find((item) => item.id === sid);
        const notifyTitle = notifySession?.title?.trim() || title;
        embedded?.onResult?.(lastMsg.content, rt.messages);
        if (!embeddedMode) {
          onAssistantResponse?.({ sessionId: sid, text: lastMsg.content, messages: rt.messages, title: notifyTitle, runId, isActiveSession: activeSidRef.current === sid });
          onReplyNotification?.({ sessionId: sid, title: notifyTitle, text: lastMsg.content, runId, isActiveSession: activeSidRef.current === sid });
          dispatchCapabilityReply(capabilities, { sessionId: sid, reply: lastMsg.content, messages: toCapMessages(rt.messages), channel: "chat" });
        }
      } else if (rt.errorMsg) {
        embedded?.onError?.(new Error(rt.errorMsg));
      }
      // 豆包 Work 式终态收束：本轮结束（正常完成 / 用户停止 / 中断）自动把过程折叠进「已完成」卡片。
      // 但正文为空时（模型最后一步是工具调用/异常退出，中间文本已被归位进步骤）不折叠——
      // 折叠会把步骤整块隐藏（见渲染处 !isFolded 条件），用户只会看到空气泡，不知道发生了什么。
      // 必须限定「当前正在查看本会话」：foldedProcess 是按消息 index 的 Set，属渲染层全局状态；
      // 若在切走状态（后台完成）时写入，会把别的会话的同index 消息错误折叠。
      if (!keepActiveRun && activeSidRef.current === sid
        && lastMsg?.role === "assistant" && Array.isArray(lastMsg.steps) && lastMsg.steps.length > 0) {
        const hasVisibleContent = Boolean((lastMsg.content || "").trim());
        if (hasVisibleContent) {
          const lastIdx = rt.messages.length - 1;
          setFoldedProcess((prev) => {
            const n = new Set(prev);
            n.add(lastIdx);
            return n;
          });
        }
      }
      // 用户已查看本轮的会话：把服务端已读游标推进到当前最新消息。
      // 打开会话时只推一次 /read（游标停在当时的最后一条消息），随后流式保存的
      // assistant 消息 id 更大 → 切走后的轮询会把 ai_unread 拉回 true，侧边栏误显
      // 「已完成（未查看）」绿圈。这里在运行真正结束时，对用户看过的会话补推一次已读。
      // throughId 用 MAX_SAFE_INTEGER：服务端按 LEAST(throughId, max(id)) 收敛到最新消息，游标只前进不后退。
      // 宿主 UI 不可见（readSuppressed）时不推：看不见的会话不能被算作已读。
      if (!keepActiveRun && isLoggedIn && !embedded?.temporary && !localProjectRun && !readSuppressedRef.current
        && (activeSidRef.current === sid || rt.viewedDuringRun)) {
        void apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ throughId: Number.MAX_SAFE_INTEGER }),
        }).then((response) => {
          if (response.ok) setSessions((list) => list.map((item) => item.id === sid
            ? { ...item, unreadCount: 0, aiUnread: false, lastMentionedMe: false } : item));
        }).catch(() => {});
      }
      gotStreamRef.current = false;
      if (keepActiveRun) return;
      // 本轮真正收尾：先等本机会话落盘完成，再广播「跑完了」——
      // 旁观实例收到后会重读历史，广播早了它读到的还是"只有用户消息"的旧内容。
      const announceEnd = () => publishRunEvent({ type: "end", sessionId: sid, origin: runEventOriginRef.current });
      if (localRunPersisted) void localRunPersisted.catch(() => {}).then(announceEnd);
      else announceEnd();
      // 优先级：AskUserQuestion 答案重发 > 排队消息逐条发送（链式，每轮结束再发下一条）
      if (rt.pendingAnswer) {
        const next = rt.pendingAnswer;
        rt.pendingAnswer = null;
        // pendingAnswer 目前没有写入路径（保留字段）；若将来使用，按队列项的内容重发
        send(next.text, next.attachments ?? (next.attachment ? [next.attachment] : []), undefined, next.voice, next.prompt, next.references).catch(() => {});
      } else if (rt.queue && rt.queue.length) {
        const next = rt.queue.shift();
        if (!next) return;
        if (activeSidRef.current === sid) setPendingQueue([...rt.queue]);
        send(next.text, next.attachments ?? (next.attachment ? [next.attachment] : []), undefined, next.voice, next.prompt, next.references).catch(() => {});
      }
    }
  }

  // 待发队列项：立即插入当前对话（steer）。
  // 走 POST /api/chat/steer（服务端经 Session 常驻会话的 CLI steer 通道，
  // 消息进入 SteerInputBuffer，在下一次模型请求前注入，不打断当前工具循环）。
  // 成功后把该条作为 user 消息插入消息流，后续 SSE 输出落在新 assistant 消息上。
  async function steerQueueItem(item: QueueItem) {
    if (item.attachments?.length || item.attachment || item.voice) {
      setQueueNotice("带附件或语音的消息将在当前回复结束后发送");
      return;
    }
    // 点击事件可能在 React 状态更新前连续触发，因此必须先用 ref 做同步互斥。
    if (steerInFlightRef.current.has(item.id)) return;
    steerInFlightRef.current.add(item.id);
    setSteerInFlight(new Set(steerInFlightRef.current));
    const sid = activeSid;
    const rt = getRt(sid);
    try {
      const res = await apiFetch(localChatRoute("/steer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: rt.sdkSid,
          text: item.text,
        }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; reason?: string; error?: string };
      if (data.ok) {
        rt.queue = (rt.queue || []).filter((q) => q.id !== item.id);
        if (activeSidRef.current === sid) setPendingQueue([...rt.queue]);
        // 把插话内容插入对话：running 的 assistant 回复继续跑。
        // CLI steer 通道在「下一次模型请求前」把这条 user 消息注入循环，不打断当前工具循环、不起新轮；
        // 后续 SSE 输出继续落到同一条 assistant 上。因此这里只把 user 消息插到「正在流的 assistant
        // 消息之前」，保持 assistant 仍是最后一条——点赞/点踩不会提前出现，当前回复也不会被截断。
        const steerUser: UiMessage = { role: "user", content: item.text, createdAt: new Date().toISOString() };
        const lastIdx = rt.messages.length - 1;
        if (rt.messages[lastIdx] && rt.messages[lastIdx].role === "assistant") {
          rt.messages.splice(lastIdx, 0, steerUser);
        } else {
          rt.messages.push(steerUser);
        }
        if (activeSidRef.current === sid) setMessages([...rt.messages]);
        // 持久化（登录用户）：插话内容也进会话历史，刷新后可见；本地 AI 单聊随结束统一落盘
        const steerTarget = sessionsRef.current.find((item) => item.id === sid);
        const steerLocalAi = localChat && isAiOnlyChat(steerTarget);
        if (isLoggedIn && !embedded?.temporary && !steerLocalAi) {
          try {
            await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/messages`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ role: "user", content: item.text }),
            });
          } catch { /* ignore */ }
        }
      } else {
        // idle = 当前轮已接近尾声/已结束（CLI 本轮不再有下一次模型请求）：
        // 不弹红色错误、不移除条目——保留在队列里，本轮 SSE 结束后由 finally 的
        // 自动冲刷按顺序正常发送，只给一条轻提示。
        if (data.reason === "idle") {
          setQueueNotice("当前回复已接近尾声，该消息将在回复结束后自动发送");
          if (queueNoticeTimer.current) clearTimeout(queueNoticeTimer.current);
          queueNoticeTimer.current = setTimeout(() => setQueueNotice(""), 4000);
        } else {
          // 其余为会话/通道不可用
          const msg =
            data.reason === "no_session"
              ? "会话已失效，请重新发送消息"
              : "插话失败，请稍后重试";
          rt.errorMsg = msg;
          if (activeSidRef.current === sid) setErrorMsg(msg);
          console.warn("[agent-kit] steer 失败:", data.reason || data.error || res.status);
        }
      }
    } catch (err) {
      const msg = "插话失败，请稍后重试";
      rt.errorMsg = msg;
      if (activeSidRef.current === sid) setErrorMsg(msg);
      console.warn("[agent-kit] steer 请求异常:", err);
    } finally {
      steerInFlightRef.current.delete(item.id);
      setSteerInFlight(new Set(steerInFlightRef.current));
    }
  }

  // 从待发队列删除一条（不发送，不插话）
  function removeQueueItem(item: QueueItem) {
    const sid = activeSid;
    const rt = getRt(sid);
    rt.queue = (rt.queue || []).filter((q) => q.id !== item.id);
    if (activeSidRef.current === sid) setPendingQueue([...rt.queue]);
  }

  // 编辑队列条目：内容（含附件）放回输入框供修改，并从队列移除
  function editQueueItem(item: QueueItem) {
    const sid = activeSid;
    const rt = getRt(sid);
    rt.queue = (rt.queue || []).filter((q) => q.id !== item.id);
    if (activeSidRef.current === sid) {
      setPendingQueue([...rt.queue]);
      composerRef.current?.setText(item.text); // 文字经 composerRef 放回输入框
      setAttachments(item.attachments ?? (item.attachment ? [item.attachment] : []));
      composerRef.current?.focus();
    }
  }

  // 队列拖拽排序（WorkBuddy 同款）：按住条目拖动到目标位置即时重排
  function onQueueDragStart(e: ReactDragEvent, item: QueueItem) {
    queueDragRef.current = item.id;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", item.id); } catch { /* ignore */ }
  }
  function onQueueDragOver(e: ReactDragEvent, item: QueueItem) {
    if (!queueDragRef.current || queueDragRef.current === item.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const sid = activeSid;
    const rt = getRt(sid);
    const q = rt.queue || [];
    const from = q.findIndex((x) => x.id === queueDragRef.current);
    const to = q.findIndex((x) => x.id === item.id);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = q.splice(from, 1);
    q.splice(to, 0, moved);
    if (activeSidRef.current === sid) setPendingQueue([...q]);
  }
  function onQueueDrop(e: ReactDragEvent) {
    if (!queueDragRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    queueDragRef.current = null;
  }
  function onQueueDragEnd() {
    queueDragRef.current = null;
  }

  // 取消当前会话的 SSE 流（用户点"停止生成"按钮）：abort 当前 active sid 的 rt.abort。
  // 切会话不调用这个——旧会话在后台继续跑。
  function cancelGeneration() {
    const sid = activeSid;
    const rt = getRt(sid);
    if (rt.runId) {
      const url = endpointUrl(localChatRoute("/run"), { sessionId: rt.sdkSid, runId: rt.runId });
      void apiFetch(url, { method: "POST" }).then(async (response) => {
        const result = await response.json().catch(() => ({})) as { ok?: boolean };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (result.ok) {
          rt.abort?.abort();
          if (rt.reconnectExhausted) {
            rt.reconnectExhausted = false;
            rt.runId = null;
            rt.errorMsg = "任务已停止";
            try {
              window.localStorage.removeItem(`agent-kit:active-run:${sid}`);
              window.localStorage.setItem(`agent-kit:run-failure:${sid}`, rt.errorMsg);
            } catch { /* ignore */ }
            markBusy(sid, false);
            if (activeSidRef.current === sid) { setBusy(false); setErrorMsg(rt.errorMsg); }
          }
        }
      }).catch((error) => {
        const message = `停止任务未送达：${error instanceof Error ? error.message : String(error)}`;
        rt.errorMsg = message;
        if (activeSidRef.current === sid) setErrorMsg(message);
      });
    } else {
      rt.abort?.abort();
    }
    if (split || compareOnly) setCompareCancelSeq((value) => value + 1);
  }

  // Enter 发送 / IME 组合判断已随 textarea 移入 ChatComposer（submit 内部处理）。

  async function logout() {
    if (!isDesktopApp()) await removeWebPushSubscription(basePath).catch(() => {});
    if (onLogout) {
      await onLogout();
      return;
    }
    await apiFetch(`${basePath}/api/logout`, { method: "POST" });
    window.location.replace(`${basePath}/login${loginProviders ? `?providers=${encodeURIComponent(loginProviders)}` : ""}`);
  }

  /** 输入框是否有内容（由 ChatComposer 在空↔非空翻转时上报；打字过程不触发，父级不重渲染）。
   *  发送按钮 disabled 依赖它：无文字且无附件时不可发送。 */
  const [composerHasInput, setComposerHasInput] = useState(false);
  const [composerHasText, setComposerHasText] = useState(false);

  // ============ 提示词增强（「增强提示词」按钮） ============
  // 点击 → 把输入框原文发到服务端独立的一次性临时会话（用当前选中的模型+框架，
  // thinking 关闭、无工具、transcript 不落库不进会话列表）→ 增强后的提示词回填输入框，
  // 按钮切换为撤回图标，再点一次还原用户原文。
  // 附件（文件/图片）全程不碰：增强只替换文字，附件状态保持原样，撤回也只还原文字。
  const [enhancing, setEnhancing] = useState(false);
  const [enhanceOriginal, setEnhanceOriginal] = useState<string | null>(null);
  // 切会话清掉增强态：保存的原文属于旧会话的输入内容，跨会话还原会覆盖新会话草稿
  useEffect(() => { setEnhanceOriginal(null); setEnhancing(false); }, [activeSid]);

  async function handleEnhancePrompt() {
    if (enhancing || contentLoading) return;
    const sid = activeSid;
    // 已增强态：按钮即撤回——还原用户原文（附件从未被修改，无需处理）
    if (enhanceOriginal != null) {
      composerRef.current?.setText(enhanceOriginal);
      setEnhanceOriginal(null);
      return;
    }
    const original = composerRef.current?.getText().trim();
    if (!original) return;
    setEnhancing(true);
    try {
      const res = await apiFetch(`${basePath}/api/prompt-enhance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: original,
          model: selectedModel,
          agentMode,
          codexModelKey: agentMode === "codex" ? selectedCodexModel : undefined,
        }),
      });
      const data = await res.json().catch(() => ({})) as { text?: string; error?: string };
      if (!res.ok || !data.text) throw new Error(data.error || `HTTP ${res.status}`);
      // 等待期间用户切了会话：结果作废，避免把增强词串进别的会话输入框
      if (activeSidRef.current !== sid) return;
      composerRef.current?.setText(data.text);
      setEnhanceOriginal(original);
    } catch (error) {
      console.warn("[agent-kit] 提示词增强失败:", error);
      setSessionAuxErrors((previous) => ({
        ...previous,
        [sid]: error instanceof Error && error.message ? `提示词增强失败：${error.message}` : "提示词增强失败，请重试",
      }));
    } finally {
      setEnhancing(false);
    }
  }

  const readPermissionPreference = (fallback: "default" | "full" = defaultPermissionMode): "default" | "full" => {
    try {
      const saved = window.localStorage.getItem(permissionPreferenceKey);
      return saved === "full" || saved === "default" ? saved : fallback;
    } catch { return fallback; }
  };
  const [permissionMode, setPermissionMode] = useState<"default" | "full">(permissionLocked ? "full" : readPermissionPreference);
  const choosePermissionMode = (mode: "default" | "full") => {
    if (permissionLocked) return; // 锁定「完全访问」：不允许切换，也不落盘
    setPermissionMode(mode);
    try { window.localStorage.setItem(permissionPreferenceKey, mode); } catch { /* 本次会话仍生效 */ }
  };
  const [showFullAccessWarning, setShowFullAccessWarning] = useState(false);

  /** 模型列表尚未就绪（加载中，或加载失败无可用模型）时禁止发送：
   *  否则 send() 在 runMode==="codebuddy" 且模型未就绪时会静默 return（见 send 内
   *  `!modelsLoaded || !modelOptions.length` 早退），造成"发了没反应"的假死。
   *  仅当走自动拉取（autoFetchModels）时受此约束；宿主显式传入 models 时不拦截。
   *  注意：这里只阻断"发送"，文本框依旧可编辑（disabled 仅由 booting/contentLoading 控制）。 */
  const modelSendBlocked = agentModesPending || !agentModes.some((mode) => mode === agentMode) || agentMode === "codebuddy" && (
    autoFetchModels ? (!modelsLoaded || !!modelError) : (modelsLoading || modelsLoadFailed || !modelOptions.length)
  );

  /** 回复生成中（busy）也允许"发送"：消息进入待发队列，而不是丢弃。
   *  输入内容是否存在由 ChatComposer 内部判断（sendNow 空内容直接 return）；
   *  此处按钮置灰只覆盖"不可发送"的硬条件 + 输入为空。 */
  const canSend = !uploading && !contentLoading && !modelSendBlocked && (composerHasInput || attachments.length > 0);
  // 仅当有文字或附件时主圆钮才是「发送」；无内容时回落到录音喇叭，
  // 不再因 !voiceEnabled 提前显示（禁用的）发送钮。
  const mobileActionIsSend = composerHasText || attachments.length > 0;
  const mobileActionIsStop = !mobileHolding && (compareOnly ? compareBusy : busy || (split && compareBusy));

  function toggleThinking(openKey: string) {
    setOpenThinking((cur) => {
      const next = new Set(cur);
      if (next.has(openKey)) next.delete(openKey);
      else next.add(openKey);
      return next;
    });
  }

  /** 折叠卡点击：展开/收起该消息的过程区（豆包 Work 式）。流式中（streamingLast）不响应。 */
  function toggleFoldProcess(msgIndex: number) {
    setFoldedProcess((cur) => {
      const next = new Set(cur);
      if (next.has(msgIndex)) next.delete(msgIndex);
      else next.add(msgIndex);
      return next;
    });
  }

  // ============ 侧边栏会话管理（登录用户，数据库持久化） ============

  const relTime = relativeTime;

  /** Merge local execution paths and backfill their display-only project groups to the server. */
  async function withLocalProjects(list: SessionItem[]): Promise<SessionItem[]> {
    if (!localFiles) return list;
    const workspaces = await localFiles.workspaces();
    const remote = list.map((session) => ({
      ...session,
      workspaceDir: workspaces[session.id] ?? null,
      projectDir: workspaces[session.id] ?? session.projectDir ?? null,
    }));
    const local = localProjectSessions(initialUser.unionId || "", workspaces);
    const merged = [...local, ...remote.filter((session) => !local.some((saved) => saved.id === session.id))];
    // 老数据回填：把当前会话使用的目录补登进独立项目清单（已存在则不动，不打乱顺序），
    // 这样删空最后一个会话后项目仍保留。
    const userId = initialUser.unionId || "";
    let changed = false;
    for (const s of merged) {
      if (ensureLocalProjectDir(userId, s.projectDir || s.workspaceDir)) changed = true;
    }
    if (changed) setRegisteredProjectDirs(listLocalProjectDirs(userId));
    return merged;
  }

  /** 桌面端的真人会话从云端读取，AI 单聊从本机读取。 */
  async function loadCloudSessions(signal?: AbortSignal): Promise<SessionItem[]> {
    if (localGuest && !cloudEnabled) return [];
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = localChat ? window.setTimeout(() => controller.abort(), 5000) : null;
    try {
      const response = await apiFetch(`${basePath}/api/sessions`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { sessions?: SessionItem[] };
      return Array.isArray(data.sessions) ? data.sessions : [];
    } catch (error) {
      if (!localChat) throw error;
      return sessionsRef.current.filter((session) => !isAiOnlyChat(session));
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (timeout !== null) window.clearTimeout(timeout);
    }
  }

  async function mergeLocalChatSessions(cloud: SessionItem[]): Promise<SessionItem[]> {
    if (!localChat) return withLocalProjects(cloud);
    let local: SessionItem[];
    try {
      local = await localChatList(localOwner);
    } catch {
      // 主进程 IPC 偶发失败（落盘抖动/窗口重建中）时**不能**当成"本地没有会话"，
      // 否则这一轮刷新会把侧边栏里的本机会话整片抹掉、下一轮又冒回来（闪断）。
      // 退化为沿用当前列表里已知的本机会话，等下一轮成功读取再校准。
      local = sessionsRef.current.filter((item) => isAiOnlyChat(item));
    }
    // 老数据回填：把本地会话用到的目录补登进「项目清单」，删空最后一个会话后项目仍保留
    const userId = initialUser.unionId || "";
    let changed = false;
    for (const s of local) {
      if (ensureLocalProjectDir(userId, s.projectDir || s.workspaceDir)) changed = true;
    }
    if (changed) setRegisteredProjectDirs(listLocalProjectDirs(userId));
    const localIds = new Set(local.map((session) => session.id));
    return [...local, ...cloud.filter((session) => !isAiOnlyChat(session) && !localIds.has(session.id))];
  }

  async function syncSessionsInBackground(notifySessionId?: string) {
    if (!initialSessionsLoadedRef.current) return;
    try {
      const cloud = await loadCloudSessions();
      const list = (await mergeLocalChatSessions(cloud))
        .filter((session) => !endedSessionIdsRef.current.has(session.id));
      const added = notifySessionId && !sessionsRef.current.some(item => item.id === notifySessionId)
        ? list.find(item => item.id === notifySessionId) : null;
      setSessions(list.map(item => item.id === activeSidRef.current && !readSuppressedRef.current
        ? { ...item, unreadCount: 0, aiUnread: false, lastMentionedMe: false } : item));
      if (added) {
        const title = added.memberCount === 1 ? added.peerName || added.title : added.title;
        const message = `${title}${added.memberCount === 1 ? "向你发起了聊天" : "邀请你加入群聊"}`;
        setNewSessionNotice(message);
        if (newSessionNoticeTimerRef.current !== null) window.clearTimeout(newSessionNoticeTimerRef.current);
        newSessionNoticeTimerRef.current = window.setTimeout(() => {
          setNewSessionNotice(null);
          newSessionNoticeTimerRef.current = null;
        }, 5000);
        if (!added.muted && canNotify() && (document.hidden || !document.hasFocus())) showNotification(
          title,
          added.memberCount === 1 ? "向你发起了聊天" : "邀请你加入群聊",
          `agent-session-${added.id}`,
          { kind: "session-invite", sessionId: added.id },
          basePath,
        );
      }
    } catch { /* 网络恢复或 WebSocket 重连时会再次同步 */ }
  }
  // 消息到达的列表刷新节流：1.5s 内多条新消息合并为一次刷新，避免消息风暴打爆 /api/sessions
  const inboxRefreshTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!remoteAuthenticated || embeddedMode) return;
    const notifyIncomingMessage = async (sessionId: string) => {
      const session = sessionsRef.current.find(item => item.id === sessionId);
      if (!session || ((session.memberCount ?? 0) === 0 && !session.coworkEverGroup)
        || session.muted || (!onReplyNotification && !canNotify())) return;
      try {
        const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/messages`, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { messages?: Array<{ id: number; role: string; senderSub?: string | null; senderName?: string | null; content?: string; attachment?: unknown; revokedAt?: string | null }> };
        const message = data.messages?.slice().reverse().find(item => !item.revokedAt);
        if (!message?.id || message.role !== "user" && message.role !== "assistant"
          || message.role === "user" && Boolean(selfSub) && message.senderSub === selfSub
          || message.role === "assistant" && session.aiMuted
          || sessionId === activeSidRef.current && !document.hidden && document.hasFocus()
          || message.id <= (notifiedMessageIdsRef.current.get(sessionId) ?? 0)) return;
        notifiedMessageIdsRef.current.set(sessionId, message.id);
        const name = message.senderName?.trim() || (message.role === "assistant" ? "Agent" : "成员");
        const preview = messagePreviewText(message.content, message.attachment);
        const notificationBody = summarizeForNotify(preview || "[附件]");
        const title = notificationTitleForSession(session, name);
        const body = isGroupSession(session) || message.role === "assistant" ? `${name}：${notificationBody}` : notificationBody;
        if (onReplyNotification) onReplyNotification({ sessionId, title, text: body, runId: `message-${message.id}`, isActiveSession: false });
        else showNotification(title, body, `agent-im-${sessionId}`, { kind: "new-message", sessionId, notifyWhileViewing: Boolean(selfSub) && message.senderSub === selfSub }, basePath);
      } catch { /* 下一次 inbox 事件或后台推送仍可提醒 */ }
    };
    const unsubscribe = realtimeClient(basePath).subscribeInbox({
      onSessionAdded: sessionId => { void syncSessionsInBackground(sessionId); },
      // 任意会话来了新消息 → 立即（去抖）刷新会话列表，未读角标不再等 15 秒轮询
      onSessionMessage: sessionId => {
        void notifyIncomingMessage(sessionId);
        if (inboxRefreshTimerRef.current != null) return;
        inboxRefreshTimerRef.current = window.setTimeout(() => {
          inboxRefreshTimerRef.current = null;
          void syncSessionsInBackground();
        }, 1500);
      },
      onConnect: () => { void syncSessionsInBackground(); },
    });
    const poll = () => { if (!document.hidden) void syncSessionsInBackground(); };
    const timer = window.setInterval(poll, 15000);
    document.addEventListener("visibilitychange", poll);
    return () => { unsubscribe(); window.clearInterval(timer); window.clearTimeout(inboxRefreshTimerRef.current ?? undefined); inboxRefreshTimerRef.current = null; document.removeEventListener("visibilitychange", poll); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, remoteAuthenticated, embeddedMode, selfSub]);

  /** 拉取会话列表；若当前还没有任何消息且列表非空，恢复最近会话的历史消息。 */
  async function refreshSessions() {
    if (!isLoggedIn || embeddedMode) return;
    const requestId = ++sessionListRequestRef.current;
    const selectionAtStart = sessionHistoryRequestRef.current;
    setSessionsLoading(true);
    setSessionsLoadError(false);
    const controller = new AbortController();
    try {
      const cloud = await loadCloudSessions(controller.signal);
      let list = await mergeLocalChatSessions(cloud);
      list = list
        .filter((session) => !endedSessionIdsRef.current.has(session.id));
      if (requestId !== sessionListRequestRef.current) return;
      setSessions(list);
      initialSessionsLoadedRef.current = true;
      setSessionsLoading(false);
      if (backgroundMode) return;
      if (window.matchMedia("(max-width: 767.98px)").matches) {
        if (list.length === 0 && !conversationView) {
          newSession(false);
          setConversationView(true);
        }
        return;
      }
      const last = readLastSession();
      if (last && list.some((session) => session.id === last) && messagesRef.current.length === 0 && selectionAtStart === sessionHistoryRequestRef.current) {
        await switchSession(last, list.find((session) => session.id === last), false);
      }
    } catch {
      if (requestId === sessionListRequestRef.current) setSessionsLoadError(true);
    } finally {
      if (requestId === sessionListRequestRef.current) {
        setSessionsLoading(false);
        setBooting(false);
      }
    }
  }

  // 拉取会话产物列表（递归含子目录），更新总数缓存与列表缓存。
  // 列表来自磁盘实时扫描：同一会话多次拉取会覆盖旧缓存（新增产物后重拉）。
  async function refreshArtifactList(id: string, ensureFresh = false) {
    const pending = artifactListRequests.current.get(id);
    if (pending) {
      if (ensureFresh) artifactListsDirty.current.add(id);
      return pending;
    }
    const request = (async () => {
    setArtifactLoadErrors((current) => ({ ...current, [id]: false }));
    try {
      let includeHidden = false;
      try { includeHidden = window.localStorage.getItem(`artifact-show-hidden:${id}`) === "1"; } catch { /* storage unavailable */ }
      const url = artifactUrl({ session: id, list: "1", ...(includeHidden ? { hidden: "1" } : {}) });
      const res = await apiFetch(url, { cache: "no-store" });
      if (!res.ok) {
        if (res.status !== 403 && res.status !== 401) throw new Error("artifacts load failed");
        // 权限校验失败（403：会话不属于当前用户 / 游客票据无效或过期）：静默置空，
        // 右侧显示该会话的空态，不弹错、不阻塞切换。游客刷新后无票据属正常（会话不持久化）。
        setArtifactCounts((cur) => ({ ...cur, [id]: 0 }));
        setArtifactLists((cur) => ({ ...cur, [id]: [] }));
        return;
      }
      const data = await res.json() as { artifacts?: ArtifactMeta[] };
      const arts = Array.isArray(data.artifacts) ? data.artifacts : [];
      setArtifactCounts((cur) => ({ ...cur, [id]: arts.length }));
      setArtifactLists((cur) => ({ ...cur, [id]: arts }));
    } catch {
      setArtifactLoadErrors((current) => ({ ...current, [id]: true }));
    } finally {
      artifactListRequests.current.delete(id);
      if (artifactListsDirty.current.delete(id)) void refreshArtifactList(id);
    }
    })();
    artifactListRequests.current.set(id, request);
    return request;
  }

  // 产物列表刷新完成时：若本轮刚产生新产物，且用户未在查看其它内容、右栏已展开，
  // 则自动聚焦第一个产物进入预览（参考变更 diff 的 tab 体验——用标签栏切换，而非停留在列表）。
  // 标志位只在「生成事件」路径置位，因此切换会话 / 手动重试不会误触发。
  useEffect(() => {
    if (!autoFocusNewArtifactsRef.current) return;
    const arts = artifactLists[activeSid];
    if (!Array.isArray(arts) || arts.length === 0) return;
    autoFocusNewArtifactsRef.current = false;
    if (!preview && !diffView && !inputFilePreview && rightOpen) {
      setPreview({ sid: activeSid, meta: arts[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifactLists, activeSid]);

  // 打开指定产物的真实所在目录（产物条目上的"打开所在文件夹"）：dir 由服务端 list 返回
  async function openArtifactFileDir(dir: string) {
    const desktop = (
      window as unknown as {
        agentHost?: { openPath?: (p: string) => Promise<{ ok?: boolean; error?: string } | undefined> };
      }
    ).agentHost;
    if (!desktop?.openPath || !dir) return;
    try {
      await desktop.openPath(dir);
    } catch {
      /* ignore */
    }
  }

  // 下载文件夹压缩包（?zip=1，浏览器/桌面下载桥直接拉取）
  function zipArtifactFolder(rel: string) {
    const url = `${buildArtifactUrl(rel)}&zip=1`;
    const desktop = (window as unknown as { agentHost?: { download?: (u: string, n: string) => Promise<boolean> } }).agentHost;
    const filename = `${rel.split("/").pop() || "folder"}.zip`;
    if (desktop?.download) void desktop.download(url, filename);
    else window.open(url, "_blank");
  }

  // 重命名产物（文件/文件夹），返回是否成功
  async function renameArtifact(rel: string, newName: string, isDir: boolean): Promise<boolean> {
    const res = await apiFetch(`${basePath}/api/artifact?session=${encodeURIComponent(activeSid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rename", file: rel, name: newName, isDir }),
    });
    return res.ok;
  }

  async function moveArtifact(rel: string, destination: string, isDir: boolean): Promise<boolean> {
    const res = await apiFetch(`${basePath}/api/artifact?session=${encodeURIComponent(activeSid)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "move", file: rel, destination, isDir }),
    });
    return res.ok;
  }

  // 删除产物（文件/文件夹，目录递归），返回是否成功
  async function deleteArtifact(rel: string, isDir: boolean): Promise<boolean> {
    const res = await apiFetch(`${basePath}/api/artifact?session=${encodeURIComponent(activeSid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", file: rel, isDir }),
    });
    return res.ok;
  }

  // 新建产物文件夹（当前目录 rel 下），返回结果：ok=创建成功 / exists=同名已存在 / error=其他失败
  async function createArtifactFolder(rel: string, name: string): Promise<"ok" | "exists" | "error"> {
    const res = await apiFetch(`${basePath}/api/artifact?session=${encodeURIComponent(activeSid)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create", file: rel, name }),
    });
    if (res.ok) return "ok";
    if (res.status === 409) return "exists";
    return "error";
  }

  // 打开右栏产物面板：「查看所有产物」按钮使用；未缓存则先拉取。
  // 显式打开产物时聚焦对应预览；无产物时右栏显示作业选择器。
  // 有产物时自动聚焦第一个并进入预览（类似 diff 面板的 tab 体验），而非停留在列表。
  function openArtifactList(id: string) {
    setDiffView(null); // 打开产物列表：退出变更 diff 视图
    setInputFilePreview(null); // 打开产物列表：退出输入文件预览
    setPreviewFull(false); // 返回列表态：退出产物全屏
    setRightOpen(true);
    const arts = artifactLists[id];
    if (arts && arts.length > 0) {
      setPreview({ sid: id, meta: arts[0] });
    } else {
      setPreview(null);
    }
    // 显式打开总是重新拉取：避免首次空开缓存了空数组后，后续新生成的文件不再出现。
    autoFocusNewArtifactsRef.current = true;
    void refreshArtifactList(id, true);
  }

  // 展开右栏：浏览器实时预览等自动场景使用
  function openRight() {
    setRightOpen(true);
  }

  // 群聊 AI 消息「查看产出物 / 查看变更」：CoworkPanel 派发窗口事件，主窗口在这里打开右栏。
  useEffect(() => {
    const onOpenArtifacts = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail?.sessionId || detail.sessionId !== activeSid) return;
      openArtifactList(activeSid);
    };
    const onOpenDiff = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; activeId?: string; changes?: ArtifactChange[] }>).detail;
      if (!detail?.sessionId || detail.sessionId !== activeSid || !detail.activeId) return;
      setCoworkDiffChanges({ sid: activeSid, changes: Array.isArray(detail.changes)
        ? detail.changes.filter(change => change.change === "modified" || change.change === "deleted") : [] });
      setPreview(null);
      setPreviewFull(false);
      setInputFilePreview(null);
      setDiffView({ sid: activeSid, activeId: detail.activeId });
      setRightOpen(true);
    };
    window.addEventListener(AGENT_OPEN_ARTIFACTS_EVENT, onOpenArtifacts);
    window.addEventListener(AGENT_OPEN_DIFF_EVENT, onOpenDiff);
    // 群聊新消息到达：CoworkPanel 广播后合并进本会话 rt.messages（按 id 升序插入/替换）。
    // 群聊消息只存在于 CoworkPanel 状态，不合并则右栏「输入文件」缺群聊进行中新增的附件。
    const onCoworkMessage = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string;
        message?: {
          id: number; role: string; content: string; revokedAt?: string | null;
          senderSub?: string | null; senderName?: string | null; senderAvatar?: string | null;
          createdAt?: string | null; attachment?: UiAttachment | UiAttachment[] | null;
        };
      }>).detail;
      if (!detail?.sessionId || !detail.message || typeof detail.message.id !== "number") return;
      const cow = detail.message;
      const rawAttachments = Array.isArray(cow.attachment) ? cow.attachment : cow.attachment ? [cow.attachment] : [];
      const ui: UiMessage = {
        id: cow.id,
        role: cow.role === "assistant" ? "assistant" : "user",
        senderSub: cow.senderSub ?? null,
        senderName: cow.senderName ?? null,
        senderAvatar: cow.senderAvatar ?? null,
        content: String(cow.content || ""),
        createdAt: cow.createdAt ? String(cow.createdAt) : null,
        revokedAt: cow.revokedAt ? String(cow.revokedAt) : null,
        attachment: rawAttachments[0],
        attachments: rawAttachments,
      };
      const rt = getRt(detail.sessionId);
      const exists = rt.messages.some((item) => item.id === ui.id);
      rt.messages = exists
        ? rt.messages.map((item) => item.id === ui.id ? ui : item)
        : [...rt.messages, ui].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
      if (activeSidRef.current === detail.sessionId) setMessages([...rt.messages]);
    };
    window.addEventListener(COWORK_MESSAGE_UPDATE_EVENT, onCoworkMessage);
    // 群聊消息撤回：CoworkPanel 撤回成功后同步清理本会话 rt.messages 中对应消息的正文与附件。
    // 不清理会让已撤回消息的附件残留在右栏「输入文件」列表（该列表聚合自本窗口 messages）。
    const onCoworkRevoked = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; messageId?: number; revokedAt?: string }>).detail;
      if (!detail?.sessionId || typeof detail.messageId !== "number") return;
      const rt = getRt(detail.sessionId);
      rt.messages = rt.messages.map((message) => message.id === detail.messageId
        ? { ...message, content: "", images: undefined, voice: undefined, attachment: undefined, attachments: [], revokedAt: detail.revokedAt ?? new Date().toISOString() }
        : message);
      if (activeSidRef.current === detail.sessionId) setMessages([...rt.messages]);
    };
    window.addEventListener(COWORK_MESSAGE_REVOKED_EVENT, onCoworkRevoked);
    // 会话被外部更新（桌面卡片「重发最后一条消息」等）：非后台实例刷新会话列表；
    // 若正是当前显示中的会话，则重载该会话消息，保证与写盘数据同源。
    const onSessionUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (!detail?.sessionId || backgroundMode) return;
      if (activeSidRef.current === detail.sessionId) {
        const target = sessionsRef.current.find((item) => item.id === detail.sessionId);
        if (target) void switchSession(detail.sessionId, target, false);
      } else {
        void refreshSessions();
      }
    };
    window.addEventListener(AGENT_SESSION_UPDATED_EVENT, onSessionUpdated);
    return () => {
      window.removeEventListener(AGENT_OPEN_ARTIFACTS_EVENT, onOpenArtifacts);
      window.removeEventListener(AGENT_OPEN_DIFF_EVENT, onOpenDiff);
      window.removeEventListener(COWORK_MESSAGE_UPDATE_EVENT, onCoworkMessage);
      window.removeEventListener(COWORK_MESSAGE_REVOKED_EVENT, onCoworkRevoked);
      window.removeEventListener(AGENT_SESSION_UPDATED_EVENT, onSessionUpdated);
    };
    // openArtifactList 读取 artifactLists 状态，列表变化后重新绑定以拿到最新闭包。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSid, artifactLists]);

  /** 输入文件统一在右侧顶部标签预览；本机引用先检查是否仍可访问。 */
  /** 桌面宿主：显式走主进程下载（preload 桥 → session.fetch 重拉 + 保存对话框落盘）；web 无桥返回 false */
  const desktopDownload = (f: UiAttachment): boolean => {
    const desktop = (window as unknown as {
      agentHost?: { download?(url: string, filename: string): Promise<unknown> };
    }).agentHost;
    if (desktop?.download) {
      void desktop.download(`${resolveFileUrl(f.url, f.fileId)}&download=1`, f.name || "file");
      return true;
    }
    return false;
  };
  async function openInputFile(f: UiAttachment) {
    if (isLocalReference(f.url) && localFiles) {
      let ref: LocalReference | undefined;
      try { ref = (await localFiles.list()).find((item) => item.url === f.url); }
      catch { setUploadError("无法读取本机引用，请稍后重试"); return; }
      if (!ref || ref.available === false) {
        setUploadError("此设备无法访问该文件夹或文件，请重新选择");
        return;
      }
      if (ref.kind === "folder") {
        if (!ref.path || !AGENT_HOST?.openPath) {
          setUploadError("无法打开本机文件夹");
          return;
        }
        try {
          const result = await AGENT_HOST.openPath(ref.path);
          if (!result.ok) setUploadError(result.error || "无法打开本机文件夹");
        } catch { setUploadError("无法打开本机文件夹"); }
        return;
      }
    }
    const t = fileArtifactType(f);
    setInputFilePreview({ url: resolveFileUrl(f.url, f.fileId), name: f.name, type: t });
    setRightOpen(true);
    if (window.matchMedia("(max-width: 767.98px)").matches) setSidebarOpen(false);
  }

  async function revealInputFile(f: UiAttachment) {
    if (!localFiles || !isLocalReference(f.url)) return;
    try {
      if (await localFiles.reveal(f.url)) return;
    } catch { /* missing or inaccessible local reference */ }
    setLocalRefOpenMsg("此设备无法定位该文件或文件夹，请重新选择");
    setTimeout(() => setLocalRefOpenMsg(""), 3000);
  }

  function downloadMessageFile(f: UiAttachment) {
    if (desktopDownload(f)) return;
    const url = resolveFileUrl(f.url, f.fileId);
    const link = document.createElement("a");
    link.href = `${url}${url.includes("?") ? "&" : "?"}download=1`;
    link.download = f.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // 变更历史独立于产出物列表：既有文件不会出现在产出物中，删除也不能抹掉变更证据。
  // 同一文件跨轮次保留最初修改前内容和最新内容，展示会话累计差异。
  // 群聊 AI 消息的产物变更经 AGENT_OPEN_DIFF_EVENT 实时带过来（群 SSE 不写 rt.messages），
  // 与历史聚合结果按 id 合并，保证「查看变更」刚生成就能打开对应 diff。
  const [coworkDiffChanges, setCoworkDiffChanges] = useState<{ sid: string; changes: ArtifactChange[] } | null>(null);
  const sessionChanges = useMemo(() => {
    const base = aggregateArtifactChanges(messages);
    if (!coworkDiffChanges || coworkDiffChanges.sid !== activeSid) return base;
    const merged = new Map(base.map(change => [change.id, change]));
    for (const change of coworkDiffChanges.changes) merged.set(change.id, change);
    return [...merged.values()];
  }, [messages, coworkDiffChanges, activeSid]);

  // 右栏「输入文件」列表：当前输入附件 + 本会话历史 user 消息附件（按 url 去重）。
  // 已撤回的消息（revokedAt）不参与聚合：撤回即视为该消息及附件一并删除，
  // 无论其附件字段是否残留都不应再出现在输入文件列表。
  // 每项携带来源消息 messageId：右栏「查看上传文件」可据此定位到上传该文件的那条消息。
  const inputFiles = useMemo(() => {
    const seen = new Set<string>();
    const out: (UiAttachment & { messageId?: number | null })[] = [];
    for (const m of messages) {
      if (m.role !== "user" || m.revokedAt) continue;
      const files = m.attachments ?? (m.attachment ? [m.attachment] : []);
      for (const a of files) if (a.url && !seen.has(a.url)) {
        seen.add(a.url);
        out.push({ ...a, kind: a.kind ?? (isLocalReference(a.url) ? localRefKinds[a.url] : undefined), messageId: m.id ?? null });
      }
    }
    for (const a of attachments) if (a.url && !seen.has(a.url)) out.push({ ...a, kind: a.kind ?? (isLocalReference(a.url) ? localRefKinds[a.url] : undefined), messageId: null });
    return out;
  }, [messages, attachments, localRefKinds]);

  /** 切换会话：不 abort 旧流（旧会话在后台继续跑），加载目标会话历史到它自己的 rt。 */
  async function switchSession(id: string, sessionOverride?: SessionItem, navigate = true) {
    homeMentionRequestRef.current++;
    homeRoutedNamesRef.current = null;
    homeSelectedGroupRef.current = null;
    homeSelectedContactsRef.current = [];
    setHomeSelectedChips([]);
    homeMentionKeyRef.current = "";
    setHomeGroupRecipients([]);
    setMemoryOpen(false);
    setActiveNavigation("home");
    setConversationView(true);
    if (id !== activeSidRef.current) flushDraft();
    if (navigate && (readAgentLocation(navigationKeys)?.view !== "session" || readAgentLocation(navigationKeys)?.sessionId !== id)) {
      writeAgentLocation({ view: "session", sessionId: id });
    }
    setLibraryOpen(false);
    // 切换会话：关闭「选择工作空间」popup（避免切回空态新会话时残留弹出）
    setWsMenuOpen(false);
    const requestId = ++sessionHistoryRequestRef.current;
    // 冻结右栏显示决策：切换运算完成前保持切换前的显示态，避免「开一半又关」的闪烁。
    // 若已经处于冻结（连续快速切换），沿用现有快照，保持视觉连续、不重新计算。
    if (!rightFrozen) {
      rightShownSnapshotRef.current = rightOpen;
    }
    setRightFrozen(true);
    setLoadingSessionId(id);
    setHistoryLoadError(null);
    try {
      // 桌面壳：AI 单聊从本地落盘读消息；人际 1v1/群聊走云端 /messages；web 项目会话读 localStorage
      let localHistory: UiMessage[] | null = null;
      let data: { messages?: Array<Record<string, unknown>>; members?: Array<{ contactId: string; name: string; avatar: string }>; ownerSub?: string } = {};
      const targetSession = sessionOverride ?? sessions.find((item) => item.id === id);
      if (localChat && isAiOnlyChat(targetSession)) {
        localHistory = (await localChatMessages(localOwner, id)) ?? [];
      } else {
        const stored = localFiles && (sessionOverride?.projectDir || sessions.find((item) => item.id === id)?.projectDir)
          ? localProjectMessages(initialUser.unionId || "", id) : null;
        if (stored) {
          localHistory = stored;
        } else {
          const res = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(id)}/messages`, { cache: "no-store" });
          if (!res.ok) throw new Error("history load failed");
          data = await res.json();
        }
      }
      if (requestId !== sessionHistoryRequestRef.current) return;
      setConversationMembers((Array.isArray(data.members) ? data.members : []).map((m: { provider?: string; contactId: string; name: string; avatar: string }) => ({ provider: m.provider ?? "", contactId: m.contactId, name: m.name, avatar: m.avatar })));
      setConversationOwnerSub(data.ownerSub || "");
      setPendingMembers([]); // 切入已有会话：清掉草稿预选成员，避免误写入他人会话
      const history: UiMessage[] = localHistory ?? (Array.isArray(data.messages)
        ? data.messages.map((m) => {
            const base: UiMessage = {
              id: typeof m.id === "number" ? m.id : undefined,
              revokedAt: typeof m.revokedAt === "string" ? m.revokedAt : null,
              role: m.role === "assistant" ? "assistant" : "user",
              senderSub: typeof m.senderSub === "string" ? m.senderSub : null,
              senderName: typeof m.senderName === "string" ? m.senderName : null,
              senderAvatar: typeof m.senderAvatar === "string" ? m.senderAvatar : null,
              content: String(m.content || ""),
              voice: m.voice && typeof m.voice === "object" && typeof (m.voice as UiVoiceRecording).fileId === "string"
                ? m.voice as UiVoiceRecording : undefined,
              images: Array.isArray(m.images) ? m.images as UiImage[] : undefined,
              createdAt: m.createdAt ? String(m.createdAt) : null,
            };
            if (base.role === "assistant") {
              return {
                ...base,
                steps: Array.isArray(m.steps) ? (m.steps as UiStep[]) : [],
                thinkingSecs: m.thinkingSecs != null ? Number(m.thinkingSecs) : null,
                elapsedSecs: m.elapsedSecs != null ? Number(m.elapsedSecs) : null,
                modelInfo: (m.modelInfo as ModelInfo) || null,
                // 恢复本轮产物清单：文件卡片与「查看所有产物」按钮在刷新/重开后仍然可见
                artifacts: Array.isArray(m.artifacts) ? (m.artifacts as ArtifactMeta[]) : undefined,
                // 恢复本轮消耗（usage/costUsd）：刷新/切会话后回复底部「消耗 …」不再消失
                costInfo: (m.costInfo as UiMessage["costInfo"]) || null,
              };
            }
            // 恢复用户消息的上传附件（附件条 / 右栏输入文件列表）
            const rawAttachments = Array.isArray(m.attachment) ? m.attachment : m.attachment ? [m.attachment] : [];
            const restored = rawAttachments.flatMap((att: Partial<UiAttachment>) =>
              att && typeof att.url === "string" && att.url
                ? [{ url: att.url, name: typeof att.name === "string" ? att.name : att.url, size: typeof att.size === "number" ? att.size : undefined, fileId: typeof att.fileId === "string" ? att.fileId : undefined, kind: att.kind === "folder" || att.kind === "file" ? att.kind : undefined }]
                : []);
            return {
              ...base,
              attachment: restored[0],
              attachments: restored,
            };
          })
        : []);
      const projectSession = sessionOverride ?? sessions.find((item) => item.id === id);
      if (localFiles && projectSession?.workspaceDir && !localHistory) {
        saveLocalProjectSession(initialUser.unionId || "", projectSession, history);
      }
      const rt = getRt(id);
      // 关键：该会话正在流式生成时（rt.busy），服务端历史尚未包含本轮刚发的用户消息与进行中的回复。
      // 此时若无条件用 history 覆盖 rt.messages，会把「已发出但未落库」的实时内容冲掉 → 切回来消息消失。
      // 故busy 时只做标记（下方 setActiveSid 触发的 effect 会把 rt.messages 同步到渲染），
      // 让后台流继续往 rt.messages 写；待本轮结束（idle）后再次进入该会话才会用 history 兜底校正。
      if (!rt.busy) {
        // 老数据兼容：历史末尾可能留着「空答复占位」（旧版本会把占位一起落盘），
        // 带进来就是一个永远不填内容的空气泡，还会挡住下面「接管正在跑的那一轮」的判定。
        rt.messages = trimEmptyAssistantTail(history);
        rt.openThinking = new Set();
      }
      // 历史恢复后重算「待确认」集合（恢复的消息可能含已回答的提问卡片，判定自动解除）
      syncPendingQuestionSids();
      rt.sessionRegistered = true;
      rt.sessionStarted = true;
      // 历史恢复：默认折叠所有有 steps 的助手消息（豆包 Work 式，点击「已完成」卡片展开）。
      // 正文为空（模型最后一步是工具调用/异常）的消息保持展开——折叠会把步骤整块隐藏，
      // 用户看到的将是「无正文、无过程」的空气泡，无法判断发生了什么。
      // 折叠索引必须基于**实际生效的消息**（busy 时是 rt.messages 而非 history），否则索引与渲染错位。
      const foldedInit = new Set<number>();
      const foldingSource = rt.messages;
      foldingSource.forEach((hm, hi) => {
        if (
          hm.role === "assistant" &&
          Array.isArray(hm.steps) &&
          hm.steps.length > 0 &&
          (hm.content || "").trim()
        ) {
          foldedInit.add(hi);
        }
      });
      setFoldedProcess(foldedInit);
      setSessionId(id);
      setActiveSid(id); // useEffect 会把 rt.messages 同步到渲染
      if (localChat && isAiOnlyChat(targetSession) && !backgroundMode) {
        // 本地 AI 单聊：仅清前端未读角标，不上报云端已读游标
        setSessions((list) => list.map((item) => item.id === id ? { ...item, unreadCount: 0, aiUnread: false, lastMentionedMe: false } : item));
      } else if (localChat && isAiOnlyChat(targetSession)) {
        // 后台运行器载入会话不等于用户阅读，保留未读状态。
      } else {
        const lastReadId = history.at(-1)?.id;
        if (typeof lastReadId === "number") {
          void apiFetch(`${basePath}/api/sessions/${encodeURIComponent(id)}/read`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ throughId: lastReadId }),
          }).then(response => {
            if (response.ok) setSessions(list => list.map(item => item.id === id ? { ...item, unreadCount: 0, aiUnread: false, lastMentionedMe: false } : item));
          }).catch(() => {});
        }
      }
      activeSidRef.current = id; // 同步 ref：使下方 refreshArtifactList 内「仅当前会话」的显隐判定立即生效（不再等 effect 滞后）
      // A refreshed tab can replay the same run from event 0. The user turn is
      // already in history; recovery must not append or execute it again.
      if (!rt.busy && !backgroundMode) {
        try {
          const saved = JSON.parse(window.localStorage.getItem(`agent-kit:active-run:${id}`) || "null") as
            { runId?: unknown; sdkSid?: unknown; mode?: unknown; startedAt?: unknown } | null;
          if (saved && typeof saved.runId === "string" && typeof saved.sdkSid === "string" &&
              typeof saved.mode === "string" && ["codebuddy", "codex", "cc", "dsh"].includes(saved.mode) && typeof saved.startedAt === "number" &&
              Date.now() - saved.startedAt < 24 * 60 * 60 * 1000 && rt.messages.at(-1)?.role === "user") {
            void send(undefined, null, { sid: id, runId: saved.runId, sdkSid: saved.sdkSid, mode: saved.mode as NonNullable<ModelInfo["agentMode"]> });
          } else if (saved) {
            window.localStorage.removeItem(`agent-kit:active-run:${id}`);
          }
        } catch { /* ignore malformed local state */ }
      }
      if (!backgroundMode) writeLastSession(id); // 后台刷新不改用户下次进入时打开的会话
      if (completedCardSidsRef.current.has(id)) {
        const nextCards = new Set(completedCardSidsRef.current);
        nextCards.delete(id);
        completedCardSidsRef.current = nextCards;
        setCompletedCardSids(nextCards);
      }
      if (localChat && !backgroundMode) void localChatPatch(localOwner, id, { aiUnread: false });
      // 打开会话即视为已查看：清除其「已完成未查看」标记（小绿圈消失）
      if (unseenDoneSidsRef.current.has(id)) {
        const nextDone = new Set(unseenDoneSidsRef.current);
        nextDone.delete(id);
        unseenDoneSidsRef.current = nextDone;
        setUnseenDoneSids(nextDone);
      }
      syncModelForSession(id); // 模型按会话隔离：切到该会话时恢复它上次选中的模型
      // 恢复本会话的工作目录（沙箱范围）：会话列表缓存里可能没有 workspace_dir（老会话），缺省置空
      const s = sessionOverride ?? sessions.find((x) => x.id === id);
      const storedLayout = localStorage.getItem(`agent-kit:view-layout:${id}`);
      const layout = s?.viewLayout ?? (storedLayout === "split" || storedLayout === "compare" ? storedLayout : "single");
      const mobile = window.matchMedia("(max-width: 767.98px)").matches;
      setSplit(!mobile && !embeddedMode && multiFramework && layout === "split");
      setCompareOnly(!mobile && !embeddedMode && multiFramework && layout === "compare");
      setCompareSubmission(null);
      setWorkspaceDir(s?.workspaceDir ?? null);
      // 切换会话：重置滚动状态（内容替换后无 scroll 事件可自愈，必须显式复位），
      // 置顶模式/「回到底部」按钮对空内容无效。
      resetScrollState();
      // 切换会话不关闭左栏：用户可在会话列表间连续切换/对比（右栏产物列表随之刷新）
      setRenameId(null);
      // 先切内容后查权限：立即关闭旧会话的预览，右侧面板随之切到新会话的状态；
      // 产物列表拉取是后台异步，权限校验失败时只影响该会话的列表内容，不阻塞本次切换。
      setPreview(null);
      setDiffView(null); // 切换会话：退出上一会话的变更 diff 视图
      setInputFilePreview(null); // 切换会话：退出上一会话的输入文件预览
      setPreviewFull(false); // 切换会话：退出上一会话的产物全屏态
      autoFocusNewArtifactsRef.current = false; // 切换会话：取消上一会话残留的自动聚焦
      // 上下文用量：优先用历史最后一条带消耗的助手消息回填（刷新/切会话后圆环不再消失）；
      // 无历史消耗则清空，等本轮 cost_info 填充。
      const lastCostMsg = [...history].reverse().find((hm) => hm.role === "assistant" && hm.costInfo);
      const restoredUsed = contextUsedTokens(lastCostMsg?.costInfo?.usage);
      setCtxUsage((prev) => ({
        ...prev,
        usedTokens: restoredUsed > 0 ? restoredUsed : null,
        maxTokens: null,
      }));
      maxTokensRef.current = null; // 切换会话后上限缓存重置：立即补拉（命中服务端缓存）/ 首轮 cost_info 再填充
      if (restoredUsed > 0) void refreshContextLimit(id);
      // 切换会话时刷新产物列表；右栏展开状态由用户偏好决定。
      await refreshArtifactList(id);
    } catch {
      if (requestId === sessionHistoryRequestRef.current) setHistoryLoadError(id);
    } finally {
      if (requestId === sessionHistoryRequestRef.current) {
        setLoadingSessionId(null);
        // 运算完成：解冻右栏显示决策，落定为最终态（要么开、要么关，不再开一半又关）。
        // 受 requestId 保护：仅最新一次切换的收尾才解冻，避免旧切换的 finally 误解除新切换的冻结。
        setRightFrozen(false);
      }
    }
  }

  /** 新建会话：生成新 sid，不 abort 旧流（旧会话后台继续）。 */
  function newSession(navigate = true, restoreSid?: string): string {
    homeMentionRequestRef.current++;
    homeRoutedNamesRef.current = null;
    homeSelectedGroupRef.current = null;
    homeSelectedContactsRef.current = [];
    setHomeSelectedChips([]);
    homeMentionKeyRef.current = "";
    setConversationMembers([]);
    setPendingMembers([]); // 新建会话：清空上一草稿预选的成员（内存暂存不跨会话）
    setHomeGroupRecipients([]);
    setCoworkSubmission(null);
    setConversationOwnerSub("");
    setMemoryOpen(false);
    setActiveNavigation("home");
    setConversationView(navigate);
    flushDraft();
    const currentView = readAgentLocation(navigationKeys)?.view;
    const candidate = restoreSid ?? (navigate && currentView !== "new" ? pendingAgentDraft() : null);
    const restored = candidate ? rtMapRef.current.get(candidate) : null;
    // 已发送的草稿 ID 已变成真实会话；返回“新建任务”时创建新的空白输入区。
    const sid = candidate && !isAgentDraftConsumed() && !restored?.messages.length && !restored?.sessionRegistered ? candidate : generateSessionId();
    if (navigate || restoreSid !== sid) {
      writeAgentLocation({ view: "new", sessionId: sid }, navigate && currentView !== "new" ? "push" : "replace");
    }
    setLibraryOpen(false);
    sessionHistoryRequestRef.current++;
    setLoadingSessionId(null);
    setHistoryLoadError(null);
    setBooting(false);
    setSplit(false);
    setCompareOnly(false);
    setCompareSubmission(null);
    // 新建任务：清除上次打开的会话记录，刷新后停留在首页
    clearLastSession();
    getRt(sid); // 自动创建空 rt
    setSessionId(sid);
    setActiveSid(sid);
    activeSidRef.current = sid; // 同步 ref：changeModel 立即写到新会话的独立记忆，不必等 activeSid effect
    syncModelForSession(sid); // 新会话沿用默认模型（无会话记忆时）；若同id 已存在记忆则恢复之
    setOpenThinking(new Set());
    // 新会话默认不带工作目录：在输入框下方选择（每会话独立沙箱范围）
    setWorkspaceDir(null);
    setPermissionMode(permissionLocked ? "full" : readPermissionPreference(permissionMode));
    // 新建会话：重置滚动状态（空内容无 scroll 事件自愈，「回到底部」按钮不应出现）
    resetScrollState();
    // 新建会话同样不关闭左栏（与切换会话行为一致）；例外是空白入口
    // （closePanelsOnNewChat，如宿主 hover 输入框直接发消息）新建的会话：
    // 它从零开始，左右面板一律回到默认收起态，不继承上一次会话的展开状态。
    if (closePanelsOnNewChat) collapsePanelsForNewChat();
    setRenameId(null);
    // 新建会话：右侧立即切到新会话状态并显示作业选择器。
    setArtifactLists((current) => ({ ...current, [sid]: [] }));
    setPreview(null);
    setDiffView(null); // 新建会话：退出旧会话的变更 diff 视图
    setInputFilePreview(null); // 新建会话：退出旧会话的输入文件预览
    setPreviewFull(false); // 新建会话：退出旧会话的产物全屏态
    autoFocusNewArtifactsRef.current = false; // 新建会话：取消旧会话残留的自动聚焦
    setCtxUsage((prev) => ({ ...prev, usedTokens: null, maxTokens: null })); // 新会话无上下文：清用量，首轮 cost_info 再填充
    maxTokensRef.current = null; // 新建会话后上限缓存重置：首轮 cost_info 到达时补拉
    return sid;
  }

  // Ctrl+N（Windows/Linux）/ Cmd+N（macOS）：新建对话，与点侧栏「新建」走同一条 newSession 路径
  // （草稿落盘、会话列表刷新、上下文档位重置全一致）。桌面壳里该组合键的浏览器默认行为
  // （开新窗口）没有意义，统一接管；回调经 ref 透传，避免把每次渲染都重新生成的 newSession
  // 塞进依赖数组。
  const newSessionRef = useRef(newSession);
  newSessionRef.current = newSession;
  useEffect(() => {
    if (embeddedMode || !shortcutsActive) return;
    const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
    const onKeyDown = (event: KeyboardEvent) => {
      // 输入法组合中不抢（候选词窗口可能用到字母键）；只认不带 Shift/Alt 的主修饰键。
      if (event.isComposing || event.shiftKey || event.altKey) return;
      // mac 上只认 Cmd（Ctrl+N 在 mac 习惯里是「下一行」之类），Windows/Linux 只认 Ctrl。
      const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!primary || event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      newSessionRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [embeddedMode, shortcutsActive]);

  // Ctrl/Cmd+B：切换左侧面板；Ctrl/Cmd+O：切换右侧面板。
  // 与顶栏/侧栏的 toggle 按钮走同一份 state（持久化、展开动画、窄屏紧凑态全都一致），
  // 所以不需要额外维护"快捷键里打开的面板"这种分支。右栏关闭时同样清掉 diff/文件预览，
  // 与按钮那条路径保持完全一致（否则下次打开会莫名其妙回到上次的分屏视图）。
  // 多窗口宿主只给最上层实例开 shortcutsActive，避免一次按键把所有窗口的面板都翻一遍。
  const rightOpenHotkeyRef = useRef(rightOpen);
  rightOpenHotkeyRef.current = rightOpen;
  useEffect(() => {
    if (embeddedMode || !shortcutsActive) return;
    const mac = typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.shiftKey || event.altKey) return;
      const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!primary) return;
      const key = event.key.toLowerCase();
      if (key === "b") {
        event.preventDefault();
        setSidebarOpen((open) => !open);
      } else if (key === "o") {
        event.preventDefault();
        if (rightOpenHotkeyRef.current) {
          setRightOpen(false);
          setDiffView(null);
          setInputFilePreview(null);
        } else {
          setRightOpen(true);
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [embeddedMode, shortcutsActive]);

  function saveViewLayout(layout: "single" | "split" | "compare") {
    if (embedded?.temporary) return;
    localStorage.setItem(`agent-kit:view-layout:${activeSid}`, layout);
    setSessions((list) => list.map((session) => session.id === activeSid ? { ...session, viewLayout: layout } : session));
    const layoutTarget = sessionsRef.current.find((item) => item.id === activeSid);
    if (isLoggedIn && !(localChat && isAiOnlyChat(layoutTarget))) {
      void apiFetch(`${basePath}/api/sessions/${encodeURIComponent(activeSid)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ viewLayout: layout }),
      }).catch(() => {});
    }
  }

  function closeSplitView(side: "left" | "right") {
    setSplit(false);
    setCompareOnly(side === "left" && !isEmptyView);
    setCompareSubmission(null);
    if (isEmptyView) newSession();
    else saveViewLayout(side === "left" ? "compare" : "single");
  }

  function openLibrary(navigate = true) {
    setMemoryOpen(false);
    setActiveNavigation("library");
    flushDraft();
    if (navigate && readAgentLocation(navigationKeys)?.view !== "library") writeAgentLocation({ view: "library" });
    // 资料库没有选中会话；取消进行中的历史恢复，刷新后回新建任务。
    sessionHistoryRequestRef.current++;
    setLoadingSessionId(null);
    setRightFrozen(false);
    clearLastSession();
    setLibraryOpen(true);
    setPreviewFull(false);
    setRightOpen(false);
    if (window.matchMedia("(max-width: 767.98px)").matches) setSidebarOpen(false);
  }

  function openMemory() {
    setMemoryOpen(true);
    setUserOpen(false);
  }

  function replaceMobileTabRoot(item: string) {
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.delete("session");
    url.searchParams.delete("draft");
    if (item !== "home") url.searchParams.set("view", item);
    window.history.replaceState({ ...window.history.state, agentNav: { index: 0 }, agentMobileWorkPage: undefined }, "", url);
    mobileWorkNav.resetRoot();
  }

  function restoreMobileTab(item: string) {
    replaceMobileTabRoot(item);
    selectNavigation(item, false);
    const saved = tabLocationsRef.current[item];
    if (item !== "home" || !saved) return;
    restoreConversationTab(saved);
  }

  function restoreConversationTab(saved: { view: "session" | "new"; sessionId?: string }) {
    writeAgentLocation(saved);
    if (saved.view === "session" && saved.sessionId) {
      if (saved.sessionId === activeSidRef.current) {
        setActiveNavigation("home");
        setLibraryOpen(false);
        setConversationView(true);
      }
      else void switchSession(saved.sessionId, undefined, false);
    } else if (saved.view === "new") {
      newSession(false, saved.sessionId);
      setConversationView(true);
    }
  }

  function selectNavigation(item: string, navigate = true) {
    if (navigate && item !== activeNavigation && !embeddedMode) {
      const mobile = window.matchMedia("(max-width: 767.98px)").matches;
      if (activeNavigation === "home") {
        const location = !mobile || conversationView ? readAgentLocation(navigationKeys) : null;
        if (location?.view === "session" || location?.view === "new")
          tabLocationsRef.current.home = { view: location.view, sessionId: location.sessionId };
        else delete tabLocationsRef.current.home;
      }
      if (mobile) {
        const depth = window.history.state?.agentNav?.index ?? 0;
        if (depth > 0) {
          pendingMobileTabRef.current = item;
          window.history.go(-depth);
        } else {
          restoreMobileTab(item);
        }
        return;
      }
      const saved = tabLocationsRef.current[item];
      if (item === "home" && saved) {
        restoreConversationTab(saved);
        return;
      }
    }
    setMemoryOpen(false);
    if (item === "library") { openLibrary(navigate); return; }
    if (item === "home") {
      setActiveNavigation("home");
      setLibraryOpen(false);
      if (navigate) newSession();
      setConversationView(false);
      if (!navigate && window.matchMedia("(max-width: 767.98px)").matches) {
        const url = new URL(window.location.href);
        url.searchParams.delete("view");
        url.searchParams.delete("session");
        url.searchParams.delete("draft");
        window.history.replaceState(window.history.state, "", url);
      }
      if (window.matchMedia("(max-width: 767.98px)").matches && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      // Embedded side chats may have saved a session while the workbench was open.
      void refreshSessions();
      return;
    }
    flushDraft();
    if (navigate && readAgentLocation(navigationKeys)?.view !== item) writeAgentLocation({ view: item });
    setActiveNavigation(item);
    setLibraryOpen(false);
    setRightOpen(false);
  }

  async function startConversationWithLibraryFile(file: LibraryFile) {
    setLibraryOpen(false);
    newSession();
    try {
      if (localFiles) {
        const ref = await localFiles.cacheCloudFile(file.id, file.name);
        if (!ref) throw new Error("资料库文件下载失败");
        setAttachments((current) => [...current, { url: ref.url, name: ref.name, size: ref.size }]);
        return;
      }
      const response = await apiFetch(`${basePath}/api/file?fileId=${encodeURIComponent(file.id)}`, { cache: "no-store" });
      if (!response.ok) throw new Error("无法读取资料库文件");
      const blob = await response.blob();
      await uploadFiles([new File([blob], file.name, { type: file.mime || blob.type || "application/octet-stream" })]);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "添加文件失败");
    }
  }

  async function startConversationWithLocalReference(ref: LocalReference) {
    if (!localFiles || ref.available === false) return;
    setLibraryOpen(false);
    newSession();
    setAttachments((current) => [...current, { url: ref.url, name: ref.name, size: ref.size }]);
  }

  /**
   * 宿主定向会话跳转（点击系统通知）。
   * 必须等会话列表加载完再判断目标是否存在：否则刚启动时列表还是空的，
   * 会把「会话存在」误判成「已删除」而丢掉这次跳转。
   */
  useEffect(() => {
    if (!sessionRequest || sessionsLoading) return;
    if (handledSessionRequestRef.current === sessionRequest.nonce) return;
    handledSessionRequestRef.current = sessionRequest.nonce;
    const targetId = sessionRequest.sessionId;
    if (targetId === activeSidRef.current && completedCardSidsRef.current.has(targetId)) {
      const nextCards = new Set(completedCardSidsRef.current);
      nextCards.delete(targetId);
      completedCardSidsRef.current = nextCards;
      setCompletedCardSids(nextCards);
    }
    if (targetId === activeSidRef.current && localChat) {
      setSessions((list) => list.map((item) => item.id === targetId ? { ...item, aiUnread: false } : item));
      void localChatPatch(localOwner, targetId, { aiUnread: false });
    }
    if (targetId !== activeSidRef.current) {
      const target = sessionsRef.current.find((item) => item.id === targetId);
      if (target) void switchSession(target.id, target);
    }
    onSessionRequestHandled?.(sessionRequest.nonce);
  }, [sessionRequest, sessionsLoading]);

  /**
   * 宿主投递的「@联系人」预选（联系人窗口点「发消息」），与 home 输入框内 @ 选择同一人等价：
   * resolveHomeContactSession 找历史 1v1（含 user 消息才算历史，否则按新会话处理）→
   * openPersonChat 跳转历史或进入新建草稿，并在输入框顶部渲染成员 chip。
   * 必须等会话列表加载完再处理（否则 sessions 为空，跳转会误判）。
   */
  useEffect(() => {
    if (!mentionRequest || sessionsLoading) return;
    if (handledMentionRequestRef.current === mentionRequest.nonce) return;
    handledMentionRequestRef.current = mentionRequest.nonce;
    const { person, nonce } = mentionRequest;
    if (!resolveHomeContactSession) {
      onMentionRequestHandled?.(nonce);
      return;
    }
    void resolveHomeContactSession(person.id).then(async candidateId => {
      let sessionId = candidateId;
      if (sessionId) {
        const history = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/messages`, { cache: "no-store" });
        const data = history.ok ? await history.json().catch(() => null) as { messages?: Array<{ role?: string }> } | null : null;
        if (!data?.messages?.some(message => message.role === "user")) sessionId = null;
      }
      if (handledMentionRequestRef.current !== nonce) return;
      openPersonChat({ id: person.id, name: person.name, avatar: person.avatar, provider: "builtin", department: "", title: "", email: "", sessionId }, undefined);
      homeSelectedContactsRef.current = [{ id: person.id, name: person.name, avatar: person.avatar }];
      setHomeSelectedChips([{ id: person.id, name: person.name, avatar: person.avatar }]);
      if (sessionId) homeRoutedNamesRef.current = [person.name];
      if (sessionId) homeMentionKeyRef.current = person.id;
      // 不调 onExistingPersonChatOpened：宿主（联系人窗口）已用 PROMOTE_PRIMARY 打开/前置主窗口，
      // 再触发 OPEN_FOCUS_CHAT 会带来「跳到未读会话」的 sessionRequest，覆盖本次联系人跳转。
      onMentionRequestHandled?.(nonce);
    }).catch(() => { onMentionRequestHandled?.(nonce); setNewSessionNotice("联系人会话查询失败，请重试"); });
  }, [mentionRequest, sessionsLoading]);

  const handledRerunRequestRef = useRef(0);
  const [pendingRerun, setPendingRerun] = useState<{ sessionId: string; nonce: number; text: string; attachments: UiAttachment[]; mode: string | null } | null>(null);
  useEffect(() => {
    if (!rerunRequest || sessionsLoading || handledRerunRequestRef.current === rerunRequest.nonce) return;
    handledRerunRequestRef.current = rerunRequest.nonce;
    let cancelled = false;
    void (async () => {
      const target = sessionsRef.current.find((item) => item.id === rerunRequest.sessionId);
      if (!target || !isAiOnlyChat(target) || !localChat) {
        onRerunRequestHandled?.(rerunRequest.nonce, "会话不存在或不支持刷新");
        return;
      }
      const rt = getRt(target.id);
      if (rt.busy) {
        onRerunRequestHandled?.(rerunRequest.nonce, "会话正在运行");
        return;
      }
      try {
        const history = await localChatMessages(localOwner, target.id);
        if (cancelled) return;
        const lastUser = [...(history ?? [])].reverse().find((message) => message.role === "user" && (message.content?.trim() || message.attachments?.length || message.attachment));
        if (!lastUser) {
          onRerunRequestHandled?.(rerunRequest.nonce, "没有可重新发送的用户消息");
          return;
        }
        const attachments = lastUser.attachments ?? (lastUser.attachment ? [lastUser.attachment] : []);
        const header = attachments.map((attachment) => `[附件] ${attachment.name}`).join("\n");
        const text = header && lastUser.content?.startsWith(header) ? lastUser.content.slice(header.length).trimStart() : lastUser.content || "";
        await switchSession(target.id, target, false);
        if (cancelled) return;
        let mode: string | null = null;
        try { mode = window.localStorage.getItem(`agent-kit:mode:${target.id}`); } catch { /* use current mode */ }
        setPendingRerun({ sessionId: target.id, nonce: rerunRequest.nonce, text, attachments, mode });
      } catch {
        if (!cancelled) onRerunRequestHandled?.(rerunRequest.nonce, "无法读取会话历史");
      }
    })();
    return () => { cancelled = true; };
    // The request nonce is the sole trigger; model/session state is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerunRequest, sessionsLoading]);
  useEffect(() => {
    if (!pendingRerun || activeSid !== pendingRerun.sessionId || !modelsLoaded) return;
    if ((pendingRerun.mode === "codebuddy" || pendingRerun.mode === "codex")
      && agentModes.includes(pendingRerun.mode) && agentMode !== pendingRerun.mode) return;
    if (agentMode === "codebuddy" && autoFetchModels && !modelOptions.length) {
      setPendingRerun(null);
      onRerunRequestHandled?.(pendingRerun.nonce, modelError || "当前没有可用模型");
      return;
    }
    setPendingRerun(null);
    onRerunRequestHandled?.(pendingRerun.nonce);
    void send(pendingRerun.text, pendingRerun.attachments, undefined, undefined, null, []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRerun, activeSid, agentMode, modelsLoaded, modelOptions.length, modelError]);

  /**
   * 宿主请求向指定会话**新增**一轮消息（桌面把本机文件拖到会话卡片）。
   * 与 rerunRequest 的差别：这是新的一轮，附件由宿主给出，可以只有附件没有正文。
   *
   * `sessionId` 缺省 = 新开一条对话再发（语音优先的「一句一对话」）：
   * 先走 newSession()（与点「新建对话」完全同一条路径），再把这段话作为该会话的第一轮。
   */
  const handledSendRequestRef = useRef(0);
  const [pendingSend, setPendingSend] = useState<{ sessionId: string; nonce: number; text: string; attachments: UiAttachment[]; mode: string | null } | null>(null);
  useEffect(() => {
    if (!sendRequest || sessionsLoading || handledSendRequestRef.current === sendRequest.nonce) return;
    handledSendRequestRef.current = sendRequest.nonce;
    let cancelled = false;
    void (async () => {
      if (!localChat) {
        onSendRequestHandled?.(sendRequest.nonce, "本机会话不可用");
        return;
      }
      // —— 新对话：语音优先「一句一对话」——
      // 多数情况下「按住语音键」时窗口刚刚挂载，newChatOnMount 已经建好一个空白会话，
      // 这里优先**复用**它（activeSid 就是那个空会话），不要再 newSession，
      // 否则松手发送会留下一个永远空着的会话孤儿。
      // 仅当当前会话已经有内容（用户在看一段已有对话、又按了语音键但该窗口没拿到焦点）
      // 时才新建一条对话，保证「一条语音 = 一条新对话」。
      if (!sendRequest.sessionId) {
        const current = activeSidRef.current;
        const currentRt = getRt(current);
        const currentIsEmpty = !currentRt?.messages?.some((message) => message.role === "user") && !isAgentDraftConsumed();
        const sid = currentIsEmpty ? current : newSession(false);
        if (cancelled) return;
        let mode: string | null = null;
        try { mode = window.localStorage.getItem(`agent-kit:mode:${sid}`); } catch { /* use current mode */ }
        setPendingSend({
          sessionId: sid, nonce: sendRequest.nonce,
          text: sendRequest.text ?? "", attachments: sendRequest.attachments ?? [], mode,
        });
        return;
      }
      const target = sessionsRef.current.find((item) => item.id === sendRequest.sessionId);
      if (!target || !isAiOnlyChat(target)) {
        onSendRequestHandled?.(sendRequest.nonce, "会话不存在或不支持发送");
        return;
      }
      const rt = getRt(target.id);
      if (rt.busy) {
        onSendRequestHandled?.(sendRequest.nonce, "会话正在运行");
        return;
      }
      try {
        await switchSession(target.id, target, false);
        if (cancelled) return;
        let mode: string | null = null;
        try { mode = window.localStorage.getItem(`agent-kit:mode:${target.id}`); } catch { /* use current mode */ }
        setPendingSend({
          sessionId: target.id, nonce: sendRequest.nonce,
          text: sendRequest.text ?? "", attachments: sendRequest.attachments ?? [], mode,
        });
      } catch {
        if (!cancelled) onSendRequestHandled?.(sendRequest.nonce, "无法切换到目标会话");
      }
    })();
    return () => { cancelled = true; };
    // The request nonce is the sole trigger; session/model state is handled by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendRequest, sessionsLoading]);
  useEffect(() => {
    if (!pendingSend || activeSid !== pendingSend.sessionId || !modelsLoaded) return;
    if ((pendingSend.mode === "codebuddy" || pendingSend.mode === "codex")
      && agentModes.includes(pendingSend.mode) && agentMode !== pendingSend.mode) return;
    if (agentMode === "codebuddy" && autoFetchModels && !modelOptions.length) {
      setPendingSend(null);
      onSendRequestHandled?.(pendingSend.nonce, modelError || "当前没有可用模型");
      return;
    }
    setPendingSend(null);
    onSendRequestHandled?.(pendingSend.nonce);
    // text 允许为空：只有附件时 send() 仍会发出一条只带附件的用户消息。
    void send(pendingSend.text, pendingSend.attachments, undefined, undefined, null, []);
    // 语音优先松手即发：发完输入框必须清空，不留草稿——
    // onRealtimeResult 说话过程中把文字写进了 composer，send() 内部清得可能不彻底
    // （松手后最后一帧 final 还可能回写），这里显式再清一次。
    composerRef.current?.setText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSend, activeSid, agentMode, modelsLoaded, modelOptions.length, modelError]);

  /**
   * 宿主请求把附件放进**输入框**（不发送）。
   *
   * 桌面三种拖放都走这一条内核：
   *  · 从文件管理组件拖到聊天窗 → 落进这个聊天窗的输入框；
   *  · 在会话卡片上停留 2 秒再松手 → 先打开该会话的聊天窗，落进它的输入框；
   *  · 拖到 Dock 的 home 按钮 → 悬浮输入框浮出，落进它的输入框。
   *
   * 两段式执行（和 sendRequest 同构）：
   *  1. 收到请求 → 若带 sessionId，先切到该会话。**必须等切换完成**：
   *     切会话会恢复该会话草稿里的附件（setAttachments(draft.attachments)），
   *     抢在恢复之前注入的话，刚放进去的附件会被草稿覆盖掉。
   *  2. 目标会话成为当前会话、且草稿已恢复完毕（draftHydratedSid === activeSid）后，
   *     才把附件追加进去并聚焦输入框。
   */
  const handledAttachRequestRef = useRef(0);
  const [pendingAttach, setPendingAttach] = useState<{ nonce: number; sessionId: string; attachments: UiAttachment[] } | null>(null);
  useEffect(() => {
    if (!attachRequest || sessionsLoading || handledAttachRequestRef.current === attachRequest.nonce) return;
    handledAttachRequestRef.current = attachRequest.nonce;
    let cancelled = false;
    void (async () => {
      const attachments = attachRequest.attachments ?? [];
      if (!attachments.length) {
        if (!cancelled) onAttachRequestHandled?.(attachRequest.nonce);
        return;
      }
      // 不带 sessionId = 注入当前会话（拖到已打开的聊天窗 / home 悬浮输入框）。
      if (!attachRequest.sessionId) {
        if (!cancelled) setPendingAttach({ nonce: attachRequest.nonce, sessionId: activeSidRef.current, attachments });
        return;
      }
      const target = sessionsRef.current.find((item) => item.id === attachRequest.sessionId);
      if (!target) {
        // 目标会话不在 kit 的会话列表里：无处可挂，也不该挂到别的会话上（会挂错）。
        if (!cancelled) onAttachRequestHandled?.(attachRequest.nonce, "会话不存在");
        return;
      }
      try {
        if (target.id !== activeSidRef.current) await switchSession(target.id, target, false);
        if (cancelled) return;
        setPendingAttach({ nonce: attachRequest.nonce, sessionId: target.id, attachments });
      } catch {
        if (!cancelled) onAttachRequestHandled?.(attachRequest.nonce, "无法切换到目标会话");
      }
    })();
    return () => { cancelled = true; };
    // The request nonce is the sole trigger; the session switch happens in the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachRequest, sessionsLoading]);
  useEffect(() => {
    // draftHydratedSid === activeSid：目标会话的草稿已经恢复完，附件追加不会再被覆盖。
    if (!pendingAttach || activeSid !== pendingAttach.sessionId || draftHydratedSid !== activeSid) return;
    setPendingAttach(null);
    onAttachRequestHandled?.(pendingAttach.nonce);
    setAttachments((current) => [...current, ...pendingAttach.attachments]);
    // 附件已经进框，光标挪过去方便直接补一句说明。
    composerRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAttach, activeSid, draftHydratedSid]);

  // Web 浏览器按钮与 local 顶部按钮都触发同一个 popstate，恢复对应视图。
  useEffect(() => {
    if (embeddedMode) return;
    const restore = () => {
      const pendingTab = pendingMobileTabRef.current;
      if (pendingTab) {
        pendingMobileTabRef.current = null;
        restoreMobileTab(pendingTab);
        return;
      }
      if (sessionSearchHistoryRef.current) {
        sessionSearchHistoryRef.current = false;
        setSessionSearchOpen(false);
        const pending = sessionSearchPendingRef.current;
        sessionSearchPendingRef.current = null;
        pending?.();
        return;
      }
      if (["settings", "artifacts", "artifact-preview", "chatmate", "monologue"].includes(mobileWorkTop?.type ?? "")) {
        mobileWorkNav.pop();
        if (mobileWorkTop?.type === "artifact-preview") {
          setPreviewFull(false);
        } else {
          setRightOpen(false);
          setPreviewFull(false);
          setConversationView(true);
        }
        return;
      }
      const location = readAgentLocation(navigationKeys);
      if (location?.view === "library") openLibrary(false);
      else if (location && location.view !== "session" && location.view !== "new") selectNavigation(location.view, false);
      else if (location?.view === "session" && location.sessionId) void switchSession(location.sessionId, undefined, false);
      else if (location?.view === "new") {
        // 新建 / 草稿空态（?view=new）：保留输入详情，不退回列表
        setActiveNavigation("home");
        newSession(false, location.sessionId);
        setConversationView(true);
      } else {
        // 列表根（URL 无参）：回到会话列表并清掉残留 query。
        // 不能调 newSession(false)——它会把当前条目 replace 成 ?view=new，污染列表根，
        // 导致第二次返回命中 new 条目而误入新建空态。
        setActiveNavigation("home");
        setLibraryOpen(false);
        setConversationView(false);
        if (window.matchMedia("(max-width: 767.98px)").matches) {
          const url = new URL(window.location.href);
          url.searchParams.delete("view");
          url.searchParams.delete("session");
          url.searchParams.delete("draft");
          window.history.replaceState(window.history.state, "", url);
        }
      }
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  });

  /** 重命名会话。 */
  async function commitRename(id: string, rawTitle: string) {
    const title = (rawTitle || "").trim();
    setRenameId(null);
    if (!title) return;
    const renameTarget = sessionsRef.current.find((item) => item.id === id);
    const localAi = localChat && isAiOnlyChat(renameTarget);
    if (localAi) {
      void localChatPatch(localOwner, id, { title });
    } else {
      try {
        if (!localFiles || !localProjectMessages(initialUser.unionId || "", id)) await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
      } catch {
        /* ignore */
      }
    }
    setSessions((list) => list.map((s) => (s.id === id ? { ...s, title } : s)));
    if (localAi) return;
    const local = sessionsRef.current.find((item) => item.id === id);
    const saved = localProjectMessages(initialUser.unionId || "", id);
    if (localFiles && local && saved) saveLocalProjectSession(initialUser.unionId || "", { ...local, title }, saved);
  }

  // —— 工作目录（沙箱范围，桌面宿主）——
  /** 弹系统目录选择框（仅 Electron 壳可用）；选中的目录作为本会话沙箱范围 */
  async function pickWorkspace() {
    if (!AGENT_HOST?.pickDirectory) return;
    setPickingWorkspace(true);
    try {
      const dir = await AGENT_HOST.pickDirectory(lastWorkspaceRef.current || undefined);
      if (dir) {
        lastWorkspaceRef.current = dir;
        await applyWorkspace(dir);
      }
    } catch (e) {
      console.warn("[agent-kit] 工作目录选择失败:", e);
    } finally {
      setPickingWorkspace(false);
    }
  }

  /** 更新本会话工作目录：
   *   - 无条件 PATCH 落库（幂等）：即使会话已注册但尚未开始（历史恢复/失败重试），
   *     也能把 DB workspaceDir 同步为当前值，避免产物写入目录（chat 请求传参）与
   *     产物读取/列表目录（DB 记录）分裂——那会导致「卡片显示文件、右侧预览 404、
   *     查看所有产物 (0)」。
   *   - 空会话（DB 尚无行）PATCH 返回 404，忽略即可：首条消息的 POST 注册会带上当前
   *     workspaceDir 落库。 */
  async function applyWorkspace(dir: string | null, sid = activeSidRef.current) {
    if (localFiles) {
      const saved = await localFiles.setWorkspace(sid, dir);
      if (!saved) { setUploadError("本机工作空间不可用，请重新选择文件夹"); return; }
    }
    if (activeSidRef.current === sid) setWorkspaceDir(dir);
    const rt = getRt(sid);
    // 本地同步更新会话列表缓存，切回本会话时能恢复新目录
    setSessions((list) => list.map((s) => (s.id === sid ? { ...s, workspaceDir: dir, projectDir: localFiles ? dir : s.projectDir } : s)));
    if (localChat) {
      // 登记为独立项目（删除会话不影响项目保留）；解除绑定（dir=null）不遗忘项目
      if (dir) {
        rememberLocalProjectDir(initialUser.unionId || "", dir);
        setRegisteredProjectDirs(listLocalProjectDirs(initialUser.unionId || ""));
      }
      void localChatPatch(localOwner, sid, dir ? { workspaceDir: dir, projectDir: dir } : { workspaceDir: null, projectDir: null });
      return;
    }
    if (localFiles) {
      // 登记为独立项目（删除会话不影响项目保留）；解除绑定（dir=null）不遗忘项目
      if (dir) {
        rememberLocalProjectDir(initialUser.unionId || "", dir);
        setRegisteredProjectDirs(listLocalProjectDirs(initialUser.unionId || ""));
      }
      const saved = localProjectMessages(initialUser.unionId || "", sid);
      const current = sessionsRef.current.find((session) => session.id === sid);
      if (saved && current && dir) saveLocalProjectSession(initialUser.unionId || "", { ...current, workspaceDir: dir, projectDir: dir }, saved);
      if (!dir) removeLocalProjectSession(initialUser.unionId || "", sid);
      return;
    }
    // 无条件 PATCH（幂等）：同步 DB workspaceDir。若不落库（如「会话已注册但未开始」的边界
    // 场景），产物写入目录（chat 请求传参）与读取/列表目录（DB 记录）会分裂 →
    // 卡片显示文件、右侧预览 404、查看所有产物 (0)。空会话（DB 无行）PATCH 返回 404 忽略即可。
    try {
      await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceDir: dir }),
      });
    } catch (err) {
      console.warn("[agent-kit] 工作目录持久化失败:", err);
    }
    if (rt.sessionStarted || rt.sessionRegistered) {
      try {
        await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/close-sdk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sdkSid: rt.sdkSid }),
        });
      } catch { /* ignore */ }
      rt.sessionStarted = false; // 下一轮 resume=false，按新工作目录重建常驻会话
    }
  }

  /** 清除本会话工作目录限定（回到不限范围的本地默认行为） */
  function clearWorkspace() {
    void applyWorkspace(null);
  }

  // —— 选择工作空间 popup（WB 风格）——
  /** 目录绝对路径 → 显示名（取最后一段） */
  function dirName(p: string): string {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
  }

  // 独立项目清单（localStorage 持久化）：删空会话后项目仍保留，仅「删除项目」时移除
  const [registeredProjectDirs, setRegisteredProjectDirs] = useState<string[]>(() =>
    localFiles ? listLocalProjectDirs(initialUser.unionId || "") : []);

  /** 已有项目列表：独立登记清单（含已删空会话的项目）+ 当前会话用过的工作目录，去重 */
  const knownProjects = useMemo(() => {
    const seen = new Set<string>();
    const arr: Array<{ dir: string; updatedAt: string }> = [];
    const push = (dir: string, updatedAt: string) => {
      if (!dir || seen.has(dir)) return;
      seen.add(dir);
      arr.push({ dir, updatedAt });
    };
    for (const dir of registeredProjectDirs) push(dir, "");
    for (const s of sessions) push(s.workspaceDir ?? "", s.updatedAt ?? "");
    return arr;
  }, [sessions, registeredProjectDirs]);

  /** 打开 popup：展示已有项目列表 + 打开本地文件夹（桌面宿主不支持云主机，无「新建项目」） */
  function openWorkspacePopup() {
    setWsMenuOpen(true);
  }

  /** popup 里的「打开本地文件夹」：复用系统目录选择，完成后收起 popup */
  async function pickWorkspaceFromPopup() {
    await pickWorkspace();
    setWsMenuOpen(false);
  }

  // —— 项目分组操作（右键/⋯ 菜单）：显示别名 / 从列表隐藏（均本地存储，不动文件与会话）——
  const projectAliasKey = (dir: string) => `agent-kit:project-alias:${dir}`;
  const projectHiddenKey = (dir: string) => `agent-kit:project-hidden:${dir}`;
  const projectDisplayName = (dir: string): string => {
    try { return localStorage.getItem(projectAliasKey(dir)) || dirName(dir); } catch { return dirName(dir); }
  };
  // 兼容早期「从列表中移除」隐藏过的项目（菜单现为「删除项目」，隐藏入口移除但旧隐藏状态仍生效）
  const isProjectHidden = (dir: string): boolean => {
    try { return localStorage.getItem(projectHiddenKey(dir)) === "1"; } catch { return false; }
  };
  const setProjectAlias = (dir: string, name: string) => {
    try {
      const v = String(name ?? "").trim();
      if (v) localStorage.setItem(projectAliasKey(dir), v);
      else localStorage.removeItem(projectAliasKey(dir));
    } catch { /* ignore */ }
  };
  // 项目分组右键菜单：{ dir, x, y } 定位在右键处；null = 关闭
  const [projectMenu, setProjectMenu] = useState<{ dir: string; x: number; y: number } | null>(null);
  // 项目重命名中（inline input 编辑显示别名）：存项目目录，null = 不在重命名
  const [projectRenameDir, setProjectRenameDir] = useState<string | null>(null);
  // 项目折叠状态（localStorage 持久化）：折叠后该组会话隐藏
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem("agent-kit:project-collapsed");
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch { return {}; }
  });
  const toggleProjectCollapsed = (dir: string) => {
    setCollapsedProjects((cur) => {
      const next = { ...cur, [dir]: !cur[dir] };
      try { localStorage.setItem("agent-kit:project-collapsed", JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  // 项目菜单从 ⋯ 按钮展开：锚点固定到按钮附近（按钮传入相对窗口位置）
  const [projectMenuAnchor, setProjectMenuAnchor] = useState<{ dir: string; rect: DOMRect } | null>(null);
  // 「删除项目」确认对话框：待删除的项目目录（null = 关闭）
  const [confirmDeleteProjectDir, setConfirmDeleteProjectDir] = useState<string | null>(null);
  async function clearUngroupedSessions() {
    setDeleting(true);
    try {
      const ids = sessionsRef.current.filter((s) => isAiOnlyChat(s) && !(s.projectDir || s.workspaceDir)).map((s) => s.id);
      for (const id of ids) {
        await localChatRemove(localOwner, id);
        forgetSessionModel(id);
      }
      const removed = new Set(ids);
      setSessions((list) => list.filter((s) => !removed.has(s.id)));
      if (removed.has(sessionId)) newSession();
    } catch (error) {
      console.error("[agent-kit] 清空未归属项目的会话失败:", error);
      setSessionsLoadError(true);
      void refreshSessions();
    } finally { setDeleting(false); }
  }
  /** 删除项目：先删除该目录下全部本机会话，再移除项目登记。 */
  async function deleteProjectSessions(dir: string) {
    setDeleting(true);
    try {
    const targets = sessionsRef.current.filter((s) => (s.projectDir || s.workspaceDir) === dir);
    const ids = targets.map((s) => s.id);
    for (const target of targets) {
      const id = target.id;
      if (localChat && isAiOnlyChat(target)) {
        await localChatRemove(localOwner, id);
        // 清理主进程 workspaces 里该会话 -> 目录的残留绑定
        try { await localFiles?.setWorkspace(id, null); } catch { /* ignore */ }
      } else if (!localChat && localFiles) {
        removeLocalProjectSession(initialUser.unionId || "", id);
        // 清理主进程 workspaces 里该会话 -> 目录的残留绑定
        try { await localFiles.setWorkspace(id, null); } catch { /* ignore */ }
      } else {
        const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`删除会话失败: HTTP ${response.status}`);
      }
      forgetSessionModel(id);
    }
    setSessions((list) => list.filter((s) => (s.projectDir || s.workspaceDir) !== dir));
    if (localFiles) {
      // 移除项目登记并清理别名/隐藏偏好（不触碰磁盘文件夹）
      forgetLocalProjectDir(initialUser.unionId || "", dir);
      setRegisteredProjectDirs(listLocalProjectDirs(initialUser.unionId || ""));
      try {
        localStorage.removeItem(`agent-kit:project-alias:${dir}`);
        localStorage.removeItem(`agent-kit:project-hidden:${dir}`);
      } catch { /* ignore */ }
    }
    if (ids.includes(sessionId)) newSession();
    setConfirmDeleteProjectDir(null);
    } catch (error) {
      console.error("[agent-kit] 删除项目会话失败:", error);
      setSessionsLoadError(true);
      void refreshSessions();
    } finally { setDeleting(false); }
  }
  // 点击菜单/输入框之外任意处关闭项目菜单（⋯ 按钮与右键共用）
  useClickOutside({
    enabled: Boolean(projectMenu || projectMenuAnchor),
    exceptSelectors: [".chat-sidebar-project-menu", ".chat-sidebar-group-more"],
    onDismiss: () => { setProjectMenu(null); setProjectMenuAnchor(null); },
  });

  // —— 会话条目操作菜单（⋯ 按钮展开锚定 / 移动端长按、右键弹出）：null = 关闭 ——
  const [sessionMenuAnchor, setSessionMenuAnchor] = useState<{ sid: string; rect: DOMRect } | null>(null);
  const [sessionMenu, setSessionMenu] = useState<{ sid: string; x: number; y: number } | null>(null);
  // 长按已弹出菜单标记：阻止松手后的 click 误触「切换会话」
  const longPressFiredRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const clearLongPress = () => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  useEffect(() => () => clearLongPress(), []);
  const openSessionMenuAt = (sid: string, x: number, y: number) => {
    longPressFiredRef.current = true;
    setSessionMenuAnchor(null);
    setProjectMenu(null);
    setProjectMenuAnchor(null);
    setSessionMenu({ sid, x, y });
  };
  // —— Home 导航项右键菜单（「全部已读」）：null = 关闭 ——
  const [homeMenu, setHomeMenu] = useState<{ x: number; y: number } | null>(null);
  // 全部会话未读消息总数（有成员参与会话的未读角标之和；Home 右键「全部已读」文案用）
  const unreadTotal = sessions.reduce((sum, s) => sum + (s.unreadCount ?? 0) + (s.aiUnread ? 1 : 0), 0);
  useEffect(() => { onUnreadCountChange?.(isLoggedIn ? unreadTotal : 0); }, [onUnreadCountChange, isLoggedIn, unreadTotal]);
  useEffect(() => {
    if (!AGENT_HOST?.setUnreadBadgeCount) return;
    const count = isLoggedIn ? unreadTotal : 0;
    if (AGENT_HOST.platform === "darwin") {
      void AGENT_HOST.setUnreadBadgeCount(count);
    } else if (AGENT_HOST.platform === "win32") {
      if (count === 0) { void AGENT_HOST.setUnreadBadgeCount(0); return; }
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#e53935";
      ctx.beginPath();
      ctx.arc(32, 32, 30, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${count > 99 ? 27 : count > 9 ? 34 : 42}px Arial, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(count > 99 ? "99+" : String(count), 32, 34);
      void AGENT_HOST.setUnreadBadgeCount(count, canvas.toDataURL("image/png"));
    }
  }, [isLoggedIn, unreadTotal]);
  const openHomeMenu = (x: number, y: number) => {
    if (unreadTotal <= 0) return; // 无未读可标：不弹空菜单
    setHomeMenu({ x, y });
  };
  // 点击菜单之外任意处关闭 Home 菜单
  useClickOutside({
    enabled: homeMenu !== null,
    exceptSelectors: [".chat-home-menu"],
    onDismiss: () => setHomeMenu(null),
  });
  // 点击菜单/⋯ 按钮之外任意处关闭会话菜单
  useClickOutside({
    enabled: Boolean(sessionMenu || sessionMenuAnchor),
    exceptSelectors: [".chat-sidebar-project-menu", ".chat-sidebar-item-more"],
    onDismiss: () => { setSessionMenu(null); setSessionMenuAnchor(null); },
  });

  // —— 侧边栏按项目分组：有工作目录的会话归入对应项目组（组标题=目录名）；
  //    无工作目录的会话保持原扁平样式（与现在一致）——
  const pinnedSessions = sessions.filter((s) => s.pinOrder != null)
    .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0) || a.id.localeCompare(b.id));
  const ungroupedSessions = sessions.filter((s) => s.pinOrder == null && !(s.projectDir || s.workspaceDir));
  // 会话分组 + 独立登记项目（含已删空会话的空项目，删除最后一个会话后项目仍保留）
  const projectGroups: Array<[string, SessionItem[]]> = mergeProjectGroups(registeredProjectDirs, sessions);

  async function setSessionPinned(sid: string, pinned: boolean) {
    const old = sessions;
    const nextOrder = pinned ? Math.max(-1, ...old.map((s) => s.pinOrder ?? -1)) + 1 : null;
    setSessions((list) => list.map((s) => s.id === sid ? { ...s, pinOrder: nextOrder } : s));
    const pinTarget = sessionsRef.current.find((item) => item.id === sid);
    if (localChat && isAiOnlyChat(pinTarget)) {
      void localChatPatch(localOwner, sid, { pinOrder: nextOrder });
      return;
    }
    try {
      const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      setSessions(old);
      console.error("[agent-kit] 更新置顶状态失败:", error);
    }
  }

  /** 「全部已读」：将该会话未读游标推进到最新消息（缺省 throughId = 全部已读），并清除本地未读角标。 */
  async function markSessionReadAll(sid: string) {
    const readTarget = sessionsRef.current.find((item) => item.id === sid);
    if (localChat && isAiOnlyChat(readTarget)) {
      setSessions((list) => list.map((item) => item.id === sid ? { ...item, unreadCount: 0, aiUnread: false, lastMentionedMe: false } : item));
      return;
    }
    try {
      const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/read`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSessions((list) => list.map((item) => item.id === sid ? { ...item, unreadCount: 0, aiUnread: false, lastMentionedMe: false } : item));
    } catch (error) {
      console.error("[agent-kit] 标记全部已读失败:", error);
    }
  }

  /** 「全部已读」：所有可见会话未读游标一次推进到各自最新消息，并清除本地全部未读角标。 */
  async function markAllRead() {
    try {
      const response = await apiFetch(`${basePath}/api/sessions/read-all`, {
        method: "POST", headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setSessions((list) => list.map((item) => ({ ...item, unreadCount: 0, aiUnread: false, lastMentionedMe: false })));
    } catch (error) {
      console.error("[agent-kit] 全部标记已读失败:", error);
    }
  }

  async function moveSessionToPinned(sid: string, index: number) {
    const old = sessions;
    const wasPinned = old.some((s) => s.id === sid && s.pinOrder != null);
    const visiblePinned = isDesktopApp() ? pinnedSessions : pinnedSessions.filter((s) => !(s.projectDir || s.workspaceDir));
    const previousIndex = visiblePinned.findIndex((s) => s.id === sid);
    const order = pinnedSessions.map((s) => s.id).filter((id) => id !== sid);
    const adjustedIndex = previousIndex >= 0 && previousIndex < index ? index - 1 : index;
    const visibleOrder = visiblePinned.map((s) => s.id).filter((id) => id !== sid);
    const insertBefore = visibleOrder[Math.max(0, adjustedIndex)];
    const insertAt = insertBefore ? order.indexOf(insertBefore) :
      visibleOrder.length > 0 ? order.indexOf(visibleOrder[visibleOrder.length - 1]) + 1 : order.length;
    order.splice(insertAt, 0, sid);
    if (wasPinned && order.every((id, i) => id === pinnedSessions[i]?.id)) return;
    setSessions((list) => list.map((s) => {
      const position = order.indexOf(s.id);
      return position >= 0 ? { ...s, pinOrder: position } : s;
    }));
    if (localChat) {
      // 仅本地 AI 单聊持久化置顶顺序；人际会话继续走云端 pinned-order
      order.forEach((id, position) => {
        if (isAiOnlyChat(sessionsRef.current.find((item) => item.id === id))) {
          void localChatPatch(localOwner, id, { pinOrder: position });
        }
      });
    }
    try {
      if (!wasPinned) {
        const pin = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pinned: true }),
        });
        if (!pin.ok) throw new Error(`置顶失败（HTTP ${pin.status}）`);
      }
      const save = await apiFetch(`${basePath}/api/sessions/pinned-order`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: order }),
      });
      if (!save.ok) throw new Error(`保存顺序失败（HTTP ${save.status}）`);
    } catch (error) {
      console.error("[agent-kit] 保存置顶顺序失败:", error);
      void refreshSessions();
    }
  }

  /** 删除会话：先弹确认框，确认后删除并显示 loading。 */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 隐藏会话（1v1 / 群聊的「删除」）：软删除，仅对当前用户不可见，不删服务器数据 */
  const [confirmHideId, setConfirmHideId] = useState<string | null>(null);
  const [hiding, setHiding] = useState(false);
  const [branchTarget, setBranchTarget] = useState<{ sid: string; index: number; messageId?: number; title: string; snapshot: UiMessage[] } | null>(null);
  const [branching, setBranching] = useState(false);
  const [branchError, setBranchError] = useState("");
  const branchPending = useRef(false);
  const branchCancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (branchTarget) branchCancelRef.current?.focus(); }, [branchTarget]);
  async function createBranch() {
    if (!branchTarget || branchPending.current) return;
    branchPending.current = true;
    setBranching(true);
    setBranchError("");
    try {
      const res = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(branchTarget.sid)}/fork`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageIndex: branchTarget.index, messageId: branchTarget.messageId, snapshot: branchTarget.snapshot }),
      });
      const data = await res.json() as { session?: SessionItem; error?: string };
      if (!res.ok || !data.session) throw new Error(data.error || "创建分支失败，请重试");
      const created = data.session;
      setSessions((previous) => [created, ...previous.filter((session) => session.id !== created.id)]);
      setBranchTarget(null);
      await switchSession(created.id, created);
      // Never resume the source transcript: the new SDK session receives the copied history.
      getRt(created.id).sessionStarted = false;
    } catch (error) { setBranchError(error instanceof Error ? error.message : "创建分支失败，请重试"); }
    finally { branchPending.current = false; setBranching(false); }
  }
  // 原地编辑用户消息：editingIdx = 正在编辑的消息下标（null 表示不在编辑）
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingText, setEditingText] = useState("");
  // 进入编辑时量得的原气泡宽度：编辑框沿用该宽度（与原消息框同宽），而非撑满用户消息最大宽度
  const [editingWidth, setEditingWidth] = useState<number | null>(null);
  // control_browser 人工接管（图形验证码等）：browser_ask 事件的输入框内容
  const [browserAskText, setBrowserAskText] = useState("");

  /** 回传 control_browser 人工接管答案（图形验证码/短信验证等） */
  async function submitBrowserAnswer(browserId: string, text: string) {
    try {
      await apiFetch(localChatRoute("/browser-answer"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: browserId, text, chatSessionId: activeSid ?? sessionId }),
      });
    } catch {
      /* 提交失败：浏览器任务会因 5 分钟超时自动结束，忽略 */
    }
  }

  /** 右侧浏览器预览点击：截图坐标（显示尺寸 → 原始像素）转发到 AI 正在操作的同一浏览器 */
  function handleBrowserShotClick(e: React.MouseEvent<HTMLImageElement>): void {
    if (!cdpPort || cdpSid !== activeSid) return;
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height || !img.naturalWidth || !img.naturalHeight) return;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * img.naturalWidth);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * img.naturalHeight);
    void browserCdp.click(x, y).catch((err) => {
      console.warn("[browser-preview] 点击转发失败:", err instanceof Error ? err.message : err);
    });
  }

  /** 清除已删除会话的模型记忆：避免 localStorage 里堆积已不存在的 sid（功能无害，但会缓慢膨胀）。 */
  const forgetSessionModel = (sid: string) => {
    if (!sid || !(sid in sessionModelMapRef.current)) return;
    const next = { ...sessionModelMapRef.current };
    delete next[sid];
    sessionModelMapRef.current = next;
    writeSessionModelMap(next);
  };

  async function deleteSession(id: string) {
    setConfirmDeleteId(null);
    setDeleting(true);
    const delTarget = sessionsRef.current.find((item) => item.id === id);
    if (localChat && isAiOnlyChat(delTarget)) {
      void localChatRemove(localOwner, id);
    } else {
      try {
        if (!localFiles || !localProjectMessages(initialUser.unionId || "", id)) await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch {
        /* ignore */
      }
      if (localFiles) removeLocalProjectSession(initialUser.unionId || "", id);
    }
    forgetSessionModel(id);
    setSessions((list) => list.filter((s) => s.id !== id));
    if (id === sessionId) newSession();
    setDeleting(false);
  }

  /**
   * 隐藏会话（1v1 / 群聊菜单里的「删除」）：软删除。
   * 只把该会话对当前用户标记为不可见（PATCH hidden），不删除服务器上会话与消息的任何数据；
   * 会话从本地列表移除；若正在查看则回到新会话。对方再发消息时服务端自动解除隐藏并重新出现。
   */
  async function hideSession(id: string) {
    setConfirmHideId(null);
    setHiding(true);
    try {
      const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: true }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error("[agent-kit] 隐藏会话失败:", error);
      setHiding(false);
      return;
    }
    setSessions((list) => list.filter((s) => s.id !== id));
    if (id === sessionId) newSession();
    setHiding(false);
  }

  /** 提交 AskUserQuestion 卡片的答案。
   *  新机制：不新开对话、不发普通 user 消息，而是 POST /api/chat/answer 唤醒后端
   *  挂起的 canUseTool——CLI 把 answers 作为 tool_result 喂回模型，模型在同一轮 SSE 流里继续。
   *  卡片切只读态；同时把答案作为一条 user 消息入库（纯历史展示，不发给模型）。 */
  async function submitAnswer(messageIdx: number, stepIdx: number, answerText: string, answers: Record<string, string>) {
    const sid = activeSid;
    const rt = getRt(sid);
    // 卡片标记 answered → QuestionCard return null 隐藏
    rt.messages[messageIdx] = {
      ...rt.messages[messageIdx],
      steps: (rt.messages[messageIdx].steps || []).map((s, si) =>
        si === stepIdx ? { ...s, answered: answerText } : s,
      ),
    };
    // 答案已提交：该会话不再处于「待确认」状态
    syncPendingQuestionSids();
    // 卡片消失后、模型下一个字流过来前有几秒空档：在 assistant 消息末尾临时追加一行
    // 「✅ 你选择了：xxx」作为反馈，让用户知道提交成功了。下一个 SSE text 事件到达时
    // applyUpdate 用 pendingText 覆盖 content，这行提示自然消失。
    const lastIdx = rt.messages.length - 1;
    const last = rt.messages[lastIdx];
    if (last?.role === "assistant") {
      rt.messages[lastIdx] = {
        ...last,
        content: `${last.content || ""}${last.content ? "\n\n" : ""}✅ 你选择了：${answerText}`,
      };
    }
    if (activeSidRef.current === sid) setMessages([...rt.messages]);
      // 唤醒后端挂起的 canUseTool；失败给个可诊断的提示（而不是笼统的“请刷新重试”）
      try {
        const res = await apiFetch(localChatRoute("/answer"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: rt.sdkSid,
            answers,
          }),
        });
        if (!res.ok) {
          // 读取服务端错误体，给出可诊断的提示（HTTP 状态 + 服务端 error/message）
          let detail = `HTTP ${res.status}`;
          try {
            const j = await res.json().catch(() => null);
            if (j && (j.error || j.message)) detail = String(j.error || j.message);
          } catch { /* ignore */ }
          console.error("[agent-kit] 提交 AskUserQuestion 答案失败:", detail, "session=", rt.sdkSid);
          rt.errorMsg = `提交答案失败（${detail}）。请重试或刷新。`;
          if (activeSidRef.current === sid) setErrorMsg(rt.errorMsg);
          return;
        }
        // 后端返回 { ok:false }：挂起的提问已不存在（会话结束/超时/已被其它请求消费）——
        // 模型不会继续，明确提示用户而非静默卡死。
        let delivered = true;
        try {
          const j = await res.json().catch(() => null);
          if (j && j.ok === false) delivered = false;
        } catch { /* ignore */ }
        if (!delivered) {
          console.warn("[agent-kit] 提交答案：后端无挂起提问（可能已超时/会话结束）session=", rt.sdkSid);
          rt.errorMsg = "答案未能送达（会话可能已结束或超时），可让模型重新提问或新开对话。";
          if (activeSidRef.current === sid) setErrorMsg(rt.errorMsg);
          return;
        }
        // 成功送达：清除可能残留的旧错误提示
        if (rt.errorMsg) {
          rt.errorMsg = null;
          if (activeSidRef.current === sid) setErrorMsg(null);
        }
      } catch (e) {
        console.error("[agent-kit] 提交 AskUserQuestion 答案失败（网络/传输错误）:", e, "session=", rt.sdkSid);
        rt.errorMsg = "提交答案失败（网络错误），请检查连接后重试。";
        if (activeSidRef.current === sid) setErrorMsg(rt.errorMsg);
      }
  }

  // 重新生成：以所点答复对应的用户提问为起点，删除该提问及其后的全部消息，再重发该提问。
  async function regenerateFrom(messageIdx: number) {
    const sid = activeSid;
    const rt = getRt(sid);
    if (rt.busy) return;
    // 定位该答复对应的提问：向前找最近的一条 user 消息
    let qi = -1;
    for (let k = messageIdx - 1; k >= 0; k--) {
      if (rt.messages[k]?.role === "user") { qi = k; break; }
    }
    if (qi === -1) return;
    const question = (rt.messages[qi].content || "").trim();
    if (!question) return;
    // 保留更早的历史，删除提问及其后的答复；重置 SDK 会话以从头生成
    rt.messages = rt.messages.slice(0, qi);
    const oldSdkSid = rt.sdkSid;
    // 换一个「派生自本会话 id」的临时 SDK transcript id（避免 CLI 加载旧 transcript）。
    // 必须保留 `sid_` 前缀：服务端据此反查归属会话做鉴权（见 session-access.ts）。
    rt.sdkSid = `${sid}_${crypto.randomUUID()}`;
    rt.sessionStarted = false;
    rt.sessionRegistered = false;
    markBusy(sid, false);
    const lastKept = rt.messages[rt.messages.length - 1];
    const upToId = lastKept?.id || 0;
    const editTarget = sessionsRef.current.find((item) => item.id === sid);
    const editLocalAi = localChat && isAiOnlyChat(editTarget);
    if (editLocalAi) {
      // 本地 AI：rt.messages 已裁剪，直接落盘；无云端 truncate/close-sdk
      if (editTarget) void localChatSave(localOwner, { ...editTarget, updatedAt: new Date().toISOString() }, rt.messages);
    } else if (!embedded?.temporary) await Promise.allSettled([
      apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/truncate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upToId }),
      }),
      apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sid)}/close-sdk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdkSid: oldSdkSid }),
      }),
    ]);
    send(question).catch(() => {});
  }

  const userMenu = <UserMenu basePath={basePath} compact={hasNavigation} expanded={navExpanded} userOpen={userOpen} setUserOpen={setUserOpen}
    initialUser={initialUser} roles={roles} theme={theme} setTheme={setTheme}
    showContextUsage={showContextUsage} setShowContextUsage={setShowContextUsage}
    modelSelectionEnabled={modelSelectionEnabled} showModel={showModel} setShowModel={setShowModel}
    multiFramework={multiFramework} multiFrameworkAvailable={agentModesLoaded && agentModes.length > 1}
    setMultiFramework={setMultiFramework} rightCtrlVoice={rightCtrlVoice} setRightCtrlVoice={setRightCtrlVoice}
    logout={logout} onOpenMemory={openMemory} />;

  const mobileMode = compareOnly ? compareMode : agentMode;
  const mobileChoicesForMode = (mode: string) => (mode === "dsh" ? dshModelOptions : mode === "codex" ? codexModelOptions : modelOptions).map((option) => {
    const model = normalizeModelOption(option);
    const credits = model.meta?.modelType === "enterprise" ? null : model.meta?.credits ?? model.meta?.credit;
    const amount = credits == null ? null : String(credits).match(/(?:x|×)?\s*(\d+(?:\.\d+)?)/i);
    return { key: modelOptionKey(model), label: model.name || model.id, credits: amount ? `${amount[1]}x` : undefined };
  });
  const mobileModelChoices = mobileChoicesForMode(mobileMode);
  const compareModelChoices = mobileChoicesForMode(compareMode);
  const currentMobileModelKey = compareOnly ? compareModelKey : mobileMode === "dsh" ? selectedDshModel : mobileMode === "codex" ? selectedCodexModel : selectedModel;
  const currentMobileModelName = mobileModelChoices.find((choice) => choice.key === currentMobileModelKey)?.label || t("chooseModel");
  const currentCompareModelName = compareModelChoices.find((choice) => choice.key === compareModelKey)?.label || t("chooseModel");
  const mobileFrameworkName = mobileMode === "dsh" ? "DeepSeek Harness" : mobileMode === "codex" ? "Codex" : "CodeBuddy";
  const compareFrameworkName = compareMode === "codex" ? "Codex" : "CodeBuddy";
  const chooseMobileModel = (key: string) => {
    if (compareOnly) {
      setCompareModelKey(key);
      localStorage.setItem(`agent-kit:compare-model:${sessionId}:${compareMode}`, key);
    } else if (mobileMode === "dsh") {
      setSelectedDshModel(key);
    } else if (mobileMode === "codex") {
      setSelectedCodexModel(key);
      localStorage.setItem(`agent-kit:codex-model:${sessionId}`, key);
    } else changeModel(key);
  };
  const chooseMobileFramework = (key: string) => {
    const mode = key as typeof agentMode;
    if (compareOnly) setCompareMode(mode as "codebuddy" | "codex");
    else { setAgentMode(mode); saveAgentMode(sessionId, mode); }
  };

  // —— 工具栏响应式降级（按真实几何测量，不用固定断点）——
  // 铁律：+ 恒在左、语音/发送恒在右（外层三段式已保证）；只有中间一组降级。
  // 降级优先级：先去掉权限文字；仍放不下时模型按钮收成图标。
  // 为什么不用 @container 固定断点：所需宽度随「模型名长度」剧烈变化
  // （如 "Dots Studio: Dots3-Note Preview (free)" 极长），固定 600/460px
  // 无法反映真实压力，会出现「已换行但权限文字还在」。故用 ResizeObserver
  // + 临时 natural-width 测量来判定；同时 .chat-toolbar-center 默认 nowrap，
  // 工具栏始终保持一行，模型名较长时不再挤出第二行。
  const [toolbarCompact, setToolbarCompact] = useState(0); // 0=全量 1=权限仅图标 2=模型仅图标
  useLayoutEffect(() => {
    const center = toolbarCenterRef.current;
    if (!center) return;
    // 同步测量（刻意不用 rAF）：useLayoutEffect 在 paint 前执行，首帧即为正确降级，无闪烁。
    const measure = () => {
      const c = toolbarCenterRef.current;
      if (!c) return;
      const avail = c.clientWidth;
      if (avail <= 0) return;
      const pickersEl = c.querySelector<HTMLElement>(".chat-toolbar-pickers");
      const pickerRows: HTMLElement[] = pickersEl
        ? (Array.from(pickersEl.children).filter((el) => el instanceof HTMLElement) as HTMLElement[])
        : [];
      const modelRow = pickerRows.find((r) => r.classList.contains("chat-pickers-model-row")) ?? null;
      const fwRow = pickerRows.find((r) => r.classList.contains("chat-pickers-framework-row")) ?? null;
      // 主项排除 spacer（spacer flex:1 会吸收剩余空间，不应计入自然宽度）
      const mainKids = (Array.from(c.children).filter((el) => el instanceof HTMLElement) as HTMLElement[])
        .filter((el) => el !== pickersEl && !el.classList.contains("chat-tool-spacer"));
      const label = c.querySelector<HTMLElement>(".chat-permission-label");
      const sumMain = () => mainKids.reduce((s, k) => s + k.offsetWidth, 0);

      // 临时强制自然宽度测量：nowrap + 各级 flex 不收缩，读完立刻还原（同帧移除，用户不可见）
      c.classList.add("is-measuring");
      if (label) label.style.display = "block";
      const mainWithText = sumMain();
      if (label) label.style.display = "none";
      const mainIconOnly = sumMain();
      if (label) label.style.display = "";
      const modelW = modelRow ? modelRow.offsetWidth : 0;
      const fwW = fwRow ? fwRow.offsetWidth : 0;
      c.classList.remove("is-measuring");

      const gap = (n: number) => 4 * Math.max(0, n - 1);
      const mainN = mainKids.length;
      const hasModel = modelW > 0;
      const hasFw = fwW > 0;
      const pickerCount = (hasModel ? 1 : 0) + (hasFw ? 1 : 0);

      // 各级别均为单行；模型图标按钮宽 36px。
      const need0 = mainWithText + modelW + fwW + gap(mainN + pickerCount);
      const need1 = mainIconOnly + modelW + fwW + gap(mainN + pickerCount);
      const level = need0 <= avail ? 0 : need1 <= avail ? 1 : 2;
      setToolbarCompact((prev) => (prev === level ? prev : level));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(center);
    return () => {
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedModel, compareModelKey, selectedCodexModel, selectedDshModel, workspaceDir, permissionMode,
    ctxUsage.usedTokens, ctxUsage.maxTokens, showContextUsage,
    agentMode, compareMode, compareOnly, multiFramework, split,
    modelOptions.length, codexModelOptions.length, dshModelOptions.length, showModel, modelSelectionEnabled,
    agentModes.length, isEmptyView, uploadEnabled,
  ]);

  const conversationPanel = (<>
      {!embeddedMode ? <ConversationPanel
        basePath={basePath}
        sidebarOpen={sidebarOpen} sidebarLogo={sidebarLogo} title={title}
        libraryOpen={libraryOpen} conversationActive={activeNavigation === "home" && conversationView} onOpenLibrary={openLibrary} showLibraryShortcut={false}
        sessionsLoading={sessionsLoading} sessions={sessions} isLoggedIn={isLoggedIn}
        newSession={() => { setActiveNavigation("home"); setLibraryOpen(false); return newSession(); }} setSidebarOpen={setSidebarOpen}
        keepSidebarOnNewChat={keepSidebarOnNewChat}
        onOpenSearch={openSessionSearch}
        sidebarHover={sidebarHover} onSidebarHoverEnter={openSidebarHover} onSidebarHoverLeave={leaveSidebarHover}
        sessionsLoadError={sessionsLoadError} desktopApp={isDesktopApp()} refreshSessions={refreshSessions}
        ungroupedSessions={ungroupedSessions}
        pinnedSessions={pinnedSessions} setSessionPinned={setSessionPinned} moveSessionToPinned={moveSessionToPinned}
        markSessionReadAll={markSessionReadAll}
        loadingSessionId={loadingSessionId} sessionId={sessionId}
        renameId={renameId} runningSids={runningSids} unseenDoneSids={unseenDoneSids} pendingQuestionSids={pendingQuestionSids}
        sessionErrors={{ ...sessionAuxErrors, ...Object.fromEntries([...rtMapRef.current].filter(([, rt]) => rt.errorMsg).map(([sid, rt]) => [sid, rt.errorMsg as string])) }}
        longPressFiredRef={longPressFiredRef} longPressTimerRef={longPressTimerRef}
        switchSession={(sid) => {
          setActiveNavigation("home"); setLibraryOpen(false);
          if (window.matchMedia("(max-width: 767.98px)").matches) setSidebarOpen(false);
          return switchSession(sid);
        }} clearLongPress={clearLongPress}
        // Ctrl+Tab 快捷切换会话后，把焦点落回聊天输入框，用户可直接接着打字。
        focusComposer={() => composerRef.current?.focus()}
        openSessionMenuAt={openSessionMenuAt} commitRename={commitRename}
        relTime={relTime}
        projectGroups={projectGroups} isProjectHidden={isProjectHidden}
        projectRenameDir={projectRenameDir} projectDisplayName={projectDisplayName}
        setProjectAlias={setProjectAlias} setProjectRenameDir={setProjectRenameDir}
        collapsedProjects={collapsedProjects} toggleProjectCollapsed={toggleProjectCollapsed}
        projectMenu={projectMenu} setProjectMenu={setProjectMenu}
        projectMenuAnchor={projectMenuAnchor} setProjectMenuAnchor={setProjectMenuAnchor}
        applyWorkspace={applyWorkspace} openArtifactFileDir={openArtifactFileDir}
        setConfirmDeleteProjectDir={setConfirmDeleteProjectDir}
        onClearUngrouped={() => void clearUngroupedSessions()}
        sessionMenu={sessionMenu} setSessionMenu={setSessionMenu}
        sessionMenuAnchor={sessionMenuAnchor} setSessionMenuAnchor={setSessionMenuAnchor}
        setRenameId={setRenameId} setConfirmDeleteId={setConfirmDeleteId}
        setConfirmHideId={setConfirmHideId}
        userMenu={!hasNavigation ? userMenu : null}
        headerUserMenu={userMenu}
      /> : null}
  </>);
  const chatPanel = (<>
      {/* 中栏：顶栏（左右上角按钮唤起左/右栏）+ 限宽内容区（对话 + 场景 + 输入）
          is-empty：新建任务（无消息）时输入区与提示一起垂直居中，参考 WB 新建任务界面；
          用户输入第一条消息后自动回到常规底部布局 */}
      <ChatPanel
        toolbar={toolbar}
        showVoiceButton={showVoiceButton}
        active={embeddedMode ? "home" : libraryOpen ? "library" : activeNavigation}
        views={{
          library: <LibraryView basePath={basePath} sessions={sessions} onOpenSession={(sid) => { setActiveNavigation("home"); setLibraryOpen(false); void switchSession(sid); }} onStartConversation={(file) => void startConversationWithLibraryFile(file)} onStartLocalReference={(file) => void startConversationWithLocalReference(file)} />,
          timer: <ContentPage title={t("scheduledTasks")}>{t("noScheduledTasks")}</ContentPage>,
          contacts: <ContactsView basePath={basePath} />,
          ...customNavigationViews,
        }}
        coworkView={coworkActive
          ? <CoworkPanel key={activeSid} basePath={basePath} sessionId={activeSid} title={title} sessionTitle={pendingMembers.length ? t("newGroup") : currentSessionTitle} rightCtrlVoice={rightCtrlVoice} showVoiceButton={showVoiceButton} previewFull={previewFull && rightShown} renderToolbar={renderCoworkToolbar} initialDraftCaret={transferredDraftCaret?.sid === activeSid ? transferredDraftCaret.caret : undefined} onInitialDraftRestored={() => setTransferredDraftCaret(null)}
              homeRecipientChips={homeSelectedChips}
              onRemoveHomeRecipient={removeHomeRecipient}
              onMessageSubmitted={() => { homeRoutedNamesRef.current = null; homeSelectedGroupRef.current = null; homeSelectedContactsRef.current = []; setHomeSelectedChips([]); homeMentionKeyRef.current = ""; }}
              capabilities={capabilities} referenceSources={referenceSources}
              jumpMessageId={jumpTarget?.sid === activeSid ? jumpTarget.messageId : null}
              onJumpComplete={() => setJumpTarget(null)}
              sessions={sessions} onForwarded={() => void refreshSessions()}
              selfSub={selfSub} selfName={initialUser?.name || t("me")} selfAvatar={initialUser?.avatar || ""} members={conversationMembers} pendingMembers={pendingMembers}
              initialSubmission={coworkSubmission} onSubmissionConsumed={() => { setCoworkSubmission(null); setAttachments([]); }}
              models={modelOptions} codexModels={codexModelOptions} modes={agentModes} modelSelectionEnabled={modelSelectionEnabled}
              initialMode={agentMode} initialModel={selectedModelId}
              initialCodexModel={codexModelOptions.find((o) => modelOptionKey(o) === selectedCodexModel)?.id ?? ""}
              muted={sessions.find(item => item.id === activeSid)?.muted}
              onMutedChange={(value) => setSessions(list => list.map(item => item.id === activeSid ? { ...item, muted: value } : item))}
              aiMuted={sessions.find(item => item.id === activeSid)?.aiMuted}
              onAiMutedChange={(value) => setSessions(list => list.map(item => item.id === activeSid ? { ...item, aiMuted: value } : item))}
              canInvite
              onInvite={openInvite} onStarted={(members) => { homeRoutedNamesRef.current = null; homeSelectedGroupRef.current = null; homeSelectedContactsRef.current = []; setHomeSelectedChips([]); homeMentionKeyRef.current = ""; setHomeGroupRecipients([]); setConversationMembers(members); setConversationOwnerSub(selfSub); setPendingMembers([]); void refreshSessions(); }}
              onMembersRemoved={(ids) => setConversationMembers(current => current.filter(m => !ids.includes(m.contactId)))}
              onSessionEnded={(kind) => { if (kind === "dissolve") endedSessionIdsRef.current.add(activeSid); setSessions((list) => list.filter((item) => item.id !== activeSid)); if (activeSid === sessionId) newSession(); }}
              onTitleChange={(value) => { setSessions((list) => list.some((session) => session.id === activeSid)
                ? list.map((session) => session.id === activeSid ? { ...session, title: value } : session)
                : [{ id: activeSid, title: value, memberCount: conversationMembers.length || pendingMembers.length, peerName: conversationMembers[0]?.name || pendingMembers[0]?.name, peerAvatar: conversationMembers[0]?.avatar || pendingMembers[0]?.avatar, updatedAt: new Date().toISOString() }, ...list]); }}
              onGroupAvatarChange={(value) => { setSessions((list) => list.map((session) => session.id === activeSid ? { ...session, coworkAvatar: value } : session)); }}
              onMessagePreview={(content, senderName, createdAt, fromUser, senderSub) => { setSessions((list) => list.map((session) => session.id === activeSid
                ? { ...session, lastPreview: content, lastSenderName: senderName,
                  ...(fromUser ? { lastQuestionPreview: content, lastQuestionSenderName: senderName, lastUserPreview: content,
                    lastMentionedMe: (!document.hidden && document.hasFocus()) ? false : (computeLastMentionedMe({ role: "user", content, senderSub }, selfSub, initialUser?.name ?? "") ?? session.lastMentionedMe) } : null),
                  updatedAt: createdAt || new Date().toISOString() } : session)); }}
              onMonologuesChange={setCoworkMonologues}
              onOpenFile={(file) => void openInputFile(file)}
              onRightPanel={(page) => {
                if (page && isMobileViewport) { openMobileWorkPage(page); return; }
                // 群聊「更多 → 查看产物」：直接拉取并打开产物列表（旧逻辑只切换右栏开关，
                // 不刷新列表，群聊首次空开会导致后续生成的文件一直不显示）。
                if (page === "artifacts") { openArtifactList(activeSid); return; }
                if (rightShown) { setRightOpen(false); setDiffView(null); setInputFilePreview(null); }
                else setRightOpen(true);
                if (window.matchMedia("(max-width: 767.98px)").matches) setSidebarOpen(false);
              }}
              rightShown={rightShown}
              onMobileSettingsBack={closeMobileWorkPage}
              onBack={() => selectNavigation("home", false)}
              onSidebar={() => { if (window.matchMedia("(max-width: 767.98px)").matches) selectNavigation("home", false); else toggleSidebar(); }} />
        : undefined}
      />
  </>);
  const operationPanel = (<>
      {!embeddedMode && !libraryOpen && activeNavigation === "home" ? <OperationPanel
        rightShown={rightShown} rightDragging={rightDragging} rightW={rightW}
        onResizeStart={onResizeStart} onResizeMove={onResizeMove} onResizeEnd={onResizeEnd}
        inputFiles={inputFiles} preview={preview} diffView={diffView}
        inputFilePreview={inputFilePreview} workSurface={workSurface} renderApp={renderNavigationEntry} closeWorkSurface={() => { setWorkSurface(null); setPreviewFull(false); }} resolveFileUrl={resolveFileUrl}
        desktopApp={isDesktopApp()} openInputFile={openInputFile}
        desktopDownload={desktopDownload}
        revealInputFile={(file) => { void revealInputFile(file); }}
        activeSid={activeSid} sessionChanges={sessionChanges}
        hideFileChoices={isEmptyView}
        artifactLists={artifactLists} artifactLoadErrors={artifactLoadErrors}
        rightBodyRef={rightBodyRef}
        setDiffView={setDiffView} setInputFilePreview={setInputFilePreview}
        setPreview={setPreview} previewFull={previewFull} setPreviewFull={setPreviewFull}
        buildArtifactUrl={buildArtifactUrl} browserShot={browserShotSid === activeSid ? browserShot : null} cdpPort={cdpSid === activeSid ? cdpPort : 0}
        handleBrowserShotClick={handleBrowserShotClick}
        refreshArtifactList={refreshArtifactList} artifactMenuId={artifactMenuId}
        setArtifactMenuId={setArtifactMenuId} openArtifactFileDir={openArtifactFileDir}
        onShareArtifact={(artifact) => setArtifactToShare({ sessionId: activeSid, artifact })}
        onZipFolder={zipArtifactFolder}
        onRenameArtifact={renameArtifact}
        onMoveArtifact={moveArtifact}
        onDeleteArtifact={deleteArtifact}
        onCreateFolder={createArtifactFolder}
        coworkMonologues={coworkActive ? coworkMonologues : undefined}
        coworkMode={coworkActive ? "group" : undefined}
        terminalHost={terminalHost}
        mobilePage={["artifacts", "chatmate", "monologue"].includes(mobileWorkPage ?? "") ? mobileWorkPage as "artifacts" | "chatmate" | "monologue" : null}
        mobileArtifactPreviewActive={mobileWorkTop?.type === "artifact-preview"}
        onMobileBack={closeMobileWorkPage}
        onMobileArtifactPreview={openMobileArtifactPreview}
        onJumpToMessage={(messageId) => setJumpTarget({ sid: activeSid, messageId })}
        basePath={basePath}
      /> : null}
  </>);

  const ctxValue = {
    sessions,
    sessionsRef,
    setMessages,
    messages,
    activeSidRef,
    sessionId,
    currentSessionTitle,
    currentSessionError,
    contentLoading,
    loadingSessionId,
    booting,
    busy,
    serverOnline,
    connDetail,
    retrying,
    isLoggedIn,
    isEmptyView,
    queueNotice,
    steerInFlight,
    pendingQueue,
    getRt,
    markBusy,
    setSessionAuxErrors,
    setVoiceError,
    activeQuestion,
    branching,
    setBranchError,
    setBranchTarget,
    dictation,
    cancelArmed: mobileCancelArmed,
    handleDraftSave,
    resolveFileUrl,
    retryConnection,
    send,
    handleSend,
    switchSession,
    newSession,
    collapsePanelsForNewChat,
    refreshSessions,
    cancelGeneration,
    steerQueueItem,
    editQueueItem,
    removeQueueItem,
    regenerateFrom,
    submitAnswer,
    submitBrowserAnswer,
    browserAskText,
    setBrowserAskText,
    editingIdx,
    setEditingIdx,
    editingText,
    setEditingText,
    setEditingWidth,
    enhancing,
    enhanceOriginal,
    handleEnhancePrompt,
    downloadMessageFile,
    openInputFile,
    toggleThinking,
    toggleFoldProcess,
    foldedProcess,
    openThinking,
    msgVotes,
    setMsgVotes,
    messageMoreIdx,
    setMessageMoreIdx,
    copiedIdx,
    setCopiedIdx,
    scrollToMsg,
    activeSid,
    historyLoadError,
    localOwner,
    editingWidth,
    scene,
    setScene,
    allScenes,
    activeScene,
    agentMode,
    setAgentMode,
    agentModes,
    agentModesPending,
    modelOptions,
    codexModelOptions,
    dshModelOptions, selectedDshModel, setSelectedDshModel,
    selectedModel,
    setSelectedCodexModel,
    selectedCodexModel,
    selectedModelId,
    modelsLoaded,
    modelError,
    modelSelectionEnabled,
    autoFetchModels,
    changeModel,
    modelSendBlocked,
    showModel,
    setShowModel,
    multiFramework,
    compareMode,
    setCompareMode,
    compareModelKey,
    setCompareModelKey,
    compareBusy,
    setCompareBusy,
    compareSubmission,
    setCompareSubmission,
    split,
    setSplit,
    compareOnly,
    setCompareOnly,
    setDiffView,
    saveViewLayout,
    closeSplitView,
    compareCancelSeq,
    compareFrameworkName,
    compareModelChoices,
    currentCompareModelName,
    currentMobileModelName,
    mobileFrameworkName,
    mobileModelChoices,
    mobileVoiceMode,
    setMobileVoiceMode,
    toggleMobileVoiceMode,
    mobileHolding,
    setMobileHolding,
    mobileCancelArmed,
    setMobileCancelArmed,
    mobileActionIsSend,
    mobileActionIsStop,
    voiceSendPendingRef,
    canSend,
    composerHasInput,
    toggleVoiceInput,
    speakerClick,
    speakerDown,
    holdAreaDown,
    transcribing,
    recording,
    setRightCtrlRecording,
    rightCtrlRecording,
    rightCtrlVoice,
    voiceRealtimeTranscription,
    startRealtimeVoice,
    stopRealtimeVoice,
    voiceAmplitudeRef,
    toolbarCompact,
    setWsMenuOpen,
    wsMenuOpen,
    attachments,
    setComposerReferences,
    composerReferences,
    composerHasText,
    setComposerHasText,
    setComposerHasInput,
    activeAttachments,
    clearAttachment,
    addRef,
    removeRef,
    uploading,
    visionWarning,
    composerRef,
    fileRef,
    pendingFiles,
    inputFilePreview,
    setInputFilePreview,
    dragOver,
    setDragOver,
    referenceMenuOpen,
    setReferenceMenuOpen,
    localRefOpenMsg,
    setLocalRefOpenMsg,
    localRefKinds,
    localRefAvailability,
    knownProjects,
    coworkActive,
    conversationMembers,
    conversationOwnerSub,
    selfSub,
    pendingMembers,
    setPendingMembers,
    pendingMembersRef,
    visiblePendingMembers,
    openInvite,
    pendingMentionOptions,
    pendingMentionActive,
    homeMentionFilter,
    setHomeMentionFilter,
    showHomeMentionFilter: homeMentionInputActive,
    pendingMentionIndex,
    setPendingMentionIndex,
    choosePendingMention: selectPendingMention,
    homeSelectedChips,
    onRemoveHomeRecipient: removeHomeRecipient,
    onPendingValueChange: (value: string, caret: number) => {
      if (homeMentionInputActive && value.slice(0, caret).endsWith("@")) setHomeMentionFilter("all");
      onPendingValueChange(value, caret);
    },
    onHomeUserValueChange: undefined,
    trackHomeMentions: homeMentionInputActive,
    homeGroupRecipients,
    onPendingEnter: selectPendingEnter,
    onPendingKeyDownIntercept: selectPendingKeyDown,
    pendingMentionRefs,
    openFeishuChat,
    searchOpen,
    searchQuery,
    searchIdx,
    setSearchQuery,
    searchHits,
    goSearch,
    closeSearch,
    shareOpen,
    shareLoading,
    shareSending,
    shareSendMsg,
    shareError,
    copiedLink,
    shareState,
    sharePopupPosition,
    shareButtonRef,
    sharePopupRef,
    moreButtonRef,
    moreMenuRef,
    toolbarCenterRef,
    moreOpen,
    setMoreOpen,
    openShare,
    copyShareLink,
    openShareInBrowser,
    chooseAndSend,
    setShareSendMsg,
    activeNavigation,
    hasNavigation,
    conversationView,
    selectNavigation,
    sidebarOpen,
    setSidebarOpen,
    toggleSidebar,
    openSidebarHover,
    closeSidebarHover,
    isMobileViewport,
    rightShown,
    openMobileWorkPage,
    setMobilePicker,
    setRightOpen,
    openArtifactList,
    ctxUsage,
    showContextUsage,
    notifyBanner,
    setNotifyBanner,
    permissionMode,
    choosePermissionMode,
    showFullAccessWarning,
    setShowFullAccessWarning,
    permissionLocked,
    setJumpHighlightId,
    jumpHighlightId,
    recentScreenshot,
    setRecentScreenshot,
    screenshotHoveredRef,
    screenshotTimerRef,
    addRecentScreenshot,
    preview,
    setPreview,
    previewFull,
    setPreviewFull,
    pickingWorkspace,
    workspaceDir,
    openWorkspacePopup,
    pickWorkspaceFromPopup,
    clearWorkspace,
    applyWorkspace,
    embedded,
    embeddedMode,
    composerPlaceholder,
    emptyMessage,
    basePath,
    chatEndpoint,
    sidebar,
    renderSessionFooter,
    sessionFooterVisibility,
    sessionFooterAppearing,
    capabilities,
    reconnectAttempt,
    recordingSeconds,
    renderSuggestion,
    navigationKeys,
    title,
    voiceEnabled,
    onComposerTextPresenceChange,
    onComposerContentPresenceChange,
    referenceSources,
    refs,
    onAttachClick,
    onPickFile,
    uploadFiles,
    fillSuggestionPromptRef,
    notifyBannerDismissedRef,
    onQueueDragStart,
    onQueueDragOver,
    onQueueDrop,
    onQueueDragEnd,
    dirName,
    localChat,
    localFiles,
    initialUser,
    isDesktopApp,
    IS_ELECTRON,
    uploadEnabled,
    logoSrc,
    bodyRef,
    bindBodyRef,
    spacerRef,
    atBottom,
    jumpToBottom,
    onUserScrollIntent,
  };
  return (
    <ChatSessionContext.Provider value={ctxValue}>
    <FullscreenContext.Provider value={{ isFullscreen: appFull, setFullscreen: setAppFull }}>
    <div
      ref={shellRef}
      onClickCapture={(event) => {
        if (!isDesktopApp() || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.target;
        const anchor = target instanceof Element ? target.closest("a[href]") : null;
        if (!(anchor instanceof HTMLAnchorElement) || !anchor.closest(".msg") || anchor.closest(".chat-right")) return;
        let url: URL;
        try { url = new URL(anchor.href); } catch { return; }
        if (url.protocol !== "http:" && url.protocol !== "https:") return;
        event.preventDefault();
        event.stopPropagation();
        setRightOpen(true);
        window.dispatchEvent(new CustomEvent(CHAT_LINK_OPEN_EVENT, { detail: { url: url.href, sid: activeSid } }));
      }}
      className={`chat-shell layout-${layoutMode}${className ? ` ${className}` : ""}${embeddedMode ? " is-embedded" : ""}${IS_ELECTRON ? " env-electron" : ""}${isInDingTalk() ? " env-dingtalk" : ""}${sidebarOpen && !embeddedMode ? " has-left-pane" : ""}${rightShown && !embeddedMode ? " has-right-pane" : ""}${["artifacts", "chatmate", "monologue"].includes(mobileWorkPage ?? "") ? " has-mobile-work-page" : ""}${previewFull && rightShown ? " has-preview-full" : ""}${appFull ? " has-app-full" : ""}${hasNavigation && !embeddedMode ? ` has-navigation navigation-${activeNavigation.replace(/[^a-zA-Z0-9_-]/g, "-")}` : ""}${!embeddedMode && activeNavigation === "home" && !libraryOpen ? conversationView ? " has-mobile-conversation" : " has-mobile-list" : ""}`}
      style={{ "--left-used": sidebarOpen ? `${LEFT_PANE_W}px` : "0px", "--grow-left": growLeft ? `${LEFT_PANE_W}px` : "0px", "--grow-right": growRight ? `${rightW ?? 340}px` : "0px" } as React.CSSProperties}
    >
      {newSessionNotice ? <div className="chat-share-toast" role="status">{newSessionNotice}</div> : null}
      {IS_ELECTRON ? <DesktopHistoryControls previewFull={previewFull && rightShown} onExitPreviewFull={() => setPreviewFull(false)} /> : null}
      {!embeddedMode && hasNavigation && !appFull && !(previewFull && rightShown) ? <NavigationSidebar entries={navigationEntries} expanded={navExpanded} width={navExpandW} active={activeNavigation} onSelect={selectNavigation}
        navDragging={navDragging} onNavResizeStart={onNavResizeStart} onNavResizeMove={onNavResizeMove} onNavResizeEnd={onNavResizeEnd}
        onHomeHoverStart={!sidebarOpen ? openSidebarHover : undefined} onHomeHoverEnd={closeSidebarHover} onHomeContextMenu={openHomeMenu} homeUnread={!sidebarOpen && unreadTotal > 0} userMenu={userMenu} /> : null}
      {mobilePicker ? <MobileChoiceDialog title={`${split ? mobilePicker.startsWith("compare-") ? "右侧" : "左侧" : "选择"}${mobilePicker.endsWith("framework") ? "框架" : "模型"}`}
        choices={mobilePicker.endsWith("framework") ? agentModes.filter((mode) => mobilePicker !== "compare-framework" || mode !== "dsh").map((mode) => ({ key: mode, label: mode === "dsh" ? "DeepSeek Harness" : mode === "codex" ? "Codex" : "CodeBuddy" })) : mobilePicker === "compare-model" ? compareModelChoices : mobileModelChoices}
        value={mobilePicker === "compare-framework" ? compareMode : mobilePicker === "framework" ? mobileMode : mobilePicker === "compare-model" ? compareModelKey : compareOnly ? compareModelKey : mobileMode === "dsh" ? selectedDshModel : mobileMode === "codex" ? selectedCodexModel : selectedModel}
        disabled={mobilePicker.endsWith("framework") && (mobilePicker.startsWith("compare-") ? compareBusy : compareOnly ? compareBusy : busy)}
        onChoose={mobilePicker === "compare-framework" ? (key) => setCompareMode(key as "codebuddy" | "codex") : mobilePicker === "compare-model" ? (key) => { setCompareModelKey(key); localStorage.setItem(`agent-kit:compare-model:${sessionId}:${compareMode}`, key); } : mobilePicker === "framework" ? chooseMobileFramework : chooseMobileModel}
        onClose={() => setMobilePicker(null)} /> : null}
      {memoryOpen ? <MemoryView basePath={basePath} onClose={() => setMemoryOpen(false)} /> : null}
      {/* Home 导航项右键菜单：portal 到 body（复用侧栏浮动菜单样式），点击即全部会话标记已读 */}
      {homeMenu ? createPortal(
        <div className="chat-sidebar-project-menu chat-home-menu" role="menu"
          style={{ left: Math.max(8, Math.min(homeMenu.x, window.innerWidth - 200)), top: Math.max(8, Math.min(homeMenu.y, window.innerHeight - 52)) }}>
          <button type="button" role="menuitem" onClick={() => { setHomeMenu(null); void markAllRead(); }}>
            <CheckIcon />
            <span>全部已读 · {unreadTotal} 条未读消息</span>
          </button>
        </div>,
        document.body,
      ) : null}
      {/* 会话列表的全局搜索：跨会话检索联系人/群聊与历史消息，结果可直接跳转到指定会话 / 指定消息 */}
      {sessionSearchOpen ? <SessionSearchPanel basePath={basePath} sessions={sessions}
        onOpenPerson={openSearchedPerson} onOpenGroup={openSearchedSession} onOpenMessage={openSearchedMessage}
        onClose={closeSessionSearch} /> : null}
      {branchTarget ? (
        <div className="chat-modal-backdrop" onClick={() => { if (!branching) setBranchTarget(null); }}>
          <div className="chat-modal" role="dialog" aria-modal="true" aria-labelledby="branch-dialog-title" onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !branching) setBranchTarget(null);
              if (event.key === "Tab") {
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
                if (buttons.length && ((event.shiftKey && document.activeElement === buttons[0]) || (!event.shiftKey && document.activeElement === buttons.at(-1)))) {
                  event.preventDefault(); (event.shiftKey ? buttons.at(-1) : buttons[0])?.focus();
                }
              }
            }}>
            <h3 id="branch-dialog-title" className="chat-modal-title">{t("branchTitle")}</h3>
            <p className="chat-modal-desc">{t("branchDescription", { title: branchTarget.title })}</p>
            {branchError ? <p className="chat-loading-error" role="alert">{branchError}</p> : null}
            <div className="chat-modal-actions">
              <button ref={branchCancelRef} type="button" className="chat-modal-btn" disabled={branching} onClick={() => setBranchTarget(null)}>{t("cancel")}</button>
              <button type="button" className="chat-modal-btn" disabled={branching} onClick={() => void createBranch()}>{branching ? t("creating") : t("createBranch")}</button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmDeleteId ? (
        <div className="chat-modal-backdrop" onClick={() => setConfirmDeleteId(null)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="chat-modal-title">{t("deleteConversation")}</h3>
            <p className="chat-modal-desc">{t("deleteWarning")}</p>
            <div className="chat-modal-actions">
              <button type="button" className="chat-modal-btn" onClick={() => setConfirmDeleteId(null)}>{t("cancel")}</button>
              <button type="button" className="chat-modal-btn chat-modal-btn--danger" onClick={() => deleteSession(confirmDeleteId)}>{t("delete")}</button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmHideId ? (
        <div className="chat-modal-backdrop" onClick={() => setConfirmHideId(null)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="chat-modal-title">{t("deleteChat")}</h3>
            <p className="chat-modal-desc">{t("hideChatWarning")}</p>
            <div className="chat-modal-actions">
              <button type="button" className="chat-modal-btn" onClick={() => setConfirmHideId(null)}>{t("cancel")}</button>
              <button type="button" className="chat-modal-btn chat-modal-btn--danger" onClick={() => hideSession(confirmHideId)}>{t("delete")}</button>
            </div>
          </div>
        </div>
      ) : null}
      {confirmDeleteProjectDir ? (
        <div className="chat-modal-backdrop" onClick={() => setConfirmDeleteProjectDir(null)}>
          <div className="chat-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="chat-modal-title">{t("deleteProject")}</h3>
            <p className="chat-modal-desc">
              {sessions.filter((s) => (s.projectDir || s.workspaceDir) === confirmDeleteProjectDir).length > 0
                ? <>该项目下有{sessions.filter((s) => (s.projectDir || s.workspaceDir) === confirmDeleteProjectDir).length}个会话，删除后会话将被清除、项目从列表移除（不会删除磁盘上的文件夹及其内容），确认删除？</>
                : <>该项目暂无会话，删除后项目将从列表移除（不会删除磁盘上的文件夹及其内容），确认删除？</>}
            </p>
            <div className="chat-modal-actions">
              <button type="button" className="chat-modal-btn" onClick={() => setConfirmDeleteProjectDir(null)}>{t("cancel")}</button>
              <button
                type="button"
                className="chat-modal-btn chat-modal-btn--danger"
                onClick={() => deleteProjectSessions(confirmDeleteProjectDir)}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {deleting || hiding ? (
        <div className="chat-modal-backdrop chat-modal-backdrop--busy">
          <div className="chat-modal chat-modal--loading">
            <div className="chat-spinner" />
            <p>{t("deleting")}</p>
          </div>
        </div>
      ) : null}
      <div className="agent-content-frame">
        {renderPanels ? renderPanels({ conversation: conversationPanel, chat: chatPanel, operation: operationPanel, activeSessionId: activeSid, selectSession: switchSession }) : <>{conversationPanel}{chatPanel}{operationPanel}</>}
      </div>
      {inviteOpen ? <ContactPickerDialog
        open={inviteOpen}
        title={inviteMode === "empty" ? t("selectContacts") : t("inviteMembers")}
        confirmLabel={inviteMode === "empty" ? t("confirm") : t("invite")}
        contacts={inviteContacts}
        query={inviteQuery}
        onQueryChange={setInviteQuery}
        loading={contactsLoading}
        error={contactsError}
        onReload={reloadContacts}
        excludeIds={inviteMode === "session" ? conversationMembers.map(member => member.contactId) : []}
        initialSelected={inviteMode === "empty" ? pendingMembers.map(member => member.contactId) : []}
        initialContacts={inviteMode === "empty" ? pendingMembers.map(member => ({ id: member.contactId, name: member.name, avatar: member.avatar, department: "", title: "", email: "", mobile: "", provider: initialUser?.provider === "builtin" ? "builtin" : initialUser?.provider === "feishu" ? "feishu" : "dingtalk" })) : []}
        busy={inviteLoading}
        actionError={inviteActionError}
        onConfirm={confirmInvite}
        onClose={() => { setInviteOpen(false); setInviteErrorText(""); }}
      /> : null}
      {artifactToShare ? <ShareToChatDialog basePath={basePath} sourceSessionId={artifactToShare.sessionId} artifactId={artifactToShare.artifact.id} sessions={sessions} onClose={() => setArtifactToShare(null)} /> : null}
      {/* 移动端抽屉遮罩：悬浮抽屉（左/右栏）打开时盖住中栏，点击收起。仅移动端媒体查询下显示 */}
      {(sidebarOpen && !(hasNavigation && !conversationView && activeNavigation === "home" && !libraryOpen)) || rightShown ? (
        <div
          className="chat-mobile-backdrop"
          aria-hidden="true"
          onClick={() => {
            setSidebarOpen(false);
            setRightOpen(false);
            setDiffView(null); // 右栏收起：退出变更 diff 视图
            setInputFilePreview(null); // 右栏收起：退出输入文件预览
            // 右栏收起时同步退出产物全屏态，避免中/左栏持续隐藏造成空白
            setPreviewFull(false);
          }}
        />
      ) : null}
    </div>
    </FullscreenContext.Provider>
    </ChatSessionContext.Provider>
  );
}
