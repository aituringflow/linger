const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// PowerShell cannot use an asar virtual directory as cwd or read scripts from it.
const scriptDir = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'prototypes', 'wechat-window-cua')
  : __dirname;
let win;
let busy = false;
let docked = null;
let closing = false;
let readyPromise = Promise.resolve();
let requestedForeground = true;
let windowReady = false;

function showWindow() {
  if (!win || win.isDestroyed() || !windowReady) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.moveTop();
}
function reportWindowEvent(type) {
  if (process.connected && process.send) process.send({ type, at: Date.now() });
}
process.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'show') { requestedForeground = true; showWindow(); }
  if (message.type === 'background') requestedForeground = false;
  if (message.type === 'close') {
    if (win && !win.isDestroyed()) win.close();
    else { closing = true; app.quit(); }
  }
});
process.on('disconnect', () => {
  if (win && !win.isDestroyed()) win.close();
  else { closing = true; app.quit(); }
});

function fitFrame(bounds) {
  const display = screen.getDisplayMatching(win.getBounds());
  const work = display.workArea;
  const widthDip = bounds.width / display.scaleFactor;
  const heightDip = bounds.height / display.scaleFactor;
  const desiredWidth = Math.ceil(widthDip + 340);
  const desiredHeight = Math.ceil(Math.max(heightDip + 8, 360));
  win.setContentSize(Math.min(desiredWidth, work.width - 40), Math.min(desiredHeight, work.height - 40));
  publish('geometry', { width: widthDip, height: heightDip, pixelWidth: bounds.width, pixelHeight: bounds.height, scaleFactor: display.scaleFactor });
}

async function driver(action, args = []) {
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(scriptDir, 'wechat-window.ps1'), action, ...args], {
      cwd: scriptDir, timeout: 20000, windowsHide: true,
    });
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  } catch (error) {
    if (typeof error.stderr === 'string' && error.stderr.trim()) {
      const encoded = error.stderr.match(/WECHAT_CUA_ERROR:([A-Za-z0-9+/=]+)/);
      if (encoded) throw new Error(Buffer.from(encoded[1], 'base64').toString('utf8'));
      throw new Error(error.stderr.trim());
    }
    throw error;
  }
}

async function embed(action, args = []) {
  const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(scriptDir, 'embed-window.ps1'), '-Action', action, ...args], {
    cwd: scriptDir, timeout: 20000, windowsHide: true,
  });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}

async function positionDock(rect) {
  if (!docked) return;
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
  const x = Math.round(rect.x * scale), y = Math.round(rect.y * scale);
  const width = Math.round(rect.width * scale), height = Math.round(rect.height * scale);
  const placed = await embed('position', ['-TargetHandle', String(docked.targetHandle), '-X', String(x), '-Y', String(y), '-Width', String(width), '-Height', String(height)]);
  publish('dock-status', `微信原生窗口已嵌入 · ${placed.actualWidth}×${placed.actualHeight} 像素`);
}

async function undock() {
  if (!docked) return;
  const state = docked;
  docked = null;
  await embed('detach', Object.entries(state).flatMap(([key, value]) => ['-' + key[0].toUpperCase() + key.slice(1), String(value)]));
}

function publish(event, value) {
  console.log('[wechat-cua]', event, event === 'image' || event === 'result' ? `${value.length} chars` : value);
  if (win && !win.isDestroyed()) win.webContents.send(event, value);
}

async function askHy3(instruction, images) {
  const { query } = await import('@tencent-ai/agent-sdk');
  const userMessage = {
    type: 'user', session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content: [
      { type: 'text', text: instruction },
      ...images.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
    ] },
  };
  const prompt = (async function* () { yield userMessage; })();
  let answer = '';
  for await (const msg of query({ prompt, options: {
    model: 'hy3', allowedTools: [], maxTurns: 1, continue: false,
    permissionMode: 'bypassPermissions', thinking: { type: 'disabled' },
    includePartialMessages: false, cwd: app.isPackaged ? app.getPath('userData') : path.resolve(__dirname, '../../../..'),
  } })) {
    if (msg.type === 'assistant') for (const block of msg.message.content) {
      if (block.type === 'text') answer += block.text;
    }
  }
  if (!answer.trim()) throw new Error('hy3 未返回可显示的摘要');
  return answer.trim();
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function assertOpen() { if (closing) throw new Error('微信数域已关闭'); }
async function input(action, handle, x, y, extra = []) {
  const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-File', path.join(scriptDir, 'background-input.ps1'), '-Action', action, '-TargetHandle', String(handle), '-X', String(x), '-Y', String(y), ...extra], { cwd: scriptDir, timeout: 20000, windowsHide: true });
  return JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
}
async function capture(handle) {
  const file = path.join(app.getPath('temp'), `wechat-cua-${process.pid}-${Date.now()}.png`);
  try {
    await driver('capture', ['-TargetHandle', String(handle), '-Output', file]);
    return (await fs.readFile(file)).toString('base64');
  } finally { await fs.unlink(file).catch(() => {}); }
}
function chatViewport(imageBase64) {
  const source = nativeImage.createFromBuffer(Buffer.from(imageBase64, 'base64'));
  const { width, height } = source.getSize();
  if (!width || !height) throw new Error('无法读取聊天截图尺寸');
  const pixels = source.toBitmap();
  if (pixels.length < width * height * 4) throw new Error('聊天截图解码不完整');
  const left = Math.floor(width * (width > 900 ? 0.42 : 0.17));
  const top = Math.max(120, Math.floor(height * 0.1));
  const bottom = height - Math.max(170, Math.floor(height * 0.2));
  const sample = Buffer.alloc(96 * 64 * 3);
  for (let row = 0; row < 64; row++) {
    const y = top + Math.floor((row + 0.5) * (bottom - top) / 64);
    for (let col = 0; col < 96; col++) {
      const x = left + Math.floor((col + 0.5) * (width - left - 12) / 96);
      const sourceIndex = (y * width + x) * 4;
      const targetIndex = (row * 96 + col) * 3;
      sample[targetIndex] = pixels[sourceIndex];
      sample[targetIndex + 1] = pixels[sourceIndex + 1];
      sample[targetIndex + 2] = pixels[sourceIndex + 2];
    }
  }
  return sample;
}
function viewportUnchanged(before, after) {
  let total = 0, changed = 0;
  for (let i = 0; i < before.length; i++) {
    const delta = Math.abs(before[i] - after[i]);
    total += delta;
    if (delta >= 10) changed++;
  }
  return total / before.length < 0.6 && changed / before.length < 0.003;
}
function jsonAnswer(answer) {
  const match = answer.match(/```(?:json)?\s*([\s\S]*?)```/) || answer.match(/(\{[\s\S]*\})/);
  if (!match) throw new Error(`hy3 未返回 JSON：${answer.slice(0, 150)}`);
  return JSON.parse(match[1]);
}

async function runUnread() {
  if (busy) return;
  busy = true;
  try {
    assertOpen();
    const prepared = docked ? await driver('status', ['-TargetHandle', String(docked.targetHandle)]) : await driver('prepare');
    if (!docked) fitFrame(prepared.bounds);
    if (!docked) publish('dock-target', { handle: prepared.handle });
    const handle = prepared.handle;
    const listX = Math.min(300, Math.round(prepared.bounds.width * 0.5));
    const initial = await capture(handle);
    assertOpen();
    const initialView = jsonAnswer(await askHy3('判断这张微信截图能否看到左侧会话列表和顶部搜索框。能看到就返回 {"view":"list"}，即使右侧同时显示某个聊天内容也算 list。只有窄窗口单独显示聊天、顶部有返回箭头且看不到会话列表时才返回 {"view":"chat"}。只返回 JSON。', [initial]));
    if (initialView.view === 'chat') {
      publish('phase', '正在返回会话列表…');
      await input('click', handle, 168, 96);
      await delay(300);
    } else if (initialView.view !== 'list') throw new Error('无法确认微信当前页面。');
    publish('phase', '正在将会话列表滚动到顶部…');
    // WeChat uses the standard wheel sign: positive is toward the newest conversations.
    for (let i = 0; i < 5; i++) { assertOpen(); await input('wheel', handle, listX, 300, ['-Delta','120','-Count','30']); }
    assertOpen();
    await delay(350);
    const home = await capture(handle);
    publish('image', `data:image/png;base64,${home}`);
    publish('phase', 'hy3 正在识别顶部第一个未读会话…');
    const choice = jsonAnswer(await askHy3(`这是微信会话列表顶部截图，尺寸 ${prepared.bounds.width}×${prepared.bounds.height} 像素。只看会话列表（宽窗口时在左侧，右侧可能同时显示聊天），找从上往下第一个头像右上角带红色未读圆点或数字的会话。仅返回 JSON：{"name":"会话名","x":点击位置整数,"y":点击位置整数}。点击位置必须在该会话行内、窗口截图坐标；若看不清或没有未读会话，返回 {"name":null,"x":null,"y":null}。不要把最左侧导航栏的红点当会话。`, [home]));
    if (!choice.name || !Number.isInteger(choice.x) || !Number.isInteger(choice.y) || choice.x < 120 || choice.x >= prepared.bounds.width - 20 || choice.y < 140 || choice.y >= prepared.bounds.height - 20) throw new Error('未能可靠定位列表中的未读会话。');
    assertOpen();
    publish('phase', `正在打开首个未读会话：${choice.name}…`);
    await input('click', handle, choice.x, choice.y);
    await delay(500);
    let shot = await capture(handle);
    publish('image', `data:image/png;base64,${shot}`);
    const opened = jsonAnswer(await askHy3(`这是点击会话后的微信窗口截图。预期会话名为「${choice.name}」。只返回 JSON：{"opened":true或false,"title":"实际看到的顶部会话名"}。如果仍是会话列表，opened 为 false。`, [shot]));
    if (!opened.opened) throw new Error(`点击后未确认进入会话：${opened.title || '未知'}`);
    assertOpen();
    const screenshots = [shot];
    let previousViewport = chatViewport(shot);
    const chatX = prepared.bounds.width > 900 ? Math.round(prepared.bounds.width * 0.7) : Math.round(prepared.bounds.width * 0.55);
    const chatY = Math.min(400, Math.round(prepared.bounds.height * 0.5));
    const pageCount = Math.max(5, Math.min(12, Math.ceil(9000 / prepared.bounds.height)));
    const wheelTicks = Math.max(4, Math.min(9, Math.round(prepared.bounds.height / 170)));
    // Capture overlapping pages, newest first. Each screenshot is checked by hy3 below.
    for (let i = 0; i < pageCount; i++) {
      assertOpen();
      publish('phase', `正在向上滚动读取聊天记录 ${i + 1}/${pageCount}…`);
      await input('wheel', handle, chatX, chatY, ['-Delta','120','-Count',String(wheelTicks)]);
      await delay(300);
      shot = await capture(handle);
      let currentViewport = chatViewport(shot);
      if (viewportUnchanged(previousViewport, currentViewport)) {
        // A late render can briefly look stationary; confirm once before stopping.
        await delay(250);
        const confirmation = await capture(handle);
        const confirmedViewport = chatViewport(confirmation);
        if (viewportUnchanged(previousViewport, confirmedViewport)) {
          publish('phase', `聊天记录已到顶部 · 共截取 ${screenshots.length} 张有效画面`);
          break;
        }
        shot = confirmation;
        currentViewport = confirmedViewport;
      }
      previousViewport = currentViewport;
      screenshots.push(shot);
      publish('image', `data:image/png;base64,${shot}`);
    }
    publish('phase', 'hy3 正在提取最近 10 条消息并汇总…');
    const extracts = [];
    for (let i = 0; i < screenshots.length; i += 4) {
      assertOpen();
      const batch = screenshots.slice(i, i + 4);
      const result = await askHy3(`以下 ${batch.length} 张图按时间从新到旧依次截取同一个微信会话「${choice.name}」，相邻截图有重叠。只记录聊天区里完整可读的消息气泡，去掉重复，忽略顶部会话名、悬浮的“新消息”、底部输入框。每条写成“发送者：内容”，按截图从新到旧排列。看不清内容不要猜。`, batch);
      extracts.push(result);
      publish('phase', `已识别 ${Math.min(i + 4, screenshots.length)}/${screenshots.length} 张截图…`);
    }
    const report = await askHy3(`以下是从微信会话「${choice.name}」连续滚动截图中抽取的文本，分段可能重叠或截断。请按时间从新到旧去重，只保留最近 10 条可确认的消息，逐条列出发送者与要点，然后给出简短汇总和需要用户关注的事项。若不足 10 条完整可读消息，明确说出实际条数；不要编造或补全。\n\n${extracts.join('\n\n---\n\n')}`, []);
    assertOpen();
    publish('result', `会话：${choice.name}\n\n${report}`);
    publish('phase', '完成 · 已在后台滚动并读取会话');
  } catch (error) {
    publish('phase', '读取失败');
    publish('error', error instanceof Error ? error.message : String(error));
  } finally { busy = false; }
}

async function initialize() {
  if (busy || docked) return;
  busy = true;
  try {
    publish('phase', '正在定位微信并读取当前窗口尺寸…');
    const prepared = await driver('prepare');
    assertOpen();
    fitFrame(prepared.bounds);
    publish('dock-target', { handle: prepared.handle });
    publish('phase', '就绪 · 点击“分析”读取首个未读会话');
  } catch (error) {
    publish('phase', '初始化失败');
    publish('error', error instanceof Error ? error.message : String(error));
  } finally { busy = false; }
}

app.whenReady().then(() => {
  if (closing) return;
  const theme = process.argv.includes('--theme=dark') ? 'dark' : 'light';
  console.log('[wechat-cua] Electron ready');
  win = new BrowserWindow({
    width: 880, height: 600, minWidth: 600, minHeight: 360, show: false,
    title: '微信数域',
    backgroundColor: theme === 'dark' ? '#1c1c1e' : '#f5f5f5', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  console.log('[wechat-cua] window created', win.id, win.getNativeWindowHandle().toString('hex'));
  win.once('ready-to-show', () => { windowReady = true; if (requestedForeground) showWindow(); });
  win.on('focus', () => reportWindowEvent('focus'));
  win.on('blur', () => reportWindowEvent('blur'));
  win.on('minimize', () => reportWindowEvent('minimize'));
  win.loadFile(path.join(__dirname, 'viewer.html'), { query: { theme } });
  win.webContents.once('did-finish-load', () => {
    console.log('[wechat-cua] viewer loaded');
    readyPromise = initialize();
  });
  win.on('close', (event) => {
    if (closing) return;
    closing = true;
    if (!docked) return;
    event.preventDefault();
    void undock().catch((error) => console.error('[wechat-cua] restore failed', error)).finally(() => win.close());
  });
});
ipcMain.handle('unread', () => readyPromise.then(runUnread));
ipcMain.handle('reconnect', () => {
  readyPromise = initialize();
  return readyPromise;
});
ipcMain.handle('dock', async (_event, targetHandle, rect) => {
  if (!win || win.isDestroyed() || !Number.isSafeInteger(targetHandle) || !rect || !['x','y','width','height'].every((key) => Number.isFinite(rect[key]))) return;
  try {
    if (!docked) {
      const parentHandle = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
      docked = await embed('attach', ['-ParentHandle', parentHandle, '-TargetHandle', String(targetHandle)]);
    }
    await positionDock(rect);
  } catch (error) {
    if (docked) await undock().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    publish('dock-status', `嵌入失败：${message}`);
    publish('phase', '初始化失败');
    publish('error', message);
  }
});
app.on('window-all-closed', () => app.quit());
