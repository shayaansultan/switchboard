import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import * as store from '../src/buckets/store';
import * as buckets from '../src/buckets';
import { observe } from '../src/buckets/proxy';
import { run, withoutTty } from './cli-helpers';

const account = { name: 'fixture.json', auth_index: 'fixture', provider: 'claude', email: 'fixture@example.test' };
// What the vendors answer when the fake proxy calls them for an account,
// by the tail of the endpoint's path. Claude's profile can be made to fail.
let profileStatus = 200;
const vendor: Record<string, unknown> = {
  'oauth/usage': { limits: [{ kind: 'weekly_all', percent: 40, resets_at: null }] },
  'oauth/profile': { organization: { rate_limit_tier: 'default_claude_max_20x' } },
  'wham/usage': {
    plan_type: 'prolite',
    rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 604800 } },
  },
};

async function fixture(run: (id: string, actions: string[], port: number) => Promise<void>, failRefresh = false) {
  const previous = process.env.SWITCHBOARD_ROOT;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bucket-management-'));
  process.env.SWITCHBOARD_ROOT = temporary;
  const bucket = store.create('Fixture');
  const receiptFile = path.join(store.paths(bucket.id).runtime, 'worker.json');
  const actions: string[] = [];
  let disabled = false;
  let removed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const receipt = {
    profileId: bucket.id,
    instance: 'fixture-worker',
    controlPort: 0,
    proxyPort: 0,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const status = () => ({
    receipt,
    ready: true,
    accounts: removed
      ? []
      : [
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
      const input = body ? JSON.parse(body) : {};
      // Vendor calls are recorded by resource, field writes by the field.
      const resource =
        request.url === '/v0/management/api-call' ? String(input.url).split('/').slice(-2).join('/') : '';
      actions.push(
        `${request.method} ${request.url}${resource ? ` ${resource}` : input.weight ? ` weight=${input.weight}` : ''}`,
      );
      if (request.url === '/v0/management/auth-files/status') disabled = input.disabled;
      if (request.method === 'DELETE' && request.url === `/v0/management/auth-files?name=${account.name}`)
        removed = true;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify(
          request.url === '/v0/management/auth-files'
            ? { files: removed ? [] : [{ ...account, disabled }] }
            : resource
              ? {
                  status_code: resource === 'oauth/profile' ? profileStatus : 200,
                  body: JSON.stringify(vendor[resource]),
                }
              : status(),
        ),
      );
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    receipt.controlPort = receipt.proxyPort = (server.address() as { port: number }).port;
    store.writeJson(receiptFile, receipt);
    await run(bucket.id, actions, receipt.proxyPort);
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

test('observation names the plan, sizes routing by its capacity and asks Claude for its profile once', async () => {
  await fixture(async (id, actions, port) => {
    const first = await observe(id, port, account);
    expect(first.status).toBe('fresh');
    expect(first.plan).toEqual({ name: 'Max 20x', capacity: 20 });
    expect(first.weight).toBe(1200);
    expect(actions).toEqual([
      'POST /v0/management/api-call oauth/usage',
      'POST /v0/management/api-call oauth/profile',
      'PATCH /v0/management/auth-files/fields weight=1200',
    ]);
    const second = await observe(id, port, { ...account, weight: first.weight }, first);
    expect(second.plan).toEqual(first.plan);
    expect(actions.slice(3)).toEqual(['POST /v0/management/api-call oauth/usage']);
    // Codex reports its plan with usage; there is no profile call, and the
    // $100 Pro is a quarter the size of the $200 one.
    const codex = await observe(id, port, { ...account, name: 'codex.json', provider: 'codex' });
    expect(codex.plan).toEqual({ name: 'Pro 5x', capacity: 5 });
    expect(codex.weight).toBe(300);
    expect(actions.slice(4)).toEqual([
      'POST /v0/management/api-call wham/usage',
      'PATCH /v0/management/auth-files/fields weight=300',
    ]);
  });
});

test('a Claude profile that fails is asked again only while the failure may pass', async () => {
  await fixture(async (id, actions, port) => {
    profileStatus = 429;
    const throttled = await observe(id, port, account);
    expect(throttled.plan).toBeUndefined();
    expect(throttled.weight).toBe(60);
    profileStatus = 500;
    const refused = await observe(id, port, { ...account, weight: throttled.weight }, throttled);
    expect(refused.plan).toBeNull();
    const settled = await observe(id, port, { ...account, weight: refused.weight }, refused);
    expect(settled.plan).toBeNull();
    expect(actions.filter((action) => action.endsWith('oauth/profile'))).toHaveLength(2);
    profileStatus = 200;
  });
});

test('removing an account deletes only a member of the pool, through the proxy', async () => {
  await fixture(async (id, actions) => {
    await expect(buckets.removeAccount(id, 'unknown.json')).rejects.toThrow('not in this bucket');
    expect(actions.some((action) => action.startsWith('DELETE'))).toBe(false);
    await buckets.removeAccount(id, 'fixture.json');
    expect(actions).toContain('DELETE /v0/management/auth-files?name=fixture.json');
    expect((await buckets.snapshot())[0].accounts).toEqual([]);
  });
});

test('bucket remove-account resolves the account by email and needs --yes', async () => {
  await fixture(async (id, actions) => {
    expect((await run('bucket', 'remove-account', id, 'nobody@example.test', '--yes')).failure().error).toBe(
      'no-such-account',
    );
    const unconfirmed = await withoutTty(() => run('bucket', 'remove-account', id, account.email));
    expect(unconfirmed.failure().error).toBe('confirmation-required');
    expect(actions.some((action) => action.startsWith('DELETE'))).toBe(false);
    const removed = await run('bucket', 'remove-account', id, account.email, '--yes');
    expect(removed.code).toBe(0);
    expect(removed.json()).toMatchObject({ id, status: 'running', accounts: [] });
    expect(actions).toContain('DELETE /v0/management/auth-files?name=fixture.json');
  });
});

test('removing a bucket stops its worker before deleting its directory', async () => {
  await fixture(async (id, actions) => {
    const base = store.paths(id).base;
    await buckets.remove(id);
    expect(actions).toContain('POST /stop');
    expect(fs.existsSync(base)).toBe(false);
    expect(await buckets.snapshot()).toEqual([]);
  });
});

test('removal holds the start lock, and a failure before the delete keeps the bucket', async () => {
  await fixture(async (id) => {
    const lock = path.join(store.paths(id).runtime, 'starting.lock');
    await expect(
      buckets.remove(id, () => {
        expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
        throw new Error('store refused');
      }),
    ).rejects.toThrow('store refused');
    expect(fs.existsSync(store.paths(id).base)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    // A start in progress by a live process blocks removal until it is done.
    fs.writeFileSync(lock, String(process.pid));
    await expect(buckets.remove(id)).rejects.toThrow('is starting');
    fs.rmSync(lock);
  });
});

test('an unreachable worker keeps its bucket', async () => {
  await fixture(async (id, _actions, port) => {
    const receipt = path.join(store.paths(id).runtime, 'worker.json');
    store.writeJson(receipt, { ...(store.readJson(receipt) as object), controlPort: port + 1 });
    await expect(buckets.remove(id)).rejects.toThrow('unreachable');
    expect(fs.existsSync(store.paths(id).base)).toBe(true);
  });
});

test('a bucket stored with an OpenCode profile is removed with it', () => {
  const previous = process.env.SWITCHBOARD_ROOT;
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-bucket-remove-'));
  process.env.SWITCHBOARD_ROOT = temporary;
  try {
    const base = path.join(temporary, 'opencode', 'legacy');
    fs.mkdirSync(path.join(base, 'data'), { recursive: true });
    store.writeJson(path.join(base, 'profile.json'), { id: 'legacy', name: 'Legacy' });
    const plain = store.create('Plain');
    expect(store.withOpenCode('legacy')).toBe(true);
    expect(store.withOpenCode(plain.id)).toBe(false);
    store.remove('legacy');
    expect(fs.existsSync(base)).toBe(false);
    expect(store.list().map((b) => b.id)).toEqual(['plain']);
  } finally {
    if (previous === undefined) delete process.env.SWITCHBOARD_ROOT;
    else process.env.SWITCHBOARD_ROOT = previous;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
