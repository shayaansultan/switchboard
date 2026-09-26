// Profile store. A profile is one account slot for one vendor.
// Each non-default profile owns an isolated directory tree under ~/.switchboard
// so its CLI login, desktop-app session, history and settings never touch
// another profile's.
//
// Two processes write this store: the app and the `switchboard` CLI. Every
// write is an atomic rename, the app watches the file and reloads foreign
// writes, and read-modify-write sequences hold an advisory lock.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dirs, Profile, Store, Vendor, VendorInfo } from './types';
import { desktopRouting } from './storage';

// Node's os.homedir() honours $HOME on POSIX; Bun reads the passwd entry
// instead. Prefer $HOME so tests can point the whole store at a scratch
// directory, and so an explicit HOME wins as it does everywhere else.
// SWITCHBOARD_ROOT moves the store the same way it moves buckets (storage.ts).
export const HOME = process.env.HOME || os.homedir();
export const ROOT = path.resolve(process.env.SWITCHBOARD_ROOT || path.join(HOME, '.switchboard'));
export const STORE_FILE = path.join(ROOT, 'profiles.json');
export const LIVE_CACHE_FILE = path.join(ROOT, 'live-cache.json');
const LOCK_FILE = path.join(ROOT, 'profiles.lock');

export const VENDORS: Record<Vendor, VendorInfo> = {
  claude: {
    label: 'Claude',
    appPath: '/Applications/Claude.app',
    appBinary: '/Applications/Claude.app/Contents/MacOS/Claude',
    cli: 'claude',
    defaultHome: path.join(HOME, '.claude'),
    defaultDesktop: path.join(HOME, 'Library', 'Application Support', 'Claude'),
    homeEnv: 'CLAUDE_CONFIG_DIR',
  },
  codex: {
    label: 'Codex',
    appPath: '/Applications/ChatGPT.app',
    appBinary: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    cli: 'codex',
    defaultHome: path.join(HOME, '.codex'),
    defaultDesktop: path.join(HOME, 'Library', 'Application Support', 'Codex'),
    homeEnv: 'CODEX_HOME',
  },
};

export const VENDOR_IDS = Object.keys(VENDORS) as Vendor[];

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'profile'
  );
}

function defaults(): Store {
  return {
    settings: { terminal: 'Terminal', pollMinutes: 5, usageMode: 'used', appearance: 'system', menuBar: 'icon' },
    profiles: [
      { id: 'claude-default', vendor: 'claude', name: 'Default', isDefault: true, color: '#d97757' },
      { id: 'codex-default', vendor: 'codex', name: 'Default', isDefault: true, color: '#10a37f' },
    ],
  };
}

// The text of the last save() from this process. A change event whose file
// text equals it is our own write, not one to reload.
let lastSaved: string | null = null;

// Parse the store file's text. Throws on a shape that cannot be a store.
export function parseStore(raw: string): Store {
  const data = JSON.parse(raw) as Store;
  if (!Array.isArray(data.profiles)) throw new Error('no profiles array');
  data.settings = { ...defaults().settings, ...data.settings };
  return data;
}

// Read the store as it is on disk. Never writes; throws if missing or unreadable.
export function readStore(): Store {
  return parseStore(fs.readFileSync(STORE_FILE, 'utf8'));
}

export function load(): Store {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_FILE, 'utf8');
  } catch {
    // No store yet: first run.
    const d = defaults();
    save(d);
    return d;
  }
  try {
    return parseStore(raw);
  } catch (e) {
    // The file exists but is unreadable. Keep it: it is the only record of
    // which profiles own which directories, and those directories hold logins.
    const backup = `${STORE_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(STORE_FILE, backup);
    } catch {
      /* best effort */
    }
    const d = defaults();
    d.loadError = `Could not read ${STORE_FILE} (${(e as Error).message}). A copy is at ${backup}; starting with the default profiles.`;
    save(d);
    return d;
  }
}

// Write through a uniquely named temp file so a crash, a full disk or a
// concurrent writer cannot truncate the store and lose the mapping from
// profiles to their directories.
export function save(data: Store): void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const { loadError: _loadError, ...persisted } = data;
  const text = JSON.stringify(persisted, null, 2);
  const tmp = `${STORE_FILE}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, STORE_FILE);
    lastSaved = text;
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

// The store if another process changed it since this one last saved, else
// null. Unreadable or corrupt content is also null: the in-memory store
// stays authoritative and the next save() writes it back.
export function readIfChanged(): Store | null {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE_FILE, 'utf8');
  } catch {
    return null;
  }
  if (raw === lastSaved) return null;
  try {
    const next = parseStore(raw);
    lastSaved = raw;
    return next;
  } catch {
    return null;
  }
}

export interface StoreDiff {
  added: string[];
  removed: string[];
  changed: string[];
  settingsChanged: boolean;
}

export function diffStores(current: Store, next: Store): StoreDiff {
  const before = new Map(current.profiles.map((p) => [p.id, JSON.stringify(p)]));
  const after = new Map(next.profiles.map((p) => [p.id, JSON.stringify(p)]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)),
    settingsChanged: JSON.stringify(current.settings) !== JSON.stringify(next.settings),
  };
}

// Call `onChange` with the store whenever another process rewrites it. The
// directory is watched rather than the file: the atomic rename replaces the
// inode, and a watch on the old one goes quiet after the first foreign write.
// Returns a function that stops watching.
export function watchStore(onChange: (next: Store) => void, debounceMs = 150): () => void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;
  let dirty = false;
  const check = (): void => {
    timer = null;
    if (reading) {
      dirty = true;
      return;
    }
    reading = true;
    try {
      const next = readIfChanged();
      if (next) onChange(next);
    } finally {
      reading = false;
      if (dirty) {
        dirty = false;
        check();
      }
    }
  };
  const watcher = fs.watch(ROOT, { persistent: false }, (_event, filename) => {
    if (filename !== path.basename(STORE_FILE)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
  });
  watcher.on('error', (error) => {
    console.error(`profiles.json watcher stopped: ${error.message}`);
    watcher.close();
  });
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STEP_MS = 25;

// A lock whose holder no longer exists. Age alone never counts: a holder can
// legitimately be slow (bringing chat history over copies whole folders
// under the lock), and stealing from it would be the lost update the lock
// exists to prevent.
function lockIsStale(): boolean {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) return true;
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ENOENT: it was released meanwhile, which is as good as stale.
    // ESRCH: the holder is gone. EPERM: alive, owned by someone else.
    return (error as NodeJS.ErrnoException).code !== 'EPERM';
  }
}

// Run `fn` while holding the store's advisory lock, so a read-modify-write
// in this process cannot interleave with one in another. Synchronous on
// purpose: the store functions are synchronous, and holders usually finish
// in microseconds. Waits briefly for a live holder; throws if it does not
// clear, rather than ever taking the lock from a process that still has it.
export function withStoreLock<T>(fn: () => T): T {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (lockIsStale()) {
        fs.rmSync(LOCK_FILE, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Another process is editing ${STORE_FILE}. Retry in a moment.`);
      Atomics.wait(pause, 0, 0, LOCK_STEP_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(LOCK_FILE, { force: true });
  }
}

// Resolved paths for a profile. Default profiles point at the vendor's real
// default locations; everything else lives under ~/.switchboard/<vendor>/<id>/.
export function dirs(profile: Profile): Dirs {
  const v = VENDORS[profile.vendor];
  if (profile.isDefault) {
    return { home: v.defaultHome, desktop: v.defaultDesktop, isDefault: true };
  }
  const base = path.join(ROOT, profile.vendor, profile.id);
  return { home: path.join(base, 'home'), desktop: path.join(base, 'desktop'), isDefault: false };
}

export function ensureDirs(profile: Profile): Dirs {
  const d = dirs(profile);
  if (d.isDefault) return d;
  fs.mkdirSync(d.home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(d.desktop, { recursive: true, mode: 0o700 });
  return d;
}

export const PALETTE = ['#d97757', '#10a37f', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#14b8a6', '#64748b'];

// A new, empty profile. Bringing things into it is setup.ts's job.
export function create(data: Store, { vendor, name }: { vendor: Vendor; name: string }): Profile {
  if (!VENDORS[vendor]) throw new Error(`unknown vendor ${vendor}`);
  const clean = String(name || '').trim();
  if (!clean) throw new Error('name is required');
  // A directory left behind by an interrupted removal is never adopted by a
  // new profile of the same name: it could still hold another account's login.
  const taken = (i: string) => data.profiles.some((p) => p.id === i) || fs.existsSync(path.join(ROOT, vendor, i));
  let id = `${vendor}-${slugify(clean)}`;
  let n = 2;
  while (taken(id)) id = `${vendor}-${slugify(clean)}-${n++}`;
  const profile: Profile = {
    id,
    vendor,
    name: clean,
    isDefault: false,
    color: PALETTE[data.profiles.length % PALETTE.length],
    createdAt: new Date().toISOString(),
  };
  ensureDirs(profile);
  data.profiles.push(profile);
  save(data);
  return profile;
}

// Removing a profile removes everything it owns: its CLI login, desktop
// session, history and settings, and for Codex its bucket launch files.
// There is no keep-the-data variant; the directory means nothing without its
// entry in the store.
export function remove(data: Store, id: string): void {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return;
  if (p.isDefault) throw new Error('the default profile cannot be removed');
  // Resolved first: a bad id fails before anything is deleted.
  const routing = p.vendor === 'codex' ? Object.values(desktopRouting(p.id)) : [];
  data.profiles = data.profiles.filter((x) => x.id !== id);
  save(data);
  const base = path.join(ROOT, p.vendor, p.id);
  if (base.startsWith(ROOT + path.sep)) fs.rmSync(base, { recursive: true, force: true });
  for (const file of routing) fs.rmSync(file, { force: true });
}

// Move a profile one step left or right among its vendor's added profiles.
// The Default profile stays first; the order of the other vendor's profiles
// is untouched. Returns false when there was nowhere to move.
export function move(data: Store, id: string, delta: number): boolean {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('no such profile');
  if (p.isDefault) return false;
  const row = data.profiles.filter((x) => x.vendor === p.vendor && !x.isDefault);
  const i = row.indexOf(p);
  // Any whole number of places; a drag lands wherever it was dropped.
  const j = Math.max(0, Math.min(row.length - 1, i + Math.trunc(delta)));
  if (j === i) return false;
  row.splice(i, 1);
  row.splice(j, 0, p);
  // Refill this vendor's slots in the new order; every other entry stays put.
  const queue = [...row];
  data.profiles = data.profiles.map((x) => (x.vendor === p.vendor && !x.isDefault ? (queue.shift() as Profile) : x));
  save(data);
  return true;
}

export function update(data: Store, id: string, patch: { name?: string; color?: string }): Profile {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('no such profile');
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim();
  if (typeof patch.color === 'string') p.color = patch.color;
  save(data);
  return p;
}

// Route a Codex desktop profile's embedded agent through a proxy bucket, or
// back to its native account with null. Whether the bucket exists is the
// caller's concern; this module knows nothing about buckets.
export function setProxyBucket(data: Store, id: string, bucket: string | null): Profile {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('no such profile');
  if (p.vendor !== 'codex') throw new Error('proxy routing is available for Codex desktop profiles');
  if (bucket === null) delete p.proxyBucket;
  else p.proxyBucket = bucket;
  save(data);
  return p;
}

// Moves every profile routed through a bucket back to its own sign-in, for
// when the bucket is deleted. Returns the ids it moved.
export function clearProxyBucket(data: Store, bucket: string): string[] {
  const moved = data.profiles.filter((p) => p.proxyBucket === bucket);
  for (const p of moved) delete p.proxyBucket;
  if (moved.length) save(data);
  return moved.map((p) => p.id);
}
