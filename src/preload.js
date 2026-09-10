const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sb', {
  getState: () => ipcRenderer.invoke('state:get'),
  measureSizes: () => ipcRenderer.invoke('state:measure'),
  refresh: (id) => ipcRenderer.invoke('state:refresh', id),
  addProfile: (p) => ipcRenderer.invoke('profiles:add', p),
  removeProfile: (id) => ipcRenderer.invoke('profiles:remove', id),
  updateProfile: (id, patch) => ipcRenderer.invoke('profiles:update', id, patch),
  bringOver: (id, sourceId, opts) => ipcRenderer.invoke('profiles:bringOver', id, sourceId, opts),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  launch: (id) => ipcRenderer.invoke('app:launch', id),
  quit: (id) => ipcRenderer.invoke('app:quit', id),
  quitOthers: (id) => ipcRenderer.invoke('app:quitOthers', id),
  login: (id) => ipcRenderer.invoke('cli:login', id),
  shell: (id) => ipcRenderer.invoke('cli:shell', id),
  reveal: (id) => ipcRenderer.invoke('profile:reveal', id),
  copyCommand: (id) => ipcRenderer.invoke('cli:copy', id),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
});
