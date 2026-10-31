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

// A monthly plan price spread over `days` days, so a range's value can be
// set against what the plan cost for the same days.
export function planCostOver(monthly: number, days: number): number {
  return (monthly * days) / (365.25 / 12);
}

// How long a window is, by its label: "5h", "7d" and "Weekly", or one that
// names its length beside a model ("7d Opus", "Spark 5h"). Null when the
// label does not say.
export function windowMs(label: string): number | null {
  if (label === 'Weekly') return 7 * 24 * HOUR;
  const m = /(\d+)\s*([hd])\b/.exec(label);
  return m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) * HOUR : null;
}

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
  const span = windowMs(label);
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!span || Number.isNaN(at) || at <= now || remaining <= 0) return null;
  const timeLeft = at - now;
  const elapsed = span - timeLeft;
  if (elapsed < span / 10) return null;
  const used = 100 - remaining;
  if (used <= 0 || remaining * elapsed >= used * timeLeft) return 'ok';
  return { runsOutAt: now + (remaining * elapsed) / used };
}

// How far a window is ahead of an even burn across it, in points: 60% used
// halfway through is 10 ahead. Derived from the same reading as `pace`, and
// null exactly when it is, so a positive number always means `pace` says the
// window runs out before it resets.
export function pointsAhead(
  label: string,
  remaining: number,
  resetsAt: string | null | undefined,
  now: number,
): number | null {
  if (pace(label, remaining, resetsAt, now) === null) return null;
  const span = windowMs(label) as number;
  const elapsed = 1 - (Date.parse(resetsAt as string) - now) / span;
  return Math.round(100 - remaining - elapsed * 100);
}
