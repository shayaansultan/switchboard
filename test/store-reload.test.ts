// The store is shared between the app and the CLI. These tests pin the
// contract that makes that safe: atomic saves, detecting foreign writes
// without reacting to our own, and the advisory lock around read-modify-write.

import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import * as store from '../src/store';
import { runtime, workerCommand } from '../src/buckets/runtime';
import type { Store } from '../src/types';

if (!store.ROOT.startsWith(sandboxHome + path.sep)) {
  throw new Error(`refusing to run: store root is ${store.ROOT}, outside the sandbox ${sandboxHome}`);
}

function reset() {
  fs.rmSync(store.ROOT, { recursive: true, force: true });
}
beforeEach(reset);
afterEach(reset);

// A write from another process: a fresh temp file renamed over the store.
function foreignWrite(text: string) {
  const tmp = `${store.STORE_FILE}.foreign.tmp`;
  fs.mkdirSync(store.ROOT, { recursive: true });
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, store.STORE_FILE);
}

const withProfile = (data: Store, name: string): Store => ({
  ...data,
  profiles: [...data.profiles, { id: `claude-${name}`, vendor: 'claude', name, isDefault: false, color: '#000' }],
});

test('diffStores reports added, removed and changed profiles and settings', () => {
  const a = store.load();
  const b = withProfile(a, 'work');
  expect(store.diffStores(a, a)).toEqual({ added: [], removed: [], changed: [], settingsChanged: false });
  expect(store.diffStores(a, b).added).toEqual(['claude-work']);
  expect(store.diffStores(b, a).removed).toEqual(['claude-work']);
  const renamed = { ...b, profiles: b.profiles.map((p) => (p.id === 'claude-work' ? { ...p, name: 'Client' } : p)) };
  expect(store.diffStores(b, renamed).changed).toEqual(['claude-work']);
  const settings = { ...a, settings: { ...a.settings, pollMinutes: 9 } };
  expect(store.diffStores(a, settings).settingsChanged).toBe(true);
});

test('save writes atomically and leaves no temp file behind', () => {
  store.save(store.load());
  expect(fs.readdirSync(store.ROOT).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  expect(store.readStore().profiles.map((p) => p.id)).toEqual(['claude-default', 'codex-default']);
});

test('readIfChanged ignores our own save and returns a foreign write', () => {
  const data = store.load();
  expect(store.readIfChanged()).toBeNull();
  store.save(withProfile(data, 'work'));
  expect(store.readIfChanged()).toBeNull();
  foreignWrite(JSON.stringify(withProfile(data, 'other')));
  const next = store.readIfChanged();
  expect(next?.profiles.map((p) => p.id)).toContain('claude-other');
  // Seen once: the same content is not reported again.
  expect(store.readIfChanged()).toBeNull();
});

test('readIfChanged leaves a corrupt foreign write alone', () => {
  store.load();
  foreignWrite('{');
  expect(store.readIfChanged()).toBeNull();
  expect(fs.readFileSync(store.STORE_FILE, 'utf8')).toBe('{');
  expect(fs.readdirSync(store.ROOT).filter((f) => f.includes('corrupt'))).toEqual([]);
});

test('watchStore fires for a foreign write and not for our own save', async () => {
  const data = store.load();
  const seen: string[][] = [];
  const stop = store.watchStore((next) => seen.push(next.profiles.map((p) => p.id)), 20);
  try {
    store.save(withProfile(data, 'mine'));
    await Bun.sleep(300);
    expect(seen).toEqual([]);
    foreignWrite(JSON.stringify(withProfile(data, 'theirs')));
    for (let i = 0; i < 100 && !seen.length; i++) await Bun.sleep(20);
    expect(seen).toEqual([['claude-default', 'codex-default', 'claude-theirs']]);
  } finally {
    stop();
  }
});

test('withStoreLock runs the body, releases the lock, and refuses a live holder', () => {
  store.load();
  const lock = path.join(store.ROOT, 'profiles.lock');
  expect(store.withStoreLock(() => fs.existsSync(lock))).toBe(true);
  expect(fs.existsSync(lock)).toBe(false);
  // A lock held by this (live) process from inside the body is contended.
  expect(() => store.withStoreLock(() => store.withStoreLock(() => 1))).toThrow(/Another process is editing/);
  expect(fs.existsSync(lock)).toBe(false);
});

test('withStoreLock reclaims a lock left by a dead process', () => {
  store.load();
  const lock = path.join(store.ROOT, 'profiles.lock');
  fs.writeFileSync(lock, '2147483646');
  expect(store.withStoreLock(() => 'ran')).toBe('ran');
  expect(fs.existsSync(lock)).toBe(false);
});

test('setProxyBucket only applies to Codex profiles and persists', () => {
  const data = store.load();
  expect(() => store.setProxyBucket(data, 'claude-default', 'pool')).toThrow(/Codex/);
  expect(store.setProxyBucket(data, 'codex-default', 'pool').proxyBucket).toBe('pool');
  expect(store.readStore().profiles.find((p) => p.id === 'codex-default')?.proxyBucket).toBe('pool');
  expect('proxyBucket' in store.setProxyBucket(data, 'codex-default', null)).toBe(false);
});

test('runtime borrows an installed app outside Electron, else uses itself', () => {
  const fake = path.join(sandboxHome, 'Fake.app');
  fs.mkdirSync(path.join(fake, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(fake, 'Contents', 'Resources', 'app.asar'), '');
  const borrowed = runtime(fake);
  expect(borrowed.execPath).toBe(path.join(fake, 'Contents', 'MacOS', 'Switchboard'));
  expect(borrowed.script('cli')).toBe(path.join(fake, 'Contents', 'Resources', 'app.asar', 'out', 'buckets', 'cli.js'));
  const own = runtime(path.join(sandboxHome, 'Missing.app'));
  expect(own.execPath).toBe(process.execPath);
  expect(own.script('desktop-stdio')).toMatch(/src\/buckets\/desktop-stdio\.ts$/);
  expect(workerCommand(fake)).toEqual({ execPath: borrowed.execPath, script: borrowed.script('cli') });
});
