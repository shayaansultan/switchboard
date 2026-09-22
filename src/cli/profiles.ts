// Profiles: listing them, creating and removing them, and the settings each
// one carries. Mutations go through mutateStore, so they take the same lock
// the app takes and re-read the file before changing it.

import * as path from 'node:path';
import * as launch from '../launch';
import * as profiles from '../profiles';
import * as buckets from '../buckets';
import type { BringMode, Instance, Profile, SetupItem, Vendor } from '../types';
import type { Context } from './context';
import { parse, required } from './context';
import { assertNotRunning, instances, runningPid } from './desktop';
import { notFound, ref, refused, table, usageError, type ProfileRef } from './output';
import { confirm, mutateStore, parseVendor, resolveProfile } from './resolve';
import { identityOut, readLiveCache, usageOut, type CacheRead, type IdentityOut, type UsageOut } from './usage';

export interface ProfileSummary extends ProfileRef {
  color: string;
  proxyBucket: string | null;
  dirs: ReturnType<typeof profiles.dirs>;
  command: string;
  running: boolean;
  pid: number | null;
  identity: IdentityOut;
}

export function summary(profile: Profile, running: Instance[], cache: CacheRead): ProfileSummary {
  const pid = runningPid(profile, running);
  return {
    ...ref(profile),
    color: profile.color,
    proxyBucket: profile.proxyBucket ?? null,
    dirs: profiles.dirs(profile),
    command: launch.cliCommand(profile),
    running: pid !== null,
    pid,
    identity: identityOut(cache.entries[profile.id]?.identity),
  };
}

const warnings = (ctx: Context) => (ctx.data.loadError ? { warnings: [ctx.data.loadError] } : {});

export async function listCommand(rest: string[], ctx: Context): Promise<void> {
  const { values } = parse(rest, { vendor: { type: 'string' } });
  const vendor = values.vendor === undefined ? null : parseVendor(values.vendor);
  const [running, cache] = [await instances(), readLiveCache()];
  const rows = ctx.data.profiles.filter((p) => !vendor || p.vendor === vendor).map((p) => summary(p, running, cache));
  ctx.out.result({ profiles: rows, ...warnings(ctx) }, () =>
    table(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        running: r.running ? 'yes' : '',
        bucket: r.proxyBucket,
        account: r.identity?.email ?? (r.identity ? 'signed out' : ''),
      })),
      ['id', 'name', 'running', 'bucket', 'account'],
    ),
  );
}

export async function showCommand(rest: string[], ctx: Context): Promise<void> {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  const cache = readLiveCache();
  const entry = cache.entries[profile.id];
  const usage: UsageOut = usageOut(entry?.identity, entry?.usage, Date.now());
  ctx.out.result({
    ...summary(profile, await instances(), cache),
    createdAt: profile.createdAt,
    setup: profile.setup,
    usage,
    ...warnings(ctx),
  });
}

export function setupItemsCommand(rest: string[], ctx: Context): void {
  const vendor = parseVendor(rest[0]);
  ctx.out.result({
    vendor,
    items: profiles.SETUP_ITEMS[vendor].map(({ id, label, hint, kind, on, warn, copyOnly }) => ({
      id,
      label,
      hint,
      kind,
      on,
      warn,
      copyOnly,
    })),
  });
}

// `--items a,b,c`, `--items none`, or the dialog's defaults when omitted.
function chooseItems(vendor: Vendor, text: string | undefined): string[] {
  const available: SetupItem[] = profiles.SETUP_ITEMS[vendor];
  if (text === undefined) return available.filter((i) => i.on).map((i) => i.id);
  if (text === 'none') return [];
  const ids = text.split(',').map((s) => s.trim());
  const unknown = ids.filter((id) => !available.some((i) => i.id === id));
  if (unknown.length) {
    throw usageError(`Unknown item${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, {
      items: available.map((i) => i.id),
    });
  }
  return ids;
}

function parseMode(text: string | undefined): BringMode {
  if (text === undefined) return 'link';
  if (text === 'link' || text === 'copy') return text;
  throw usageError('--mode must be link or copy');
}

function assertSameVendor(target: Vendor, source: Profile): void {
  if (source.vendor !== target) {
    throw refused(
      'vendor-mismatch',
      `${source.id} is a ${source.vendor} profile; items only move between profiles of one app`,
    );
  }
}

// Chat history rewrites a file the app keeps open, so a running window would
// silently undo it (see the same guard in the app's bring-over handler).
async function assertHistoryPossible(target: Profile, items: string[]): Promise<void> {
  const touchesAppState = items.some((id) =>
    profiles.SETUP_ITEMS[target.vendor].some((it) => it.id === id && it.projectState),
  );
  if (touchesAppState)
    assertNotRunning(target, await instances(), 'chat history changes a file that window keeps open');
}

const bringOptions = { from: { type: 'string' }, items: { type: 'string' }, mode: { type: 'string' } } as const;

export async function addCommand(rest: string[], ctx: Context): Promise<void> {
  const { values, positionals } = parse(rest, bringOptions);
  const vendor = parseVendor(positionals[0]);
  const name = required(positionals[1], 'Name');
  if (values.from === undefined && (values.items !== undefined || values.mode !== undefined)) {
    throw usageError('--items and --mode need --from');
  }
  const source = values.from === undefined ? null : resolveProfile(ctx.data, values.from);
  if (source) assertSameVendor(vendor, source);
  const items = source ? chooseItems(vendor, values.items) : [];
  const mode = parseMode(values.mode);
  ctx.out.result(mutateStore((data) => profiles.add(data, { vendor, name, sourceId: source?.id, items, mode })));
}

export async function bringOverCommand(rest: string[], ctx: Context): Promise<void> {
  const { values, positionals } = parse(rest, bringOptions);
  const target = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
  const source = resolveProfile(ctx.data, required(values.from, '--from'));
  assertSameVendor(target.vendor, source);
  const items = chooseItems(target.vendor, values.items);
  const mode = parseMode(values.mode);
  await assertHistoryPossible(target, items);
  const result = mutateStore((data) =>
    profiles.bringOver(data, resolveProfile(data, target.id), resolveProfile(data, source.id), { items, mode }),
  );
  ctx.out.result({ profile: ref(target), source: ref(source), result });
}

export function renameCommand(rest: string[], ctx: Context): void {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  const name = required(rest[1], 'Name');
  ctx.out.result({ profile: mutateStore((data) => profiles.update(data, profile.id, { name })) });
}

export function recolorCommand(rest: string[], ctx: Context): void {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  const text = required(rest[1], 'Colour');
  const color = /^\d+$/.test(text) ? profiles.PALETTE[Number(text)] : /^#[0-9a-f]{6}$/i.test(text) ? text : undefined;
  if (!color) throw usageError(`Colour must be #rrggbb or a palette index 0-${profiles.PALETTE.length - 1}`);
  ctx.out.result({ profile: mutateStore((data) => profiles.update(data, profile.id, { color })) });
}

export function moveCommand(rest: string[], ctx: Context): void {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  const direction = rest[1];
  if (direction !== 'up' && direction !== 'down') throw usageError('Direction must be up or down');
  const moved = mutateStore((data) => profiles.move(data, profile.id, direction === 'up' ? -1 : 1));
  ctx.out.result({ profile: ref(profile), moved });
}

export async function removeCommand(rest: string[], ctx: Context): Promise<void> {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  if (profile.isDefault) throw refused('default-profile', 'The Default profile cannot be removed');
  assertNotRunning(profile, await instances(), 'removing it deletes the directory that window is using');
  const deleted = path.dirname(profiles.dirs(profile).home);
  await confirm(ctx.flags, ctx.out.io, `Remove ${profile.id} and delete everything under ${deleted}?`);
  mutateStore((data) => profiles.remove(data, profile.id));
  ctx.out.result({ removed: ref(profile), deleted });
}

export function loadBucket(id: string): ReturnType<typeof buckets.load> {
  try {
    return buckets.load(id);
  } catch {
    throw notFound('no-such-bucket', `No bucket "${id}"`, 'switchboard bucket list');
  }
}

export async function assignCommand(rest: string[], ctx: Context, bucket: string | null): Promise<void> {
  const profile = resolveProfile(ctx.data, required(rest[0], 'Profile'));
  if (profile.vendor !== 'codex')
    throw refused('wrong-vendor', 'Proxy routing is available for Codex desktop profiles');
  if (bucket !== null) loadBucket(bucket);
  const updated = mutateStore((data) => profiles.setProxyBucket(data, profile.id, bucket));
  const running = runningPid(profile, await instances()) !== null;
  ctx.out.result({ profile: updated, effective: 'next-launch', running });
}
