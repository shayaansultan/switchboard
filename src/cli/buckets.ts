// Proxy buckets: pools of accounts behind a local routing worker.

import { z } from 'zod';
import * as buckets from '../buckets';
import * as proxy from '../buckets/proxy';
import * as launch from '../launch';
import * as profiles from '../profiles';
import { runInherit } from '../child';
import { shellQuote } from '../shell';
import type { BucketView } from '../types';
import type { Context } from './context';
import { parse, required } from './context';
import { notFound, refused, table, usageError } from './output';
import { assertNotRunning, instances } from './desktop';
import { loadBucket } from './profiles';
import { confirm, mutateStore } from './resolve';

const SUBCOMMANDS = z.enum([
  'list',
  'show',
  'create',
  'start',
  'stop',
  'refresh',
  'login',
  'enable',
  'disable',
  'remove',
  'remove-account',
  'install-proxy',
]);

async function view(id: string): Promise<BucketView> {
  const found = (await buckets.snapshot()).find((b) => b.id === id);
  if (!found) throw notFound('no-such-bucket', `No bucket "${id}"`, 'switchboard bucket list');
  return found;
}

const summarize = (b: BucketView) => ({
  id: b.id,
  name: b.name,
  status: b.status,
  accounts: b.accounts.map((a) => `${a.email ?? a.name} (${a.status})`).join(', '),
});

export async function bucketCommand(rest: string[], ctx: Context): Promise<number | void> {
  const parsed = SUBCOMMANDS.safeParse(rest[0]);
  if (!parsed.success) throw usageError(`bucket needs one of: ${SUBCOMMANDS.options.join(', ')}`);
  const sub = parsed.data;
  const args = rest.slice(1);
  switch (sub) {
    case 'list': {
      const all = await buckets.snapshot();
      ctx.out.result({ buckets: all }, () => table(all.map(summarize), ['id', 'name', 'status', 'accounts']));
      return;
    }
    case 'show':
      ctx.out.result(await view(required(args[0], 'Bucket')));
      return;
    case 'create':
      ctx.out.result(await view(buckets.create(required(args[0], 'Name')).id));
      return;
    case 'start': {
      const id = loadBucket(required(args[0], 'Bucket')).id;
      ctx.out.narrate(`Starting the ${id} worker…`);
      await buckets.start(id);
      ctx.out.result(await view(id));
      return;
    }
    case 'stop': {
      const id = loadBucket(required(args[0], 'Bucket')).id;
      await confirm(ctx.flags, `Stop bucket ${id}? Every client routed through it is interrupted.`);
      await buckets.stop(id);
      ctx.out.result(await view(id));
      return;
    }
    case 'refresh': {
      const id = loadBucket(required(args[0], 'Bucket')).id;
      await buckets.refresh(id);
      ctx.out.result(await view(id));
      return;
    }
    case 'enable':
    case 'disable': {
      const id = loadBucket(required(args[0], 'Bucket')).id;
      await buckets.setAccountEnabled(id, required(args[1], 'Account'), sub === 'enable');
      ctx.out.result(await view(id));
      return;
    }
    case 'remove': {
      const id = loadBucket(required(args[0], 'Bucket')).id;
      if (ctx.data.loadError) throw refused('store-recovered', ctx.data.loadError);
      const assertRoutedQuit = async () => {
        const running = await instances();
        for (const p of ctx.data.profiles.filter((p) => p.proxyBucket === id))
          assertNotRunning(p, running, `it routes through ${id}`);
      };
      await assertRoutedQuit();
      const deleted = buckets.paths(id).base;
      const what = buckets.withOpenCode(id) ? `bucket ${id} and its OpenCode profile` : `bucket ${id}`;
      await confirm(
        ctx.flags,
        `Remove ${what}? Its worker stops, interrupting every client routed through it, and everything under ${deleted} is deleted, with its accounts' sign-ins.`,
      );
      // A profile may have been launched while the prompt was open.
      await assertRoutedQuit();
      let unassigned: string[] = [];
      await buckets.remove(id, () => {
        unassigned = mutateStore((data) => profiles.clearProxyBucket(data, id));
      });
      ctx.out.result({ removed: id, deleted, unassigned });
      return;
    }
    case 'remove-account': {
      const id = loadBucket(required(args[0], 'Bucket')).id;
      const name = required(args[1], 'Account');
      // Only the worker's proxy can list the accounts. A worker started just
      // for this is stopped again, whether or not the removal goes ahead.
      const before = proxy.receipt(id)?.instance;
      const worker = await proxy.ensureWorker(id);
      const started = worker.receipt.instance !== before;
      try {
        const matches = (await proxy.accounts(id, worker.receipt.proxyPort)).filter(
          (a) => a.name === name || a.email === name,
        );
        if (!matches.length)
          throw notFound('no-such-account', `No account "${name}" in ${id}`, `switchboard bucket show ${id}`);
        if (matches.length > 1)
          throw usageError(
            `"${name}" matches ${matches.length} accounts; name one: ${matches.map((a) => a.name).join(', ')}`,
          );
        const [account] = matches;
        await confirm(ctx.flags, `Remove ${account.email ?? account.name} from ${id} and delete its sign-in there?`);
        await buckets.removeAccount(id, account.name);
      } finally {
        if (started) await buckets.stop(id);
      }
      ctx.out.result(await view(id));
      return;
    }
    case 'login': {
      const { values, positionals } = parse(args, {
        provider: { type: 'string', default: 'codex' },
        here: { type: 'boolean' },
      });
      const id = loadBucket(required(positionals[0], 'Bucket')).id;
      const provider = z.enum(['codex', 'claude']).safeParse(values.provider);
      if (!provider.success) throw usageError('--provider must be codex or claude');
      const command = await buckets.loginCommand(id, provider.data);
      if (values.here) {
        if (!process.stdin.isTTY) throw refused('not-a-tty', 'Sign-in is interactive; run --here from a terminal');
        const code = await runInherit(command[0], command.slice(1));
        await buckets.refresh(id).catch(() => {});
        return code;
      }
      await launch.openTerminal(command.map(shellQuote).join(' '), { terminal: ctx.data.settings.terminal });
      ctx.out.result({ bucket: id, provider: provider.data, opened: true, command });
      return;
    }
    case 'install-proxy':
      ctx.out.narrate('Downloading the pinned proxy release…');
      ctx.out.result({ installed: await proxy.installProxy() });
      return;
  }
}

export const workerCommand = (rest: string[]): Promise<void> => proxy.runWorker(required(rest[0], 'Bucket'));
