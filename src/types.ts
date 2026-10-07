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

// A usage reset a vendor has saved on an account, as the window and the CLI
// see it. `detail` is the same facts as one line of prose for --human output.
export interface ResetOffer {
  id: string;
  title: string;
  detail: string;
  usable: boolean;
  // How many resets the grant holds, when the vendor counts them.
  remaining: number | null;
  expiresAt: string | null;
  // What spending it restores, as a sentence.
  clears: string;
  // Why it cannot be spent now, when it cannot.
  reason?: string;
}
export interface ResetResult {
  outcome:
    | 'reset'
    | 'already_used'
    | 'not_limited'
    | 'cooldown'
    | 'ineligible'
    | 'unavailable'
    | 'nothing_to_reset'
    | 'no_credit'
    | 'already_redeemed';
  proxyRecovery: 'not-needed' | 'refreshed' | 'deferred' | 'unconfirmed';
  message: string;
}
// Whose resets the dialog is showing: a profile's own sign-in, or one
// account in a proxy bucket.
export type ResetTarget = { kind: 'profile'; id: string } | { kind: 'bucket'; id: string; account: string };
// What the window gets back when it opens the dialog. The main process keeps
// the pinned account and credentials; `token` names that session for redeem.
export interface ResetList {
  token: string;
  account: string;
  note: string;
  offers: ResetOffer[];
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
  listResets(target: ResetTarget): Promise<ResetList>;
  redeemReset(token: string, offerId: string): Promise<ResetResult>;
  closeResets(token: string): Promise<void>;
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
}
