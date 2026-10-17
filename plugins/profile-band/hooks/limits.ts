// The band's arithmetic on a rate-limit window: how long until it resets,
// when, and whether it lasts until then. Kept apart from register.tsx so
// Switchboard's own tests can hold `pace` to the app's copy in
// src/shared/usage.ts, which this mod, running inside Claude's engine,
// cannot import.

import type { BandWindow } from '../types';

const HOUR = 60 * 60 * 1000;
const WINDOW_MS: Record<string, number> = { '5h': 5 * HOUR, '7d': 7 * 24 * HOUR };

// "2h 5m", "40m", "3d": how long until a window resets.
export function until(resetsAt: string | null, now: number): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (Number.isNaN(at) || at <= now) return null;
  const minutes = Math.round((at - now) / 60000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.round(minutes / 1440)}d`;
}

// "Sat 02:00", or "16:20" without the day: a local time, for the 7-day reset,
// whose reset is days off and easier to plan around as a date than a count.
// Rounded to the minute: resets land a moment before the hour (01:59:59.9).
export function clockTime(at: number, withDay: boolean, timeZone?: string): string {
  return new Date(Math.round(at / 60000) * 60000).toLocaleString('en-GB', {
    ...(withDay ? { weekday: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

export function resetsOn(resetsAt: string | null, now: number, timeZone?: string): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (Number.isNaN(at) || at <= now) return null;
  return clockTime(at, true, timeZone);
}

// Whether the window lasts to its reset at the rate it has been used so far:
// 'ok' when it does, the moment it would run out when it does not, null when
// there is too little of the window behind us to say (its first tenth) or no
// reset time, or nothing left, which the bar already says. The two answers are
// exact complements: a window runs out early precisely when less of it is left
// than of the time.
export function pace(w: BandWindow, now: number): 'ok' | { runsOutAt: number } | null {
  const windowMs = WINDOW_MS[w.label];
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!windowMs || Number.isNaN(at) || at <= now || w.remaining <= 0) return null;
  const timeLeft = at - now;
  const elapsed = windowMs - timeLeft;
  if (elapsed < windowMs / 10) return null;
  const used = 100 - w.remaining;
  if (used <= 0 || w.remaining * elapsed >= used * timeLeft) return 'ok';
  return { runsOutAt: now + (w.remaining * elapsed) / used };
}
