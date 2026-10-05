// Which usage notifications a refresh warrants: a window that has just
// reached 90%, and a window that was at 90% or more and has reset. Pure, so
// the rules are testable; main.ts shows what this returns. An account signed
// in to several profiles fills the same windows in each, and is told once.

import type { UsageWindow, Vendor } from '../types';
import { dayOf } from './ledger';
import { roomiest, sameReset, type LiveProfile } from './windows';

const ALERT_AT = 90;

export interface AlertProfile {
  id: string;
  vendor: Vendor;
  label: string;
  // The account's email, when known.
  account?: string;
}

export interface Alert {
  profile: string;
  title: string;
  body: string;
}

// "3:00 PM" today, "Tue 3:00 PM" on another day (a 7-day window's reset).
function resetTime(iso: string | null, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return dayOf(at) === dayOf(now) ? time : `${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

// `after` holds every profile's current windows, so any of them can be the
// one with the most room; only the profiles in `fresh`, read just now, are
// checked for alerts.
export function alertsFor(
  before: Map<string, UsageWindow[]>,
  after: Map<string, UsageWindow[]>,
  profiles: AlertProfile[],
  fresh: Set<string>,
  now = Date.now(),
): Alert[] {
  const out: Alert[] = [];
  const told = new Set<string>();
  const live: LiveProfile[] = profiles.map((p) => ({
    id: p.id,
    vendor: p.vendor,
    windows: after.get(p.id),
    account: p.account,
  }));
  const name = (id: string) => profiles.find((p) => p.id === id)?.label ?? id;
  for (const p of profiles) {
    if (!fresh.has(p.id)) continue;
    const prev = before.get(p.id);
    // Nothing to compare with on the first reading after launch.
    if (!prev) continue;
    for (const w of after.get(p.id) ?? []) {
      const old = prev.find((x) => x.label === w.label);
      if (!old || w.pct === null || old.pct === null) continue;
      const reset = !sameReset(old.resetsAt, w.resetsAt) && w.pct < old.pct;
      const rising = old.pct < ALERT_AT && w.pct >= ALERT_AT && !reset;
      if (!rising && !(reset && old.pct >= ALERT_AT)) continue;
      // The same email at Claude and at Codex is two accounts.
      const key = `${p.account ? `${p.vendor}:${p.account}` : `profile:${p.id}`}\t${w.label}`;
      if (told.has(key)) continue;
      told.add(key);
      if (rising) {
        const alt = roomiest(live, p.vendor, now, p);
        const when = resetTime(w.resetsAt, now);
        out.push({
          profile: p.id,
          title: `${p.label} is at ${w.pct}%`,
          body: [
            `Its ${w.label} window${when ? ` resets at ${when}` : ' is nearly full'}.`,
            alt ? `${name(alt.profile)} has ${100 - alt.pct}% left.` : '',
          ]
            .filter(Boolean)
            .join(' '),
        });
      } else {
        out.push({ profile: p.id, title: `${p.label} is free again`, body: `Its ${w.label} window reset.` });
      }
    }
  }
  return out;
}
