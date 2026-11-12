/**
 * agent-kit · 服务端 Markdown → HTML（分享公开页用）
 *
 * 与前端 ui/Markdown.tsx 同一套管线：remark-gfm + rehype-raw + rehype-highlight + rehype-sanitize，
 * 保证分享页的 AI 消息渲染效果与聊天区域一致（标题 / 列表 / 表格 / 代码高亮 / 行内样式）。
 * 输出为净化后的 HTML 字符串（剥离 script/iframe/on* 事件，仅放行 style 等安全属性）。
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import type { Schema } from "hast-util-sanitize";

// 与 ui/Markdown.tsx 的 sanitizeSchema 保持一致：
// 放行 style、代码高亮类名（language-* / hljs*）、mark 类名（对话内搜索）；其余默认剥离。
const sanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"],
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style"],
    code: [["className", /^(language-|hljs)/]],
    span: [["className", /^hljs/], ["style"]],
    mark: [["className", /^search-hit$/]],
  },
};

/** 把 markdown 渲染为净化后的 HTML 字符串；渲染失败时回退为转义纯文本（返回 null 表示用纯文本）。 */
export async function renderMarkdownHtml(md: string): Promise<string | null> {
  if (!md) return null;
  try {
    const file = await unified()
      .use(remarkParse)
      .use(remarkGfm)
      // 与 react-markdown 一致：允许 inline HTML 进入 rehype-raw 解析，再由 rehype-sanitize 白名单净化
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeHighlight)
      .use(rehypeSanitize, sanitizeSchema)
      .use(rehypeStringify)
      .process(String(md));
    return String(file);
  } catch (e) {
    console.error("[agent-kit share] markdown render failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
