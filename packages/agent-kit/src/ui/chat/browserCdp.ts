/**
 * 浏览器 CDP 客户端（右侧边栏"可点击内嵌预览"）：
 * 连引擎 Playwright 无头浏览器的远程调试端口（browser_cdp 帧下发），
 * 把用户点击截图产生的坐标直接派发进**同一个**浏览器（AI 正在操控的实例）。
 * 截图 = 视口截图（1280x900，1:1），点击坐标无需换算。
 * 连接复用：端口变化（换会话/重启）时重建。
 */
class BrowserCdp {
  private port = 0;
  private ws: WebSocket | null = null;
  private pageWs: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private connecting: Promise<void> | null = null;

  setPort(port: number): void {
    if (port !== this.port) {
      this.port = port;
      this.close();
    }
  }

  private sendOn(ws: WebSocket, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private handleMessage(ev: MessageEvent): void {
    let msg: { id?: number; error?: { message: string }; result?: unknown };
    try {
      msg = JSON.parse(String(ev.data)) as { id?: number; error?: { message: string }; result?: unknown };
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  private connect(): Promise<void> {
    if (!this.port) return Promise.reject(new Error("browser cdp port 未知"));
    if (this.pageWs && this.pageWs.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${this.port}/devtools/browser`);
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.ws = ws;
      ws.onerror = () => {
        reject(new Error(`CDP 连接失败 (127.0.0.1:${this.port})`));
      };
      ws.onopen = () => {
        void (async () => {
          try {
            const res = (await this.sendOn(ws, "Target.getTargets", {})) as {
              targetInfos?: Array<{ type: string; url?: string; webSocketDebuggerUrl?: string }>;
            };
            const pages = (res.targetInfos || []).filter(
              (t) =>
                t.type === "page" &&
                t.webSocketDebuggerUrl &&
                !/^(chrome|devtools|about):/.test(t.url || ""),
            );
            const target = pages[pages.length - 1]; // 最后激活的页面 = Playwright 正在操作的页
            if (!target?.webSocketDebuggerUrl) {
              ws.close();
              this.ws = null;
              reject(new Error("未找到浏览器页面 target"));
              return;
            }
            const pageWs = new WebSocket(target.webSocketDebuggerUrl);
            pageWs.onmessage = (ev) => this.handleMessage(ev);
            pageWs.onclose = () => {
              this.pageWs = null;
            };
            await new Promise<void>((res2, rej2) => {
              pageWs.onopen = () => res2();
              pageWs.onerror = () => rej2(new Error("页面 CDP 连接失败"));
            });
            this.pageWs = pageWs;
            ws.close();
            this.ws = null;
            resolve();
          } catch (e) {
            ws.close();
            this.ws = null;
            reject(e as Error);
          }
        })();
      };
    });
  }

  private send(method: string, params: unknown): Promise<unknown> {
    if (!this.pageWs || this.pageWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("页面 CDP 未连接"));
    }
    return this.sendOn(this.pageWs, method, params);
  }

  /** 在 AI 正在操作的浏览器里点击视口坐标（截图 1:1 映射） */
  async click(x: number, y: number): Promise<void> {
    await this.connect();
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  close(): void {
    try { this.pageWs?.close(); } catch { /* ignore */ }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.pageWs = null;
    this.ws = null;
    this.pending.clear();
  }
}
export const browserCdp = new BrowserCdp();

