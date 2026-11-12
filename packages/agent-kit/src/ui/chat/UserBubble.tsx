"use client";

import { useChatTranslation } from "./i18n.tsx";

import { useState, type ReactNode } from "react";
import { renderRichText } from "./linkify.tsx";
import LinkPreviewCard from "./LinkPreviewCard.tsx";
import { FileIcon } from "../icons/SharedIcons.tsx";
import { isImageFile } from "./messageUtils.ts";

// 长用户输入折叠：超过 300 字符默认截断，点"展开全部"才显示完整内容。
// 内容里的 "[附件] 文件名" 段渲染为带背景的圆角文件条（文件部分与输入文字明确区分）；
// 图片例外——图片已由媒体区直接展示，不再重复渲染文件名条。
// 折叠只作用于文字部分，文件条始终完整显示。
// 正文里的 URL 由 linkify 自动识别成链接（显示省略时复制还原原始 URL），
// 折叠预算按片段整体结算，避免把 URL 截成半截还挂错误的 href。
// 链接预览卡（unfurl）：Telegram 口径，只对实际渲染出来的第一条链接出一张卡片；
// 卡片在服务端抓取失败时整体静默，行内链接不受影响。
// collapseDisabled：群聊/1v1 协同场景由调用方置 true——长消息不折叠、不显示「展开全部」（人机模式保留折叠）。
// collapseThreshold：自定义折叠阈值（字符数），默认 300；群聊场景传更大值（如 1000），更长的消息才折叠。
export default function UserBubble({ text, highlight, renderText, basePath, collapseDisabled = false, collapseThreshold }: { text: string; highlight?: string; renderText?: (value: string) => ReactNode; basePath?: string; collapseDisabled?: boolean; collapseThreshold?: number }): ReactNode {
  const t = useChatTranslation();
  const [expanded, setExpanded] = useState(false);
  const LONG = 300;
  if (!text) return text;
  const parts: Array<{ type: "text" | "file"; value?: string; name?: string }> = [];
  const re = /\[附件\] ([^\n]*)/g;
  let last = 0;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(text))) {
    if (mm.index > last) parts.push({ type: "text", value: text.slice(last, mm.index) });
    parts.push({ type: "file", name: mm[1].trim() });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  if (parts.length === 0) parts.push({ type: "text", value: text });

  const textLen = parts.reduce((n, p) => n + (p.type === "text" ? (p.value || "").length : 0), 0);
  const threshold = collapseThreshold ?? LONG;
  const collapsed = !collapseDisabled && textLen > threshold && !expanded;
  let budget = collapsed ? threshold : Infinity;
  let cut = false;
  let previewUrl = "";
  const nodes: ReactNode[] = [];
  const pushRich = (value: string, key: string) => {
    const res = renderRichText(value, budget, { highlight, renderText });
    budget = res.budget;
    if (res.cut) cut = true;
    if (!previewUrl && res.firstLink) previewUrl = res.firstLink.raw;
    nodes.push(<span key={key} className="msg-user-text">{res.nodes}</span>);
  };
  parts.forEach((p, i) => {
    if (p.type === "file") {
      // 图片已由上方媒体区（MediaAttachment）直接展示，正文残留的「[附件] 图片名」不再重复渲染文件名条；
      // 其他类型文件仍保留文件名条。
      if (isImageFile({ name: p.name })) return;
      nodes.push(
        <span key={`f${i}`} className="msg-inline-file">
          <span className="msg-inline-file-icon" aria-hidden="true">
            <FileIcon />
          </span>
          <span className="msg-inline-file-name">{p.name}</span>
        </span>
      );
      return;
    }
    if (cut || budget <= 0) {
      cut = true;
      return;
    }
    pushRich(p.value || "", `t${i}`);
  });
  if (collapsed && cut) nodes.push(<span key="tail" className="msg-user-text">…</span>);
  // 链接预览卡：置于正文之后、折叠开关之前
  if (previewUrl) nodes.push(<LinkPreviewCard key="preview" url={previewUrl} basePath={basePath} />);
  if (!collapseDisabled && textLen > threshold) {
    if (collapsed) {
      // 折叠尾部渐隐罩：盖在被截断文字的最后几行上，营造"内容淡出"的小毛玻璃过渡
      nodes.push(<div key="fade" className="chat-expand-fade" aria-hidden="true" />);
    }
    nodes.push(
      <div key="toggle" className="chat-expand-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? t("collapse") : t("expandAll")}
      </div>
    );
  }
  return <>{nodes}</>;
}
