// Usage reporting reads the app's cache and, on request, the live lookups.
// Both are injected here; nothing spawns a CLI or reaches the network.

import { test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { readLiveCache, usageReport, type CacheRead, type UsageDeps } from '../src/cli/usage';
import type { LiveCache, Profile } from '../src/types';

const claude: Profile = { id: 'claude-a', vendor: 'claude', name: 'A', isDefault: false, color: '#000' };
const codex: Profile = { id: 'codex-b', vendor: 'codex', name: 'B', isDefault: false, color: '#000' };
const NOW = Date.parse('2026-09-22T12:00:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const cache = (entries: LiveCache): CacheRead => ({ entries });
const signedIn = { loggedIn: true, email: 'a@example.test', plan: 'Max', org: null };
const fresh = { windows: [{ label: '5h', pct: 25, resetsAt: null }], plan: 'Max', fetchedAt: at(5) };

function deps(calls: string[], live: Partial<UsageDeps> = {}): UsageDeps {
  return {
    now: () => NOW,
    identity: async (p) => {
      calls.push(`identity:${p.id}`);
      return live.identity ? live.identity(p) : signedIn;
    },
    usage: async (p, d) => {
      calls.push(`usage:${p.id}`);
      return live.usage ? live.usage(p, d) : { windows: [{ label: '5h', pct: 40, resetsAt: null }], fetchedAt: at(0) };
    },
  };
}

test('cache only: entries come from the cache, with age, headroom and status', async () => {
  const calls: string[] = [];
  const report = await usageReport(
    [claude, codex],
    new Set(['claude-a']),
    { maxAgeMs: null, renew: true },
    cache({ 'claude-a': { identity: signedIn, usage: fresh } }),
    deps(calls),
  );
  expect(calls).toEqual([]);
  const [a, b] = report.profiles;
  expect(a).toMatchObject({ id: 'claude-a', running: true, source: 'cache', identity: signedIn });
  expect(a.usage).toMatchObject({ status: 'ok', headroom: 75, ageSeconds: 300, plan: 'Max', error: null });
  expect(a.usage.windows[0]).toEqual({ label: '5h', pct: 25, remaining: 75, resetsAt: null, severity: null });
  expect(b).toMatchObject({ source: 'none', identity: null, usage: { status: 'none', windows: [], headroom: null } });
});

test('a cached signed-out identity is reported as not signed in', async () => {
  const report = await usageReport(
    [claude],
    new Set(),
    { maxAgeMs: null, renew: true },
    cache({ 'claude-a': { identity: { loggedIn: false } } }),
    deps([]),
  );
  expect(report.profiles[0].usage.status).toBe('not-signed-in');
});

test('--max-age refreshes only entries older than the limit, and never writes the cache', async () => {
  const calls: string[] = [];
  const file = path.join(sandboxHome, 'no-cache-write.json');
  const report = await usageReport(
    [claude, codex],
    new Set(),
    { maxAgeMs: 10 * 60_000, renew: true },
    cache({
      'claude-a': { identity: signedIn, usage: fresh },
      'codex-b': { identity: signedIn, usage: { ...fresh, fetchedAt: at(30) } },
    }),
    deps(calls),
  );
  expect(calls).toEqual(['identity:codex-b', 'usage:codex-b']);
  expect(report.profiles.map((p) => p.source)).toEqual(['cache', 'live']);
  expect(report.profiles[1].usage).toMatchObject({ status: 'ok', headroom: 60, ageSeconds: 0 });
  expect(fs.existsSync(file)).toBe(false);
});

test('--refresh fetches live even when the cache is brand new', async () => {
  const calls: string[] = [];
  const report = await usageReport(
    [claude],
    new Set(),
    { maxAgeMs: 0, renew: true },
    cache({ 'claude-a': { identity: signedIn, usage: { ...fresh, fetchedAt: at(0) } } }),
    deps(calls),
  );
  expect(calls).toEqual(['identity:claude-a', 'usage:claude-a']);
  expect(report.profiles[0].source).toBe('live');
});

test('a failed live fetch keeps the cached numbers as stale; --no-renew disables token renewal', async () => {
  const calls: string[] = [];
  let renewal: unknown;
  const report = await usageReport(
    [claude],
    new Set(),
    { maxAgeMs: 0, renew: false },
    cache({ 'claude-a': { identity: signedIn, usage: fresh } }),
    deps(calls, {
      usage: async (_p, d) => {
        renewal = d.recoverClaudeCredential;
        return { error: 'usage API 503' };
      },
    }),
  );
  expect(typeof renewal).toBe('function');
  expect(report.profiles[0].usage).toMatchObject({ status: 'stale', headroom: 75, error: 'usage API 503' });
});

test('live answers classify sign-out, rate limits and other errors', async () => {
  const at401 = await usageReport(
    [claude],
    new Set(),
    { maxAgeMs: 0, renew: true },
    cache({}),
    deps([], {
      usage: async () => ({ error: 'Claude session rejected (401); open this profile in Terminal to sign in' }),
    }),
  );
  expect(at401.profiles[0].usage.status).toBe('not-signed-in');
  const limited = await usageReport(
    [claude],
    new Set(),
    { maxAgeMs: 0, renew: true },
    cache({}),
    deps([], {
      usage: async () => ({ error: 'rate limited by the usage API', retryAfterMs: 900_000 }),
    }),
  );
  expect(limited.profiles[0].usage).toMatchObject({ status: 'error', retryAfterMs: 900_000 });
  const loggedOut = await usageReport(
    [claude],
    new Set(),
    { maxAgeMs: 0, renew: true },
    cache({}),
    deps([], {
      identity: async () => ({ loggedIn: false }),
    }),
  );
  expect(loggedOut.profiles[0].usage.status).toBe('not-signed-in');
});

test('a torn cache file is reported, not fatal', () => {
  const file = path.join(sandboxHome, 'torn-cache.json');
  fs.writeFileSync(file, '{"claude-a": {"identity": {"loggedIn": tru');
  const read = readLiveCache(file);
  expect(read.entries).toEqual({});
  expect(read.error).toMatch(/torn-cache\.json/);
  expect(readLiveCache(path.join(sandboxHome, 'absent.json'))).toEqual({ entries: {} });
});
