// Usage per profile: from the app's cache by default, live on request. The
// CLI never writes the cache; the app is its only writer.

import * as fs from 'node:fs';
import * as usage from '../usage';
import { LIVE_CACHE_FILE } from '../store';
import type { CacheEntry, Identity, LiveCache, Profile, Usage } from '../types';
import type { Context } from './context';
import { parse } from './context';
import { runningIds } from './desktop';
import { rank } from './headroom';
import { ref, refused, table, usageError, type ProfileRef } from './output';
import { parseDuration, parseVendor, resolveProfile } from './resolve';

export type UsageStatus = 'ok' | 'stale' | 'not-signed-in' | 'error' | 'none';

export interface UsageWindowOut {
  label: string;
  pct: number | null;
  remaining: number | null;
  resetsAt: string | null;
  severity: string | null;
}

export interface UsageOut {
  status: UsageStatus;
  windows: UsageWindowOut[];
  headroom: number | null;
  plan: string | null;
  fetchedAt: string | null;
  ageSeconds: number | null;
  error: string | null;
  retryAfterMs?: number;
}

export type IdentityOut = { loggedIn: boolean; email: string | null; plan: string | null; org: string | null } | null;

export interface UsageEntry extends ProfileRef {
  running: boolean;
  source: 'cache' | 'live' | 'none';
  identity: IdentityOut;
  usage: UsageOut;
}

export interface CacheRead {
  entries: LiveCache;
  error?: string;
}

export function readLiveCache(file = LIVE_CACHE_FILE): CacheRead {
  if (!fs.existsSync(file)) return { entries: {} };
  try {
    return { entries: JSON.parse(fs.readFileSync(file, 'utf8')) as LiveCache };
  } catch (error) {
    return { entries: {}, error: `Could not read ${file}: ${(error as Error).message}` };
  }
}

export interface UsageOptions {
  // Fetch live when the cached entry is older than this; null means cache only.
  maxAgeMs: number | null;
  // Let an expired Claude token be renewed through the CLI's own startup.
  renew: boolean;
}

// The lookups, injectable so tests never spawn a CLI or reach the network.
export interface UsageDeps {
  identity(profile: Profile): Promise<Identity>;
  usage(profile: Profile, deps: usage.UsageDependencies): Promise<Usage>;
  now(): number;
}

export const liveDeps: UsageDeps = { identity: usage.identity, usage: usage.usage, now: Date.now };

export const identityOut = (identity: Identity | undefined): IdentityOut =>
  identity
    ? {
        loggedIn: identity.loggedIn,
        email: identity.email ?? null,
        plan: identity.plan ?? null,
        org: identity.org ?? null,
      }
    : null;

export function headroom(windows: UsageWindowOut[]): number | null {
  const known = windows.map((w) => w.remaining).filter((r): r is number => r !== null);
  return known.length ? Math.min(...known) : null;
}

function windowsOut(u: Usage | CacheEntry['usage'] | undefined): UsageWindowOut[] {
  return (u?.windows ?? []).map((w) => ({
    label: w.label,
    pct: w.pct,
    remaining: w.pct === null ? null : 100 - w.pct,
    resetsAt: w.resetsAt,
    severity: w.severity ?? null,
  }));
}

function ageSeconds(fetchedAt: string | null | undefined, now: number): number | null {
  if (!fetchedAt) return null;
  const t = Date.parse(fetchedAt);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((now - t) / 1000));
}

// Fold identity and usage answers, from either source, into one status.
export function usageOut(
  identity: Identity | undefined,
  u: Usage | CacheEntry['usage'] | undefined,
  now: number,
  fallback?: CacheEntry['usage'],
): UsageOut {
  const error = u && 'error' in u ? (u.error ?? null) : null;
  let windows = windowsOut(u);
  let fetchedAt = u?.fetchedAt ?? null;
  let status: UsageStatus;
  if ((identity && !identity.loggedIn) || usage.looksSignedOut(u as Usage | undefined)) status = 'not-signed-in';
  else if (windows.length) status = 'ok';
  else if (error && fallback?.windows?.length) {
    // The live fetch failed; the cached numbers are still the best available.
    status = 'stale';
    windows = windowsOut(fallback);
    fetchedAt = fallback.fetchedAt ?? null;
  } else if (error) status = 'error';
  else status = identity ? 'error' : 'none';
  return {
    status,
    windows,
    headroom: headroom(windows),
    plan: u?.plan ?? null,
    fetchedAt,
    ageSeconds: ageSeconds(fetchedAt, now),
    error,
    ...(u && 'retryAfterMs' in u && u.retryAfterMs ? { retryAfterMs: u.retryAfterMs } : {}),
  };
}

async function entryFor(
  profile: Profile,
  cached: CacheEntry | undefined,
  running: boolean,
  options: UsageOptions,
  deps: UsageDeps,
): Promise<UsageEntry> {
  const now = deps.now();
  const age = ageSeconds(cached?.usage?.fetchedAt, now);
  const refresh = options.maxAgeMs !== null && (!cached?.usage || age === null || age * 1000 >= options.maxAgeMs);
  if (!refresh) {
    return {
      ...ref(profile),
      running,
      source: cached ? 'cache' : 'none',
      identity: identityOut(cached?.identity),
      usage: usageOut(cached?.identity, cached?.usage, now),
    };
  }
  const identity = await deps.identity(profile);
  const live: Usage = identity.loggedIn
    ? await deps.usage(profile, options.renew ? {} : { recoverClaudeCredential: async () => {} })
    : { error: 'not signed in via CLI' };
  return {
    ...ref(profile),
    running,
    source: 'live',
    identity: identityOut(identity),
    usage: usageOut(identity, live, now, cached?.usage),
  };
}

export async function usageReport(
  profiles: Profile[],
  running: Set<string>,
  options: UsageOptions,
  cache: CacheRead = readLiveCache(),
  deps: UsageDeps = liveDeps,
): Promise<{ profiles: UsageEntry[]; cacheError?: string }> {
  const entries = await Promise.all(
    profiles.map((p) => entryFor(p, cache.entries[p.id], running.has(p.id), options, deps)),
  );
  return { profiles: entries, ...(cache.error ? { cacheError: cache.error } : {}) };
}

// ---- commands ----

const ageOptions = { 'max-age': { type: 'string' }, refresh: { type: 'boolean' } } as const;

// Cache only by default; --max-age fetches live for entries older than that.
function maxAge(values: { 'max-age'?: string; refresh?: boolean }): number | null {
  if (values.refresh) return 0;
  return values['max-age'] === undefined ? null : parseDuration(values['max-age']);
}

const usageRow = (e: UsageEntry) => ({
  id: e.id,
  status: e.usage.status,
  windows: e.usage.windows.map((w) => `${w.label} ${w.pct ?? '?'}%`).join(', '),
  headroom: e.usage.headroom === null ? '' : `${e.usage.headroom}%`,
  age: e.usage.ageSeconds === null ? '' : `${Math.round(e.usage.ageSeconds / 60)}m`,
});

export async function usageCommand(rest: string[], ctx: Context, deps = liveDeps): Promise<void> {
  const { values, positionals } = parse(rest, {
    ...ageOptions,
    vendor: { type: 'string' },
    'no-renew': { type: 'boolean' },
  });
  const vendor = values.vendor === undefined ? null : parseVendor(values.vendor);
  const chosen = positionals.length
    ? positionals.map((token) => resolveProfile(ctx.data, token))
    : ctx.data.profiles.filter((p) => !vendor || p.vendor === vendor);
  const options: UsageOptions = { maxAgeMs: maxAge(values), renew: !values['no-renew'] };
  const report = await usageReport(chosen, await runningIds(chosen), options, readLiveCache(), deps);
  ctx.out.result(report, () => table(report.profiles.map(usageRow), ['id', 'status', 'windows', 'headroom', 'age']));
}

export async function pickCommand(rest: string[], ctx: Context, deps = liveDeps): Promise<void> {
  const { values, positionals } = parse(rest, {
    ...ageOptions,
    window: { type: 'string' },
    'min-headroom': { type: 'string' },
  });
  const vendor = parseVendor(positionals[0]);
  const minHeadroom = values['min-headroom'] === undefined ? undefined : Number(values['min-headroom']);
  if (minHeadroom !== undefined && !(minHeadroom >= 0 && minHeadroom <= 100)) {
    throw usageError('--min-headroom is a percentage from 0 to 100');
  }
  const chosen = ctx.data.profiles.filter((p) => p.vendor === vendor);
  const options: UsageOptions = { maxAgeMs: maxAge(values), renew: true };
  const report = await usageReport(chosen, await runningIds(chosen), options, readLiveCache(), deps);
  const ranking = rank(report.profiles, { window: values.window, minHeadroom });
  if (!ranking.profile) {
    throw refused(
      'no-candidates',
      `No ${vendor} profile has usable usage numbers (${ranking.excluded.map((e) => `${e.id}: ${e.reason}`).join(', ') || 'no profiles'})`,
      'switchboard usage --refresh',
    );
  }
  ctx.out.result(ranking);
}
