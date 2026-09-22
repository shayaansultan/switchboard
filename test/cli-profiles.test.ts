// Profile lifecycle through the CLI entry point, against the sandbox store.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { run, resetStore, withoutTty } from './cli-helpers';
import { assertNotRunning } from '../src/cli/desktop';
import * as store from '../src/store';
import * as buckets from '../src/buckets/store';

beforeEach(resetStore);
afterEach(resetStore);

test('list and show describe the sandbox defaults', async () => {
  const list = await run('list');
  expect(list.code).toBe(0);
  const { profiles } = list.json<{ profiles: { id: string; command: string; dirs: { isDefault: boolean } }[] }>();
  expect(profiles.map((p) => p.id)).toEqual(['claude-default', 'codex-default']);
  expect(profiles[0].command).toBe('claude');
  expect(profiles[0].dirs.isDefault).toBe(true);
  const show = await run('show', 'codex');
  expect(show.json()).toMatchObject({ id: 'codex-default', usage: { status: 'none' }, identity: null });
  expect((await run('list', '--vendor', 'gemini')).failure().error).toBe('usage');
});

test('add creates a profile; --from uses the dialog defaults, --items none brings nothing', async () => {
  const plain = await run('add', 'claude', 'Work');
  expect(plain.code).toBe(0);
  expect(plain.json()).toMatchObject({ profile: { id: 'claude-work', vendor: 'claude' }, result: { done: [] } });
  expect(fs.existsSync(path.join(store.ROOT, 'claude', 'claude-work', 'home'))).toBe(true);

  fs.mkdirSync(path.join(store.VENDORS.claude.defaultHome, 'skills'), { recursive: true });
  const linked = await run('add', 'claude', 'Personal', '--from', 'claude');
  expect(linked.code).toBe(0);
  expect(linked.json<{ result: { done: string[] } }>().result.done).toEqual(['skills']);
  const personal = store.readStore().profiles.find((p) => p.id === 'claude-personal');
  expect(personal?.setup).toMatchObject({ from: 'claude-default', mode: 'link' });
  expect(personal?.setup?.items).toContain('skills');
  expect(fs.lstatSync(path.join(store.dirs(personal!).home, 'skills')).isSymbolicLink()).toBe(true);

  const none = await run('add', 'codex', 'Client', '--from', 'codex', '--items', 'none', '--mode', 'copy');
  expect(none.json()).toMatchObject({ result: { done: [], skipped: [] } });
  expect(store.readStore().profiles.map((p) => p.id)).toContain('codex-client');
});

test('add rejects bad items, a source from another app, and items without a source', async () => {
  const bad = await run('add', 'claude', 'X', '--from', 'claude', '--items', 'skills,nope');
  expect(bad.code).toBe(2);
  expect(bad.failure()).toMatchObject({ error: 'usage', details: { items: expect.arrayContaining(['skills']) } });
  const cross = await run('add', 'claude', 'X', '--from', 'codex');
  expect(cross.code).toBe(4);
  expect(cross.failure().error).toBe('vendor-mismatch');
  expect((await run('add', 'claude', 'X', '--items', 'skills')).failure().error).toBe('usage');
  expect(store.readStore().profiles).toHaveLength(2);
});

test('bring-over refuses the default target and reports what moved', async () => {
  await run('add', 'claude', 'Work');
  const into = await run('bring-over', 'claude-work', '--from', 'claude', '--items', 'skills,instructions');
  expect(into.code).toBe(0);
  expect(into.json()).toMatchObject({ profile: { id: 'claude-work' }, source: { id: 'claude-default' } });
  const back = await run('bring-over', 'claude', '--from', 'claude-work', '--items', 'skills');
  expect(back.code).toBe(4);
  expect(back.failure().error).toBe('default-profile');
});

test('rename, recolor and move write through to the store', async () => {
  await run('add', 'claude', 'One');
  await run('add', 'claude', 'Two');
  expect((await run('rename', 'claude-one', 'Uno')).json()).toMatchObject({ profile: { name: 'Uno' } });
  expect((await run('recolor', 'claude-one', '3')).json()).toMatchObject({ profile: { color: store.PALETTE[3] } });
  expect((await run('recolor', 'claude-one', '#ABCDEF')).json()).toMatchObject({ profile: { color: '#ABCDEF' } });
  expect((await run('recolor', 'claude-one', 'red')).code).toBe(2);
  expect((await run('move', 'claude-two', 'up')).json()).toMatchObject({ moved: true });
  expect((await run('move', 'claude-two', 'up')).json()).toMatchObject({ moved: false });
  expect((await run('move', 'claude-two', 'sideways')).code).toBe(2);
  const ids = store.readStore().profiles.map((p) => p.id);
  expect(ids).toEqual(['claude-default', 'codex-default', 'claude-two', 'claude-one']);
  expect(store.readStore().profiles.find((p) => p.id === 'claude-one')?.name).toBe('Uno');
});

test('remove needs --yes, refuses the Default profile, and deletes the directory', async () => {
  await run('add', 'codex', 'Temp');
  const dir = path.join(store.ROOT, 'codex', 'codex-temp');
  expect(fs.existsSync(dir)).toBe(true);
  const unconfirmed = await withoutTty(() => run('remove', 'codex-temp'));
  expect(unconfirmed.code).toBe(4);
  expect(unconfirmed.failure().error).toBe('confirmation-required');
  expect(fs.existsSync(dir)).toBe(true);
  expect((await run('remove', 'codex', '--yes')).failure().error).toBe('default-profile');
  const removed = await run('remove', 'codex-temp', '--yes');
  expect(removed.code).toBe(0);
  expect(removed.json()).toEqual({
    removed: { id: 'codex-temp', vendor: 'codex', name: 'Temp', isDefault: false },
    deleted: dir,
  });
  expect(fs.existsSync(dir)).toBe(false);
  expect(store.readStore().profiles.map((p) => p.id)).toEqual(['claude-default', 'codex-default']);
  expect((await run('remove', 'codex-temp', '--yes')).failure().error).toBe('no-such-profile');
});

test('a running window blocks removal and history bring-over', () => {
  const profile = { id: 'claude-x', vendor: 'claude' as const, name: 'X', isDefault: false, color: '#000' };
  const instance = { pid: 1, vendor: 'claude' as const, userDataDir: store.dirs(profile).desktop };
  expect(() => assertNotRunning(profile, [instance], 'why')).toThrow(/Quit the X window first/);
  expect(() => assertNotRunning(profile, [], 'why')).not.toThrow();
});

test('assign routes only Codex profiles, only to buckets that exist', async () => {
  await run('add', 'codex', 'Routed');
  await run('add', 'claude', 'Plain');
  expect((await run('assign', 'claude-plain', 'pool')).failure().error).toBe('wrong-vendor');
  expect((await run('assign', 'codex-routed', 'pool')).failure().error).toBe('no-such-bucket');
  const bucket = buckets.create('Pool');
  const assigned = await run('assign', 'codex-routed', bucket.id);
  expect(assigned.code).toBe(0);
  expect(assigned.json()).toMatchObject({ profile: { proxyBucket: 'pool' }, effective: 'next-launch', running: false });
  expect(store.readStore().profiles.find((p) => p.id === 'codex-routed')?.proxyBucket).toBe('pool');
  const cleared = await run('unassign', 'codex-routed');
  expect('proxyBucket' in (cleared.json() as { profile: object }).profile).toBe(false);
});

test('a store that had to be reset is read with a warning and refuses mutations', async () => {
  fs.mkdirSync(store.ROOT, { recursive: true });
  fs.writeFileSync(store.STORE_FILE, '{');
  const list = await run('list');
  expect(list.code).toBe(0);
  expect(list.json<{ warnings: string[] }>().warnings[0]).toMatch(/corrupt-/);
  // load() has now written defaults; the next command sees a clean store.
  expect((await run('add', 'claude', 'After')).code).toBe(0);
});

test('setup-items lists what add and bring-over accept', async () => {
  const items = await run('setup-items', 'codex');
  expect(items.json<{ items: { id: string; on: boolean }[] }>().items.map((i) => i.id)).toContain('history');
  expect((await run('setup-items')).code).toBe(2);
});

test('an unknown command and --help are handled at the top level', async () => {
  const unknown = await run('frobnicate');
  expect(unknown.code).toBe(2);
  expect(unknown.out).toBe('');
  expect(unknown.failure()).toMatchObject({ error: 'usage', hint: 'switchboard --help' });
  expect((await run('--help')).out).toMatch(/switchboard list/);
  expect((await run()).out).toMatch(/switchboard list/);
  expect((await run('--version')).out).toMatch(/^\d+\.\d+\.\d+$/);
});
