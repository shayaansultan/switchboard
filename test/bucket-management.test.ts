import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as store from '../src/buckets/store';
import * as buckets from '../src/buckets';

async function fixture(run: (id: string, actions: string[]) => Promise<void>, failRefresh = false) {
  const previous = process.env.SWITCHBOARD_ROOT;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bucket-management-'));
  process.env.SWITCHBOARD_ROOT = temporary;
  const bucket = store.create('Fixture');
  const receiptFile = path.join(store.paths(bucket.id).runtime, 'worker.json');
  const actions: string[] = [];
  let disabled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const receipt = {
    profileId: bucket.id,
    instance: 'fixture-worker',
    controlPort: 0,
    proxyPort: 0,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const account = { name: 'fixture.json', auth_index: 'fixture', provider: 'claude', email: 'fixture@example.test' };
  const status = () => ({
    receipt,
    ready: true,
    accounts: [
      {
        name: account.name,
        email: account.email,
        provider: 'claude',
        status: disabled ? 'disabled' : 'fresh',
        windows: [],
        weight: 50,
      },
    ],
  });
  const server = http.createServer((request, response) => {
    actions.push(`${request.method} ${request.url}`);
    if (request.headers.authorization !== `Bearer ${store.secrets(bucket.id).managementKey}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === '/refresh' && failRefresh) {
      response.destroy();
      return;
    }
    if (request.url === '/stop') timer = setTimeout(() => fs.rmSync(receiptFile, { force: true }), 150);
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      if (request.url === '/v0/management/auth-files/status') disabled = JSON.parse(body).disabled;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(request.url === '/v0/management/auth-files' ? { files: [{ ...account, disabled }] } : status()),
      );
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    receipt.controlPort = receipt.proxyPort = (server.address() as { port: number }).port;
    store.writeJson(receiptFile, receipt);
    await run(bucket.id, actions);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.SWITCHBOARD_ROOT;
    else process.env.SWITCHBOARD_ROOT = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

test('Stop waits for worker shutdown before reporting the bucket stopped', async () => {
  await fixture(async (id) => {
    await buckets.stop(id);
    expect((await buckets.snapshot())[0].status).toBe('stopped');
  });
});

test('Start does not report success when its initial account refresh loses the worker', async () => {
  await fixture(async (id) => {
    await expect(buckets.start(id)).rejects.toThrow();
  }, true);
});

test('account management validates membership and refreshes the confirmed provider state', async () => {
  await fixture(async (id, actions) => {
    await expect(buckets.setAccountEnabled(id, 'unknown.json', false)).rejects.toThrow('not in this bucket');
    expect(actions).not.toContain('PATCH /v0/management/auth-files/status');
    await buckets.setAccountEnabled(id, 'fixture.json', false);
    expect((await buckets.snapshot())[0].accounts[0].status).toBe('disabled');
    await buckets.setAccountEnabled(id, 'fixture.json', true);
    expect((await buckets.snapshot())[0].accounts[0].status).toBe('fresh');
    expect(actions.filter((action) => action === 'PATCH /v0/management/auth-files/status')).toHaveLength(2);
  });
});
