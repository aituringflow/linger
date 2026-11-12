"use client";

import { useChatTranslation } from "./i18n.tsx";

import type { UiAttachment } from "./types.ts";
import FileTypeIcon, { AttachmentFileIcon, fileTypeKind, isOfficePdfKind } from "../icons/FileTypeIcons.tsx";
import { FolderIcon } from "../icons/SharedIcons.tsx";

function fileSize(bytes?: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FileMessageCard({ file, onOpen, unavailable = false }: { file: UiAttachment; onOpen: () => void; unavailable?: boolean }) {
  const t = useChatTranslation();
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toUpperCase() || t("attachment");
  const size = fileSize(file.size);
  const kind = fileTypeKind(file.name);
  const folder = file.kind === "folder";
  // office/pdf 文件消息用「附件风格」：彩色虚线字母图标（X / W / P / PDF），不再重复显示扩展名小字；
  // 其他格式保持现状（黑白线性图标 + 扩展名小字）。
  const attach = !folder && isOfficePdfKind(kind) && !/\.csv$/i.test(file.name);
  return <button type="button" className="msg-file-card" onClick={onOpen} title={file.name} aria-label={`${folder ? t("openFolder") : t("previewFile")}：${file.name}`}>
    <span className={`msg-file-card-icon${attach ? " msg-file-card-icon--attach" : ""}`} aria-hidden="true">
      {folder ? <FolderIcon /> : attach ? <AttachmentFileIcon kind={kind} /> : <><FileTypeIcon name={file.name} /><small>{extension.slice(0, 5)}</small></>}
    </span>
    <span className="msg-file-card-content"><span className="msg-file-card-name">{file.name}</span><span className="msg-file-card-meta">{unavailable ? t("unavailable") : folder ? t("folder") : [extension, size].filter(Boolean).join(" · ")}</span></span>
    <span className="msg-file-card-open" aria-hidden="true">›</span>
  </button>;
}
