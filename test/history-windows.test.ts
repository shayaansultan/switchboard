import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { alertsFor } from '../src/history/alerts';
import {
  forecast,
  instances,
  pace,
  tightest,
  waited,
  WindowHistory,
  windowLength,
  type WindowRecord,
} from '../src/history/windows';
import type { UsageWindow } from '../src/types';

const dir = path.join(sandboxHome, 'windows-test');
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const H = 3_600_000;
const NOW = Date.parse('2026-09-24T14:35:00Z');
const reset = (ms: number) => new Date(ms).toISOString();
const w = (label: string, pct: number | null, resetsAt: number): UsageWindow => ({
  label,
  pct,
  resetsAt: reset(resetsAt),
});

test('window lengths come from their labels', () => {
  expect(windowLength('5h')).toBe(5 * H);
  expect(windowLength('7d Opus')).toBe(7 * 24 * H);
  expect(windowLength('Spark 5h')).toBe(5 * H);
  expect(windowLength('window')).toBeNull();
});

test('records only changes, and reads them back across months', () => {
  const h = new WindowHistory(dir);
  const sept = Date.parse('2026-09-30T23:00:00Z');
  const oct = Date.parse('2026-10-01T01:00:00Z');
  expect(h.record('p', [w('5h', 10, sept + H)], sept)).toBe(true);
  expect(h.record('p', [w('5h', 10, sept + H)], sept + 60_000)).toBe(false);
  expect(h.record('p', [w('5h', 20, sept + H)], oct)).toBe(true);
  expect(fs.readdirSync(dir).length).toBeGreaterThanOrEqual(1);
  expect(h.read(sept - H, oct + H).map((r) => r.windows[0].pct)).toEqual([10, 20]);
  expect(h.firstRecordAt()).toBe(sept);
});

test('instances split at resets and note when the limit was hit', () => {
  const end1 = NOW - 2 * H;
  const end2 = NOW + 3 * H;
  const records: WindowRecord[] = [
    { at: end1 - 4 * H, profile: 'p', windows: [w('5h', 40, end1)] },
    { at: end1 - 2 * H, profile: 'p', windows: [w('5h', 100, end1 + 30_000)] },
    { at: end1 - H, profile: 'p', windows: [w('5h', 100, end1)] },
    { at: NOW - H, profile: 'p', windows: [w('5h', 20, end2)] },
    { at: NOW, profile: 'other', windows: [w('5h', 90, end2)] },
  ];
  const list = instances(records, 'p');
  expect(list.map((i) => [i.peak, i.points.length])).toEqual([
    [100, 3],
    [20, 1],
  ]);
  expect(list[0].hitAt).toBe(end1 - 2 * H);
  expect(waited(list[0], NOW)).toBe(2 * H);
  expect(list[0].start).toBe(end1 - 5 * H);
});

test('pace is how far ahead of an even burn a window is', () => {
  // Half of a 5-hour window gone, 70% used: 20 points ahead.
  expect(pace(w('5h', 70, NOW + 2.5 * H), NOW)).toBe(20);
  // Too early to say.
  expect(pace(w('5h', 5, NOW + 4.95 * H), NOW)).toBeNull();
  expect(tightest([w('5h', 12, NOW + H), w('7d', 52, NOW + 50 * H)], NOW)?.label).toBe('7d');
});

test('forecast finds the window that fills before it resets, and where to go instead', () => {
  const end = NOW + 2.5 * H;
  const records: WindowRecord[] = [
    { at: NOW - 1.5 * H, profile: 'personal', windows: [w('5h', 40, end)] },
    { at: NOW - H, profile: 'personal', windows: [w('5h', 48, end)] },
  ];
  const live = [
    { id: 'personal', vendor: 'claude' as const, windows: [w('5h', 68, end)] },
    { id: 'work', vendor: 'claude' as const, windows: [w('5h', 12, NOW + 4 * H)] },
    { id: 'codex', vendor: 'codex' as const, windows: [w('7d', 5, NOW + 90 * H)] },
  ];
  const history = (rs: WindowRecord[]) => new Map(live.map((p) => [p.id, instances(rs, p.id)]));
  const f = forecast(history(records), live, NOW);
  // 20 points in the last hour: full in 1.6 hours, before the reset.
  expect(f).toMatchObject({ profile: 'personal', label: '5h', ratePerHour: 20 });
  expect(Date.parse(f!.fullAt)).toBe(NOW + 1.6 * H);
  expect(f!.alternative).toEqual({ profile: 'work', label: '5h', pct: 12 });
  // At a slower pace it lasts until the reset, and there is nothing to say.
  expect(forecast(history([{ at: NOW - H, profile: 'personal', windows: [w('5h', 60, end)] }]), live, NOW)).toBeNull();
});

test('alerts at 90% and when a full window resets, never on the first reading', () => {
  const profiles = [
    { id: 'personal', vendor: 'claude' as const, label: 'Claude · Personal' },
    { id: 'work', vendor: 'claude' as const, label: 'Claude · Work' },
  ];
  const before = new Map([['personal', [w('5h', 85, NOW + H)]]]);
  const after = new Map([
    ['personal', [w('5h', 91, NOW + H)]],
    ['work', [w('5h', 12, NOW + 3 * H)]],
  ]);
  // Only Personal was read just now; Work's last reading still names it as
  // the account with room.
  const fresh = new Set(['personal']);
  const [high] = alertsFor(before, after, profiles, fresh, NOW);
  expect(high.title).toBe('Claude · Personal is at 91%');
  expect(high.body).toContain('Claude · Work has 88% left.');
  expect(alertsFor(new Map(), after, profiles, fresh, NOW)).toEqual([]);
  expect(alertsFor(before, after, profiles, new Set(), NOW)).toEqual([]);
  const later = new Map([['personal', [w('5h', 3, NOW + 6 * H)]]]);
  expect(alertsFor(after, later, profiles, fresh, NOW).map((a) => a.title)).toEqual([
    'Claude · Personal is free again',
  ]);
  // Staying above 90% is not news, nor is a reset time that drifted by seconds.
  expect(alertsFor(after, after, profiles, fresh, NOW)).toEqual([]);
  const drifted = new Map([['personal', [w('5h', 89, NOW + H + 20_000)]]]);
  expect(alertsFor(new Map([['personal', [w('5h', 92, NOW + H)]]]), drifted, profiles, fresh, NOW)).toEqual([]);
});

test('a reset time that drifts by seconds is not a new reading', () => {
  const h = new WindowHistory(dir);
  expect(h.record('codex', [w('7d', 40, NOW + 50 * H)], NOW)).toBe(true);
  expect(h.record('codex', [w('7d', 40, NOW + 50 * H + 3000)], NOW + 60_000)).toBe(false);
  expect(h.record('codex', [w('7d', 41, NOW + 50 * H + 3000)], NOW + 120_000)).toBe(true);
});
