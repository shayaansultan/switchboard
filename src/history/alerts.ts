// Which usage notifications a refresh warrants: a window that has just
// reached 90%, and a window that was at 90% or more and has reset. Pure, so
// the rules are testable; main.ts shows what this returns.

import type { UsageWindow, Vendor } from '../types';
import { roomiest, sameReset, type LiveProfile } from './windows';

const ALERT_AT = 90;

export interface AlertProfile {
  id: string;
  vendor: Vendor;
  label: string;
}

export interface Alert {
  profile: string;
  title: string;
  body: string;
}

function resetTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
  const live: LiveProfile[] = profiles.map((p) => ({ id: p.id, vendor: p.vendor, windows: after.get(p.id) }));
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
      if (old.pct < ALERT_AT && w.pct >= ALERT_AT && !reset) {
        const alt = roomiest(live, p, now);
        const when = resetTime(w.resetsAt);
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
      } else if (reset && old.pct >= ALERT_AT) {
        out.push({ profile: p.id, title: `${p.label} is free again`, body: `Its ${w.label} window reset.` });
      }
    }
  }
  return out;
}
