import { test, expect } from 'bun:test';
import { rank } from '../src/cli/headroom';
import type { UsageEntry, UsageStatus, UsageWindowOut } from '../src/cli/usage';

const window = (label: string, pct: number | null, resetsAt: string | null = null): UsageWindowOut => ({
  label,
  pct,
  remaining: pct === null ? null : 100 - pct,
  resetsAt,
  severity: null,
});

const entry = (id: string, status: UsageStatus, windows: UsageWindowOut[] = []): UsageEntry => ({
  id,
  vendor: 'claude',
  name: id,
  isDefault: false,
  running: false,
  source: 'cache',
  identity: null,
  usage: { status, windows, headroom: null, plan: null, fetchedAt: null, ageSeconds: null, error: null },
});

test('the tightest window decides, and only usable statuses compete', () => {
  const result = rank([
    entry('a', 'ok', [window('5h', 10), window('7d', 60)]),
    entry('b', 'ok', [window('5h', 90), window('7d', 5)]),
    entry('c', 'not-signed-in'),
    entry('d', 'none'),
    entry('e', 'error'),
    entry('f', 'stale', [window('5h', 50)]),
  ]);
  expect(result.candidates.map((c) => [c.id, c.headroom, c.window, c.stale])).toEqual([
    ['f', 50, '5h', true],
    ['a', 40, '7d', false],
    ['b', 10, '5h', false],
  ]);
  expect(result.profile?.id).toBe('f');
  expect(result.excluded).toEqual([
    { id: 'c', vendor: 'claude', name: 'c', isDefault: false, reason: 'not-signed-in' },
    { id: 'd', vendor: 'claude', name: 'd', isDefault: false, reason: 'none' },
    { id: 'e', vendor: 'claude', name: 'e', isDefault: false, reason: 'error' },
  ]);
});

test('--window judges by one label; profiles without it are excluded', () => {
  const result = rank([entry('a', 'ok', [window('5h', 10), window('7d', 60)]), entry('b', 'ok', [window('5h', 90)])], {
    window: '7D',
  });
  expect(result.candidates.map((c) => c.id)).toEqual(['a']);
  expect(result.excluded).toEqual([{ id: 'b', vendor: 'claude', name: 'b', isDefault: false, reason: 'no-window' }]);
});

test('ties break on the sooner reset, then store order; min headroom excludes', () => {
  const result = rank(
    [
      entry('later', 'ok', [window('5h', 30, '2030-01-01T02:00:00Z')]),
      entry('sooner', 'ok', [window('5h', 30, '2030-01-01T01:00:00Z')]),
      entry('unknown', 'ok', [window('5h', 30)]),
      entry('low', 'ok', [window('5h', 95)]),
    ],
    { minHeadroom: 10 },
  );
  expect(result.candidates.map((c) => c.id)).toEqual(['sooner', 'later', 'unknown']);
  expect(result.excluded.map((e) => [e.id, e.reason])).toEqual([['low', 'below-min']]);
});

test('no eligible profile leaves profile null', () => {
  expect(rank([entry('a', 'ok', [window('5h', null)])]).profile).toBeNull();
  expect(rank([]).profile).toBeNull();
});
