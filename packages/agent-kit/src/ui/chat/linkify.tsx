"use client";

// 用户消息里的链接识别（linkify）：把正文中的 URL 变成可点锚点 —— 微信 / Slack / Telegram 的一致体验。
//
// 业界 IM 的六条口径，逐条落地：
//   1. 自动识别，不需要手粘：http(s)、www.、常见 TLD 裸域名、mailto: / tel:；
//   2. 尾标点不吞：「(https://x.com/a).」里的括号按配对计数回退，中英文句读一律裁掉；
//   3. 只放行 http/https/mailto/tel 四种协议，杜绝 javascript: 注入 + rel=noopener noreferrer；
//   4. 长链不刷屏：去掉协议与尾斜杠，超长中段省略显示，href / title 始终保留全量 URL；
//   5. 复制要还原：显示被省略了，复制时由 data-raw-url 还原成原始 URL（见文末 copy 监听）；
//   6. 链接默认保留 target=_blank；桌面宿主的聊天容器会拦截普通点击，
//      优先在右侧浏览器打开，Web 端仍按锚点默认行为打开。
//
// 助手侧不在这里处理：Markdown 正文由 remark-gfm 的 autolink literal 已自动成链。

import { Fragment, type ReactNode } from "react";
import { highlightMatches } from "../components/Markdown.tsx";

/** 切好的片段：普通文本 | 链接。 */
export type LinkToken =
  | { type: "text"; value: string }
  | { type: "link"; raw: string; href: string; label: string };

// 常见顶级域白名单：裸域名（没有协议头）只有命中这里才识别，
// 避免把 "e.g" / "3.14" / "index.html" 之类误判成链接（Slack / linkify-it 同样用 TLD 表兜底）。
// 刻意不收日期/英文常用词类 TLD（date / press / today / life 等），宁漏勿错。
const TLD_LIST = [
  "com", "cn", "net", "org", "io", "co", "ai", "app", "dev", "xyz",
  "edu", "gov", "info", "biz", "tech", "online", "site", "shop", "store",
  "cloud", "top", "vip", "pro", "me", "tv", "cc", "ltd", "group", "world",
  "jp", "kr", "uk", "us", "de", "fr", "sg", "au", "ca", "eu", "ru",
  "中国", "公司", "网络", "网址",
];

const HOST_LABEL = "[a-z0-9\\u4e00-\\u9fa5](?:[a-z0-9\\u4e00-\\u9fa5-]{0,61}[a-z0-9\\u4e00-\\u9fa5])?";
const TLD_ALT = `(?:${TLD_LIST.join("|")})`;
// URL 尾字符集：不含空格与中英文标点（URL 里本不该出现），把这类字符直接甩给普通文本，
// 剩下需要小心处理的英文标点（.,;:!?)】 等）交给 trimTail 逐字符回退。
const TAIL = "[^\\s<>\"'\\u2018\\u2019\\u201c\\u201d，。、；：！？）》」』】…]*";

// 候选匹配：① 带协议 / mailto / tel；② www. 打头；③ 裸域名（多段 host + 白名单 TLD）
const CANDIDATE = new RegExp(
  `(?:https?:\\/\\/|mailto:|tel:)${TAIL}` +
    // www. 打头同样要求命中 TLD 白名单，否则 "www.v2" 这类也会被误判
    `|www\\.(?:${HOST_LABEL}\\.)+${TLD_ALT}(?![a-z0-9\\u4e00-\\u9fa5-])${TAIL}` +
    `|(?:${HOST_LABEL}\\.)+${TLD_ALT}(?![a-z0-9\\u4e00-\\u9fa5-])${TAIL}`,
  "gi"
);

/** 句尾该还给正文的字符（英文 + 成对闭合符号）。
 *  ")"/"]"/"}" 不是一律裁：交给下面的配对计数判断（维基 https://en.wikipedia.org/wiki/A_(b) 这种内部带括号的必须保留）。 */
const TAIL_PUNCT = new Set([".", ",", ";", ":", "!", "?", "'", '"']);

/** 计数字符出现次数（用于括号配对）。 */
function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] === ch) n += 1;
  return n;
}

/** 回退尾部标点：逐个剥掉并把剥掉的字符还给正文；括号按开合配对决定留还是剥。 */
function trimTail(raw: string): string {
  let url = raw;
  while (url.length > 1) {
    const last = url[url.length - 1];
    const pair = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : "";
    if (pair) {
      // 闭符号多于开符号 → 这个收尾的括号属于句子，不属于 URL
      if (countChar(url, pair) < countChar(url, last)) {
        url = url.slice(0, -1);
        continue;
      }
      break;
    }
    if (TAIL_PUNCT.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url;
}

/** 归一化成可安全落进 href 的地址；协议不在白名单里返回 null（不渲染成链接）。 */
function safeHref(url: string): string | null {
  if (/^https?:\/\/[^\s]+/i.test(url)) return url;
  if (/^(?:mailto:|tel:)[^\s]+/i.test(url)) return url;
  // 带上端口的裸地址（如 内网:8080/x）先于「未知协议」判断，否则会被下面的兜底拦掉
  if (/^[a-z0-9][^\s/:]*:\d+(?:\/|$)/i.test(url)) return `http://${url}`;
  // 其他一切 scheme（javascript: / data: / ftp: / file: …）一律不放行
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  return `https://${url}`;
}

/** 链接的显示文本：去掉协议与尾斜杠，超长中段省略（href / title 仍是全量）。
 *  百分号编码的中文路径先解码再显示（%E9%80%9A… → 通…），解码失败保持原样。 */
function displayText(url: string): string {
  let bare = url.replace(/^(?:https?:\/\/|mailto:|tel:)/i, "").replace(/\/+$/, "");
  try {
    bare = decodeURI(bare);
  } catch {
    /* 含非法编码序列：按原文显示 */
  }
  if (bare.length <= 48) return bare;
  return `${bare.slice(0, 32)}…${bare.slice(-8)}`;
}

/** 切词：把正文切成 [文本 | 链接] 序列。纯函数，便于单测。 */
export function tokenizeLinks(input: string): LinkToken[] {
  const text = String(input ?? "");
  if (!text) return [];
  const out: LinkToken[] = [];
  let last = 0;
  CANDIDATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CANDIDATE.exec(text)) !== null) {
    const start = m.index;
    let raw = m[0];
    // 裸域名：前一个字符是单词 / @ / 点 / 斜杠 / 连字符时，说明它是别的词的一部分（邮箱、文件名、路径）
    if (!/^(?:https?:\/\/|mailto:|tel:|www\.)/i.test(raw)) {
      const prev = start > 0 ? text[start - 1] : "";
      if (prev && /[\w.@/+-]/i.test(prev)) {
        CANDIDATE.lastIndex = start + 1;
        continue;
      }
    }
    raw = trimTail(raw);
    const bare = raw.replace(/^(?:https?:\/\/|mailto:|tel:)/i, "");
    const href = safeHref(raw);
    // 空壳链接（"https://"）不成链；localhost / IP / mailto / tel 不强求点分主机名
    const hostPart = bare.split(/[/?#]/)[0].split(":")[0];
    const shapeOk =
      bare.length > 0 &&
      (bare.includes(".") || hostPart === "localhost" || /^(?:mailto:|tel:)/i.test(raw));
    if (!href || !shapeOk) {
      CANDIDATE.lastIndex = start + 1;
      continue;
    }
    if (start > last) out.push({ type: "text", value: text.slice(last, start) });
    out.push({ type: "link", raw, href, label: displayText(raw) });
    // trimTail 剥掉的标点不单独回写：它仍在原文里，会被下一段普通文本自然带上
    last = start + raw.length;
    CANDIDATE.lastIndex = last;
  }
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}

/**
 * 渲染一段用户正文：自动链接 + 可选的搜索高亮 / @提及。
 * budget 为折叠预算（剩余可见字符数；Infinity 表示不折叠）：按 token 整体结算，
 * 避免把 URL 从中间截断后渲染出一个指向错误地址的半截链接。
 */
export interface RichTextResult {
  nodes: ReactNode[];
  /** 结算后剩余预算 */
  budget: number;
  /** 是否发生了截断 */
  cut: boolean;
  /** 实际渲染出来的第一条链接（供消息级「链接预览卡」取用；被折叠预算跳过的不算） */
  firstLink?: { raw: string; href: string };
}

export function renderRichText(
  value: string,
  budget: number,
  opts: { highlight?: string; renderText?: (v: string) => ReactNode } = {},
): RichTextResult {
  const { highlight, renderText } = opts;
  const inline = (v: string): ReactNode =>
    renderText ? renderText(v) : highlight ? highlightMatches(v, highlight) : v;
  const tokens = tokenizeLinks(value);
  const nodes: ReactNode[] = [];
  let rest = budget;
  let cut = false;
  let firstLink: { raw: string; href: string } | undefined;
  tokens.forEach((t, i) => {
    if (rest <= 0) {
      cut = true;
      return;
    }
    if (t.type === "link") {
      if (!firstLink) firstLink = { raw: t.raw, href: t.href };
      nodes.push(
        <a
          key={`l${i}`}
          className="msg-link"
          href={t.href}
          data-raw-url={t.raw}
          title={t.raw}
          target="_blank"
          rel="noopener noreferrer"
          // 勾选转发 / 消息菜单挂在气泡上，点链接不该顺带触发它们
          onClick={(e) => e.stopPropagation()}
        >
          {highlight ? highlightMatches(t.label, highlight) : t.label}
        </a>,
      );
      rest -= t.raw.length;
      return;
    }
    if (t.value.length > rest) {
      nodes.push(<Fragment key={`t${i}`}>{inline(t.value.slice(0, rest))}</Fragment>);
      rest = 0;
      cut = true;
      return;
    }
    nodes.push(<Fragment key={`t${i}`}>{inline(t.value)}</Fragment>);
    rest -= t.value.length;
  });
  return { nodes, budget: rest, cut, firstLink };
}

// ---------------- 复制还原：显示被省略了，剪贴板里必须是原始 URL ----------------
// 浏览器复制 DOM 文本拿到的是省略后的显示文案，粘贴到别处就成了一个断链。
// 做法是克隆选区内容，把其中带 data-raw-url 的锚点文本替换回原始 URL 再写入剪贴板
//（Slack / Telegram 网页版同口径）。全局只装一个监听，命中才接管。
function installCopyRestore(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("copy", (event) => {
    const selection = typeof window !== "undefined" ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    let frag: DocumentFragment;
    try {
      frag = selection.getRangeAt(0).cloneContents();
    } catch {
      return;
    }
    const holder = document.createElement("div");
    holder.appendChild(frag);
    const anchors = Array.from(holder.querySelectorAll<HTMLAnchorElement>("a[data-raw-url]"));
    if (anchors.length === 0) return;
    for (const a of anchors) {
      const raw = a.getAttribute("data-raw-url");
      if (raw) a.textContent = raw;
    }
    const text = holder.textContent || "";
    if (!text) return;
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
  });
}

installCopyRestore();
