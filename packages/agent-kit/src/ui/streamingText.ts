import type { Element, Root, RootContent, Text } from "hast";

/** Visual timing only. The entire received answer is always present in the DOM. */
// 单段文字从暗到完全显现的时长（毫秒）；越小，半透明尾巴越短。
export const REVEAL_DURATION_MS = 180;
// 同一批文字从头到尾的最大错峰间隔（毫秒）；越小，整体显现越紧凑。
export const REVEAL_STAGGER_MS = 40;
const MAX_REVEAL_CHARS = 1200;
const MAX_REVEAL_RUNS = 96;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type RevealRange = { start: number; end: number; at: number; endAt: number };
export type RevealFrame = { content: string; streaming: boolean; ranges: RevealRange[] };

/** Source offsets survive Markdown re-parsing (e.g. a closing ** or table delimiter). */
export function nextRevealFrame(content: string, streaming: boolean, previous: RevealFrame | undefined, now: number, revealAt?: number): RevealFrame {
  const append = previous ? content.startsWith(previous.content) : true;
  const ranges = append ? (previous?.ranges ?? []).filter((range) =>
    now < range.endAt + REVEAL_DURATION_MS) : [];
  // A replacement or a history mount must not replay an already visible answer.
  const recent = revealAt !== undefined && now - revealAt < REVEAL_DURATION_MS + REVEAL_STAGGER_MS;
  if (append && (streaming || previous?.streaming || recent)) {
    const start = Math.max(previous?.content.length ?? 0, content.length - MAX_REVEAL_CHARS);
    if (content.length > start) {
      const received = Math.min(now, revealAt ?? now);
      // Later packets cannot overtake the end of an earlier packet. Compress their
      // stagger window instead of accumulating a display queue.
      const at = Math.max(received, ranges.at(-1)?.endAt ?? received);
      ranges.push({ start, end: content.length, at, endAt: Math.max(at, received + REVEAL_STAGGER_MS) });
    }
  }
  return { content, streaming, ranges };
}

/** Wrap only the recent tail, after sanitization. Never create a span per historical character. */
export function revealTextTree(tree: Root, frame: RevealFrame, now: number): Root {
  if (!frame.ranges.length) return tree;
  const first = frame.ranges[0].start;
  const activeChars = frame.ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  const runSize = Math.max(4, Math.ceil(activeChars / MAX_REVEAL_RUNS));
  let runs = 0;
  const walk = (parent: Root | Element) => {
    const children: RootContent[] = [];
    for (const node of parent.children) {
      if (node.type === "element") {
        // Keep code highlighting, copy/paste, and embedded controls untouched.
        if (!["pre", "code", "svg", "math", "textarea"].includes(node.tagName)) walk(node);
        children.push(node);
        continue;
      }
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (node.type !== "text" || start === undefined || end === undefined || end <= first || end <= start) {
        children.push(node);
        continue;
      }
      const text = node.value;
      const boundaries = graphemes.segment(text);
      // Entities/escaped punctuation can occupy more source characters than rendered characters.
      const toTextOffset = (offset: number) => Math.max(0, Math.min(text.length,
        Math.ceil((offset - start) * text.length / (end - start))));
      let cursor = 0;
      const plain = (value: string) => { if (value) children.push({ type: "text", value }); };
      for (const range of frame.ranges) {
        if (range.end <= start || range.start >= end) continue;
        const rawFrom = toTextOffset(range.start);
        const rawTo = toTextOffset(range.end);
        const from = Math.max(cursor, boundaries.containing(rawFrom)?.index ?? rawFrom);
        const last = rawTo > 0 ? boundaries.containing(rawTo - 1) : undefined;
        const to = Math.max(from, last ? last.index + last.segment.length : rawTo);
        plain(text.slice(cursor, from));
        const segments = [...graphemes.segment(text.slice(from, to))];
        for (let i = 0; i < segments.length; i += runSize) {
          const group = segments.slice(i, i + runSize);
          const value = group.map((segment) => segment.segment).join("");
          const sourceOffset = start + (from + group[0].index) * (end - start) / text.length;
          const fraction = Math.max(0, Math.min(1, (sourceOffset - range.start) / Math.max(1, range.end - range.start)));
          const stagger = (range.endAt - range.at) * fraction;
          const spanTime = Math.max(.1, (range.endAt - range.at) * value.length * (end - start) / text.length / Math.max(1, range.end - range.start));
          // The mask's soft band spans the whole fade duration, in this run's local
          // coordinates. A new run continues the preceding ramp rather than resetting
          // a full dark-to-white gradient every four characters.
          const band = REVEAL_DURATION_MS / spanTime * 100;
          const age = now - range.at - stagger;
          if (age >= REVEAL_DURATION_MS + spanTime || !value.trim()) {
            plain(value);
          } else {
            runs++;
            children.push({
              type: "element", tagName: "span",
              properties: {
                className: ["md-reveal"],
                "data-md-reveal-at": Math.round(range.at + stagger),
                style: `--md-reveal-duration:${REVEAL_DURATION_MS + spanTime}ms;--md-reveal-band:${band}%;--md-reveal-end:${band + 100}%`,
              },
              children: [{ type: "text", value } as Text],
            });
          }
        }
        cursor = to;
      }
      plain(text.slice(cursor));
    }
    parent.children = children;
  };
  walk(tree);
  if (runs > MAX_REVEAL_RUNS) {
    // Complex Markdown can fragment the tail into many tiny nodes. Settle the entire
    // tail together instead of leaving later unanimated nodes bright ahead of it.
    const settle = (parent: Root | Element) => {
      parent.children = parent.children.flatMap((node): RootContent[] => {
        if (node.type !== "element") return [node];
        if (node.properties["data-md-reveal-at"] !== undefined) return node.children;
        settle(node);
        return [node];
      });
    };
    settle(tree);
  }
  return tree;
}
