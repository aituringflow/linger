const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
function selectedVisionModel() {
  const root = process.env.LAUNCHER_KNOWLEDGE_DIR || path.join(os.homedir(), `.${process.env.LAUNCHER_APP_NAME || 'linger'}`, 'knowledge');
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8')).memoryImageModel;
    if ((value?.framework === 'codebuddy' || value?.framework === 'codex') && typeof value.model === 'string' && value.model.trim()) return { framework: value.framework, model: value.model.trim() };
  } catch {}
  return { framework: 'codebuddy', model: 'hy3' };
}
function modelLabel(value = selectedVisionModel()) { return `${value.framework === 'codex' ? 'Codex' : 'WorkBuddy'} · ${value.model}`; }
function isCustomModel(model) {
  const configured = process.env.AGENT_MODELS_PATH?.trim();
  const candidates = [...(configured ? [configured.endsWith('.json') ? configured : path.join(configured, 'models.json')] : []), path.join(os.homedir(), `.${process.env.LAUNCHER_APP_NAME || 'linger'}`, 'models.json')];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  if (!file) return false;
  try { return Boolean(JSON.parse(fs.readFileSync(file, 'utf8')).models?.some(item => item?.id === model && typeof item.url === 'string' && item.url.trim())); } catch { return false; }
}
function askCodex(instruction, images, model, signal, framework = 'codex') {
  if (!process.connected || !process.send) return Promise.reject(new Error('图片分析需要通过桌面应用启动微信窗口。'));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let settled = false;
    const timer = setTimeout(() => { if (process.connected) process.send({ type: 'wechat-vision-cancel', id }); finish(new Error('图片分析超时。')); }, 120000);
    const onMessage = msg => { if (msg?.type === 'wechat-vision-result' && msg.id === id) finish(msg.error ? new Error(msg.error) : null, msg.text); };
    const abort = () => { if (process.connected) process.send({ type: 'wechat-vision-cancel', id }); finish(new Error('图片分析已取消。')); };
    function finish(error, text) { if (settled) return; settled = true; clearTimeout(timer); process.removeListener('message', onMessage); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(text); }
    process.on('message', onMessage); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    process.send({ type: 'wechat-vision-request', id, instruction, images, model, framework }, error => { if (error) finish(error); });
  });
}
module.exports = { selectedVisionModel, modelLabel, askCodex, isCustomModel };
