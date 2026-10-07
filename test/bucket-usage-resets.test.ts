// Verify the proxy account boundary, including post-reset routing recovery.
import { run as cli, withoutTty } from './cli-helpers';
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { create, paths } from '../src/buckets/store';
import { writeJson } from '../src/storage';
import { prepareBucketUsageReset } from '../src/buckets/usage-resets';
import * as launch from '../src/launch';
import * as usage from '../src/usage';

let bucket: ReturnType<typeof create>;
let worker: {
  supportsAccountRefresh: boolean;
  receipt: {
    profileId: string;
    instance: string;
    proxyPort: number;
    controlPort: number;
    pid: number;
    startedAt: string;
  };
  ready: boolean;
  accounts: unknown[];
};
let account: {
  name: string;
  auth_index: string;
  provider: string;
  email: string;
  account_id: string;
  disabled: boolean;
};
let requests: { path: string; body?: any }[];
let outcome: string;
let failRecovery: boolean;
let refreshStatus: 'fresh' | 'cooldown';
const mocks: { mockRestore(): void }[] = [];
beforeEach(() => {
  bucket = create(`Reset bucket ${crypto.randomUUID()}`);
  worker = {
    supportsAccountRefresh: true,
    receipt: {
      profileId: bucket.id,
      instance: 'original-worker',
      proxyPort: 18701,
      controlPort: 18702,
      pid: 123,
      startedAt: new Date().toISOString(),
    },
    ready: true,
    accounts: [],
  };
  writeJson(paths(bucket.id).runtime + '/worker.json', worker.receipt);
  account = {
    name: 'selected.json',
    auth_index: 'selected-index',
    provider: 'codex',
    email: 'bucket@example.com',
    account_id: 'bucket-account',
    disabled: false,
  };
  requests = [];
  outcome = 'reset';
  failRecovery = false;
  refreshStatus = 'fresh';
  mocks.push(
    spyOn(usage, 'codexAuth').mockImplementation(() => {
      throw new Error('Must not use a native sign-in');
    }),
  );
  mocks.push(
    spyOn(usage, 'claudeToken').mockImplementation(async () => {
      throw new Error('Must not use a native sign-in');
    }),
  );
  mocks.push(spyOn(launch, 'run').mockResolvedValue({ stdout: '2.1.285', stderr: '' }));
  mocks.push(
    spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
      const route = new URL(String(url));
      expect(route.hostname).toBe('127.0.0.1');
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ path: route.pathname + route.search, body });
      if (route.pathname === '/status') return Response.json(worker);
      if (route.pathname === '/refresh-account')
        return Response.json({
          ...worker,
          accounts: [
            { name: account.name, provider: account.provider, status: refreshStatus, windows: [], weight: 100 },
          ],
        });
      if (route.pathname.endsWith('/auth-files'))
        return Response.json({
          files: [account, { ...account, name: 'other.json', auth_index: 'other-index', email: 'other@example.com' }],
        });
      if (route.pathname.endsWith('/reset-quota'))
        return failRecovery
          ? new Response('', { status: 503 })
          : Response.json({ status: 'ok', auth_index: account.auth_index });
      expect(route.pathname).toBe('/v0/management/api-call');
      expect(body.auth_index).toBe('selected-index');
      expect(body.header.Authorization).toBe('Bearer $TOKEN$');
      let result: unknown;
      if (body.method === 'POST') result = account.provider === 'claude' ? { result: outcome } : { code: outcome };
      else if (body.url.endsWith('/profile'))
        result = {
          account: { email: account.email, uuid: '00000000-0000-4000-8000-000000000001' },
          organization: { uuid: '00000000-0000-4000-8000-000000000002' },
        };
      else if (body.url.includes('cedar_ember'))
        result = {
          cedar_ember: {
            eligible: true,
            next_grant_id: 'launch-grant',
            grants: [
              {
                id: 'launch-grant',
                label: 'Full reset',
                resets_left: 1,
                usable_now: true,
                paused: false,
                ends_at: '2099-01-01T00:00:00Z',
                clears: ['five_hour'],
              },
            ],
          },
        };
      else
        result = {
          credits: [
            {
              id: 'credit-one',
              title: 'Full reset',
              reset_type: 'codex_rate_limits',
              status: 'available',
              is_supported_by_plan: true,
            },
          ],
        };
      return Response.json({ status_code: 200, body: JSON.stringify(result) });
    }),
  );
});
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});
for (const vendor of ['claude', 'codex']) {
  test(`${vendor}: confirmed bucket redemption targets one proxy sign-in and then clears its cooldown`, async () => {
    account.provider = vendor;
    const session = await prepareBucketUsageReset(bucket.id, account.name);
    expect(requests.some((r) => r.body?.method === 'POST' || r.path.endsWith('reset-quota'))).toBe(false);
    const result = await session.redeem(session.offers[0]!.id);
    expect(result.message).toContain('proxy cooldown was cleared');
    const writes = requests.filter(
      (r) => r.body?.method === 'POST' || r.path.endsWith('reset-quota') || r.path.startsWith('/refresh-account'),
    );
    expect(writes.map((r) => r.path)).toEqual([
      '/v0/management/api-call',
      '/v0/management/reset-quota',
      '/refresh-account?name=selected.json',
    ]);
    expect(writes[1]!.body).toEqual({ auth_index: 'selected-index' });
    expect(JSON.parse(writes[0]!.body.data)).toMatchObject(
      vendor === 'claude' ? { grant_id: 'launch-grant' } : { credit_id: 'credit-one' },
    );
  });
}
test('replaced bucket sign-in cannot redeem the previously displayed credit', async () => {
  const session = await prepareBucketUsageReset(bucket.id, account.name);
  account.account_id = 'replacement-account';
  await expect(session.redeem('credit-one')).rejects.toThrow('account changed');
  expect(requests.some((r) => r.body?.method === 'POST')).toBe(false);
});
test('worker replacement invalidates a prepared reset', async () => {
  const session = await prepareBucketUsageReset(bucket.id, account.name);
  worker.receipt.instance = 'replacement-worker';
  await expect(session.redeem('credit-one')).rejects.toThrow('identity mismatch');
  expect(requests.some((r) => r.body?.method === 'POST')).toBe(false);
});
test('no-credit outcome never clears local proxy limits', async () => {
  outcome = 'no_credit';
  const session = await prepareBucketUsageReset(bucket.id, account.name);
  expect((await session.redeem('credit-one')).message).toContain('no reset credit');
  expect(requests.some((r) => r.path.endsWith('reset-quota'))).toBe(false);
});
test('proxy recovery failure reports the vendor success separately and does not redeem again', async () => {
  failRecovery = true;
  const session = await prepareBucketUsageReset(bucket.id, account.name);
  expect((await session.redeem('credit-one')).message).toContain('vendor reset succeeded, but proxy recovery');
  expect(requests.filter((r) => r.body?.method === 'POST')).toHaveLength(1);
});

test('older workers may show grants but cannot redeem until targeted refresh is supported', async () => {
  worker.supportsAccountRefresh = false;
  const session = await prepareBucketUsageReset(bucket.id, account.name);
  expect(session.offers[0]!.usable).toBe(false);
  expect(session.note).toContain('Restart this bucket');
  await expect(session.redeem('credit-one')).rejects.toThrow('Restart this bucket');
  expect(requests.some((r) => r.body?.method === 'POST')).toBe(false);
});

test('a rate-limited recheck reports the confirmed cooldown clear without implying a failed reset', async () => {
  refreshStatus = 'cooldown';
  const session = await prepareBucketUsageReset(bucket.id, account.name);
  const result = await session.redeem('credit-one');
  expect(result.message).toContain('proxy cooldown was cleared');
  expect(result.message).toContain('refresh later');
  expect(result.message).not.toContain('recovery could not be confirmed');
  expect(requests.filter((r) => r.body?.method === 'POST')).toHaveLength(1);
});

for (const vendor of ['claude', 'codex']) {
  test(vendor + ': bucket reset CLI resolves the account and requires confirmation', async () => {
    account.provider = vendor;
    const args = ['bucket', 'resets', bucket.id, account.email];
    const listed = await cli(...args);
    expect(listed.code).toBe(0);
    const { offers } = listed.json<{ offers: { id: string }[] }>();
    expect(listed.json()).toMatchObject({ target: { kind: 'bucket', accountName: account.name } });
    const denied = await withoutTty(() => cli(...args, '--redeem', offers[0]!.id));
    expect(denied.failure().error).toBe('confirmation-required');
    expect(requests.some((r) => r.body?.method === 'POST')).toBe(false);
    expect((await cli(...args, '--redeem', offers[0]!.id, '--yes')).code).toBe(0);
    expect(requests.filter((r) => r.body?.method === 'POST')).toHaveLength(1);
    expect(requests.some((r) => r.path.startsWith('/refresh-account'))).toBe(true);
  });
}

test('CLI reports a non-reset vendor outcome without prose parsing', async () => {
  outcome = 'no_credit';
  const result = await cli(
    'bucket',
    'resets',
    bucket.id,
    account.email.toUpperCase(),
    '--redeem',
    'credit-one',
    '--yes',
  );
  expect(result.code).toBe(0);
  expect(result.json()).toMatchObject({ outcome: 'no_credit', proxyRecovery: 'not-needed' });
  expect(requests.some((r) => r.path.endsWith('reset-quota'))).toBe(false);
});
