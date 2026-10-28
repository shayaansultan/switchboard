import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  clipboard,
  dialog,
  powerMonitor,
  powerSaveBlocker,
  shell,
  systemPreferences,
} from 'electron';
import { serveAppControl } from './app-control';
import { CliError, ref } from './cli/output';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as profiles from './profiles';
import * as launch from './launch';
import * as usage from './usage';
import { prepareUsageReset, type ResetSession } from './usage-resets';
import { prepareBucketUsageReset } from './buckets/usage-resets';
import * as buckets from './buckets';
import { shellQuote } from './shell';
import { writeJson } from './storage';
import { z } from 'zod';
import { CaffeinateController, type SleepBlocker } from './caffeinate';
import { FanController } from './fans';
import { spawnSystemBridge } from './system-bridge';
import { isCaffeinateMinutes } from './shared/caffeinate';
import { isFanLevel, isFanMinutes } from './shared/fans';
import { barPng, meterPng, stripPng } from './trayart';
import { composeTrayText, type TrayText } from './tray-status';
import { PollingPause, type PauseReason } from './polling-pause';
import { AppStates, openAction, START_DEADLINE_MS } from './app-state';
import { DesktopWatch } from './desktop-watch';
import { installShim, launcherScript } from './shim';
import { INSTALLED_APP } from './buckets/runtime';
import { HOME } from './store';
import { UsageHistory, USAGE_DIR, type LedgerProfile, type LiveProfile } from './history';
import { alertsFor } from './history/alerts';
import { buildDigest, digestDue, digestNote, lastDigest, lastWeekEnd, markDigest } from './history/digest';
import { roomiest } from './history/windows';
import { resetsIn } from './shared/time';
import { DEFAULT_PORT, startHub, type Hub, type HubProfile, type HubSource } from './remote/hub';
import { clearHubStatus, pairing, phoneStatus, publish, writeHubStatus } from './remote/status';
import { revoke as revokeDevice } from './remote/pairing';
import { controlSocket } from './remote/control';
import { defaultClaudeLinked, hookedApps, linkDefaultClaude, reachOf, unlinkDefaultClaude } from './remote/reach';
import type {
  AppState,
  CliStatus,
  DesktopSupport,
  AddOptions,
  BringOptions,
  Live,
  LiveCache,
  Profile,
  ProfilePatch,
  ProfileView,
  ResetList,
  ResetResult,
  Settings,
  SetupItemView,
  State,
  Store,
  UsageWindow,
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
// The system bridge sits beside the app's executable in Contents/MacOS, where
// SMAppService looks for the helper's plist; a checkout run uses out/.
const systemBridge = spawnSystemBridge(
  app.isPackaged
    ? path.join(path.dirname(process.execPath), 'system-bridge')
    : path.join(__dirname, 'native', 'system-bridge'),
);
// One power assertion at a time; macOS drops it when Switchboard quits.
let blockerId: number | null = null;
const sleepBlocker: SleepBlocker = {
  start() {
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
  },
  stop() {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  },
};
const caffeinate = new CaffeinateController(systemBridge, sleepBlocker, (state) => {
  if (win && !win.isDestroyed()) win.webContents.send('caffeinate:state', state);
  rebuildTray();
});
const fans = new FanController(systemBridge, (state) => {
  if (win && !win.isDestroyed()) win.webContents.send('fans:state', state);
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

// ---- usage history ----
// Every fresh reading of a profile's windows is kept (see history/windows.ts)
// and checked for alerts, and each refresh reads what the profiles' agent
// logs gained since the last (history/ledger.ts). The Usage tab asks for a
// report and is told when there is something new to ask for.
const history = new UsageHistory();
const alertBaseline = new Map<string, UsageWindow[]>();

function profileLabel(p: Profile): string {
  return `${profiles.VENDORS[p.vendor].label} · ${p.name}`;
}

// A profile's windows as last read just now: not from the cache, not failed.
function freshWindows(id: string): UsageWindow[] | undefined {
  const u = live.get(id)?.usage;
  return u?.windows && !u.stale && !u.error ? u.windows : undefined;
}

// Which account a profile is signed in to, so two profiles on one account
// are not suggested as each other's alternative or alerted on twice.
function accountOf(id: string): string | undefined {
  const who = live.get(id)?.identity;
  return who?.email ? `${who.email}\n${who.org ?? ''}` : undefined;
}

function liveProfiles(): LiveProfile[] {
  return data.profiles.map((p) => {
    const windows = live.get(p.id)?.usage?.windows;
    return { id: p.id, vendor: p.vendor, windows, stale: !freshWindows(p.id), account: accountOf(p.id) };
  });
}

function ledgerProfiles(): LedgerProfile[] {
  return data.profiles.map((p) => ({ id: p.id, vendor: p.vendor, home: profiles.dirs(p).home }));
}

function usageChanged(): void {
  if (win && !win.isDestroyed()) win.webContents.send('usage:changed');
}

// A poll or a refresh of one profile is a reason to read the logs, but not
// more than once a minute; opening the Usage tab asks the same.
const INDEX_GAP_MS = 60_000;

async function indexUsage(): Promise<void> {
  try {
    // Today's prices first, so a model new since yesterday is valued (a
    // no-op until the kept list is a day old).
    const repriced = await history.refreshPrices();
    if ((await history.index(ledgerProfiles(), INDEX_GAP_MS)) || repriced) usageChanged();
  } catch {
    /* history is a nicety; the next refresh tries again */
  }
}

function recordUsage(list: Profile[]): void {
  const fresh = new Map<string, UsageWindow[]>();
  let wrote = false;
  for (const p of list) {
    const windows = freshWindows(p.id);
    if (!windows) continue;
    fresh.set(p.id, windows);
    try {
      wrote = history.windows.record(p.id, windows) || wrote;
    } catch {
      /* as above */
    }
  }
  if (data.settings.usageAlerts !== false && Notification.isSupported()) {
    // An account whose last reading failed or came from the cache is not
    // suggested: its room may be long gone.
    const current = new Map<string, UsageWindow[]>();
    for (const p of data.profiles) {
      const windows = freshWindows(p.id);
      if (windows) current.set(p.id, windows);
    }
    const all = data.profiles.map((p) => ({
      id: p.id,
      vendor: p.vendor,
      label: profileLabel(p),
      account: accountOf(p.id),
    }));
    for (const a of alertsFor(alertBaseline, current, all, new Set(fresh.keys())))
      new Notification({ title: a.title, body: a.body }).show();
  }
  for (const [id, windows] of fresh) alertBaseline.set(id, windows);
  if (wrote) usageChanged();
  void indexUsage().then(sendDigest);
}

// The Monday notification (history/digest.ts), once a week from 9:00 on
// Monday. A week without two recorded behind it is passed over, not retried
// at every poll.
function sendDigest(): void {
  if (data.settings.weeklyDigest === false || !Notification.isSupported()) return;
  const now = Date.now();
  const week = digestDue(now, lastDigest(USAGE_DIR));
  if (!week) return;
  try {
    const d = buildDigest(
      history.report(liveProfiles(), 7, lastWeekEnd(now)),
      Object.fromEntries(data.profiles.map((p) => [p.id, p.planPrice])),
    );
    // Marked first: a marker that cannot be written must not repeat the
    // notification at every poll.
    markDigest(USAGE_DIR, week);
    if (d.ready) {
      const note = digestNote(d, (id) => {
        const p = data.profiles.find((x) => x.id === id);
        return p ? profileLabel(p) : id;
      });
      new Notification({ title: note.title, body: note.body }).show();
    }
  } catch {
    /* as above: the next poll tries again */
  }
}

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
    void applyPhoneAccess();
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
    caffeinate: caffeinate.snapshot(),
    fans: fans.snapshot(),
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

// ---- phone access ----
// The hub serves the phone app from this process, so it sees the same
// profiles, app states and usage the window does. It follows the
// phoneAccess and phonePort settings, which the CLI can change too, and
// records whether it is listening for `switchboard remote status`.
let hub: Hub | null = null;
let phoneAccessChange: Promise<void> = Promise.resolve();

const hubSource: HubSource = {
  profiles: () =>
    data.profiles.map((p): Omit<HubProfile, 'label'> => {
      const l = live.get(p.id) ?? {};
      return {
        id: p.id,
        name: p.name,
        vendor: p.vendor,
        color: p.color,
        isDefault: p.isDefault,
        email: l.identity?.email ?? null,
        plan: l.usage?.plan ?? l.identity?.plan ?? null,
        app: l.app ?? null,
        windows: (l.usage?.windows ?? []).map((w) => ({ label: w.label, pct: w.pct, resetsAt: w.resetsAt })),
        reach: reachOf(p, appHooks.get(p.id), !!data.settings.phoneAccess),
      };
    }),
  homes: () => data.profiles.map((p) => ({ id: p.id, vendor: p.vendor, home: profiles.dirs(p).home })),
  // Approvals go to the phone while nobody is at the Mac: the screen is
  // locked, or there has been no input for AWAY_IDLE_S.
  away: () => screenLocked || powerMonitor.getSystemIdleTime() >= AWAY_IDLE_S,
  relaunch: (profileId) => {
    const p = data.profiles.find((x) => x.id === profileId);
    if (!p) return Promise.reject(new Error('No such profile'));
    return relaunchForPhone(p);
  },
};

// Quits a profile's app and opens it again with the phone's hook, for an app
// opened from the Dock or before phone access was on.
async function relaunchForPhone(p: Profile): Promise<void> {
  if (!data.settings.phoneAccess) throw new Error('Turn on phone access first');
  await launch.relaunchForPhone(p, {
    quit: async (x) => {
      await quitApp(x);
    },
    open: launchApp,
  });
}

// Default Claude's settings entry follows the setting and phone access, and
// goes when Switchboard quits (below); any other time the file is left
// alone. A failure is shown in the Phone tab.
let defaultClaudeError: string | null = null;
function syncDefaultClaude(): void {
  const wanted = !!data.settings.phoneAccess && !!data.settings.phoneDefaultClaude;
  const plugin = launch.remotePlugin();
  try {
    if (wanted && plugin) linkDefaultClaude(plugin, controlSocket());
    else if (defaultClaudeLinked()) unlinkDefaultClaude();
    defaultClaudeError =
      wanted && !plugin ? 'This build of Switchboard is missing its phone plugin; reinstall it.' : null;
  } catch (error) {
    defaultClaudeError = (error as Error).message;
  }
}

// The entry points into this app's bundle and at its socket, both of which
// are only there while Switchboard runs: take it out on quit, so a moved or
// deleted Switchboard never leaves Claude a plugin folder that is gone. The
// next start puts it back.
app.on('will-quit', () => {
  try {
    if (defaultClaudeLinked()) unlinkDefaultClaude();
  } catch {
    // Left as it was; the next start reconciles it.
  }
});

const AWAY_IDLE_S = 60;
let screenLocked = false;

function applyPhoneAccess(): Promise<void> {
  // A lock pause was taken while phone access was off; with it on, the
  // phone needs fresh numbers even while the Mac is locked.
  if (data.settings.phoneAccess) void resumePolling('lock');
  syncDefaultClaude();
  phoneAccessChange = phoneAccessChange.then(async () => {
    const port = data.settings.phoneAccess ? (data.settings.phonePort ?? DEFAULT_PORT) : null;
    if (hub && hub.port === port) return;
    if (hub) {
      await hub.close();
      hub = null;
    }
    if (port === null) {
      clearHubStatus();
      return;
    }
    try {
      hub = await startHub({ source: hubSource, staticDir: path.join(__dirname, 'phone'), port });
      writeHubStatus({ port: hub.port, error: null });
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      writeHubStatus({ port: null, error: busy ? `Port ${port} is in use by another program` : String(error) });
    }
  });
  return phoneAccessChange;
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

// Whether each running app carries the phone's hook (src/remote/reach.ts),
// by profile id; read only while phone access is on.
let appHooks = new Map<string, boolean | null>();

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
  const running = data.profiles.flatMap((p) =>
    pids.has(p.id) ? [{ id: p.id, pid: pids.get(p.id)!, vendor: p.vendor }] : [],
  );
  const hooks = data.settings.phoneAccess ? await hookedApps(running) : new Map<number, boolean | null>();
  appHooks = new Map(running.map((r) => [r.id, hooks.get(r.pid) ?? null]));
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
  await launch.launchDesktop(p, !!data.settings.phoneAccess);
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

// The app in front, whatever it is doing now: see openAction.
async function openApp(p: Profile): Promise<void> {
  const state = appStates.get(p.id);
  const action = openAction(state, { helper: !!helper, isDefault: p.isDefault, routed: !!p.proxyBucket });
  if (action === 'launch') return launchApp(p);
  if (action === 'show') return showApp(p);
  if (action === null) {
    const app = `${profiles.VENDORS[p.vendor].label} for "${p.name}"`;
    if (state === 'quitting') throw new Error(`${app} is still quitting. Open it once it has.`);
    if (state === 'stalled') throw new Error(`${app} has not quit. Force quit it from Profiles first.`);
    throw new Error(`${app} is already open. Switch to it from the Dock.`);
  }
}

// Resolves once the app is gone or has passed the deadline; a stalled app is
// shown as such, with Force quit, rather than reported as an error.
async function quitApp(p: Profile, force = false) {
  const sent = force ? await launch.forceQuitDesktop(p) : await launch.quitDesktop(p);
  if (!sent) {
    desktopWatch.poke();
    return { profile: ref(p), quit: false, stopped: !launch.instanceFor(p, await launch.runningInstances()) };
  }
  await expectApp(p, 'quitting');
  return { profile: ref(p), quit: true, stopped: !launch.instanceFor(p, await launch.runningInstances()) };
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
  recordUsage(list);
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
// sets the colour scheme the stylesheet's light-dark() tokens follow.
function applyAppearance(): void {
  nativeTheme.themeSource = data.settings.appearance ?? 'system';
}
nativeTheme.on('updated', () => {
  if (win && !win.isDestroyed()) win.setBackgroundColor(windowBackground());
});

// For the UI tests (demo/): the window is never shown, the app never becomes
// the active one and puts nothing in the Dock or the menu bar, so a test run
// does not take the screen, or the Space, someone is working in. Playwright
// drives and captures the page all the same.
const BACKGROUND = process.env.SWITCHBOARD_BACKGROUND === '1';
if (BACKGROUND && process.platform === 'darwin') app.setActivationPolicy('accessory');

/** Where the traffic lights go for a page zoom: macOS draws them at a fixed
 * size, while the title bar's 56 px grows and shrinks with the zoom. */
function trafficLights(zoom: number): Electron.Point {
  return { x: 20, y: Math.round(19 + 28 * (zoom - 1)) };
}

ipcMain.on('window:zoom', (event, zoom: unknown) => {
  if (!win || event.sender !== win.webContents) return;
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) return;
  win.setWindowButtonPosition(trafficLights(zoom));
});

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    show: !BACKGROUND,
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title: 'Switchboard',
    // The traffic lights sit on the title bar's centre line: the bar is 56 px
    // and the lights draw 14 tall, so 19 from the top puts their centre on the
    // text. At other page zooms the window reports its zoom and they follow.
    titleBarStyle: 'hidden',
    trafficLightPosition: trafficLights(1),
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Hidden, the page would otherwise be throttled like a background tab.
      backgroundThrottling: !BACKGROUND,
    },
  });
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  w.on('closed', () => {
    win = null;
    desktopWatch.setVisible(false);
  });
  w.on('focus', () => {
    noteInteraction();
    void caffeinate.refresh();
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
  if (BACKGROUND) return;
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
  const awake = caffeinate.snapshot();
  const text = composeTrayText(usageText, awake);
  tray.setTitle(text.title);
  tray.setToolTip(text.tooltip);
  items.push({
    label: awake.active ? 'Decaf now' : 'Caffeinate…',
    enabled: !awake.busy,
    click: () => {
      if (awake.active) void caffeinate.stop();
      else showWindow();
    },
  });
  const fanState = fans.snapshot();
  if (fanState.status === 'ready' && fanState.level !== null) {
    items.push({
      label: `Stop fan boost (${fanState.level}%)`,
      enabled: !fanState.busy,
      click: () => void fans.system(),
    });
  }
  items.push({ type: 'separator' });
  for (const vendor of profiles.VENDOR_IDS) {
    // Where to go next: the account whose fullest window is emptiest.
    const room = roomiest(liveProfiles(), vendor, Date.now());
    const roomName = data.profiles.find((p) => p.id === room?.profile)?.name;
    items.push({
      label:
        room && roomName && data.profiles.filter((p) => p.vendor === vendor).length > 1
          ? `${profiles.VENDORS[vendor].label} · most room: ${roomName}, ${100 - room.pct}% left`
          : profiles.VENDORS[vendor].label,
      enabled: false,
    });
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
  return resetsIn(iso).replace(/^resets /, '') || 'now';
}

// ---- IPC ----
function validateSender(event: Electron.IpcMainInvokeEvent): void {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error('Untrusted Switchboard request');
  }
}

ipcMain.handle('caffeinate:refresh', (event) => {
  validateSender(event);
  return caffeinate.refresh();
});
ipcMain.handle('caffeinate:start', (event, minutes: unknown, lid: unknown) => {
  validateSender(event);
  if (!isCaffeinateMinutes(minutes) || typeof lid !== 'boolean') throw new Error('Invalid Caffeinate request');
  return caffeinate.start(minutes, { lid });
});
ipcMain.handle('caffeinate:action', (event, action: unknown) => {
  validateSender(event);
  switch (action) {
    case 'stop':
      return caffeinate.stop();
    case 'extend':
      return caffeinate.extend();
    case 'dismiss':
      return caffeinate.dismiss();
    case 'cancel':
      return caffeinate.cancel();
    case 'clear':
      return caffeinate.clear();
    case 'login-items':
      return caffeinate.openLoginItems();
    default:
      throw new Error('Invalid Caffeinate action');
  }
});
ipcMain.handle('fans:refresh', (event) => {
  validateSender(event);
  return fans.refresh();
});
ipcMain.handle('fans:set', (event, level: unknown, minutes: unknown) => {
  validateSender(event);
  if (!isFanLevel(level) || !isFanMinutes(minutes)) throw new Error('Invalid fan speed');
  return fans.set(level, minutes);
});
ipcMain.handle('fans:adjust', (event, level: unknown) => {
  validateSender(event);
  if (!isFanLevel(level)) throw new Error('Invalid fan speed');
  return fans.adjust(level);
});
ipcMain.handle('fans:action', (event, action: unknown) => {
  validateSender(event);
  switch (action) {
    case 'system':
      return fans.system();
    case 'extend':
      return fans.extend();
    case 'cancel':
      return fans.cancel();
    case 'dismiss':
      return fans.dismiss();
    case 'install':
      return fans.install();
    case 'remove':
      return fans.remove();
    case 'login-items':
      return fans.openLoginItems();
    default:
      throw new Error('Invalid fan action');
  }
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
ipcMain.handle('buckets:create', async (event, name: unknown, input: unknown) => {
  validateSender(event);
  if (input !== undefined) {
    const { Upstream, inspectUpstream, assertDefaultModel } = await import('./buckets/upstream.js');
    const upstream = Upstream.parse(input);
    const observation = await inspectUpstream(upstream);
    if (observation.discovery.status !== 'ok') throw new Error('API discovery: ' + observation.discovery.status);
    assertDefaultModel(upstream, observation.models);
    const bucket = buckets.create(z.string().parse(name), upstream);
    await buckets.inspect(bucket.id);
  } else buckets.create(z.string().parse(name));
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
// The native warning every removal asks through, with Cancel as the default.
async function confirmRemove(message: string, detail: string): Promise<boolean> {
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message,
    detail,
  };
  const r = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return r.response === 0;
}
// A desktop app routed through a bucket loses its endpoint when the bucket
// goes, so removal waits until each one has quit.
function assertRoutedQuit(id: string, name: string): void {
  const running = data.profiles.filter((p) => p.proxyBucket === id && appStates.get(p.id) !== 'off');
  if (running.length) throw new Error(`Quit ${running.map((p) => p.name).join(', ')} first: it routes through ${name}`);
}
ipcMain.handle('buckets:remove', async (event, id: string) => {
  validateSender(event);
  const bucket = buckets.load(id);
  const users = data.profiles.filter((p) => p.proxyBucket === id);
  assertRoutedQuit(id, bucket.name);
  const withOpenCode = buckets.withOpenCode(id);
  const detail = [
    `This stops its worker, interrupting every client routed through it, and deletes ${buckets.paths(id).base} with the sign-ins of its accounts.`,
    withOpenCode
      ? `It is also the OpenCode profile "${bucket.name}": its sessions, settings and connections go too.`
      : '',
    users.length ? `${users.map((p) => p.name).join(', ')} will use its own sign-in again.` : '',
    'It cannot be undone.',
  ];
  const message = `Remove "${bucket.name}"${withOpenCode ? ' and its OpenCode profile' : ''}?`;
  if (!(await confirmRemove(message, detail.filter(Boolean).join(' ')))) return false;
  // A profile may have been launched while the dialog was open.
  assertRoutedQuit(id, bucket.name);
  try {
    await buckets.remove(id, () => mutate(() => profiles.clearProxyBucket(data, id)));
    bucketFailures.delete(id);
  } catch (error) {
    bucketFailures.set(id, error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    await refreshBuckets();
    broadcast();
  }
  return true;
});
ipcMain.handle('buckets:removeAccount', async (event, id: string, name: unknown) => {
  validateSender(event);
  const account = z.string().parse(name);
  const bucket = buckets.load(id);
  const shown = bucketViews?.find((b) => b.id === id)?.accounts.find((a) => a.name === account);
  const who = shown?.email ?? account;
  const detail = `This deletes the bucket's sign-in for ${who}. Sign-ins elsewhere, such as the desktop app's, are untouched. Adding it again needs a new login.`;
  if (!(await confirmRemove(`Remove ${who} from "${bucket.name}"?`, detail))) return false;
  try {
    await buckets.removeAccount(id, account);
  } finally {
    await refreshBuckets();
    broadcast();
  }
  return true;
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

ipcMain.handle('usage:report', (event, days: unknown) => {
  validateSender(event);
  void indexUsage();
  return history.report(liveProfiles(), z.number().int().min(1).max(366).parse(days));
});
// Session ids are UUIDs (Claude Code) or rollout ids (Codex). The shape is
// checked as well as the ledger, so an id never reads as a CLI option.
const SESSION_ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
// A session the ledger knows. Paths stay here: errors that reach the
// renderer never carry one.
function sessionFor(profileId: unknown, sessionId: unknown) {
  const p = byId(z.string().parse(profileId));
  const id = SESSION_ID.parse(sessionId);
  const s = history.session(p.id, id);
  if (!s) throw new Error('That session is no longer in the usage history.');
  return { p, s, id };
}
// Resuming and showing the transcript both need the log file still there.
function requireLog(p: Profile, file: string): void {
  if (fs.existsSync(file)) return;
  throw new Error(
    p.vendor === 'claude'
      ? 'The transcript has been deleted since, as Claude Code does after 30 days.'
      : 'The rollout file has been deleted since.',
  );
}
function isFolder(dir: string | null): dir is string {
  try {
    return !!dir && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
ipcMain.handle('usage:resume', async (event, profileId: unknown, sessionId: unknown) => {
  validateSender(event);
  const { p, s, id } = sessionFor(profileId, sessionId);
  requireLog(p, s.file);
  try {
    await launch.openShell(p, data.settings, isFolder(s.cwd) ? s.cwd : undefined, launch.resumeArgs(p, id));
  } catch {
    throw new Error(
      'The terminal could not be opened. Check that Switchboard may control it in System Settings › Privacy & Security › Automation.',
    );
  }
});
// Both are revealed in Finder, never opened: the paths come from log files,
// and opening a bundle runs it.
ipcMain.handle('usage:open', (event, profileId: unknown, sessionId: unknown, what: unknown) => {
  validateSender(event);
  const { p, s } = sessionFor(profileId, sessionId);
  if (z.enum(['folder', 'transcript']).parse(what) === 'transcript') {
    requireLog(p, s.file);
    return shell.showItemInFolder(s.file);
  }
  if (!isFolder(s.cwd)) throw new Error('That folder no longer exists.');
  shell.showItemInFolder(s.cwd);
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
// The usage-reset dialog lives in the window; the session it lists from
// stays here, pinned to its account and grant. One at a time: opening the
// dialog again replaces it and a redeem spends it, so a stale token can never
// reach a vendor.
let resets: { token: string; session: ResetSession; refresh: () => Promise<void>; busy: boolean } | null = null;
// Each open bumps this; a prepare that finishes after a newer one started is
// dropped rather than replacing the session the newer dialog will use.
let resetsOpened = 0;
const ResetTargetInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), id: z.string() }),
  z.object({ kind: z.literal('bucket'), id: z.string(), account: z.string().min(1) }),
]);
ipcMain.handle('resets:list', async (event, input: unknown): Promise<ResetList> => {
  validateSender(event);
  const target = ResetTargetInput.parse(input);
  if (resets?.busy) throw new Error('A usage reset is being spent. Wait for its result.');
  resets = null;
  const opened = ++resetsOpened;
  let session: ResetSession;
  let refresh: () => Promise<void>;
  if (target.kind === 'profile') {
    const p = byId(target.id);
    session = await prepareUsageReset(p);
    refresh = () => refreshAll(p.id, true);
  } else {
    const bucket = buckets.load(target.id);
    session = await prepareBucketUsageReset(bucket.id, target.account);
    refresh = async () => {
      await refreshBuckets();
      broadcast();
    };
  }
  if (opened !== resetsOpened) throw new Error('Usage resets were reopened. Use the newer dialog.');
  const token = randomUUID();
  resets = { token, session, refresh, busy: false };
  return { token, account: session.account, note: session.note, offers: session.offers };
});
ipcMain.handle('resets:redeem', async (event, token: unknown, offerId: unknown): Promise<ResetResult> => {
  validateSender(event);
  const current = resets;
  if (!current || current.token !== z.string().parse(token))
    throw new Error('This list of resets is out of date. Reopen Usage resets.');
  if (current.busy) throw new Error('This reset is already being spent.');
  const offer = current.session.offers.find((o) => o.id === z.string().parse(offerId));
  if (!offer?.usable) throw new Error('This reset cannot be spent now.');
  current.busy = true;
  try {
    return await current.session.redeem(offer.id);
  } finally {
    if (resets === current) resets = null;
    // A failed usage refresh must not hide what the vendor said.
    await current.refresh().catch(() => {});
  }
});
ipcMain.handle('resets:close', (event, token: unknown) => {
  validateSender(event);
  if (resets?.token === z.string().parse(token) && !resets.busy) resets = null;
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
  // As in the CLI: removal deletes the directory and launch files the
  // running app is using.
  if (appStates.get(p.id) !== 'off') throw new Error(`Quit the ${p.name} window first`);
  const detail = `This removes the profile's CLI login, desktop session, history and settings under ${path.dirname(profiles.dirs(p).home)}. It cannot be undone.`;
  if (!(await confirmRemove(`Remove "${p.name}" and delete all its data?`, detail))) return false;
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
ipcMain.handle('profiles:update', (_e, id: string, patch: ProfilePatch) => {
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
ipcMain.handle('remote:status', async () => {
  await phoneAccessChange;
  const status = await phoneStatus(data.settings, data.profiles);
  return { ...status, defaultClaude: { ...status.defaultClaude, error: defaultClaudeError } };
});
ipcMain.handle('remote:pair', () => pairing());
ipcMain.handle('remote:unpair', (_e, id: unknown) => {
  revokeDevice(z.string().min(1).parse(id));
});
// Publish in the Phone tab. When Tailscale first wants Serve or HTTPS allowed
// on the tailnet, its page opens in the browser: the person clicked Publish,
// and that page is the rest of it.
ipcMain.handle('remote:publish', async () => {
  if (!data.settings.phoneAccess) throw new Error('Turn on phone access first');
  const result = await publish(data.settings.phonePort ?? DEFAULT_PORT);
  if (result.enableUrl) await shell.openExternal(result.enableUrl);
  return result;
});
ipcMain.handle('remote:relaunch', async (_e, id: unknown) => {
  const p = data.profiles.find((x) => x.id === z.string().min(1).parse(id));
  if (!p) throw new Error('No such profile');
  await relaunchForPhone(p);
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
  void applyPhoneAccess();
  broadcast();
});
ipcMain.handle('app:launch', (_e, id: string) => launchApp(byId(id)));
ipcMain.handle('app:quit', (_e, id: string) => quitApp(byId(id)));
ipcMain.handle('app:forceQuit', (_e, id: string) => quitApp(byId(id), true));
ipcMain.handle('app:show', (_e, id: string) => showApp(byId(id)));
ipcMain.handle('app:open', (event, id: unknown) => {
  validateSender(event);
  return openApp(byId(z.string().parse(id)));
});
// Accessibility, asked of macOS as Switchboard itself. Its helper inherits
// the answer, because macOS attributes a child process to the app that
// started it. 'request' shows macOS's dialog, but only the first time: once
// Switchboard is listed, even switched off or stale after a rebuild, macOS
// stays silent, so the window also offers to open the pane directly.
function accessibilityTrusted(prompt = false): boolean {
  return process.platform === 'darwin' && systemPreferences.isTrustedAccessibilityClient(prompt);
}
async function checkAccessibility(action: unknown) {
  const a = z.enum(['check', 'request', 'open']).parse(action);
  if (a === 'open')
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  const trusted = accessibilityTrusted(a === 'request');
  if (trusted) desktopWatch.poke();
  return trusted;
}
ipcMain.handle('app:accessibility', (_e, action: unknown) => checkAccessibility(action));
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
  try {
    const stopControl = await serveAppControl(async (command) => {
      // A CLI add/rename may precede the debounced store watcher. Resolve the
      // request against the same fresh store the CLI just read.
      const next = profiles.readIfChanged();
      if (next) applyReload(next);
      switch (command.command) {
        case 'caffeinate': {
          const { action, minutes, lid } = command;
          if (action === 'start') await caffeinate.start(minutes, { lid });
          else if (action === 'extend') await caffeinate.extend(minutes);
          else if (action === 'status') await caffeinate.refresh();
          else await caffeinate[action]();
          return caffeinate.snapshot();
        }
        case 'fans': {
          if (command.action === 'set') await fans.set(command.level ?? -1, command.minutes ?? -1);
          else if (command.action === 'extend') await fans.extend(command.minutes);
          else if (command.action === 'status') await fans.refresh();
          else await fans[command.action]();
          return fans.snapshot();
        }
        case 'accessibility':
          return {
            trusted: await checkAccessibility(command.action === 'status' ? 'check' : 'open'),
            identity: { name: app.getName(), executable: process.execPath, packaged: app.isPackaged },
          };
        case 'focus': {
          const p = byId(command.profile);
          if (!launch.instanceFor(p, await launch.runningInstances()))
            throw new CliError('desktop-not-running', `${p.name} is not running. Focus only shows an existing app.`, 4);
          await showApp(p);
          return { profile: ref(p), shown: true };
        }
        case 'force-quit':
          return quitApp(byId(command.profile), true);
      }
    });
    app.on('will-quit', stopControl);
  } catch (error) {
    console.error('Local CLI control unavailable; continuing app startup:', error);
  }
  await launch.adoptLoginShellPath();
  applyAppearance();
  if (!BACKGROUND) createTray();
  // The helper ends a boost on sleep; read why once awake again.
  void caffeinate.refresh();
  void fans.refresh();
  powerMonitor.on('resume', () => {
    void caffeinate.refresh();
    void fans.refresh();
  });
  // Closing the bridge ends its connection, and the helper gives back any
  // boost or lid-closed hold; the power assertion goes with the process.
  app.on('will-quit', () => systemBridge?.close());
  // Launched at login: stay in the menu bar, don't pop the window.
  const hidden = app.getLoginItemSettings().wasOpenedAtLogin;
  if (!hidden) createWindow();
  void resumeInterruptedBuckets();
  // Asleep or locked, there is nobody to show numbers to.
  powerMonitor.on('suspend', () => pausePolling('sleep'));
  // Locked, there is nobody at the Mac, but with phone access on the phone
  // still shows usage and is told when a profile runs low.
  powerMonitor.on('lock-screen', () => {
    screenLocked = true;
    if (!data.settings.phoneAccess) pausePolling('lock');
  });
  powerMonitor.on('unlock-screen', () => {
    screenLocked = false;
  });
  powerMonitor.on('resume', () => void resumePolling('sleep'));
  powerMonitor.on('unlock-screen', () => void resumePolling('lock'));
  if (powerMonitor.getSystemIdleState(1) === 'locked' && !data.settings.phoneAccess) pollingPause.pause('lock');
  desktopWatch.setPaused(pollingPause.paused);
  desktopWatch.start();
  app.on('will-quit', () => desktopWatch.stop());
  schedulePolling();
  if (!pollingPause.paused) await refreshAll().catch(() => {});
  const stopWatching = profiles.watchStore(applyReload);
  app.on('will-quit', stopWatching);
  void applyPhoneAccess();
  app.on('will-quit', () => {
    if (hub) clearHubStatus();
  });
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
