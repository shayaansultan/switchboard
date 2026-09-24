import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  clipboard,
  dialog,
  powerMonitor,
  shell,
  systemPreferences,
} from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as profiles from './profiles';
import * as launch from './launch';
import * as usage from './usage';
import * as buckets from './buckets';
import { shellQuote } from './shell';
import { writeJson } from './storage';
import { z } from 'zod';
import { AwakeController, isAwakeValue, macAwakeSystem } from './awake';
import { barPng, meterPng, stripPng } from './trayart';
import { composeTrayText, type TrayText } from './tray-status';
import { PollingPause, type PauseReason } from './polling-pause';
import { AppStates, START_DEADLINE_MS } from './app-state';
import { DesktopWatch } from './desktop-watch';
import { installShim, launcherScript } from './shim';
import { INSTALLED_APP } from './buckets/runtime';
import { HOME } from './store';
import type {
  AppState,
  CliStatus,
  DesktopSupport,
  AddOptions,
  BringOptions,
  Live,
  LiveCache,
  Profile,
  ProfileView,
  Settings,
  SetupItemView,
  State,
  Store,
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
const awake = new AwakeController(macAwakeSystem, (state) => {
  if (win && !win.isDestroyed()) win.webContents.send('awake:state', state);
  rebuildTray();
});
// Per-profile live state: what is running, who is signed in, last usage.
const live = new Map<string, Live>();
let bucketViews: State['buckets'] = [];
let bucketsError: string | undefined;
const bucketFailures = new Map<string, string>();
let bucketRefresh = 0;
async function refreshBuckets(): Promise<void> {
  const version = ++bucketRefresh;
  try {
    const next = await buckets.snapshot();
    if (version !== bucketRefresh) return;
    bucketViews = next.map((bucket) => ({
      ...bucket,
      error: bucketFailures.get(bucket.id) ?? bucket.error,
    }));
    bucketsError = undefined;
  } catch (error) {
    if (version !== bucketRefresh) return;
    bucketsError = error instanceof Error ? error.message : 'Cannot read proxy buckets';
  }
}

async function resumeInterruptedBuckets(): Promise<void> {
  try {
    // A normal Stop removes the receipt; only buckets interrupted while
    // running are resumed when Switchboard starts again.
    for (const bucket of await buckets.snapshot()) {
      if (bucket.status !== 'unreachable') continue;
      try {
        await buckets.start(bucket.id);
        bucketFailures.delete(bucket.id);
      } catch (error) {
        bucketFailures.set(bucket.id, error instanceof Error ? error.message : String(error));
      }
      await refreshBuckets();
      broadcast();
    }
  } catch (error) {
    bucketsError = error instanceof Error ? error.message : String(error);
    broadcast();
  }
}

// Last known identity and usage per profile, so the window has numbers the
// moment it opens instead of blanks while the first refresh runs. The CLI
// reads this file too; only the app writes it.
function loadCache(): void {
  try {
    const c = JSON.parse(fs.readFileSync(profiles.LIVE_CACHE_FILE, 'utf8')) as LiveCache;
    for (const [id, v] of Object.entries(c)) {
      if (!data.profiles.some((p) => p.id === id)) continue;
      live.set(id, { identity: v.identity, usage: v.usage ? { ...v.usage, stale: true } : undefined, cached: true });
    }
  } catch {
    /* no cache yet */
  }
}
function saveCache(): void {
  const c: LiveCache = {};
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
    writeJson(profiles.LIVE_CACHE_FILE, c);
  } catch {
    /* cache is a nicety */
  }
}
loadCache();

// ---- store shared with the CLI ----
// The CLI writes profiles.json directly. A foreign write arrives here through
// the store watcher; an app-side mutation first folds in anything the CLI
// wrote since, under the same lock the CLI takes, so neither side can
// overwrite the other's change.
function applyReload(next: Store): void {
  const diff = profiles.diffStores(data, next);
  data.profiles = next.profiles;
  data.settings = next.settings;
  delete data.loadError;
  for (const id of diff.removed) live.delete(id);
  if (diff.removed.length) saveCache();
  if (diff.settingsChanged) {
    schedulePolling();
    applyLoginItem();
    applyAppearance();
  }
  broadcast();
  for (const id of diff.added) void refreshAll(id).catch(() => {});
}

function mutate<T>(fn: () => T): T {
  return profiles.withStoreLock(() => {
    const next = profiles.readIfChanged();
    if (next) applyReload(next);
    return fn();
  });
}
// ---- polling cadence ----
// The interval in Settings is the steady rate while Switchboard is in use.
// Away from it the app polls less, so an idle Mac does not hit the usage
// endpoints every few minutes all day, and it stops entirely while asleep
// or locked. Anything you do in the window or the tray counts as use.
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastInteractionAt = Date.now();
const pollingPause = new PollingPause();

function nextPollDelay(): number {
  const base = Math.max(1, Number(data.settings.pollMinutes) || 5) * 60_000;
  const idle = Date.now() - lastInteractionAt;
  let delay: number;
  if (idle <= 5 * 60_000) delay = Math.min(base, 2 * 60_000); // just used it: keep it fresh
  else if (idle <= 60 * 60_000) delay = base;
  else if (idle <= 4 * 3600_000) delay = Math.max(base, 15 * 60_000);
  else delay = Math.max(base, 30 * 60_000);
  // On battery, never faster than the configured rate.
  if (delay < base && powerMonitor.isOnBatteryPower()) delay = base;
  return delay;
}

function noteInteraction(): void {
  const wasIdle = Date.now() - lastInteractionAt > 5 * 60_000;
  lastInteractionAt = Date.now();
  // Coming back after a while: bring the numbers up to date soon.
  if (wasIdle) schedulePolling();
}

function byVendor<T>(fn: (v: Vendor) => T): Record<Vendor, T> {
  return Object.fromEntries(profiles.VENDOR_IDS.map((v) => [v, fn(v)])) as Record<Vendor, T>;
}

function stateSnapshot(): State {
  return {
    awake: awake.snapshot(),
    buckets: bucketViews,
    bucketsError,
    settings: data.settings,
    palette: profiles.PALETTE,
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
    cli: cliStatus(),
    desktop: desktopSupport(),
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

// ---- desktop apps ----
// What each profile's desktop app is doing. The process list is read by the
// watcher (see desktop-watch.ts) on app launch and quit events and on its own
// timer, independently of the usage poll.
const appStates = new AppStates();

function applyAppStates(): void {
  for (const p of data.profiles) liveFor(p).app = appStates.get(p.id);
}

const helper = launch.appEventsHelper();
// Whether closed windows can be noticed right now: the setting is on, and
// macOS has granted Accessibility, which is re-read on each check because the
// person can revoke it at any time.
let accessibility: DesktopSupport['accessibility'] = 'off';
function desktopSupport(): DesktopSupport {
  return { helper: !!helper, accessibility };
}

// Returns whether anything changed. A failed `ps` keeps the last answer
// rather than calling every app off; a failed window count only loses the
// distinction between running and background.
async function refreshRunning(): Promise<boolean> {
  const instances = await launch.runningInstances().catch(() => null);
  if (!instances) return false;
  const pids = new Map<string, number>();
  for (const p of data.profiles) {
    const inst = launch.instanceFor(p, instances);
    if (inst) pids.set(p.id, inst.pid);
  }
  const alive = new Map(data.profiles.map((p) => [p.id, pids.has(p.id)]));
  const windowless = new Set<string>();
  const before = accessibility;
  if (helper && data.settings.noticeClosedWindows) {
    const counts = await launch.windowCounts(helper, [...pids.values()]).catch(() => undefined);
    if (counts === null) accessibility = 'missing';
    else if (counts) {
      accessibility = 'granted';
      for (const [id, pid] of pids) if (counts.get(pid) === 0) windowless.add(id);
    }
  } else accessibility = 'off';
  const changed = appStates.observe(alive, windowless);
  applyAppStates();
  return changed || before !== accessibility;
}

const desktopWatch = new DesktopWatch({
  check: async () => {
    if (await refreshRunning()) broadcast();
  },
  busy: () => appStates.busy,
  windows: () => accessibility === 'granted',
  tracks: (exe) => profiles.VENDOR_IDS.some((v) => profiles.VENDORS[v].appBinary === exe),
  helper,
});

// Show the launch or quit at once, then hold the caller until the process
// list confirms it or its deadline passes.
async function expectApp(p: Profile, kind: 'starting' | 'quitting') {
  appStates.expect(p.id, kind);
  applyAppStates();
  broadcast();
  desktopWatch.poke();
  const settled = await appStates.settled(p.id);
  // A proxy launch changes what its bucket reports.
  await refreshBuckets();
  broadcast();
  return settled;
}

async function launchApp(p: Profile): Promise<void> {
  await launch.launchDesktop(p);
  const { failedToStart } = await expectApp(p, 'starting');
  if (failedToStart)
    throw new Error(
      `${profiles.VENDORS[p.vendor].label} for "${p.name}" did not start within ${START_DEADLINE_MS / 1000} seconds.`,
    );
}

async function showApp(p: Profile): Promise<void> {
  if (!helper) throw new Error('Show window needs the app-events helper, which this build of Switchboard lacks.');
  if (!(await launch.showDesktop(p, helper)))
    throw new Error(`Could not bring back the ${profiles.VENDORS[p.vendor].label} window for "${p.name}".`);
  desktopWatch.poke();
}

// Resolves once the app is gone or has passed the deadline; a stalled app is
// shown as such, with Force quit, rather than reported as an error.
async function quitApp(p: Profile, force = false): Promise<void> {
  const sent = force ? await launch.forceQuitDesktop(p) : await launch.quitDesktop(p);
  if (!sent) {
    desktopWatch.poke();
    return;
  }
  await expectApp(p, 'quitting');
}

const IDENTITY_TTL = 60 * 60 * 1000;
const profileRefreshes = new Map<string, Promise<void>>();

// `force` is a person clicking refresh; scheduled polls respect the backoff
// a 429 imposed and keep showing the last good numbers meanwhile.
//
// Identity is asked for rarely: for Claude it means spawning the CLI, and
// who is signed in does not change between polls. It is re-read on a manual
// refresh, once an hour, or when the usage call says the token is gone.
async function performProfileRefresh(p: Profile, force: boolean): Promise<void> {
  const cur = liveFor(p);
  const known = cur.identity && cur.identityAt && Date.now() - cur.identityAt < IDENTITY_TTL;
  if (force || !known || usage.looksSignedOut(cur.usage)) {
    cur.identity = await usage.identity(p);
    cur.identityAt = Date.now();
  }
  if (!cur.identity || !cur.identity.loggedIn) {
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

// A manual refresh can arrive while a scheduled refresh is still waiting on a
// CLI or network request. Share that work instead of racing writes to `live`.
// A click during an active poll joins it, including that poll's backoff policy;
// clicking again after it finishes performs a forced refresh.
function refreshProfile(p: Profile, force: boolean): Promise<void> {
  const running = profileRefreshes.get(p.id);
  if (running) return running;
  const refresh = performProfileRefresh(p, force).finally(() => profileRefreshes.delete(p.id));
  profileRefreshes.set(p.id, refresh);
  return refresh;
}

async function refreshAll(onlyId?: string, force = false): Promise<void> {
  await refreshRunning();
  await refreshBuckets();
  const list = onlyId ? data.profiles.filter((p) => p.id === onlyId) : data.profiles;
  await Promise.all(list.map((p) => refreshProfile(p, force).catch(() => {})));
  saveCache();
  broadcast();
}

function schedulePolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (pollingPause.paused) return;
  pollTimer = setTimeout(async () => {
    await refreshAll().catch(() => {});
    schedulePolling();
  }, nextPollDelay());
}

function pausePolling(reason: PauseReason): void {
  pollingPause.pause(reason);
  desktopWatch.setPaused(true);
  schedulePolling();
}

async function resumePolling(reason: PauseReason): Promise<void> {
  if (!pollingPause.resume(reason)) return;
  desktopWatch.setPaused(pollingPause.paused);
  await refreshAll().catch(() => {});
  schedulePolling();
}

// The window's own background, painted before the page loads and behind it
// while it resizes. Must match --bg in the stylesheet for each scheme.
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#202020' : '#fcfcfb';
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
    // The traffic lights sit on the title bar's centre line: the bar is 56 px
    // and the lights draw 14 tall, so 19 from the top puts their centre on the text.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 20, y: 19 },
    backgroundColor: windowBackground(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  w.on('closed', () => {
    win = null;
    desktopWatch.setVisible(false);
  });
  w.on('focus', () => {
    noteInteraction();
    void awake.refresh();
    desktopWatch.poke();
  });
  w.on('show', () => {
    noteInteraction();
    desktopWatch.setVisible(true);
  });
  // macOS also sends hide and show when the window is fully covered and
  // uncovered, which is what the watcher wants: look often only while
  // someone can see the window, and look at once when they can again.
  w.on('hide', () => desktopWatch.setVisible(false));
  w.on('minimize', () => desktopWatch.setVisible(false));
  w.on('restore', () => desktopWatch.setVisible(true));
  // Windows are created shown.
  desktopWatch.setVisible(true);
  win = w;
  return w;
}

function showWindow(): void {
  const w = win ?? createWindow();
  w.show();
  w.focus();
}

// The fill of a bar for a window, honouring the used/remaining setting.
function laneFill(w: { pct: number | null }): number {
  const pct = (w.pct ?? 0) / 100;
  return data.settings.usageMode === 'remaining' ? 1 - pct : pct;
}

// Drawn images are cached by their pixels' inputs; a rebuild happens on
// every state change and re-encoding the same PNG each time is wasteful.
const artCache = new Map<string, Electron.NativeImage>();
function art(key: string, draw: () => Buffer): Electron.NativeImage {
  let img = artCache.get(key);
  if (!img) {
    img = nativeImage.createFromBuffer(draw(), { scaleFactor: 2 });
    img.setTemplateImage(true);
    if (artCache.size > 256) artCache.clear();
    artCache.set(key, img);
  }
  return img;
}

// The profile whose fullest window is fullest of all: what the status item
// shows when there is nothing more specific to say.
function busiestProfile(): { p: Profile; s: Live } | null {
  let best: { p: Profile; s: Live; pct: number } | null = null;
  for (const p of data.profiles) {
    const s = live.get(p.id);
    const pct = Math.max(-1, ...(s?.usage?.windows ?? []).map((w) => w.pct ?? 0));
    if (pct >= 0 && (!best || pct > best.pct)) best = { p, s: s as Live, pct };
  }
  return best;
}

function refreshTrayIcon(): TrayText {
  const fallback = { title: '', tooltip: 'Switchboard' };
  if (!tray) return fallback;
  const b = busiestProfile();
  const windows = b?.s.usage?.windows ?? [];
  if (!b || !windows.length) {
    tray.setImage(nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png')));
    return fallback;
  }
  const stale = !!b.s.usage?.stale;
  const lanes = windows.slice(0, 2).map((w) => ({ fill: laneFill(w) }));
  tray.setImage(art(`meter:${lanes.map((l) => l.fill.toFixed(2)).join(',')}:${stale}`, () => meterPng(lanes, stale)));
  const fullest = windows.reduce((a, w) => ((w.pct ?? 0) > (a.pct ?? 0) ? w : a), windows[0]);
  const remaining = data.settings.usageMode === 'remaining';
  const shown = remaining ? 100 - (fullest.pct ?? 0) : (fullest.pct ?? 0);
  return {
    title: data.settings.menuBar === 'percent' ? ` ${shown}%` : '',
    tooltip: `${b.p.name}: ${usageLine(b.p)}`,
  };
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
  const usageText = refreshTrayIcon();
  const remaining = data.settings.usageMode === 'remaining';
  const items: Electron.MenuItemConstructorOptions[] = [];
  const awakeState = awake.snapshot();
  const isAwake = awakeState.status === 'ready' && awakeState.value === 'on';
  const text = composeTrayText(usageText, awakeState);
  tray.setTitle(text.title);
  tray.setToolTip(text.tooltip);
  items.push({
    label:
      awakeState.status === 'changing' ? 'Changing sleep setting…' : isAwake ? 'Turn keep awake off' : 'Keep awake…',
    enabled: awakeState.status !== 'changing',
    click: () => {
      if (isAwake) void awake.set('off');
      else showWindow();
    },
  });
  items.push({ type: 'separator' });
  for (const vendor of profiles.VENDOR_IDS) {
    items.push({ label: profiles.VENDORS[vendor].label, enabled: false });
    for (const p of data.profiles.filter((x) => x.vendor === vendor)) {
      const s = live.get(p.id) ?? {};
      const windows = s.usage?.windows ?? [];
      const stale = !!s.usage?.stale;
      // One line per window, each with its own bar, ahead of the actions.
      const windowLines: Electron.MenuItemConstructorOptions[] = windows.map((w) => {
        const shown = remaining ? 100 - (w.pct ?? 0) : (w.pct ?? 0);
        const reset = w.resetsAt ? ` · resets ${relTime(w.resetsAt)}` : '';
        return {
          label: `${w.label}  ${shown}%${remaining ? ' left' : ''}${reset}`,
          icon: art(`bar:${laneFill(w).toFixed(2)}:${stale}`, () => barPng(laneFill(w), stale)),
          enabled: false,
        };
      });
      const summary = windows.length
        ? `${windows[0].label} ${remaining ? 100 - (windows[0].pct ?? 0) : (windows[0].pct ?? 0)}%`
        : usageLine(p);
      const fills = windows.slice(0, 4).map((w) => ({ fill: laneFill(w) }));
      items.push({
        label: `${p.name}  ${summary}${TRAY_SUFFIX[s.app ?? 'off']}`,
        icon: fills.length
          ? art(`strip:${fills.map((l) => l.fill.toFixed(2)).join(',')}:${stale}`, () => stripPng(fills, stale))
          : undefined,
        submenu: [
          ...windowLines,
          ...(windowLines.length ? [{ type: 'separator' as const }] : []),
          trayAppItem(p, s.app ?? 'off'),
          ...(helper && ['running', 'background', 'stalled'].includes(s.app ?? 'off')
            ? [
                {
                  label: 'Show window',
                  click: () =>
                    void showApp(p).catch((e: Error) => dialog.showErrorBox('Could not show window', e.message)),
                },
              ]
            : []),
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

// After the profile's usage in its tray line.
const TRAY_SUFFIX: Record<AppState, string> = {
  off: '  (not running)',
  starting: '  (starting…)',
  running: '',
  background: '  (no window)',
  quitting: '  (quitting…)',
  stalled: "  (won't quit)",
};

function trayAppItem(p: Profile, state: AppState): Electron.MenuItemConstructorOptions {
  const fail = (title: string) => (error: Error) => dialog.showErrorBox(title, error.message);
  switch (state) {
    case 'off':
      return { label: 'Launch app', click: () => void launchApp(p).catch(fail('Could not launch app')) };
    case 'running':
    case 'background':
      return { label: 'Quit app', click: () => void quitApp(p).catch(fail('Could not quit app')) };
    case 'stalled':
      return { label: 'Force quit app', click: () => void quitApp(p, true).catch(fail('Could not quit app')) };
    default:
      return { label: state === 'starting' ? 'Starting…' : 'Quitting…', enabled: false };
  }
}

function createTray(): void {
  // Template image: macOS recolours it for light/dark menu bars.
  const img = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'trayTemplate.png'));
  img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Switchboard');
  tray.on('mouse-enter', () => {
    noteInteraction();
    desktopWatch.poke();
  });
  rebuildTray();
}

function applyLoginItem(): void {
  app.setLoginItemSettings({ openAtLogin: !!data.settings.openAtLogin });
}

// "in 54m", "in 6d", for the tray's window lines.
function relTime(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `in ${h}h ${m % 60}m`;
  return `in ${Math.round(h / 24)}d`;
}

// ---- IPC ----
function validateSender(event: Electron.IpcMainInvokeEvent): void {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error('Untrusted Switchboard request');
  }
}

ipcMain.handle('awake:set', (event, value: unknown) => {
  validateSender(event);
  if (!isAwakeValue(value)) throw new Error('Invalid keep-awake value');
  return awake.set(value);
});
ipcMain.handle('awake:refresh', (event, reason: unknown) => {
  validateSender(event);
  if (reason !== 'observe' && reason !== 'recheck') throw new Error('Invalid keep-awake refresh');
  return awake.refresh(reason);
});

const byId = (id: string): Profile => {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('no such profile');
  return p;
};

ipcMain.handle('buckets:assign', (event, id: string, bucket: unknown) => {
  validateSender(event);
  const p = byId(id);
  if (p.vendor !== 'codex') throw new Error('Proxy routing is available for Codex desktop profiles');
  const target = z.string().nullable().parse(bucket);
  if (target !== null) buckets.load(target);
  mutate(() => profiles.setProxyBucket(data, id, target));
  broadcast();
});
ipcMain.handle('buckets:create', async (event, name: unknown) => {
  validateSender(event);
  buckets.create(z.string().parse(name));
  await refreshBuckets();
  broadcast();
});
ipcMain.handle('buckets:action', async (event, id: string, input: unknown, provider: unknown) => {
  validateSender(event);
  const action = z.enum(['start', 'refresh', 'stop', 'login']).parse(input);
  buckets.load(id);
  try {
    if (action === 'login') {
      const command = await buckets.loginCommand(id, z.enum(['codex', 'claude']).default('codex').parse(provider));
      await launch.openTerminal(command.map(shellQuote).join(' '), { terminal: data.settings.terminal });
    } else await buckets[action](id);
    bucketFailures.delete(id);
  } catch (error) {
    bucketFailures.set(id, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await refreshBuckets();
    broadcast();
  }
});
ipcMain.handle('buckets:account', async (event, id: string, name: unknown, enabled: unknown) => {
  validateSender(event);
  try {
    await buckets.setAccountEnabled(id, z.string().parse(name), z.boolean().parse(enabled));
  } finally {
    await refreshBuckets();
    broadcast();
  }
});

ipcMain.handle('state:get', () => {
  noteInteraction();
  return stateSnapshot();
});
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
  noteInteraction();
  await refreshAll(id || undefined, true);
  return stateSnapshot();
});
ipcMain.handle('profiles:add', async (_e, p: AddOptions) => {
  const { profile, result } = mutate(() => profiles.add(data, p));
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
  mutate(() => profiles.remove(data, id));
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
  // Resolve again under the lock: a reload there replaces the profile objects.
  const r = mutate(() => profiles.bringOver(data, byId(id), byId(sourceId), o));
  broadcast();
  return r;
});
ipcMain.handle('profiles:update', (_e, id: string, patch: { name?: string; color?: string }) => {
  mutate(() => profiles.update(data, id, patch));
  broadcast();
});
// The `switchboard` command: a launcher shim in ~/.local/bin that runs
// cli.js on this app's own runtime. A packaged app points the shim at the
// installed app; a checkout points it at itself.
const appLauncher = launcherScript(
  'Switchboard CLI launcher',
  [
    path.join(INSTALLED_APP, 'Contents', 'MacOS', 'Switchboard'),
    path.join(INSTALLED_APP, 'Contents', 'Resources', 'app.asar', 'out', 'cli.js'),
  ],
  { ELECTRON_RUN_AS_NODE: '1' },
);
const devLauncher = launcherScript(
  'Switchboard CLI launcher (development checkout)',
  [process.execPath, path.join(__dirname, 'cli.js')],
  { ELECTRON_RUN_AS_NODE: '1' },
);
function cliLauncher(): string {
  return app.isPackaged ? appLauncher : devLauncher;
}
function cliStatus(): CliStatus {
  const file = path.join(HOME, '.local', 'bin', 'switchboard');
  const installed = fs.existsSync(file);
  let ours = false;
  try {
    // Either of this app's launchers counts, so a checkout does not call the
    // installed app's launcher foreign, nor the other way round.
    const content = installed ? fs.readFileSync(file, 'utf8') : '';
    ours = installed && (content === appLauncher || content === devLauncher);
  } catch {
    ours = false;
  }
  const onPath = launch.loginShellPath ? launch.loginShellPath.split(':').includes(path.dirname(file)) : true;
  return { file, installed, ours, onPath, appInstalled: !app.isPackaged || fs.existsSync(INSTALLED_APP) };
}
ipcMain.handle('cli:install', () => {
  installShim('switchboard', cliLauncher());
  broadcast();
  return cliStatus();
});
ipcMain.handle('profiles:move', (_e, id: string, delta: number) => {
  const moved = mutate(() => profiles.move(data, id, delta));
  if (moved) broadcast();
  return moved;
});
ipcMain.handle('settings:save', (_e, s: Partial<Settings>) => {
  // The switch cannot be turned on without the permission it needs.
  if (s.noticeClosedWindows && !data.settings.noticeClosedWindows && !accessibilityTrusted())
    throw new Error('Allow Switchboard in Accessibility settings before turning on Notice closed windows.');
  mutate(() => {
    data.settings = { ...data.settings, ...s };
    profiles.save(data);
  });
  desktopWatch.poke();
  schedulePolling();
  applyLoginItem();
  applyAppearance();
  broadcast();
});
ipcMain.handle('app:launch', (_e, id: string) => launchApp(byId(id)));
ipcMain.handle('app:quit', (_e, id: string) => quitApp(byId(id)));
ipcMain.handle('app:forceQuit', (_e, id: string) => quitApp(byId(id), true));
ipcMain.handle('app:show', (_e, id: string) => showApp(byId(id)));
// Accessibility, asked of macOS as Switchboard itself. Its helper inherits
// the answer, because macOS attributes a child process to the app that
// started it. 'request' shows macOS's dialog, but only the first time: once
// Switchboard is listed, even switched off or stale after a rebuild, macOS
// stays silent, so the window also offers to open the pane directly.
function accessibilityTrusted(prompt = false): boolean {
  return process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(prompt);
}
ipcMain.handle('app:accessibility', async (_e, action: unknown) => {
  const a = z.enum(['check', 'request', 'open']).parse(action);
  if (a === 'open')
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  const trusted = accessibilityTrusted(a === 'request');
  if (trusted) desktopWatch.poke();
  return trusted;
});
ipcMain.handle('app:quitOthers', async (_e, id: string) => {
  const target = byId(id);
  const n = await launch.quitOthers(target);
  const others = data.profiles.filter(
    (p) => p.vendor === target.vendor && p.id !== target.id && appStates.get(p.id) === 'running',
  );
  await Promise.all(others.map((p) => expectApp(p, 'quitting')));
  desktopWatch.poke();
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
  void awake.refresh();
  // Reads only. The toggle remains a macOS setting when Switchboard exits.
  const awakePoll = setInterval(() => void awake.refresh(), 15_000);
  awakePoll.unref();
  powerMonitor.on('resume', () => void awake.refresh());
  // Launched at login: stay in the menu bar, don't pop the window.
  const hidden = app.getLoginItemSettings().wasOpenedAtLogin;
  if (!hidden) createWindow();
  void resumeInterruptedBuckets();
  // Asleep or locked, there is nobody to show numbers to.
  powerMonitor.on('suspend', () => pausePolling('sleep'));
  powerMonitor.on('lock-screen', () => pausePolling('lock'));
  powerMonitor.on('resume', () => void resumePolling('sleep'));
  powerMonitor.on('unlock-screen', () => void resumePolling('lock'));
  if (powerMonitor.getSystemIdleState(1) === 'locked') pollingPause.pause('lock');
  desktopWatch.setPaused(pollingPause.paused);
  desktopWatch.start();
  app.on('will-quit', () => desktopWatch.stop());
  schedulePolling();
  if (!pollingPause.paused) await refreshAll().catch(() => {});
  const stopWatching = profiles.watchStore(applyReload);
  app.on('will-quit', stopWatching);
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
