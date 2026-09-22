import { test, expect, beforeEach, afterEach } from 'bun:test';
import { run, resetStore } from './cli-helpers';
import * as store from '../src/store';

beforeEach(resetStore);
afterEach(resetStore);

test('settings get returns all settings or one key', async () => {
  expect((await run('settings', 'get')).json()).toMatchObject({ terminal: 'Terminal', pollMinutes: 5 });
  expect((await run('settings', 'get', 'usageMode')).json()).toEqual({ key: 'usageMode', value: 'used' });
  expect((await run('settings', 'get', 'nope')).code).toBe(2);
  expect((await run('settings', 'frob')).code).toBe(2);
});

test('settings set validates each key and persists', async () => {
  expect((await run('settings', 'set', 'pollMinutes', '10')).json()).toMatchObject({ settings: { pollMinutes: 10 } });
  expect((await run('settings', 'set', 'pollMinutes', '0')).code).toBe(2);
  expect((await run('settings', 'set', 'pollMinutes', 'ten')).code).toBe(2);
  expect((await run('settings', 'set', 'usageMode', 'remaining')).code).toBe(0);
  expect((await run('settings', 'set', 'usageMode', 'left')).code).toBe(2);
  expect((await run('settings', 'set', 'openAtLogin', 'on')).json()).toMatchObject({ settings: { openAtLogin: true } });
  expect((await run('settings', 'set', 'openAtLogin', 'maybe')).code).toBe(2);
  expect((await run('settings', 'set', 'appearance', 'dark')).code).toBe(0);
  expect((await run('settings', 'set', 'menuBar', 'percent')).code).toBe(0);
  expect((await run('settings', 'set', 'unknown', 'x')).code).toBe(2);
  expect((await run('settings', 'set', 'terminal')).code).toBe(2);
  const uninstalled = await run('settings', 'set', 'terminal', 'NoSuchTerm');
  expect(uninstalled.code).toBe(0);
  expect(uninstalled.json<{ warnings: string[] }>().warnings[0]).toMatch(/not an installed terminal/);
  expect(store.readStore().settings).toMatchObject({
    pollMinutes: 10,
    usageMode: 'remaining',
    openAtLogin: true,
    appearance: 'dark',
    menuBar: 'percent',
    terminal: 'NoSuchTerm',
  });
});
