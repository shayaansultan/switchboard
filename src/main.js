const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard, dialog } = require('electron');
const path = require('path');
const profiles = require('./profiles');
const launch = require('./launch');
const usage = require('./usage');

// A last-resort PATH for the CLIs, used until the login shell answers (see
// launch.adoptLoginShellPath, called at startup) and if it never does.
const os = require('os');
process.env.PATH = [
  process.env.PATH || '/usr/bin:/bin',
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
].join(':');

// Rough size of each vendor's default-profile history, measured once at
// startup so the setup dialog can warn before a multi-gigabyte copy.
const itemSizes = {};
async function measureItemSizes() {
  for (const [vendor, items] of Object.entries(profiles.SETUP_ITEMS)) {
    for (const item of items) {
      if (!item.copyOnly) continue;
      const paths = item.paths.map((p) => path.join(profiles.VENDORS[vendor].defaultHome, p)).filter((p) => require('fs').existsSync(p));
      if (!paths.length) continue;
      try {
        const { stdout } = await launch.run('du', ['-skc', ...paths]);
        const kb = Number((stdout.trim().split('\n').pop() || '').split(/\s+/)[0]);
        if (kb) itemSizes[`${vendor}/${item.id}`] = kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
      } catch {
        /* size is a nicety */
      }
    }
  }
}

let win = null;
let tray = null;
let data = profiles.load();
// Per-profile live state: { running, identity, usage }
const live = new Map();

// Last known identity and usage per profile, so the window has numbers the
// moment it opens instead of blanks while the first refresh runs.
const CACHE = path.join(profiles.ROOT, 'live-cache.json');
function loadCache() {
  try {
    const c = JSON.parse(require('fs').readFileSync(CACHE, 'utf8'));
    for (const [id, v] of Object.entries(c)) {
      if (!data.profiles.some((p) => p.id === id)) continue;
      live.set(id, { identity: v.identity, usage: v.usage ? { ...v.usage, stale: true } : undefined, cached: true });
    }
  } catch {
    /* no cache yet */
  }
}
function saveCache() {
  const c = {};
  for (const p of data.profiles) {
    const s = live.get(p.id);
    if (!s || !s.identity) continue;
    const usage = s.usage && s.usage.windows ? { windows: s.usage.windows, plan: s.usage.plan, fetchedAt: s.usage.fetchedAt } : undefined;
    c[p.id] = { identity: s.identity, usage };
  }
  try {
    require('fs').writeFileSync(CACHE, JSON.stringify(c), { mode: 0o600 });
  } catch {
    /* cache is a nicety */
  }
}
loadCache();
let pollTimer = null;

function stateSnapshot() {
  return {
    settings: data.settings,
    terminals: launch.installedTerminals().map((t) => ({ id: t.id, label: t.label })),
    setupItems: Object.fromEntries(Object.entries(profiles.SETUP_ITEMS).map(([v, items]) => [v, items.map(({ id, label, hint, kind, on, warn, copyOnly }) => ({ id, label, hint, kind, on, warn, copyOnly, size: itemSizes[`${v}/${id}`] || null }))])),
    vendors: Object.fromEntries(Object.entries(profiles.VENDORS).map(([k, v]) => [k, { label: v.label, installed: require('fs').existsSync(v.appPath) }])),
    profiles: data.profiles.map((p) => ({
      ...p,
      dirs: profiles.dirs(p),
      cli: launch.cliCommand(p),
      ...(live.get(p.id) || {}),
    })),
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state', stateSnapshot());
  rebuildTray();
}

async function refreshRunning() {
  const instances = await launch.runningInstances().catch(() => []);
  for (const p of data.profiles) {
    const cur = live.get(p.id) || {};
    cur.running = !!launch.instanceFor(p, instances);
    live.set(p.id, cur);
  }
}

// `force` is a person clicking refresh; scheduled polls respect the backoff
// a 429 imposed and keep showing the last good numbers meanwhile.
async function refreshProfile(p, force) {
  const cur = live.get(p.id) || {};
  cur.identity = await usage.identity(p);
  if (!cur.identity.loggedIn) {
    cur.usage = { error: 'not signed in via CLI' };
    live.set(p.id, cur);
    return;
  }
  if (!force && cur.backoffUntil && Date.now() < cur.backoffUntil) return;
  const fresh = await usage.usage(p);
  if (fresh.error) {
    cur.backoffUntil = fresh.retryAfterMs ? Date.now() + fresh.retryAfterMs : null;
    const prev = cur.usage && cur.usage.windows ? cur.usage : null;
    cur.usage = prev ? { ...prev, stale: true, error: fresh.error } : fresh;
  } else {
    cur.backoffUntil = null;
    cur.usage = fresh;
  }
  cur.cached = false;
  live.set(p.id, cur);
}

async function refreshAll(onlyId, force = false) {
  await refreshRunning();
  const list = onlyId ? data.profiles.filter((p) => p.id === onlyId) : data.profiles;
  await Promise.all(list.map((p) => refreshProfile(p, force).catch(() => {})));
  saveCache();
  broadcast();
}

// Launching or quitting an app only changes what's running, not the quota.
async function refreshRunningOnly() {
  await refreshRunning();
  broadcast();
}

function schedulePolling() {
  if (pollTimer) clearInterval(pollTimer);
  const mins = Math.max(1, Number(data.settings.pollMinutes) || 5);
  pollTimer = setInterval(() => refreshAll().catch(() => {}), mins * 60 * 1000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title: 'Switchboard',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f1f1ee',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

function showWindow() {
  if (!win) createWindow();
  else win.show();
  win.focus();
}

function usageLine(p) {
  const s = live.get(p.id);
  if (!s || !s.usage || s.usage.error) return s && s.identity && !s.identity.loggedIn ? 'not signed in' : '…';
  const remaining = data.settings.usageMode === 'remaining';
  return s.usage.windows.map((w) => `${w.label} ${remaining ? 100 - w.pct : w.pct}%${remaining ? ' left' : ''}`).join(', ') || 'no windows';
}

function rebuildTray() {
  if (!tray) return;
  const items = [];
  for (const vendor of Object.keys(profiles.VENDORS)) {
    items.push({ label: profiles.VENDORS[vendor].label, enabled: false });
    for (const p of data.profiles.filter((x) => x.vendor === vendor)) {
      const s = live.get(p.id) || {};
      items.push({
        label: `${s.running ? '● ' : '○ '}${p.name} — ${usageLine(p)}`,
        submenu: [
          { label: s.running ? 'Quit app' : 'Launch app', click: () => (s.running ? launch.quitDesktop(p) : launch.launchDesktop(p)).then(() => setTimeout(() => refreshRunningOnly(), 1500)) },
          { label: 'Open terminal here', click: () => launch.openShell(p, data.settings) },
          { label: 'Refresh usage', click: () => refreshAll(p.id, true) },
        ],
      });
    }
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Open Switchboard', click: showWindow });
  items.push({ label: 'Refresh all', click: () => refreshAll(undefined, true) });
  items.push({ type: 'separator' });
  items.push({ label: 'Quit Switchboard', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  // Template image: macOS recolours it for light/dark menu bars.
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Switchboard');
  rebuildTray();
}

function applyLoginItem() {
  app.setLoginItemSettings({ openAtLogin: !!data.settings.openAtLogin, openAsHidden: true });
}

// ---- IPC ----
const byId = (id) => {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('no such profile');
  return p;
};

ipcMain.handle('state:get', () => stateSnapshot());
// Sizing the history folders walks gigabytes, so only do it when the setup
// dialog is about to show the numbers, and only once.
let sizesMeasured = false;
ipcMain.handle('state:measure', async () => {
  if (!sizesMeasured) {
    sizesMeasured = true;
    await measureItemSizes().catch(() => {});
    broadcast();
  }
  return stateSnapshot();
});
ipcMain.handle('state:refresh', async (_e, id) => {
  await refreshAll(id || undefined, true);
  return stateSnapshot();
});
ipcMain.handle('profiles:add', async (_e, p) => {
  const { profile, result } = profiles.add(data, p);
  await refreshAll(profile.id);
  return { profile, result };
});
ipcMain.handle('profiles:remove', async (_e, id, opts) => {
  // fall through to removal below; cache entry goes with it via saveCache
  const p = byId(id);
  if (opts && opts.deleteData) {
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete all data for "${p.name}"?`,
      detail: `This removes the profile's CLI login, desktop session, history and settings under ${path.dirname(profiles.dirs(p).home)}. It cannot be undone.`,
    });
    if (r.response !== 0) return false;
  }
  profiles.remove(data, id, opts || {});
  live.delete(id);
  saveCache();
  broadcast();
  return true;
});
ipcMain.handle('profiles:bringOver', async (_e, id, sourceId, opts) => {
  const target = byId(id);
  const o = opts || {};
  // Chat history rewrites the app's own state file. A running window keeps
  // that file in memory and writes it back whole, which would silently undo
  // the change, so refuse rather than let it look like it worked.
  const touchesAppState = (o.items || []).some((i) => (profiles.SETUP_ITEMS[target.vendor] || []).some((it) => it.id === i && it.projectState));
  if (touchesAppState && launch.instanceFor(target, await launch.runningInstances().catch(() => []))) {
    throw new Error(`Quit the ${profiles.VENDORS[target.vendor].label} window for "${target.name}" first: chat history changes a file that window keeps open.`);
  }
  const r = profiles.bringOver(data, target, byId(sourceId), o);
  broadcast();
  return r;
});
ipcMain.handle('profiles:update', (_e, id, patch) => {
  profiles.update(data, id, patch);
  broadcast();
});
ipcMain.handle('settings:save', (_e, s) => {
  data.settings = { ...data.settings, ...s };
  profiles.save(data);
  schedulePolling();
  applyLoginItem();
  broadcast();
});
ipcMain.handle('app:launch', async (_e, id) => {
  await launch.launchDesktop(byId(id));
  setTimeout(() => refreshRunningOnly().catch(() => {}), 2500);
});
ipcMain.handle('app:quit', async (_e, id) => {
  await launch.quitDesktop(byId(id));
  setTimeout(() => refreshRunningOnly().catch(() => {}), 1500);
});
ipcMain.handle('app:quitOthers', async (_e, id) => {
  const n = await launch.quitOthers(byId(id));
  setTimeout(() => refreshRunningOnly().catch(() => {}), 1500);
  return n;
});
ipcMain.handle('cli:login', (_e, id) => launch.openLogin(byId(id), data.settings));
ipcMain.handle('cli:shell', (_e, id) => launch.openShell(byId(id), data.settings));
ipcMain.handle('profile:reveal', (_e, id) => launch.revealDir(byId(id)));
ipcMain.handle('cli:copy', (_e, id) => clipboard.writeText(launch.cliCommand(byId(id))));

// A second copy would poll the same endpoints in parallel and double the
// rate-limit pressure, so hand off to the one already running.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) return;
  if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon-1024.png'));
  await launch.adoptLoginShellPath();
  createTray();
  // Launched at login: stay in the menu bar, don't pop the window.
  const hidden = app.getLoginItemSettings().wasOpenedAtLogin;
  if (!hidden) createWindow();
  schedulePolling();
  await refreshAll().catch(() => {});
  // Dev aid: `electron . --screenshot=/tmp/x.png` captures the window and exits.
  const shot = process.argv.find((a) => a.startsWith('--screenshot='));
  if (shot) {
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      require('fs').writeFileSync(shot.slice('--screenshot='.length), img.toPNG());
      app.quit();
    }, 1500);
  }
});

// Menu-bar app: closing the window keeps the tray alive.
app.on('window-all-closed', () => {});
app.on('activate', showWindow);
