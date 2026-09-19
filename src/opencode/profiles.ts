import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { root, readJson, writeJson } from '../storage';
export { root, readJson, writeJson } from '../storage';
import { Profile, ProfileId, ModelId, Secrets, Connection, Service, Identity } from './types';

export function paths(value: string) {
  const id = ProfileId.parse(value);
  const base = path.join(root(), 'opencode', id);
  return {
    base,
    config: path.join(base, 'config', 'opencode'),
    data: path.join(base, 'data', 'opencode'),
    home: path.join(base, 'home'),
    runtime: path.join(base, 'runtime'),
    proxy: path.join(base, 'proxy'),
    auth: path.join(base, 'proxy', 'auth'),
  };
}
export function load(id: string): Profile {
  const profile = Profile.parse(readJson(path.join(paths(id).base, 'profile.json')));
  if (profile.id !== id) throw new Error('Profile directory and manifest disagree');
  return profile;
}
export function list(): Profile[] {
  const directory = path.join(root(), 'opencode');
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  return entries
    .filter((id) => ProfileId.safeParse(id).success)
    .filter((id) => fs.existsSync(path.join(directory, id, 'profile.json')))
    .map(load);
}
export function save(profile: Profile): void {
  writeJson(path.join(paths(profile.id).base, 'profile.json'), Profile.parse(profile));
}

export function update(id: string, change: (profile: Profile) => void): void {
  const lock = path.join(paths(id).base, 'editing.lock');
  const descriptor = fs.openSync(lock, 'wx', 0o600);

  try {
    const profile = load(id);
    change(profile);
    save(profile);
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(lock);
  }
}
export function create(name: string): Profile {
  const id = ProfileId.parse(
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64),
  );
  const directory = paths(id);
  if (fs.existsSync(path.join(root(), 'buckets', id))) throw new Error('A shared bucket with that name already exists');
  fs.mkdirSync(path.dirname(directory.base), { recursive: true, mode: 0o700 });
  // Exclusive creation must never adopt old credentials left in an orphan folder.
  fs.mkdirSync(directory.base, { mode: 0o700 });
  try {
    for (const entry of [
      directory.config,
      directory.data,
      directory.home,
      directory.runtime,
      directory.proxy,
      directory.auth,
      path.join(directory.base, 'state'),
      path.join(directory.base, 'cache'),
    ]) {
      fs.mkdirSync(entry, { recursive: true, mode: 0o700 });
    }
    const profile: Profile = {
      version: 1,
      id,
      name: name.trim(),
      createdAt: new Date().toISOString(),
      model: ModelId.parse('gpt-6-astra'),
      reasoningEffort: 'low',
      projectConfig: 'isolated',
      connections: {},
    };
    writeJson(path.join(directory.base, 'secrets.json'), {
      apiKey: randomBytes(32).toString('hex'),
      managementKey: randomBytes(32).toString('hex'),
    });
    writeJson(path.join(directory.config, 'opencode.json'), { $schema: 'https://opencode.ai/config.json' });
    save(profile);
    return profile;
  } catch (error) {
    fs.rmSync(directory.base, { recursive: true, force: true });
    throw error;
  }
}
export function secrets(id: string): Secrets {
  return Secrets.parse(readJson(path.join(paths(id).base, 'secrets.json')));
}

export function identitySnapshot(id: string, service: Service, identity: Identity): string {
  const value = Identity.parse(identity);
  const content = JSON.stringify(value);
  const digest = createHash('sha256').update(content).digest('hex');
  const file = path.join(paths(id).runtime, 'identities', `${service}-${digest}.json`);

  // Every launch retains its own binding even if another window reconnects
  // this service. Keep old snapshots while their MCP processes may reference them.
  if (fs.existsSync(file)) {
    if (JSON.stringify(Identity.parse(readJson(file))) !== content) {
      throw new Error('An existing service identity snapshot has changed');
    }
  } else {
    writeJson(file, value);
  }

  return file;
}

export function connect(id: string, service: Service, input: Connection): void {
  const connection = Connection.parse(input);
  for (const file of [connection.bridge, path.join(connection.codexHome, 'auth.json')]) {
    if (!path.isAbsolute(file) || !fs.existsSync(file)) throw new Error(`Connection path is missing: ${file}`);
  }
  update(id, (profile) => {
    profile.connections[service] = connection;
  });
}
export function disconnect(id: string, service: Service): void {
  update(id, (profile) => {
    delete profile.connections[service];
  });
}
