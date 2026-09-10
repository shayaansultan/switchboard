// Shapes shared between the main process, the preload bridge and the
// renderer. The renderer reaches them through `import()` types only, so it
// stays a plain script with no module wrapper.

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
  createdAt?: string;
  setup?: { from: string; items: string[]; mode: BringMode; at: string };
}

export type UsageMode = 'used' | 'remaining';

export type Appearance = 'system' | 'light' | 'dark';

export interface Settings {
  terminal: string;
  pollMinutes: number;
  usageMode: UsageMode;
  openAtLogin?: boolean;
  appearance?: Appearance;
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

// What the main process knows about a profile beyond the store: whether its
// window is running, who is signed in, and the last usage numbers.
export interface Live {
  running?: boolean;
  identity?: Identity;
  usage?: Usage;
  cached?: boolean;
  backoffUntil?: number | null;
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

// Everything the window renders from. Never a token.
export interface State {
  settings: Settings;
  terminals: { id: string; label: string }[];
  setupItems: Record<Vendor, SetupItemView[]>;
  vendors: Record<Vendor, { label: string; installed: boolean }>;
  profiles: ProfileView[];
}

// The preload bridge, as `window.sb` in the renderer.
export interface SwitchboardApi {
  getState(): Promise<State>;
  measureSizes(): Promise<State>;
  refresh(id?: string): Promise<State>;
  addProfile(p: AddOptions): Promise<{ profile: Profile; result: BringResult }>;
  removeProfile(id: string): Promise<boolean>;
  updateProfile(id: string, patch: { name?: string; color?: string }): Promise<void>;
  bringOver(id: string, sourceId: string, opts: BringOptions): Promise<BringResult>;
  saveSettings(s: Partial<Settings>): Promise<void>;
  launch(id: string): Promise<void>;
  quit(id: string): Promise<void>;
  quitOthers(id: string): Promise<number>;
  login(id: string): Promise<void>;
  shell(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  copyCommand(id: string): Promise<void>;
  onState(fn: (s: State) => void): void;
}
