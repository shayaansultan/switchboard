// Small helpers shared by the views: time words, the colour a usage window
// deserves, and the one way every button talks to the main process.

export type State = import('../types').State;
export type ProfileView = import('../types').ProfileView;
export type UsageWindow = import('../types').UsageWindow;
export type Identity = import('../types').Identity;
export type Usage = import('../types').Usage;
export type Vendor = import('../types').Vendor;
export type AppState = import('../types').AppState;
export type BringMode = import('../types').BringMode;
export type Settings = import('../types').Settings;
export type ProfilesView = import('../types').ProfilesView;
export type BucketView = import('../types').BucketView;
export type BucketAccount = BucketView['accounts'][number];
export type CliStatus = import('../types').CliStatus;
export type UsageReport = import('../types').UsageReport;
export type UsageBlock = import('../types').UsageBlock;
export type UsageSession = import('../types').UsageSession;
export type TokenCounts = import('../types').TokenCounts;
export type WindowPace = import('../types').WindowPace;

export function relTime(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'resets now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `resets in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `resets in ${h}h ${m % 60}m` : `resets in ${h}h`;
  return `resets in ${Math.round(h / 24)}d`;
}

// The same moment without the words, for the space beside a bar's label.
export function relShort(iso: string | null): string {
  return relTime(iso).replace(/^resets (in )?/, '');
}

// How long ago, for the refresh line: "just now", "2m ago", "3h ago".
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function clock(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
}

// Colour always reflects how close the window is to running out.
export function severityClass(w: UsageWindow): string {
  const pct = w.pct ?? 0;
  return w.severity === 'critical' || pct >= 90 ? 'bad' : w.severity === 'warning' || pct >= 70 ? 'warn' : '';
}

// The account's fullest window, for the ring and the menu bar alike.
export function fullest(windows: UsageWindow[] | undefined): UsageWindow | null {
  const known = (windows ?? []).filter((w) => w.pct !== null && w.pct !== undefined);
  if (!known.length) return null;
  return known.reduce((a, b) => ((b.pct ?? 0) > (a.pct ?? 0) ? b : a));
}

// Run an action from a button: the button is disabled while it runs, and a
// failure is shown rather than swallowed.
export async function act(fn: () => unknown, btn?: EventTarget | null): Promise<void> {
  const b = btn instanceof HTMLButtonElement ? btn : null;
  if (b) b.disabled = true;
  try {
    await fn();
  } catch (e) {
    alert((e as Error).message || String(e));
  } finally {
    if (b) b.disabled = false;
  }
}

// Dollars as the Usage tab shows them: whole from $100, cents below.
export function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (v >= 100) return `$${Math.round(v).toLocaleString('en-US')}`;
  return `$${v.toFixed(2)}`;
}

// 1.94B, 134M, 12K, 800.
export function count(n: number): string {
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2).replace(/\.?0+$/, '')}${unit}`;
    }
  }
  return String(Math.round(n));
}

// 2 h 05 m, 38 m, under a minute.
export function duration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return ms > 0 ? '<1 m' : '0 m';
  if (m < 60) return `${m} m`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}

// "Today", "Yesterday", "Tue 23 Sep".
export function dayWord(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// The profile a usage row belongs to, named as the Usage tab names it.
export function profileName(state: State, id: string): string {
  const p = state.profiles.find((x) => x.id === id);
  return p ? `${state.vendors[p.vendor].label} · ${p.name}` : id;
}

export function profileColor(state: State, id: string): string {
  return state.profiles.find((x) => x.id === id)?.color ?? 'var(--muted)';
}

export function providerLabel(account: BucketAccount): string {
  return account.provider === 'claude' ? 'Claude' : 'ChatGPT';
}
