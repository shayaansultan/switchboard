import { afterEach, beforeEach, expect, test } from 'bun:test';
import { run, resetStore, withoutTty } from './cli-helpers';
import { serveAppControl, type AppCommand } from '../src/app-control';
import * as store from '../src/store';

let stop: (() => void) | undefined;
beforeEach(resetStore);
afterEach(() => {
  stop?.();
  stop = undefined;
  resetStore();
});

test('T3 export is credential-free and resolves default and isolated homes', async () => {
  await run('add', 'claude', 'Work');
  await run('recolor', 'claude-work', '#123456');
  for (const [id, driver, binaryPath, homePath, displayName, accentColor] of [
    ['claude-work', 'claudeAgent', 'claude', `${store.ROOT}/claude/claude-work/home`, 'Work', '#123456'],
    ['codex-default', 'codex', 'codex', `${store.HOME}/.codex`, 'Default', '#10a37f'],
  ]) {
    const result = await run('export', id, '--format', 't3');
    expect(result.code).toBe(0);
    expect(result.json()).toEqual({
      providerInstances: {
        [id]: { driver, displayName, accentColor, enabled: true, config: { binaryPath, homePath } },
      },
    });
  }
  await run('add', 'codex', 'Routed');
  store.withStoreLock(() => store.setProxyBucket(store.load(), 'codex-routed', 'fixture-bucket'));
  const refused = await run('export', 'codex-routed', '--format', 't3');
  expect(refused.code).toBe(4);
  expect(refused.out).toBe('');
  expect(refused.failure().error).toBe('routed-export-unsupported');
  expect((await run('export', 'claude', '--format', 'other')).code).toBe(2);
});

test('CLI resolves profiles and requires force confirmation before contacting the app', async () => {
  const calls: AppCommand[] = [];
  stop = await serveAppControl(async (command) => {
    calls.push(command);
    return { fixture: true };
  });
  await run('add', 'claude', 'Fixture');
  expect((await withoutTty(() => run('quit', 'claude-fixture', '--force'))).failure().error).toBe(
    'confirmation-required',
  );
  expect(calls).toEqual([]);
  expect((await run('quit', 'claude-fixture', '--force', '--no-wait', '--yes')).code).toBe(2);
  for (const args of [
    ['quit', 'claude/Fixture', '--force', '--yes'],
    ['focus', 'claude/Fixture'],
    ['awake', 'status'],
    ['awake', 'on'],
    ['awake', 'off'],
    ['awake', 'recheck'],
    ['accessibility', 'status'],
    ['accessibility', 'open'],
  ])
    expect((await run(...args)).json()).toEqual({ fixture: true });
  expect(calls).toEqual([
    { command: 'force-quit', profile: 'claude-fixture' },
    { command: 'focus', profile: 'claude-fixture' },
    ...['status', 'on', 'off', 'recheck'].map((action) => ({ command: 'awake', action })),
    { command: 'accessibility', action: 'status' },
    { command: 'accessibility', action: 'open' },
  ]);
  for (const args of [
    ['awake', 'bad'],
    ['awake', 'status', 'extra'],
    ['accessibility', 'request'],
    ['focus', 'missing'],
  ]) {
    expect((await run(...args)).code).not.toBe(0);
  }
  expect(calls).toHaveLength(8);
});
