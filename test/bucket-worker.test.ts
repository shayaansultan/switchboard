import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as buckets from '../src/buckets/store';
import { control, ensureWorker, quotaWeight } from '../src/buckets/proxy';
import type { Command } from '../src/buckets/runtime';
import { acquireWorkerLease } from '../src/buckets/worker-lease';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bucket-worker-'));
const originalRoot = process.env.SWITCHBOARD_ROOT;
process.env.SWITCHBOARD_ROOT = temporary;

afterAll(() => {
  if (originalRoot === undefined) delete process.env.SWITCHBOARD_ROOT;
  else process.env.SWITCHBOARD_ROOT = originalRoot;
  fs.rmSync(temporary, { recursive: true, force: true });
});

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return address.port;
}

test('worker ownership lasts until release and cannot remove another owner', () => {
  const file = path.join(temporary, 'worker-lease');
  const release = acquireWorkerLease(file);
  expect(() => acquireWorkerLease(file)).toThrow();
  release();
  const nextRelease = acquireWorkerLease(file);
  release();
  expect(fs.existsSync(file)).toBe(true);
  nextRelease();
  expect(fs.existsSync(file)).toBe(false);
});

// These cases fail before a worker would start, so this one never runs.
const UNUSED_WORKER: Command = { execPath: '/unused-cli', script: '/unused-worker.js' };

test('an unreachable live worker is not replaced', async () => {
  const bucket = buckets.create('Unreachable worker');
  buckets.writeJson(path.join(buckets.paths(bucket.id).runtime, 'worker.json'), {
    profileId: bucket.id,
    instance: 'existing-worker',
    controlPort: 1,
    proxyPort: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  await expect(ensureWorker(bucket.id, UNUSED_WORKER)).rejects.toThrow('alive but unreachable');
  expect(fs.existsSync(path.join(buckets.paths(bucket.id).proxy, 'config.yaml'))).toBe(false);
});

test('a listener on an old proxy port blocks stale worker recovery', async () => {
  const bucket = buckets.create('Orphan proxy');
  const server = http.createServer((_request, response) => response.writeHead(200).end());
  const port = await listen(server);
  const runtime = buckets.paths(bucket.id).runtime;
  buckets.writeJson(path.join(runtime, 'worker.json'), {
    profileId: bucket.id,
    instance: 'old-worker',
    controlPort: 1,
    proxyPort: port,
    pid: 99999999,
    startedAt: new Date().toISOString(),
  });
  buckets.writeJson(path.join(runtime, 'worker.lock'), { pid: 99999999, instance: 'old-lease' });
  try {
    await expect(ensureWorker(bucket.id, UNUSED_WORKER)).rejects.toThrow('listener on an old worker port');
    expect(fs.existsSync(path.join(runtime, 'worker.json'))).toBe(true);
    expect(fs.existsSync(path.join(runtime, 'worker.lock'))).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('worker control failures are not reported as a stopped worker', async () => {
  const bucket = buckets.create('Control errors');
  const server = http.createServer((_request, response) => response.writeHead(401).end());
  const port = await listen(server);
  buckets.writeJson(path.join(buckets.paths(bucket.id).runtime, 'worker.json'), {
    profileId: bucket.id,
    instance: 'fixture',
    controlPort: port,
    proxyPort: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  try {
    await expect(control(bucket.id, 'status')).rejects.toThrow('HTTP 401');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('quota weights use the tightest observed window, never evicting healthy sticky sessions', () => {
  expect(quotaWeight([])).toBe(50);
  expect(
    quotaWeight([
      { label: '5h', pct: 20, resetsAt: null },
      { label: '7d', pct: 90, resetsAt: null },
    ]),
  ).toBe(10);
  expect(quotaWeight([{ label: '7d', pct: 100, resetsAt: null }])).toBe(1);
  expect(quotaWeight([{ label: 'unknown', pct: null, resetsAt: null }])).toBe(50);
});

test('quota weights scale with plan capacity, so a large plan is favoured at equal headroom', () => {
  const half = [{ label: '7d', pct: 50, resetsAt: null }];
  expect(quotaWeight(half, 20)).toBe(1000);
  expect(quotaWeight(half, 5)).toBe(250);
  expect(quotaWeight(half, undefined)).toBe(50);
  expect(quotaWeight([{ label: '7d', pct: 100, resetsAt: null }], 20)).toBe(1);
});
