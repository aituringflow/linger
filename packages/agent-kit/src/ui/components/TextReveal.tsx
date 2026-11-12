"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import type { Root } from "hast";
import { nextRevealFrame, revealTextTree, REVEAL_DURATION_MS, type RevealFrame } from "../streamingText.ts";

/** Shared timeline: Markdown and plain thinking text use the same visual timing. */
export function useTextReveal(source: string, streaming: boolean, revealAt?: number) {
  const committed = useRef<RevealFrame | undefined>(undefined);
  const [settled, setSettled] = useState(0);
  const frame = useMemo(() => nextRevealFrame(source, streaming, committed.current, Date.now(), revealAt), [source, streaming, revealAt, settled]);
  useLayoutEffect(() => { committed.current = frame; }, [frame]);
  useEffect(() => {
    const last = frame.ranges.at(-1);
    if (!last) return;
    const timer = setTimeout(() => setSettled((value) => value + 1), Math.max(0, last.endAt + REVEAL_DURATION_MS - Date.now()) + 16);
    return () => clearTimeout(timer);
  }, [frame]);
  return frame;
}

export function RevealSpan({ born, children, ...props }: ComponentPropsWithoutRef<"span"> & { born: number }) {
  // Freeze the delay during this DOM lifetime; rerenders must not accelerate the clock.
  const delay = useMemo(() => Number.isFinite(born) ? `${born - Date.now()}ms` : undefined, [born]);
  if (!delay) return <span {...props}>{children}</span>;
  return <span {...props} key={born} style={{ ...props.style, "--md-reveal-delay": delay } as CSSProperties}>{children}</span>;
}

/** Keep thinking as literal text, including whitespace, rather than parsing Markdown. */
export function StreamingText({ text, active }: { text: string; active: boolean }) {
  const frame = useTextReveal(text, active);
  const tree = useMemo(() => revealTextTree({ type: "root", children: [{ type: "text", value: text,
    position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: text.length + 1, offset: text.length } },
  }] } as Root, frame, Date.now()), [text, frame]);
  return <>{tree.children.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    const style = Object.fromEntries(String(node.properties.style).split(";").map((entry) => entry.split(":"))) as CSSProperties;
    return <RevealSpan key={index} born={Number(node.properties["data-md-reveal-at"])} className="md-reveal" style={style}>
      {node.children.map((child) => child.type === "text" ? child.value : "").join("")}
    </RevealSpan>;
  })}</>;
}
