// How full a rate-limit window is, the same way everywhere Switchboard shows
// one: the colour of a bar, which window an account is closest to running
// out of, and whether it will last to its reset at the pace it is going.
//
// The profile band (plugins/profile-band) runs inside Claude's engine and
// cannot import this, so it keeps its own copy of `pace`;
// test/shared-usage.test.ts fails if the two disagree.

export interface WindowLike {
  label: string;
  pct: number | null | undefined;
  resetsAt: string | null | undefined;
  severity?: string | null;
}

export type Severity = 'ok' | 'warn' | 'bad';

// Amber from 70% used, coral from 90%, or sooner when the vendor says so.
export function severity(w: Pick<WindowLike, 'pct' | 'severity'>): Severity {
  const pct = w.pct ?? 0;
  if (w.severity === 'critical' || pct >= 90) return 'bad';
  if (w.severity === 'warning' || pct >= 70) return 'warn';
  return 'ok';
}

// The window closest to running out, for a ring or the menu bar.
export function fullest<W extends WindowLike>(windows: readonly W[] | undefined): W | null {
  const known = (windows ?? []).filter((w) => w.pct !== null && w.pct !== undefined);
  if (!known.length) return null;
  return known.reduce((a, b) => ((b.pct ?? 0) > (a.pct ?? 0) ? b : a));
}

const HOUR = 3600_000;
// How long each kind of window is, by the labels the vendors use.
export const WINDOW_MS: Record<string, number> = {
  '5h': 5 * HOUR,
  '7d': 7 * 24 * HOUR,
  Weekly: 7 * 24 * HOUR,
};

// Whether a window lasts to its reset at the rate it has been used so far:
// 'ok' when it does, the moment it would run out when it does not, null when
// there is too little of the window behind us to say (its first tenth), no
// reset time, or nothing left, which the bar already says. A window runs out
// early precisely when less of it is left than of the time.
export function pace(
  label: string,
  remaining: number,
  resetsAt: string | null | undefined,
  now: number,
): 'ok' | { runsOutAt: number } | null {
  const windowMs = WINDOW_MS[label];
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!windowMs || Number.isNaN(at) || at <= now || remaining <= 0) return null;
  const timeLeft = at - now;
  const elapsed = windowMs - timeLeft;
  if (elapsed < windowMs / 10) return null;
  const used = 100 - remaining;
  if (used <= 0 || remaining * elapsed >= used * timeLeft) return 'ok';
  return { runsOutAt: now + (remaining * elapsed) / used };
}
