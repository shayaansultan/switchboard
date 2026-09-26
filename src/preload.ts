import { contextBridge, ipcRenderer } from 'electron';
import type { AddOptions, BringOptions, Settings, State, SwitchboardApi } from './types';

const api: SwitchboardApi = {
  setProxyBucket: (id, bucket) => ipcRenderer.invoke('buckets:assign', id, bucket),
  createBucket: (name) => ipcRenderer.invoke('buckets:create', name),
  bucketAction: (id, action, provider) => ipcRenderer.invoke('buckets:action', id, action, provider),
  setBucketAccount: (id, name, enabled) => ipcRenderer.invoke('buckets:account', id, name, enabled),
  setAwake: (value) => ipcRenderer.invoke('awake:set', value),
  refreshAwake: (reason = 'observe') => ipcRenderer.invoke('awake:refresh', reason),
  onAwakeState: (fn) => {
    ipcRenderer.on('awake:state', (_event, state) => fn(state));
  },
  getState: () => ipcRenderer.invoke('state:get'),
  measureSizes: () => ipcRenderer.invoke('state:measure'),
  refresh: (id?: string) => ipcRenderer.invoke('state:refresh', id),
  addProfile: (p: AddOptions) => ipcRenderer.invoke('profiles:add', p),
  removeProfile: (id: string) => ipcRenderer.invoke('profiles:remove', id),
  updateProfile: (id: string, patch) => ipcRenderer.invoke('profiles:update', id, patch),
  moveProfile: (id: string, delta: number) => ipcRenderer.invoke('profiles:move', id, delta),
  bringOver: (id: string, sourceId: string, opts: BringOptions) =>
    ipcRenderer.invoke('profiles:bringOver', id, sourceId, opts),
  saveSettings: (s: Partial<Settings>) => ipcRenderer.invoke('settings:save', s),
  launch: (id: string) => ipcRenderer.invoke('app:launch', id),
  quit: (id: string) => ipcRenderer.invoke('app:quit', id),
  forceQuit: (id: string) => ipcRenderer.invoke('app:forceQuit', id),
  showWindow: (id: string) => ipcRenderer.invoke('app:show', id),
  accessibility: (action) => ipcRenderer.invoke('app:accessibility', action),
  quitOthers: (id: string) => ipcRenderer.invoke('app:quitOthers', id),
  login: (id: string) => ipcRenderer.invoke('cli:login', id),
  shell: (id: string) => ipcRenderer.invoke('cli:shell', id),
  reveal: (id: string) => ipcRenderer.invoke('profile:reveal', id),
  copyCommand: (id: string) => ipcRenderer.invoke('cli:copy', id),
  installCli: () => ipcRenderer.invoke('cli:install'),
  onState: (fn: (s: State) => void) => {
    ipcRenderer.on('state', (_e, s: State) => fn(s));
  },
  usageReport: (days) => ipcRenderer.invoke('usage:report', days),
  onUsageChanged: (fn) => {
    ipcRenderer.on('usage:changed', () => fn());
  },
  resumeSession: (profile, id) => ipcRenderer.invoke('usage:resume', profile, id),
  openSession: (profile, id, what) => ipcRenderer.invoke('usage:open', profile, id, what),
};

contextBridge.exposeInMainWorld('sb', api);
