// Run the real bucket worker against an offline proxy fixture. Verify that a
// reset bypasses only its account's usage-probe backoff and updates routing.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-reset-worker-'));
const oldRoot = process.env.SWITCHBOARD_ROOT;
const oldBinary = process.env.SWITCHBOARD_PROXY_BINARY;
process.env.SWITCHBOARD_ROOT = temporary;
const binary = path.join(temporary, 'proxy-fixture');
process.env.SWITCHBOARD_PROXY_BINARY = binary;
await fs.writeFile(
  binary,
  `#!/usr/bin/env bun
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('-config') + 1], 'utf8'));
const root = process.env.SWITCHBOARD_ROOT;
const calls = { one: 0, two: 0, profile: 0 };
const accounts = ['one', 'two'].map(name => ({ name: name + '.json', auth_index: name, provider: 'claude', account_id: name, weight: 50 }));
Bun.serve({ hostname: '127.0.0.1', port: config.port, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname.endsWith('/auth-files')) return Response.json({ files: accounts });
  const body = await req.json();
  if (url.pathname.endsWith('/api-call')) {
    if (body.url.endsWith('/profile')) {
      calls.profile++;
      fs.writeFileSync(root + '/calls.json', JSON.stringify(calls));
      return Response.json({ status_code: calls.profile === 1 ? 200 : 503, body: JSON.stringify({ organization: { rate_limit_tier: 'default_claude_max_20x' } }) });
    }
    calls[body.auth_index]++;
    fs.writeFileSync(root + '/calls.json', JSON.stringify(calls));
    const healthy = fs.existsSync(root + '/healthy');
    return Response.json({ status_code: healthy ? 200 : 429, body: JSON.stringify({ five_hour: { utilization: 0, resets_at: null } }) });
  }
  if (url.pathname.endsWith('/auth-files/fields')) {
    accounts.find(account => account.name === body.name).weight = body.weight;
    return Response.json({ status: 'ok' });
  }
  return new Response('', { status: 404 });
}});
`,
  { mode: 0o700 },
);
const store = await import('../out/buckets/store.js');
const proxy = await import('../out/buckets/proxy.js');
const bucket = store.create('Offline reset test');
try {
  await proxy.ensureWorker(bucket.id, { execPath: process.execPath, script: path.join(root, 'out/buckets/cli.js') });
  const before = await proxy.control(bucket.id, 'refresh');
  assert.equal(before.accounts.length, 2);
  assert.ok(before.accounts.every((account) => account.status === 'cooldown'));
  await fs.writeFile(path.join(temporary, 'healthy'), '');
  await proxy.control(bucket.id, 'refresh');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, 'calls.json'), 'utf8')), {
    one: 1,
    two: 1,
    profile: 0,
  });
  const after = await proxy.control(bucket.id, 'refresh-account', 'one.json');
  assert.equal(after.accounts.find((account) => account.name === 'one.json').status, 'fresh');
  assert.equal(after.accounts.find((account) => account.name === 'one.json').weight, 2000);
  assert.equal(after.accounts.find((account) => account.name === 'two.json').status, 'cooldown');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, 'calls.json'), 'utf8')), {
    one: 2,
    two: 1,
    profile: 1,
  });
  const again = await proxy.control(bucket.id, 'refresh-account', 'one.json');
  assert.equal(again.accounts.find((account) => account.name === 'one.json').weight, 2000);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(temporary, 'calls.json'), 'utf8')), {
    one: 3,
    two: 1,
    profile: 1,
  });
  console.log(
    'PASS: real worker refreshes the reset account and its routing weight while preserving the other account’s cooldown.',
  );
} finally {
  await proxy.control(bucket.id, 'stop').catch(() => {});
  for (let i = 0; i < 60 && proxy.receipt(bucket.id); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(proxy.receipt(bucket.id), undefined, 'Test worker must be stopped before cleanup');
  if (oldRoot === undefined) delete process.env.SWITCHBOARD_ROOT;
  else process.env.SWITCHBOARD_ROOT = oldRoot;
  if (oldBinary === undefined) delete process.env.SWITCHBOARD_PROXY_BINARY;
  else process.env.SWITCHBOARD_PROXY_BINARY = oldBinary;
  await fs.rm(temporary, { recursive: true, force: true });
}
