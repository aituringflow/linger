"use client";

// agent-kit · MessageSlider —— 聊天区侧边消息滑块（对标 ChatGPT / 豆包 minimap）
//
// 行为约定：
// 1. 只在「聊天区宽度足够（≥ SLIDER_MIN_CHAT_W）且内容可滚动」时出现，否则隐藏。
// 2. 一条横线 = 一个「用户提问」（与顶栏「历史」面板口径完全一致：role === "user"），
//    不把 assistant 回复单列；一个会话有 N 个提问就画 N 根。横线宽度按该提问所属
//    整轮（提问+回复）的渲染高度映射（轮次越长线越长，sqrt 缓化差距）。
// 3. 颜色：当前视口能看到的提问 = 亮色（--slider-on）；滚出视口 = 灰色（--slider-off）。
//    深浅主题各有一套变量（见 styles.css 的 :root / :root[data-theme=dark]）。
// 4. hover：横线加宽（随鼠标移动跟手变化），右侧弹出该提问的 tooltip；
//    点击横线跳转到那个提问（与顶栏「历史」面板同款滚动定位，复用宿主的 onJump）。
//
// 实现说明：纯 DOM 测量（.msg[data-msg-index]，仅取 .user 节点），不侵入 useChatScroll
// 的滚动状态机；测量以 rAF 节流，由 scroll / ResizeObserver / messages 变化三处触发。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

/** 聊天区（.chat-body）宽度低于该值时滑块隐藏（窄屏不挤占内容） */
const SLIDER_MIN_CHAT_W = 900;
/** 内容溢出超过该值才视为「可滚动」 */
const OVERFLOW_EPS = 40;
/** 问答轮数（=用户提问数）不足该值时隐藏（短对话无需导航）；含该值本身显示 */
const MIN_ROUNDS = 5;
/** 横线视觉高度（按钮命中区更高，见 CSS background-clip 技巧） */
const DASH_H = 3;
/** 非 hover 时横线的统一宽度（也是渐变衰减的下限） */
const DASH_W = 10;
/** hover 渐变衰减系数：相邻横线宽度 = 上一根 × FALLOFF（友商同款波峰过渡） */
const FALLOFF = 0.62;
/** tooltip 文本截断上限（字符）：超出截断加「…」，配合 CSS max-height 保证最多约 5 行 */
const TIP_MAX_CHARS = 120;
/** 横向轨道：横线间最大间距（消息少时更宽松） */
const GAP_MAX = 10;
/** 轨道可用高度的上下留白（避开顶栏/输入区附近） */
const TRACK_INSET_V = 60;

type SliderMsgLike = { role: string; content: string };

interface SliderItem {
  /** 消息下标（= data-msg-index） */
  key: number;
  /** 所属轮次的用户提问下标（-1 = 前面还没有提问） */
  qIdx: number;
  /** 横线宽度 px */
  w: number;
  /** 是否在当前视口内（亮色） */
  on: boolean;
  /** 轨道内布局 top（tooltip 定位用），与滚动位置无关 */
  top: number;
}

export default function MessageSlider({
  bodyRef,
  messages,
  loading,
  onJump,
  onWheelIntent,
}: {
  /** 挂在 .chat-body 滚动容器上的 ref（与 useChatScroll 共享同一个） */
  bodyRef: React.RefObject<HTMLDivElement | null>;
  messages: readonly SliderMsgLike[];
  loading: boolean;
  /** 点击横线后的跳转回调（宿主传 scrollToMsg 即可） */
  onJump: (msgIndex: number) => void;
  /** 滑块滚轮会转发给聊天区，需要先通知滚动控制逻辑 */
  onWheelIntent: (deltaY: number) => void;
}) {
  const [show, setShow] = useState(false);
  const [items, setItems] = useState<SliderItem[]>([]);
  const [hover, setHover] = useState(-1);
  // tooltip 用 position:fixed 定位（视口坐标），从横线按钮的 getBoundingClientRect 算出。
  // 不能用 absolute + track 内定位：track 仅 64px 宽，绝对定位的 shrink-to-fit 可用宽度
  // 被压到 64px，中文逐字断行会塌成竖排细条（踩坑多次的根因）。
  const [tipPos, setTipPos] = useState({ left: 0, top: 0 });
  const rafRef = useRef(0);
  const aliveRef = useRef(true);

  const measure = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight > OVERFLOW_EPS;
    const wideEnough = el.clientWidth >= SLIDER_MIN_CHAT_W;
    if (loading || !scrollable || !wideEnough) {
      setShow(false);
      setItems([]);
      return;
    }
    // 一条横线 = 一个用户提问（与「历史」面板口径一致）；assistant 回复不单列
    const nodes = Array.from(el.querySelectorAll<HTMLElement>(".msg[data-msg-index]"));
    const userNodes = nodes.filter((n) => n.classList.contains("user"));
    // 问答轮数（用户提问数）不足 MIN_ROUNDS 时隐藏；满 MIN_ROUNDS（含）才显示
    if (userNodes.length < MIN_ROUNDS) {
      setShow(false);
      setItems([]);
      return;
    }
    const bodyRect = el.getBoundingClientRect();
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight;
    const relTop = (n: HTMLElement) => {
      const r = n.getBoundingClientRect();
      return r.top - bodyRect.top + viewTop;
    };
    const relBottom = (n: HTMLElement) => {
      const r = n.getBoundingClientRect();
      return r.bottom - bodyRect.top + viewTop;
    };
    // 最后一条消息（无论角色）的底部，用于推算最后一轮的高度
    const lastBottom = nodes.length ? relBottom(nodes[nodes.length - 1]) : 0;
    // 行距自适应：提问很多时压缩间距（最小 2px），而不是让轨道撑出滚动
    const avail = Math.max(120, el.clientHeight - TRACK_INSET_V * 2);
    const gap =
      userNodes.length > 1
        ? Math.max(2, Math.min(GAP_MAX, (avail - userNodes.length * DASH_H) / (userNodes.length - 1)))
        : 0;
    const pitch = DASH_H + gap;
    const next: SliderItem[] = [];
    for (let u = 0; u < userNodes.length; u++) {
      const node = userNodes[u];
      const idx = Number(node.dataset.msgIndex);
      const qTop = relTop(node);
      // 整轮高度：本轮提问顶 → 下一轮提问顶（最后一轮 → 最后一条消息底）
      const turnBottom = u + 1 < userNodes.length ? relTop(userNodes[u + 1]) : lastBottom;
      const turnH = Math.max(0, turnBottom - qTop);
      // hover 加宽后的宽度：按整轮渲染高度 sqrt 映射（22~38px，偏克制）；
      // 实际渲染时还会按与 hover 的距离做指数衰减（见渲染处 FALLOFF），非 hover 统一 DASH_W
      const w = Math.round(22 + 16 * Math.min(1, Math.sqrt(turnH / 1200)));
      // 亮色判定：该「轮次」（提问 → 下一轮提问/末条消息）只要任意部分进入视口即亮。
      // 即提问可见、或其答案可见、或上一轮答案仍在视口底部而下一轮提问已进入顶部，都算亮。
      const on = qTop < viewBottom - 4 && turnBottom > viewTop + 4;
      next.push({ key: idx, qIdx: idx, w, on, top: next.length * pitch });
    }
    setShow(true);
    setItems(next);
  }, [bodyRef, loading]);

  // rAF 节流：滚动/resize/流式增量高频触发，一帧最多测一次
  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (aliveRef.current) measure();
    });
  }, [measure]);

  // 挂 scroll + ResizeObserver（loading 变化时重挂，频率极低）
  useEffect(() => {
    aliveRef.current = true;
    const el = bodyRef.current;
    if (!el) return;
    schedule();
    const onScroll = () => schedule();
    el.addEventListener("scroll", onScroll, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => schedule());
      ro.observe(el);
    }
    return () => {
      aliveRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [bodyRef, schedule]);

  // messages 变化（流式增量 / 切会话 / 消息增删）→ 重新测量
  useEffect(() => {
    schedule();
  }, [messages, schedule]);

  const trackH = items.length ? items[items.length - 1].top + DASH_H : 0;
  const hoverItem = hover >= 0 ? items[hover] : undefined;
  const hoverText =
    hoverItem && hoverItem.qIdx >= 0 ? messages[hoverItem.qIdx]?.content ?? "" : "";
  const tipText =
    hoverText.length > TIP_MAX_CHARS ? `${hoverText.slice(0, TIP_MAX_CHARS)}…` : hoverText;

  return (
    <div className={`chat-slider${show ? " is-show" : ""}`} aria-hidden={!show}>
      <div
        className="chat-slider-track"
        style={{ height: trackH }}
        onMouseLeave={() => setHover(-1)}
        onWheel={(e) => {
          // 滑块条本身不占滚动：滚轮转发给聊天容器（ChatGPT 同款手感）
          onWheelIntent(e.deltaY);
          const el = bodyRef.current;
          if (el) el.scrollTop += e.deltaY;
        }}
      >
        {items.map((it, k) => {
          const t = it.qIdx >= 0 ? messages[it.qIdx]?.content ?? "" : "";
          // 渐变宽度：hover 那根最宽，相邻横线按距离指数衰减（友商同款「波峰」过渡），
          // 衰减到默认宽度以下就钳到默认宽度；无 hover 时全部为默认宽度
          const dist = hover >= 0 ? Math.abs(k - hover) : -1;
          const wPx =
            dist < 0 ? DASH_W : Math.max(DASH_W, Math.round(it.w * Math.pow(FALLOFF, dist)));
          return (
            <button
              key={it.key}
              type="button"
              className={`chat-slider-dash${it.on ? " is-on" : ""}${k === hover ? " is-hover" : ""}`}
              style={{ top: it.top, "--w": `${wPx}px` } as CSSProperties}
              onMouseEnter={(e) => {
                setHover(k);
                // 视口坐标：气泡改用 fixed 定位（包含块=视口），宽度才能按内容真实撑开。
                // r.right + 18：横线与气泡之间留出一点水平间距
                const r = e.currentTarget.getBoundingClientRect();
                setTipPos({ left: r.right + 18, top: r.top + r.height / 2 });
              }}
              onClick={() => onJump(it.key)}
              aria-label={t ? `跳转到提问：${t.slice(0, 40)}` : "跳转到该消息"}
            />
          );
        })}
      </div>
      {hoverItem ? (
        <div className="chat-slider-tip" style={{ left: tipPos.left, top: tipPos.top }}>
          <span className="chat-slider-tip-text">{hoverText || "（空消息）"}</span>
        </div>
      ) : null}
    </div>
  );
}
