import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { CHAT_MIN_WIDTH } from "@turingflow/agent-kit/ui";
import WindowFrame from "./WindowFrame";

/**
 * 聊天窗口（Home / 数域）：通用窗口壳 WindowFrame + 聊天专属的那一点配置。
 * 窗口本身的行为（拖动、缩放、最大化、红绿灯、从 Dock 图标展开的入场动画）全部在 WindowFrame 里，
 * 这里只负责把它绑到一条会话窗口上：
 *   · 三颗红绿灯全开（关闭 = 隐藏，会话继续后台跑）；
 *   · 最小宽度跟 chat 中栏的下限一致；
 *   · 入场动画从对应的 Dock 图标展开（Home 圆钮 / 数域图标）；
 *   · 主窗口额外带 focus-primary，供 kit 与火焰皮肤定位输入卡。
 */
export interface FocusWindowFrameProps {
  windowId: string;
  initialOffset?: { x: number; y: number };
  skinId: string;
  style: CSSProperties;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  /** 是否为当前聚焦（最上层）窗口：多窗口时给更亮的边框。 */
  focused?: boolean;
  /** 语音优先极简态：隐藏框架控制按钮，输入区交给 data-voice-mode 处理（只留文字+背景）。 */
  voiceFirstMinimal?: boolean;
  /** 由语音快捷键发起的极简窗口：按答复内容向上增长。 */
  voiceFirstSurface?: boolean;
  /** hover 预览态：整窗已挂载但只显示输入框（其余控件隐藏、不拦截鼠标）；点击后同一实例切换为完整窗口。 */
  preview?: boolean;
  /** 最小化（隐藏但会话继续后台跑）：窗口保持挂载、仅不可见；点 Dock 图标恢复。 */
  minimized?: boolean;
  /** 全屏状态变化：宿主据此把 kit 布局从 grow（窗口向外生长）切成 fixed（侧栏在窗口内挤压）。 */
  onMaximizeChange?: (maximized: boolean) => void;
  /**
   * 窗口几何上报（基准态，即右栏收起时的位置）：宿主据此判断"展开右栏后右侧还剩多少屏幕空间"。
   * 报的是**基准**几何，不含右栏增量 —— 展开时正是要在这个基准上算出还能长多少。
   */
  onGeometryChange?: (geometry: { left: number; right: number; baseWidth: number; viewport: number }) => void;
  /** 右栏当前占用的宽度（0 = 收起）。> 0 时拖右侧边框只调整右栏宽度，不动窗口基准宽。 */
  rightPanelWidth?: number;
  /** 窗口相对基准宽多出来的部分（= 右栏贡献的宽度，默认等于 rightPanelWidth）。 */
  windowExtra?: number;
  /** 拖右侧边框时回调新的右栏宽度与窗口增量。 */
  onRightPanelResize?: (width: number, windowInc: number) => void;
  onMouseLeave?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  /** 拖放：文件管理器载荷经过 / 落在窗口上（宿主把文件接进这个窗口的输入框）。 */
  onArtifactDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onArtifactDrop?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onArtifactDragLeave?: (event: ReactDragEvent<HTMLDivElement>) => void;
  artifactDropActive?: boolean;
  children: ReactNode;
}

/** 该窗口对应的 Dock 图标（入场动画的起点）；找不到就不播动画。 */
function dockIconRect(windowId: string): DOMRect | null {
  const item = windowId === "primary"
    ? document.querySelector<HTMLElement>(".dock-home-item")
    : [...document.querySelectorAll<HTMLElement>(".dock-domain-item")].find((node) => node.dataset.domain === windowId);
  return item?.querySelector<HTMLElement>(".icon-wrap")?.getBoundingClientRect() ?? null;
}

/** A movable chat window inside the Launcher desktop. 内容区由 kit AgentWindow 承担。 */
export default function FocusWindowFrame({
  windowId, initialOffset, skinId, style, onFocus, onClose, onMinimize,
  preview, minimized = false, onMaximizeChange, onGeometryChange,
  rightPanelWidth = 0, windowExtra, onRightPanelResize, onMouseLeave,
  onArtifactDragOver, onArtifactDrop, onArtifactDragLeave, artifactDropActive,
  focused,
  voiceFirstMinimal,
  voiceFirstSurface,
  children,
}: FocusWindowFrameProps) {
  return (
    <WindowFrame
      id={windowId}
      skinId={skinId}
      style={style}
      className={windowId === "primary" ? "focus-primary" : ""}
      initialOffset={initialOffset}
      minWidth={CHAT_MIN_WIDTH}
      preview={preview}
      minimized={minimized}
      appearFrom={() => dockIconRect(windowId)}
      onFocus={onFocus}
      onClose={onClose}
      onMinimize={onMinimize}
      focused={focused}
      voiceFirstMinimal={voiceFirstMinimal}
      voiceFirstSurface={voiceFirstSurface}
      onMaximizeChange={onMaximizeChange}
      onGeometryChange={onGeometryChange}
      rightPanelWidth={rightPanelWidth}
      windowExtra={windowExtra}
      onRightPanelResize={onRightPanelResize}
      onMouseLeave={onMouseLeave}
      onArtifactDragOver={onArtifactDragOver}
      onArtifactDrop={onArtifactDrop}
      onArtifactDragLeave={onArtifactDragLeave}
      artifactDropActive={artifactDropActive}
    >
      {children}
    </WindowFrame>
  );
}
