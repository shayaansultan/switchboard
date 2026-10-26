// Removing an OpenCode profile. Every OpenCode profile is also the proxy
// bucket of the same id, stored in the profile's own directory, so a removal
// says what happens to that bucket: keep it, as a standalone bucket under
// buckets/<id>, or delete it with the profile. Launch admission is shared
// with bucket removal and profile editing. Process inspection covers tools
// that predate the launch lease protocol.
//
// Keeping the bucket moves exactly secrets.json and proxy/ (the accounts'
// sign-ins, the API credential reference's settings and the keys routed
// clients use) into a new bucket directory, and the upstream settings into
// its bucket.json. Everything else in the profile directory is OpenCode's:
// settings, sessions, history, connections and their identity snapshots.
// The move is two renames around one commit point, the rename of the new
// bucket directory into place, so an interrupted move either rolls back to
// the profile or finishes as the bucket (see recoverLocked()).
//
// Nothing moves under a running process. The routing worker is stopped under
// its start lock first, desktop profiles routed through the bucket must have
// quit, and no process may hold a file open in the directory: an OpenCode
// window keeps its log and database open, and a proxy orphaned by a dead
// worker keeps its working directory there.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as profiles from './profiles';
import * as bucketStore from '../buckets/store';
import * as buckets from '../buckets';
import * as proxy from '../buckets/proxy';
import { holdRemoval } from './lifecycle';
import { Profile } from './types';
import { root, readJson, writeJson, ProfileId } from '../storage';
import { readStore, withStoreLock, load as loadStore, clearProxyBucket } from '../store';
import { instanceFor, runningInstances } from '../launch';
import type { Profile as DesktopProfile } from '../types';

const execute = promisify(execFile);

export type BucketChoice = 'keep' | 'delete';

// What the bucket keeps when the profile goes. Paths are relative to the
// profile directory.
const BUCKET_ENTRIES = ['secrets.json', 'proxy'] as const;
// Directories only OpenCode writes. A file open in one means a window or a
// tool of this profile is still running.
const OPENCODE_ENTRIES = ['config', 'data', 'home', 'state', 'cache'] as const;

export interface RemovalPlan {
  profile: { id: string; name: string };
  bucket: BucketChoice;
  stopsWorker: true;
  // Deleted outright.
  deletes: string[];
  // Kept as the standalone bucket at `to`, when the bucket is kept.
  keeps?: { from: string[]; to: string };
  // Desktop profiles routed through the bucket. Kept: they stay routed.
  // Deleted: they go back to their own sign-in.
  routed: { id: string; name: string }[];
  // Outside the profile and untouched either way: a connection's Codex home
  // and bridge, and native agent sign-ins.
  untouched: string[];
}

export interface RemovalResult {
  removed: string;
  bucket: BucketChoice;
  deleted: string[];
  // Where the kept bucket now lives.
  movedTo?: string;
  unassigned: string[];
  recovered?: true;
}

function staging(id: string): string {
  // A leading dot is not a bucket id, so neither list() nor paths() sees it.
  return path.join(root(), 'buckets', `.${id}.removing`);
}
function hidden(id: string): string {
  return path.join(root(), 'opencode', `.${id}.removing`);
}

function routedProfiles(id: string): DesktopProfile[] {
  try {
    return readStore().profiles.filter((p) => p.proxyBucket === id);
  } catch (error) {
    // No Switchboard store yet means nothing is routed.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function plan(id: string, bucket: BucketChoice): RemovalPlan {
  const base = profiles.paths(id).base;
  const pending = fs.existsSync(hidden(id));
  if (pending && bucket !== 'keep')
    throw new Error(
      `Finish the interrupted keep first: oc remove ${id} --keep-bucket --yes. Then use switchboard bucket remove if the bucket should go too.`,
    );
  const source = pending ? hidden(id) : base;
  const profile = pending ? Profile.parse(readJson(path.join(source, 'profile.json'))) : profiles.load(id);
  if (profile.id !== id) throw new Error('Profile directory and manifest disagree');
  const entries = fs.readdirSync(source);
  const kept = bucket === 'keep' ? BUCKET_ENTRIES.filter((entry) => entries.includes(entry)) : [];
  const connections = Object.values(profile.connections).flatMap((c) => [c.codexHome, c.bridge]);
  const native = [profile.nativeAgents?.claude?.configDir, profile.nativeAgents?.codex?.home];
  return {
    profile: { id: profile.id, name: profile.name },
    bucket,
    stopsWorker: true,
    deletes:
      bucket === 'delete'
        ? [base]
        : entries.filter((entry) => !kept.includes(entry as never)).map((entry) => path.join(base, entry)),
    keeps:
      bucket === 'keep'
        ? { from: kept.map((entry) => path.join(base, entry)), to: path.join(root(), 'buckets', id) }
        : undefined,
    routed: routedProfiles(id).map((p) => ({ id: p.id, name: p.name })),
    untouched: [...new Set([...connections, ...native].filter((p): p is string => Boolean(p)))],
  };
}

// The processes, other than this one, with a file open (or their working
// directory) under any of the given paths. Fails closed: removal does not go
// ahead when it cannot tell.
async function openBy(directories: string[]): Promise<number[]> {
  const present = directories.filter((directory) => fs.existsSync(directory));
  if (!present.length) return [];
  try {
    const { stdout, stderr } = await execute('lsof', ['-t', ...present.flatMap((d) => ['+D', d])], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    if (stderr.trim()) throw new Error(stderr.trim());
    return pids(stdout);
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean; message: string };
    // Exit 1 without diagnostics means no matches. Warnings mean the scan
    // may be incomplete, so never interpret them as permission to delete.
    if (failure.code === 1 && !failure.killed && !failure.stderr?.trim()) return pids(failure.stdout ?? '');
    throw new Error(`Cannot check which processes use ${present[0]}: ${failure.message}`);
  }
}
function pids(stdout: string): number[] {
  return [
    ...new Set(
      stdout
        .split('\n')
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid),
    ),
  ];
}
async function assertUnused(id: string, directories: string[], what: string): Promise<void> {
  const users = await openBy(directories);
  if (users.length)
    throw new Error(
      `${what} ${id} is in use by process ${users.join(', ')}. Quit its OpenCode windows and tools first.`,
    );
}

async function assertRoutedQuit(routed: DesktopProfile[]): Promise<void> {
  if (!routed.length) return;
  const running = await runningInstances();
  const open = routed.filter((p) => instanceFor(p, running));
  if (open.length) throw new Error(`Quit ${open.map((p) => p.name).join(', ')} first: it routes through this bucket`);
}
function unroute(bucket: string): string[] {
  if (!routedProfiles(bucket).length) return [];
  return withStoreLock(() => {
    const data = loadStore();
    if (data.loadError) throw new Error(data.loadError);
    return clearProxyBucket(data, bucket);
  });
}

// Finishes or undoes a keep-the-bucket removal a crash interrupted. Whether
// the new bucket directory reached its place decides which. The hidden
// directories are invisible to every other operation; the start lock that
// moved with the profile also recognizes removals from older builds. The
// caller holds the external lifecycle gate throughout recovery.
function recoverLocked(id: string): boolean {
  ProfileId.parse(id);
  const moving = hidden(id);
  const next = staging(id);
  const lock = path.join(moving, 'runtime', 'starting.lock');
  const owner = fs.existsSync(lock) ? Number(fs.readFileSync(lock, 'utf8')) : 0;
  if (fs.existsSync(lock) && (!Number.isSafeInteger(owner) || owner <= 0))
    throw new Error(`Invalid removal lock: ${lock}. Inspect it before retrying.`);
  if (owner && owner !== process.pid && proxy.processAlive(owner))
    throw new Error(`OpenCode profile ${id} is being removed by process ${owner}`);
  if (fs.existsSync(moving)) {
    const profile = Profile.parse(readJson(path.join(moving, 'profile.json')));
    if (profile.id !== id) throw new Error('Profile directory and manifest disagree');
    if (fs.existsSync(profiles.paths(id).base))
      throw new Error(`Both ${profiles.paths(id).base} and ${moving} exist. Inspect them before retrying.`);
  }
  const committed = fs.existsSync(moving) && fs.existsSync(path.join(root(), 'buckets', id, 'bucket.json'));
  if (committed) {
    bucketStore.load(id);
    fs.rmSync(moving, { recursive: true, force: true });
    fs.rmSync(next, { recursive: true, force: true });
    return true;
  }
  if (!fs.existsSync(moving)) {
    fs.rmSync(next, { recursive: true, force: true });
    return false;
  }
  for (const entry of BUCKET_ENTRIES) {
    const from = path.join(next, entry);
    if (fs.existsSync(from) && !fs.existsSync(path.join(moving, entry))) fs.renameSync(from, path.join(moving, entry));
  }
  fs.rmSync(next, { recursive: true, force: true });
  fs.renameSync(moving, profiles.paths(id).base);
  return false;
}

export async function remove(id: string, bucket: BucketChoice): Promise<RemovalResult> {
  const release = holdRemoval(id);
  try {
    return await removeLocked(id, bucket);
  } finally {
    release();
  }
}

async function removeLocked(id: string, bucket: BucketChoice): Promise<RemovalResult> {
  if (fs.existsSync(hidden(id)) && bucket !== 'keep')
    throw new Error(`Finish the interrupted keep first: oc remove ${id} --keep-bucket --yes`);
  if (recoverLocked(id))
    return {
      removed: id,
      bucket: 'keep',
      deleted: [profiles.paths(id).base],
      movedTo: path.join(root(), 'buckets', id),
      unassigned: [],
      recovered: true,
    };
  const profile = profiles.load(id);
  const directory = profiles.paths(id);
  if (!bucketStore.withOpenCode(id)) throw new Error(`OpenCode profile ${id} is not stored with its bucket`);
  const opencodeDirectories = OPENCODE_ENTRIES.map((entry) => path.join(directory.base, entry));

  await assertRoutedQuit(routedProfiles(id));
  // Before the worker stops, so a window in use is not cut off by a refusal.
  await assertUnused(id, opencodeDirectories, 'OpenCode profile');

  const release = proxy.holdStartLock(id);
  try {
    await buckets.stop(id);
    if (proxy.receipt(id)) throw new Error(`Bucket ${id} still has a worker. Stop it before removing the profile.`);
    await assertRoutedQuit(routedProfiles(id));
    await assertUnused(id, [directory.base], 'OpenCode profile');
    if (fs.existsSync(path.join(directory.base, 'editing.lock')))
      throw new Error(`OpenCode profile ${id} is being edited. Try again in a moment.`);
    if (bucket === 'delete') {
      const unassigned = unroute(id);
      bucketStore.remove(id);
      return { removed: id, bucket, deleted: [directory.base], unassigned };
    }
    if (fs.existsSync(path.join(root(), 'buckets', id))) throw new Error(`A bucket already exists for ${id}`);
    // The whole directory leaves view first, taking the start lock with it, so
    // nothing can start a worker or edit the profile while the bucket moves.
    fs.renameSync(directory.base, hidden(id));
  } catch (error) {
    release();
    throw error;
  }
  const moving = hidden(id);
  const next = staging(id);
  const target = path.join(root(), 'buckets', id);
  try {
    fs.mkdirSync(path.join(next, 'runtime'), { recursive: true, mode: 0o700 });
    for (const entry of BUCKET_ENTRIES)
      if (fs.existsSync(path.join(moving, entry))) fs.renameSync(path.join(moving, entry), path.join(next, entry));
    fs.mkdirSync(path.join(next, 'proxy', 'auth'), { recursive: true, mode: 0o700 });
    // The cached API observation lets a stopped bucket still show its models.
    const observed = path.join(moving, 'runtime', 'upstream.json');
    if (fs.existsSync(observed)) fs.copyFileSync(observed, path.join(next, 'runtime', 'upstream.json'));
    writeJson(path.join(next, 'bucket.json'), { id, name: profile.name, upstream: profile.upstream });
    // The commit point.
    fs.renameSync(next, target);
  } catch (error) {
    try {
      recoverLocked(id);
    } finally {
      release();
    }
    throw error;
  }
  const deleted = fs.readdirSync(moving).map((entry) => path.join(directory.base, entry));
  fs.rmSync(moving, { recursive: true, force: true });
  return { removed: id, bucket, deleted, movedTo: target, unassigned: [] };
}
