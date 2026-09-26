// Shapes shared between the main process, the preload bridge and the
// renderer. The renderer reaches them through `import()` types only, so it
// stays a plain script with no module wrapper.

import type { AwakeRefresh, AwakeState, AwakeValue } from './awake';

export type Vendor = 'claude' | 'codex';

export interface VendorInfo {
  label: string;
  appPath: string;
  appBinary: string;
  cli: string;
  defaultHome: string;
  defaultDesktop: string;
  homeEnv: string;
}

export type BringMode = 'link' | 'copy';

export interface Profile {
  id: string;
  vendor: Vendor;
  name: string;
  isDefault: boolean;
  color: string;
  proxyBucket?: string;
  createdAt?: string;
  setup?: { from: string; items: string[]; mode: BringMode; at: string };
}

export type UsageMode = 'used' | 'remaining';

export type Appearance = 'system' | 'light' | 'dark';
export type MenuBarStyle = 'icon' | 'percent';
export type ProfilesView = 'cards' | 'list';

export interface Settings {
  terminal: string;
  pollMinutes: number;
  usageMode: UsageMode;
  openAtLogin?: boolean;
  appearance?: Appearance;
  menuBar?: MenuBarStyle;
  view?: ProfilesView;
  // Tell an app running with its window closed from one in use. Needs
  // Accessibility permission; see src/native/app-events.swift.
  noticeClosedWindows?: boolean;
  // Notify when a window reaches 90% and when a full one resets. On unless
  // switched off.
  usageAlerts?: boolean;
}

export interface Store {
  settings: Settings;
  profiles: Profile[];
  loadError?: string;
}

export interface Dirs {
  home: string;
  desktop: string;
  isDefault: boolean;
}

export interface SetupItem {
  id: string;
  label: string;
  hint?: string;
  kind: 'paths' | 'preferences' | 'connectors';
  paths?: string[];
  tables?: string[];
  copyOnly?: boolean;
  projectState?: boolean;
  on: boolean;
  warn?: boolean;
}

export interface BringResult {
  done: string[];
  skipped: { item: string; reason: string }[];
}

export interface BringOptions {
  items?: string[];
  mode?: BringMode;
}

export interface AddOptions extends BringOptions {
  vendor: Vendor;
  name: string;
  sourceId?: string | null;
}

export interface UsageWindow {
  label: string;
  pct: number | null;
  resetsAt: string | null;
  severity?: string | null;
}

export interface Usage {
  windows?: UsageWindow[];
  plan?: string | null;
  fetchedAt?: string;
  error?: string;
  retryAfterMs?: number;
  stale?: boolean;
}

export interface Identity {
  loggedIn: boolean;
  email?: string | null;
  plan?: string | null;
  org?: string | null;
  mode?: string;
  error?: string | null;
}

// What the app persists between runs, per profile id, so the window and the
// CLI have numbers before the first fetch.
export interface CacheEntry {
  identity: Identity;
  usage?: Pick<Usage, 'windows' | 'plan' | 'fetchedAt'>;
}
export type LiveCache = Record<string, CacheEntry>;

// A profile's desktop app, as the window and tray show it. `starting` and
// `quitting` are a launch or quit Switchboard sent that the process list has
// not confirmed yet; `stalled` is a quit that passed its deadline with the
// app still running; `background` is running with no window open, known only
// when closed windows are being noticed. See app-state.ts.
export type AppState = 'off' | 'starting' | 'running' | 'background' | 'quitting' | 'stalled';

// What the native helper makes possible here: Show window needs the helper;
// noticing closed windows also needs Accessibility, which is `missing` until
// the person grants it and `off` while the setting is off.
export interface DesktopSupport {
  helper: boolean;
  accessibility: 'granted' | 'missing' | 'off';
}

// What the main process knows about a profile beyond the store: what its
// desktop app is doing, who is signed in, and the last usage numbers.
export interface Live {
  app?: AppState;
  identity?: Identity;
  usage?: Usage;
  cached?: boolean;
  backoffUntil?: number | null;
  identityAt?: number;
}

export interface Instance {
  pid: number;
  vendor: Vendor;
  userDataDir: string | null;
}

export interface SetupItemView {
  id: string;
  label: string;
  hint?: string;
  kind: SetupItem['kind'];
  on: boolean;
  warn?: boolean;
  copyOnly?: boolean;
  size: string | null;
}

export interface ProfileView extends Profile, Live {
  dirs: Dirs;
  cli: string;
}

export interface BucketView {
  id: string;
  name: string;
  status: 'running' | 'stopped' | 'unreachable';
  accounts: import('./buckets/proxy').AccountUsage[];
  error?: string;
}

// ---- usage history (see src/history/) ----

// Tokens in the four kinds the vendors bill. `input` is input that was not
// served from cache; `output` includes reasoning.
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// Where an agent session ran: the CLI in a terminal, a desktop app's own
// agent, a script through an SDK or `codex exec`, or anything else.
export type SessionEntry = 'cli' | 'desktop' | 'sdk' | 'other';

// A period's totals. Value is the API-equivalent estimate in dollars; tokens
// of models the price table does not know are counted in `unpricedTokens`.
export interface UsageTotals {
  value: number;
  tokens: TokenCounts;
  agentMs: number;
  sessions: number;
  projects: number;
  limitHits: number;
  waitedMs: number;
  unpricedTokens: number;
}

// A live window with its pace: how many points ahead (+) or behind (−) of
// an even burn across the window it is, or null while too little of the
// window has passed to say.
export interface WindowPace {
  label: string;
  pct: number;
  resetsAt: string;
  pace: number | null;
}

// A window on course to run out before it resets, and the same vendor's
// account with the most room.
export interface UsageForecast {
  profile: string;
  label: string;
  pct: number;
  resetsAt: string;
  fullAt: string;
  ratePerHour: number;
  pace: number | null;
  alternative: { profile: string; label: string; pct: number } | null;
}

// One agent session, as the Sessions view lists it. The project is the
// folder's name only; the full path stays in the main process.
export interface UsageSession {
  id: string;
  profile: string;
  title: string;
  project: string;
  entry: SessionEntry;
  start: string;
  end: string;
  prompts: number;
  agentMs: number;
  model: string | null;
  value: number | null;
  tokens: TokenCounts;
  cacheHit: number | null;
  tools: [string, number][];
  files: string[];
  fileCount: number;
  subagents: { calls: number; value: number | null; model: string | null } | null;
  // Estimated share of its window, in percentage points of that window.
  share: number | null;
}

// Sessions grouped by the window they counted against, or by day where no
// window history covers them. `points` are the window's recorded
// percentages, [time in ms, pct], for the chart of how it filled.
export interface UsageBlock {
  profile: string;
  kind: 'window' | 'day';
  label: string;
  start: string;
  end: string;
  peak: number | null;
  hitAt: string | null;
  waitedMs: number;
  current: boolean;
  value: number | null;
  points: [number, number][];
  sessions: UsageSession[];
}

// Everything the Usage tab draws, for one range of days. Never a token, a
// credential or a full path.
export interface UsageReport {
  days: number;
  generatedAt: string;
  // When Switchboard began keeping usage history, if it has.
  recordedSince: string | null;
  indexedAt: string | null;
  pricesAsOf: string;
  totals: UsageTotals;
  previous: UsageTotals | null;
  // Whether the previous period's limit hits were recorded, and so worth
  // comparing with.
  previousHasLimits: boolean;
  accounts: { profile: string; tightest: WindowPace | null; value: number; tokens: TokenCounts }[];
  forecast: UsageForecast | null;
  daily: { day: string; value: Record<string, number>; tokens: Record<string, number> }[];
  // One entry per day for 26 weeks; null where nothing was recorded yet.
  heat: { day: string; agentMs: number | null }[];
  projects: { name: string; profiles: string[]; value: number; sessions: number; agentMs: number }[];
  models: { model: string; value: number | null; tokens: number; sessions: number }[];
  mix: { kind: keyof TokenCounts; tokens: number; value: number }[];
  cacheHit: { profile: string; pct: number | null }[];
  blocks: UsageBlock[];
}

// Whether the `switchboard` command is installed, and where.
export interface CliStatus {
  file: string;
  installed: boolean;
  ours: boolean;
  onPath: boolean;
  appInstalled: boolean;
}

// Everything the window renders from. Never a token.
export interface State {
  awake: AwakeState;
  settings: Settings;
  palette: string[];
  terminals: { id: string; label: string }[];
  setupItems: Record<Vendor, SetupItemView[]>;
  vendors: Record<Vendor, { label: string; installed: boolean }>;
  profiles: ProfileView[];
  buckets: BucketView[];
  bucketsError?: string;
  cli?: CliStatus;
  desktop: DesktopSupport;
}

// The preload bridge, as `window.sb` in the renderer.
export interface SwitchboardApi {
  setAwake(value: AwakeValue): Promise<void>;
  refreshAwake(reason?: AwakeRefresh): Promise<void>;
  onAwakeState(fn: (s: AwakeState) => void): void;
  getState(): Promise<State>;
  setProxyBucket(id: string, bucket: string | null): Promise<void>;
  createBucket(name: string): Promise<void>;
  bucketAction(
    id: string,
    action: 'start' | 'refresh' | 'stop' | 'login',
    provider?: 'codex' | 'claude',
  ): Promise<void>;
  setBucketAccount(id: string, name: string, enabled: boolean): Promise<void>;
  removeBucket(id: string): Promise<boolean>;
  removeBucketAccount(id: string, name: string): Promise<boolean>;
  measureSizes(): Promise<State>;
  refresh(id?: string): Promise<State>;
  addProfile(p: AddOptions): Promise<{ profile: Profile; result: BringResult }>;
  removeProfile(id: string): Promise<boolean>;
  updateProfile(id: string, patch: { name?: string; color?: string }): Promise<void>;
  moveProfile(id: string, delta: number): Promise<boolean>;
  bringOver(id: string, sourceId: string, opts: BringOptions): Promise<BringResult>;
  saveSettings(s: Partial<Settings>): Promise<void>;
  launch(id: string): Promise<void>;
  quit(id: string): Promise<void>;
  forceQuit(id: string): Promise<void>;
  showWindow(id: string): Promise<void>;
  // Whether Switchboard has Accessibility permission. 'request' also asks
  // macOS to show its dialog; 'open' opens that pane of System Settings.
  accessibility(action: 'check' | 'request' | 'open'): Promise<boolean>;
  quitOthers(id: string): Promise<number>;
  login(id: string): Promise<void>;
  shell(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  copyCommand(id: string): Promise<void>;
  installCli(): Promise<CliStatus>;
  onState(fn: (s: State) => void): void;
  // The Usage tab: a report for the last `days` days, a signal that there
  // is a newer one, and opening a listed session.
  usageReport(days: number): Promise<UsageReport>;
  onUsageChanged(fn: () => void): void;
  resumeSession(profile: string, id: string): Promise<void>;
  openSession(profile: string, id: string, what: 'folder' | 'transcript'): Promise<void>;
}
