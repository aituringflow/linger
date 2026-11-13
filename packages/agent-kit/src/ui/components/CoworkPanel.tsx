"use client";

import { useChatTranslation } from "../chat/i18n.tsx";
import { ASSISTANT_NAME } from "../../shared/assistant-name.ts";

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVoiceDictation, createDictationTranscriber, type VoiceTranscriber, type VoiceDictationError } from "@summersmile/voice-dictation";
import UserBubble from "../chat/UserBubble.tsx";
import LinkPreviewCard from "../chat/LinkPreviewCard.tsx";
import { tokenizeLinks } from "../chat/linkify.tsx";
import Markdown, { looksLikeMarkdown } from "./Markdown.tsx";
import { SlowPageSpinner } from "./LoadingState.tsx";
import { FileIcon } from "../icons/SharedIcons.tsx";
import MediaAttachment, { type ImageGalleryItem } from "../chat/MediaAttachment.tsx";
import FileMessageCard from "../chat/FileMessageCard.tsx";
import RecordOverlay, { GlobalRecordingWave, RecordingWave } from "../chat/RecordOverlay.tsx";
import { useVoiceHold } from "../chat/useVoiceHold.ts";
import { readMobileVoiceMode, saveMobileVoiceMode, toggleMobileVoiceMode as switchMobileVoiceMode } from "../chat/mobileVoiceMode.ts";
import VoiceMessage from "../chat/VoiceMessage.tsx";
import { apiFetch } from "../shared/apiFetch.ts";
import { resolveAttachmentUrl } from "../shared/attachmentUrl.ts";
import { coworkRealtimeSource, realtimeClient } from "../shared/realtime.ts";
import { openWorkPanelSurface } from "../chat/workPanel.ts";
import { buildCapabilitiesContext, dispatchCapabilityReply, renderCapabilityCards, toCapMessages, type HostCapability, type CapMessage } from "../capabilities/index.tsx";
import { isDesktopApp } from "../chat/platform.ts";
import { ensureWebPushSubscription } from "../shared/webPush.ts";
import { copyTextToClipboard } from "../shared/clipboard.ts";
import { avatarFallbackClass, avatarInitials } from "../shared/avatar.ts";
import { Avatar } from "../shared/AvatarView.tsx";
import { GroupAvatarIcon } from "../shared/GroupAvatarIcon.tsx";
import { CHATMATE_ADOPT_EVENT, CHATMATE_AUTO_SEND_EVENT, AGENT_OPEN_ARTIFACTS_EVENT, AGENT_OPEN_DIFF_EVENT, COWORK_MESSAGE_REVOKED_EVENT, COWORK_MESSAGE_UPDATE_EVENT, readChatDraft, saveChatDraft } from "../shared/drafts.ts";
import { useAtMention } from "../shared/useAtMention.ts";
import ChatInputArea from "./ChatInputArea.tsx";
import ChatComposer, { type ChatComposerHandle } from "./ChatComposer.tsx";
import { useChatScroll } from "../useChatScroll.ts";
import { useClickOutside } from "../useClickOutside.ts";
import type { ComposerReference, ComposerReferenceSource, SessionItem, UiAttachment, UiStep, UiTool, UiVoiceRecording } from "../chat/types.ts";
import AiResponse from "../chat/AiResponse.tsx";
import type { CoworkAgentInfo } from "./CoworkAgentsManager.tsx";
import type { ArtifactChange } from "./ArtifactDiff.tsx";
import HumanMessage from "../chat/HumanMessage.tsx";
import TimeMarker, { shouldShowTimeMarker } from "../chat/TimeMarker.tsx";
import { quickSessionTitle } from "../chat/quickTitle.ts";
import { isAudioFile, isImageFile, isVideoFile, messagePreviewText, stripAttachmentLine } from "../chat/messageUtils.ts";
import { MicIcon, AddUserIcon, SettingsIcon, ErrorMarkIcon, CopyIcon, CheckIcon, MultiSelectIcon, SmileIcon, ReplyBubbleIcon, MoreIcon } from "../icons/SharedIcons.tsx";
import { ChatPanelGlyph01, ChatPanelGlyph04, ChatPanelGlyph08, ChatPanelGlyph21, ChatPanelGlyph24, ChatPanelGlyph35, OperationPanelGlyph08 } from "../icons/PageIcons.tsx";
import ModelSelect, { type ModelMeta, modelOptionKey } from "./ModelSelect.tsx";
import AppSelect from "./AppSelect.tsx";
import MemberChip from "./MemberChip.tsx";
import { GROUP_EMOJIS } from "../cowork-emoji.ts";
import { FeedbackVoteIcon } from "../icons/DynamicIcons.tsx";
import { RecallIcon } from "../icons/ActionIcons.tsx";
import { COWORK_COMPOSER_TEXT_EVENT } from "../shared/drafts.ts";
import ForwardMessageDialog from "./ForwardMessageDialog.tsx";

type Member = { provider: string; contactId: string; name: string; avatar: string; sub?: string };

// 群聊用户消息 Markdown 渲染：文本带 markdown 痕迹时走完整渲染。
// 保留「[附件] 文件名」文件条、裸 URL 链接化（tokenizeLinks 排除 markdown 链接内的 URL）与首链接预览卡；
// @提及高亮经 Markdown.mentions 注入（<span class="cowork-mention">，见 Markdown.tsx mentionRehype）。
function CoworkMarkdownBubble({ text, mentionNames, basePath }: { text: string; mentionNames: string[]; basePath: string }) {
  const parts: Array<{ type: "text" | "file"; value?: string; name?: string }> = [];
  const fileRe = /\[附件\] ([^\n]*)/g;
  let last = 0;
  let fm: RegExpExecArray | null;
  while ((fm = fileRe.exec(text))) {
    if (fm.index > last) parts.push({ type: "text", value: text.slice(last, fm.index) });
    parts.push({ type: "file", name: fm[1].trim() });
    last = fileRe.lastIndex;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  if (parts.length === 0) parts.push({ type: "text", value: text });

  let mdText = "";
  let previewUrl = "";
  for (const part of parts) {
    if (part.type === "file") continue;
    for (const token of tokenizeLinks(part.value || "")) {
      if (token.type === "link") {
        if (!previewUrl) previewUrl = token.raw;
        mdText += `[${token.raw}](${token.href})`;
      } else {
        mdText += token.value;
      }
    }
  }

  const fileNodes: ReactNode[] = [];
  for (const part of parts) {
    if (part.type !== "file") continue;
    // 图片已由上方媒体区（MediaAttachment）直接展示，正文残留的「[附件] 图片名」不再重复渲染文件名条；
    // 其他类型文件仍保留文件名条。
    if (isImageFile({ name: part.name })) continue;
    fileNodes.push(
      <span key={`f${fileNodes.length}`} className="msg-inline-file">
        <span className="msg-inline-file-icon" aria-hidden="true"><FileIcon /></span>
        <span className="msg-inline-file-name">{part.name}</span>
      </span>
    );
  }
  return (
    <div className="cowork-user-md">
      {fileNodes.length ? <div className="msg-attachments">{fileNodes}</div> : null}
      {previewUrl && (() => {
        try {
          const url = new URL(previewUrl, window.location.origin);
          if (url.origin === window.location.origin && /^\/api\/share\/chat\/[0-9a-f]{48}$/.test(url.pathname.replace(basePath, ""))) {
            const shared = text.match(/^(AI 对话分享|产物分享)：([^\n]+)/);
            const title = shared?.[2] || "分享内容";
            return <a className="chat-share-message-card" href={url.href} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}><strong>{title}</strong><span>{shared?.[1] || "分享"} · 点击查看</span></a>;
          }
        } catch { /* 普通链接交给预览组件 */ }
        return <LinkPreviewCard key="preview" url={previewUrl} basePath={basePath} />;
      })()}
      {mdText.trim() ? <Markdown content={mdText} mentions={mentionNames} urlBasePath={basePath} /> : null}
    </div>
  );
}

function EmojiPopup({ anchor, open, onDismiss, children }: { anchor: HTMLElement | null; open: boolean; onDismiss: () => void; children: ReactNode }) {
  const t = useChatTranslation();
  const popupRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }
    setVisible(false);
    const timer = window.setTimeout(() => setMounted(false), 130);
    return () => window.clearTimeout(timer);
  }, [open]);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const popup = popupRef.current;
      if (!popup) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const gap = 6;
      const above = Math.max(0, rect.top - margin - gap);
      const below = Math.max(0, window.innerHeight - rect.bottom - margin - gap);
      const desiredHeight = Math.min(310, popup.scrollHeight + 2);
      const up = above >= desiredHeight;
      const maxHeight = Math.min(310, up ? above : below);
      const height = Math.min(desiredHeight, maxHeight);
      const width = Math.min(320, window.innerWidth - margin * 2);
      setPosition({ width, maxHeight, left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
        top: up ? Math.max(margin, rect.top - gap - height) : rect.bottom + gap, visibility: "visible" });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [anchor, mounted]);
  return anchor && mounted ? createPortal(<div ref={popupRef} className={`cowork-emoji-popup${visible ? " is-visible" : ""}`} style={position} role="dialog" aria-label={t("selectEmoji")} onMouseLeave={onDismiss} onClick={event => event.stopPropagation()}>{children}</div>, document.body) : null;
}
type ReplyPolicy = "balanced" | "cautious" | "proactive" | "mentions_only" | "custom";
type Message = { id: number; role: string; content: string; revokedAt?: string | null; senderSub?: string | null; clientMessageId?: string | null; senderName?: string | null; senderAvatar?: string | null; createdAt?: string | null; replyToId?: number | null; runId?: string | null; attachment?: UiAttachment | UiAttachment[] | null; voice?: UiVoiceRecording | null; forwardedBundle?: Array<{ senderName: string; content: string; createdAt: string; attachments: UiAttachment[] }> | null; steps?: UiStep[] | null; elapsedSecs?: number | null; artifacts?: ArtifactChange[] | null };
type PendingMessage = { localId: string; content: string; attachments: UiAttachment[]; voice?: UiVoiceRecording; replyToId?: number | null; createdAt: string; status: "sending" | "slow" | "accepted" | "failed"; error?: string; autoTitle?: boolean };
function quotedContent(message?: Message): string {
  if (!message) return "原消息不可用";
  if (message.revokedAt) return "原消息已撤回";
  const text = message.content.trim();
  if (text) return text;
  const attachments = Array.isArray(message.attachment) ? message.attachment : message.attachment ? [message.attachment] : [];
  return attachments.length ? `[附件] ${attachments.map(item => item.name).join("、")}` : "原消息不可用";
}
function quotedSender(message: Message | undefined, selfSub: string, agentName: string, ownerSub?: string): string {
  if (!message) return "成员";
  // 升级前的人机聊天消息 sender_sub 为 NULL = 会话所有者所发；所有者本人查看时引用显示「你」
  if (message.senderSub === selfSub || (message.senderSub == null && ownerSub === selfSub)) return "你";
  return message.role === "assistant" ? agentName : message.senderName || "成员";
}
export type CoworkMonologue = { id: string; agentId?: string | null; status: string; content: string; steps?: UiStep[]; elapsedSecs?: number | null; startedAt?: string; error?: string | null };
type Run = CoworkMonologue & { trigger_message_id: number };
type Reaction = { message_id: number; user_sub: string; user_name: string | null; emoji: string };
type Reader = { userSub: string; name: string; avatar: string; read: boolean };
type ParticipantRead = Omit<Reader, "read"> & { throughId: string; addedAt: string };
type State = { messages: Message[]; run: Run | null; reactions: Reaction[];
  participantReads: ParticipantRead[];
  monologues: CoworkMonologue[];
  settings: { title: string; cowork_avatar: string; cowork_mode: string; cowork_model: string | null; cowork_codex_model: string | null; cowork_reply_policy: ReplyPolicy; cowork_fast_prompt: string } | null; ownerSub: string; ownerName?: string; ownerAvatar?: string; isTwoPerson?: boolean; isAdmin?: boolean; adminRoster?: Array<{ provider: string; contactId: string; name: string; avatar: string }> };

export default function CoworkPanel({ basePath, sessionId, title, sessionTitle, rightCtrlVoice, showVoiceButton, previewFull, selfSub, selfName, selfAvatar, members, pendingMembers,
  models, codexModels, modes, modelSelectionEnabled, canInvite, onInvite, onStarted, onTitleChange, onGroupAvatarChange, onMessagePreview, onSidebar, onBack, onRightPanel, onMobileSettingsBack, onOpenFile, rightShown, onMonologuesChange, initialSubmission, onSubmissionConsumed, sessions, onForwarded, onMembersRemoved, capabilities, referenceSources = [], renderToolbar, initialDraftCaret, onInitialDraftRestored,
  initialMode, initialModel, initialCodexModel, muted, onMutedChange, aiMuted, onAiMutedChange, jumpMessageId, onJumpComplete, onSessionEnded, onHomeDraftChange, onMessageSubmitted, homeRecipientChips, onRemoveHomeRecipient }: {
  basePath: string; sessionId: string; title: string; sessionTitle: string; rightCtrlVoice: boolean; showVoiceButton?: boolean; previewFull: boolean; selfSub: string; selfName: string; selfAvatar?: string;
  renderToolbar?: (settings: { open: boolean; label: string; title: string; toggle: () => void }) => ReactNode;
  onHomeDraftChange?: (value: string, caret: number) => boolean | void;
  onMessageSubmitted?: () => void;
  homeRecipientChips?: Array<{ id: string; name: string; avatar: string }>;
  onRemoveHomeRecipient?: (id: string, draft: string, caret: number, attachments: UiAttachment[]) => void;
  initialDraftCaret?: number;
  onInitialDraftRestored?: () => void;
  members: Member[]; pendingMembers: Array<{ provider?: string; contactId: string; name: string; avatar: string }>;
  sessions: SessionItem[]; onForwarded: () => void;
  /** 批量移除成员成功后回调（通知父级同步成员列表，如邀请弹窗的已排除名单）。 */
  onMembersRemoved?: (contactIds: string[]) => void;
  /** 通道无关的注册能力列表；与单聊共用同一套 buildContext/onReply/renderCard。 */
  capabilities?: HostCapability[];
  referenceSources?: readonly ComposerReferenceSource[];
  models: Array<{ id: string; name?: string; meta?: ModelMeta }>; codexModels: Array<{ id: string; name?: string; meta?: ModelMeta }>; modes: string[];
  modelSelectionEnabled: boolean;
  canInvite: boolean;
  onInvite: () => void; onStarted: (members: Member[]) => void; onTitleChange: (value: string) => void; onGroupAvatarChange: (value: string) => void;
  onMessagePreview: (content: string, senderName: string, createdAt?: string | null, fromUser?: boolean, senderSub?: string | null) => void; onSidebar: () => void;
  /** 移动端详情态左上角返回箭头：回会话列表；缺省回退到 onSidebar。 */
  onBack?: () => void;
  onOpenFile: (file: UiAttachment) => void;
  onMonologuesChange?: (items: CoworkMonologue[]) => void;
  onRightPanel: (page?: "settings" | "artifacts" | "chatmate" | "monologue") => void;
  onMobileSettingsBack?: () => void;
  rightShown?: boolean;
  initialSubmission: { text: string; attachments: UiAttachment[] } | null;
  onSubmissionConsumed: () => void;
  /** 新建群时从「空态选人」继承的初始框架/模型：避免建群 settings 用 models[0] 覆盖用户选择。 */
  initialMode?: string; initialModel?: string; initialCodexModel?: string;
  muted?: boolean; onMutedChange: (value: boolean) => void;
  aiMuted?: boolean; onAiMutedChange: (value: boolean) => void;
  jumpMessageId?: number | null; onJumpComplete?: () => void;
  /** 当前会话被「解散群组 / 退出群组」后，通知宿主关闭该会话并刷新列表。 */
  onSessionEnded?: (kind: "leave" | "dissolve" | "delete") => void;
}) {
  const t = useChatTranslation();
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState("");
  const [historyOnly, setHistoryOnly] = useState(false);
  const stateRef = useRef<State | null>(null);
  stateRef.current = state;
  const [readDetails, setReadDetails] = useState<{ messageId: number; people: Reader[] } | null>(null);
  const [bundleViewer, setBundleViewer] = useState<NonNullable<Message["forwardedBundle"]> | null>(null);
  const lastMarkedRead = useRef(0);
  const [error, setError] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [moreMenuId, setMoreMenuId] = useState<number | null>(null);
  const [forwardMessage, setForwardMessage] = useState<Message | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [forwardSelected, setForwardSelected] = useState(false);
  const [selectedForwardMode, setSelectedForwardMode] = useState<"merged" | "individual">("merged");
  const imageGallery: ImageGalleryItem[] = (state?.messages ?? []).flatMap(message => {
    if (message.revokedAt || message.role === "reaction" || message.role === "system" || message.forwardedBundle?.length) return [];
    const files = Array.isArray(message.attachment) ? message.attachment : message.attachment ? [message.attachment] : [];
    return files.flatMap((file, index) => isImageFile(file) ? [{ key: `${message.id}:${index}`, name: file.name, url: resolveAttachmentUrl(file.url, basePath, file.fileId) }] : []);
  });
  const renderMessageAttachment = (file: UiAttachment, index: number, galleryKey?: string) => isImageFile(file) || isVideoFile(file) || isAudioFile(file)
    ? <MediaAttachment key={`${file.url}-${index}`} file={file} url={resolveAttachmentUrl(file.url, basePath, file.fileId)} gallery={galleryKey ? imageGallery : undefined} galleryKey={galleryKey} />
    : <FileMessageCard key={`${file.url}-${index}`} file={file} onOpen={() => onOpenFile(file)} />;
  // 合并转发卡片预览：每条压成一行（折叠换行），无正文时用附件占位说明
  const bundlePreviewLine = (item: NonNullable<Message["forwardedBundle"]>[number]) => {
    const text = item.content.replace(/\s+/g, " ").trim();
    if (text) return `${item.senderName}：${text}`;
    const first = item.attachments?.[0];
    if (!first) return `${item.senderName}：（无内容）`;
    const media = isImageFile(first) ? "[图片]" : isVideoFile(first) ? "[视频]" : isAudioFile(first) ? "[语音]" : `[文件] ${first.name}`;
    const extra = (item.attachments?.length ?? 0) > 1 ? ` 等${item.attachments!.length}个附件` : "";
    return `${item.senderName}：${media}${extra}`;
  };
  const downloadAttachment = (file: UiAttachment) => {
    const resolved = resolveAttachmentUrl(file.url, basePath, file.fileId);
    const url = `${resolved}${resolved.includes("?") ? "&" : "?"}download=1`;
    const desktop = (window as Window & { agentHost?: { download?: (url: string, name: string) => Promise<unknown> } }).agentHost;
    if (desktop?.download) { void desktop.download(url, file.name); return; }
    const link = document.createElement("a");
    link.href = url; link.download = file.name; document.body.appendChild(link); link.click(); link.remove();
  };
  const toggleSelected = (id: number) => setSelectedIds(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  useEffect(() => {
    if (!multiSelect || forwardSelected) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMultiSelect(false);
      setSelectedIds(new Set());
      setMoreMenuId(null);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [multiSelect, forwardSelected]);
  useEffect(() => {
    if (!bundleViewer) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setBundleViewer(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [bundleViewer]);
  // 消息「更多」菜单：点击菜单/⋯ 之外任意处关闭（data-cowork-more-menu 覆盖菜单与锚点）
  useClickOutside({
    enabled: moreMenuId !== null,
    exceptSelectors: ["[data-cowork-more-menu]"],
    onDismiss: () => setMoreMenuId(null),
  });
  const [msgVotes, setMsgVotes] = useState<Record<number, "up" | "down" | null>>({});
  const [sending, setSending] = useState(false);
  const [emojiPicker, setEmojiPicker] = useState<"composer" | number | null>(null);
  const [dismissedMenuId, setDismissedMenuId] = useState<number | null>(null);
  const emojiHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelEmojiHover = () => { if (emojiHoverTimer.current) clearTimeout(emojiHoverTimer.current); emojiHoverTimer.current = null; };
  useEffect(() => () => cancelEmojiHover(), []);
  const [emojiAnchor, setEmojiAnchor] = useState<HTMLElement | null>(null);
  const [replyToId, setReplyToId] = useState<number | null>(null);
  const [recentEmojis, setRecentEmojis] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem("cowork-recent-emojis") || "[]"); } catch { return []; } });
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [hasInput, setHasInput] = useState(false);
  const [referenceMenuOpen, setReferenceMenuOpen] = useState(false);
  const [composerReferences, setComposerReferences] = useState<Array<{ sourceId: string; reference: ComposerReference }>>([]);
  // 移动端「按住说话」模式：点按喇叭进入，输入框隐藏、显示按住说话，喇叭位变键盘退出钮。
  const [mobileVoiceMode, setMobileVoiceMode] = useState(readMobileVoiceMode);
  const [rightCtrlRecording, setRightCtrlRecording] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 移动端顶栏「更多」popup：设置 / 查看产物 / 伴聊·Chatmate / AI 独白
  const [coworkMoreOpen, setCoworkMoreOpen] = useState(false);
  const [groupTitle, setGroupTitle] = useState(sessionTitle);
  const [groupAvatar, setGroupAvatar] = useState("");
  const [groupAvatarUploading, setGroupAvatarUploading] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [mutedSaving, setMutedSaving] = useState(false);
  /** 最近一次已落库的群名称（防抖即时保存用）：打开面板/切会话时对齐，避免误触保存 */
  const lastPersistedTitle = useRef("");
  /** 自定义提示词「保存」按钮的短暂成功反馈 */
  /** 群危险操作确认：leave=退出群组 / dissolve=解散群组（仅对应角色可见入口） */
  const [groupAction, setGroupAction] = useState<null | "leave" | "dissolve" | "delete">(null);
  const [groupActionBusy, setGroupActionBusy] = useState(false);
  /** 群主批量移除成员：勾选集合 + 确认框 + 请求中 */
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removingBusy, setRemovingBusy] = useState(false);
  /** 管理员管理弹窗（仅群主打开）：列表内逐个设/取消管理员，支持多名管理员。 */
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);
  /** 本地成员覆盖：移除成功后无需等会话重开即反映；members prop 变化（加人/切会话）时重置 */
  const [localMembersOverride, setLocalMembersOverride] = useState<Member[] | null>(null);
  const effectiveMembers = localMembersOverride ?? members;
  useEffect(() => { setLocalMembersOverride(null); setSelectedMembers(new Set()); }, [members]);
  const toggleMemberSelect = (contactId: string) => {
    setSelectedMembers(prev => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId); else next.add(contactId);
      return next;
    });
  };
  const toggleMuted = async (value: boolean) => {
    setMutedSaving(true); setSettingsError("");
    try {
      const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ muted: value }),
      });
      if (!response.ok) throw new Error("保存消息免打扰失败");
      onMutedChange(value);
      // 打开全量免打扰时必然一并打开 AI 消息免打扰（后端联动，前端同步显示）
      if (value) onAiMutedChange(true);
    } catch (cause) { setSettingsError(cause instanceof Error ? cause.message : "保存消息免打扰失败"); }
    finally { setMutedSaving(false); }
  };
  const toggleAiMuted = async (value: boolean) => {
    setMutedSaving(true); setSettingsError("");
    try {
      const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ aiMuted: value }),
      });
      if (!response.ok) throw new Error("保存 AI 消息免打扰失败");
      onAiMutedChange(value);
    } catch (cause) { setSettingsError(cause instanceof Error ? cause.message : "保存 AI 消息免打扰失败"); }
    finally { setMutedSaving(false); }
  };
  const [memberQuery, setMemberQuery] = useState("");
  const groupAvatarInput = useRef<HTMLInputElement>(null);
  // 新建群（成员尚未落库）时以空态选中的框架/模型为初值：建群发的 settings 直接沿用它，
  // 避免 model 初始为空 → `model || models[0]` 兜底成列表第一个模型（hy4 preview）。
  // 已有群则留空，由下面的 state.settings 同步 effect 用服务端群设置覆盖。
  const isNewGroupSeed = members.length === 0 && pendingMembers.length > 0;
  const [mode, setMode] = useState(() => (isNewGroupSeed && initialMode && modes.includes(initialMode) ? initialMode : modes[0] || "codebuddy"));
  const [model, setModel] = useState(() => (isNewGroupSeed ? (initialModel || "") : ""));
  const [codexModel, setCodexModel] = useState(() => (isNewGroupSeed ? (initialCodexModel || "") : ""));
  const [groupAgents, setGroupAgents] = useState<CoworkAgentInfo[]>([]);
  const agentsSyncedAfterState = useRef(false);
  useEffect(() => {
    // 新建群的成员还未落库时 /agents 会返回 not_group；成员保存后必须重新请求。
    if (!members.length) return;
    let cancelled = false;
    let request = 0;
    const endpoint = `${basePath}/api/cowork/${encodeURIComponent(sessionId)}/agents`;
    const reload = () => {
      const current = ++request;
      void (async () => {
        const response = await apiFetch(endpoint, { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as { agents?: CoworkAgentInfo[] };
        if (!data.agents || cancelled) return;
        if (current === request) setGroupAgents(data.agents);
      })().catch(() => {});
    };
    const changed = (event: Event) => { if ((event as CustomEvent<{ sessionId: string }>).detail?.sessionId === sessionId) reload(); };
    reload(); window.addEventListener("cowork-agents-changed", changed);
    return () => { cancelled = true; window.removeEventListener("cowork-agents-changed", changed); };
  }, [basePath, sessionId, members.length, title]);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [attachments, setAttachments] = useState<UiAttachment[]>(initialSubmission?.attachments ?? []);
  const [uploading, setUploading] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  // 喇叭「按住说话」：按住开始录制，移出输入条进入取消态，松开按当前位置提交/取消。
  // 与常驻麦克风（点按切换的语音转写）是两套独立交互，互不替代。
  const [holdRecording, setHoldRecording] = useState(false);
  const [holdCancelArmed, setHoldCancelArmed] = useState(false);
  // 长按「松开发送」链路：persist 保存录音拿 fileId，转写文字与语音一起发出（对齐人机）。
  const pendingVoiceRef = useRef<UiVoiceRecording | null>(null);
  const voiceSendPendingRef = useRef(false);
  const voiceStartedAtRef = useRef(0);
  // 拖拽添加附件（与人机聊天一致）：文件拖到消息列表/输入框区域松开即加入附件
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [recentScreenshot, setRecentScreenshot] = useState<{ id: string; name: string; thumbnail: string } | null>(null);
  const screenshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screenshotHoveredRef = useRef(false);
  useEffect(() => {
    const desktop = (window as unknown as { agentHost?: { screenshots?: {
      onNew(listener: (notice: { id: string; name: string; thumbnail: string }) => void): () => void;
    } } }).agentHost;
    if (!desktop?.screenshots) return;
    const unsubscribe = desktop.screenshots.onNew((notice) => {
      setRecentScreenshot(notice);
      if (screenshotTimerRef.current) clearTimeout(screenshotTimerRef.current);
      screenshotTimerRef.current = screenshotHoveredRef.current ? null : setTimeout(() => setRecentScreenshot(null), 10000);
    });
    return () => { unsubscribe(); if (screenshotTimerRef.current) clearTimeout(screenshotTimerRef.current); };
  }, []);
  const voiceEnabled = true;
  // 仅移动端把「语音 / 发送」改为互斥切换；桌面保持语音 + 发送并排原样。
  const isMobileLayout = typeof window !== "undefined" && window.matchMedia("(max-width: 767.98px)").matches;
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const saveGroupDraft = useCallback((value: string) => saveChatDraft(sessionId, value, attachments, { replyToId }), [sessionId, attachments, replyToId]);
  const [draftHydratedSid, setDraftHydratedSid] = useState<string | null>(null);
  useEffect(() => {
    if (draftHydratedSid !== sessionId) return;
    saveGroupDraft(composerRef.current?.getText() ?? "");
  }, [sessionId, draftHydratedSid, attachments, replyToId, saveGroupDraft]);
  useEffect(() => {
    const adopt = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string }>).detail;
      if (detail?.sessionId !== sessionId || !detail.text?.trim()) return;
      composerRef.current?.setText(detail.text);
      composerRef.current?.focus();
    };
    window.addEventListener(CHATMATE_ADOPT_EVENT, adopt);
    return () => window.removeEventListener(CHATMATE_ADOPT_EVENT, adopt);
  }, [sessionId]);
  useEffect(() => {
    if (initialSubmission) return;
    const draft = readChatDraft(sessionId);
    composerRef.current?.setText(draft.text, initialDraftCaret);
    if (initialDraftCaret !== undefined) {
      requestAnimationFrame(() => composerRef.current?.focus());
      onInitialDraftRestored?.();
    }
    setAttachments(draft.attachments);
    setReplyToId(draft.replyToId);
    setDraftHydratedSid(sessionId);
  }, [sessionId]);
  const initialized = useRef(false);
  const lastId = useRef(0);
  const groupReady = members.length > 0;
  useEffect(() => {
    let cancelled = false;
    setMsgVotes({});
    fetch(`${basePath}/api/feedback?sessionId=${encodeURIComponent(sessionId)}`, { credentials: "include" })
      .then(response => response.ok ? response.json() : null)
      .then(data => { if (!cancelled && data?.votes) setMsgVotes(data.votes as Record<number, "up" | "down">); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [basePath, sessionId]);
  const liveRun = state?.run && (state.run.status === "running" || state.run.status === "pending") && !state.messages.some(message => message.runId === state.run?.id)
    ? state.run : null;
  useEffect(() => { onMonologuesChange?.(state?.monologues ?? []); }, [state?.monologues, onMonologuesChange]);
  useEffect(() => {
    if (document.hidden || !state?.messages.length) return;
    const throughId = state.messages.at(-1)?.id ?? 0;
    if (throughId <= lastMarkedRead.current) return;
    lastMarkedRead.current = throughId;
    void apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/read`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ throughId }),
    }).then(response => { if (!response.ok) lastMarkedRead.current = 0; }).catch(() => { lastMarkedRead.current = 0; });
  }, [basePath, sessionId, state?.messages]);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!liveRun) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [liveRun?.id]);
  const liveElapsed = liveRun?.startedAt ? Math.max(1, Math.floor((clock - new Date(liveRun.startedAt).getTime()) / 1000)) : liveRun?.elapsedSecs;
  // 聊天区滚动：与单聊复用同一套 useChatScroll，统一「发送后滚到底 / 上滚出现回到底部按钮 /
  // 大模型输出中播放按钮动画」的体验。群聊不置顶（pinOnSend=false），发送即跟随底部。
  // 依赖项随消息 / 待确认消息 / 流式内容变化而刷新，驱动「跟随底部」滚动。
  const scrollMessages = useMemo(
    () => [
      ...(state?.messages ?? []),
      ...pendingMessages,
      ...(liveRun ? [liveRun.content ?? ""] : []),
    ],
    [state?.messages, pendingMessages, liveRun?.content],
  );
  const jumpScrollSuppressRef = useRef(jumpMessageId != null);
  const [jumpHighlightId, setJumpHighlightId] = useState<number | null>(null);
  const { bodyRef, bindBodyRef, spacerRef, atBottom, jumpToBottom, scrollToMessage, onUserScrollIntent, markSend, resetScrollState, unreadCount, markUnread } = useChatScroll({
    messages: scrollMessages,
    busy: !!liveRun,
    booting: state === null,
    pinOnSend: false,
    initScrollDisabledRef: jumpScrollSuppressRef,
  });
  // 本会话「已计入未读」的消息 id：同一消息（SSE 重投 / 轮询合并）只计一次；
  // 会话切换时随 resetScrollState 一并清空（见下方 [sessionId] effect）。
  const countedUnreadIdsRef = useRef<Set<number>>(new Set());
  // 计入未读的口径：他人的 user 消息 + 完成的 assistant 消息（AI 回复）；
  // 自己的消息（senderSub === selfSub）与 system 群事件不计。
  const shouldCountUnread = (message: Message): boolean =>
    message.role === "user" ? message.senderSub !== selfSub : message.role === "assistant";
  useEffect(() => {
    if (jumpMessageId == null || !state) return;
    const index = state.messages.findIndex(message => message.id === jumpMessageId);
    if (index < 0) return;
    const frame = requestAnimationFrame(() => {
      if (scrollToMessage(index, "auto")) {
        setJumpHighlightId(jumpMessageId);
        onJumpComplete?.();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [jumpMessageId, state?.messages]);
  useEffect(() => {
    if (jumpHighlightId == null) return;
    const timer = window.setTimeout(() => setJumpHighlightId(null), 4000);
    return () => window.clearTimeout(timer);
  }, [jumpHighlightId]);
  // 切换会话：重置滚动状态并标记初始化滚底（历史加载完成后滚到最新消息）。
  useEffect(() => { resetScrollState(); countedUnreadIdsRef.current = new Set(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sessionId]);
  useEffect(() => { setMultiSelect(false); setSelectedIds(new Set()); setForwardSelected(false); setForwardMessage(null); setBundleViewer(null); }, [sessionId]);
  const senderDisplayName = (message: Message): string => {
    if (message.role !== "user") return message.senderName || "成员";
    if (message.senderSub === selfSub) return selfName;
    const member = members.find(item => item.sub === message.senderSub || `${item.provider}:${item.contactId}` === message.senderSub);
    const ownerState = stateRef.current;
    const ownerName = ownerState && message.senderSub === ownerState.ownerSub ? ownerState.ownerName : null;
    return (message.senderName && message.senderName !== "成员" ? message.senderName : null) || member?.name || ownerName || "成员";
  };
  const applyMessage = (incoming: Message) => {
    const message = incoming.role === "user" ? { ...incoming, senderName: senderDisplayName(incoming) } : incoming;
    lastId.current = Math.max(lastId.current, message.id);
    onMessagePreview(messagePreviewText(message.content, message.attachment), message.role === "assistant" ? title : (message.senderSub === selfSub || (message.senderSub == null && state?.ownerSub === selfSub)) ? "我" : message.senderName || "成员", message.createdAt, message.role === "user", message.senderSub);
    if (message.clientMessageId) setPendingMessages(current => current.filter(item => item.localId !== message.clientMessageId));
    // 未读计数：滚离底部期间到达的他人消息 / 完成的 AI 回复计入「x 条新消息」；
    // 同一 id（SSE 重投）只计一次。计数在 setState 之外执行，避免 updater 副作用与重复执行。
    if (!countedUnreadIdsRef.current.has(message.id) && shouldCountUnread(message)) {
      countedUnreadIdsRef.current.add(message.id);
      markUnread(1);
    }
    const isNew = !(stateRef.current?.messages.some(item => item.id === message.id));
    setState(current => {
      if (!current) return current;
      if (current.messages.some(item => item.id === message.id)) return current;
      return { ...current, messages: [...current.messages, message].sort((a, b) => a.id - b.id) };
    });
    // 新的群聊消息（含自己刚发送的带附件消息）广播给主窗口：合并进该会话 rt.messages，
    // 否则右栏「输入文件」只含切会话时的历史快照，缺群聊进行中新增的附件（见 COWORK_MESSAGE_UPDATE_EVENT）。
    if (isNew) {
      window.dispatchEvent(new CustomEvent(COWORK_MESSAGE_UPDATE_EVENT, { detail: { sessionId, message } }));
    }
    // 新的助手回复到达（非 SSE 重投）：分发给注册能力抽取草稿/写状态，与单聊 onAssistantResponse 对齐。
    if (isNew && message.role === "assistant" && message.content?.trim()) {
      const history = [...(stateRef.current?.messages ?? []), message];
      dispatchCapabilityReply(capabilities, { sessionId, reply: message.content, messages: toCapMessages(history), channel: "cowork" });
    }
  };
  // 每个会话（effect 运行）独立的「已卸载」标记；必须在 effect 开头重置，
  // 否则上一次长连接（SSE）的 cleanup 把它置为 true 后，再次进入群时 refresh
  // 会在「if (closed) return」处提前退出，state 永远为 null，卡在加载状态（1s 后居中转圈）。
  const closedRef = useRef(false);
  const refresh = async () => {
    try {
      const response = await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(sessionId)}/state?title=${encodeURIComponent(title)}&after=${lastId.current}`, { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        if (response.status === 404 && payload?.error === "cowork_disabled") {
          // An older hosted server can still reject the cowork route while its
          // authenticated session-history route remains available to desktop.
          const history = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/messages`, { cache: "no-store" });
          if (history.ok) {
            const data = await history.json() as { messages?: Message[]; ownerSub?: string };
            if (closedRef.current) return;
            const messages = Array.isArray(data.messages) ? data.messages : [];
            for (const message of messages) lastId.current = Math.max(lastId.current, message.id);
            setState(current => ({
              messages, run: null, participantReads: [], monologues: [], reactions: [], settings: null,
              ownerSub: data.ownerSub || current?.ownerSub || "",
            }));
            setHistoryOnly(true);
            setLoadError("群聊服务尚未启用，当前仅能查看历史消息");
            return;
          }
        }
        if (!closedRef.current) setLoadError(`群消息加载失败（HTTP ${response.status}${payload?.error ? `: ${payload.error}` : ""}）`);
        return;
      }
      const next = await response.json() as State;
      if (closedRef.current) return;
      setHistoryOnly(false);
      setLoadError("");
      for (const message of next.messages) lastId.current = Math.max(lastId.current, message.id);
      const confirmed = new Set(next.messages.map(message => message.clientMessageId).filter(Boolean));
      if (confirmed.size) setPendingMessages(current => current.filter(item => !confirmed.has(item.localId)));
      setState(current => {
        if (!current) return next;
        if (!next.messages.length) return { ...next, messages: current.messages };
        const merged = new Map(current.messages.map(message => [message.id, message]));
        // 未读计数：合并进来的新消息（断线/重连/轮询补拉）若属他人消息或完成的 AI 回复，
        // 计入「x 条新消息」。id 去重保证 updater 重复执行（StrictMode）也不会重复计数。
        let unreadDelta = 0;
        for (const message of next.messages) {
          if (!merged.has(message.id)) {
            merged.set(message.id, message);
            if (shouldCountUnread(message) && !countedUnreadIdsRef.current.has(message.id)) {
              countedUnreadIdsRef.current.add(message.id);
              unreadDelta++;
            }
          }
        }
        if (unreadDelta > 0) markUnread(unreadDelta);
        return { ...next, messages: [...merged.values()].sort((a, b) => a.id - b.id) };
      });
      if (!initialized.current && next.settings) {
        initialized.current = true;
        // /agents 可能先于 /state?title=... 返回旧默认名；状态请求完成后重新读取。
        if (!agentsSyncedAfterState.current) {
          agentsSyncedAfterState.current = true;
          window.dispatchEvent(new CustomEvent("cowork-agents-changed", { detail: { sessionId } }));
        }
        // 群设置未配置时回退继承升级前会话的框架/模型（见设置同步 effect 注释）
        setMode(modes.includes(next.settings.cowork_mode) ? next.settings.cowork_mode : (initialMode && modes.includes(initialMode) ? initialMode : modes[0] || "codebuddy"));
        setModel(next.settings.cowork_model || (initialModel || "") || models[0]?.id || "");
        setCodexModel(next.settings.cowork_codex_model || (initialCodexModel || "") || codexModels[0]?.id || "");
      }
    } catch (cause) {
      if (!closedRef.current) setLoadError(cause instanceof Error ? `群消息加载失败：${cause.message}` : "群消息加载失败");
    }
  };
  useEffect(() => {
    closedRef.current = false;
    initialized.current = false;
    agentsSyncedAfterState.current = false;
    lastId.current = 0;
    lastMarkedRead.current = 0;
    setReadDetails(null);
    setState(null);
    setHistoryOnly(false);
    setLoadError("");
    if (!groupReady) return;
    // SSE 实时推送；建连、重连及页面重新可见时补齐断线期间的消息。
    void refresh();
    const source = coworkRealtimeSource(basePath, sessionId);
    source.onopen = () => { if (!closedRef.current) return refresh(); };
    source.onerror = () => { if (!closedRef.current) void refresh(); };
    const onVisibility = () => { if (!closedRef.current && !document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    const receiptPoll = window.setInterval(() => { if (!closedRef.current && !document.hidden) void refresh(); }, 15000);
    source.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { message: Message };
        applyMessage(payload.message);
      } catch { /* 忽略坏帧 */ }
    });
    source.addEventListener("revoked", (event) => {
      try {
        const { messageId, revokedAt } = JSON.parse((event as MessageEvent).data) as { messageId: number; revokedAt: string };
        setState(current => current ? { ...current, messages: current.messages.map(message => message.id === messageId
          ? { ...message, content: "", attachment: null, revokedAt } : message) } : current);
      } catch { /* 忽略坏帧 */ }
    });
    source.addEventListener("run", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { run: Run | null };
        setState(current => current ? { ...current, run: payload.run } : current);
      } catch { /* 忽略坏帧 */ }
    });
    source.addEventListener("agent", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { runId: string; event: string; data: Record<string, unknown> };
        setState(current => {
          if (!current?.run || current.run.id !== payload.runId) return current;
          const run = { ...current.run, steps: (current.run.steps ?? []).map(step => ({ ...step, tool: step.tool ? { ...step.tool } : null })) };
          const data = payload.data;
          const index = Math.max(1, Number(data.index) || 1) - 1;
          while (run.steps!.length <= index) run.steps!.push({ thinking: "", text: "", tool: null });
          const step = run.steps![index];
          if (payload.event === "text") run.content += String(data.text ?? "");
          else if (payload.event === "thinking") step.thinking = `${step.thinking ?? ""}${String(data.text ?? "")}`;
          else if (payload.event === "tool") step.tool = { name: String(data.name ?? ""), input: String(data.input ?? ""), activity: typeof data.activity === "string" ? data.activity : undefined,
            edit: data.edit as UiTool["edit"], toolUseId: String(data.toolUseId ?? ""), status: "running" };
          else if (payload.event === "tool_result" && step.tool && (!step.tool.toolUseId || !data.toolUseId || step.tool.toolUseId === String(data.toolUseId))) {
            step.tool.status = data.status === "failed" ? "failed" : "completed";
            step.tool.result = String(data.summary ?? "").slice(0, 300);
          }
          return { ...current, run };
        });
      } catch { /* 忽略坏帧 */ }
    });
    source.addEventListener("fast", (event) => {
      try {
        const item = JSON.parse((event as MessageEvent).data) as CoworkMonologue & { runId: string; phase?: "initial" | "review" };
        const itemId = item.phase === "review" ? `${item.runId}:review` : item.runId;
        setState(current => current ? { ...current, monologues: [...current.monologues.filter(existing => existing.id !== itemId),
          { id: itemId, agentId: item.agentId, content: item.content, status: item.status, steps: item.steps, elapsedSecs: item.elapsedSecs,
            startedAt: current.monologues.find(existing => existing.id === itemId)?.startedAt || new Date().toISOString() }] } : current);
      } catch { /* 忽略坏帧 */ }
    });
    source.addEventListener("agents", () => {
      window.dispatchEvent(new CustomEvent("cowork-agents-changed", { detail: { sessionId } }));
    });
    source.addEventListener("admins", () => { void refresh(); });
    // Tool calls may run in a separate server module instance; consume the persisted realtime channel.
    const unsubscribePreview = realtimeClient(basePath).subscribe(sessionId, { onEvent: frame => {
      if (frame.event !== "preview") return;
      try {
        const payload = frame.data as { agentId?: string; url?: string; requesterSub?: string };
        if (!payload.agentId || !payload.url) return;
        if (payload.requesterSub && payload.requesterSub !== selfSub) return;
        const url = new URL(payload.url, window.location.href);
        // 只校验路径在预览挂载点下，不要求同源：服务端可能以 APP_PUBLIC_URL 发布不同 origin 的地址。
        if (!/^https?:$/.test(url.protocol) || !url.pathname.startsWith(`${basePath}/preview/`)) return;
        // 容器为群级共享，预览应用同一时刻只有一个：按群建唯一 tab，任何 AI 再次启动都聚焦并刷新它。
        openWorkPanelSurface({ kind: "website", id: `group-preview:${sessionId}`, title: "应用预览", url: url.href, sessionId, reload: true });
      } catch { /* 忽略坏帧 */ }
    } });
    source.addEventListener("reactions", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { reactions: State["reactions"] };
        setState(current => current ? { ...current, reactions: payload.reactions } : current);
      } catch { /* 忽略坏帧 */ }
    });
    source.addEventListener("settings", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { settings: State["settings"]; ownerSub: string; ownerName?: string; ownerAvatar?: string };
        setState(current => current ? { ...current, settings: payload.settings, ownerSub: payload.ownerSub, ownerName: payload.ownerName, ownerAvatar: payload.ownerAvatar } : current);
        if (payload.settings?.title) onTitleChange(payload.settings.title);
        if (payload.settings) onGroupAvatarChange(payload.settings.cowork_avatar);
      } catch { /* 忽略坏帧 */ }
    });
    return () => { closedRef.current = true; source.close(); unsubscribePreview(); window.clearInterval(receiptPoll); document.removeEventListener("visibilitychange", onVisibility); };
    // sessionId is the transport boundary; model lists are used only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, sessionId, groupReady]);
  useEffect(() => {
    if (settingsOpen || !state?.settings) return;
    // 群设置未配置（cowork_model 为 NULL，如刚升级的人机聊天）时，回退继承升级前会话的
    // 框架/模型（initialMode/initialModel/initialCodexModel），避免落到列表首个模型（hy4 preview）。
    setMode(modes.includes(state.settings.cowork_mode) ? state.settings.cowork_mode : (initialMode && modes.includes(initialMode) ? initialMode : modes[0] || "codebuddy"));
    setModel(state.settings.cowork_model || (initialModel || "") || models[0]?.id || "");
    setCodexModel(state.settings.cowork_codex_model || (initialCodexModel || "") || codexModels[0]?.id || "");
  }, [settingsOpen, state?.settings?.cowork_mode, state?.settings?.cowork_model, state?.settings?.cowork_codex_model, models, codexModels, modes, initialMode, initialModel, initialCodexModel]);
  // 群聊判定：曾是群（coworkEverGroup，永不回退）或当前真人成员 ≥2；仅群聊提供 @所有人 提及
  const everGroupFlag = sessions.find((s) => s.id === sessionId)?.coworkEverGroup ?? false;
  const isGroupChat = everGroupFlag || members.length >= 2 || pendingMembers.length >= 2;
  // 设置面板标题：1:1 显示「会话设置」，群聊显示「群设置」
  const settingsLabel = isGroupChat ? "群设置" : "会话设置";
  // 首条消息发送前群尚未落库，服务端无法返回默认 AI；先用应用名展示候选。
  const pendingDefaultAgent = useMemo(() => !members.length && pendingMembers.length > 0 && !groupAgents.length
    ? [{ id: `${sessionId}:default`, name: title || ASSISTANT_NAME, avatar: "" }]
    : [], [members.length, pendingMembers.length, groupAgents.length, sessionId, title]);
  // @ 提及候选包含群 AI 和群成员；去重交给 hook。
  const mentionCandidates = useMemo(() => [
    ...(isGroupChat ? [{ id: "all", name: "所有人", avatar: "" }] : []),
    ...pendingDefaultAgent,
    ...(!pendingDefaultAgent.length && !groupAgents.some(agent => agent.enabled) ? [{ id: "agent", name: title || ASSISTANT_NAME, avatar: "" }] : []),
    ...groupAgents.filter(agent => agent.enabled).map(agent => ({ id: agent.id, name: agent.name, avatar: "" })),
    ...(state?.ownerSub && state.ownerSub !== selfSub ? [{ id: `owner:${state.ownerSub}`, name: state.ownerName || "发起人", avatar: state.ownerAvatar || "" }] : []),
    ...members.map(member => ({ id: member.contactId, name: member.name, avatar: member.avatar })),
    ...pendingMembers.map(member => ({ id: member.contactId, name: member.name, avatar: member.avatar })),
  ], [isGroupChat, pendingDefaultAgent, groupAgents, title, state?.ownerSub, state?.ownerName, state?.ownerAvatar, selfSub, members, pendingMembers]);
  // 输入框 @ 提及：识别光标处未闭合的 "@"，弹出候选列表，↑↓/Tab/回车/Esc 交互。
  const {
    visibleMentionOptions,
    mentionIndex,
    setMentionIndex,
    mentionRefs,
    chooseMention,
    onValueChange,
    onEnter,
    onKeyDownIntercept: onMentionKeyDown,
  } = useAtMention(composerRef, mentionCandidates);
  // 群聊输入框内容广播：右侧伴聊面板据此判断「用户有输入」（增强草稿时读当前文本）。
  // 同时把真实光标位置回传 useAtMention（@ 提及识别依赖光标处的上下文）——
  // 只传 value 不传光标（此前硬编码 0）会让 @ 弹列表永远无法出现。
  const handleComposerValue = useCallback((value: string, selectionStart?: number) => {
    onValueChange?.(value, selectionStart ?? value.length);
    window.dispatchEvent(new CustomEvent(COWORK_COMPOSER_TEXT_EVENT, { detail: { sessionId, text: value ?? "" } }));
  }, [onValueChange, sessionId]);
  const knownNames = [...pendingDefaultAgent.map(agent => agent.name), ...groupAgents.filter(agent => agent.enabled).map(agent => agent.name), ...(isGroupChat ? ["所有人"] : []), state?.ownerName || "", ...members.map(member => member.name), ...pendingMembers.map(member => member.name)].filter(Boolean);
  const mentionPattern = knownNames.length ? new RegExp(`(@(?:${knownNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")}))(?=$|[\\s，。！？?,.!:：])`, "gi") : null;
  // 群消息正文里的 @提及：仅用品牌色高亮，不加粗（用 span 而非 strong，避免继承粗体）
  const renderHuman = (content: string) => mentionPattern ? content.split(mentionPattern).map((part, index) => part.startsWith("@") && knownNames.some(name => part.slice(1).toLocaleLowerCase() === name.toLocaleLowerCase())
    ? <span key={index} className="cowork-mention">{part}</span> : part) : content;
  // 群聊用户消息：带 markdown 痕迹时走完整 Markdown 渲染（保留附件条/裸链接/预览卡/@提及），否则维持纯文本+链接化渲染。
  const renderUserText = (content: string) => looksLikeMarkdown(content)
    ? <CoworkMarkdownBubble text={content} mentionNames={knownNames} basePath={basePath} />
    : <UserBubble text={content} renderText={renderHuman} basePath={basePath} collapseThreshold={1000} />;

  // 语音输入：复用单聊同一套听写通道（/api/voice/*），识别结果回填到输入框。
  const dictationTranscriber = useMemo(() => voiceEnabled
    ? createDictationTranscriber({
        endpoint: `${basePath}/api/voice/transcribe`,
        fetchImpl: async (input, init) => {
          // 仅长按「松开发送」链路 persist 保存原始录音并取回 fileId；点按转写不保存。
          const persist = voiceSendPendingRef.current;
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
          const response = await apiFetch(`${basePath}/api/voice/token`, { method: "POST" });
          if (!response.ok) throw new Error("无法获取语音令牌");
          const data = await response.json() as { token?: string };
          return data.token ?? "";
        },
      })
    : null,
    [basePath, voiceEnabled]);
  const dictation = useVoiceDictation({
    transcribe: dictationTranscriber as unknown as VoiceTranscriber,
    hardStopMs: 10 * 60 * 1000,
    onTranscribed: (transcript: string) => {
      setRightCtrlRecording(false);
      const trimmed = (transcript || "").trim();
      setVoiceError("");
      if (voiceSendPendingRef.current) {
        // 长按「松开发送」：录音文件（fileId）+ 转写文字一起发出，对齐人机逻辑。
        voiceSendPendingRef.current = false;
        const voice = pendingVoiceRef.current;
        pendingVoiceRef.current = null;
        if (!voice?.fileId) {
          setVoiceError("录音未能保存，请重试");
          return;
        }
        if (sending) {
          setVoiceError("当前暂时无法发送，请稍后重录");
          return;
        }
        void sendRef.current(trimmed, undefined, undefined, 0, null, voice);
      } else if (trimmed) {
        composerRef.current?.appendText(trimmed);
      }
    },
    onError: (error: VoiceDictationError) => {
      setRightCtrlRecording(false);
      console.error("[voice-input] error", error);
      // 复位长按发送链路，避免失败后残留待发态
      voiceSendPendingRef.current = false;
      pendingVoiceRef.current = null;
      // 长按录制失败（权限拒绝/非安全上下文等）：复位长按态，避免提示条残留
      setHoldRecording(false);
      setHoldCancelArmed(false);
      setVoiceError(!window.isSecureContext && error?.kind === "unsupported"
        ? "当前局域网 HTTP 地址无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）"
        : error?.message || "语音输入暂时不可用");
    },
  });
  const recording = dictation.state === "recording";
  const transcribing = dictation.state === "transcribing";
  useEffect(() => { if (transcribing) setRightCtrlRecording(false); }, [transcribing]);
  const toggleVoiceInput = () => {
    if (dictation.state === "transcribing") {
      voiceSendPendingRef.current = false;
      pendingVoiceRef.current = null;
      dictation.cancel();
      return;
    }
    if (dictation.state === "recording") { dictation.stop(); return; }
    if (!window.isSecureContext) {
      setVoiceError("当前局域网 HTTP 地址无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）");
      return;
    }
    // 点按为普通语音转写（回填输入框），明确退出长按发送链路。
    voiceSendPendingRef.current = false;
    pendingVoiceRef.current = null;
    setVoiceError("");
    dictation.start();
  };

  // 点按进入/退出「按住说话」模式：进入时收起键盘、隐藏输入框；退出时复位录音链路并交还焦点。
  const toggleMobileVoiceMode = () => {
    switchMobileVoiceMode(mobileVoiceMode, (active) => {
      setMobileVoiceMode(active);
      saveMobileVoiceMode(active);
    }, dictation, () => {
      voiceSendPendingRef.current = false;
      pendingVoiceRef.current = null;
      setHoldRecording(false);
      setHoldCancelArmed(false);
    }, () => composerRef.current?.focus());
  };
  // 共享手势（useVoiceHold）：短按喇叭切模式，长按/大钮按住录音，移出取消、松开
  // 发送。录音 persist 与转写发送链路由本组件 onBegin/onFinish 接管。
  const { speakerDown, speakerClick, holdAreaDown } = useVoiceHold({
    dictation,
    onError: (msg) => setVoiceError(msg),
    onTap: toggleMobileVoiceMode,
    onIntent: (cancel) => {
      setHoldCancelArmed(cancel);
      dictation.setFinishIntent(cancel ? "cancel" : "send");
    },
    onBegin: (bounds, x, y) => {
      const cancelArmed = x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom;
      pendingVoiceRef.current = null;
      voiceStartedAtRef.current = Date.now();
      voiceSendPendingRef.current = true;
      dictation.setFinishIntent(cancelArmed ? "cancel" : "send");
      setHoldCancelArmed(cancelArmed);
      setHoldRecording(true);
      setVoiceError("");
      void dictation.start();
    },
    onFinish: (cancel) => {
      setHoldRecording(false);
      setHoldCancelArmed(false);
      if (cancel) {
        // 移出取消：丢弃录音，不进入发送链路。
        voiceSendPendingRef.current = false;
        pendingVoiceRef.current = null;
        dictation.cancel();
      } else {
        dictation.stop();
      }
    },
  });

  // 附件上传：复用单聊同一上传端点，上传成功后作为待发附件挂到输入框。
  // 选择文件与拖拽共用同一逻辑。
  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    setUploading(true); setVoiceError("");
    try {
      const uploaded = await Promise.all(files.map(async (file): Promise<UiAttachment> => {
        const form = new FormData();
        form.append("file", file);
        const response = await apiFetch(`${basePath}/api/upload?session=${encodeURIComponent(sessionId)}`, { method: "POST", body: form });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; url?: string; name?: string; size?: number; fileId?: string; error?: string };
        if (!response.ok || !data.ok) throw new Error(data.error || "上传失败");
        return { url: data.url!, name: data.name ?? file.name, size: data.size ?? file.size, fileId: data.fileId, previewUrl: isImageFile({ file }) ? URL.createObjectURL(file) : undefined };
      }));
      setAttachments(current => [...current, ...uploaded]);
      // 选完文件通常紧接着就要提问：把焦点交还输入框，PC / 移动端都直接可继续键入。
      composerRef.current?.focus();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "上传失败"); }
    finally { setUploading(false); }
  };
  const addRecentScreenshot = async () => {
    if (!recentScreenshot || uploading) return;
    const notice = recentScreenshot;
    setRecentScreenshot(null);
    const desktop = (window as unknown as { agentHost?: { screenshots?: {
      read(id: string): Promise<{ name: string; bytes: Uint8Array } | null>;
    } } }).agentHost;
    const image = await desktop?.screenshots?.read(notice.id);
    if (!image) return;
    const type = /\.jpe?g$/i.test(image.name) ? "image/jpeg" : /\.webp$/i.test(image.name) ? "image/webp" : "image/png";
    await uploadFiles([new File([new Uint8Array(image.bytes)], image.name, { type })]);
  };
  const onPickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    await uploadFiles(files);
  };
  const clearAttachment = (index: number) => {
    setAttachments(current => {
      const next = current.slice();
      const [removed] = next.splice(index, 1);
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  };

  const send = async (content?: string, retry?: PendingMessage, filesOverride?: UiAttachment[], batchIndex = 0, replyOverride?: number | null, voice?: UiVoiceRecording) => {
    if (historyOnly) { setError("群聊服务尚未启用，暂时无法发送消息"); return; }
    const message = (retry?.content ?? content ?? "").trim();
    const pending = retry?.attachments ?? filesOverride ?? attachments;
    if (!retry && !filesOverride && pending.length > 1) {
      for (const [index, file] of pending.entries()) await send("", undefined, [file], index);
      if (message) await send(message, undefined, [], pending.length);
      return;
    }
    if ((!message && !pending.length && !voice) || sending) return;
    if (!retry) onMessageSubmitted?.();
    if (!isDesktopApp() && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission().then(permission => { if (permission === "granted") void ensureWebPushSubscription(basePath); }).catch(() => {});
    }
    // 发送后跟随底部：让刚发的消息立即可见（to bottom）。
    markSend();
    const localId = retry?.localId ?? crypto.randomUUID();
    const firstGroupMessage = batchIndex === 0 && pendingMembers.length > 0 && members.length === 0;
    const shouldAutoTitle = false;
    const optimistic: PendingMessage = retry ?? { localId, content: message, attachments: pending, voice, replyToId: batchIndex === 0 ? (replyOverride !== undefined ? replyOverride : replyToId) : null, createdAt: new Date().toISOString(), status: "sending", autoTitle: shouldAutoTitle };
    if (retry) setPendingMessages(current => current.map(item => item.localId === localId ? { ...item, status: "sending", error: undefined } : item));
    else { setPendingMessages(current => [...current, optimistic]); setAttachments([]); setReplyToId(null); }
    if (!retry) saveChatDraft(sessionId, "", [], { replyToId: null });
    setSending(true); setError("");
    const slowTimer = window.setTimeout(() => setPendingMessages(current => current.map(item => item.localId === localId && item.status === "sending" ? { ...item, status: "slow" } : item)), 5000);
    try {
      if (batchIndex === 0 && pendingMembers.length && !members.length) {
        const registered = await apiFetch(`${basePath}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, title: sessionTitle || "新群聊", contactIds: pendingMembers.map(member => member.contactId) }) });
        if (!registered.ok) throw new Error("创建会话失败");
        const data = await registered.json() as { members?: Member[] };
        const initialMode = modes.includes(mode) ? mode : modes[0] || "codebuddy";
        await realtimeClient(basePath).request(sessionId, "settings", { mode: initialMode, model: model || models[0]?.id || "",
          codexModel: codexModel || codexModels[0]?.id || "" });
        onStarted(data.members ?? pendingMembers.map(member => ({ provider: member.provider ?? "", contactId: member.contactId, name: member.name, avatar: member.avatar })));
      }
      // 注册能力的逐轮上下文（报销格式/当前草稿等）随发送上报，服务端追加到慢思考 system，与单聊对齐。
      // state 尚未 append 刚发的消息，这里手动补一条当前用户消息，保证 buildContext 能读到本轮文字与附件。
      const outgoing: CapMessage = {
        role: "user",
        content: message,
        attachments: pending.map(item => ({ url: item.url, name: item.name, fileId: item.fileId, size: item.size })),
      };
      const capContext = buildCapabilitiesContext(capabilities, {
        sessionId,
        messages: [...toCapMessages(stateRef.current?.messages ?? []), outgoing],
        channel: "cowork",
      });
      const referenceContext = composerReferences.map(({ sourceId, reference }) => `[引用: ${sourceId}/${reference.id} · ${reference.label}]\n${reference.context}`).join("\n\n");
      await realtimeClient(basePath).request(sessionId, "send", { content: message, title, clientMessageId: localId, replyToId: optimistic.replyToId ?? null,
        voice: voice ?? null,
        context: [capContext, referenceContext].filter(Boolean).join("\n\n") || undefined,
        attachments: pending.map(item => ({ url: item.url, name: item.name, fileId: item.fileId, size: item.size })) });
      if (optimistic.autoTitle) {
        const quick = quickSessionTitle(message);
        if (quick) onTitleChange(quick);
        // 与人机聊天复用同一个标题总结接口；群消息已经落库，标题生成不阻塞消息发送。
        void apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/auto-title`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userMessage: message, agentMode: mode === "codex" ? "codex" : "codebuddy", model: model || models[0]?.id, codexModelKey: codexModel || codexModels[0]?.id }),
        }).then(async result => {
          if (!result.ok) return;
          const data = await result.json().catch(() => null) as { title?: string } | null;
          if (data?.title) onTitleChange(data.title);
        }).catch(() => {});
      }
      setPendingMessages(current => current.map(item => item.localId === localId ? { ...item, status: "accepted" } : item));
      await refresh();
      if (initialSubmission) onSubmissionConsumed();
      composerRef.current?.focus();
    } catch (cause) {
      const messageError = cause instanceof Error ? cause.message : "发送失败";
      setPendingMessages(current => current.map(item => item.localId === localId ? { ...item, status: "failed", error: messageError } : item));
    }
    finally { window.clearTimeout(slowTimer); setSending(false); }
  };
  // 伴聊自动回复：右侧面板派发「建议完成」事件后，代表用户把最终建议的纯文本直接发送到群里。
  // 仅当触发消息仍存在且未被撤回时附加引用（replyTo），不携带 JSON 原始答案。
  const sendingRef = useRef(false);
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const autoSend = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; text: string; messageId?: number | null }>).detail;
      if (detail?.sessionId !== sessionId || !detail.text?.trim()) return;
      void (async () => {
        for (let attempt = 0; attempt < 10 && sendingRef.current; attempt++) await new Promise(resolve => setTimeout(resolve, 500));
        if (sendingRef.current) return;
        let replyTo: number | null = null;
        if (detail.messageId != null) {
          const trigger = stateRef.current?.messages.find(message => message.id === detail.messageId);
          if (trigger && !trigger.revokedAt) replyTo = detail.messageId;
        }
        await sendRef.current(detail.text, undefined, undefined, 0, replyTo);
      })();
    };
    window.addEventListener(CHATMATE_AUTO_SEND_EVENT, autoSend);
    return () => window.removeEventListener(CHATMATE_AUTO_SEND_EVENT, autoSend);
  }, [sessionId]);
  const initialSent = useRef(false);
  useEffect(() => {
    if (!initialSubmission || initialSent.current) return;
    initialSent.current = true;
    void send(initialSubmission.text);
    // 首条消息只在群聊面板首次挂载时提交一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const copyMessage = async (id: number, content: string) => {
    if (!await copyTextToClipboard(content)) return;
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(current => current === id ? null : current), 1800);
  };
  const revokeMessage = async (id: number) => {
    try {
      const response = await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(sessionId)}/revoke`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageId: id }),
      });
      if (!response.ok) throw new Error("消息撤回失败，请重试");
      const data = await response.json() as { revokedAt: string };
      setState(current => current ? { ...current, messages: current.messages.map(message => message.id === id
        ? { ...message, content: "", attachment: null, revokedAt: data.revokedAt } : message) } : current);
      // 同步主窗口的 rt.messages：右栏「输入文件」聚合自主窗口消息历史，
      // 只更新本面板会让已撤回消息的附件残留在输入文件列表（见 COWORK_MESSAGE_REVOKED_EVENT）。
      window.dispatchEvent(new CustomEvent(COWORK_MESSAGE_REVOKED_EVENT, {
        detail: { sessionId, messageId: id, revokedAt: data.revokedAt },
      }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "消息撤回失败，请重试"); }
  };
  const rememberEmoji = (emoji: string) => setRecentEmojis(current => {
    const next = [emoji, ...current.filter(item => item !== emoji)].slice(0, 10);
    localStorage.setItem("cowork-recent-emojis", JSON.stringify(next));
    return next;
  });
  const chooseEmoji = async (emoji: string, selectedTarget?: "composer" | number) => {
    const target = selectedTarget ?? emojiPicker;
    setEmojiPicker(null);
    rememberEmoji(emoji);
    if (target === "composer") { composerRef.current?.appendText(emoji); composerRef.current?.focus(); return; }
    if (typeof target === "number") {
      try { await realtimeClient(basePath).request(sessionId, "reaction", { messageId: target, emoji, title }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "表情发送失败"); }
    }
  };
  const openEmojiPicker = (target: "composer" | number, element: HTMLElement) => {
    setEmojiAnchor(element);
    setEmojiPicker(target);
  };
  const emojiGrid = (target: "composer" | number) => <EmojiPopup anchor={emojiAnchor} open={emojiPicker !== null} onDismiss={() => setEmojiPicker(null)}>
    <div className="cowork-emoji-heading">{t("recentEmoji")}</div><div className="cowork-emoji-grid">{(recentEmojis.length ? recentEmojis : GROUP_EMOJIS.slice(0, 5)).map(emoji => <button key={`recent-${emoji}`} type="button" title={emoji} onClick={() => void chooseEmoji(emoji, target)}>{emoji}</button>)}</div>
    <div className="cowork-emoji-heading">{t("defaultEmoji")}</div><div className="cowork-emoji-grid">{GROUP_EMOJIS.map(emoji => <button key={`${target}-${emoji}`} type="button" title={emoji} onClick={() => void chooseEmoji(emoji, target)}>{emoji}</button>)}</div>
  </EmojiPopup>;
  // 点击表情浮层之外的任意区域，或按 Esc：关闭浮层（点表情按钮本身/浮层内不触发，由各自的 onClick 处理）
  useClickOutside({
    enabled: emojiPicker != null,
    exceptSelectors: [".cowork-emoji-anchor", ".cowork-composer-emoji-anchor", ".cowork-emoji-popup"],
    onDismiss: () => setEmojiPicker(null),
  });
  const openSettings = () => {
    setGroupTitle(sessionTitle || "群聊");
    setGroupAvatar(state?.settings?.cowork_avatar || "");
    setSettingsError("");
    setMemberQuery("");
    setSelectedMembers(new Set());
    lastPersistedTitle.current = sessionTitle || "群聊";
    setSettingsOpen(true);
  };
  /** 群名称保存：不再实时/防抖写库，仅在回车或输入框失焦（blur）时提交一次；
   *  打开面板/切会话时 groupTitle 初始值 = 服务端 sessionTitle，与上次保存一致时跳过。 */
  const commitGroupTitle = () => {
    if (lastPersistedTitle.current === groupTitle) return;
    if (!canPersist) return;
    // 打开面板/切会话时 groupTitle = 服务端 sessionTitle，标题未被用户改动，不发起写库；
    // 否则服务端 settings 保存会无条件 updated_at=now()，把会话幽灵刷新到列表顶部（"刚刚"）。
    if (groupTitle.trim() === sessionTitle) {
      lastPersistedTitle.current = groupTitle;
      return;
    }
    const titleValue = groupTitle.trim();
    if (!titleValue && (effectiveMembers.length > 1 || everGroup)) { setSettingsError("群名称不能为空"); return; }
    lastPersistedTitle.current = groupTitle;
    void persistSettings({ title: titleValue, ...((effectiveMembers.length > 1 || everGroup) ? { avatar: groupAvatar } : {}) });
  };
  const uploadGroupAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setSettingsError("请选择图片文件"); return; }
    setGroupAvatarUploading(true); setSettingsError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await apiFetch(`${basePath}/api/upload?session=${encodeURIComponent(sessionId)}`, { method: "POST", body: form });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
      if (!response.ok || !data.ok || !data.url) throw new Error(data.error || "上传群头像失败");
      setGroupAvatar(data.url);
      // 上传成功后立即落库，避免“选了图但忘了点保存”导致图标不生效。
      await persistGroupAvatar(data.url);
    } catch (cause) { setSettingsError(cause instanceof Error ? cause.message : "上传群头像失败"); }
    finally { setGroupAvatarUploading(false); }
  };
  const persistGroupAvatar = async (url: string) => {
    setSettingsSaving(true); setSettingsError("");
    try {
      const data = await realtimeClient(basePath).request(sessionId, "settings", { avatar: url }) as { avatar?: string; error?: string };
      onGroupAvatarChange(data.avatar ?? url);
    } catch (cause) { setSettingsError(cause instanceof Error ? cause.message : "保存群头像失败"); }
    finally { setSettingsSaving(false); }
  };
  /** 设置即时保存：改动即落库。新建群空态（会话尚未创建）时跳过请求。 */
  const canPersist = !(pendingMembers.length && !members.length);
  const persistSettings = async (patch: Record<string, unknown>) => {
    if (!canPersist) return;
    setSettingsSaving(true); setSettingsError("");
    try {
      const data = await realtimeClient(basePath).request(sessionId, "settings", patch) as { title?: string; avatar?: string; error?: string };
      if (data.error) { setSettingsError(data.error); return; }
      if (typeof data.title === "string") onTitleChange(data.title);
      if (typeof data.avatar === "string") onGroupAvatarChange(data.avatar);
      void refresh();
    } catch (cause) { setSettingsError(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSettingsSaving(false); }
  };
  /** 群主（发起人）；1v1 双方天然为管理角色。 */
  const isOwner = state?.ownerSub === selfSub;
  const adminRoster = state?.adminRoster ?? [];
  const isAdminInGroup = Boolean(state?.isAdmin);
  /** 管理角色：群主、群主任命的管理员、1v1 双方，或建群待入队状态的发起人。 */
  const isAdminRole = pendingMembers.length > 0 || isOwner || !!state?.isTwoPerson || isAdminInGroup;
  /** 可配置群设置（群名/头像/框架/模型/群AI）：群主与管理员。 */
  const canConfigure = isAdminRole;
  /** 成员管理（邀请/移除）：群主与管理员；管理员不能移除群主/其他管理员/自己（后端兜底）。 */
  const canManageMembers = isAdminRole;
  /** 自我会话：参与者只有自己一个真人（如误把自己拉进 1v1）。此时没有「对方」，消息一律靠左。 */
  // 曾是/已是群聊（≥2 真人成员过）：永不回退成单聊/自我聊天形态
  const everGroup = sessions.find((s) => s.id === sessionId)?.coworkEverGroup ?? false;
  const selfChat = !everGroup && (state?.participantReads ?? []).length === 1 && (state?.participantReads ?? [])[0]?.userSub === selfSub;
  /** 群危险操作：退出群组（非创建者）/ 解散群组（创建者）。成功后通知宿主关闭会话并刷新列表。 */
  const runGroupAction = async (kind: "leave" | "dissolve" | "delete") => {
    setGroupActionBusy(true);
    try {
      const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}${kind === "leave" ? "/leave" : ""}`, {
        method: kind === "leave" ? "POST" : "DELETE",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        setSettingsError(data?.error === "owner_cannot_leave" ? "群发起人不能退出，请解散群组。"
          : data?.error === "forbidden" ? "只有群发起人或单聊中的另一方才能解散群组。"
          : data?.error === "not_a_member" ? "你已不在该群聊中。"
          : data?.error === "not_a_group" ? "该会话不是群聊。"
          : "操作失败，请稍后重试。");
        setGroupAction(null);
        return;
      }
      setGroupAction(null);
      setSettingsOpen(false);
      onSessionEnded?.(kind);
    } catch {
      setSettingsError("操作失败，请检查网络后重试。");
      setGroupAction(null);
    } finally {
      setGroupActionBusy(false);
    }
  };
  /** 群主批量移除成员：确认后调 /members/remove，成功后本地过滤成员并刷新列表（系统消息随实时推送出现） */
  const runRemoveMembers = async () => {
    const ids = [...selectedMembers];
    if (!ids.length) { setRemoveConfirmOpen(false); return; }
    setRemovingBusy(true);
    try {
      const response = await apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/members/remove`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: ids }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        setSettingsError(data?.error === "forbidden" ? "群主和管理员才能移除成员，且不能移除群主或其他管理员。"
          : data?.error === "member_not_found" ? "部分成员已不在群聊中。"
          : data?.error === "not_a_group" ? "该会话不是群聊。"
          : "移除失败，请稍后重试。");
        setRemoveConfirmOpen(false);
        return;
      }
      setLocalMembersOverride(effectiveMembers.filter(member => !ids.includes(member.contactId)));
      setSelectedMembers(new Set());
      setRemoveConfirmOpen(false);
      onMembersRemoved?.(ids);
      void onForwarded?.();
    } catch {
      setSettingsError("移除失败，请检查网络后重试。");
      setRemoveConfirmOpen(false);
    } finally {
      setRemovingBusy(false);
    }
  };
  /** 群主任免管理员：POST/DELETE /cowork/:id/admins（按成员快照，未登录亦可任命），成功后刷新。 */
  const [adminBusy, setAdminBusy] = useState(false);
  const toggleAdmin = async (member: { provider: string; contactId: string; name: string; avatar: string }, makeAdmin: boolean) => {
    if (!member.provider || !member.contactId || adminBusy) return;
    setAdminBusy(true);
    setSettingsError("");
    try {
      const response = await apiFetch(`${basePath}/api/cowork/${encodeURIComponent(sessionId)}/admins`, {
        method: makeAdmin ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(makeAdmin
          ? { provider: member.provider, contactId: member.contactId, name: member.name, avatar: member.avatar }
          : { provider: member.provider, contactId: member.contactId }),
      });
      const data = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        setSettingsError(data?.error === "not_a_member" ? "该成员不在群聊中。"
          : data?.error === "owner_only" ? "只有群主才能任免管理员。"
          : "操作失败，请稍后重试。");
        return;
      }
      await refresh();
      window.dispatchEvent(new CustomEvent("cowork-agents-changed", { detail: { sessionId } }));
    } catch {
      setSettingsError("操作失败，请检查网络后重试。");
    } finally {
      setAdminBusy(false);
    }
  };
  // 仅一名真人成员（不含 AI）且该会话从未成群时，左上角直接展示该成员头像与姓名，不再显示「N 人」。
  // 曾是群聊的会话即使成员只剩 1 人，也保持群聊形态（显示群名/N 人），不回退成 1v1。
  /** 仅群聊（曾是群或当前 ≥2 真人成员）才提供「移除成员」；1v1 会话不显示 */
  const canRemoveMembers = canManageMembers && (everGroup || effectiveMembers.length >= 2);
  // 群设置成员行：群主（state.ownerSub）置顶，再接已加入成员；管理员按快照 provider+contactId 匹配 adminRoster。
  const settingsRows = useMemo(() => {
    const rows: Array<{ key: string; provider?: string; contactId?: string; name: string; avatar: string; role: "owner" | "admin" | "member" }> = [];
    if (state?.ownerSub) {
      rows.push({ key: `owner:${state.ownerSub}`, name: state.ownerName || "发起人", avatar: state.ownerAvatar || "", role: "owner" });
    }
    const isAdminRow = (member: Member) => adminRoster.some(a => a.provider === member.provider && a.contactId === member.contactId);
    for (const member of effectiveMembers) {
      if (state?.ownerSub && member.sub === state.ownerSub) continue;
      const role = isAdminRow(member) ? "admin" : "member";
      rows.push({ key: member.contactId, provider: member.provider, contactId: member.contactId, name: member.name, avatar: member.avatar, role });
    }
    return rows;
  }, [effectiveMembers, state?.ownerSub, state?.ownerName, state?.ownerAvatar, adminRoster]);
  const peopleCount = effectiveMembers.length || pendingMembers.length;
  const singleMember = !everGroup && peopleCount === 1 ? (effectiveMembers[0] ?? pendingMembers[0]) : null;
  const humanChatTitle = singleMember?.name || state?.settings?.title || sessionTitle || "群聊";
  // 与单聊共用同一套 .chat-main 容器（含 .chat-single-body > .chat-split-primary > .chat-body
  // 以及兄弟节点 .chat-main-inner）：宽度/滚动条逻辑完全由基础 CSS 决定，避免两份实现漂移。
  return <div className="cowork-panel chat-main"
    onDragOver={(event) => {
      // 拖文件到消息列表/输入框区域：与人机聊天一致，松开即加入附件
      if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer!.dropEffect = "copy";
      setDragOver(true);
    }}
    onDragLeave={(event) => {
      // 仅当真正离开面板时才取消高亮（子元素间移动不触发闪烁）
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setDragOver(false);
    }}
    onDrop={(event) => {
      if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      setDragOver(false);
      if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
        setError("Web 暂不支持添加文件夹，请选择单个文件上传");
        return;
      }
      void uploadFiles(Array.from(event.dataTransfer?.files ?? []));
    }}
  >
    {dragOver ? <div className="chat-drop-overlay"></div> : null}
    {emojiGrid(emojiPicker ?? "composer")}
    {forwardMessage || forwardSelected ? <ForwardMessageDialog basePath={basePath} sourceSessionId={sessionId}
      messageIds={forwardSelected ? [...selectedIds].sort((a, b) => a - b) : [forwardMessage!.id]}
      forwardMode={forwardSelected ? selectedForwardMode : undefined}
      preview={forwardSelected ? `已选择 ${selectedIds.size} 条消息` : quotedContent(forwardMessage!)} sessions={sessions}
      onClose={() => { setForwardMessage(null); setForwardSelected(false); }} onForwarded={() => { onForwarded(); setMultiSelect(false); setSelectedIds(new Set()); }} /> : null}
    {renderToolbar ? renderToolbar({ open: settingsOpen, label: settingsLabel, title: humanChatTitle, toggle: () => (settingsOpen ? setSettingsOpen(false) : openSettings()) }) : <header className="chat-topbar cowork-topbar">
      <div className="chat-topbar-left">
        {/* 移动端详情态返回箭头（复用 .chat-mobile-home-back，仅 has-mobile-conversation 显示），与人机聊天一致 */}
        <button type="button" className="chat-mobile-home-back"
          onClick={onBack ?? onSidebar} aria-label={t("backConversations")} title={t("backConversations")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m14 5-7 7 7 7" />
          </svg>
        </button>
        <button type="button" className="chat-sidebar-toggle" onClick={onSidebar} aria-label={t("conversationList")} title={t("conversationList")}>
          <ChatPanelGlyph01 />
        </button>
        {singleMember ? (
          <>
            <span className="cowork-group-avatar" aria-hidden="true">
              {singleMember.avatar ? <img src={singleMember.avatar} alt="" /> : (singleMember.name || "群").trim().slice(0, 1) || "群"}
            </span>
            <span className="chat-title chat-title--left" title={singleMember.name}>{singleMember.name}</span>
          </>
        ) : (
          <>
            <span className="cowork-group-avatar" aria-hidden="true">{state?.settings?.cowork_avatar ? <img src={`${basePath}${state.settings.cowork_avatar}`} alt="" /> : <GroupAvatarIcon />}</span>
            <span className="chat-title chat-title--left" title={humanChatTitle}>{humanChatTitle}</span>
            <span className="cowork-count">{peopleCount} 人</span>
          </>
        )}
      </div>
      <div className="chat-topbar-right">
        {/* 顶部加人钮仅「新建对话空态」显示；进入聊天详情后去掉，成员管理统一在群设置里 */}
        {isNewGroupSeed && canManageMembers ? (
          <button type="button" className="chat-topbar-btn chat-invite-trigger" onClick={onInvite} aria-label={t("addMembers")} title={t("addMembers")}>
            <AddUserIcon />
          </button>
        ) : null}
        {/* 移动端：顶栏只留一个「更多」，设置/产物/Chatmate/独白收进 popup；
            PC：保留设置钮与右侧边栏开关。 */}
        {isMobileLayout ? (
          <>
            <button
              type="button"
              className={`chat-topbar-btn chat-topbar-mobile-more${coworkMoreOpen ? " is-active" : ""}`}
              onClick={() => setCoworkMoreOpen(o => !o)}
              aria-label={t("more")}
              aria-haspopup="menu"
              aria-expanded={coworkMoreOpen}
              title={t("more")}
            >
              <MoreIcon />
            </button>
            {coworkMoreOpen ? (
              <>
                <div className="chat-panel-backdrop" onClick={() => setCoworkMoreOpen(false)} />
                <div className="chat-topbar-more" role="menu" aria-label={t("moreActions")}>
                  <button type="button" role="menuitem" onClick={() => { setCoworkMoreOpen(false); openSettings(); onRightPanel("settings"); }}>{t("settings")}</button>
                  <button type="button" role="menuitem" onClick={() => { setCoworkMoreOpen(false); onRightPanel("artifacts"); }}>{t("viewArtifacts")}</button>
                  <button type="button" role="menuitem" onClick={() => { setCoworkMoreOpen(false); onRightPanel("chatmate"); }}>{t("chatmate")}</button>
                  <button type="button" role="menuitem" onClick={() => { setCoworkMoreOpen(false); onRightPanel("monologue"); }}>{t("groupAi")}</button>
                </div>
              </>
            ) : null}
          </>
        ) : (
          <>
            <button type="button" className={`chat-topbar-btn${settingsOpen ? " is-active" : ""}`} onClick={() => (settingsOpen ? setSettingsOpen(false) : openSettings())} aria-expanded={settingsOpen} aria-label={settingsLabel} title={settingsLabel}>
              <SettingsIcon />
            </button>
            <button type="button" className="chat-sidebar-toggle" onClick={() => onRightPanel()} aria-label={t("expandRight")} aria-expanded={rightShown} title={t("expandRight")}><ChatPanelGlyph08 /></button>
          </>
        )}
      </div>
    </header>}
    <div className="chat-single-body">
      <div className="chat-split-primary">
      <div className={`chat-body${holdRecording ? " is-hold-recording" : ""}${!state && !pendingMembers.length && !loadError ? " is-loading" : ""}`} ref={bindBodyRef}>
        <div className="chat-body-inner">
          {state && loadError ? <p className="cowork-loading" role="status">{loadError}</p> : null}
          {/* 群消息加载：1s 内不显示任何 loading，超时才显示页面居中转圈（无文字） */}
          {!state && !pendingMembers.length ? (loadError ? <p className="cowork-loading" role="status">{loadError}</p> : <SlowPageSpinner />) : null}
          {state?.messages.map((message, index) => {
            if (message.role === "reaction") return null;
            const previousAt = state.messages[index - 1]?.createdAt;
            const marker = shouldShowTimeMarker(message.createdAt, previousAt) ? <TimeMarker at={message.createdAt!} /> : null;
            // 自我会话（成员只有自己一个真人）：没有「对方」，所有消息一律靠左展示，不区分 own/peer。
            // 升级前的人机聊天消息 sender_sub 为 NULL（服务端按「会话所有者」解析发送者姓名/头像）；
            // 当前查看者是会话所有者时，这些升级前的消息也归入 own（右侧），其他人查看时仍按对方消息靠左。
            const own = !selfChat && (message.senderSub === selfSub || (message.senderSub == null && state?.ownerSub === selfSub));
            if (message.role === "system") {
              // 系统消息 content 自带完整句子（「邀请了xx进入群聊」「xx 已退出群聊」）。
              // 旧消息可能以「成员」开头；按当前身份替换前缀，不能拼出「你成员」。
              const systemSender = senderDisplayName(message);
              const prefix = message.content.startsWith(systemSender) ? systemSender : message.content.startsWith("成员 ") ? "成员" : "";
              const notice = prefix ? own ? `你${message.content.slice(prefix.length).trimStart()}` : `${systemSender}${message.content.slice(prefix.length)}`
                : message.content.startsWith("你") ? message.content : `${own ? "你" : systemSender}${message.content}`;
              return <Fragment key={message.id}>{marker}<div className="cowork-system-notice" role="status">{notice}</div></Fragment>;
            }
            if (message.revokedAt) return <Fragment key={message.id}>{marker}<div className="cowork-revoked-notice" role="status">
              {own ? "你撤回了一条消息" : `${message.senderName || "成员"}撤回了一条消息`}
            </div></Fragment>;
            const replyTarget = message.replyToId ? state.messages.find(item => item.id === message.replyToId) : undefined;
            const replyCount = state.messages.filter(item => item.role === "user" && item.replyToId === message.id && !item.revokedAt).length;
            const isAssistant = message.role === "assistant";
            const recipients = (state.participantReads ?? []).filter(person => person.userSub !== selfSub && (!person.addedAt || !message.createdAt || new Date(person.addedAt).getTime() <= new Date(message.createdAt).getTime()));
            const readCount = recipients.filter(person => Number(person.throughId) >= message.id).length;
            const allRead = recipients.length > 0 && readCount === recipients.length;
            const readStatus = own && recipients.length ? (singleMember ?
              <span className="cowork-read-label" aria-label={allRead ? "已读" : "未读"}>{allRead ? "已读" : "未读"}</span> :
              <button type="button" className={`cowork-read-pie${allRead ? " is-all-read" : readCount === 0 ? " is-empty" : ""}`} style={allRead ? undefined : { "--read-angle": `${readCount / recipients.length * 360}deg` } as CSSProperties}
                title={`${readCount} 人已读，${recipients.length - readCount} 人未读`} aria-label={`查看已读详情，${readCount} 人已读，${recipients.length - readCount} 人未读`}
                onClick={() => void apiFetch(`${basePath}/api/sessions/${encodeURIComponent(sessionId)}/readers?messageId=${message.id}`)
                  .then(response => response.ok ? response.json() : null)
                  .then(data => { if (data?.people) setReadDetails({ messageId: message.id, people: data.people as Reader[] }); })}>
                {allRead ? "全部已读" : <span className="cowork-read-pie-mark" aria-hidden="true" />}
              </button>) : null;
            const grouped = GROUP_EMOJIS.filter(emoji => state.reactions.some(reaction => Number(reaction.message_id) === message.id && reaction.emoji === emoji)).map(emoji => ({ emoji, people: state.reactions.filter(reaction => Number(reaction.message_id) === message.id && reaction.emoji === emoji) }));
            const reactionBar = grouped.length ? <div className="cowork-reaction-bar">{grouped.map(({ emoji, people }) => {
              const names = people.map(person => person.user_sub === "agent" ? title : person.user_sub.startsWith("agent:")
                ? (groupAgents.find(agent => `agent:${agent.id}` === person.user_sub)?.name || person.user_name || "群 AI")
                : (person.user_name || "成员")).join("、");
              return <button key={emoji} type="button" className={people.some(person => person.user_sub === selfSub) ? "is-active" : ""} aria-label={`${emoji}，${names}`} onClick={() => void chooseEmoji(emoji, message.id)}><span className="cowork-reaction-emoji">{emoji}</span><span className="cowork-reaction-divider" aria-hidden="true">|</span><span className="cowork-reaction-names">{names}</span></button>;
            })}</div> : null;
            const actions = <div className="cowork-message-menu"><div className="cowork-emoji-anchor"><button type="button" aria-label={t("likeEmoji")} onMouseEnter={event => {
              if (holdRecording) return;
              cancelEmojiHover();
              const button = event.currentTarget;
              emojiHoverTimer.current = setTimeout(() => openEmojiPicker(message.id, button), 180);
            }} onMouseLeave={cancelEmojiHover} onClick={() => {
              cancelEmojiHover();
              setEmojiPicker(null);
              setDismissedMenuId(message.id);
              if (!state.reactions.some(reaction => Number(reaction.message_id) === message.id && reaction.user_sub === selfSub && reaction.emoji === "👍")) void chooseEmoji("👍", message.id);
            }}><FeedbackVoteIcon vote="up" selected /></button></div><button type="button" className="msg-menu-tip msg-reply-button" data-tooltip={t("reply")} aria-label={t("replyMessage")} onClick={() => { setReplyToId(message.id); composerRef.current?.focus(); }}><ReplyBubbleIcon /></button></div>;
            if (isAssistant) {
              // 与一人对话一致：答复底部（msg-footer 上方）显示本消息的产物操作（查看产出物 / 查看变更）
              const msgArtifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
              const addedCount = msgArtifacts.filter(artifact => artifact.change === "added" || !artifact.change).length;
              const changeCount = msgArtifacts.filter(artifact => artifact.change === "modified" || artifact.change === "deleted").length;
              const firstChangeId = msgArtifacts.find(artifact => artifact.change === "modified" || artifact.change === "deleted")?.id ?? "";
              const artifactActions = addedCount === 0 && changeCount === 0 ? null : (
                <div className="artifact-viewall-row">
                  {addedCount > 0 ? <button type="button" className="artifact-viewall" onClick={() => window.dispatchEvent(new CustomEvent(AGENT_OPEN_ARTIFACTS_EVENT, { detail: { sessionId } }))} title={t("artifactsHintGroup")}>{t("viewArtifactsCount", { count: addedCount })}</button> : null}
                  {changeCount > 0 ? <button type="button" className="artifact-viewall" onClick={() => window.dispatchEvent(new CustomEvent(AGENT_OPEN_DIFF_EVENT, { detail: { sessionId, activeId: firstChangeId, changes: msgArtifacts } }))} title={t("changesHintGroup")}>{t("viewChangesCount", { count: changeCount })}</button> : null}
                </div>
              );
              return <Fragment key={message.id}>{marker}<div className={`cowork-ai-message${multiSelect ? " is-selecting" : ""}${jumpHighlightId === message.id ? " is-jump-hit" : ""}`}>
                {multiSelect ? <input type="checkbox" className="cowork-select-check" checked={selectedIds.has(message.id)} onChange={() => toggleSelected(message.id)} aria-label={t("selectAgentMessage")} /> : null}<div className="msg bot" data-msg-index={index}>
                <div className="cowork-ai-sender">{message.senderName || title}</div>
                <AiResponse scene="group" steps={message.steps} elapsedSecs={message.elapsedSecs} running={false} mode={state.settings?.cowork_mode} basePath={basePath} content={message.content} mentions={knownNames}
                  afterAnswer={artifactActions}
                  footer={{ feedback: { basePath, sessionId, messageId: message.id, answer: message.content,
                    vote: msgVotes[message.id] ?? null,
                    onVote: vote => setMsgVotes(current => ({ ...current, [message.id]: vote })),
                  } }} />
              </div>{reactionBar}</div></Fragment>;
            }
            const senderName = senderDisplayName(message);
            const atts = Array.isArray(message.attachment) ? message.attachment : message.attachment ? [message.attachment] : [];
            const displayContent = atts.length ? stripAttachmentLine(message.content) : message.content;
            const hasFileMessage = atts.some(file => !isImageFile(file) && !isVideoFile(file) && !isAudioFile(file));
            const fileMessageClass = hasFileMessage ? ` bubble--file-message${message.content.trim().length > 90 ? " bubble--file-message-wide" : ""}` : "";
            return <Fragment key={message.id}>{marker}<div className={`chat-message-row${jumpHighlightId === message.id ? " is-jump-hit" : ""}`}><HumanMessage own={own} showAvatar avatar={message.senderAvatar} senderName={senderName} messageIndex={index}
              selection={multiSelect ? { checked: selectedIds.has(message.id), onChange: () => toggleSelected(message.id), label: `选择${senderName}的消息` } : undefined}
              className={`${emojiPicker === message.id || moreMenuId === message.id ? " has-active-menu" : ""}${dismissedMenuId === message.id ? " has-dismissed-menu" : ""}${multiSelect ? " is-selecting" : ""}${selectedIds.has(message.id) ? " is-selected" : ""}`}
              onPointerEnter={() => { if (dismissedMenuId === message.id) setDismissedMenuId(null); }}
              onActionsMouseLeave={event => {
                // 表情浮层打开时，鼠标移出消息操作菜单（且未进入浮层本身）即关闭浮层
                if (emojiPicker !== message.id) return;
                const next = event.relatedTarget as HTMLElement | null;
                if (next && next.closest(".cowork-emoji-popup")) return;
                setEmojiPicker(null);
              }}
              showName={!singleMember && !own}
              bubble={<div className={`bubble${message.voice ? " bubble--voice" : ""}${grouped.length ? " has-cowork-reactions" : ""}${fileMessageClass}`}>
                {message.replyToId ? <div className="cowork-quoted-message"><span>{quotedSender(replyTarget, selfSub, title, state?.ownerSub)}：</span><span>{quotedContent(replyTarget)}</span></div> : null}
                {message.voice ? (
                  <VoiceMessage recording={message.voice} basePath={basePath} />
                ) : message.forwardedBundle?.length ? (
                  <button type="button" className="cowork-bundle" aria-haspopup="dialog" aria-label={`查看聊天记录，共 ${message.forwardedBundle.length} 条`} onClick={() => setBundleViewer(message.forwardedBundle!)}>
                    <span className="cowork-bundle-title">{t("chatHistoryCount", { count: message.forwardedBundle.length })}<small>{t("clickToView")}</small></span>
                    <span className="cowork-bundle-preview">
                      {message.forwardedBundle.slice(0, 4).map((item, itemIndex) => <span key={itemIndex} className="cowork-bundle-preview-line">{bundlePreviewLine(item)}</span>)}
                    </span>
                  </button>
                ) : <>{atts.length ? <div className="msg-attachments">{atts.map((file, fileIndex) => renderMessageAttachment(file, fileIndex, `${message.id}:${fileIndex}`))}</div> : null}{displayContent.trim() ? renderUserText(displayContent) : null}</>}
                {reactionBar}
              </div>}
              belowBubble={message.voice && message.content.trim() ? (
                <div className="msg-voice-transcript--plain">{renderUserText(message.content)}</div>
              ) : null}
              status={replyCount || readStatus ? <div className={`cowork-message-status${own ? " is-own" : ""}`}>
                {replyCount ? <span className="cowork-reply-count">{replyCount}条回复</span> : null}{readStatus}
              </div> : null}
              actions={multiSelect ? undefined : <>
                {actions}
                <button type="button" className="msg-menu-tip" data-tooltip={t("coworkForward")} aria-label={t("forwardMessage")} onClick={() => { setMoreMenuId(null); setForwardMessage(message); }}><ChatPanelGlyph04 /></button>
                {own ? <button type="button" className="msg-menu-tip" data-tooltip="撤回" aria-label={t("recallMessage")} onClick={() => void revokeMessage(message.id)}><RecallIcon /></button> : null}
                <span className="cowork-more-anchor" data-cowork-more-menu>
                  <button type="button" className="msg-menu-tip cowork-more-trigger" data-tooltip={t("more")} aria-label={t("moreActions")} aria-expanded={moreMenuId === message.id} onClick={() => setMoreMenuId(current => current === message.id ? null : message.id)}><MoreIcon /></button>
                  {moreMenuId === message.id ? <span className="cowork-more-pop" role="menu">
                    <button type="button" role="menuitem" onClick={() => { setMoreMenuId(null); void copyMessage(message.id, message.content); }}>{copiedId === message.id ? <CheckIcon /> : <CopyIcon />}<span>{copiedId === message.id ? "已复制" : "复制"}</span></button>
                    {atts.length === 1 && !isImageFile(atts[0]) ? <button type="button" role="menuitem" onClick={() => { setMoreMenuId(null); downloadAttachment(atts[0]); }}><OperationPanelGlyph08 /><span>{t("download")}</span></button> : null}
                    <button type="button" role="menuitem" onClick={() => { setMoreMenuId(null); setMultiSelect(true); setSelectedIds(new Set([message.id])); }}><MultiSelectIcon />{t("multiSelect")}</button>
                  </span> : null}
                </span>
              </>}
            /></div></Fragment>;
          })}
          {readDetails ? <div className="cowork-read-backdrop" onClick={() => setReadDetails(null)}><div className="cowork-read-dialog" role="dialog" aria-modal="true" aria-label={t("readDetails")} onClick={event => event.stopPropagation()}>
            <button type="button" className="cowork-read-close" onClick={() => setReadDetails(null)} aria-label={t("close")}>×</button>
            {[true,false].map(read => <section key={String(read)}><h3>{readDetails.people.filter(person => person.read === read).length} {read ? t("read") : t("notRead")}</h3>
              {readDetails.people.filter(person => person.read === read).map(person => <div className="cowork-read-person" key={person.userSub}>
                <Avatar name={person.name} src={person.avatar || undefined} size={30} className="cowork-read-avatar" />{person.name}
              </div>)}
            </section>)}
          </div></div> : null}
          {bundleViewer ? <div className="cowork-bundle-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setBundleViewer(null); }}>
            <div className="cowork-bundle-dialog" role="dialog" aria-modal="true" aria-label={t("chatHistoryCount", { count: bundleViewer.length })} onClick={event => event.stopPropagation()}>
              <header><h2>聊天记录 · {bundleViewer.length} 条</h2><button type="button" className="cowork-bundle-close" aria-label={t("close")} onClick={() => setBundleViewer(null)}>×</button></header>
              <div className="cowork-bundle-list">
                {bundleViewer.map((item, itemIndex) => <div key={itemIndex} className="cowork-bundle-item">
                  <strong>{item.senderName}</strong><time>{new Date(item.createdAt).toLocaleString()}</time>
                  <div>{item.content}</div>
                  {item.attachments?.map((file, index) => renderMessageAttachment(file, index))}
                </div>)}
              </div>
            </div>
          </div> : null}
          {pendingMessages.map((message, index) => <Fragment key={message.localId}>
            {shouldShowTimeMarker(message.createdAt, index > 0 ? pendingMessages[index - 1].createdAt : state?.messages.at(-1)?.createdAt) ? <TimeMarker at={message.createdAt} /> : null}
            <HumanMessage own={!selfChat} showAvatar avatar={selfAvatar} senderName={selfName} showName={false}
            bubble={<div className={`bubble${message.voice ? " bubble--voice" : ""}${message.attachments.some(file => !isImageFile(file) && !isVideoFile(file) && !isAudioFile(file)) ? ` bubble--file-message${message.content.trim().length > 90 ? " bubble--file-message-wide" : ""}` : ""}`}>
              {message.replyToId ? <div className="cowork-quoted-message"><span>{quotedSender(state?.messages.find(item => item.id === message.replyToId), selfSub, title)}：</span><span>{quotedContent(state?.messages.find(item => item.id === message.replyToId))}</span></div> : null}
              {message.attachments.length ? <div className="msg-attachments">{message.attachments.map((file, fileIndex) => renderMessageAttachment(file, fileIndex))}</div> : null}
              {message.voice ? <VoiceMessage recording={message.voice} basePath={basePath} /> : null}
              {!message.voice ? renderUserText(message.content) : null}
            </div>}
            belowBubble={message.voice && message.content?.trim() ? (
              <div className="msg-voice-transcript--plain">{renderUserText(message.content)}</div>
            ) : null}
            status={<>
              {message.status === "slow" ? <div className="cowork-send-status is-pending-left" role="status" title={t("sendingEllipsis")} aria-label={t("sending")}><span className="chat-loading-spinner" aria-hidden="true" /></div> : null}
              {message.status === "failed" ? <button type="button" className="cowork-send-status is-pending-left is-failed" title={message.error ? t("sendFailedReason", { reason: message.error }) : t("sendFailedRetry")} aria-label={t("sendFailedRetry")} onClick={() => void send(undefined, message)}><ErrorMarkIcon /></button> : null}
            </>}
          /></Fragment>)}
          {/* 群内 AI 使用单聊相同的事件字段更新思考、工具和正文。 */}
          {liveRun ? <div className="msg bot" aria-live="polite">
            <div className="cowork-ai-sender">{groupAgents.find(agent => agent.id === liveRun.agentId)?.name || title}</div>
            <AiResponse scene="group" steps={liveRun.steps} elapsedSecs={liveElapsed} running mode={state?.settings?.cowork_mode} basePath={basePath} content={liveRun.content} mentions={knownNames} />
          </div> : null}
          <div ref={spacerRef} className="chat-stream-spacer" aria-hidden="true" />
        </div>
      </div>
      </div>
    </div>
    <div className="chat-main-inner">
    {/* 离开底部时：消息底部渐隐模糊遮罩 + 居中「回到底部」按钮（与人机聊天一致）。
        大模型输出进行中（busy）且用户在下方有未读消息时，按钮播放细环转圈动画。 */}
    {!atBottom ? (
      <div className="chat-body-overlay">
        <div className="chat-body-fade" aria-hidden="true" />
        {/* 未读新消息徽标：滚离底部期间到达的新消息数，小字显示在「回到底部」箭头正上方；
            回到底部 / 滚回底部 / 发送消息时自动消失（计数由 useChatScroll 维护） */}
        {unreadCount > 0 ? (
          <span className="chat-unread-badge">{unreadCount} 条新消息</span>
        ) : null}
        <button
          type="button"
          className={`chat-bottom-btn${liveRun ? " is-live" : ""}`}
          onClick={jumpToBottom}
          aria-label={t("backToBottom")}
        >
          <ChatPanelGlyph21 />
        </button>
      </div>
    ) : null}
    <div className={`chat-input-zone${multiSelect ? " is-multi-select" : ""}`}>
      {homeRecipientChips?.length ? <div className="chat-pending-members" aria-label={`已选择 ${homeRecipientChips.length} 个发送对象`}>
        {homeRecipientChips.map(chip => <MemberChip key={chip.id} name={chip.name} avatar={chip.avatar} onRemoveClick={() => {
          const draft = composerRef.current?.getText() ?? "";
          onRemoveHomeRecipient?.(chip.id, draft, draft.length, attachments);
        }} />)}
      </div> : null}
      {replyToId ? <div className="cowork-reply-banner"><span>{t("replyTo", { sender: quotedSender(state?.messages.find(item => item.id === replyToId), selfSub, title), content: quotedContent(state?.messages.find(item => item.id === replyToId)) })}</span><button type="button" onClick={() => setReplyToId(null)} aria-label={t("cancelReply")}>×</button></div> : null}
      {error ? <p className="cowork-error" role="alert">{error}</p> : null}
      {voiceError ? <p className="cowork-error" role="alert">{voiceError}</p> : null}
      {visibleMentionOptions.length ? <div className="cowork-mentions" role="listbox" aria-label={t("mentionMembers")}>{visibleMentionOptions.map((option, index) => <button
        key={option.id}
        ref={node => { mentionRefs.current[index] = node; }}
        type="button"
        role="option"
        aria-selected={index === mentionIndex}
        tabIndex={-1}
        onMouseDown={event => event.preventDefault()}
        onMouseEnter={() => setMentionIndex(index)}
        onClick={() => { const result = chooseMention(option.name); if (result) onHomeDraftChange?.(result.text, result.caret); }}
      >{option.id === "all" ? null : option.avatar ? <img src={option.avatar} alt="" /> : <span className={avatarFallbackClass(avatarInitials(option.name))}>{avatarInitials(option.name)}</span>}{option.name}{option.id === "agent" ? <small>AI</small> : null}</button>)}</div> : null}
      {capabilities?.length
        ? (() => {
            const cards = renderCapabilityCards(capabilities, { sessionId, messages: toCapMessages(state?.messages ?? []), channel: "cowork" });
            return cards.length === 0 ? null : <div className="cowork-capability-cards">{cards}</div>;
          })()
        : null}
      <ChatInputArea
        pendingQueue={[]} queueNotice={null} steerInFlight={new Set<string>()}
        onQueueDragStart={() => {}} onQueueDragOver={() => {}} onQueueDrop={() => {}} onQueueDragEnd={() => {}}
        steerQueueItem={() => {}} editQueueItem={() => {}} removeQueueItem={() => {}}
        activeAttachments={attachments} clearAttachment={clearAttachment} resolveFileUrl={(url) => resolveAttachmentUrl(url, basePath)}
        visionWarning={null} uploading={uploading} mobileHolding={holdRecording} mobileCancelArmed={holdCancelArmed}
      >
        <ChatComposer
          ref={composerRef}
          activeSid={sessionId}
          busy={sending || uploading || !!liveRun}
          booting={false}
          uploading={uploading}
          modelLoading={false}
          modelBlocked={false}
          attachments={attachments}
          recording={recording}
          transcribing={transcribing}
          mobileVoiceMode={mobileVoiceMode}
          appName={title}
          onSend={(value) => void send(value)}
          onDraftSave={saveGroupDraft}
          onHasInputChange={setHasInput}
          onHasTextChange={() => {}}
          onValueChange={handleComposerValue}
          onUserValueChange={(value, caret) => { if (onHomeDraftChange?.(value, caret)) composerRef.current?.discardDraft(); }}
          onEnter={() => { const selected = onEnter(); if (selected) { const text = composerRef.current?.getText() ?? ""; onHomeDraftChange?.(text, text.length); } return selected; }}
          onKeyDownIntercept={(key) => { const selected = onMentionKeyDown(key); if (selected && key === "Tab") { const text = composerRef.current?.getText() ?? ""; onHomeDraftChange?.(text, text.length); } return selected; }}
          onVoiceHoldStart={voiceEnabled && rightCtrlVoice ? () => {
            if (dictation.state !== "idle") return false;
            if (!window.isSecureContext) {
              setVoiceError("当前局域网 HTTP 地址无法使用麦克风，请通过 HTTPS 访问（本机可用 localhost）");
              return false;
            }
            voiceSendPendingRef.current = false;
            pendingVoiceRef.current = null;
            setVoiceError("");
            dictation.start();
            setRightCtrlRecording(true);
            return true;
          } : undefined}
          onVoiceHoldEnd={voiceEnabled ? (cancelled) => { setRightCtrlRecording(false); if (cancelled) dictation.cancel(); else dictation.stop(); } : undefined}
          onPasteFiles={uploadFiles}
          placeholder={`发消息，输入 @ 提及${title}或成员`}
        />
        {/* 按住说话模式：输入框隐藏，中间铺满「按住说话」大钮，长按直接录音（移出取消）。 */}
        {mobileVoiceMode && !holdRecording ? (
          <button
            type="button"
            className="chat-mobile-hold is-active"
            onPointerDown={holdAreaDown}
            onContextMenu={(event) => event.preventDefault()}
            aria-label={t("holdToTalk")}
          >
            {transcribing ? "正在识别…" : "按住说话"}
          </button>
        ) : null}
        {/* 与单聊同一个输入卡片：左侧加号（附件）、右侧语音 + 发送。
            群聊使用群级统一的框架与模型（群设置内配置），故不渲染模型 / 框架选择。 */}
        <div className={`chat-toolbar${mobileVoiceMode ? " chat-toolbar--mobile-voice" : ""}${recording || rightCtrlRecording ? " chat-toolbar--recording" : ""}`}>
          <div className="chat-toolbar-left">
            <div className="chat-attach-anchor">
              {recentScreenshot ? <button type="button" className="chat-screenshot-suggestion" onClick={() => void addRecentScreenshot()} onMouseEnter={() => { screenshotHoveredRef.current = true; if (screenshotTimerRef.current) clearTimeout(screenshotTimerRef.current); screenshotTimerRef.current = null; }} onMouseLeave={() => { screenshotHoveredRef.current = false; setRecentScreenshot(null); }} aria-label={t("addScreenshot")} disabled={uploading}>
                <img src={recentScreenshot.thumbnail} alt="刚刚的截图" />
              </button> : null}
              <button type="button" className="chat-tool" onClick={() => referenceSources.length ? setReferenceMenuOpen(open => !open) : fileRef.current?.click()} disabled={uploading} aria-label={referenceSources.length ? "添加引用" : "上传附件"} aria-expanded={referenceSources.length ? referenceMenuOpen : undefined} aria-haspopup={referenceSources.length ? "menu" : undefined}>
                <ChatPanelGlyph24 />
              </button>
              <input ref={fileRef} type="file" multiple hidden onChange={onPickFile} />
              {referenceMenuOpen ? <>
                <div className="chat-reference-menu-backdrop" onClick={() => setReferenceMenuOpen(false)} />
                <div className="chat-reference-menu" role="menu" aria-label={t("addReference")}>
                  <button type="button" role="menuitem" onClick={() => { setReferenceMenuOpen(false); fileRef.current?.click(); }}>{t("attachment")}</button>
                  {referenceSources.map(source => <button type="button" role="menuitem" key={source.id} onClick={() => {
                    setReferenceMenuOpen(false);
                    void Promise.resolve().then(() => source.onSelect({ sessionId, add: reference => {
                      if (!reference.id || !reference.context) return;
                      setComposerReferences(current => current.some(item => item.sourceId === source.id && item.reference.id === reference.id)
                        ? current.map(item => item.sourceId === source.id && item.reference.id === reference.id ? { sourceId: source.id, reference } : item)
                        : [...current, { sourceId: source.id, reference }]);
                    } })).catch(error => console.warn("[agent-kit] 引用来源选择失败:", error));
                  }}>{source.label}</button>)}
                </div>
              </> : null}
            </div>
            {composerReferences.map(({ sourceId, reference }) => <span className="chat-reference-chip" key={`${sourceId}:${reference.id}`} title={reference.label}>
              <span className="chat-reference-chip-content">{referenceSources.find(source => source.id === sourceId)?.renderReference?.(reference) ?? reference.label}</span>
              <button type="button" aria-label={`移除引用 ${reference.label}`} onClick={() => setComposerReferences(current => current.filter(item => item.sourceId !== sourceId || item.reference.id !== reference.id))}>×</button>
            </span>)}
          </div>
          {(recording || rightCtrlRecording) && !(rightCtrlRecording && previewFull) ? <div className="chat-desktop-record-wave" role="status" aria-label={t("voiceInput")}><RecordingWave amplitude={dictation.amplitude} /></div> : null}
          {rightCtrlRecording && previewFull ? <GlobalRecordingWave amplitude={dictation.amplitude} /> : null}
          <div className="chat-toolbar-center" />
          <div className="chat-toolbar-right">
            {/* 常驻麦克风：点按切换的语音转写（与第三位长按录音相互独立）。
                第三位（移动端）：无内容=喇叭「按住说话」，有内容=发送；转写/长按录制中留空。
                桌面保持语音 + 发送并排。 */}
            {(showVoiceButton ?? voiceEnabled) && !holdRecording ? (
              <button
                type="button"
                className={`chat-voice ${recording ? "recording" : ""} ${transcribing ? "connecting" : ""}`}
                onClick={toggleVoiceInput}
                aria-label={transcribing ? "取消语音转写" : recording ? "结束录音" : "语音输入"}
                title={transcribing ? "取消语音转写" : undefined}
                aria-pressed={recording}
              >
                {transcribing ? (
                  <span className="chat-voice-spinner" aria-hidden="true" />
                ) : recording ? (
                  <span className="chat-voice-icon chat-voice-icon--stop" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg></span>
                ) : (
                  <span className="chat-voice-icon"><MicIcon /></span>
                )}
              </button>
            ) : null}
            <div className="cowork-composer-emoji-anchor"><button type="button" className="chat-tool" aria-label={t("insertEmoji")} onClick={event => emojiPicker === "composer" ? setEmojiPicker(null) : openEmojiPicker("composer", event.currentTarget)}><SmileIcon /></button></div>
            {isMobileLayout ? (
              mobileVoiceMode ? (
                <button
                  type="button"
                  className="chat-mobile-speaker chat-mobile-keyboard"
                  onClick={toggleMobileVoiceMode}
                  aria-label={t("keyboardInput")}
                  title={t("keyboardInput")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19h16" /><circle cx="5.5" cy="7" r="1" /><circle cx="10" cy="7" r="1" /><circle cx="14.5" cy="7" r="1" /><circle cx="19" cy="7" r="1" /><circle cx="5.5" cy="12" r="1" /><circle cx="10" cy="12" r="1" /><circle cx="14.5" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
                </button>
              ) : hasInput && !recording && !transcribing && !holdRecording ? (
                <button type="button" className="chat-send" onClick={() => composerRef.current?.sendNow()} disabled={sending || historyOnly} aria-label={t("sendGroup")}>
                  <ChatPanelGlyph35 />
                </button>
              ) : recording || transcribing ? null : (
                <button
                  type="button"
                  className="chat-mobile-speaker"
                  onClick={speakerClick}
                  onPointerDown={speakerDown}
                  onContextMenu={(event) => event.preventDefault()}
                  aria-label={t("voiceTapHold")}
                  title={t("voiceTapHint")}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="4" cy="12" r="1.3" /><path d="M8 8a6 6 0 0 1 0 8M12 4a11 11 0 0 1 0 16" /></svg>
                </button>
              )
            ) : (
              <button type="button" className="chat-send" onClick={() => composerRef.current?.sendNow()} disabled={!hasInput || sending || historyOnly} aria-label={t("sendGroup")}>
                <ChatPanelGlyph35 />
              </button>
            )}
          </div>
        </div>
      </ChatInputArea>
      {holdRecording ? (
        <RecordOverlay amplitude={dictation.amplitude} cancelArmed={holdCancelArmed} />
      ) : null}
      {multiSelect ? <div className="cowork-select-actions" role="toolbar" aria-label={`已选择 ${selectedIds.size} 条消息`}>
        <span className="cowork-select-count">已选择 {selectedIds.size} 条</span>
        <button type="button" disabled={!selectedIds.size} onClick={() => { setSelectedForwardMode("merged"); setForwardSelected(true); }}><span className="cowork-select-action-icon"><ChatPanelGlyph04 /><span className="cowork-select-action-lines" /></span><span>{t("forwardMerged")}</span></button>
        <button type="button" disabled={!selectedIds.size} onClick={() => { setSelectedForwardMode("individual"); setForwardSelected(true); }}><span className="cowork-select-action-icon"><ChatPanelGlyph04 /></span><span>{t("forwardSeparate")}</span></button>
        <button type="button" className="cowork-select-close" onClick={() => { setMultiSelect(false); setSelectedIds(new Set()); }} aria-label={t("cancelSelection")}>×</button>
      </div> : null}
    </div>
    </div>
      {/* 群设置从顶栏下沿展开，覆盖消息区和输入区；顶栏按钮保持可见可点。 */}
      {settingsOpen ? <div className="cowork-settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { setSettingsOpen(false); if (isMobileLayout) onMobileSettingsBack?.(); } }}>
        <section className="cowork-settings" role="dialog" aria-modal="true" aria-label={settingsLabel}>
          <header><strong className="cowork-settings-desktop-title">{settingsLabel}</strong><span className="chat-title cowork-settings-mobile-title">{t("settings")}</span><button type="button" onClick={() => { setSettingsOpen(false); if (isMobileLayout) onMobileSettingsBack?.(); }} aria-label={isMobileLayout ? t("backChatDetails") : t("close")}>{isMobileLayout ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m14 5-7 7 7 7" /></svg> : "×"}</button></header>
          <div className="cowork-settings-body">
            {members.length >= 1 ? (
              <>
                {/* 群头像/群名称：真人成员 ≥2 或已是群聊（增强群由人机聊天升级而来，即使只有 1 名成员）都显示 */}
                {(members.length > 1 || everGroup) ? (
                  <div className="cowork-settings-group">
                    <button type="button" className="cowork-group-avatar cowork-settings-avatar-button" onClick={() => groupAvatarInput.current?.click()} disabled={!canConfigure || groupAvatarUploading} title={t("changeGroupAvatar")} aria-label={t("changeGroupAvatar")}>
                      {groupAvatar ? <img src={`${basePath}${groupAvatar}`} alt="" /> : <GroupAvatarIcon />}
                      <span className="cowork-settings-avatar-edit">{groupAvatarUploading ? "上传中…" : "更换"}</span>
                    </button>
                    <input ref={groupAvatarInput} type="file" accept="image/*" hidden onChange={event => void uploadGroupAvatar(event)} />
                    <label className="cowork-settings-title">{t("groupName")}<input value={groupTitle} onChange={event => setGroupTitle(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commitGroupTitle(); } }} onBlur={() => commitGroupTitle()} maxLength={80} disabled={!canConfigure} aria-label={t("groupName")} /></label>
                  </div>
                ) : null}
                <div className="cowork-settings-members">
                  <div className="cowork-settings-members-head">
                    <strong>{(members.length > 1 || everGroup) ? "群成员" : "成员"} <span className="cowork-settings-members-count">{settingsRows.length} 人</span></strong>
                    {isOwner ? (
                      <button type="button" className="cowork-settings-members-arrow" aria-label={t("manageAdmins")} title={t("setAdmins")} onClick={() => setAdminDialogOpen(true)}>›</button>
                    ) : null}
                  </div>
                  {effectiveMembers.length > 6 ? <input type="search" className="cowork-settings-members-search" placeholder={t("searchMembers")} value={memberQuery} onChange={event => setMemberQuery(event.target.value)} /> : null}
                  <div className="cowork-settings-members-list">
                    {settingsRows.filter(row => row.name.toLocaleLowerCase().includes(memberQuery.trim().toLocaleLowerCase())).map(row => {
                      const protectedRow = row.role !== "member";
                      const selectable = canRemoveMembers && !protectedRow;
                      const selected = selectable && selectedMembers.has(row.key);
                      return (
                      <MemberChip key={row.key} name={row.name} avatar={row.avatar}
                        size={36}
                        badge={row.role === "owner" ? "群主" : row.role === "admin" ? "管理员" : undefined}
                        removable={selectable}
                        selected={selected}
                        onCardClick={selectable ? () => toggleMemberSelect(row.key) : undefined} />
                      );
                    })}
                    {canManageMembers ? (
                      <button type="button" className="cowork-settings-member-add" aria-label={t("addMembers")} title={t("addMembers")} onClick={() => { setSettingsOpen(false); onInvite(); }}>+</button>
                    ) : null}
                  </div>
                  {canRemoveMembers && selectedMembers.size > 0 ? (
                    <button type="button" className="cowork-settings-danger-btn cowork-settings-member-remove" onClick={() => setRemoveConfirmOpen(true)} disabled={removingBusy}>
                      移除成员（{selectedMembers.size}）
                    </button>
                  ) : null}
                </div>
              </>
            ) : null}
            {settingsError ? <p className="cowork-error" role="alert">{settingsError}</p> : null}
            <div className="cowork-settings-mute-group">
              <label className="cowork-settings-mute">{t("muteMessages")}<input type="checkbox" role="switch" checked={!!muted} disabled={mutedSaving || !sessionId || !!pendingMembers.length && !members.length} onChange={event => void toggleMuted(event.target.checked)} /><span className="cowork-settings-switch" aria-hidden="true" /></label>
              <label className="cowork-settings-mute" title={t("aiMuteHint")}>
                AI 消息免打扰<input type="checkbox" role="switch" checked={!!muted || !!aiMuted} disabled={mutedSaving || !sessionId || !!pendingMembers.length && !members.length || !!muted} onChange={event => void toggleAiMuted(event.target.checked)} /><span className="cowork-settings-switch" aria-hidden="true" />
              </label>
            </div>
            {/* 仅配置了一个可用框架（AGENT_PROVIDER 单值）时没有切换意义，隐藏整行；模型选择不受影响。 */}
            {modes.length > 1 ? (
              <div className="cowork-settings-field"><span>{t("framework")}</span>
                <AppSelect
                  options={modes.map(item => ({ value: item, label: item === "codex" ? "Codex" : "CodeBuddy" }))}
                  value={mode}
                  onChange={next => { setMode(next); void persistSettings({ mode: next }); }}
                  disabled={!canConfigure}
                  openOnHover
                  forceUp
                />
              </div>
            ) : null}
            <div className="cowork-settings-field"><span>{t("model")}</span>{(() => {
              const opts = mode === "codex" ? codexModels : models;
              const id = mode === "codex" ? codexModel : model;
              const key = id ? (opts.find((m) => m.id === id) ? modelOptionKey(opts.find((m) => m.id === id)!) : id) : "";
              return (
                <ModelSelect
                  options={opts}
                  value={key}
                  onChange={(k) => {
                    const newId = k.includes("::") ? k.slice(k.indexOf("::") + 2) : k;
                    if (mode === "codex") { setCodexModel(newId); void persistSettings({ codexModel: newId }); }
                    else { setModel(newId); void persistSettings({ model: newId }); }
                  }}
                  disabled={!canConfigure || (mode === "codebuddy" && !modelSelectionEnabled)}
                  forceUp
                />
              );
            })()}</div>
            {effectiveMembers.length ? <div className="cowork-settings-danger">
              {(() => {
                const personalChat = !everGroup && !!state?.isTwoPerson;
                const canDissolve = state?.ownerSub === selfSub;
                return <button type="button" className="cowork-settings-danger-btn" aria-label={personalChat ? "删除聊天" : canDissolve ? "解散群组" : "退出群组"}
                  onClick={() => setGroupAction(personalChat ? "delete" : canDissolve ? "dissolve" : "leave")} disabled={groupActionBusy}>
                  {personalChat ? "删除聊天" : canDissolve ? "解散群组" : "退出群组"}
                </button>;
              })()}
            </div> : null}
          </div>
          <footer>{!canConfigure ? <p>{t("adminOnly")}</p> : null}</footer>
        </section>
      </div> : null}
      {removeConfirmOpen ? <div className="cowork-action-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !removingBusy) setRemoveConfirmOpen(false); }}>
        <div className="cowork-action-dialog" role="alertdialog" aria-modal="true" aria-label={t("removeMember")}>
          <h3>{t("removeMember")}</h3>
          <p>确定将 {effectiveMembers.filter(member => selectedMembers.has(member.contactId)).map(member => member.name).join("、")} 移出群聊吗？移除后对方将无法查看该群聊。</p>
          <div className="cowork-action-btns">
            <button type="button" className="cowork-action-cancel" onClick={() => setRemoveConfirmOpen(false)} disabled={removingBusy}>{t("cancel")}</button>
            <button type="button" className="cowork-action-confirm" onClick={() => void runRemoveMembers()} disabled={removingBusy}>{removingBusy ? "处理中…" : "移除"}</button>
          </div>
        </div>
      </div> : null}
      {adminDialogOpen ? <div className="cowork-action-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !adminBusy) setAdminDialogOpen(false); }}>
        <div className="cowork-action-dialog cowork-admin-dialog" role="dialog" aria-modal="true" aria-label={t("adminManagement")}>
          <h3>{t("adminManagement")}</h3>
          <p className="cowork-admin-hint">{t("adminHelp")}</p>
          <input type="search" className="cowork-settings-members-search cowork-admin-search" placeholder={t("searchMembers")} value={memberQuery} onChange={event => setMemberQuery(event.target.value)} />
          <div className="cowork-admin-list">
            {settingsRows.filter(row => row.name.toLocaleLowerCase().includes(memberQuery.trim().toLocaleLowerCase())).map(row => (
              <div className="cowork-admin-row" key={row.key}>
                <Avatar name={row.name} src={row.avatar || undefined} size={36} className="cowork-admin-avatar" />
                <div className="cowork-admin-row-main">
                  <span className="cowork-admin-row-name">{row.name}</span>
                  <span className="cowork-admin-row-role">{row.role === "owner" ? "群主" : row.role === "admin" ? "管理员" : "成员"}</span>
                </div>
                {row.role === "owner" ? <span className="cowork-admin-lock">{t("owner")}</span>
                  : (
                    <button type="button" className={`cowork-admin-toggle${row.role === "admin" ? " is-on" : ""}`} disabled={adminBusy}
                      onClick={() => void toggleAdmin({ provider: row.provider!, contactId: row.contactId!, name: row.name, avatar: row.avatar }, row.role !== "admin")}>
                      {row.role === "admin" ? "取消管理员" : "设为管理员"}
                    </button>
                  )}
              </div>
            ))}
          </div>
          <div className="cowork-action-btns">
            <button type="button" className="cowork-action-cancel" onClick={() => setAdminDialogOpen(false)} disabled={adminBusy}>{t("close")}</button>
          </div>
        </div>
      </div> : null}
      {groupAction ? <div className="cowork-action-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !groupActionBusy) setGroupAction(null); }}>
        <div className="cowork-action-dialog" role="alertdialog" aria-modal="true" aria-label={groupAction === "delete" ? "删除聊天" : groupAction === "dissolve" ? "解散群组" : "退出群组"}>
          <h3>{groupAction === "delete" ? "删除聊天" : groupAction === "dissolve" ? "解散群组" : "退出群组"}</h3>
          <p>{groupAction === "delete" ? "删除后，你将看不到此前的聊天记录；对方的记录不受影响。收到新消息时，聊天会重新出现。确定删除吗？" : groupAction === "dissolve" ? "解散后所有成员将无法查看该群聊，聊天记录会被删除，且不可恢复。确定要解散吗？" : "退出后你将不再看到该群聊，也无法继续接收群消息。确定要退出吗？"}</p>
          <div className="cowork-action-btns">
            <button type="button" className="cowork-action-cancel" onClick={() => setGroupAction(null)} disabled={groupActionBusy}>{t("cancel")}</button>
            <button type="button" className="cowork-action-confirm" onClick={() => void runGroupAction(groupAction)} disabled={groupActionBusy}>{groupActionBusy ? "处理中…" : (groupAction === "delete" ? "删除" : groupAction === "dissolve" ? "解散" : "退出")}</button>
          </div>
        </div>
      </div> : null}
  </div>;
}
