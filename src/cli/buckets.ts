// Proxy buckets: pools of accounts behind a local routing worker.

import { z } from 'zod';
import * as buckets from '../buckets';
import * as proxy from '../buckets/proxy';
import * as launch from '../launch';
import { runInherit } from '../child';
import { shellQuote } from '../shell';
import type { BucketView } from '../types';
import type { Context } from './context';
import { parse, required } from './context';
import { refused, table, usageError } from './output';
import { loadBucket } from './profiles';
import { confirm } from './resolve';

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
  'install-proxy',
]);

async function view(id: string): Promise<BucketView> {
  const found = (await buckets.snapshot()).find((b) => b.id === id);
  if (!found) loadBucket(id); // throws no-such-bucket
  return found as BucketView;
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
      await confirm(ctx.flags, ctx.out.io, `Stop bucket ${id}? Every client routed through it is interrupted.`);
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
