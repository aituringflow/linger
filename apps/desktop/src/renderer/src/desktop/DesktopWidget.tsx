import React from "react";
import { WidgetCaption } from "./WidgetCaption";

/**
 * 桌面组件通用容器：封装边框、边缘拖拽把手、标题栏、鼠标事件。
 * 会话组、文件管理等所有桌面组件都用它作为外壳。
 */
export function DesktopWidget({ id, style, className = "", isEditing = false, isDropTarget = false, title, extra = null, count = null, onOpenMenu, onContextMenu, onDragOver, onDragLeave, onDrop, moveLayoutDrag, finishLayoutDrag, startLayoutDrag, children }: {
  id: string;
  style: React.CSSProperties;
  className?: string;
  isEditing?: boolean;
  isDropTarget?: boolean;
  title: string;
  extra?: string | null;
  count?: { total: number; onClick: () => void } | null;
  onOpenMenu: (x: number, y: number) => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  onDragOver?: (event: React.DragEvent) => void;
  onDragLeave?: (event: React.DragEvent) => void;
  onDrop?: (event: React.DragEvent) => void;
  moveLayoutDrag: (event: PointerEvent) => void;
  finishLayoutDrag: (moved: boolean, event?: PointerEvent) => void;
  startLayoutDrag: (id: string, type: "move" | "resize", event: PointerEvent) => void;
  children: React.ReactNode;
}) {
  return <div key={id} className={`desktop-running-widget ${className}`}
    style={style}
    onMouseDown={(event) => event.stopPropagation()}
    onPointerMove={moveLayoutDrag}
    onPointerUp={(event) => finishLayoutDrag(true, event)}
    onPointerCancel={() => finishLayoutDrag(false)}
    onContextMenu={onContextMenu}
    onDragOver={onDragOver}
    onDragLeave={onDragLeave}
    onDrop={onDrop}>
    {/* 边缘拖拽把手：扩大拖拽范围，hover 到组件边缘就能拖 */}
    <div className="widget-drag-edge widget-drag-edge--top" onPointerDown={(event) => startLayoutDrag(id, "move", event)} />
    <div className="widget-drag-edge widget-drag-edge--bottom" onPointerDown={(event) => startLayoutDrag(id, "move", event)} />
    <div className="widget-drag-edge widget-drag-edge--left" onPointerDown={(event) => startLayoutDrag(id, "move", event)} />
    <div className="widget-drag-edge widget-drag-edge--right" onPointerDown={(event) => startLayoutDrag(id, "move", event)} />
    <WidgetCaption
      title={title}
      extra={extra}
      count={count}
      onOpen={onOpenMenu}
      onMovePointerDown={(event) => startLayoutDrag(id, "move", event)}
    />
    {children}
  </div>;
}
