import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 聊天区滚动控制（独立 hook，与 AgentWindow 解耦，避免其余改动误伤滚动逻辑）。
 *
 * 职责与关键机制：
 * 1. 普通「跟随底部」：stickToBottom=true 时新 token 滚到底部；用户上滚即停止跟随，
 *    手动滚回底部或点「回到底部」才恢复。
 * 2. 发送后「置顶」（pin）：把刚发的用户消息滚到「距视口顶 PIN_TOP_GAP」处，底部用动态 reserve(spacer) 撑住，
 *    回复未填满前总高度恒定 → 零抖动；置顶位即最大滚动位 → 置顶后下方全是空白、一点也滚不动。
 * 3. 回复结束「冻结」（pinFrozen）：短回复的 reserve 不在结束瞬间撤掉（那会 clamp 造成下坠），
 *    也不随用户上滚消减（否则「上滚一点留白就变小」）；留白定格、视图停在置顶位，用户可自由上滚读历史。
 *    留白直到用户手动滚到底部、点「回到底部」(jumpToBottom) 或发新消息才收掉。
 * 4. 会话/历史加载后的「初始化滚底 + 安定窗口」：页面打开/切会话后异步内容陆续撑高，
 *    用 ResizeObserver 在有界窗口内反复钉底，避免立刻冒出「回到底部」按钮。
 *
 * ── 两个实测踩出来的硬约束（改动前务必读懂，否则复现「LLM 一输出整条列表掉下来」）──
 * 1) 测真实内容高【绝不能】把 spacer 临时置 0 再读 scrollHeight：spacer 归零会让 scrollHeight
 *    骤降、浏览器把 scrollTop clamp 回新上限，随后 spacer 恢复 scrollTop 却不回弹 → 列表下坠。
 *    正确做法：`scrollHeight − 当前 spacer 实际高度` 无侵入反推真实内容高。
 * 2) reserve 必须随内容增高【反向等量缩小】，且用「置顶时捕获的绝对偏移」计算（与当前 scrollTop 无关）。
 */

const INIT_SETTLE_MS = 1200;
// 置顶时用户消息顶部距视口顶的留白。
// .chat-body-inner 本身有 padding-top:20px，置顶会把它滚出视口 → 消息 flush 贴顶、显得拥挤；
// 用这个常量把消息往下推一点。reserve 公式同步减去它，保证「置顶位 == 最大滚动位」，
// 因此既有顶部间距，又不会出现「还能再往下滚一点点」。
const PIN_TOP_GAP = 12;

export interface ChatScrollApi {
  /** 挂到 .chat-body 滚动容器上 */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  /** 挂到 .chat-body 的 ref 回调；容器因 tab 切换重建时重新绑定滚动监听。 */
  bindBodyRef: (element: HTMLDivElement | null) => void;
  /** 挂到消息列表底部的 spacer 上 */
  spacerRef: React.RefObject<HTMLDivElement | null>;
  /** 「回到底部」按钮是否可见 */
  atBottom: boolean;
  /** 「回到底部」按钮点击处理 */
  jumpToBottom: () => void;
  /**
   * 未读新消息计数：用户滚离底部（atBottom=false）期间到达的新消息条数，
   * 用于「回到底部」箭头正上方的「x 条新消息」小字。回到底部 / 手动滚回底部 /
   * 发送消息 / 切换会话时自动清零。调用方在收到他人新消息时调用 markUnread 累加。
   */
  unreadCount: number;
  /** 到达 N 条未读新消息（在底部时不计，消息已可见） */
  markUnread: (n: number) => void;
  /**
   * 跳转到指定消息并尽量垂直居中（跨会话搜索定位用）。
   * 关键点：直接关闭「跟随底部」并停止初始化钉底，使视图稳稳停在该消息上、
   * 不会被 syncStreamScroll 的跟随逻辑重新钉回底部；命中返回 true，元素未挂载返回 false。
   */
  scrollToMessage: (i: number, behavior?: ScrollBehavior) => boolean;
  /** 用户通过侧边滑块等非聊天容器区域滚动时，提前记录滚动方向 */
  onUserScrollIntent: (deltaY: number) => void;
  /** 发送新消息后调用（在 setMessages 之前同步调用） */
  markSend: () => void;
  /** 切换会话 / 新建会话时调用，重置滚动状态并标记初始化滚底 */
  resetScrollState: () => void;
}

export function useChatScroll(opts: {
  messages: readonly unknown[];
  busy: boolean;
  booting: boolean;
  /**
   * 发送后是否置顶刚发的用户消息（人机聊天默认 true：预留回复空白、置顶用户提问）。
   * 群聊传 false：发送后直接跟随底部，让刚发的消息可见（to bottom），
   * 不再把用户消息顶到视口顶部，统一「发完滚到底」的体验。
   */
  pinOnSend?: boolean;
  /**
   * 跨会话搜索「跳转定位消息」时挂的抑制开关：为 true 时，本次切会话的
   * 「初始化滚底 + 安定窗口（ResizeObserver 反复钉底）」整体跳过，且不再跟随底部，
   * 让 AgentWindow 的 scrollToMsg 能稳稳落在目标消息上，而不是被重新钉回底部。
   * 由 AgentWindow 在发起跳转（目标会话≠当前会话）时置 true，本 hook 在 init 分支消费后清回 false。
   */
  initScrollDisabledRef?: React.MutableRefObject<boolean>;
}): ChatScrollApi {
  const { messages, busy, booting, pinOnSend = true, initScrollDisabledRef } = opts;

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const bindBodyRef = useCallback((element: HTMLDivElement | null) => {
    bodyRef.current = element;
    setScrollElement(element);
  }, []);
  const spacerRef = useRef<HTMLDivElement | null>(null);

  // 未读新消息计数：滚离底部期间到达的新消息数（回底箭头上的「x 条新消息」）。
  // 回到底部 / 手动滚回底部 / 发送消息 / 切换会话时清零（见 clearUnread 的各调用点）。
  const [unreadCount, setUnreadCount] = useState(0);
  const unreadCountRef = useRef(0);

  // 自动滚动策略：默认跟随最新内容滚到底部；用户手动上滚 → 停止；手动回到底部或点箭头 → 恢复。
  const stickToBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  // 会话/历史加载完成后的「初始化滚底」标记：syncStreamScroll 见到后无条件滚底（覆盖 onScroll 竞态）。
  const scrollInitPendingRef = useRef(false);
  // 「回到底部」平滑滚动动画进行中：期间忽略 scroll 事件，避免误判为「用户手动滚动」。
  const jumpAnimatingRef = useRef(false);
  // 发送后置顶模式（pin）：把刚发的用户消息滚到视口顶，给 LLM 回复预留下方空间。
  const pinActiveRef = useRef(false);
  const pinPendingRef = useRef(false);
  // 置顶时捕获的目标 scrollTop（= 消息顶 flush 视口顶）与用户消息相对内容顶的绝对偏移。
  const pinnedScrollTopRef = useRef(0);
  const pinnedUserOffsetRef = useRef(0);
  // 置顶后用户是否手动滚动过：一旦 true，overflow 时不再自动跟随底部。
  const userScrolledSincePinRef = useRef(false);
  // 答复结束后的「冻结」阶段（短回复、reserve 仍在）：留白定格不动（与 WorkBuddy 一致），
  // 用户可自由上滚读历史；仅当用户滚到列表最底（含留白底）或点箭头时才收掉留白并跟随底部。
  // 注意：此阶段 reserve 不随上滚消减——否则「上滚一点留白就变小」会复现。
  const pinFrozenRef = useRef(false);
  // 程序主动滚动标记：记录期望到达的 scrollTop 目标值；仅当实际位置与目标吻合才忽略 scroll 事件。
  const programmaticScrollRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const jumpTokenRef = useRef(0);
  const lastDownIntentAtRef = useRef(0);
  const pointerScrollingRef = useRef(false);

  // 初始化「安定窗口」：ResizeObserver + 超时封顶。
  const initSettleUntilRef = useRef(0);
  const initPinnedTopRef = useRef(0);
  const initResizeObsRef = useRef<ResizeObserver | null>(null);

  const stopInitSettle = () => {
    initSettleUntilRef.current = 0;
    if (initResizeObsRef.current) {
      initResizeObsRef.current.disconnect();
      initResizeObsRef.current = null;
    }
  };

  const pauseFollowing = () => {
    stickToBottomRef.current = false;
    userScrolledSincePinRef.current = true;
    lastDownIntentAtRef.current = 0;
    scrollInitPendingRef.current = false;
    pinPendingRef.current = false;
    stopInitSettle();
    if (jumpAnimatingRef.current) {
      jumpTokenRef.current++;
      jumpAnimatingRef.current = false;
      const el = bodyRef.current;
      if (el) el.scrollTo({ top: el.scrollTop, behavior: "instant" });
    }
  };

  const resumeFollowing = () => {
    const el = bodyRef.current;
    if (!el) return;
    if (pinActiveRef.current || pinFrozenRef.current) {
      const sp = spacerRef.current;
      if (sp) sp.style.height = "0px";
      pinActiveRef.current = false;
      pinFrozenRef.current = false;
    }
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    programmaticScrollRef.current = el.scrollTop;
    stickToBottomRef.current = true;
    userScrolledSincePinRef.current = false;
    lastDownIntentAtRef.current = 0;
    if (!atBottomRef.current) {
      atBottomRef.current = true;
      setAtBottom(true);
    }
    // 回到底部：滚离底部期间累计的未读新消息全部可见，清掉计数。
    clearUnread();
  };

  const clearUnread = () => {
    if (unreadCountRef.current === 0) return;
    unreadCountRef.current = 0;
    setUnreadCount(0);
  };

  const markUnread = (n: number) => {
    if (n <= 0 || atBottomRef.current) return; // 在底部时新消息已可见，不累计
    unreadCountRef.current += n;
    setUnreadCount(unreadCountRef.current);
  };

  const onUserScrollIntent = (deltaY: number) => {
    const el = bodyRef.current;
    if (!el || deltaY === 0) return;
    if (deltaY < 0) {
      pauseFollowing();
    } else {
      lastDownIntentAtRef.current = Date.now();
      if (!stickToBottomRef.current &&
        el.scrollHeight - el.clientHeight - el.scrollTop < 8) {
        resumeFollowing();
      }
    }
  };

  const syncAtBottom = (el: HTMLDivElement) => {
    const totalHeight = el.scrollHeight;
    const reserveH = spacerRef.current?.getBoundingClientRect().height ?? 0;
    const contentH = Math.max(0, totalHeight - reserveH);
    // 置顶/冻结时底部有预留空白。用户从置顶位上滚后，应按置顶位判断是否离开底部；
    // 仅用真实内容高度会把预留空白扣掉，误判为仍在底部，导致返回箭头不出现。
    const leftPinnedPosition = (pinActiveRef.current || pinFrozenRef.current) &&
      userScrolledSincePinRef.current && pinnedScrollTopRef.current - el.scrollTop > 8;
    const isAtBottom = !leftPinnedPosition && (totalHeight - el.clientHeight <= 4 ||
      contentH - el.scrollTop - el.clientHeight < 8);
    if (isAtBottom !== atBottomRef.current) {
      atBottomRef.current = isAtBottom;
      setAtBottom(isAtBottom);
      // 用户手动滚回底部：未读新消息全部可见，清掉计数（回到底部按钮消失）。
      if (isAtBottom) clearUnread();
    }
  };

  const pinToBottom = () => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    programmaticScrollRef.current = el.scrollTop;
    lastScrollTopRef.current = el.scrollTop;
    initPinnedTopRef.current = el.scrollTop;
  };

  const startInitSettle = () => {
    stopInitSettle();
    initSettleUntilRef.current = Date.now() + INIT_SETTLE_MS;
    const inner = bodyRef.current?.querySelector(".chat-body-inner") as HTMLElement | null;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (Date.now() > initSettleUntilRef.current || !stickToBottomRef.current) {
        stopInitSettle();
        return;
      }
      if (pinActiveRef.current || pinPendingRef.current) return;
      pinToBottom();
      if (!atBottomRef.current) {
        atBottomRef.current = true;
        setAtBottom(true);
      }
    });
    ro.observe(inner);
    initResizeObsRef.current = ro;
    window.setTimeout(() => {
      if (initResizeObsRef.current === ro) stopInitSettle();
    }, INIT_SETTLE_MS + 300);
  };

  const syncStreamScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const spacer = spacerRef.current;

    // ① 会话/历史加载完成：无条件初始化滚底（booting 期间内容未挂载，先跳过等重入）。
    if (scrollInitPendingRef.current) {
      if (booting) return;
      scrollInitPendingRef.current = false;
      // 跨会话搜索「跳转定位消息」：本次切会话不应自动滚底，否则会把定位目标重新钉回底部。
      // 直接跳过 init 钉底 + 安定窗口，并关闭「跟随底部」，交还给 AgentWindow 的 scrollToMsg。
      if (initScrollDisabledRef?.current) {
        initScrollDisabledRef.current = false;
        stickToBottomRef.current = false;
        atBottomRef.current = false;
        setAtBottom(false);
        return;
      }
      stickToBottomRef.current = true;
      atBottomRef.current = true;
      setAtBottom(true);
      pinToBottom();
      startInitSettle();
      return;
    }

    // ① 维护 reserve（无侵入测量：scrollHeight − 当前 spacer 实际高度）。
    if (spacer) {
      if (pinActiveRef.current || pinPendingRef.current) {
        const V = el.clientHeight;
        const curSpacer = spacer.getBoundingClientRect().height;
        const contentH = Math.max(0, el.scrollHeight - curSpacer);
        const userMsgs = el.querySelectorAll(".msg.user");
        const lastUser = userMsgs[userMsgs.length - 1];
        if (lastUser) {
          // 置顶中：偏移固定为捕获的置顶位（已含 PIN_TOP_GAP），避免用户滚动时 reserve 跟着变大（否则可无限下滚）。
          // 待置顶：偏移现量，并同样预留顶部间距，使 ② 里的置顶位恰好等于最大滚动位。
          const base = pinActiveRef.current
            ? pinnedUserOffsetRef.current
            : lastUser.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
          const userTop = pinActiveRef.current ? base : Math.max(0, base - PIN_TOP_GAP);
          // reserve 使「置顶位」就是「最大滚动位」：置顶后下方全是空白、不能再往下滚。
          const need = Math.max(0, userTop + V - contentH);
          // ★ 关键：need 必须能精确归零。否则会因下方 `>= 1` 的更新阈值卡在 0.x px（如 0.8px），
          // 导致 ③ 的 `reserveLeft < 1` 永远不成立 → 置顶后无法切回底部跟随（自动滚动被破坏）。
          if (need < 1) {
            if (curSpacer !== 0) spacer.style.height = "0px";
          } else if (Math.abs(need - curSpacer) >= 1) {
            spacer.style.height = need + "px";
          }
        }
      } else if (!pinFrozenRef.current && spacer.style.height !== "" && spacer.style.height !== "0px") {
        // 冻结阶段不在此归零：留白由 pinFrozen 逻辑定格，直到用户滚到底部才收掉。
        spacer.style.height = "0px";
      }
    }

    // ② 一次性置顶：reserve 先就位后，把刚发的用户消息滚到「距视口顶 PIN_TOP_GAP」处（仅执行一次），随后关闭底部跟随。
    if (pinPendingRef.current) {
      pinPendingRef.current = false;
      const userMsgs = el.querySelectorAll(".msg.user");
      const lastUser = userMsgs[userMsgs.length - 1];
      if (lastUser) {
        const cRect = el.getBoundingClientRect();
        const mRect = lastUser.getBoundingClientRect();
        // 置顶位 = 消息顶再下移 PIN_TOP_GAP（不贴顶，留一点呼吸空间；内容不够时钳到 0）。
        // 由于 ① 的 reserve 已按同一偏移预留，此处 scrollTop 正好等于 maxScroll → 置顶后不能再往下滚。
        const base = el.scrollTop + (mRect.top - cRect.top);
        const target = Math.max(0, base - PIN_TOP_GAP);
        pinnedScrollTopRef.current = target;
        pinnedUserOffsetRef.current = target; // 绝对偏移，reserve 据此维持总高度恒定
        el.scrollTop = target;
        programmaticScrollRef.current = el.scrollTop; // 吞掉这次程序滚动派发的 scroll 事件
        lastScrollTopRef.current = el.scrollTop;
        pinActiveRef.current = true;
        userScrolledSincePinRef.current = false;
        stickToBottomRef.current = false;
        // 置顶后下方全是预留空白，没有真实消息被输入区挡住，强制隐藏「回到底部」按钮。
        if (!atBottomRef.current) {
          atBottomRef.current = true;
          setAtBottom(true);
        }
        // DEBUG: 短消息列表置顶不到位的诊断日志。若复现问题，请把控制台输出贴给我。
        // eslint-disable-next-line no-console
        console.log("[pin pending]", {
          base,
          target,
          scrollTopAfter: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          maxScroll: el.scrollHeight - el.clientHeight,
          need: spacer ? parseFloat(spacer.style.height || "0") : 0,
        });
        // 防御：某些浏览器/layout 延迟会导致 scrollTop 被 clamp 到较小值，下一帧再校验一次。
        const expected = target;
        requestAnimationFrame(() => {
          const body = bodyRef.current;
          if (!body || expected <= 0 || !pinActiveRef.current || userScrolledSincePinRef.current) return;
          const max = body.scrollHeight - body.clientHeight;
          if (Math.abs(body.scrollTop - expected) > 2 && expected <= max + 2) {
            // eslint-disable-next-line no-console
            console.log("[pin pending retry]", { before: body.scrollTop, expected, max });
            body.scrollTop = expected;
            programmaticScrollRef.current = body.scrollTop;
            lastScrollTopRef.current = body.scrollTop;
          }
        });
      }
      return;
    }

    // ③ 置顶进行中：reserve 归零 = 预留空白已被回复填满。
    if (pinActiveRef.current) {
      const reserveLeft = spacer ? spacer.getBoundingClientRect().height : 0;
      if (reserveLeft < 1) {
        if (spacer) spacer.style.height = "0px";
        pinActiveRef.current = false;
        if (!userScrolledSincePinRef.current) {
          stickToBottomRef.current = true;
          el.scrollTop = el.scrollHeight;
          programmaticScrollRef.current = el.scrollTop;
          lastScrollTopRef.current = el.scrollTop;
        }
      }
      syncAtBottom(el);
      return;
    }

    // ④ 普通跟随底部（用户已手动上滚时不干预）。
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      programmaticScrollRef.current = el.scrollTop;
      lastScrollTopRef.current = el.scrollTop;
      if (!atBottomRef.current) {
        atBottomRef.current = true;
        setAtBottom(true);
      }
    }

    // 主动同步「回到底部」按钮显隐：流式置顶期间 scrollTop 恒定、不触发 scroll 事件，
    // 若只在 onScroll 里算，回复超出视口时按钮永不刷新出现。此处用真实内容高（剔除底部 reserve 空白）
    // 判断，与 onScroll 保持一致，保证「下方还有真实内容被挡住」时才提示。
    syncAtBottom(el);
  };

  // onScroll：滚动事件监听。
  useEffect(() => {
    const el = scrollElement;
    if (!el) return;
    let touchY: number | null = null;
    const onPointerDown = (event: PointerEvent) => {
      const right = el.getBoundingClientRect().right;
      pointerScrollingRef.current = event.target === el && right - event.clientX <= 24;
    };
    const onPointerUp = () => { pointerScrollingRef.current = false; };
    const onWheel = (event: WheelEvent) => onUserScrollIntent(event.deltaY);
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY === null || nextY === undefined) return;
      onUserScrollIntent(touchY - nextY);
      touchY = nextY;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if ((event.target as HTMLElement).closest("input, textarea, [contenteditable=true]")) return;
      if (event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" ||
        (event.key === " " && event.shiftKey)) onUserScrollIntent(-1);
      if (event.key === "ArrowDown" || event.key === "PageDown" || event.key === "End" ||
        (event.key === " " && !event.shiftKey)) onUserScrollIntent(1);
    };
    const onScroll = () => {
      if (jumpAnimatingRef.current) return;
      const scrollDelta = el.scrollTop - lastScrollTopRef.current;
      lastScrollTopRef.current = el.scrollTop;
      // 初始化安定窗口内：钉底滚动 + 异步内容增高会派发 scroll 事件，不能当成用户滚动。
      if (initSettleUntilRef.current > Date.now()) {
        if (scrollDelta < -1 || el.scrollTop < initPinnedTopRef.current - 8) {
          pauseFollowing();
        } else {
          programmaticScrollRef.current = null;
          return;
        }
      }
      // 程序主动滚动：仅当位置与目标吻合时忽略本次事件。
      if (programmaticScrollRef.current !== null) {
        const target = programmaticScrollRef.current;
        programmaticScrollRef.current = null;
        if (Math.abs(el.scrollTop - target) < 1) return;
      }
      // 滚动条拖动等没有 wheel/touch 前置信号的情况，用实际向上位移接管滚动。
      if (scrollDelta < -1) pauseFollowing();
      const totalHeight = el.scrollHeight;
      syncAtBottom(el);
      // 仅由近期向下输入或滚动条拖动恢复；浏览器锚定引发的向下 scroll 不能恢复。
      if (scrollDelta > 1 && !stickToBottomRef.current &&
        (Date.now() - lastDownIntentAtRef.current < 500 || pointerScrollingRef.current) &&
        totalHeight - el.clientHeight - el.scrollTop < 8) {
        resumeFollowing();
      }
    };
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("scroll", onScroll);
    };
  }, [scrollElement]);

  // 流式内容变化：同步滚动（初始化滚底 / reserve 维护 / 置顶 / 跟随底部）。
  useEffect(() => {
    syncStreamScroll();
  }, [messages, booting]);

  // 回答结束（busy 变 false）：置顶模式收尾，或普通跟随底部。
  useEffect(() => {
    if (busy) return;
    const el = bodyRef.current;
    if (!el) return;
    if (pinActiveRef.current) {
      // 答复结束、留白仍在（短回复）：不瞬间撤空白（那会 clamp 造成整体下坠），也不随上滚消减。
      // 改为「冻结」：留白定格、视图保持在置顶位，用户可自由上滚读历史（与 WorkBuddy 一致）。
      // 留白直到用户点「回到底部」或发新消息才收掉。
      pinActiveRef.current = false;
      const reserve = spacerRef.current ? spacerRef.current.getBoundingClientRect().height : 0;
      if (reserve > 0) {
        pinFrozenRef.current = true;
        stickToBottomRef.current = false;
      }
      return;
    }
    if (!stickToBottomRef.current) return;
    const id = requestAnimationFrame(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
      programmaticScrollRef.current = el.scrollTop;
      lastScrollTopRef.current = el.scrollTop;
    });
    return () => cancelAnimationFrame(id);
  }, [busy]);

  // 卸载时结束安定窗口，避免 ResizeObserver 长驻。
  useEffect(() => () => stopInitSettle(), []);

  const jumpToBottom = () => {
    const el = bodyRef.current;
    if (!el) return;
    stopInitSettle();
    const jumpToken = ++jumpTokenRef.current;
    jumpAnimatingRef.current = true;
    // 先撤掉 reserve 再滚：否则 scrollTo 目标会把底部空白一起算进去，滚不到真正的内容末尾。
    const sp = spacerRef.current;
    if (sp && sp.style.height !== "0px") sp.style.height = "0px";
    pinActiveRef.current = false;
    pinFrozenRef.current = false;
    const from = el.scrollTop;
    const to = Math.max(0, el.scrollHeight - el.clientHeight);
    const durationMs = 280;
    const finish = () => {
      if (jumpToken !== jumpTokenRef.current) return;
      jumpAnimatingRef.current = false;
      lastScrollTopRef.current = el.scrollTop;
      resumeFollowing();
    };
    if (Math.abs(to - from) < 1) { finish(); return; }
    let startedAt: number | null = null;
    const step = (now: number) => {
      if (jumpToken !== jumpTokenRef.current) return;
      if (bodyRef.current !== el) { jumpAnimatingRef.current = false; return; }
      if (startedAt === null) startedAt = now;
      const progress = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.scrollTop = from + (to - from) * eased;
      if (progress < 1) requestAnimationFrame(step);
      else finish();
    };
    requestAnimationFrame(step);
  };

  const markSend = () => {
    // 发送后置顶刚发的用户消息：等待渲染完成后由 [messages] effect 执行一次性置顶滚动。
    stopInitSettle();
    jumpTokenRef.current++;
    jumpAnimatingRef.current = false;
    lastDownIntentAtRef.current = 0;
    pointerScrollingRef.current = false;
    pinActiveRef.current = false;
    userScrolledSincePinRef.current = false;
    pinFrozenRef.current = false;
    pinnedScrollTopRef.current = 0;
    pinnedUserOffsetRef.current = 0;
    if (pinOnSend) {
      // 人机聊天：置顶刚发的用户消息，下方预留回复空白；发送瞬间先隐藏「回到底部」按钮。
      pinPendingRef.current = true;
      stickToBottomRef.current = false;
    } else {
      // 群聊：发送后直接跟随底部（to bottom），让刚发的消息立即可见；
      // 即使用户此前已上滚，也强制回到底部。
      pinPendingRef.current = false;
      stickToBottomRef.current = true;
    }
    // 发送后下方是真实新消息（或预留给回复的空白），没有「被挡住的真实内容」；
    // 若之前用户滚离底部导致 atBottom=false，这里先把按钮隐藏，避免发送瞬间出现向下箭头。
    if (!atBottomRef.current) {
      atBottomRef.current = true;
      setAtBottom(true);
    }
    // 发送消息即视为回到底部（群聊强制跟随底部 / 人机聊天置顶提问），滚离期间累计的未读一并清掉。
    clearUnread();
  };

  /**
   * 跳转到指定消息并尽量垂直居中，同时关闭「跟随底部」与初始化钉底窗口，
   * 确保 syncStreamScroll 的 ④ 跟随分支不会把视图重新钉回底部（否则跳转动效会瞬间失效）。
   * 命中返回 true，元素尚未挂载返回 false（调用方可重试）。
   */
  const scrollToMessage = (i: number, behavior: ScrollBehavior = "smooth"): boolean => {
    const el = bodyRef.current;
    if (!el) return false;
    const target = el.querySelector<HTMLElement>(`.msg[data-msg-index="${i}"]`);
    if (!target) return false;
    // 关闭跟随底部 + 任何进行中的置顶/钉底，让本次定位成为唯一滚动源。
    stickToBottomRef.current = false;
    pinActiveRef.current = false;
    pinPendingRef.current = false;
    stopInitSettle();
    if (!atBottomRef.current) { atBottomRef.current = false; setAtBottom(false); }
    // 手动居中：以 .chat-body 可见区为基准，把消息中点对齐到其可视区中点（边缘消息由浏览器 clamp）。
    const elRect = target.getBoundingClientRect();
    const scRect = el.getBoundingClientRect();
    const elCenterY = elRect.top - scRect.top + elRect.height / 2 + el.scrollTop;
    const top = elCenterY - el.clientHeight / 2;
    el.scrollTo({ top, behavior });
    lastScrollTopRef.current = el.scrollTop;
    return true;
  };

  const resetScrollState = () => {
    atBottomRef.current = true;
    setAtBottom(true);
    stickToBottomRef.current = true;
    scrollInitPendingRef.current = true;
    stopInitSettle();
    jumpTokenRef.current++;
    jumpAnimatingRef.current = false;
    lastDownIntentAtRef.current = 0;
    pointerScrollingRef.current = false;
    pinActiveRef.current = false;
    pinPendingRef.current = false;
    userScrolledSincePinRef.current = false;
    pinFrozenRef.current = false;
    pinnedScrollTopRef.current = 0;
    pinnedUserOffsetRef.current = 0;
    programmaticScrollRef.current = null;
    lastScrollTopRef.current = bodyRef.current?.scrollTop ?? 0;
    if (spacerRef.current) spacerRef.current.style.height = "0px";
    // 切换会话：未读计数随旧会话一起清空。
    clearUnread();
  };

  return { bodyRef, bindBodyRef, spacerRef, atBottom, jumpToBottom, scrollToMessage, onUserScrollIntent, markSend, resetScrollState, unreadCount, markUnread };
}
