import { expect, test } from 'bun:test';
import { buildDigest, digestDue, digestNote, lastWeekEnd, thisMonday } from '../src/history/digest';
import type { UsageReport, UsageTotals } from '../src/types';

const local = (s: string) => Date.parse(s); // no zone: local time, as the app's days are
const H = 3_600_000;

test('the week runs Monday to Sunday, local time', () => {
  const wednesday = local('2026-10-28T15:00:00');
  expect(thisMonday(wednesday)).toBe(local('2026-10-26T00:00:00'));
  expect(thisMonday(local('2026-10-26T00:00:00'))).toBe(local('2026-10-26T00:00:00'));
  expect(thisMonday(local('2026-11-01T23:00:00'))).toBe(local('2026-10-26T00:00:00'));
  expect(lastWeekEnd(wednesday)).toBe(local('2026-10-26T00:00:00') - 1);
});

test('the notification is due once a week, from 9:00 on Monday', () => {
  expect(digestDue(local('2026-10-26T08:59:00'), '2026-10-19')).toBeNull();
  expect(digestDue(local('2026-10-26T09:00:00'), '2026-10-19')).toBe('2026-10-26');
  expect(digestDue(local('2026-10-26T09:05:00'), '2026-10-26')).toBeNull();
  // A Mac asleep all Monday hears it on Wednesday instead.
  expect(digestDue(local('2026-10-28T10:00:00'), '2026-10-19')).toBe('2026-10-26');
  expect(digestDue(local('2026-10-28T10:00:00'), null)).toBe('2026-10-26');
});

const totals = (value: number, agentMs: number): UsageTotals => ({
  value,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  agentMs,
  sessions: 3,
  projects: 1,
  limitHits: 1,
  waitedMs: H,
  unpricedTokens: 0,
});

function report(recordedSince: string | null): UsageReport {
  const days = ['19', '20', '21', '22', '23', '24', '25'].map((d) => `2026-10-${d}`);
  return {
    days: 7,
    generatedAt: new Date(local('2026-10-26T00:00:00') - 1).toISOString(),
    recordedSince,
    indexedAt: null,
    pricesAsOf: '2026-09-24',
    totals: totals(462, 38 * H),
    previous: totals(400, 30 * H),
    previousHasLimits: true,
    accounts: [
      { profile: 'work', tightest: null, value: 300, tokens: totals(0, 0).tokens },
      { profile: 'personal', tightest: null, value: 162, tokens: totals(0, 0).tokens },
    ],
    forecast: null,
    daily: days.map((day, i) => ({ day, value: { work: i === 5 ? 120 : 30 }, tokens: {} })),
    heat: [],
    projects: [{ name: 'app', profiles: ['work'], value: 300, sessions: 2, agentMs: 20 * H }],
    models: [{ model: 'claude-opus-5', value: 400, tokens: 1, sessions: 3 }],
    mix: [],
    cacheHit: [],
    blocks: [
      {
        profile: 'personal',
        kind: 'window',
        label: '5h',
        start: '2026-10-24T08:00:00.000Z',
        end: '2026-10-24T13:00:00.000Z',
        peak: 100,
        hitAt: new Date(local('2026-10-24T11:00:00')).toISOString(),
        waitedMs: H,
        current: false,
        value: 50,
        points: [],
        sessions: [],
      },
    ],
  };
}

test('the digest sums up the week and sets each account against its plan', () => {
  const d = buildDigest(report('2026-10-01'), { work: 150 });
  expect(d).toMatchObject({
    from: '2026-10-19',
    to: '2026-10-25',
    value: 462,
    busiest: { day: '2026-10-24', value: 120 },
    project: { name: 'app', value: 300 },
    ready: true,
  });
  expect(d.limitHits).toBe(1);
  expect(d.hits).toHaveLength(1);
  const work = d.accounts.find((a) => a.profile === 'work');
  expect(work?.times).toBeCloseTo(300 / ((150 * 7) / (365.25 / 12)));
  expect(d.accounts.find((a) => a.profile === 'personal')).toMatchObject({ planCost: null, times: null });
  expect(digestNote(d, (id) => (id === 'work' ? 'Claude · Work' : id))).toEqual({
    title: 'Your week in Switchboard',
    body: '38 agent hours, $462 of value. Hit a limit once, on Saturday. Claude · Work came to 8.7× its plan.',
  });
});

test('the notification waits for two recorded weeks', () => {
  expect(buildDigest(report('2026-10-13'), {}).ready).toBe(false);
  expect(buildDigest(report('2026-10-12'), {}).ready).toBe(true);
  expect(buildDigest(report(null), {}).ready).toBe(false);
});
