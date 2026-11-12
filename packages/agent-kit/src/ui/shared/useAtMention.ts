import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatComposerHandle } from "../components/ChatComposer.tsx";

export type MentionCandidate = { id: string; name: string; avatar: string };

/**
 * 输入框 @ 提及：以光标位置为准，向前找到最近的未闭合 "@" 并弹出候选列表。
 * 复用单聊 / 群聊同一套交互：关键字为空即出全部、↑↓ 循环选、Tab/回车选中、Esc 收起。
 *
 * ChatComposer 通过 onValueChange 把最新输入值与光标位置回传这里（输入 / 光标移动 / IME 结束都会触发），
 * 因此本 hook 的 text/caret 始终与输入框同步，可在句中任意位置唤起列表。
 */
export function useAtMention(
  composerRef: { current: ChatComposerHandle | null },
  candidates: MentionCandidate[],
) {
  const [text, setText] = useState("");
  const textRef = useRef("");
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Esc 收起时记录当时的光标位置；光标一动就重新显示。
  const [mentionDismissedAt, setMentionDismissedAt] = useState<number | null>(null);
  const mentionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // @ 提及识别：找到光标前最近的未闭合 "@"。
  // 允许出现在句子任意位置（"你好 @张" 或 "帮我看下@张"），关键字为空表示刚打完 @ 就出列表；
  // 关键字中不允许再出现空白或 @，一旦出现就说明这段 @ 已被编辑完、不再是进行中的提及；
  // @ 前若是字母数字（邮箱、@handle）则不触发，避免误弹列表。
  const mention = useMemo(() => {
    if (caret > text.length) return null;
    const preceding = text.slice(0, caret);
    const at = preceding.lastIndexOf("@");
    if (at < 0) return null;
    if (at > 0 && /[\w.@-]/.test(preceding[at - 1])) return null;
    const query = preceding.slice(at + 1);
    if (/[\s@]/.test(query)) return null;
    return { query: query.toLocaleLowerCase(), start: at, end: caret };
  }, [text, caret]);

  // 过滤：关键字为空显示全部；否则按「前缀优先、再包含」排序，连续输入可逐步收窄清单。
  const mentionOptions = useMemo(() => {
    if (!mention) return [];
    const query = mention.query;
    const unique = candidates.filter((item, index, list) => list.findIndex(other => other.id === item.id) === index && item.name);
    if (!query) return unique;
    const matched = unique.filter(item => item.name.toLocaleLowerCase().includes(query));
    matched.sort((a, b) => {
      const aPrefix = a.name.toLocaleLowerCase().startsWith(query) ? 0 : 1;
      const bPrefix = b.name.toLocaleLowerCase().startsWith(query) ? 0 : 1;
      return aPrefix - bPrefix || a.name.length - b.name.length;
    });
    return matched;
  }, [mention, candidates]);

  // Esc 只收起「当前这一处」：光标一动（继续输入、移动位置）即恢复。
  const visibleMentionOptions = mentionDismissedAt === caret ? [] : mentionOptions;
  // 列表高亮项：过滤结果变化或首次出现时回到第一项；打开期间 ↑↓ 循环移动。
  useEffect(() => { setMentionIndex(0); }, [mention?.start, mention?.query, visibleMentionOptions.length]);
  useEffect(() => {
    if (!visibleMentionOptions.length) return;
    mentionRefs.current[mentionIndex]?.scrollIntoView({ block: "nearest" });
  }, [mentionIndex, visibleMentionOptions.length]);

  const chooseMention = useCallback((name: string) => {
    if (!mention) return null;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.end);
    const inserted = `@${name} `;
    const next = `${before}${inserted}${after}`;
    const caretPosition = before.length + inserted.length;
    textRef.current = next;
    setMentionDismissedAt(null);
    setText(next);
    setCaret(caretPosition);
    setMentionIndex(0);
    composerRef.current?.setText(next, caretPosition);
    requestAnimationFrame(() => { composerRef.current?.focus(); });
    return { text: next, caret: caretPosition };
  }, [mention, text, composerRef]);

  // Home 快捷输入框把已选对象显示为标签；这里只消费正在输入的 @ 查询，正文其余部分保持不变。
  const consumeMention = useCallback(() => {
    if (!mention) return null;
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.end);
    const separator = before && after && !/\s$/.test(before) && !/^\s/.test(after) ? " " : "";
    const next = `${before}${separator}${after}`;
    const caretPosition = before.length + separator.length;
    textRef.current = next;
    setMentionDismissedAt(null);
    setText(next);
    setCaret(caretPosition);
    setMentionIndex(0);
    composerRef.current?.setText(next, caretPosition);
    requestAnimationFrame(() => composerRef.current?.focus());
    return { text: next, caret: caretPosition };
  }, [mention, text, composerRef]);

  // ↑↓ 在候选间循环移动；Tab 选中；Esc 收起列表（正文里的 @ 原样保留，再敲 @ 会重新唤起）。
  const onMentionKeyDown = useCallback((key: string) => {
    if (!visibleMentionOptions.length) return false;
    if (key === "ArrowDown") { setMentionIndex(index => (index + 1) % visibleMentionOptions.length); return true; }
    if (key === "ArrowUp") { setMentionIndex(index => (index - 1 + visibleMentionOptions.length) % visibleMentionOptions.length); return true; }
    if (key === "Tab") { chooseMention(visibleMentionOptions[mentionIndex]?.name || visibleMentionOptions[0].name); return true; }
    if (key === "Escape") { setMentionDismissedAt(caret); return true; }
    return false;
  }, [visibleMentionOptions, mentionIndex, chooseMention, caret]);

  // 回车：若有候选列表则选中第一项（或高亮项），阻止默认发送。
  const onEnter = useCallback(() => {
    if (visibleMentionOptions.length) { chooseMention(visibleMentionOptions[mentionIndex]?.name || visibleMentionOptions[0].name); return true; }
    return false;
  }, [visibleMentionOptions, mentionIndex, chooseMention]);

  const onValueChange = useCallback((value: string, selectionStart: number) => {
    if (value !== textRef.current) {
      textRef.current = value;
      setMentionDismissedAt(null);
    }
    setText(value);
    setCaret(selectionStart);
  }, []);

  return {
    mentionActive: mention !== null && mentionDismissedAt !== caret,
    visibleMentionOptions,
    mentionIndex,
    setMentionIndex,
    mentionRefs,
    chooseMention,
    consumeMention,
    onValueChange,
    onEnter,
    onKeyDownIntercept: onMentionKeyDown,
  };
}
