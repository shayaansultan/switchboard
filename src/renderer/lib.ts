// Small helpers shared by the views: time words, the colour a usage window
// deserves, and the one way every button talks to the main process.

export type State = import('../types').State;
export type ProfileView = import('../types').ProfileView;
export type UsageWindow = import('../types').UsageWindow;
export type Identity = import('../types').Identity;
export type Usage = import('../types').Usage;
export type Vendor = import('../types').Vendor;
export type BringMode = import('../types').BringMode;
export type Settings = import('../types').Settings;
export type ProfilesView = import('../types').ProfilesView;
export type BucketView = import('../types').BucketView;
export type BucketAccount = BucketView['accounts'][number];
export type CliStatus = import('../types').CliStatus;

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

export function providerLabel(account: BucketAccount): string {
  return account.provider === 'claude' ? 'Claude' : 'ChatGPT';
}
