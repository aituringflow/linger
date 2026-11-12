const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

// A visible conversation name is only a provisional identity: WeChat may have
// multiple contacts with the same name. Keep each observation and its provenance
// rather than destructively merging messages that merely look alike.
function conversationDir(root, conversation) {
  return path.join(root, createHash('sha256').update(conversation).digest('hex'));
}

async function savePage(root, page) {
  const directory = conversationDir(root, page.conversation);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${page.runId}-${String(page.page).padStart(3, '0')}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify({ version: 1, ...page }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function loadHistory(root, conversation) {
  const directory = conversationDir(root, conversation);
  let names;
  try { names = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const name of names.filter(name => name.endsWith('.json'))) {
    try {
      const item = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
      if (item.version === 1 && item.conversation === conversation && typeof item.text === 'string' && Number.isInteger(item.page) && typeof item.capturedAt === 'string') records.push(item);
    } catch { /* A damaged observation must not prevent reading other records. */ }
  }
  records.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || b.page - a.page);
  return records.slice(-8).map(item => ({ ...item, text: item.text.slice(0, 4000) }));
}

module.exports = { savePage, loadHistory };
