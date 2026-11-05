import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ProfileId as BucketId, Secrets, root, readJson, writeJson } from '../storage';
export { ProfileId as BucketId, root, readJson, writeJson } from '../storage';

import { Upstream } from './upstream';
import { STORE_FILE, parseStore } from '../store';
const Bucket = z.object({ id: BucketId, name: z.string().min(1), upstream: Upstream.optional() });
export function paths(value: string) {
  const base = path.join(root(), 'buckets', BucketId.parse(value));
  return {
    base,
    runtime: path.join(base, 'runtime'),
    proxy: path.join(base, 'proxy'),
    auth: path.join(base, 'proxy', 'auth'),
    manifest: path.join(base, 'bucket.json'),
  };
}
export function load(id: string) {
  const bucket = Bucket.parse(readJson(paths(id).manifest));
  if (bucket.id !== id) throw new Error('Bucket directory and manifest disagree');
  return bucket;
}
export function list() {
  const base = path.join(root(), 'buckets');
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((id) => BucketId.safeParse(id).success && fs.existsSync(path.join(base, id, 'bucket.json')))
    .sort()
    .map(load);
}
export function create(name: string, upstream?: Upstream) {
  if (upstream) upstream = Upstream.parse(upstream);
  const clean = z.string().trim().min(1).max(100).parse(name);
  const id = BucketId.parse(
    clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64),
  );
  // A profile still assigned to this ID, left from a bucket that no longer
  // exists, would otherwise route through the new one without being asked.
  const routed = routedProfiles(id);
  if (routed.length)
    throw new Error(
      `${routed.join(', ')} still route through "${id}". Unassign them before creating a bucket with that name.`,
    );
  const directory = paths(id);
  fs.mkdirSync(path.dirname(directory.base), { recursive: true, mode: 0o700 });
  // Non-recursive, so a second bucket with the same name fails here.
  fs.mkdirSync(directory.base, { mode: 0o700 });
  try {
    for (const p of [directory.runtime, directory.auth]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    writeJson(path.join(directory.base, 'secrets.json'), {
      apiKey: randomBytes(32).toString('hex'),
      managementKey: randomBytes(32).toString('hex'),
    });
    writeJson(directory.manifest, { id, name: clean, upstream });
    return load(id);
  } catch (error) {
    fs.rmSync(directory.base, { recursive: true, force: true });
    throw error;
  }
}
function routedProfiles(id: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return parseStore(raw)
    .profiles.filter((p) => p.proxyBucket === id)
    .map((p) => p.id);
}
// Deletes everything the bucket owns: its accounts' sign-ins, secrets and
// logs. The caller stops the worker first.
export function remove(id: string): void {
  load(id);
  fs.rmSync(paths(id).base, { recursive: true, force: true });
}
export function secrets(id: string) {
  return Secrets.parse(readJson(path.join(paths(id).base, 'secrets.json')));
}

// A stopped API bucket may move its credential reference without becoming an
// OAuth pool. Other manifest fields are kept as they are.
export function setCredential(id: string, credential: Upstream['credential']): void {
  editUpstream(id, (upstream) => ({ ...upstream, credential }));
}
export function setDefaultModel(id: string, defaultModel: string): void {
  editUpstream(id, (upstream) => ({ ...upstream, defaultModel }));
}
function editUpstream(id: string, change: (upstream: Upstream) => Upstream): void {
  const lock = path.join(paths(id).base, 'editing.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    const original = z.record(z.string(), z.unknown()).parse(readJson(paths(id).manifest));
    const upstream = Upstream.parse(change(Upstream.parse(original.upstream)));
    writeJson(paths(id).manifest, { ...original, upstream });
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
