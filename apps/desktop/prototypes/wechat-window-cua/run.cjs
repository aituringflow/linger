const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.join(__dirname, process.platform === 'darwin' ? 'mac-viewer.cjs' : 'viewer.cjs'), ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname, '../../../..'), env, stdio: 'inherit', windowsHide: true,
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { if (child.exitCode === null && !child.killed) child.kill(signal); });
}
child.on('exit', (code) => process.exit(code ?? 1));
