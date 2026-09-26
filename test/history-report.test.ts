import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { dayOf, emptyLedger, indexLogs, type LedgerProfile } from '../src/history/ledger';
import { buildReport } from '../src/history/report';
import type { WindowRecord } from '../src/history/windows';
import type { UsageWindow } from '../src/types';
import { claudeAssistant, claudeUser, write } from './history-fixtures';

const base = path.join(sandboxHome, 'report-test');
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const H = 3_600_000;
const D = 24 * H;
const NOW = new Date(2026, 8, 24, 14, 35).getTime();
const personal: LedgerProfile = { id: 'personal', vendor: 'claude', home: path.join(base, 'personal') };
const work: LedgerProfile = { id: 'work', vendor: 'claude', home: path.join(base, 'work') };
const w = (pct: number, end: number): UsageWindow => ({ label: '5h', pct, resetsAt: new Date(end).toISOString() });

async function scenario() {
  const winEnd = NOW + 2.5 * H;
  const winStart = winEnd - 5 * H;
  // Today, inside the current window: two sessions in two folders named app.
  write(path.join(personal.home, 'projects', 'a', 'today.jsonl'), [
    claudeUser({ session: 'today', at: winStart + H, text: 'Build the usage tab', cwd: '/code/switchboard/app' }),
    claudeAssistant({
      session: 'today',
      at: winStart + H + 60_000,
      id: 't1',
      output: 3_000_000,
      cwd: '/code/switchboard/app',
    }),
  ]);
  write(path.join(personal.home, 'projects', 'b', 'other.jsonl'), [
    claudeUser({ session: 'other', at: winStart + 2 * H, text: 'Fix tests', cwd: '/code/client/app' }),
    claudeAssistant({
      session: 'other',
      at: winStart + 2 * H + 60_000,
      id: 'o1',
      output: 1_000_000,
      input: 100,
      cacheRead: 900,
      cwd: '/code/client/app',
    }),
  ]);
  // The first day of the previous period, so it counts as recorded.
  write(path.join(work.home, 'projects', 'c', 'old.jsonl'), [
    claudeAssistant({ session: 'old', at: NOW - 13 * D, id: 'x1', output: 500_000, cwd: '/code/api' }),
  ]);
  const ledger = emptyLedger(NOW - 10 * D);
  await indexLogs(ledger, [personal, work], NOW);
  const records: WindowRecord[] = [
    { at: winStart + 30 * 60_000, profile: 'personal', windows: [w(10, winEnd)] },
    { at: NOW - H, profile: 'personal', windows: [w(48, winEnd)] },
    { at: NOW, profile: 'personal', windows: [w(68, winEnd)] },
  ];
  const live = [
    { id: 'personal', vendor: 'claude' as const, windows: [w(68, winEnd)] },
    { id: 'work', vendor: 'claude' as const, windows: [w(12, NOW + 4 * H)] },
  ];
  return buildReport({ ledger, records, live, days: 7, now: NOW });
}

test('totals, the previous period and the daily split', async () => {
  const r = await scenario();
  // claude-sonnet-5 output is $10 a million: $30 + $10, plus pennies of input.
  expect(r.totals.value).toBeCloseTo(40.00038, 5);
  expect(r.totals.sessions).toBe(2);
  expect(r.totals.projects).toBe(2);
  expect(r.previous?.value).toBeCloseTo(5, 6);
  expect(r.daily).toHaveLength(7);
  expect(r.daily.at(-1)?.day).toBe(dayOf(NOW));
  expect(r.daily.at(-1)?.value.personal).toBeCloseTo(40.00038, 5);
  expect(r.recordedSince).toBe(dayOf(NOW - 13 * D));
});

test('folders become names, told apart by their parent', async () => {
  const r = await scenario();
  expect(r.projects.map((p) => p.name)).toEqual(['switchboard/app', 'client/app']);
  expect(r.projects[0]).toMatchObject({ profiles: ['personal'], sessions: 1 });
  expect(JSON.stringify(r)).not.toContain('/code/');
});

test('mix, cache hit, models and the heat map', async () => {
  const r = await scenario();
  expect(r.mix.find((m) => m.kind === 'output')?.tokens).toBe(4_000_000);
  expect(r.cacheHit.find((c) => c.profile === 'personal')?.pct).toBe(90);
  expect(r.models[0]).toMatchObject({ model: 'claude-sonnet-5', sessions: 2 });
  expect(r.heat).toHaveLength(182);
  expect(r.heat[0].agentMs).toBeNull();
  expect(r.heat.at(-1)?.agentMs).toBeGreaterThan(0);
});

test('sessions are grouped by their window, each with its share of it', async () => {
  const r = await scenario();
  const block = r.blocks.find((b) => b.profile === 'personal' && b.kind === 'window');
  expect(block).toMatchObject({ label: '5h', peak: 68, current: true });
  expect(block?.sessions.map((s) => [s.title, s.share])).toEqual([
    ['Fix tests', 17],
    ['Build the usage tab', 51],
  ]);
  // Every session in range started inside a recorded window.
  expect(r.blocks.some((b) => b.kind === 'day')).toBe(false);
  expect(r.forecast?.profile).toBe('personal');
  expect(r.forecast?.alternative?.profile).toBe('work');
  expect(r.accounts.find((a) => a.profile === 'personal')?.tightest?.pace).toBe(18);
});
