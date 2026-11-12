"use client";

// 完整 Markdown 渲染：react-markdown + remark-gfm + rehype-highlight + rehype-raw。
// 支持 GFM（表格 / 删除线 / 任务列表 / 自动链接）、代码块语法高亮、标题、引用、列表等。
// react-markdown 默认把原始 HTML 当纯文本（XSS 安全）；这里用 rehype-raw 解析 HTML 标签，
// 让 LLM 输出里常见的 <span style="color:red"> 等行内样式生效，
// 并用 rehype-sanitize 白名单净化（剥离 script/iframe/事件属性 on*，仅放行 style 等安全属性）。

import React, { type ReactNode } from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import { defaultSchema } from "rehype-sanitize";
import { sanitize } from "hast-util-sanitize";
import type { PluggableList } from "unified";
import type { Schema } from "hast-util-sanitize";
import { revealTextTree } from "../streamingText.ts";
import { KnowledgeChatImage } from "./KnowledgeChatImage.tsx";
import { KnowledgeDocumentLink } from "./KnowledgeDocumentLink.tsx";
import { KnowledgeVideoCard, parseKnowledgeVideoReference } from "./KnowledgeVideoCard.tsx";
import { RevealSpan, useTextReveal } from "./TextReveal.tsx";

export interface MarkdownProps {
  content?: string | null;
  className?: string;
  /** 宿主部署前缀；模型历史回复里的 /api/* 链接据此指向正确的应用路由。 */
  urlBasePath?: string;
  /** 对话内搜索：非空时把正文文本节点中匹配该词（大小写不敏感）的片段包成 <mark> 高亮（代码块/行内代码不处理） */
  highlight?: string;
  /** @提及高亮：传入已知成员名单，正文文本节点中匹配 @名字 的片段包成 <span class="cowork-mention">（代码块/行内代码不处理） */
  mentions?: string[];
  /** 新收到的文字沿 135° 渐入；数据无需等待动画，结束后尾部动画自然收尾。 */
  streaming?: boolean;
  /** 本地接收时间：即使正文和流结束被 React 合并提交，最后一包也能渐入。历史不传。 */
  revealAt?: number;
}

/** 启发式判断一段文本是否带有可渲染的 Markdown 痕迹（标题/列表/引用/代码/表格/行内标记等）。
 *  用于群聊等场景：命中才走完整 Markdown 渲染，否则维持纯文本+链接化渲染，避免误伤普通聊天消息。 */
export function looksLikeMarkdown(text: string): boolean {
  const t = String(text ?? "");
  if (!t || t.length < 2) return false;
  // 成对代码围栏（``` 或 ~~~）
  if ((t.match(/```/g) || []).length >= 2) return true;
  if ((t.match(/~~~+/g) || []).length >= 2) return true;
  // 表格：一行内至少两个 |
  if (/^[^\n]*\|[^\n]*\|/m.test(t)) return true;
  // 行首块级标记
  if (/^#{1,6}\s+\S/m.test(t)) return true;             // ATX 标题
  if (/^>\s?/m.test(t)) return true;                     // 引用
  if (/^\s*[-*+]\s+\S/m.test(t)) return true;            // 无序列表
  if (/^\s*\d+[.)]\s+\S/m.test(t)) return true;          // 有序列表
  if (/^\s*[-*+]\s+\[[ xX]\]\s/m.test(t)) return true;   // 任务列表
  if (/^(\s*[-*_]\s*){3,}$/m.test(t)) return true;       // 水平线
  // 行内成对标记（要求成对且中间非空，降低误报）
  if (/\*\*[^*\n]+?\*\*/m.test(t)) return true;          // **加粗**
  if (/__[^_\n]+?__/m.test(t)) return true;              // __加粗__
  if (/~~[^~\n]+?~~/m.test(t)) return true;              // ~~删除线~~
  if (/`[^`\n]+`/m.test(t)) return true;                 // `行内代码`
  if (/!\[[^\]]*\]\([^)\n]+\)/m.test(t)) return true;    // 图片
  if (/\[[^\]]+\]\([^)\n]+\)/m.test(t)) return true;     // 链接
  // 斜体 *…*：要求边界宽松（前有空白/标点/行首，后有空白/标点/行尾），避免把 "a*b" 当斜体
  if (/(?:^|[\s(（，,：:。;；])\*[^*\s][^*\n]*\*(?=$|[\s)）!！。;；,，.?!:：])/m.test(t)) return true;
  return false;
}

/** 把纯文本 text 中匹配 query 的片段包成 <mark>（保留原文大小写），返回 React 节点数组。 */
export function highlightMatches(text: string, query: string): ReactNode[] {
  const q = (query || "").trim();
  if (!q) return [text];
  const lower = q.toLowerCase();
  const lc = text.toLowerCase();
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let idx = lc.indexOf(lower);
  while (idx !== -1) {
    if (idx > i) out.push(text.slice(i, idx));
    out.push(<mark key={`hl${key++}`}>{text.slice(idx, idx + q.length)}</mark>);
    i = idx + q.length;
    idx = lc.indexOf(lower, i);
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}

// 在默认白名单基础上扩展：
//  - 放行 style 属性（LLM 常输出 <span style="color:red"> 行内样式；react-markdown 会把它转成 React style 对象）；
//  - 放行代码高亮类名（rehype-highlight 生成的 language-* / hljs*），避免被净化掉导致高亮失效；
//    注意：hast-util-sanitize 对同一属性只取第一个匹配条目，多个类名规则必须合并进一个正则。
//  - 放行 mark 标签及其 search-hit 类名（对话内搜索关键字高亮注入，见 highlightRehype）。
const mdTailClass = /^(?:task-list-item|contains-task-list|footnotes|data-footnote-backref|sr-only)$/;

// 注：hast-util-sanitize 的 Schema.attributes 类型未覆盖"正则属性值"（运行时支持 RegExp，
// 类型只列了 string / 二元组 / 嵌套数组），故整体断言为 Schema——正则按官方文档语义生效，
// 其余字段仍遵循 defaultSchema 的结构与含义。
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    // 兜底：覆盖 defaultSchema 未单设 className 的标签（p / h1 / h3~h6）
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style"],
    // 以下标签 defaultSchema 自带 className 规则，必须覆盖并合并正则，否则任务列表/脚注等 className 被剥掉
    li: ["className", mdTailClass],
    ol: ["className", mdTailClass],
    ul: ["className", mdTailClass],
    // 保留默认的 href 等属性；覆盖 a 的白名单会让链接只剩样式、无法点击。
    a: [...(defaultSchema.attributes?.a ?? []), ["className", mdTailClass]],
    h2: ["className", mdTailClass],
    section: ["className", mdTailClass],
    code: [["className", /^(language-|hljs)/]],
    span: [["className", /^(?:hljs|cowork-mention)/], ["style"]],
    mark: [["className", /^search-hit$/]],
  },
} as unknown as Schema;

// rehype 插件：在 hast 树阶段把匹配关键字的 text 节点拆成「文本 + <mark> + 文本」。
// 放在 rehype-sanitize 之前运行，mark 元素随后经白名单放行。
// 跳过 pre / code（代码块与行内代码内不高亮，避免破坏语法高亮）。
// 注意：react-markdown v10 的文本节点由 hast-util-to-jsx-runtime 直接返回字符串，
// 不走 components.text 映射，因此不能靠组件覆盖实现，必须用此 rehype 插件。
function highlightRehype(query?: string) {
  const q = (query || "").trim();
  const lower = q.toLowerCase();
  return (tree: any) => {
    if (!lower) return tree;
    const walk = (nodes: any[]): any[] => {
      const out: any[] = [];
      for (const node of nodes) {
        if (node.type === "element") {
          if (node.tagName === "pre" || node.tagName === "code") {
            out.push(node);
            continue;
          }
          out.push({ ...node, children: walk(node.children || []) });
          continue;
        }
        if (node.type === "text" && typeof node.value === "string") {
          const lc = node.value.toLowerCase();
          let idx = lc.indexOf(lower);
          if (idx === -1) {
            out.push(node);
            continue;
          }
          const children: any[] = [];
          let i = 0;
          while (idx !== -1) {
            if (idx > i) children.push({ type: "text", value: node.value.slice(i, idx) });
            children.push({
              type: "element",
              tagName: "mark",
              properties: { className: ["search-hit"] },
              children: [{ type: "text", value: node.value.slice(idx, idx + q.length) }],
            });
            i = idx + q.length;
            idx = lc.indexOf(lower, i);
          }
          if (i < node.value.length) children.push({ type: "text", value: node.value.slice(i) });
          out.push(...children);
          continue;
        }
        out.push(node);
      }
      return out;
    };
    tree.children = walk(tree.children || []);
    return tree;
  };
}

// rehype 插件：在 hast 树阶段把匹配 @名字 的文本片段包成 <span class="cowork-mention">。
// 放在 rehype-sanitize 之前运行，随后经白名单放行；跳过 pre / code（代码块与行内代码内不高亮）。
// 与 highlightRehype 同模式：react-markdown v10 的文本节点由 hast-util-to-jsx-runtime 直接返回字符串，
// 不走 components.text 映射，必须用此 rehype 插件。
function mentionRehype(names?: string[]) {
  const list = (names || [])
    .map(name => String(name || "").trim())
    .filter(Boolean)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length);
  return (tree: any) => {
    if (!list.length) return tree;
    const re = new RegExp(`(@(?:${list.join("|")}))(?=$|[\\s，。！？?,.!:：])`, "gi");
    const walk = (nodes: any[]): any[] => {
      const out: any[] = [];
      for (const node of nodes) {
        if (node.type === "element") {
          if (node.tagName === "pre" || node.tagName === "code") {
            out.push(node);
            continue;
          }
          out.push({ ...node, children: walk(node.children || []) });
          continue;
        }
        if (node.type === "text" && typeof node.value === "string" && re.test(node.value)) {
          re.lastIndex = 0;
          const children: any[] = [];
          let i = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(node.value)) !== null) {
            if (m.index > i) children.push({ type: "text", value: node.value.slice(i, m.index) });
            children.push({
              type: "element",
              tagName: "span",
              properties: { className: ["cowork-mention"] },
              children: [{ type: "text", value: m[1] }],
            });
            i = m.index + m[1].length;
          }
          if (i < node.value.length) children.push({ type: "text", value: node.value.slice(i) });
          out.push(...children);
          continue;
        }
        out.push(node);
      }
      return out;
    };
    tree.children = walk(tree.children || []);
    return tree;
  };
}

// rehype-sanitize 插件若带自定义 schema 会被 unified 当 preset 校验而抛错，
// 故闭包捕获 sanitizeSchema 后自行调用 hast-util-sanitize。返回单层 transformer，注册时传函数本身。
function sanitizeRehype() {
  return (tree: unknown) => sanitize(tree as never, sanitizeSchema as never);
}

// Group validated links within this message, preserving the first occurrence
// and the original ordering of the distinct retrieved intervals.
function groupKnowledgeVideos() {
  return (tree: any) => {
    const groups = new Map<string, { node: any; hrefs: string[]; seen: Set<string> }>();
    const visit = (node: any): boolean => {
      if (!Array.isArray(node.children)) return false;
      let removed = false;
      node.children = node.children.filter((child: any) => {
        const href = child.type === "element" && child.tagName === "a" && typeof child.properties?.href === "string" ? child.properties.href : "";
        const reference = parseKnowledgeVideoReference(href);
        if (reference) {
          const key = `${reference.libraryId.toLowerCase()}/${reference.hash.toLowerCase()}`;
          const group = groups.get(key);
          if (!group) groups.set(key, { node: child, hrefs: [href], seen: new Set([`${reference.startMs}/${reference.endMs}`]) });
          else {
            const interval = `${reference.startMs}/${reference.endMs}`;
            if (!group.seen.has(interval)) { group.seen.add(interval); group.hrefs.push(href); }
            removed = true;
            return false;
          }
        }
        const childRemoved = visit(child);
        if (childRemoved && ["p", "li"].includes(child.tagName) && child.children.every((item: any) => item.type === "text" && !item.value.trim())) {
          removed = true;
          return false;
        }
        return true;
      });
      return removed;
    };
    visit(tree);
    for (const group of groups.values()) group.node.properties.dataKnowledgeVideoGroup = JSON.stringify(group.hrefs);
  };
}

function MarkdownSpan({ node, children, ...props }: React.ComponentPropsWithoutRef<"span"> & ExtraProps) {
  const born = Number(node?.properties["data-md-reveal-at"]);
  return <RevealSpan born={born} {...props}>{children}</RevealSpan>;
}

// React.memo：消息内容未变化时跳过 react-markdown 全管道（解析/高亮/净化）重新执行。
// 输入框打字触发的父级重渲染不再为每条历史消息重复解析 Markdown——输入卡顿的主要成本之一。
const Markdown = React.memo(function Markdown({ content, className, urlBasePath = "", highlight, mentions, streaming, revealAt }: MarkdownProps) {
  const source = String(content ?? "");
  const frame = useTextReveal(source, Boolean(streaming), revealAt);
  // Keep component types stable across streamed tokens so mounted media is not
  // destroyed and re-created each time react-markdown parses the response.
  const components = React.useMemo(() => ({
    span: MarkdownSpan,
    a: ({ node, href, children, ...props }: React.ComponentPropsWithoutRef<"a"> & ExtraProps) => {
      const documentMatch = /^https:\/\/local-knowledge\.invalid\/v1\/document\/([0-9a-f-]{36})\/(\d+)\/([0-9a-f]{64})$/i.exec(href ?? "");
      if (documentMatch && Number.isSafeInteger(Number(documentMatch[2])) && Number(documentMatch[2]) > 0) return <KnowledgeDocumentLink libraryId={documentMatch[1]} chunkId={Number(documentMatch[2])} hash={documentMatch[3]}>{children}</KnowledgeDocumentLink>;
      const videoReference = parseKnowledgeVideoReference(href);
      let references = videoReference ? [videoReference] : [];
      const group = node?.properties?.dataKnowledgeVideoGroup;
      if (videoReference && typeof group === "string") {
        try { const parsed: unknown = JSON.parse(group); if (Array.isArray(parsed)) references = parsed.map(item => typeof item === "string" ? parseKnowledgeVideoReference(item) : null).filter((item): item is NonNullable<typeof item> => item !== null && item.libraryId === videoReference.libraryId && item.hash === videoReference.hash); } catch { /* Ignore invalid group metadata. */ }
      }
      if (videoReference) return streaming
        ? <span aria-label="视频片段准备中">视频片段准备中…</span>
        : <KnowledgeVideoCard reference={videoReference} references={references}>{children}</KnowledgeVideoCard>;
      const external = typeof href === "string" && /^https?:\/\//i.test(href);
      const resolved = href?.startsWith("/api/") ? `${urlBasePath.replace(/\/+$/, "")}${href}` : href;
      return <a {...props} href={resolved} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>{children}</a>;
    },
    img: ({ node: _node, src, ...props }: React.ComponentPropsWithoutRef<"img"> & ExtraProps) => <KnowledgeChatImage {...props} src={src?.startsWith("/api/") ? `${urlBasePath.replace(/\/+$/, "")}${src}` : src} />,
    table: ({ node: _node, children, ...props }: React.ComponentPropsWithoutRef<"table"> & ExtraProps) => <div className="md-table-wrap" tabIndex={0} role="region" aria-label="表格（可横向滚动）"><table {...props}>{children}</table></div>,
  }), [urlBasePath, Boolean(streaming)]);
  if (!content) return null;
  const now = Date.now();
  const rehypePlugins: PluggableList = [
    rehypeRaw,
    rehypeHighlight,
    sanitizeRehype,
    groupKnowledgeVideos,
    () => (tree) => revealTextTree(tree, frame, now),
    // Search marks are generated from text, after reveal spans get their source positions.
    () => highlightRehype(highlight),
    // @提及高亮在净化之后运行：mention 包成的 span 需先经 sanitize 放行类名，再注入。
    () => mentionRehype(mentions),
  ];
  return (
    <div className={`md${streaming ? " md--streaming" : ""} ${className || ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins}
        components={components}>
        {String(content)}
      </ReactMarkdown>
    </div>
  );
});

export default Markdown;
