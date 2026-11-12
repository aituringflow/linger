const { app, BrowserWindow, clipboard, ipcMain, screen } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const readline = require('node:readline');
const { analyzeUnread, draftFrameState } = require('./mac-analysis.cjs');
const resourcePath = name => path.join(app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../resources'), name);

let win;
let helper;
let requests = [];
let attached = false;
let closing = false;
let requestedForeground = true;
let windowReady = false;
let previewRect = null;
let placementTimer;
let placementPromise = Promise.resolve();
let initialization = null;
let wechatPid = null;
let monitor = null;
let monitorReady = false;
let monitorFailed = false;
let monitorRetryTimer = null;
let monitorStableTimer = null;
let monitorStartupTimer = null;
let monitorStopPromise = null;
let monitorRetryAttempts = 0;
let reconnectPromise = null;
let focusTimer = null;
let suppressFocusUntil = 0;
let notificationWatcher = null;
let notificationRetryTimer = null;
let lastBounds = null;
let analysisController = null;
let analysisPromise = null;
let activeEvent = null;
let draftPending = false;
let draftWatch = null;
let draftCheckInFlight = false;
let initialCheckPending = true;
const pendingChanges = [];
const pendingCaptures = new Map();
let nextCaptureId = 0;

function publish(event, value) {
  if (!win || win.isDestroyed()) return;
  win.webContents.send(event, value);
  if (['phase', 'error', 'monitor-status', 'notification-status'].includes(event) && typeof value === 'string') {
    win.webContents.send('step', { message: value, level: event === 'error' || /失败|不可用|已停止|中断/.test(value) ? 'error' : 'info', at: Date.now() });
  }
}
function step(message) { publish('step', { message, level: 'info', at: Date.now() }); }
function report(type) {
  if (process.connected && process.send) process.send({ type, at: Date.now() });
}
function startHelper() {
  if (helper && helper.exitCode === null && !helper.killed) return;
  const executable = resourcePath('wechat-windowctl');
  if (!fs.existsSync(executable)) throw new Error('微信窗口控制程序未编译。请安装 Xcode Command Line Tools 并重新启动应用。');
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  helper = child;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const request = requests.shift();
    if (!request) return;
    try {
      const response = JSON.parse(line);
      if (!response.ok) request.reject(new Error(response.error || '微信窗口操作失败'));
      else request.resolve(response);
    } catch (error) { request.reject(error); }
  });
  child.stderr.on('data', chunk => console.error('[wechat-mac]', String(chunk).trim()));
  const failed = error => {
    if (helper !== child) return;
    helper = null;
    attached = false;
    for (const request of requests.splice(0)) request.reject(error);
    if (!closing) fail('微信窗口连接已中断，请重新连接。');
  };
  // A failed pipe write emits an 'error' event in addition to its callback.
  // Handle both paths so shutdown cannot turn a closed helper pipe into an uncaught exception.
  child.stdin.on('error', failed);
  child.on('error', failed);
  child.on('exit', () => failed(new Error('微信窗口控制程序已退出。')));
}
function command(action, args = {}) {
  const child = helper;
  if (!child || child.exitCode !== null || child.killed || !child.stdin.writable || child.stdin.destroyed) return Promise.reject(new Error('微信窗口控制程序未运行。'));
  return new Promise((resolve, reject) => {
    requests.push({ resolve, reject });
    child.stdin.write(JSON.stringify({ action, ...args }) + '\n', error => {
      if (!error) return;
      const index = requests.findIndex(item => item.resolve === resolve);
      if (index !== -1) requests.splice(index, 1);
      reject(error);
    });
  });
}
function fail(message) {
  publish('dock-status', `嵌入失败：${message}`);
  publish('phase', '初始化失败');
  publish('error', message);
}
function stopMonitor() {
  monitorReady = false;
  clearTimeout(monitorRetryTimer);
  clearTimeout(monitorStableTimer);
  clearTimeout(monitorStartupTimer);
  monitorRetryTimer = null;
  monitorStableTimer = null;
  monitorStartupTimer = null;
  if (!monitor) return monitorStopPromise || Promise.resolve();
  const child = monitor;
  monitor = null;
  for (const pending of pendingCaptures.values()) if (pending.child === child) pending.reject(new Error('微信窗口捕获已停止。'));
  const stopping = new Promise(resolve => {
    let finished = false;
    let forceTimer;
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(forceTimer); resolve(); };
    const timer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      forceTimer = setTimeout(finish, 1000);
    }, 2500);
    child.once('close', finish);
    if (child.exitCode !== null) finish();
    else child.stdin.end();
  });
  monitorStopPromise = stopping;
  void stopping.finally(() => { if (monitorStopPromise === stopping) monitorStopPromise = null; });
  return stopping;
}
async function captureFrame(_pid, bounds, signal, fresh = false) {
  const child = monitor;
  if (!child || child.exitCode !== null || !child.stdin.writable) throw new Error('微信窗口监听未就绪，暂时无法截图。');
  if (!lastBounds || bounds.width !== lastBounds.width || bounds.height !== lastBounds.height || bounds.x !== lastBounds.x || bounds.y !== lastBounds.y) throw new Error('微信窗口位置或尺寸已变化，无法截图。');
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'wechat-capture-'));
  const file = path.join(directory, 'window.png');
  const id = String(++nextCaptureId);
  let timer;
  let abort;
  try {
    const response = await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        if (!pendingCaptures.delete(id)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      pendingCaptures.set(id, { child, resolve: value => finish(null, value), reject: error => finish(error) });
      abort = () => finish(new Error('微信分析已取消。'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      timer = setTimeout(() => finish(new Error('等待微信截图超时，请重试。')), 7000);
      child.stdin.write(JSON.stringify({ action: 'capture', id, path: file, fresh }) + '\n', error => { if (error) finish(error); });
    });
    return { image: (await fsp.readFile(file)).toString('base64'), width: response.width, height: response.height };
  } finally { await fsp.rm(directory, { recursive: true, force: true }); }
}
function cancelAnalysis() {
  pendingChanges.length = 0;
  if (analysisController) analysisController.abort();
}
function enqueueChange(event) {
  if (!attached || closing) return;
  const notification = event.source === 'notification';
  if (!notification && !['x', 'y', 'width', 'height'].every(key => Number.isFinite(event[key]))) return;
  if (!pendingChanges.some(item => notification ? item.source === 'notification' : item.source !== 'notification' && Math.abs(item.x - event.x) < 5 && Math.abs(item.y - event.y) < 5)) {
    pendingChanges.push({ ...event, at: Date.now() });
    step(`${notification ? '系统通知' : '窗口红点变化'}已加入分析队列${analysisPromise ? `，前面仍有任务处理中` : ''}`);
  } else step(`${notification ? '系统通知' : '窗口红点变化'}已在队列中，已合并`);
  startPendingAnalysis();
}
function startPendingAnalysis() {
  if (analysisPromise || draftPending || !pendingChanges.length || !attached || closing || !lastBounds || !monitorReady) return;
  analysisPromise = (async () => {
    while (pendingChanges.length && !draftPending && attached && !closing && monitorReady) {
      const next = pendingChanges.shift();
      activeEvent = next;
      if (next.startup || next.source === 'startup') initialCheckPending = false;
      const sourceLabel = next.startup || next.source === 'startup' ? '启动时未读检查' : next.source === 'notification' ? '系统通知' : '窗口红点变化';
      step(`开始处理${sourceLabel}${pendingChanges.length ? `，队列还剩 ${pendingChanges.length} 项` : ''}`);
      const controller = new AbortController();
      analysisController = controller;
      try {
        const outcome = await analyzeUnread({ event: next, getBounds: () => lastBounds && { ...lastBounds }, pid: wechatPid, command, publish, signal: controller.signal, captureFrame, historyDir: path.join(app.getPath('userData'), 'wechat-history') });
        if (outcome?.status === 'draft_pending') {
          draftPending = true;
          draftWatch = outcome.watch || null;
          publish('draft-state', 'pending');
          step('等待用户回车发送或处理草稿；新触发将暂时排队');
        }
      } catch (error) {
        if (!controller.signal.aborted && !closing) {
          publish('phase', `前一项分析无效，已停止当前操作；监听继续${pendingChanges.length ? `，队列还有 ${pendingChanges.length} 项` : '，等待新的触发'}`);
          publish('error', error instanceof Error ? error.message : String(error));
        }
      } finally { if (analysisController === controller) analysisController = null; activeEvent = null; }
    }
  })().finally(() => { analysisPromise = null; if (pendingChanges.length) startPendingAnalysis(); });
}
function resumeAfterDraft(message) {
  if (!draftPending) return;
  draftPending = false;
  draftWatch = null;
  publish('draft-state', 'idle');
  step(message);
  startPendingAnalysis();
}
async function checkDraftOnFrame() {
  if (!draftPending || !draftWatch || draftCheckInFlight || !monitorReady || !lastBounds) return;
  const watch = draftWatch;
  const bounds = { ...lastBounds };
  draftCheckInFlight = true;
  try {
    const shot = await captureFrame(wechatPid, bounds, new AbortController().signal);
    if (!draftPending || draftWatch !== watch) return;
    const state = draftFrameState(watch, shot, lastBounds);
    if (state === 'changed') watch.seenChange = true;
    else if (state === 'empty' && watch.seenChange) resumeAfterDraft('微信输入框已恢复空白，继续处理新消息');
  } catch { /* The next frame or manual resume can recover from an unavailable frame. */ }
  finally { draftCheckInFlight = false; }
}
function stopNotificationWatcher() {
  clearTimeout(notificationRetryTimer);
  notificationRetryTimer = null;
  if (!notificationWatcher) return;
  const child = notificationWatcher;
  notificationWatcher = null;
  child.kill();
}
function startNotificationWatcher() {
  if (notificationWatcher || !attached || closing) return;
  const executable = resourcePath('wechat-notifications');
  if (!fs.existsSync(executable)) { publish('notification-status', '系统通知监听不可用，已保留窗口检测'); return; }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  notificationWatcher = child;
  let reportedError = false;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    if (notificationWatcher !== child) return;
    try {
      const event = JSON.parse(line);
      if (event.type === 'error') reportedError = true;
      if (event.type === 'ready') reportedError = false;
      if (['ready', 'error', 'change'].includes(event.type)) publish('notification-status', event.message);
      if (event.type === 'change') enqueueChange({ source: 'notification' });
    } catch (error) { console.error('[wechat-notifications]', error.message); }
  });
  child.stderr.on('data', chunk => console.error('[wechat-notifications]', String(chunk).trim()));
  child.on('error', error => { if (notificationWatcher === child) publish('notification-status', `系统通知监听启动失败：${error.message}`); });
  child.on('close', () => { if (notificationWatcher === child) {
    notificationWatcher = null;
    if (!closing && attached) {
      if (!reportedError) publish('notification-status', '系统通知监听已停止，将在 30 秒后重试，窗口检测仍可用');
      notificationRetryTimer = setTimeout(() => { notificationRetryTimer = null; startNotificationWatcher(); }, 30000);
    }
  } });
}
function startMonitor(rect) {
  if (monitorStopPromise) {
    void monitorStopPromise.then(() => { if (attached && !closing && lastBounds) startMonitor(lastBounds); });
    return;
  }
  if (monitor || monitorRetryTimer || monitorFailed || !wechatPid || closing) return;
  const executable = resourcePath('wechat-monitor');
  if (!fs.existsSync(executable)) {
    monitorFailed = true;
    publish('monitor-status', '监听不可用：未编译窗口监听程序');
    publish('monitor-state', 'failed');
    return;
  }
  publish('monitor-state', 'starting');
  publish('monitor-status', '正在启动本地监听…');
  const child = spawn(executable, [String(wechatPid), ...['x', 'y', 'width', 'height'].map(key => String(rect[key]))], { stdio: ['pipe', 'pipe', 'pipe'] });
  monitor = child;
  monitorStartupTimer = setTimeout(() => {
    if (monitor !== child || monitorReady || closing) return;
    retryable = true;
    publish('monitor-status', '微信监听启动超时，正在重新连接');
    child.kill();
  }, 15000);
  child.stdin.on('error', error => {
    for (const pending of pendingCaptures.values()) if (pending.child === child) pending.reject(error);
    if (monitor === child && !closing && error.code !== 'EPIPE') console.error('[wechat-monitor] 输入管道出错', error.message);
  });
  let retryable = false;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    if (monitor !== child) return;
    try {
      const event = JSON.parse(line);
      if (event.type === 'frame') { if (draftPending) void checkDraftOnFrame(); return; }
      if ((event.type === 'capture' || event.type === 'capture_error') && typeof event.id === 'string') {
        const pending = pendingCaptures.get(event.id);
        if (pending && pending.child === child) {
          if (event.type === 'capture') pending.resolve(event);
          else pending.reject(new Error(event.message || '微信截图失败。'));
        }
        return;
      }
      if (event.type === 'error') { retryable = event.retryable === true; monitorFailed = !retryable; }
      if (['started', 'ready', 'change', 'error'].includes(event.type)) publish('monitor-status', event.message);
      if (event.type === 'ready') {
        monitorReady = true;
        clearTimeout(monitorStartupTimer);
        monitorStartupTimer = null;
        publish('monitor-state', 'ready');
        if (initialCheckPending) {
          const existing = pendingChanges.findIndex(item => item.source === 'startup' || item.source === 'notification');
          if (existing >= 0) {
            const [first] = pendingChanges.splice(existing, 1);
            pendingChanges.unshift({ ...first, startup: true });
          } else {
            pendingChanges.unshift({ source: 'startup', startup: true, at: Date.now() });
            step('首次启动：已安排检查当前未读会话');
          }
        }
        startPendingAnalysis();
        clearTimeout(monitorStableTimer);
        monitorStableTimer = setTimeout(() => { if (monitor === child) monitorRetryAttempts = 0; }, 30000);
      }
      if (event.type === 'change') enqueueChange(event);
    } catch (error) { console.error('[wechat-monitor]', error.message); }
  });
  child.stderr.on('data', chunk => console.error('[wechat-monitor]', String(chunk).trim()));
  child.on('error', error => {
    if (monitor !== child) return;
    monitorReady = false;
    for (const pending of pendingCaptures.values()) if (pending.child === child) pending.reject(error);
    monitor = null; monitorFailed = false;
    clearTimeout(monitorStartupTimer);
    monitorStartupTimer = null;
    publish('monitor-status', `监听启动失败：${error.message}`);
    publish('monitor-state', 'retrying');
    if (!closing && attached) monitorRetryTimer = setTimeout(() => { monitorRetryTimer = null; if (lastBounds) startMonitor(lastBounds); }, 8000);
  });
  child.on('close', code => {
    if (monitor !== child) return;
    const wasReady = monitorReady;
    monitorReady = false;
    monitor = null;
    clearTimeout(monitorStartupTimer);
    monitorStartupTimer = null;
    for (const pending of pendingCaptures.values()) if (pending.child === child) pending.reject(new Error('微信窗口捕获连接已中断。'));
    clearTimeout(monitorStableTimer);
    monitorStableTimer = null;
    if (closing || !attached) return;
    if (wasReady) initialCheckPending = true;
    {
      const delay = [1000, 3000, 8000, 30000][Math.min(monitorRetryAttempts++, 3)];
      monitorFailed = false;
      publish('monitor-state', 'retrying');
      publish('monitor-status', `微信窗口连接中断，将在 ${delay / 1000} 秒后重新连接（第 ${monitorRetryAttempts} 次）；中断期间的消息可能遗漏`);
      monitorRetryTimer = setTimeout(() => {
        monitorRetryTimer = null;
        if (!closing && attached && lastBounds) startMonitor(lastBounds);
      }, delay);
    }
  });
}
function fitFrame(width, height) {
  const work = screen.getDisplayMatching(win.getBounds()).workArea;
  const availableWidth = Math.max(300, work.width - 380);
  const availableHeight = Math.max(300, work.height - 80);
  const viewWidth = Math.min(width, availableWidth);
  const viewHeight = Math.min(height, availableHeight);
  win.setContentSize(Math.ceil(viewWidth + 346), Math.ceil(Math.max(viewHeight + 8, 360)));
  publish('geometry', { width: viewWidth, height: viewHeight });
}
async function position() {
  if (!attached || !previewRect || !win || win.isDestroyed() || closing) return;
  const content = win.getContentBounds();
  const rect = previewRect;
  try {
    const target = {
      x: Math.round(content.x + rect.x), y: Math.round(content.y + rect.y),
      width: Math.round(rect.width), height: Math.round(rect.height),
    };
    const placed = await command('position', target);
    lastBounds = target;
    publish('dock-status', `微信原生窗口已嵌入 · ${placed.width}×${placed.height}`);
    startNotificationWatcher();
    startMonitor(target);
    startPendingAnalysis();
  } catch (error) {
    fail(error.message);
  }
}
function schedulePosition() {
  clearTimeout(placementTimer);
  placementTimer = setTimeout(() => { placementPromise = placementPromise.then(position); }, 30);
}
async function show() {
  if (!win || win.isDestroyed() || !windowReady || closing) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  await placementPromise;
  if (attached && requestedForeground && !closing) {
    try { await command('show'); report('focus'); schedulePosition(); }
    catch (error) { fail(error.message); }
  }
}
async function initialize() {
  if (attached || closing) return;
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      publish('phase', '正在连接微信窗口…');
      startHelper();
      const result = await command('attach');
      attached = true;
      wechatPid = result.pid;
      if (closing) { await command('restore'); attached = false; return; }
      fitFrame(result.width, result.height);
      publish('dock-target', { handle: 1 });
      publish('phase', '微信已连接');
    } catch (error) { fail(error.message); }
    finally { initialization = null; }
  })();
  return initialization;
}
async function closeWindow() {
  if (closing) return;
  closing = true;
  cancelAnalysis();
  const stoppingMonitor = stopMonitor();
  stopNotificationWatcher();
  clearTimeout(placementTimer);
  if (initialization) await initialization;
  if (analysisPromise) await analysisPromise;
  await stoppingMonitor;
  await placementPromise;
  if (attached && helper) {
    try { await command('restore'); } catch (error) { console.error('[wechat-mac] 恢复窗口失败', error); }
    attached = false;
  }
  if (helper) helper.stdin.end();
  if (win && !win.isDestroyed()) win.destroy();
  app.quit();
}
process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'show') { requestedForeground = true; void show(); }
  if (message.type === 'background') requestedForeground = false;
  if (message.type === 'close') void closeWindow();
});
process.on('disconnect', () => void closeWindow());
process.on('SIGINT', () => void closeWindow());
process.on('SIGTERM', () => void closeWindow());
app.whenReady().then(() => {
  if (closing) return;
  const theme = process.argv.includes('--theme=dark') ? 'dark' : 'light';
  win = new BrowserWindow({
    width: 880, height: 600, minWidth: 700, minHeight: 360, show: false,
    title: '微信数域', acceptFirstMouse: true, backgroundColor: theme === 'dark' ? '#1c1c1e' : '#f5f5f5',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.once('ready-to-show', () => { windowReady = true; if (requestedForeground) void show(); });
  win.on('focus', () => {
    report('focus');
    // Keep the native WeChat window above the preview region after the user interacts with the side panel.
    clearTimeout(focusTimer);
    if (attached && requestedForeground && !closing) focusTimer = setTimeout(() => { if (Date.now() >= suppressFocusUntil && requestedForeground && attached && !closing) void command('show').catch(error => fail(error.message)); }, 250);
  });
  win.on('minimize', () => {
    requestedForeground = false;
    report('minimize');
    publish('monitor-status', '窗口已最小化，本地监听继续');
  });
  win.on('move', schedulePosition);
  win.on('resize', schedulePosition);
  win.on('close', event => { event.preventDefault(); void closeWindow(); });
  win.loadFile(path.join(__dirname, 'viewer.html'), { query: { theme, platform: 'mac' } });
  win.webContents.once('did-finish-load', () => void initialize());
});
ipcMain.handle('dock', async (_event, target, rect) => {
  if (!attached || target !== 1 || !rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width < 100 || rect.height < 100) return;
  previewRect = rect;
  clearTimeout(placementTimer);
  placementPromise = placementPromise.then(position);
  await placementPromise;
  if (requestedForeground && attached && !closing) {
    try { await command('show'); report('focus'); } catch (error) { fail(error.message); }
  }
});
ipcMain.on('interaction', () => { suppressFocusUntil = Date.now() + 1000; clearTimeout(focusTimer); focusTimer = null; });
ipcMain.handle('resume-after-draft', () => {
  resumeAfterDraft('已恢复新消息分析');
});
ipcMain.handle('copy-log', (_event, text) => {
  if (typeof text !== 'string' || text.length > 1000000) throw new Error('日志内容无效。');
  clipboard.writeText(text);
});
ipcMain.handle('reconnect', async () => {
  if (reconnectPromise) return reconnectPromise;
  reconnectPromise = (async () => {
    publish('monitor-state', 'starting');
    publish('monitor-status', '正在重新连接微信监听…');
    cancelAnalysis();
    if (analysisPromise) await analysisPromise;
    await stopMonitor();
    if (closing) return { ok: false, error: '微信数域已关闭。' };
    monitorFailed = false;
    monitorRetryAttempts = 0;
    if (attached && helper && lastBounds) {
      startMonitor(lastBounds);
      return monitorFailed ? { ok: false, error: '无法启动微信监听。' } : { ok: true };
    }
    stopNotificationWatcher();
    if (attached) { await command('restore'); attached = false; }
    previewRect = null;
    lastBounds = null;
    await initialize();
    if (!attached) return { ok: false, error: '无法连接微信窗口，请检查窗口和辅助功能权限。' };
    return { ok: true };
  })().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    publish('monitor-status', `重新连接失败：${message}`);
    publish('monitor-state', 'failed');
    return { ok: false, error: message };
  }).finally(() => { reconnectPromise = null; });
  return reconnectPromise;
});
ipcMain.handle('unread', () => {});
app.on('window-all-closed', () => { if (!closing) void closeWindow(); });
