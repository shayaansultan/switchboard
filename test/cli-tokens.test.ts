import { beforeEach, expect, test } from 'bun:test';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { resetStore, run } from './cli-helpers';
import { UsageHistory } from '../src/history';
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
    rows: { profile: string; value: number }[];
  }>();
  expect(out.totals).toMatchObject({ value: 10, sessions: 1 });
  expect(out.rows.find((r) => r.profile === 'claude-default')?.value).toBe(10);

  const byModel = await run('tokens', '--by', 'model');
  expect(byModel.json<{ rows: unknown[] }>().rows).toEqual([
    { model: 'claude-sonnet-5', value: 10, tokens: 1_000_000, sessions: 1 },
  ]);

  const human = await run('tokens', '--by', 'project', '--human');
  expect(human.out).toContain('app');
  expect(human.out).not.toContain('/code/app');
});

test('rejects a bad range or grouping', async () => {
  expect((await run('tokens', '--days', '0')).code).toBe(2);
  expect((await run('tokens', '--by', 'colour')).code).toBe(2);
});
