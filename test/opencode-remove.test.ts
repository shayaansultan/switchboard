import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as profiles from '../src/opencode/profiles';
import * as removal from '../src/opencode/remove';
import { main } from '../src/opencode/cli';
import * as buckets from '../src/buckets';
import * as bucketStore from '../src/buckets/store';
import * as store from '../src/store';

let temporary = '';
let previous: string | undefined;
let routedId = '';

beforeEach(() => {
  previous = process.env.SWITCHBOARD_ROOT;
  temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-oc-remove-')));
  process.env.SWITCHBOARD_ROOT = temporary;
});
afterEach(() => {
  if (routedId) store.withStoreLock(() => store.remove(store.load(), routedId));
  routedId = '';
  if (previous === undefined) delete process.env.SWITCHBOARD_ROOT;
  else process.env.SWITCHBOARD_ROOT = previous;
  fs.rmSync(temporary, { recursive: true, force: true });
});

// An OpenCode profile with a signed-in pool account, a session and a
// connection snapshot, and a Codex desktop profile routed through its bucket.
function fixture() {
  const profile = profiles.create('Work');
  const directory = profiles.paths(profile.id);
  fs.writeFileSync(path.join(directory.auth, 'codex-a.json'), '{"refresh_token":"fixture"}');
  fs.mkdirSync(path.join(directory.data, 'storage'), { recursive: true });
  fs.writeFileSync(path.join(directory.data, 'storage', 'session.json'), '{}');
  fs.mkdirSync(path.join(directory.runtime, 'identities'), { recursive: true });
  fs.writeFileSync(path.join(directory.runtime, 'identities', 'slack-x.json'), '{}');
  const secrets = profiles.secrets(profile.id);
  routedId = store.withStoreLock(() => {
    const data = store.load();
    const routed = store.create(data, { vendor: 'codex', name: `Routed ${path.basename(temporary)}` });
    store.setProxyBucket(data, routed.id, profile.id);
    return routed.id;
  });
  return { id: profile.id, directory, secrets };
}
const routing = () => store.readStore().profiles.find((p) => p.id === routedId)?.proxyBucket;

test('keeping the bucket deletes the OpenCode profile and leaves its accounts, keys and routing working', async () => {
  const { id, directory, secrets } = fixture();
  const preview = removal.plan(id, 'keep');
  expect(preview.routed.map((p) => p.id)).toEqual([routedId]);
  expect(preview.deletes).toContain(path.join(directory.base, 'data'));
  expect(preview.deletes).not.toContain(path.join(directory.base, 'secrets.json'));
  expect(preview.keeps?.to).toBe(path.join(temporary, 'buckets', id));

  const result = await removal.remove(id, 'keep');

  expect(result.movedTo).toBe(path.join(temporary, 'buckets', id));
  expect(fs.existsSync(directory.base)).toBe(false);
  expect(profiles.list()).toEqual([]);
  expect(bucketStore.withOpenCode(id)).toBe(false);
  expect(bucketStore.list()).toEqual([{ id, name: 'Work' } as never]);
  expect(bucketStore.secrets(id)).toEqual(secrets);
  expect(fs.readFileSync(path.join(bucketStore.paths(id).auth, 'codex-a.json'), 'utf8')).toContain('fixture');
  expect(fs.readdirSync(path.join(temporary, 'buckets'))).toEqual([id]);
  expect(fs.readdirSync(bucketStore.paths(id).runtime)).toEqual([]);
  expect(routing()).toBe(id);
});

test('deleting the bucket too removes its sign-ins and moves routed profiles to their own sign-in', async () => {
  const { id, directory } = fixture();
  const result = await removal.remove(id, 'delete');
  expect(result.unassigned).toEqual([routedId]);
  expect(fs.existsSync(directory.base)).toBe(false);
  expect(bucketStore.list()).toEqual([]);
  expect(routing()).toBeUndefined();
});

test('a process holding a file in the profile keeps the profile and its bucket intact', async () => {
  if (spawnSync('lsof', ['-v']).error) return;
  const { id, directory } = fixture();
  const session = path.join(directory.data, 'storage', 'session.json');
  const holder = spawn('sh', ['-c', 'exec 3<"$1"; echo ready; exec sleep 30', 'sh', session]);
  try {
    await new Promise((resolve) => holder.stdout.once('data', resolve));
    for (const choice of ['keep', 'delete'] as const)
      await expect(removal.remove(id, choice)).rejects.toThrow(`in use by process ${holder.pid}`);
    expect(profiles.load(id).id).toBe(id);
    expect(fs.existsSync(path.join(directory.auth, 'codex-a.json'))).toBe(true);
    expect(routing()).toBe(id);
  } finally {
    holder.kill();
  }
});

test('an interrupted keep is rolled back, unless the removal that left it is still running', async () => {
  const { id, directory, secrets } = fixture();
  // The state a crash between the two renames leaves: the profile hidden,
  // its keys already in the unfinished bucket, and the mover's start lock.
  const hidden = path.join(temporary, 'opencode', `.${id}.removing`);
  const staging = path.join(temporary, 'buckets', `.${id}.removing`);
  fs.renameSync(directory.base, hidden);
  fs.mkdirSync(staging, { recursive: true });
  fs.renameSync(path.join(hidden, 'secrets.json'), path.join(staging, 'secrets.json'));
  const lock = path.join(hidden, 'runtime', 'starting.lock');
  const live = spawn('sleep', ['30']);
  try {
    fs.writeFileSync(lock, String(live.pid));
    await expect(removal.remove(id, 'keep')).rejects.toThrow(`being removed by process ${live.pid}`);
  } finally {
    live.kill();
  }
  const dead = spawnSync('true').pid;
  fs.writeFileSync(lock, String(dead));

  // A dry-run can inspect an interrupted removal without moving files.
  expect(removal.plan(id, 'keep').profile.id).toBe(id);
  expect(fs.existsSync(hidden)).toBe(true);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await main(['remove', id, '--keep-bucket', '--yes']);
  } finally {
    log.mockRestore();
  }
  expect(fs.existsSync(staging)).toBe(false);
  expect(bucketStore.secrets(id)).toEqual(secrets);
});

test('oc remove needs a bucket choice and confirmation, and its dry run changes nothing', async () => {
  const { id, directory } = fixture();
  const output: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((line: string) => void output.push(line));
  const tty = process.stdin.isTTY;
  process.stdin.isTTY = false as never;
  try {
    await expect(main(['remove', id, 'extra', '--keep-bucket', '--yes'])).rejects.toThrow('exactly one profile');
    await expect(main(['remove', id])).rejects.toThrow('exactly one of --keep-bucket or --delete-bucket');
    await expect(main(['remove', id, '--keep-bucket', '--delete-bucket'])).rejects.toThrow('exactly one');
    for (const mode of ['--keep-bucket', '--delete-bucket'])
      await expect(main(['remove', id, mode])).rejects.toThrow('Pass --yes to confirm');
    await main(['remove', id, '--delete-bucket', '--dry-run']);
    expect(JSON.parse(output[0])).toMatchObject({ dryRun: true, bucket: 'delete', deletes: [directory.base] });
    expect(profiles.load(id).id).toBe(id);
    await main(['remove', id, '--keep-bucket', '--yes']);
    expect(JSON.parse(output[1])).toMatchObject({ removed: id, bucket: 'keep' });
    expect(bucketStore.load(id).id).toBe(id);
  } finally {
    log.mockRestore();
    process.stdin.isTTY = tty;
  }
});

test('a native OpenCode launch preparing before it opens any files blocks removal', async () => {
  const profile = profiles.create('Native');
  const bin = path.join(temporary, 'fake-opencode');
  const marker = path.join(temporary, 'preparing');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = debug ]; then
  touch '${marker}'
  sleep 0.8
  printf '%s\\n' "$XDG_DATA_HOME/opencode" "$OPENCODE_CONFIG_DIR" "$OPENCODE_TEST_HOME"
fi
`,
    { mode: 0o700 },
  );
  const before = process.env.SWITCHBOARD_OPENCODE;
  process.env.SWITCHBOARD_OPENCODE = bin;
  const launched = main(['open', profile.id, '--model', 'anthropic/claude-sonnet-4-6']);
  try {
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(marker)).toBe(true);
    for (const choice of ['keep', 'delete'] as const)
      await expect(removal.remove(profile.id, choice)).rejects.toThrow('active launch');
    await expect(buckets.remove(profile.id)).rejects.toThrow('active launch');
    expect(profiles.load(profile.id).id).toBe(profile.id);
  } finally {
    await launched;
    if (before === undefined) delete process.env.SWITCHBOARD_OPENCODE;
    else process.env.SWITCHBOARD_OPENCODE = before;
  }
  await removal.remove(profile.id, 'keep');
  expect(profiles.list()).toEqual([]);
});

test('recovery validates the id before touching any directory', async () => {
  const sentinel = path.join(temporary, 'untouched');
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'original');
  await expect(removal.remove('../untouched', 'keep')).rejects.toThrow();
  expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('original');
});

test('an incomplete lsof scan fails closed even when it exits with no matches', async () => {
  const profile = profiles.create('Unreadable');
  const bin = path.join(temporary, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\necho "cannot stat directory" >&2\nexit 1\n', { mode: 0o700 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    await expect(removal.remove(profile.id, 'keep')).rejects.toThrow('Cannot check which processes');
    expect(profiles.load(profile.id).id).toBe(profile.id);
  } finally {
    process.env.PATH = oldPath;
  }
});

test('removal closes admission before its asynchronous checks, including edits and recreation', async () => {
  const profile = profiles.create('Closing');
  const bin = path.join(temporary, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(temporary, 'checking');
  fs.writeFileSync(
    path.join(bin, 'lsof'),
    `#!/bin/sh
touch '${marker}'
sleep 0.3
exit 1
`,
    { mode: 0o700 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  const removed = removal.remove(profile.id, 'keep');
  try {
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fs.existsSync(marker)).toBe(true);
    await expect(main(['open', profile.id, '--model', 'anthropic/claude-sonnet-4-6'])).rejects.toThrow('being removed');
    expect(() =>
      profiles.update(profile.id, (p) => {
        p.name = 'Changed';
      }),
    ).toThrow('being removed');
    expect(() => profiles.create('Closing')).toThrow('being removed');
  } finally {
    try {
      await removed;
    } finally {
      process.env.PATH = oldPath;
    }
  }
  expect(bucketStore.load(profile.id).name).toBe('Closing');
});

test('retry after the bucket commit finishes cleanup without deleting the kept bucket', async () => {
  const profile = profiles.create('Committed');
  const base = profiles.paths(profile.id).base;
  const hidden = path.join(temporary, 'opencode', '.committed.removing');
  const target = path.join(temporary, 'buckets', profile.id);
  const secrets = profiles.secrets(profile.id);
  fs.renameSync(base, hidden);
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['secrets.json', 'proxy']) fs.renameSync(path.join(hidden, name), path.join(target, name));
  fs.writeFileSync(path.join(target, 'bucket.json'), JSON.stringify({ id: profile.id, name: profile.name }));
  expect(removal.plan(profile.id, 'keep').stopsWorker).toBe(true);
  expect(() => removal.plan(profile.id, 'delete')).toThrow('Finish the interrupted keep');
  const result = await removal.remove(profile.id, 'keep');
  expect(result).toMatchObject({ removed: profile.id, bucket: 'keep', recovered: true });
  expect(fs.existsSync(hidden)).toBe(false);
  expect(bucketStore.secrets(profile.id)).toEqual(secrets);
});
