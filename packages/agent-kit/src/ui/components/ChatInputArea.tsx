"use client";

import { useChatTranslation } from "../chat/i18n.tsx";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { QueueItem, UiAttachment } from "../AgentWindow.tsx";
import { DeleteIcon, EditIcon } from "../icons/ActionIcons.tsx";
import { AudioIcon, FileIcon, FolderIcon, ImageIcon, VideoIcon } from "../icons/SharedIcons.tsx";
import { ChatInputAreaGlyph01, ChatInputAreaGlyph02 } from "../icons/PageIcons.tsx";
import { isAudioFile, isImageFile, isVideoFile } from "../chat/messageUtils.ts";
import type { GroupRef } from "../chat/types.ts";
import { GROUP_DRAG_MIME } from "../chat/types.ts";
import { Avatar } from "../shared/AvatarView.tsx";

interface HoverPreview {
  src: string;
  name: string;
  rect: DOMRect;
  /** 与胶囊渲染用的 key 一致，用于判断预览对应的附件是否仍存在 */
  key: string;
}

const attachmentKey = (att: UiAttachment | PendingFile, index: number): string =>
  "id" in att ? att.id : `${"url" in att ? att.url : ""}-${index}`;

interface PendingFile {
  id: string;
  name: string;
  size?: number;
  file: File;
  previewUrl?: string;
  progress: number;
}

interface ChatInputAreaProps {
  pendingQueue: QueueItem[];
  queueNotice: string | null;
  steerInFlight: Set<string>;
  onQueueDragStart: (event: DragEvent, item: QueueItem) => void;
  onQueueDragOver: (event: DragEvent, item: QueueItem) => void;
  onQueueDrop: (event: DragEvent) => void;
  onQueueDragEnd: () => void;
  steerQueueItem: (item: QueueItem) => void;
  editQueueItem: (item: QueueItem) => void;
  removeQueueItem: (item: QueueItem) => void;
  activeAttachments: (UiAttachment | PendingFile)[];
  clearAttachment: (index: number) => void;
  resolveFileUrl: (url: string) => string;
  visionWarning: string | null;
  uploading: boolean;
  mobileHolding: boolean;
  mobileCancelArmed: boolean;
  /** 实时转录进行中（按住 option 走腾讯云 wss）：只显示纯文本，隐藏工具栏/附件/特效，alpha 淡入淡出。 */
  realtimeVoiceActive?: boolean;
  children: ReactNode;
  /** 是否允许往输入框拖入群聊（仅 1v1 人机会话） */
  groupDropEnabled?: boolean;
  /** 拖入群聊后调用（由宿主维护接入列表） */
  onDropGroup?: (group: GroupRef) => void;
}

export default function ChatInputArea({
  pendingQueue, queueNotice, steerInFlight, onQueueDragStart, onQueueDragOver,
  onQueueDrop, onQueueDragEnd, steerQueueItem, editQueueItem, removeQueueItem,
  activeAttachments, clearAttachment, resolveFileUrl, visionWarning, uploading,
  mobileHolding, mobileCancelArmed, realtimeVoiceActive, children,
  groupDropEnabled, onDropGroup,
}: ChatInputAreaProps) {
  const t = useChatTranslation();
  const [hoverPreview, setHoverPreview] = useState<HoverPreview | null>(null);
  const [previewTop, setPreviewTop] = useState<number | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  // 拖「群聊」悬停在输入框上：给出可落下的高亮（dragover 只能读 types，读不到 payload）
  const [groupDragOver, setGroupDragOver] = useState(false);
  const hasGroupDrag = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer?.types ?? []).includes(GROUP_DRAG_MIME);
  const onGroupDragOver = (event: DragEvent<HTMLElement>) => {
    if (!groupDropEnabled || !hasGroupDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setGroupDragOver(true);
  };
  const onGroupDragLeave = () => setGroupDragOver(false);
  const onGroupDrop = (event: DragEvent<HTMLElement>) => {
    if (!groupDropEnabled || !hasGroupDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setGroupDragOver(false);
    const raw = event.dataTransfer.getData(GROUP_DRAG_MIME);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; title?: unknown; avatar?: unknown; kind?: unknown };
      if (typeof parsed.id !== "string" || !parsed.id) return;
      const kind = parsed.kind === "peer" ? ("peer" as const) : ("group" as const);
      onDropGroup?.({
        id: parsed.id,
        title: typeof parsed.title === "string" && parsed.title ? parsed.title : "会话",
        avatar: typeof parsed.avatar === "string" ? parsed.avatar : null,
        kind,
      });
    } catch { /* 坏数据忽略 */ }
  };

  const measurePreview = () => {
    if (hoverPreview && previewRef.current) {
      // 浮层整体放在 chip 上方：top = chip 顶 - 间距 - 浮层自身高度
      setPreviewTop(hoverPreview.rect.top - 8 - previewRef.current.offsetHeight);
    }
  };

  // 在绘制前同步测量并定位，避免“先原地出现再跳到上方”的闪烁
  useLayoutEffect(() => {
    if (hoverPreview) measurePreview();
    else setPreviewTop(null);
  }, [hoverPreview]);

  const showImagePreview = (el: HTMLElement, att: UiAttachment | PendingFile, index: number) => {
    const src = ("previewUrl" in att && att.previewUrl) || ("url" in att && att.url ? resolveFileUrl(att.url) : "");
    if (!src || !isImageFile(att)) return;
    setPreviewTop(null);
    setHoverPreview({ src, name: att.name, rect: el.getBoundingClientRect(), key: attachmentKey(att, index) });
  };
  const hideImagePreview = () => setHoverPreview(null);

  // 附件被移除（如点击胶囊上的 ×）后，预览对应的胶囊已不存在，必须同步关闭浮层，
  // 否则浮层会残留且无法关闭。
  useEffect(() => {
    if (!hoverPreview) return;
    const stillPresent = activeAttachments.some((att, i) => attachmentKey(att, i) === hoverPreview.key);
    if (!stillPresent) setHoverPreview(null);
  }, [activeAttachments, hoverPreview]);

  return (
    <>
      <div className={`chat-composer-stack${mobileHolding ? ` is-mobile-recording${mobileCancelArmed ? " is-cancelling" : ""}` : ""}${realtimeVoiceActive ? " is-realtime-voice" : ""}`}>
        {/* 待发消息队列（steer）：与输入卡片共用 stack 面板，视觉上连成一体。
            左侧拖拽手柄可排序，右侧三个图标 = 立即插话(气泡) / 编辑(铅笔) / 删除(垃圾桶)；
            不点插话则等本轮结束后按顺序自动发送 */}
        {pendingQueue.length > 0 ? (
          <div className="chat-queue" role="list" aria-label={t("queue")}>
            {pendingQueue.map((item) => (
              <div
                className="chat-queue-item"
                role="listitem"
                key={item.id}
                draggable
                onDragStart={(e) => onQueueDragStart(e, item)}
                onDragOver={(e) => onQueueDragOver(e, item)}
                onDrop={onQueueDrop}
                onDragEnd={onQueueDragEnd}
              >
                <span className="chat-queue-grip" aria-hidden="true">
                  <ChatInputAreaGlyph01 />
                </span>
                <span className="chat-queue-text">
                  {(item.attachments ?? (item.attachment ? [item.attachment] : [])).map((file) => `[附件] ${file.name}`).join(" ")}{item.attachments?.length || item.attachment ? " " : ""}
                  {item.text}
                </span>
                <button
                  type="button"
                  className="chat-queue-act"
                  onClick={() => steerQueueItem(item)}
                  title={t("steerTitle")}
                  aria-label={t("steer")}
                  aria-busy={steerInFlight.has(item.id)}
                  disabled={steerInFlight.has(item.id)}
                >
                  {/* 向上插入语义（参考豆包 Work 上传/插入图标）：箭头 + 底部基线 */}
                  <ChatInputAreaGlyph02 />
                </button>
                <button
                  type="button"
                  className="chat-queue-act"
                  onClick={() => editQueueItem(item)}
                  title={t("edit")}
                  aria-label={t("edit")}
                >
                  <EditIcon />
                </button>
                <button
                  type="button"
                  className="chat-queue-act chat-queue-act--danger"
                  onClick={() => removeQueueItem(item)}
                  title={t("delete")}
                  aria-label={t("delete")}
                >
                  <DeleteIcon />
                </button>
              </div>
            ))}
            {queueNotice ? <div className="chat-queue-notice">{queueNotice}</div> : null}
          </div>
        ) : null}
        <div
          className={`chat-composer${activeAttachments.length ? " has-attachment" : ""}${groupDragOver ? " is-group-drop" : ""}`}
          onDragOver={onGroupDragOver}
          onDragLeave={onGroupDragLeave}
          onDrop={onGroupDrop}
        >
        {activeAttachments.length ? (
          <div className="chat-attachments-list">
          {activeAttachments.map((att, index) => {
            const uploadingNow = "id" in att;
            return (
              <div
                className="chat-attachment-wrap"
                key={"id" in att ? att.id : `${att.url}-${index}`}
                onMouseEnter={(e) => { if (!uploadingNow) showImagePreview(e.currentTarget, att, index); }}
                onMouseLeave={hideImagePreview}
              >
                <div className={`chat-attachment${uploadingNow ? " is-uploading" : ""}`} aria-busy={uploadingNow}>
                  {uploadingNow && <span className="chat-attachment-upload-mask" aria-hidden="true" />}
                  <span className="chat-attachment-icon-wrap">
                    <span className="chat-attachment-icon" aria-hidden="true">
                      {"kind" in att && att.kind === "folder" ? <FolderIcon /> : isImageFile(att) ? <ImageIcon /> : isVideoFile(att) ? <VideoIcon /> : isAudioFile(att) ? <AudioIcon /> : <FileIcon />}
                    </span>
                    <button
                      type="button"
                      className="chat-attachment-remove"
                      onClick={() => clearAttachment(index)}
                      aria-label={t("removeAttachment")}
                    >
                      ×
                    </button>
                  </span>
                  <span className="chat-attachment-name">{att.name}</span>
                  {uploadingNow && (
                    <span className="chat-attachment-progress">
                      <span className="chat-attachment-upload-label">{t("uploading")}</span>
                      {"progress" in att ? att.progress : 0}%
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {visionWarning && !uploading ? <div className="chat-vision-warning">{visionWarning}</div> : null}
          </div>
        ) : null}
        {children}
        </div>
      </div>
      {hoverPreview && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={previewRef}
              className="chat-attachment-preview chat-attachment-preview--float"
              style={{
                left: hoverPreview.rect.left,
                top: previewTop ?? hoverPreview.rect.top - 8,
                visibility: previewTop === null ? "hidden" : "visible",
              }}
              onMouseEnter={() => setHoverPreview(hoverPreview)}
              onMouseLeave={hideImagePreview}
            >
              <img src={hoverPreview.src} alt={hoverPreview.name} onLoad={measurePreview} />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
