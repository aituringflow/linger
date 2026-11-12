/**
 * Web 终端 PTY 会话池：每个 sessionId 一个常驻 bash（Tty:true），
 * 通过 Docker Engine API（dockerode，Windows 走命名管道）与容器内 PTY 双向流桥接。
 *
 * 与旧 REST exec 模型的关系：
 *  - 旧 `execGroupBashTerminal`（一次性 POST）保留不动，供其它调用方使用；
 *  - 侧边栏终端改用本模块：持久 shell + WS 双向转发，git 提示等交互输入可用。
 *
 * 生命周期：
 *  - 懒启动：首个 WS 连接时 ensureGroupContainer + createExec/start(hijack)；
 *  - 断线保活：WS 断开不杀 shell，输出进环形缓冲，重连时先回放；
 *  - 回收：空闲 15min / 总寿命 4h / 全局并发 ≤24，由清扫器定期处理；
 *  - 容器被删时 docker 连带结束 exec，流 'end' 触发清理。
 */
import Dockerode from "dockerode";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { ensureGroupContainer, nameFor, terminalHomeDir } from "./group-container.js";
import { getAgentSession } from "./auth/db.js";

const MAX_SESSIONS = 24;
const RING_MAX = 256 * 1024;
const IDLE_MS = 15 * 60 * 1000;
const LIFETIME_MS = 4 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;
const MAX_BUFFERED = 4 * 1024 * 1024;

type PtyStream = NodeJS.ReadableStream & { write: (chunk: Buffer) => boolean };

type PtySession = {
  sessionId: string;
  container: string;
  exec: Dockerode.Exec;
  stream: PtyStream;
  ring: Buffer[];
  ringBytes: number;
  ws: WebSocket | null;
  lastActivity: number;
  createdAt: number;
  /** 最近一次已应用到 PTY 的窗口尺寸：重连时按新连接方的尺寸重放，避免回到 0×0。 */
  cols: number;
  rows: number;
  /** resize 调用队列：串行执行，保证后到的尺寸最后生效。 */
  sizeQueue: Promise<void>;
};

const SESSIONS = new Map<string, PtySession>();
let client: Dockerode | null = null;

/** 兜底窗口尺寸：docker exec 建 PTY 时不传尺寸 → 内核默认 0×0。
 *  0×0 会让 vim/less 这类全屏程序退回内置的 80×24，只在面板左上角画一小块。 */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
/** 上限：防呆（前端被篡改 / 计算异常时别把 PTY 撑成巨大尺寸）。 */
const MAX_COLS = 999;
const MAX_ROWS = 999;

function dockerClient(): Dockerode {
  if (client) return client;
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("tcp://")) {
    const url = new URL(host);
    client = new Dockerode({ host: url.hostname, port: url.port ? Number(url.port) : 2375 });
  } else {
    client = new Dockerode({ socketPath: process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock" });
  }
  return client;
}

function safeHost(host: string): string {
  const clean = host.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 40);
  return clean || "group";
}

function pushRing(session: PtySession, chunk: Buffer): void {
  session.ring.push(chunk);
  session.ringBytes += chunk.length;
  while (session.ringBytes > RING_MAX && session.ring.length) {
    session.ringBytes -= session.ring[0].length;
    session.ring.shift();
  }
}

function send(ws: WebSocket | null, frame: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_BUFFERED) { ws.close(1013, "slow client"); return; }
  ws.send(JSON.stringify(frame));
}

/** 尽力杀掉指定会话的 PTY 前台进程（exec.inspect() 拿容器内 PID，再精确 kill）。
 *  不 fallback 到 pkill：容器是群共享的，误杀其它终端会话代价太大。 */
async function killSession(session: PtySession): Promise<void> {
  try {
    const info = await session.exec.inspect();
    const pid = info.Pid;
    if (Number.isSafeInteger(pid) && pid > 1) {
      const killer = await dockerClient().getContainer(session.container).exec({
        AttachStdout: false, AttachStderr: false,
        Cmd: ["kill", "-9", String(pid)],
      });
      const kstream = await killer.start({ hijack: false, stdin: false });
      kstream.resume();
      kstream.on("end", () => {});
    }
  } catch (error) {
    console.warn(`[terminal] kill session ${session.sessionId} failed`, error);
  }
  // 兜底：等流自然结束；5s 后仍未结束则原地标记，下次 attach 时重建。
  const timer = setTimeout(() => {
    if (SESSIONS.get(session.sessionId) === session) (session.stream as { end?: () => void }).end?.();
  }, 5000);
  session.stream.once?.("end", () => clearTimeout(timer));
}

/**
 * 终端提示符：`agent@<群/对方名>:<cwd> $`。
 *
 * 用 bash 自带的 `\w`：PTY 的 HOME 就是工作区根 /group/artifacts（见 createSession 的 Env），
 * 所以 `\w` 天然把它缩写成 `~`、子目录 `~/hello`，跑到工作区外（/tmp、/group/uploads）
 * 就显示绝对路径 —— 与常见 shell 的观感一致，也和 `cd ~` 的去处完全对齐。
 */
function promptBashrc(host: string): string {
  return [
    "# 由 agent-kit 生成：每次新建终端 PTY 时覆盖写入（隔离目录，群 AI 不可见）。",
    // \[\e[..m\] 是 readline 的零宽标记，缺了会让光标位置算错（输入长命令时错位）。
    `PS1='\\[\\e[32m\\]agent@${safeHost(host)}\\[\\e[90m\\]:\\[\\e[34m\\]\\w\\[\\e[36m\\]\\$\\[\\e[0m\\] '`,
    "",
  ].join("\n");
}

/** 建会话：容器内 bash -i + TTY，HOME=工作区根，初始化文件指向隔离目录。 */
async function createSession(sessionId: string, host: string): Promise<PtySession> {
  await ensureGroupContainer(sessionId);
  const container = nameFor(sessionId);
  // Debian /etc/bash.bashrc 会覆盖环境 PS1：预写隔离目录里的 .bashrc，
  // 再用 `bash --rcfile <它>` 显式指定 —— 这样 HOME 可以指向工作区而不在 artifacts 里
  // 多出 .bashrc 文件（--rcfile 替代的是 ~/.bashrc，/etc/bash.bashrc 仍会先执行）。
  const homeDir = terminalHomeDir(sessionId);
  await mkdir(homeDir, { recursive: true, mode: 0o777 });
  await writeFile(path.join(homeDir, ".bashrc"), promptBashrc(host), { mode: 0o600 });
  const rcFile = "/group/terminal-home/.bashrc";
  const exec = await dockerClient().getContainer(container).exec({
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    WorkingDir: "/group/artifacts",
    Env: [
      // HOME=工作区根：用户眼里的 `~` 就是群共享的 artifacts（`cd ~` 回家 = 回工作区），
      // 提示符的 `\w` 也因此把 artifacts 显示成 `~`。
      // 历史文件与 npm 缓存仍指到隔离目录，避免命令历史落进群共享目录。
      `HOME=/group/artifacts`,
      `HISTFILE=/group/terminal-home/.bash_history`,
      "TERM=xterm-256color",
      // 必须显式给 UTF-8 locale：node:slim 镜像里 LANG 是空串（POSIX），
      // coreutils 会把中文文件名当成不可打印字节，`ls` 输出 `''$'\350\277\224...'`；
      // readline 更狠，会把用户输入的中文按字节回显成 `\344\270\255`（看起来就像「打不进中文」）。
      // 用 glibc 内置的 C.UTF-8（Debian bookworm 自带，无需装 locales 包）；
      // 写在 exec 的 Env 里对已存在的旧容器同样生效，不必重建群容器。
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      `NPM_CONFIG_CACHE=/group/terminal-home/.npm`,
    ],
    // --rcfile：初始化文件与 $HOME 解耦，HOME 才能安全地指向工作区。
    Cmd: ["bash", "--rcfile", rcFile, "-i"],
  });
  // 注意：Tty 必须同时在 create 与 start 传入，否则 daemon 不分配 PTY（输出走多路复用帧）。
  const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as PtyStream;
  const session: PtySession = {
    sessionId,
    container,
    exec,
    stream,
    ring: [],
    ringBytes: 0,
    ws: null,
    lastActivity: Date.now(),
    createdAt: Date.now(),
    // 0 表示「还没设置过」：docker exec 的 PTY 初始就是 0×0。
    cols: 0,
    rows: 0,
    sizeQueue: Promise.resolve(),
  };
  // exec.start 不带尺寸 → PTY 是 0×0。此刻先给一个兜底尺寸，
  // 真正的尺寸由前端 connect 后的 resize 帧覆盖；没有这一步，
  // 窗口打开的头一两秒里 vim/less 会按 80×24 布局再被拉伸（画面跳动）。
  void applySize(session, DEFAULT_COLS, DEFAULT_ROWS);
  stream.on("data", (chunk: Buffer) => {
    session.lastActivity = Date.now();
    pushRing(session, chunk);
    if (session.ws && session.ws.readyState === WebSocket.OPEN && session.ws.bufferedAmount <= MAX_BUFFERED) {
      session.ws.send(JSON.stringify({ op: "output", data: chunk.toString("base64") }));
    }
  });
  stream.on("error", error => console.error(`[terminal] stream error ${sessionId}`, error));
  const cleanup = () => {
    if (SESSIONS.get(sessionId) === session) SESSIONS.delete(sessionId);
    if (session.ws?.readyState === WebSocket.OPEN) send(session.ws, { op: "exit", code: 0 });
    session.ws = null;
  };
  stream.on("end", cleanup);
  stream.on("close", cleanup);
  // ★ 必须登记进 SESSIONS：
  //   1) 否则每次 WS 连接都会新建一个 bash（容器里会堆出一堆孤儿 shell），
  //      且清扫器遍历空 map、永远不回收；
  //   2) 也导致「断线保活 / 重连复用同一个 shell」形同虚设 ——
  //      重连时拿到的是全新会话，之前的尺寸、cwd、正在跑的程序全丢。
  SESSIONS.set(sessionId, session);
  return session;
}

/**
 * 设置 PTY 窗口尺寸。
 *
 * docker exec 的 PTY 初始是 0×0（内核默认），必须显式 resize 才有真实尺寸；
 * 0×0 时 vim/less 会退回内置的 80×24，只占面板左上角一小块 —— 这就是
 * 「vim 高度没有占满整个页面」的根因。
 *
 * 尺寸没变就直接返回：resize 会给前台进程组发 SIGWINCH，
 * 无意义的重复 resize 会让 vim 反复重绘（画面闪烁）。
 */
async function applySize(session: PtySession, cols: number, rows: number): Promise<void> {
  const w = Math.max(1, Math.min(MAX_COLS, Math.floor(cols)));
  const h = Math.max(1, Math.min(MAX_ROWS, Math.floor(rows)));
  if (session.cols === w && session.rows === h) return;
  session.cols = w;
  session.rows = h;
  // 串行化：exec.resize 走 HTTP，两次并发可能乱序落地，导致最终尺寸不是最后一次请求的。
  // 用一条 Promise 链排队，保证「后到的尺寸最后生效」。
  session.sizeQueue = session.sizeQueue
    .then(async () => {
      try {
        await session.exec.resize({ w, h });
      } catch (error) {
        console.warn(`[terminal] resize ${session.sessionId} to ${w}x${h} failed`, error);
      }
    })
    .catch(() => { /* 链不断：单次失败不影响后续 */ });
  await session.sizeQueue;
}

export async function attachTerminal(sessionId: string, identity: string, host: string, ws: WebSocket): Promise<void> {
  // ★ 帧缓冲：ws 的 message 事件是「无监听器即丢弃」。
  //   下面要做两次 await（getAgentSession 查库 + createSession 起 PTY，各约 0.5~1s），
  //   在这期间前端发来的第一帧 resize 会被 ws 直接丢掉 → PTY 永远停在 0×0 →
  //   vim 只按 80×24 画、占不满面板。所以这里先挂监听并把帧入队，
  //   等会话就绪再严格按到达顺序处理（先入队的先处理，不打乱 input/resize 的先后）。
  const queue: string[] = [];
  let drain: (() => void) | null = null;
  ws.on("message", raw => {
    const text = Buffer.isBuffer(raw) ? raw.toString() : Buffer.from(raw as ArrayBuffer).toString();
    queue.push(text);
    drain?.();
  });

  // 1) 权限：与会话实时订阅同一套校验（realtime subscribe 等价门槛）。
  if (!sessionId || !identity || !await getAgentSession(identity, sessionId)) {
    if (ws.readyState === WebSocket.OPEN) ws.close(1008, "forbidden");
    return;
  }
  // 2) 并发上限。
  if (SESSIONS.size >= MAX_SESSIONS && !SESSIONS.has(sessionId)) {
    if (ws.readyState === WebSocket.OPEN) ws.close(1013, "too_many_sessions");
    return;
  }
  // 3) 复用或新建会话；新建顶掉旧连接。
  //    容器就绪检查只做一次——createSession 内部的 ensureGroupContainer 已含
  //    「running + terminal-home 挂载 + 网关在线」全部判定（且走 dockerode 快路径），
  //    早前这里的 terminalContainerReady + createSession 里的 ensure 是两次重复检查。
  let session = SESSIONS.get(sessionId);
  if (!session) {
    session = await createSession(sessionId, host);
  }
  else if (session.ws && session.ws.readyState === WebSocket.OPEN) session.ws.close(1012, "replaced");
  session.ws = ws;
  // 4) 回放最近输出（断线期间/重连场景）。
  for (const chunk of session.ring) {
    if (ws.readyState !== WebSocket.OPEN) break;
    ws.send(JSON.stringify({ op: "output", data: chunk.toString("base64") }));
  }
  // 5) 帧路由：input / resize / ping / kill。
  const onMessage = (text: string) => {
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(text); }
    catch { send(ws, { op: "error", message: "bad_frame" }); return; }
    session.lastActivity = Date.now();
    if (frame.op === "input" && typeof frame.data === "string") {
      session.stream.write(Buffer.from(frame.data, "base64"));
    } else if (frame.op === "resize" && Number.isInteger(frame.cols) && Number.isInteger(frame.rows)) {
      void applySize(session, frame.cols as number, frame.rows as number);
    } else if (frame.op === "ping") {
      send(ws, { op: "pong" });
    } else if (frame.op === "kill") {
      session.stream.write(Buffer.from([0x03]));
    }
  };
  // 处理缓冲下来的早期帧（大概率就是前端的第一帧 resize）。
  // 排空前先挂上 drain：排空期间新到的帧会入队并立即被消费，
  // 保证「先到的帧先处理」，不会让后到的 resize 插队。
  drain = () => { while (queue.length) onMessage(queue.shift() as string); };
  drain();
  ws.on("close", () => { if (session.ws === ws) session.ws = null; });
  ws.on("error", () => { if (session.ws === ws) session.ws = null; });
  send(ws, { op: "ready" });
}

/** 清扫器：空闲/超龄/失联会话回收。startTerminalSweeper 由网关在安装时调用一次。 */
export function startTerminalSweeper(): () => void {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const session of [...SESSIONS.values()]) {
      const idle = now - session.lastActivity;
      const age = now - session.createdAt;
      const detached = !session.ws || session.ws.readyState !== WebSocket.OPEN;
      if (idle > IDLE_MS || age > LIFETIME_MS || (detached && idle > IDLE_MS)) {
        SESSIONS.delete(session.sessionId);
        void killSession(session);
      }
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
