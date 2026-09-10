import { contextBridge, ipcRenderer } from 'electron';
import type { AddOptions, BringOptions, Settings, State, SwitchboardApi } from './types';

const api: SwitchboardApi = {
  getState: () => ipcRenderer.invoke('state:get'),
  measureSizes: () => ipcRenderer.invoke('state:measure'),
  refresh: (id?: string) => ipcRenderer.invoke('state:refresh', id),
  addProfile: (p: AddOptions) => ipcRenderer.invoke('profiles:add', p),
  removeProfile: (id: string) => ipcRenderer.invoke('profiles:remove', id),
  updateProfile: (id: string, patch) => ipcRenderer.invoke('profiles:update', id, patch),
  bringOver: (id: string, sourceId: string, opts: BringOptions) =>
    ipcRenderer.invoke('profiles:bringOver', id, sourceId, opts),
  saveSettings: (s: Partial<Settings>) => ipcRenderer.invoke('settings:save', s),
  launch: (id: string) => ipcRenderer.invoke('app:launch', id),
  quit: (id: string) => ipcRenderer.invoke('app:quit', id),
  quitOthers: (id: string) => ipcRenderer.invoke('app:quitOthers', id),
  login: (id: string) => ipcRenderer.invoke('cli:login', id),
  shell: (id: string) => ipcRenderer.invoke('cli:shell', id),
  reveal: (id: string) => ipcRenderer.invoke('profile:reveal', id),
  copyCommand: (id: string) => ipcRenderer.invoke('cli:copy', id),
  onState: (fn: (s: State) => void) => {
    ipcRenderer.on('state', (_e, s: State) => fn(s));
  },
};

contextBridge.exposeInMainWorld('sb', api);
