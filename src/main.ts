import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, nativeTheme, clipboard, dialog } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as profiles from './profiles';
import * as launch from './launch';
import * as usage from './usage';
import type {
  AddOptions,
  BringOptions,
  Identity,
  Live,
  Profile,
  ProfileView,
  Settings,
  SetupItemView,
  State,
  Store,
  Usage,
  Vendor,
} from './types';

// A last-resort PATH for the CLIs, used until the login shell answers (see
// launch.adoptLoginShellPath, called at startup) and if it never does.
process.env.PATH = [
  process.env.PATH || '/usr/bin:/bin',
  path.join(os.homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
].join(':');

// Rough size of each vendor's default-profile history, measured once at
// startup so the setup dialog can warn before a multi-gigabyte copy.
const itemSizes: Record<string, string> = {};
async function measureItemSizes(): Promise<void> {
  for (const vendor of profiles.VENDOR_IDS) {
    for (const item of profiles.SETUP_ITEMS[vendor]) {
      if (!item.copyOnly) continue;
      const paths = (item.paths ?? [])
        .map((p) => path.join(profiles.VENDORS[vendor].defaultHome, p))
        .filter((p) => fs.existsSync(p));
      if (!paths.length) continue;
      try {
        const { stdout } = await launch.run('du', ['-skc', ...paths]);
        const kb = Number((stdout.trim().split('\n').pop() || '').split(/\s+/)[0]);
        if (kb)
          itemSizes[`${vendor}/${item.id}`] =
            kb >= 1048576 ? `${(kb / 1048576).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
      } catch {
        /* size is a nicety */
      }
    }
  }
}

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
const data: Store = profiles.load();
// Per-profile live state: what is running, who is signed in, last usage.
const live = new Map<string, Live>();

// Last known identity and usage per profile, so the window has numbers the
// moment it opens instead of blanks while the first refresh runs.
const CACHE = path.join(profiles.ROOT, 'live-cache.json');
interface CacheEntry {
  identity: Identity;
  usage?: Pick<Usage, 'windows' | 'plan' | 'fetchedAt'>;
}
function loadCache(): void {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')) as Record<string, CacheEntry>;
    for (const [id, v] of Object.entries(c)) {
      if (!data.profiles.some((p) => p.id === id)) continue;
      live.set(id, { identity: v.identity, usage: v.usage ? { ...v.usage, stale: true } : undefined, cached: true });
    }
  } catch {
    /* no cache yet */
  }
}
function saveCache(): void {
  const c: Record<string, CacheEntry> = {};
  for (const p of data.profiles) {
    const s = live.get(p.id);
    if (!s || !s.identity) continue;
    const u =
      s.usage && s.usage.windows
        ? { windows: s.usage.windows, plan: s.usage.plan, fetchedAt: s.usage.fetchedAt }
        : undefined;
    c[p.id] = { identity: s.identity, usage: u };
  }
  try {
    fs.writeFileSync(CACHE, JSON.stringify(c), { mode: 0o600 });
  } catch {
    /* cache is a nicety */
  }
}
loadCache();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function byVendor<T>(fn: (v: Vendor) => T): Record<Vendor, T> {
  return Object.fromEntries(profiles.VENDOR_IDS.map((v) => [v, fn(v)])) as Record<Vendor, T>;
}

function stateSnapshot(): State {
  return {
    settings: data.settings,
    terminals: launch.installedTerminals().map((t) => ({ id: t.id, label: t.label })),
    setupItems: byVendor((v) =>
      profiles.SETUP_ITEMS[v].map(({ id, label, hint, kind, on, warn, copyOnly }): SetupItemView => ({
        id,
        label,
        hint,
        kind,
        on,
        warn,
        copyOnly,
        size: itemSizes[`${v}/${id}`] || null,
      })),
    ),
    vendors: byVendor((v) => ({
      label: profiles.VENDORS[v].label,
      installed: fs.existsSync(profiles.VENDORS[v].appPath),
    })),
    profiles: data.profiles.map((p): ProfileView => ({
      ...p,
      dirs: profiles.dirs(p),
      cli: launch.cliCommand(p),
      ...live.get(p.id),
    })),
  };
}

function broadcast(): void {
  if (win && !win.isDestroyed()) win.webContents.send('state', stateSnapshot());
  rebuildTray();
}

function liveFor(p: Profile): Live {
  let cur = live.get(p.id);
  if (!cur) {
    cur = {};
    live.set(p.id, cur);
  }
  return cur;
}

async function refreshRunning(): Promise<void> {
  const instances = await launch.runningInstances().catch(() => []);
  for (const p of data.profiles) liveFor(p).running = !!launch.instanceFor(p, instances);
}

// `force` is a person clicking refresh; scheduled polls respect the backoff
// a 429 imposed and keep showing the last good numbers meanwhile.
async function refreshProfile(p: Profile, force: boolean): Promise<void> {
  const cur = liveFor(p);
  cur.identity = await usage.identity(p);
  if (!cur.identity.loggedIn) {
    cur.usage = { error: 'not signed in via CLI' };
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
}

async function refreshAll(onlyId?: string, force = false): Promise<void> {
  await refreshRunning();
  const list = onlyId ? data.profiles.filter((p) => p.id === onlyId) : data.profiles;
  await Promise.all(list.map((p) => refreshProfile(p, force).catch(() => {})));
  saveCache();
  broadcast();
}

// Launching or quitting an app only changes what's running, not the quota.
async function refreshRunningOnly(): Promise<void> {
  await refreshRunning();
  broadcast();
}

function schedulePolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  const mins = Math.max(1, Number(data.settings.pollMinutes) || 5);
  pollTimer = setInterval(() => refreshAll().catch(() => {}), mins * 60 * 1000);
}

// The window's own background, painted before the page loads and behind it
// while it resizes. Must match --bg in the stylesheet for each scheme.
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1d1d1b' : '#f1f1ee';
}

// The Appearance setting drives Electron's theme source, which in turn
// drives the prefers-color-scheme media query the stylesheet keys on.
function applyAppearance(): void {
  nativeTheme.themeSource = data.settings.appearance ?? 'system';
}
nativeTheme.on('updated', () => {
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
});

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title: 'Switchboard',
    titleBarStyle: 'hiddenInset',
    backgroundColor: windowBackground(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  w.on('closed', () => {
    win = null;
  });
  win = w;
  return w;
}

function showWindow(): void {
  const w = win ?? createWindow();
  w.show();
  w.focus();
}

function usageLine(p: Profile): string {
  const s = live.get(p.id);
  if (!s || !s.usage || s.usage.error || !s.usage.windows) {
    return s && s.identity && !s.identity.loggedIn ? 'not signed in' : '…';
  }
  const remaining = data.settings.usageMode === 'remaining';
  return (
    s.usage.windows
      .map((w) => `${w.label} ${remaining ? 100 - (w.pct ?? 0) : (w.pct ?? 0)}%${remaining ? ' left' : ''}`)
      .join(', ') || 'no windows'
  );
}

function rebuildTray(): void {
  if (!tray) return;
  const items: Electron.MenuItemConstructorOptions[] = [];
  for (const vendor of profiles.VENDOR_IDS) {
    items.push({ label: profiles.VENDORS[vendor].label, enabled: false });
    for (const p of data.profiles.filter((x) => x.vendor === vendor)) {
      const s = live.get(p.id) ?? {};
      items.push({
        label: `${s.running ? '● ' : '○ '}${p.name} — ${usageLine(p)}`,
        submenu: [
          {
            label: s.running ? 'Quit app' : 'Launch app',
            click: () =>
              (s.running ? launch.quitDesktop(p) : launch.launchDesktop(p)).then(() =>
                setTimeout(() => refreshRunningOnly(), 1500),
              ),
          },
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

function createTray(): void {
  // Template image: macOS recolours it for light/dark menu bars.
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Switchboard');
  rebuildTray();
}

function applyLoginItem(): void {
  app.setLoginItemSettings({ openAtLogin: !!data.settings.openAtLogin });
}

// ---- IPC ----
const byId = (id: string): Profile => {
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
ipcMain.handle('state:refresh', async (_e, id?: string) => {
  await refreshAll(id || undefined, true);
  return stateSnapshot();
});
ipcMain.handle('profiles:add', async (_e, p: AddOptions) => {
  const { profile, result } = profiles.add(data, p);
  await refreshAll(profile.id);
  return { profile, result };
});
ipcMain.handle('profiles:remove', async (_e, id: string) => {
  const p = byId(id);
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Remove "${p.name}" and delete all its data?`,
    detail: `This removes the profile's CLI login, desktop session, history and settings under ${path.dirname(profiles.dirs(p).home)}. It cannot be undone.`,
  };
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (r.response !== 0) return false;
  profiles.remove(data, id);
  live.delete(id);
  saveCache();
  broadcast();
  return true;
});
ipcMain.handle('profiles:bringOver', async (_e, id: string, sourceId: string, opts?: BringOptions) => {
  const target = byId(id);
  const o = opts || {};
  // Chat history rewrites the app's own state file. A running window keeps
  // that file in memory and writes it back whole, which would silently undo
  // the change, so refuse rather than let it look like it worked.
  const touchesAppState = (o.items || []).some((i) =>
    profiles.SETUP_ITEMS[target.vendor].some((it) => it.id === i && it.projectState),
  );
  if (touchesAppState && launch.instanceFor(target, await launch.runningInstances().catch(() => []))) {
    throw new Error(
      `Quit the ${profiles.VENDORS[target.vendor].label} window for "${target.name}" first: chat history changes a file that window keeps open.`,
    );
  }
  const r = profiles.bringOver(data, target, byId(sourceId), o);
  broadcast();
  return r;
});
ipcMain.handle('profiles:update', (_e, id: string, patch: { name?: string; color?: string }) => {
  profiles.update(data, id, patch);
  broadcast();
});
ipcMain.handle('settings:save', (_e, s: Partial<Settings>) => {
  data.settings = { ...data.settings, ...s };
  profiles.save(data);
  schedulePolling();
  applyLoginItem();
  applyAppearance();
  broadcast();
});
ipcMain.handle('app:launch', async (_e, id: string) => {
  await launch.launchDesktop(byId(id));
  setTimeout(() => refreshRunningOnly().catch(() => {}), 2500);
});
ipcMain.handle('app:quit', async (_e, id: string) => {
  await launch.quitDesktop(byId(id));
  setTimeout(() => refreshRunningOnly().catch(() => {}), 1500);
});
ipcMain.handle('app:quitOthers', async (_e, id: string) => {
  const n = await launch.quitOthers(byId(id));
  setTimeout(() => refreshRunningOnly().catch(() => {}), 1500);
  return n;
});
ipcMain.handle('cli:login', (_e, id: string) => launch.openLogin(byId(id), data.settings));
ipcMain.handle('cli:shell', (_e, id: string) => launch.openShell(byId(id), data.settings));
ipcMain.handle('profile:reveal', (_e, id: string) => launch.revealDir(byId(id)));
ipcMain.handle('cli:copy', (_e, id: string) => clipboard.writeText(launch.cliCommand(byId(id))));

// A second copy would poll the same endpoints in parallel and double the
// rate-limit pressure, so hand off to the one already running.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) return;
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon-1024.png'));
  await launch.adoptLoginShellPath();
  applyAppearance();
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
      const w = win ?? createWindow();
      const img = await w.webContents.capturePage();
      fs.writeFileSync(shot.slice('--screenshot='.length), img.toPNG());
      app.quit();
    }, 1500);
  }
});

// Menu-bar app: closing the window keeps the tray alive.
app.on('window-all-closed', () => {});
app.on('activate', showWindow);
