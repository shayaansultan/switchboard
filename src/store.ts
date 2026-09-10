// Profile store. A profile is one account slot for one vendor.
// Each non-default profile owns an isolated directory tree under ~/.switchboard
// so its CLI login, desktop-app session, history and settings never touch
// another profile's.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Dirs, Profile, Store, Vendor, VendorInfo } from './types';

// Node's os.homedir() honours $HOME on POSIX; Bun reads the passwd entry
// instead. Prefer $HOME so tests can point the whole store at a scratch
// directory, and so an explicit HOME wins as it does everywhere else.
export const HOME = process.env.HOME || os.homedir();
export const ROOT = path.join(HOME, '.switchboard');
const STORE = path.join(ROOT, 'profiles.json');

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
    settings: { terminal: 'Terminal', pollMinutes: 5, usageMode: 'used', appearance: 'system' },
    profiles: [
      { id: 'claude-default', vendor: 'claude', name: 'Default', isDefault: true, color: '#d97757' },
      { id: 'codex-default', vendor: 'codex', name: 'Default', isDefault: true, color: '#10a37f' },
    ],
  };
}

export function load(): Store {
  let raw: string;
  try {
    raw = fs.readFileSync(STORE, 'utf8');
  } catch {
    // No store yet: first run.
    const d = defaults();
    save(d);
    return d;
  }
  try {
    const data = JSON.parse(raw) as Store;
    if (!Array.isArray(data.profiles)) throw new Error('no profiles array');
    data.settings = { ...defaults().settings, ...data.settings };
    return data;
  } catch (e) {
    // The file exists but is unreadable. Keep it: it is the only record of
    // which profiles own which directories, and those directories hold logins.
    const backup = `${STORE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(STORE, backup);
    } catch {
      /* best effort */
    }
    const d = defaults();
    d.loadError = `Could not read ${STORE} (${(e as Error).message}). A copy is at ${backup}; starting with the default profiles.`;
    save(d);
    return d;
  }
}

// Write through a temp file so a crash or a full disk cannot truncate the
// store and lose the mapping from profiles to their directories.
export function save(data: Store): void {
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
  const tmp = `${STORE}.tmp`;
  const { loadError: _loadError, ...persisted } = data;
  fs.writeFileSync(tmp, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STORE);
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

const PALETTE = ['#d97757', '#10a37f', '#3b82f6', '#a855f7', '#f59e0b', '#ec4899', '#14b8a6', '#64748b'];

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
// session, history and settings. There is no keep-the-data variant; the
// directory means nothing without its entry in the store.
export function remove(data: Store, id: string): void {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) return;
  if (p.isDefault) throw new Error('the default profile cannot be removed');
  data.profiles = data.profiles.filter((x) => x.id !== id);
  save(data);
  const base = path.join(ROOT, p.vendor, p.id);
  if (base.startsWith(ROOT + path.sep)) fs.rmSync(base, { recursive: true, force: true });
}

export function update(data: Store, id: string, patch: { name?: string; color?: string }): Profile {
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('no such profile');
  if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim();
  if (typeof patch.color === 'string') p.color = patch.color;
  save(data);
  return p;
}
