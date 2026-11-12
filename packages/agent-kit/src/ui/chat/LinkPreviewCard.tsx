"use client";

// 用户消息里的链接预览卡（unfurl）：服务端 /api/link-preview 抓 OG 摘要，这里渲染。
// 口径（Telegram 式）：每条消息只预览第一条链接（由 UserBubble 决定传哪条）；抓取失败整体
// 静默隐藏——卡片只是增强，行内链接本身永远可点。缩略图/favicon 挂了就地隐藏不占位。

import { useEffect, useState, type MouseEvent, type SyntheticEvent } from "react";
import { apiFetch } from "../shared/apiFetch.ts";

export interface LinkPreviewData {
  url: string;
  siteName?: string;
  title?: string;
  description?: string;
  imageUrl?: string;
  faviconUrl?: string;
}

export default function LinkPreviewCard({ url, basePath }: { url: string; basePath?: string }) {
  const [data, setData] = useState<LinkPreviewData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    const base = (basePath || "").replace(/\/+$/, "");
    apiFetch(`${base}/api/link-preview?url=${encodeURIComponent(url)}`)
      .then(async (resp) => {
        if (!resp.ok) throw new Error("no_preview");
        const json = (await resp.json()) as LinkPreviewData;
        if (alive) setData(json);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [url, basePath]);

  if (failed || !data) return null;
  let host = data.url;
  try {
    host = new URL(data.url).hostname.replace(/^www\./i, "");
  } catch {
    /* 保持原样 */
  }
  // 勾选转发 / 消息菜单挂在气泡上，点卡片不该顺带触发它们
  const stop = (e: MouseEvent) => e.stopPropagation();
  const hide = (e: SyntheticEvent<HTMLImageElement>) => {
    e.currentTarget.style.display = "none";
  };
  return (
    <a className="msg-link-preview" href={data.url} target="_blank" rel="noopener noreferrer" onClick={stop}>
      <span className="msg-link-preview-body">
        <span className="msg-link-preview-head">
          {data.faviconUrl ? (
            <img className="msg-link-preview-favicon" src={data.faviconUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={hide} />
          ) : null}
          <span className="msg-link-preview-host">{host}</span>
          <span className="msg-link-preview-more" aria-hidden="true">···</span>
        </span>
        {data.title ? <span className="msg-link-preview-title">{data.title}</span> : null}
        {data.description ? <span className="msg-link-preview-desc">{data.description}</span> : null}
      </span>
      {data.imageUrl ? (
        <img className="msg-link-preview-thumb" src={data.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={hide} />
      ) : null}
    </a>
  );
}
