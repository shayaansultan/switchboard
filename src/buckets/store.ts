import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ProfileId as BucketId, Secrets, root, readJson, writeJson } from '../storage';
export { ProfileId as BucketId, root, readJson, writeJson } from '../storage';

const Bucket = z.object({ id: BucketId, name: z.string().min(1) });
// Existing pools keep their files and worker leases in place. No token copies,
// symlink migration, or second controller for an already-running OpenCode pool.
export function paths(value: string) {
  const id = BucketId.parse(value);
  const legacy = path.join(root(), 'opencode', id);
  const shared = path.join(root(), 'buckets', id);
  const existing = fs.existsSync(path.join(legacy, 'profile.json'));
  if (existing && fs.existsSync(shared)) throw new Error(`Ambiguous bucket storage: ${id}`);
  const base = existing ? legacy : shared;
  return {
    base,
    runtime: path.join(base, 'runtime'),
    proxy: path.join(base, 'proxy'),
    auth: path.join(base, 'proxy', 'auth'),
    manifest: path.join(base, existing ? 'profile.json' : 'bucket.json'),
  };
}
export function load(id: string) {
  const bucket = Bucket.parse(readJson(paths(id).manifest));
  if (bucket.id !== id) throw new Error('Bucket directory and manifest disagree');
  return bucket;
}
export function list() {
  const ids = new Set<string>();
  for (const [directory, manifest] of [
    ['opencode', 'profile.json'],
    ['buckets', 'bucket.json'],
  ]) {
    const base = path.join(root(), directory);
    if (!fs.existsSync(base)) continue;
    for (const id of fs.readdirSync(base)) {
      if (BucketId.safeParse(id).success && fs.existsSync(path.join(base, id, manifest))) ids.add(id);
    }
  }
  return [...ids].sort().map(load);
}
export function create(name: string) {
  const clean = z.string().trim().min(1).max(100).parse(name);
  const id = BucketId.parse(
    clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64),
  );
  if (fs.existsSync(path.join(root(), 'opencode', id)))
    throw new Error('A profile or bucket with that name already exists');
  const directory = paths(id);
  fs.mkdirSync(path.dirname(directory.base), { recursive: true, mode: 0o700 });
  fs.mkdirSync(directory.base, { mode: 0o700 });
  try {
    for (const p of [directory.runtime, directory.auth]) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    writeJson(path.join(directory.base, 'secrets.json'), {
      apiKey: randomBytes(32).toString('hex'),
      managementKey: randomBytes(32).toString('hex'),
    });
    writeJson(directory.manifest, { id, name: clean });
    return load(id);
  } catch (error) {
    fs.rmSync(directory.base, { recursive: true, force: true });
    throw error;
  }
}
export function secrets(id: string) {
  return Secrets.parse(readJson(path.join(paths(id).base, 'secrets.json')));
}
