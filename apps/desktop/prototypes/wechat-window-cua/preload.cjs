const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('wechatCua', {
  on: (event, callback) => {
    if (!['phase', 'image', 'result', 'error', 'geometry', 'inspection', 'dock-target', 'dock-status', 'monitor-status', 'monitor-state', 'notification-status', 'draft-state', 'step'].includes(event)) return;
    ipcRenderer.on(event, (_e, value) => callback(value));
  },
  unread: () => ipcRenderer.invoke('unread'),
  reconnect: () => ipcRenderer.invoke('reconnect'),
  interaction: () => ipcRenderer.send('interaction'),
  copyLog: (text) => ipcRenderer.invoke('copy-log', text),
  resumeAfterDraft: () => ipcRenderer.invoke('resume-after-draft'),
  dock: (handle, rect) => ipcRenderer.invoke('dock', handle, rect),
});
