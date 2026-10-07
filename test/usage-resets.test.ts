// Provider-boundary tests: grant eligibility, account pinning and retry safety.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as usage from '../src/usage';
import * as launch from '../src/launch';
import { prepareUsageReset } from '../src/usage-resets';
import { ROOT } from '../src/store';
import type { Profile } from '../src/types';

const profile = (vendor: 'claude' | 'codex'): Profile => ({
  id: `${vendor}-default`,
  vendor,
  name: 'Default',
  isDefault: true,
  color: '#000',
});
let requests: { url: string; body?: Record<string, unknown> }[];
let handle: (url: string, body?: Record<string, unknown>) => unknown;
let token = 'test-token';
let grant = {
  id: 'launch-grant',
  label: 'Full reset',
  resets_left: 1,
  usable_now: true,
  paused: false,
  ends_at: '2099-01-01T00:00:00Z',
  clears: ['five_hour', 'seven_day'],
};
let credit = {
  id: 'credit-one',
  title: 'Full reset',
  status: 'available',
  reset_type: 'codex_rate_limits',
  is_supported_by_plan: true,
  expires_at: '2099-01-01T00:00:00Z',
};
const mocks: { mockRestore(): void }[] = [];
beforeEach(() => {
  requests = [];
  token = 'test-token';
  grant = { ...grant, usable_now: true, paused: false, resets_left: 1 };
  credit = { ...credit, status: 'available', is_supported_by_plan: true };
  fs.rmSync(path.join(ROOT, 'usage-reset-attempts.json'), { force: true });
  mocks.push(
    spyOn(usage, 'claudeToken').mockImplementation(async () => ({
      token,
      expiresAt: null,
      subscriptionType: null,
      rateLimitTier: null,
    })),
  );
  mocks.push(
    spyOn(usage, 'codexAuth').mockImplementation(() => ({
      token,
      mode: 'chatgpt',
      accountId: 'test-account',
      email: 'test@example.com',
      plan: 'Pro',
    })),
  );
  mocks.push(spyOn(launch, 'run').mockResolvedValue({ stdout: '2.1.285 (Claude Code)', stderr: '' }));
  handle = (url, body) => {
    if (body) return url.endsWith('/consume') ? { code: 'reset' } : { result: 'reset' };
    if (url.endsWith('/profile'))
      return {
        account: { email: 'test@example.com', uuid: '00000000-0000-4000-8000-000000000001' },
        organization: { uuid: '00000000-0000-4000-8000-000000000002' },
      };
    if (url.includes('cedar_ember'))
      return { cedar_ember: { eligible: true, next_grant_id: grant.id, grants: [grant] } };
    return { credits: [credit] };
  };
  mocks.push(
    spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      const url = String(input);
      const body = options?.body ? JSON.parse(String(options.body)) : undefined;
      requests.push({ url, body });
      return Response.json(handle(url, body));
    }),
  );
});
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore();
});

for (const vendor of ['claude', 'codex'] as const) {
  test(`${vendor}: inspecting grants never redeems; redemption names the selected grant`, async () => {
    const session = await prepareUsageReset(profile(vendor));
    expect(session.offers).toHaveLength(1);
    expect(requests.every((r) => !r.body)).toBe(true);
    expect(await session.redeem(session.offers[0]!.id)).toContain('confirmed');
    const posts = requests.filter((r) => r.body);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject(
      vendor === 'claude' ? { program: 'cedar_ember', grant_id: 'launch-grant' } : { credit_id: 'credit-one' },
    );
  });
  test(`${vendor}: account changes between display and confirmation prevent redemption`, async () => {
    const session = await prepareUsageReset(profile(vendor));
    token = 'different-account';
    await expect(session.redeem(session.offers[0]!.id)).rejects.toThrow('sign-in changed');
    expect(requests.every((r) => !r.body)).toBe(true);
  });
  test(`${vendor}: rechecks eligibility before any write`, async () => {
    const session = await prepareUsageReset(profile(vendor));
    grant.usable_now = false;
    credit.status = 'redeemed';
    await expect(session.redeem(session.offers[0]!.id)).rejects.toThrow('no longer usable');
    expect(requests.every((r) => !r.body)).toBe(true);
  });
  test(`${vendor}: uncertain replies preserve the request ID when the dialog is reopened`, async () => {
    const original = handle;
    handle = (url, body) => {
      if (body) throw new Error('connection lost after sending');
      return original(url, body);
    };
    for (let i = 0; i < 2; i++) {
      const session = await prepareUsageReset(profile(vendor));
      await expect(session.redeem(session.offers[0]!.id)).rejects.toThrow('result was not confirmed');
    }
    const posts = requests.filter((r) => r.body);
    const key = vendor === 'claude' ? 'request_id' : 'redeem_request_id';
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body![key]).toBe(posts[1]!.body![key]);
    expect(
      JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'usage-reset-attempts.json'), 'utf8'))),
    ).not.toContain('test-account');
  });
}
test('Claude respects the provider-selected next grant and paused status', async () => {
  grant.paused = true;
  const session = await prepareUsageReset(profile('claude'));
  expect(session.offers[0]!.usable).toBe(false);
  await expect(session.redeem('other-grant')).rejects.toThrow('no longer usable');
  expect(requests.every((r) => !r.body)).toBe(true);
});
test('unknown response shapes fail closed rather than reporting no grants', async () => {
  handle = () => ({ unexpected: true });
  await expect(prepareUsageReset(profile('codex'))).rejects.toThrow();
  expect(requests.every((r) => !r.body)).toBe(true);
});

test('Claude gives the next spend of a multi-use grant a new request ID after a lost reply', async () => {
  grant.resets_left = 2;
  const original = handle;
  handle = (url, body) => {
    if (body) throw new Error('reply lost');
    return original(url, body);
  };
  const first = await prepareUsageReset(profile('claude'));
  await expect(first.redeem('launch-grant')).rejects.toThrow('result was not confirmed');
  grant.resets_left = 1;
  grant.usable_now = false;
  await expect(first.redeem('launch-grant')).rejects.toThrow('no longer usable');
  grant.usable_now = true;
  handle = original;
  const next = await prepareUsageReset(profile('claude'));
  expect(await next.redeem('launch-grant')).toContain('confirmed');
  const posts = requests.filter((r) => r.body);
  expect(posts).toHaveLength(2);
  expect(posts[1]!.body!.request_id).not.toBe(posts[0]!.body!.request_id);
});

test('Claude unavailable is not called success and preserves the ID while the spend remains uncertain', async () => {
  const original = handle;
  handle = (url, body) => (body ? { result: 'unavailable', reason: 'reset_unconfirmed' } : original(url, body));
  for (let i = 0; i < 2; i++) {
    const session = await prepareUsageReset(profile('claude'));
    expect(await session.redeem('launch-grant')).toContain('could not confirm');
  }
  const posts = requests.filter((r) => r.body);
  expect(posts[0]!.body!.request_id).toBe(posts[1]!.body!.request_id);
});

test('Claude discards a completed pending spend when a fresh read sees a lower balance, even during cooldown', async () => {
  grant.resets_left = 2;
  const original = handle;
  handle = (url, body) => {
    if (body) throw new Error('reply lost');
    return original(url, body);
  };
  const first = await prepareUsageReset(profile('claude'));
  await expect(first.redeem('launch-grant')).rejects.toThrow('result was not confirmed');
  grant.resets_left = 1;
  grant.usable_now = false;
  await prepareUsageReset(profile('claude'));
  grant.resets_left = 2;
  grant.usable_now = true;
  handle = original;
  const toppedUp = await prepareUsageReset(profile('claude'));
  expect(await toppedUp.redeem('launch-grant')).toContain('confirmed');
  const posts = requests.filter((r) => r.body);
  expect(posts[1]!.body!.request_id).not.toBe(posts[0]!.body!.request_id);
});
