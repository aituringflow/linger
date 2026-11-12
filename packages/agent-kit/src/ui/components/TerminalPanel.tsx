"use client";

import { useEffect, useRef, useState } from "react";
// 仅类型导入：在 SSR 阶段会被擦除，不会触碰 xterm 运行时代码（xterm 在 Node 下会引用 self 导致崩溃）。
import type { ITheme, Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon as XFitAddon } from "@xterm/addon-fit";
import { apiFetch } from "../shared/apiFetch.ts";

/** 终端根目录固定为群容器内的 /group/artifacts（提示符由容器内 bash 的 PS1 输出，前端不再拼提示符）。 */
const DEFAULT_HOST = "group";

/**
 * 终端配色的深浅两套（跟随全站主题）。xterm 只认具体色值、不认 CSS 变量，所以只能在这里写死两份。
 * 注意 background / foreground 必须与 styles-terminal.css 里的 --term-bg / --term-ink 一致，
 * 否则 loading 浮层与终端实底会出现色差。
 */
const DARK_THEME: ITheme = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#e6edf3",
  cursorAccent: "#0d1117",
  selectionBackground: "#2f405c",
  black: "#666666", red: "#ff7b72", green: "#7ee787", yellow: "#e3b341",
  blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#76e3ea", white: "#e6edf3",
  brightBlack: "#8b949e", brightRed: "#ffa198", brightGreen: "#56d364", brightYellow: "#f2cc60",
  brightBlue: "#6cb6ff", brightMagenta: "#dbb7ff", brightCyan: "#76e3ea", brightWhite: "#ffffff",
};

/** 浅色：白底深字（GitHub Light 口径）。ANSI white/brightWhite 必须压成灰阶，
 *  否则白字落在白底上等于不可见。 */
const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#1f2733",
  cursor: "#1f2733",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(47, 107, 255, .22)",
  black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#9a6700",
  blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
  brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#7d4e00",
  brightBlue: "#218bff", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
};

/** 当前已解析主题：shared/theme.ts 把结果写在 <html data-theme="light|dark">。 */
function resolvedTermTheme(): ITheme {
  try { return document.documentElement.dataset.theme === "dark" ? DARK_THEME : LIGHT_THEME; }
  catch { return DARK_THEME; }
}

const MAX_PENDING = 512 * 1024;

/**
 * 编码：unicode 字符串 → base64（服务端 data 帧约定）。
 * 按 UTF-8 字节编码，不再用 `unescape(encodeURIComponent())`：那条路对孤立代理项
 * （输入法中途的半个字符、emoji 边界）会抛错，然后 fallback 成 charCodeAt ⇒ 中文全乱。
 */
function toB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // 分块拼接：String.fromCharCode(...bytes) 在几十万字节时会爆参数个数上限（粘贴大段文本）。
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
/** base64 → 原始字节。解码交给调用处的流式 TextDecoder（见 writeOutput）。 */
function fromB64(text: string): Uint8Array {
  let binary: string;
  try { binary = atob(text); } catch { return new Uint8Array(0); } // 坏帧不要抛进 onmessage
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export default function TerminalPanel({ basePath, sessionId, hostLabel, active = true }: { basePath: string; sessionId: string; hostLabel?: string; active?: boolean }) {
  const hostRef = useRef((hostLabel ?? "").trim() || DEFAULT_HOST);
  const elRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<XFitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const aliveRef = useRef(true);
  const endedRef = useRef(false);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const pendingRef = useRef(0);
  const queueRef = useRef<string[]>([]);
  const drainingRef = useRef(false);
  // 连接状态：首次拉容器/起 PTY 可能要几秒，必须给用户明确反馈，否则看到的就是一块黑面板。
  const [status, setStatus] = useState<"connecting" | "ready" | "reconnecting">("connecting");
  // 重连原因（服务端 1011 附带的 reason）。只显示在浮层里，**不写进终端缓冲区**：
  // 写进缓冲区会在滚动历史里留下一条条「正在重连…」，连接恢复后也擦不掉。
  const [retryReason, setRetryReason] = useState("");

  // 负责 alive 标志与 ws 的最终关闭（与 basePath/sessionId 切换解耦）。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (retryTimerRef.current !== null) { window.clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      wsRef.current?.close();
      wsRef.current = null;
      // term/fit 的释放由下方 [basePath, sessionId] effect 的 cleanup 统一负责，避免双重 dispose。
    };
  }, [sessionId]);

  // 切回终端标签页时自动聚焦：隐藏期间 helper textarea 会失焦，不主动 focus 就要多点一下才能输入。
  useEffect(() => {
    if (active) { try { termRef.current?.focus(); } catch { /* 未就绪时忽略 */ } }
  }, [active]);

  // 终端实例 + WebSocket 的创建与销毁。xterm 仅在浏览器内通过动态 import 加载，规避 SSR 的 self is not defined。
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    let cancelled = false;
    let stopTerminal: (() => void) | null = null;
    const markStatus = (next: "connecting" | "ready" | "reconnecting") => { if (!cancelled) setStatus(next); };
    const markReason = (next: string) => { if (!cancelled) setRetryReason(next); };
    markStatus("connecting");

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !elRef.current) return;

      const term = new Terminal({
        scrollback: 4000,
        cursorBlink: true,
        // 细竖线光标（bar）：block 会占满一个字符格，视觉上过宽。
        // 未聚焦时同样是 bar（block/outline 失焦后容易显得“没有光标”）。
        cursorStyle: "bar",
        cursorWidth: 2,
        cursorInactiveStyle: "bar",
        fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        theme: resolvedTermTheme(),
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(elRef.current);
      // 面板刚挂载时元素可能尚未完成布局（高度/宽度为 0），此时 fit 会算出行/列为 0 并抛错。
      // 首帧 fit 失败不能阻断后续连接：真正的自适应交给 ResizeObserver（其回调已带 try/catch）。
      try { fit.fit(); } catch { /* 待布局完成由 ResizeObserver 重新 fit */ }
      termRef.current = term;
      fitRef.current = fit;
      // 自动聚焦：xterm 仅在聚焦时显示光标；聚焦后隐藏 textarea 才能接收原生粘贴。
      try { term.focus(); } catch { /* 忽略 */ }

      // 跟随全站主题换肤：用户菜单切「外观」或系统偏好变化时，theme.ts 会改写 <html data-theme>，
      // 这里监听该属性并同步 xterm 主题（xterm 只认具体色值，不会自己读 CSS 变量）。
      const themeObserver = new MutationObserver(() => {
        try {
          term.options.theme = resolvedTermTheme();
          term.refresh(0, Math.max(0, term.rows - 1));
        } catch { /* 终端已销毁时忽略 */ }
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      // 一个汉字的 3 个字节可能被 PTY / WS 切到两帧里；逐帧独立解码会把半个字符变成
      // U+FFFD（中文输出里偶发「�」）。同一个流式解码器跨帧续上，才能保证中文完整。
      const decoder = new TextDecoder("utf-8");
      const scheduleDrain = () => {
        if (drainingRef.current || !queueRef.current.length) return;
        drainingRef.current = true;
        const chunk = queueRef.current.splice(0).join("");
        pendingRef.current += chunk.length;
        term.write(chunk, () => {
          pendingRef.current -= chunk.length;
          drainingRef.current = false;
          if (pendingRef.current <= MAX_PENDING / 2) scheduleDrain();
        });
      };
      const writeOutput = (bytes: Uint8Array) => {
        const data = decoder.decode(bytes, { stream: true });
        if (!data) return;
        if (pendingRef.current > MAX_PENDING) { queueRef.current.push(data); scheduleDrain(); return; }
        pendingRef.current += data.length;
        term.write(data, () => {
          pendingRef.current -= data.length;
          if (pendingRef.current <= MAX_PENDING / 2) scheduleDrain();
        });
      };

      const sendResize = () => {
        const socket = wsRef.current;
        const host = elRef.current;
        const cols = term.cols;
        const rows = term.rows;
        // 面板还没布局（display:none / 高度 0）时，fit 会算出退化的 1 行 2 列；
        // 把这种尺寸发给 PTY，vim/less 会变成一条窄带。等真正有尺寸再发。
        if (!host || host.clientHeight < 24 || host.clientWidth < 48) return;
        if (!cols || !rows) return;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: "resize", cols, rows }));
        }
      };

      const connect = async () => {
        if (!aliveRef.current || wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) return;
        let ticket: string | null = null;
        try {
          const response = await apiFetch(`${basePath}/api/realtime-ticket`, { cache: "no-store" });
          if (!response.ok) throw new Error("ticket failed");
          const data = await response.json() as { ticket?: string };
          ticket = typeof data.ticket === "string" ? data.ticket : null;
        } catch { /* 重连时重试 */ }
        if (!aliveRef.current) return;
        const url = new URL(`${basePath}/api/terminal`, window.location.href);
        url.searchParams.set("session", sessionId);
        url.searchParams.set("host", hostRef.current);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(url, ticket ? ["agent-realtime", `ticket.${ticket}`] : []);
        wsRef.current = socket;
        // 新连接重置解码器：上一轮尾部若留了半个字符，别让它和重连回放拼在一起。
        socket.onopen = () => {
          retryRef.current = 0;
          decoder.decode();
          // ★ 连接建立后立刻补发一次尺寸：
          //   ResizeObserver 的首次回调几乎必然早于 socket 打开，那一帧 resize 被丢掉，
          //   之后面板尺寸不变就不会再有回调 → 服务端 PTY 停在 0×0，
          //   vim/less 退回内置 80×24，只占面板左上角一块（用户看到的「没占满」）。
          //   先重新 fit 一次，确保发出去的是当前面板的真实行列数。
          try { fit.fit(); } catch { /* 面板还没布局好，等 ResizeObserver */ }
          sendResize();
        };
        socket.onmessage = (event: MessageEvent) => {
          let frame: Record<string, unknown>;
          try { frame = JSON.parse(String(event.data)); } catch { return; }
          if (frame.op === "ready") { markStatus("ready"); markReason(""); }
          else if (frame.op === "output" && typeof frame.data === "string") {
            // 收到真实输出也视为就绪（服务端 ready 帧丢失时的兜底）。
            markStatus("ready");
            markReason("");
            writeOutput(fromB64(frame.data));
          }
          else if (frame.op === "exit") {
            endedRef.current = true;
            term.write("\r\n\x1b[90m[会话已结束]\x1b[0m\r\n");
            socket.close();
          } else if (frame.op === "error" && typeof frame.message === "string") {
            term.write(`\r\n\x1b[31m[错误] ${frame.message}\x1b[0m\r\n`);
          }
        };
        socket.onclose = (event) => {
          if (wsRef.current !== socket) return;
          wsRef.current = null;
          if (!aliveRef.current) return;
          if (endedRef.current) return;
          markStatus("reconnecting");
          // 服务端 attach 失败会带原因（1011 + reason）。原因只进顶部浮层的小字，
          // 不往终端里写任何文本 —— 重连可能连续发生，写进去就是一堆擦不掉的日志。
          markReason(event.code === 1011 && event.reason ? String(event.reason) : "");
          const delay = Math.min(30_000, 500 * 2 ** Math.min(retryRef.current++, 6)) * (0.8 + Math.random() * 0.4);
          retryTimerRef.current = window.setTimeout(() => { retryTimerRef.current = null; void connect(); }, delay);
        };
        socket.onerror = () => socket.close();
      };

      const sendInput = (data: string) => {
        const socket = wsRef.current;
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ op: "input", data: toB64(data) }));
        } else if (endedRef.current) {
          endedRef.current = false; // 会话已结束：任意输入触发重新开一个会话
          void connect();
        } else if (!socket || socket.readyState === WebSocket.CLOSED) {
          void connect();
        }
      };

      // Ctrl/Cmd+V 粘贴：读取剪贴板并包成 bracketed paste（bash readline 已开启，避免多行立即执行）。
      term.attachCustomKeyEventHandler((event) => {
        if (event.type === "keydown" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key === "v" || event.key === "V")) {
          event.preventDefault();
          void navigator.clipboard?.readText?.().then(text => {
            if (text) sendInput(`\x1b[200~${text}\x1b[201~`);
          }).catch(() => { /* 无剪贴板权限时忽略（可改用右键粘贴/Shift+Insert） */ });
          return false;
        }
        return true;
      });

      const disposeTerm = term.onData(sendInput);
      const ro = new ResizeObserver(() => {
        try { fit.fit(); } catch { /* 面板尚未布局完成 */ }
        sendResize();
      });
      ro.observe(elRef.current);

      void connect();
      stopTerminal = () => {
        themeObserver.disconnect();
        disposeTerm.dispose();
        ro.disconnect();
        wsRef.current?.close();
        wsRef.current = null;
        if (fitRef.current === fit) { fit.dispose(); fitRef.current = null; }
        if (termRef.current === term) { term.dispose(); termRef.current = null; }
      };
    })();

    return () => {
      cancelled = true;
      if (retryTimerRef.current !== null) { window.clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
      wsRef.current?.close();
      wsRef.current = null;
      stopTerminal?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath, sessionId]);

  return (
    <div className="terminal-panel" onClick={() => termRef.current?.focus()}>
      <div className="terminal-host" ref={elRef} aria-label="群容器终端" />
      {status === "connecting" ? (
        <div className="terminal-loading" role="status" aria-live="polite">
          <span className="terminal-loading-spinner" aria-hidden="true" />
          <span>正在启动终端…</span>
        </div>
      ) : status === "reconnecting" ? (
        <div className="terminal-loading-pill" role="status" aria-live="polite">
          <span className="terminal-loading-spinner" aria-hidden="true" />
          <span className="terminal-loading-text">
            <span>连接断开，正在重连…</span>
            {retryReason ? <em className="terminal-loading-hint">{retryReason}</em> : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}
