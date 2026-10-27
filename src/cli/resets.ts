// The same account-pinned reset flow as the app, with explicit grant selection
// and the CLI's standard confirmation gate before spending a reset.
import { prepareUsageReset } from '../usage-resets';
import { prepareBucketUsageReset } from '../buckets/usage-resets';
import { accounts, control } from '../buckets/proxy';
import type { Context } from './context';
import { parse, required } from './context';
import { loadBucket } from './profiles';
import { confirm, resolveProfile } from './resolve';
import { notFound, refused, table, usageError } from './output';

export async function resetsCommand(rest: string[], ctx: Context, bucket = false): Promise<void> {
  const { values, positionals } = parse(rest, { redeem: { type: 'string' } });
  if (positionals.length !== (bucket ? 2 : 1))
    throw usageError(bucket ? 'resets needs BUCKET ACCOUNT' : 'resets needs PROFILE');
  if (values.redeem !== undefined) required(values.redeem, 'Grant ID');
  const target = bucket
    ? { kind: 'bucket' as const, bucketId: loadBucket(positionals[0]!).id, accountName: positionals[1]! }
    : { kind: 'native' as const, profileId: resolveProfile(ctx.data, positionals[0]!).id };
  const session = await (async () => {
    if (target.kind === 'native') return prepareUsageReset(resolveProfile(ctx.data, target.profileId));
    const worker = await control(target.bucketId, 'status');
    if (!worker?.ready) throw refused('bucket-stopped', 'Start the bucket before checking usage resets.');
    const matches = (await accounts(target.bucketId, worker.receipt.proxyPort)).filter(
      (account) =>
        account.name === target.accountName || account.email?.toLowerCase() === target.accountName.toLowerCase(),
    );
    if (!matches.length) throw notFound('no-such-account', 'No matching account in this bucket.');
    if (matches.length > 1) throw usageError('Account is ambiguous; use its exact name from bucket show.');
    target.accountName = matches[0]!.name;
    return prepareBucketUsageReset(target.bucketId, target.accountName);
  })();
  if (values.redeem === undefined) {
    ctx.out.result(
      { target, account: session.account, offers: session.offers, note: session.note },
      () =>
        `${session.account}\n${session.note}\n${table(
          session.offers.map((offer) => ({ ...offer })),
          ['id', 'title', 'usable', 'detail'],
        )}`,
    );
    return;
  }
  const offer = session.offers.find((offer) => offer.id === values.redeem);
  if (!offer?.usable) throw refused('reset-unavailable', 'This grant is not available for redemption.');
  await confirm(ctx.flags, `Spend one “${offer.title}” reset for ${session.account}? This cannot be undone.`);
  const result = await session.redeem(offer.id);
  ctx.out.result({ target, account: session.account, grantId: offer.id, ...result }, () => result.message);
}
