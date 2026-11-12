import { useChatTranslation } from "./i18n.tsx";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Avatar } from "../shared/AvatarView.tsx";
import { useClickOutside } from "../useClickOutside.ts";

type Props = {
  own?: boolean;
  avatar?: string | null;
  senderName?: string | null;
  signature?: string | null;
  showAvatar?: boolean;
  showName?: boolean;
  replyHint?: string | null;
  bubble: ReactNode;
  /** 气泡外、气泡下方的无背景内容（如语音转写文字，视为系统转写而非用户输入气泡）。 */
  belowBubble?: ReactNode;
  actions?: ReactNode;
  /** 人机（无其他人参与）场景：用户自己的消息操作栏置于气泡底部，而非气泡侧边/上方。 */
  actionsAtBottom?: boolean;
  status?: ReactNode;
  className?: string;
  style?: CSSProperties;
  messageIndex?: number;
  onPointerEnter?: () => void;
  /** 鼠标移出消息操作菜单（点赞/回复/转发/更多 那一栏）时回调，用于关闭表情浮层等。 */
  onActionsMouseLeave?: (event: ReactMouseEvent<HTMLDivElement>) => void;
  selection?: { checked: boolean; onChange: () => void; label: string };
};

/** Shared human-message frame for direct and group conversations. */
export default function HumanMessage({ own, avatar, senderName, signature, showAvatar = false, showName = false, replyHint, bubble, belowBubble, actions, actionsAtBottom = false, status, className = "", style, messageIndex, onPointerEnter, onActionsMouseLeave, selection }: Props) {
  const t = useChatTranslation();
  const messageRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuAbove, setMenuAbove] = useState(false);
  const [menuBelow, setMenuBelow] = useState(false);
  const [touchMenuOpen, setTouchMenuOpen] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const holdStart = useRef<{ x: number; y: number } | null>(null);
  const cancelHold = () => { if (holdTimer.current !== null) window.clearTimeout(holdTimer.current); holdTimer.current = null; holdStart.current = null; };
  // 移动端长按操作菜单：点击消息本体之外任意处关闭
  useClickOutside({
    enabled: touchMenuOpen,
    refs: [messageRef],
    onDismiss: () => setTouchMenuOpen(false),
  });
  useEffect(() => () => { if (holdTimer.current !== null) window.clearTimeout(holdTimer.current); }, []);
  const onMessagePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || !actions || selection || (event.target as Element).closest("button,a,input,video,details,summary,.msg-hover-actions")) return;
    cancelHold();
    holdStart.current = { x: event.clientX, y: event.clientY };
    holdTimer.current = window.setTimeout(() => { holdTimer.current = null; holdStart.current = null; setTouchMenuOpen(true); }, 500);
  };
  const onMessagePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (holdStart.current && Math.hypot(event.clientX - holdStart.current.x, event.clientY - holdStart.current.y) > 10) cancelHold();
  };
  useLayoutEffect(() => {
    if (!actions) return;
    const measure = () => {
      const message = messageRef.current;
      const menu = menuRef.current;
      if (!message || !menu) return;
      const bubble = message.querySelector<HTMLElement>(".bubble") || message;
      const frame = message.closest<HTMLElement>(".chat-body-inner") || message.closest<HTMLElement>(".chat-body") || message.parentElement;
      if (!frame) return;
      const bubbleRect = bubble.getBoundingClientRect();
      const messageRect = message.getBoundingClientRect();
      // 人机（无其他人参与）场景：用户自己的消息操作栏置于气泡底部、右对齐气泡右缘。
      if (actionsAtBottom && own) {
        menu.style.top = `${bubbleRect.bottom - messageRect.top + 6}px`;
        menu.style.left = "auto";
        menu.style.right = `${messageRect.right - bubbleRect.right}px`;
        setMenuAbove(false);
        setMenuBelow(true);
        return;
      }
      // 通用场景：操作菜单默认显示在气泡下方——读完一条消息再顺手点赞/回复/转发，
      // 不用滚回顶部；气泡下方空间不足时回退到上方（保持原有向上定位）。
      // 水平对齐交给 CSS（.has-menu-below：own 右下、peer 左下；.has-menu-above：own 左上、peer 右上），
      // JS 只负责垂直位置，避免内联 left/right 与旧侧边定位规则冲突。
      const frameRect = frame.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const belowRoom = frameRect.bottom - bubbleRect.bottom;
      const above = belowRoom < menuRect.height + 12;
      setMenuAbove(above);
      setMenuBelow(!above);
      menu.style.top = `${(above ? bubbleRect.top : bubbleRect.bottom) - messageRect.top + (above ? -5 : 6)}px`;
      menu.style.left = "";
      menu.style.right = "";
    };
    measure();
    const observer = new ResizeObserver(measure);
    const frame = messageRef.current?.closest<HTMLElement>(".chat-body-inner") || messageRef.current?.closest<HTMLElement>(".chat-body");
    if (frame) observer.observe(frame);
    if (messageRef.current) observer.observe(messageRef.current);
    return () => observer.disconnect();
  }, [actions, own, actionsAtBottom]);
  return <div ref={messageRef} onPointerEnter={onPointerEnter} onPointerDown={onMessagePointerDown} onPointerMove={onMessagePointerMove} onPointerUp={cancelHold} onPointerCancel={cancelHold} onContextMenu={event => { if (window.matchMedia("(pointer: coarse)").matches) event.preventDefault(); }} onClick={selection ? event => {
    if (!(event.target as Element).closest("button,a,input,video,details,summary")) selection.onChange();
  } : undefined} data-msg-index={messageIndex} className={`msg user${own ? " is-own" : " is-peer"}${menuAbove ? " has-menu-above" : ""}${menuBelow ? " has-menu-below" : ""}${touchMenuOpen ? " has-touch-menu" : ""}${showAvatar ? (own ? " is-self" : " is-other") : ""}${showName ? " has-identity" : ""}${className}`} style={style}>
    {showAvatar ? <Avatar name={senderName || t("person")} src={avatar || undefined} size={30} className="msg-person-avatar" title={senderName || t("member")} /> : null}
    {showName || replyHint ? <div className="msg-meta">
      {showName ? <span className="msg-author">{senderName || t("member")}</span> : null}
      {showName && signature ? <span className="msg-signature">{signature}</span> : null}
      {replyHint ? <span className="msg-reply-hint">{replyHint}</span> : null}
    </div> : null}
    <div className="msg-bubble-wrap">
      {selection ? <input type="checkbox" className="cowork-select-check" checked={selection.checked} onChange={selection.onChange} aria-label={selection.label} /> : null}
      {bubble}
      {belowBubble ? <div className="msg-below-bubble">{belowBubble}</div> : null}
      {status}
    </div>
    {actions ? <div ref={menuRef} className="msg-hover-actions" onMouseLeave={onActionsMouseLeave}>{actions}</div> : null}
  </div>;
}
