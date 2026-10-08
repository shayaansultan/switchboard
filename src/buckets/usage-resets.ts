// Bucket reset operations use the proxy's selected sign-in via token
// substitution. No bucket credentials are copied into native profiles.
import { z } from 'zod';
import { prepareAccountReset, type ResetSession } from '../usage-resets';
import { accounts, control, management } from './proxy';
import { load } from './store';

export async function prepareBucketUsageReset(id: string, name: string): Promise<ResetSession> {
  load(id);
  const worker = await control(id, 'status');
  if (!worker?.ready) throw new Error('Start the bucket before checking usage resets.');
  const port = worker.receipt.proxyPort;
  const select = async () => {
    const current = await control(id, 'status');
    if (!current?.ready || current.receipt.instance !== worker.receipt.instance)
      throw new Error('The bucket restarted. Reopen Usage resets.');
    const matches = (await accounts(id, port)).filter((account) => account.name === name);
    if (matches.length !== 1) throw new Error('The account is no longer uniquely identified in this bucket.');
    return matches[0]!;
  };
  const selected = await select();
  const provider = z.enum(['claude', 'codex']).parse(selected.provider ?? selected.type);
  const accountId = selected.account_id ?? selected.id_token?.chatgpt_account_id;
  const identity = (account: typeof selected) =>
    JSON.stringify([
      account.auth_index,
      account.provider ?? account.type,
      account.email,
      account.account_id ?? account.id_token?.chatgpt_account_id,
    ]);
  const pinned = identity(selected);
  const validate = async () => {
    if (identity(await select()) !== pinned) throw new Error('The bucket account changed. Reopen Usage resets.');
  };
  const session = await prepareAccountReset({
    vendor: provider,
    email: selected.email ?? name,
    accountId,
    async validate() {
      await validate();
      if (!worker.supportsAccountRefresh) throw new Error('Restart this bucket to enable proxy-aware usage resets.');
    },
    async request(url, headers, body) {
      await validate();
      const result = z.object({ status_code: z.number(), body: z.string() }).parse(
        await management(id, port, 'api-call', 'POST', {
          auth_index: selected.auth_index,
          method: body === undefined ? 'GET' : 'POST',
          url,
          header: {
            ...headers,
            Authorization: 'Bearer $TOKEN$',
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { data: JSON.stringify(body) }),
        }),
      );
      if (result.status_code < 200 || result.status_code >= 300)
        throw new Error(`Reset API returned HTTP ${result.status_code}. Check the account before trying again.`);
      return JSON.parse(result.body) as unknown;
    },
    async afterReset() {
      await validate();
      const result = z
        .object({ status: z.literal('ok'), auth_index: z.string() })
        .parse(await management(id, port, 'reset-quota', 'POST', { auth_index: selected.auth_index }));
      if (result.auth_index !== selected.auth_index) throw new Error('Proxy reset acknowledged a different account.');
      const refreshed = await control(id, 'refresh-account', name);
      const observed = refreshed?.accounts.find((account) => account.name === name);
      if (observed?.status === 'cooldown')
        return {
          status: 'deferred',
          message:
            ' Its proxy cooldown was cleared. The vendor rate-limited the usage recheck, so usage and routing weight will refresh later. Paused accounts remain paused.',
        };
      if (!observed || !['fresh', 'disabled'].includes(observed.status))
        throw new Error('The worker could not refresh the reset account.');
      return {
        status: 'refreshed',
        message:
          ' Its proxy cooldown was cleared and usage and routing weight were refreshed. Paused accounts remain paused.',
      };
    },
  });
  return {
    ...session,
    offers: worker.supportsAccountRefresh
      ? session.offers
      : session.offers.map((offer) => ({
          ...offer,
          usable: false,
          reason: 'Restart this bucket to spend resets.',
        })),
    note: !worker.supportsAccountRefresh
      ? 'Restart this bucket to enable proxy-aware usage resets. Available grants are shown without spending them.'
      : `${session.note} After a confirmed vendor reset, Switchboard clears this account’s proxy cooldown and refreshes its routing weight. Other bucket accounts are unchanged.`,
  };
}
