import { beforeEach, expect, test } from 'bun:test';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { resetStore, run } from './cli-helpers';
import { UsageHistory } from '../src/history';
import { lastWeekEnd } from '../src/history/digest';
import { claudeAssistant, claudeUser, write } from './history-fixtures';

beforeEach(resetStore);

test('says so when the app has recorded nothing yet', async () => {
  const r = await run('tokens');
  expect(r.code).toBe(3);
  expect(r.failure().error).toBe('no-usage-history');
});

test('reports what the app indexed, by account and by model', async () => {
  const now = Date.now();
  write(path.join(sandboxHome, '.claude', 'projects', '-code-app', 's1.jsonl'), [
    claudeUser({ session: 's1', at: now - 60 * 60_000, text: 'Ship it', cwd: '/code/app' }),
    claudeAssistant({ session: 's1', at: now - 59 * 60_000, id: 'm1', output: 1_000_000, cwd: '/code/app' }),
  ]);
  // What the app does on each refresh.
  await new UsageHistory().index([{ id: 'claude-default', vendor: 'claude', home: path.join(sandboxHome, '.claude') }]);

  const byAccount = await run('tokens', '--days', '7');
  expect(byAccount.code).toBe(0);
  const out = byAccount.json<{
    totals: { value: number; sessions: number };
    rows: { id: string; name: string; value: number }[];
  }>();
  expect(out.totals).toMatchObject({ value: 10, sessions: 1 });
  expect(out.rows.find((r) => r.id === 'claude-default')).toMatchObject({ name: 'Default', value: 10 });

  const byModel = await run('tokens', '--by', 'model');
  expect(byModel.json<{ rows: unknown[] }>().rows).toEqual([
    { model: 'claude-sonnet-5', value: 10, tokens: 1_000_000, sessions: 1 },
  ]);

  const human = await run('tokens', '--by', 'project', '--human');
  expect(human.out).toContain('app');
  expect(human.out).not.toContain('/code/app');
  expect(human.out).toContain('$10.00 API-equivalent');
  expect((await run('tokens', '--by', 'project')).json<{ rows: unknown[] }>().rows).toEqual([
    { project: 'app', profiles: ['claude-default'], value: 10, sessions: 1, agentMinutes: 1 },
  ]);
});

test('rejects a bad range or grouping', async () => {
  expect((await run('tokens', '--days', '0')).code).toBe(2);
  expect((await run('tokens', '--by', 'colour')).code).toBe(2);
});

test('digest is last week, Monday to Sunday, against the plan price', async () => {
  const sunday = lastWeekEnd(Date.now());
  const at = sunday - 2 * 24 * 60 * 60_000;
  write(path.join(sandboxHome, '.claude', 'projects', '-code-app', 'w1.jsonl'), [
    claudeUser({ session: 'w1', at, text: 'Ship it', cwd: '/code/app' }),
    claudeAssistant({ session: 'w1', at: at + 60_000, id: 'm1', output: 1_000_000, cwd: '/code/app' }),
    // This week's work is not last week's.
    claudeUser({ session: 'w1', at: sunday + 60 * 60_000, text: 'And again', cwd: '/code/app' }),
    claudeAssistant({ session: 'w1', at: sunday + 61 * 60_000, id: 'm2', output: 1_000_000, cwd: '/code/app' }),
  ]);
  await new UsageHistory().index([{ id: 'claude-default', vendor: 'claude', home: path.join(sandboxHome, '.claude') }]);
  await run('plan-price', 'claude', '20');

  const out = (await run('digest')).json<{
    from: string;
    to: string;
    value: number;
    accounts: { id: string; name: string; value: number; planCost: number; times: number }[];
  }>();
  expect(new Date(`${out.from}T12:00:00`).getDay()).toBe(1);
  expect(new Date(`${out.to}T12:00:00`).getDay()).toBe(0);
  expect(out.value).toBe(10);
  expect(out.accounts).toEqual([{ id: 'claude-default', name: 'Default', value: 10, planCost: 4.6, times: 2.2 }]);
  const human = await run('digest', '--human');
  expect(human.out).toContain('$10.00 of value');
  expect(human.out).toContain('2.2x');
});
