// Small helpers shared by the views: time words, the colour a usage window
// deserves, and the one way every button talks to the main process.
import { ago, clock, resetsIn } from '../shared/time';
import { fullest as sharedFullest, severity } from '../shared/usage';

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
export type ResetTarget = import('../types').ResetTarget;
export type ResetList = import('../types').ResetList;
export type ResetOffer = import('../types').ResetOffer;
export type ResetResult = import('../types').ResetResult;

// Time and usage in words and colours, shared with the menu bar and the
// phone app (src/shared).
export function relTime(iso: string | null): string {
  return resetsIn(iso);
}

// The same moment without the words, for the space beside a bar's label.
export function relShort(iso: string | null): string {
  return relTime(iso).replace(/^resets (in )?/, '');
}

export { ago, clock };

// Colour always reflects how close the window is to running out.
export function severityClass(w: UsageWindow): string {
  const s = severity(w);
  return s === 'ok' ? '' : s;
}

export function fullest(windows: UsageWindow[] | undefined): UsageWindow | null {
  return sharedFullest(windows);
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
