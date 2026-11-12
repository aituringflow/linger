import React, { useRef, useLayoutEffect } from "react";

/**
 * 会话组标题（压在组件顶边上）。
 * 组件边框由 .desktop-running-widget::after 绘制，并按这里实测出的标题盒子把顶边那一段「挖掉」——
 * 所以标题不需要不透明底色，也不会有一条线从文字中间穿过去。
 * 实测用 ResizeObserver：改标题、换字体、窗口缩放都会重新上报。
 */
export function WidgetCaption({ title, extra, count, onOpen, onMovePointerDown }: {
  title: string;
  extra: string | null;
  /** 溢出计数（总数超过可见格位时才有）：点击展开整组列表。 */
  count?: { total: number; onClick: () => void } | null;
  onOpen: (x: number, y: number) => void;
  /** 在标题栏上按下 -> 拖动整个组件（移动把手只在顶部，正文区不再拖动外层）。 */
  onMovePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // 区分「点按开菜单」与「拖动移组件」：按下时记起点，移动超过阈值算拖，否则松手算点按。
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  // 一次「拖动」结束后浏览器仍可能补发 click：用这个标记把那次 click 吞掉，避免误开菜单。
  // 键鼠按 Enter/空格（无障碍）不触发指针序列，标记保持 false，click 正常开菜单。
  const pointerHandledRef = useRef(false);
  useLayoutEffect(() => {
    const caption = ref.current;
    const widget = caption?.parentElement as HTMLElement | null;
    if (!caption || !widget) return;
    const apply = () => {
      const cap = caption.getBoundingClientRect();
      const box = widget.getBoundingClientRect();
      // 边框层是 inset:calc(-1×border-width) 的伪元素，坐标原点正好是 widget 的 border box 左上角。
      widget.style.setProperty("--widget-caption-left", `${cap.left - box.left}px`);
      widget.style.setProperty("--widget-caption-width", `${cap.width}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(caption);
    // 字体加载完成后标题宽度会变一次，补测。
    void document.fonts?.ready.then(apply).catch(() => undefined);
    return () => {
      observer.disconnect();
      widget.style.removeProperty("--widget-caption-left");
      widget.style.removeProperty("--widget-caption-width");
    };
  }, [title]);
  // 计数徽标有自己独立的「展开整组」行为，不走组件移动，也不参与点按开菜单。
  function onCaptionPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    pointerHandledRef.current = false;
    downRef.current = { x: event.clientX, y: event.clientY };
    movedRef.current = false;
    if (event.target instanceof Element && event.target.closest(".desktop-widget-count")) return;
    onMovePointerDown(event);
  }
  function onCaptionPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!downRef.current) return;
    if (Math.hypot(event.clientX - downRef.current.x, event.clientY - downRef.current.y) > 5) movedRef.current = true;
  }
  function onCaptionPointerUp() {
    if (!downRef.current) return;
    downRef.current = null;
    // 拖动过则不点按，并吞掉随后可能补发的 click。
    if (movedRef.current) { pointerHandledRef.current = true; return; }
    // 没拖动：点按开菜单（标题栏任意处都行）。
    pointerHandledRef.current = true;
    const caption = ref.current;
    if (caption) {
      const rect = caption.getBoundingClientRect();
      onOpen(Math.min(rect.left, window.innerWidth - 190), rect.bottom + 5);
    }
  }
  return <div className="desktop-widget-caption" ref={ref}
    onPointerDown={onCaptionPointerDown}
    onPointerMove={onCaptionPointerMove}
    onPointerUp={onCaptionPointerUp}
    onPointerCancel={() => { downRef.current = null; }}>
    <button type="button" className="desktop-widget-title"
      onClick={(event) => {
        // 标题文字本身也能开菜单；若是「拖动后补发的 click」则吞掉。
        if (pointerHandledRef.current) { pointerHandledRef.current = false; return; }
        const rect = event.currentTarget.getBoundingClientRect();
        onOpen(Math.min(rect.left, window.innerWidth - 190), rect.bottom + 5);
      }}>{title}</button>
    {count ? <button type="button" className="desktop-widget-count" title="查看全部会话"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); count.onClick(); }}>· {count.total}</button> : null}
    {extra ? <span>{extra}</span> : null}
  </div>;
}
