// The weekly digest: last week, Monday to Sunday, in a few numbers, for
// `switchboard digest` and the Monday notification. Built from the same
// report as the Usage tab, so the two never disagree; pure apart from the
// small file that remembers which week was last sent.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { planCostOver } from '../shared/usage';
import type { UsageReport } from '../types';
import { dayOf, DAY_MS } from './ledger';

export interface Digest {
  // The week's first and last day, local dates.
  from: string;
  to: string;
  value: number;
  agentMs: number;
  sessions: number;
  limitHits: { profile: string; label: string; at: string }[];
  waitedMs: number;
  // The week before, when it was recorded from its first day.
  previous: { value: number; agentMs: number } | null;
  busiest: { day: string; value: number } | null;
  project: { name: string; value: number } | null;
  model: { model: string; value: number } | null;
  // Each account's value, and against its plan where its owner set a price.
  accounts: { profile: string; value: number; planCost: number | null; times: number | null }[];
  // Two weeks recorded, the week and one before it: the notification waits
  // for that, so the first one is not a partial week compared with nothing.
  ready: boolean;
}

// Midnight at the start of this week's Monday, local time.
export function thisMonday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// The moment the report for last week is built at: the end of Sunday.
export const lastWeekEnd = (now: number): number => thisMonday(now) - 1;

const sum = (values: Record<string, number>) => Object.values(values).reduce((a, b) => a + b, 0);

// `report` is a 7-day report built at lastWeekEnd; `plans` each profile's
// monthly plan price, where set.
export function buildDigest(report: UsageReport, plans: Record<string, number | undefined>): Digest {
  const from = report.daily[0]?.day ?? dayOf(Date.parse(report.generatedAt));
  const to = report.daily.at(-1)?.day ?? from;
  const fromMs = Date.parse(`${from}T00:00:00`);
  const busiest = report.daily.reduce<Digest['busiest']>((best, d) => {
    const v = sum(d.value);
    return v > 0 && (!best || v > best.value) ? { day: d.day, value: v } : best;
  }, null);
  const hits = report.blocks
    .filter((b) => b.hitAt && Date.parse(b.hitAt) >= fromMs)
    .map((b) => ({ profile: b.profile, label: b.label, at: b.hitAt as string }))
    .sort((a, b) => a.at.localeCompare(b.at));
  const twoWeeksBack = dayOf(fromMs - 7 * DAY_MS);
  return {
    from,
    to,
    value: report.totals.value,
    agentMs: report.totals.agentMs,
    sessions: report.totals.sessions,
    limitHits: hits,
    waitedMs: report.totals.waitedMs,
    previous: report.previous ? { value: report.previous.value, agentMs: report.previous.agentMs } : null,
    busiest,
    project: report.projects[0] ? { name: report.projects[0].name, value: report.projects[0].value } : null,
    model: report.models[0] ? { model: report.models[0].model, value: report.models[0].value ?? 0 } : null,
    accounts: report.accounts
      .filter((a) => a.value > 0)
      .map((a) => {
        const monthly = plans[a.profile];
        const planCost = monthly === undefined ? null : planCostOver(monthly, report.days);
        return { profile: a.profile, value: a.value, planCost, times: planCost ? a.value / planCost : null };
      }),
    ready: !!report.recordedSince && report.recordedSince <= twoWeeksBack,
  };
}

const WEEKDAY = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'long' });
const hours = (ms: number) => Math.round(ms / 3_600_000);
const dollars = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

// The notification: "38 agent hours, $462 of value. Hit a limit once, on
// Saturday. Claude · Work came to 2.6× its plan."
export function digestNote(d: Digest, name: (profile: string) => string): { title: string; body: string } {
  const parts = [`${hours(d.agentMs)} agent hours, ${dollars(d.value)} of value.`];
  const n = d.limitHits.length;
  if (n === 0) parts.push('No limits hit.');
  else if (n === 1) parts.push(`Hit a limit once, on ${WEEKDAY(d.limitHits[0].at)}.`);
  else parts.push(`Hit a limit ${n} times.`);
  const best = d.accounts.filter((a) => a.times !== null).sort((a, b) => (b.times ?? 0) - (a.times ?? 0))[0];
  if (best?.times) parts.push(`${name(best.profile)} came to ${best.times.toFixed(1)}× its plan.`);
  return { title: 'Your week in Switchboard', body: parts.join(' ') };
}

// Whether the Monday notification is due: from 9:00 on Monday until the
// week is out, once per week. Returns the week's key (its Monday) to pass to
// `markDigest` once handled, or null.
export function digestDue(now: number, lastWeek: string | null): string | null {
  const monday = thisMonday(now);
  if (now < monday + 9 * 3_600_000) return null;
  const key = dayOf(monday);
  return key === lastWeek ? null : key;
}

export function lastDigest(dir: string): string | null {
  try {
    const week = JSON.parse(fs.readFileSync(path.join(dir, 'digest.json'), 'utf8')).week;
    return typeof week === 'string' ? week : null;
  } catch {
    return null;
  }
}

export function markDigest(dir: string, week: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'digest.json'), JSON.stringify({ week }));
}
