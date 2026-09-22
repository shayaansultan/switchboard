import { test, expect, beforeEach, afterEach } from 'bun:test';
import { run, resetStore } from './cli-helpers';

beforeEach(resetStore);
afterEach(resetStore);

test('quit on a profile without a window reports nothing to quit', async () => {
  await run('add', 'claude', 'Idle');
  const quit = await run('quit', 'claude-idle');
  expect(quit.code).toBe(0);
  expect(quit.json()).toEqual({
    profile: { id: 'claude-idle', vendor: 'claude', name: 'Idle', isDefault: false },
    quit: false,
    stopped: false,
  });
});

test('running lists instances with their owner, or null', async () => {
  const running = await run('running');
  expect(running.code).toBe(0);
  for (const row of running.json<{ instances: { pid: number; vendor: string; profile: unknown }[] }>().instances) {
    expect(typeof row.pid).toBe('number');
    expect(['claude', 'codex']).toContain(row.vendor);
  }
  expect((await run('running', '--human')).out).toMatch(/^pid\s+vendor\s+profile/);
});

test('quit-others asks before terminating windows', async () => {
  const { withoutTty } = await import('./cli-helpers');
  const refused = await withoutTty(() => run('quit-others', 'claude'));
  expect(refused.code).toBe(4);
  expect(refused.failure().error).toBe('confirmation-required');
});
