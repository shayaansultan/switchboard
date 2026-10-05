// Window history: the percentages Switchboard already polls, kept instead
// of overwritten, so the Usage tab can say how a window filled, when an
// account hit its limit and how long it waited, and whether a window is on
// course to run out before it resets.
//
// A snapshot is appended only when a profile's windows change, to one file
// per month under ~/.switchboard/usage/. A window instance is one window
// between resets: its snapshots share a label and a reset time.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UsageForecast, UsageWindow, Vendor, WindowPace } from '../types';
import { dayOf } from './ledger';

export interface WindowRecord {
  at: number;
  profile: string;
  windows: { label: string; pct: number | null; resetsAt: string | null }[];
}

export interface WindowInstance {
  profile: string;
  label: string;
  start: number;
  end: number;
  peak: number;
  hitAt: number | null;
  points: [number, number][];
}

const HOUR = 3_600_000;
// Reset times drift by seconds between polls (Codex reports seconds left).
const SAME_RESET_MS = 10 * 60_000;

// "5h", "7d", "7d Opus", "Spark 5h": the window's length, if the label says.
export function windowLength(label: string): number | null {
  const m = /(\d+)\s*([hd])\b/.exec(label);
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'd' ? 24 : 1) * HOUR;
}

const sameResetMs = (a: number, b: number): boolean => Math.abs(a - b) <= SAME_RESET_MS;

// Whether two reset times are the same reset, allowing for the drift.
export function sameReset(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return sameResetMs(Date.parse(a), Date.parse(b));
}

const monthOf = (ms: number): string => dayOf(ms).slice(0, 7);

export class WindowHistory {
  private last = new Map<string, WindowRecord['windows']>();
  constructor(private readonly dir: string) {}

  // Appends the profile's windows if they differ from what was last
  // recorded for it. Returns whether it wrote.
  record(profile: string, windows: UsageWindow[], at = Date.now()): boolean {
    const shape = windows.map((w) => ({ label: w.label, pct: w.pct, resetsAt: w.resetsAt }));
    const prev = this.last.get(profile);
    const same =
      prev?.length === shape.length &&
      shape.every(
        (w, i) => w.label === prev[i].label && w.pct === prev[i].pct && sameReset(w.resetsAt, prev[i].resetsAt),
      );
    if (same) return false;
    this.last.set(profile, shape);
    const line: WindowRecord = { at, profile, windows: shape };
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(this.dir, `windows-${monthOf(at)}.jsonl`), JSON.stringify(line) + '\n', {
      mode: 0o600,
    });
    return true;
  }

  // Every record from `since` on, oldest first.
  read(since: number, until = Date.now()): WindowRecord[] {
    const out: WindowRecord[] = [];
    const first = new Date(since);
    for (
      let d = new Date(first.getFullYear(), first.getMonth(), 1);
      d.getTime() <= until;
      d.setMonth(d.getMonth() + 1)
    ) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.dir, `windows-${monthOf(d.getTime())}.jsonl`), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as WindowRecord;
          if (r.at >= since && r.at <= until) out.push(r);
        } catch {
          /* a torn last line */
        }
      }
    }
    return out.sort((a, b) => a.at - b.at);
  }

  // When recording began: the first whole line of the oldest month file
  // present. It only changes if that file goes, so it is looked up once.
  private began: number | null = null;
  firstRecordAt(): number | null {
    if (this.began !== null) return this.began;
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((n) => /^windows-\d{4}-\d{2}\.jsonl$/.test(n));
    } catch {
      return null;
    }
    for (const name of names.sort()) {
      let head = '';
      try {
        const fd = fs.openSync(path.join(this.dir, name), 'r');
        try {
          const buf = Buffer.alloc(64 * 1024);
          head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      // The last piece may be cut short by the read or still being written.
      for (const line of head.split('\n').slice(0, -1)) {
        try {
          const at = (JSON.parse(line) as WindowRecord).at;
          if (typeof at === 'number') return (this.began = at);
        } catch {
          /* a torn line */
        }
      }
    }
    return null;
  }
}

// The window instances in a profile's records, oldest first.
export function instances(records: WindowRecord[], profile: string): WindowInstance[] {
  const open = new Map<string, WindowInstance>();
  const done: WindowInstance[] = [];
  for (const r of records) {
    if (r.profile !== profile) continue;
    for (const w of r.windows) {
      const len = windowLength(w.label);
      const end = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
      if (!len || Number.isNaN(end) || w.pct === null) continue;
      let cur = open.get(w.label);
      if (cur && !sameResetMs(cur.end, end)) {
        done.push(cur);
        cur = undefined;
      }
      if (!cur) {
        cur = { profile, label: w.label, start: end - len, end, peak: 0, hitAt: null, points: [] };
        open.set(w.label, cur);
      }
      cur.points.push([r.at, w.pct]);
      cur.peak = Math.max(cur.peak, w.pct);
      if (w.pct >= 100 && cur.hitAt === null) cur.hitAt = r.at;
    }
  }
  return [...done, ...open.values()].sort((a, b) => a.start - b.start);
}

// Time spent at the limit: from the hit until the window reset, or until now.
export const waited = (i: WindowInstance, now: number): number =>
  i.hitAt === null ? 0 : Math.max(0, Math.min(i.end, now) - i.hitAt);

// How far ahead of an even burn a live window is, in points. Too early in
// a window to say (under 3% of it gone) or past its reset gives null.
export function pace(w: { label: string; pct: number | null; resetsAt: string | null }, now: number): number | null {
  const len = windowLength(w.label);
  const end = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!len || Number.isNaN(end) || w.pct === null) return null;
  const elapsed = 1 - (end - now) / len;
  if (elapsed < 0.03 || elapsed > 1) return null;
  return Math.round(w.pct - elapsed * 100);
}

// A profile's fullest live window, with its pace.
export function tightest(windows: UsageWindow[] | undefined, now: number): WindowPace | null {
  const known = (windows ?? []).filter((w) => w.pct !== null && w.resetsAt);
  if (!known.length) return null;
  const w = known.reduce((a, b) => ((b.pct ?? 0) > (a.pct ?? 0) ? b : a));
  return { label: w.label, pct: w.pct ?? 0, resetsAt: w.resetsAt as string, pace: pace(w, now) };
}

export interface LiveProfile {
  id: string;
  vendor: Vendor;
  windows: UsageWindow[] | undefined;
  // The windows came from the cache or a failed reading, so the room they
  // show may be gone.
  stale?: boolean;
  // The account's email. One account can be signed in to several profiles,
  // which then share its windows.
  account?: string;
}

// How fast a window is filling, in points an hour: over the last hour of
// its history where there is one, else since the window began.
function rate(list: WindowInstance[], w: UsageWindow, now: number): number | null {
  const end = Date.parse(w.resetsAt as string);
  const len = windowLength(w.label) as number;
  const mine = list.find((i) => i.label === w.label && sameResetMs(i.end, end));
  const pct = w.pct ?? 0;
  const before = mine?.points.filter(([at]) => at <= now - HOUR).at(-1);
  const first = mine?.points[0];
  // Over the time since the last reading an hour or more ago. The window may
  // have stood there until much later, but only if Switchboard was watching;
  // after a night asleep the rise may be the whole night's, and taking it as
  // the last hour's would warn of a window that is filling slowly.
  if (before) return ((pct - before[1]) * HOUR) / (now - before[0]);
  if (first && now - first[0] >= 15 * 60_000) return ((pct - first[1]) * HOUR) / (now - first[0]);
  const elapsed = now - (end - len);
  return elapsed >= len * 0.03 ? (pct * HOUR) / elapsed : null;
}

// The window closest to running out before it resets, and where to go
// instead: the same vendor's account whose fullest window is emptiest.
// `history` is each profile's window instances.
export function forecast(
  history: Map<string, WindowInstance[]>,
  live: LiveProfile[],
  now: number,
): UsageForecast | null {
  let best: UsageForecast | null = null;
  for (const p of live) {
    for (const w of p.windows ?? []) {
      if (w.pct === null || w.pct < 50 || w.pct >= 100 || !w.resetsAt || !windowLength(w.label)) continue;
      const r = rate(history.get(p.id) ?? [], w, now);
      if (!r || r <= 0) continue;
      const fullAt = now + ((100 - w.pct) / r) * HOUR;
      const resetsAt = Date.parse(w.resetsAt);
      if (fullAt >= resetsAt - 10 * 60_000) continue;
      if (best && fullAt >= Date.parse(best.fullAt)) continue;
      best = {
        profile: p.id,
        label: w.label,
        pct: w.pct,
        resetsAt: w.resetsAt,
        fullAt: new Date(fullAt).toISOString(),
        ratePerHour: Math.round(r * 10) / 10,
        pace: pace(w, now),
        alternative: roomiest(live, p.vendor, now, p),
      };
    }
  }
  return best;
}

// The vendor's profile whose fullest window is emptiest, other than
// `except` and any profile on the same account as it.
export function roomiest(
  live: LiveProfile[],
  vendor: Vendor,
  now: number,
  except?: { id: string; account?: string },
): { profile: string; label: string; pct: number } | null {
  let best: { profile: string; label: string; pct: number } | null = null;
  for (const p of live) {
    if (p.vendor !== vendor || p.stale) continue;
    if (except && (p.id === except.id || (!!except.account && p.account === except.account))) continue;
    // A window whose reset has passed since the reading is empty now.
    const windows = p.windows?.map((w) => (w.resetsAt && Date.parse(w.resetsAt) <= now ? { ...w, pct: 0 } : w));
    const t = tightest(windows, now);
    if (t && t.pct < 90 && (!best || t.pct < best.pct)) best = { profile: p.id, label: t.label, pct: t.pct };
  }
  return best;
}
