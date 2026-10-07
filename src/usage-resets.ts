// On-demand reset grants for native profiles and proxy accounts. Credentials
// stay with the profile reader or proxy; a prepared offer pins the account and grant until
// confirmation. These vendor endpoints are private and must fail closed.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { dirs, withStoreLock } from './store';
import { root, readJson, writeJson } from './storage';
import { claudeToken, codexAuth } from './usage';
import { run } from './launch';
import type { Profile, Vendor } from './types';

const date = z.string().refine((s) => Number.isFinite(Date.parse(s)));
const ClaudeStatus = z.object({
  eligible: z.boolean(),
  ineligible_reason: z.string().nullish(),
  next_grant_id: z.string().nullable(),
  grants: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
      label: z.string(),
      resets_left: z.number().int().nonnegative(),
      ends_at: date.nullish(),
      usable_now: z.boolean(),
      paused: z.boolean(),
      clears: z.array(z.string()),
    }),
  ),
});
const CodexCredits = z.object({
  credits: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().nullish(),
      reset_type: z.string(),
      status: z.string(),
      is_supported_by_plan: z.boolean(),
      expires_at: date.nullish(),
    }),
  ),
});

export interface ResetOffer {
  id: string;
  title: string;
  detail: string;
  usable: boolean;
}
export interface ResetSession {
  account: string;
  offers: ResetOffer[];
  note: string;
  redeem(id: string): Promise<string>;
}

async function json(url: string, headers: Record<string, string>, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      `Reset API returned HTTP ${response.status}. Check the account in the vendor app before trying again.`,
    );
  return response.json();
}
async function submitReset<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch {
    throw new Error(
      'The reset request may have reached the vendor, but its result was not confirmed. Check the vendor Usage page before trying again. Switchboard keeps the pending request ID for an unchanged grant.',
    );
  }
}
const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
const expiry = (value?: string | null) =>
  value ? `Expires ${new Date(value).toLocaleString()}.` : 'No expiry reported.';
const unexpired = (value?: string | null) => !value || Date.parse(value) > Date.now();

// Persist one pending spend per grant before sending. Fresh provider state
// invalidates it when the balance or expiry changes, even during a cooldown.
// Keys contain only account/grant hashes; unknown writes never auto-retry.
function pendingAttempt(key: string, generation: string, action: 'observe' | 'send' | 'complete'): string {
  return withStoreLock(() => {
    const file = path.join(root(), 'usage-reset-attempts.json');
    const schema = z.record(z.string(), z.object({ id: z.string().uuid(), generation: z.string() }));
    const entries = existsSync(file) ? schema.parse(readJson(file)) : {};
    const hash = fingerprint(key);
    const old = entries[hash];
    if (old && (old.generation !== generation || action === 'complete')) delete entries[hash];
    if (action === 'send' && !entries[hash]) entries[hash] = { id: randomUUID(), generation };
    if (old !== entries[hash]) writeJson(file, entries);
    return entries[hash]?.id ?? '';
  });
}

// One provider protocol works with either native credentials or a proxy-owned
// sign-in. This interface stays in the main process, never in the preload API.
export interface ResetAccount {
  vendor: Vendor;
  email: string;
  accountId?: string;
  request(url: string, headers: Record<string, string>, body?: unknown): Promise<unknown>;
  validate(): Promise<void>;
  afterReset?(): Promise<string>;
}

export async function prepareUsageReset(profile: Profile): Promise<ResetSession> {
  const home = dirs(profile).home;
  if (profile.vendor === 'claude') {
    const credential = await claudeToken(home);
    if (!credential || (credential.expiresAt && credential.expiresAt <= Date.now()))
      throw new Error('Refresh usage or sign in to this Claude profile before checking resets.');
    return prepareAccountReset({
      vendor: 'claude',
      email: profile.name,
      request: (url, headers, body) => json(url, { ...headers, Authorization: `Bearer ${credential.token}` }, body),
      async validate() {
        if ((await claudeToken(home))?.token !== credential.token)
          throw new Error('The account sign-in changed. Reopen Usage resets before continuing.');
      },
    });
  }
  const auth = codexAuth(home);
  if (!auth?.token || !auth.accountId) throw new Error('Sign in to this Codex profile with a ChatGPT account first.');
  const stamp = fingerprint(`${auth.accountId}:${auth.token}`);
  return prepareAccountReset({
    vendor: 'codex',
    accountId: auth.accountId,
    email: auth.email ?? profile.name,
    request: (url, headers, body) => json(url, { ...headers, Authorization: `Bearer ${auth.token}` }, body),
    async validate() {
      const current = codexAuth(home);
      if (!current || fingerprint(`${current.accountId}:${current.token}`) !== stamp)
        throw new Error('The account sign-in changed. Reopen Usage resets before continuing.');
    },
  });
}

export async function prepareAccountReset(connection: ResetAccount): Promise<ResetSession> {
  const request = connection.request;
  const afterReset = async () => {
    try {
      return connection.afterReset ? await connection.afterReset() : '';
    } catch {
      return ' The vendor reset succeeded, but proxy recovery could not be confirmed. Refresh the bucket before spending another reset.';
    }
  };
  if (connection.vendor === 'claude') {
    // The reset program uses the CLI protocol and checks the CLI version.
    // Identify Switchboard explicitly as the client, using the installed version.
    const { stdout } = await run('claude', ['--version']);
    const version = stdout.match(/^\d+\.\d+\.\d+/)?.[0];
    if (!version) throw new Error('Cannot determine the installed Claude CLI version.');
    const headers = {
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-cli/${version} (external, cli, client-app/switchboard)`,
    };
    const base = 'https://api.anthropic.com';
    const account = z
      .object({
        account: z.object({ email: z.string(), uuid: z.string().uuid() }),
        organization: z.object({ uuid: z.string().uuid() }),
      })
      .parse(await request(`${base}/api/oauth/profile`, headers));
    const read = async () => {
      const result = ClaudeStatus.parse(
        z
          .object({ cedar_ember: z.unknown() })
          .parse(await request(`${base}/api/oauth/usage?cedar_ember=1&skip_spend=1`, headers)).cedar_ember,
      );
      for (const grant of result.grants)
        pendingAttempt(
          `${account.account.uuid}:${account.organization.uuid}:${grant.id}`,
          `${grant.resets_left}:${grant.ends_at ?? ''}`,
          'observe',
        );
      return result;
    };
    const status = await read();
    const canUse = (s: z.infer<typeof ClaudeStatus>, id: string) =>
      s.eligible &&
      s.grants.some(
        (g) =>
          g.id === id &&
          g.id === s.next_grant_id &&
          g.resets_left > 0 &&
          g.usable_now &&
          !g.paused &&
          unexpired(g.ends_at),
      );
    const titles: Record<string, string> = {
      five_hour: '5-hour',
      seven_day: 'weekly',
      seven_day_overage_included: 'included weekly overage',
    };
    return {
      account: account.account.email,
      note: status.eligible
        ? 'Only the next grant selected by Claude can be used. Claude decides when a grant is usable.'
        : `Claude reports this account is not eligible (${status.ineligible_reason ?? 'unavailable'}).`,
      offers: status.grants
        .filter((g) => g.resets_left > 0 && unexpired(g.ends_at))
        .map((g) => ({
          id: g.id,
          title: g.label || 'Usage-limit reset',
          usable: canUse(status, g.id),
          detail: `${g.resets_left} remaining. ${expiry(g.ends_at)} Resets: ${g.clears.map((w) => titles[w] ?? w).join(', ')}.`,
        })),
      async redeem(id) {
        await connection.validate();
        const confirmedAccount = z
          .object({ account: z.object({ uuid: z.string() }), organization: z.object({ uuid: z.string() }) })
          .parse(await request(`${base}/api/oauth/profile`, headers));
        if (
          confirmedAccount.account.uuid !== account.account.uuid ||
          confirmedAccount.organization.uuid !== account.organization.uuid
        )
          throw new Error('The account changed. Reopen Usage resets.');
        const fresh = await read();
        if (!canUse(fresh, id))
          throw new Error('This reset is no longer usable. Reopen Usage resets to check availability.');
        // A grant may contain several resets. A lower count proves the prior
        // spend took effect, even if its response was lost.
        const grant = fresh.grants.find((g) => g.id === id)!;
        const generation = `${grant.resets_left}:${grant.ends_at ?? ''}`;
        const key = `${account.account.uuid}:${account.organization.uuid}:${id}`;
        const requestId = pendingAttempt(key, generation, 'send');
        const result = await submitReset(async () =>
          z
            .object({
              result: z.enum(['reset', 'already_used', 'not_limited', 'cooldown', 'ineligible', 'unavailable']),
            })
            .parse(
              await request(`${base}/api/organizations/${account.organization.uuid}/reset_rate_limits`, headers, {
                program: 'cedar_ember',
                grant_id: id,
                request_id: requestId,
              }),
            ),
        );
        if (result.result !== 'unavailable') pendingAttempt(key, generation, 'complete');
        const messages = {
          reset: 'Claude confirmed the usage-limit reset.',
          already_used: 'Claude reports this reset was already used.',
          not_limited: 'Claude reports there is no limit to reset.',
          cooldown: 'Claude requires a cooldown before another reset.',
          ineligible: 'Claude reports this account is no longer eligible.',
          unavailable: 'Claude could not confirm a reset. Check its Usage page before trying again.',
        };
        return messages[result.result] + (result.result === 'reset' ? await afterReset() : '');
      },
    };
  }
  if (!connection.accountId) throw new Error('The proxy did not identify this ChatGPT account.');
  const headers = { 'ChatGPT-Account-Id': connection.accountId, 'User-Agent': 'switchboard/0.1' };
  const url = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
  const read = async () => CodexCredits.parse(await request(url, headers));
  const canUse = (c: z.infer<typeof CodexCredits>['credits'][number]) =>
    c.status === 'available' &&
    c.reset_type === 'codex_rate_limits' &&
    c.is_supported_by_plan &&
    unexpired(c.expires_at);
  const result = await read();
  return {
    account: connection.email,
    note: 'Resets apply to the selected ChatGPT account and its Codex usage across apps.',
    offers: result.credits
      .filter(canUse)
      .map((c) => ({ id: c.id, title: c.title || 'Full reset', detail: expiry(c.expires_at), usable: true })),
    async redeem(id) {
      await connection.validate();
      if (!(await read()).credits.some((c) => c.id === id && canUse(c)))
        throw new Error('This reset is no longer usable. Reopen Usage resets to check availability.');
      const key = `${connection.accountId}:${id}`;
      const requestId = pendingAttempt(key, id, 'send');
      const response = await submitReset(async () =>
        z.object({ code: z.enum(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed']) }).parse(
          await request(`${url}/consume`, headers, {
            credit_id: id,
            redeem_request_id: requestId,
          }),
        ),
      );
      pendingAttempt(key, id, 'complete');
      const messages = {
        reset: 'ChatGPT confirmed the Codex usage-limit reset.',
        nothing_to_reset: 'ChatGPT reports there is no usage to reset.',
        no_credit: 'ChatGPT reports no reset credit is available.',
        already_redeemed: 'ChatGPT reports this credit was already redeemed.',
      };
      return messages[response.code] + (response.code === 'reset' ? await afterReset() : '');
    },
  };
}
