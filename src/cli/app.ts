// Commands that need the running app's identity or controller, plus a pure
// provider export. Export never writes another application's configuration.
import { requestApp, AppCommand } from '../app-control';
import { dirs } from '../store';
import type { Context } from './context';
import { parse, required } from './context';
import { resolveProfile } from './resolve';
import { refused, usageError } from './output';

export async function appCommand(
  command: 'awake' | 'accessibility' | 'focus',
  rest: string[],
  ctx: Context,
): Promise<void> {
  const { positionals } = parse(rest, {});
  if (positionals.length !== 1) throw usageError(`${command} requires exactly one argument`);
  const input =
    command === 'focus'
      ? { command, profile: resolveProfile(ctx.data, positionals[0]).id }
      : { command, action: positionals[0] };
  const parsed = AppCommand.safeParse(input);
  if (!parsed.success) throw usageError(`Invalid ${command} action`);
  ctx.out.result(await requestApp(parsed.data));
}

export function exportCommand(rest: string[], ctx: Context): void {
  const { values, positionals } = parse(rest, { format: { type: 'string' } });
  if (values.format !== 't3' || positionals.length !== 1)
    throw usageError('Use: switchboard export PROFILE --format t3');
  const profile = resolveProfile(ctx.data, required(positionals[0], 'Profile'));
  if (profile.vendor === 'codex' && profile.proxyBucket)
    throw refused(
      'routed-export-unsupported',
      'T3 export cannot preserve this Codex profile’s proxy routing.',
      'Use switchboard routed PROFILE, or select a native-account profile for export.',
    );
  ctx.out.result({
    providerInstances: {
      [profile.id]: {
        driver: profile.vendor === 'claude' ? 'claudeAgent' : 'codex',
        displayName: profile.name,
        accentColor: profile.color,
        enabled: true,
        config: { binaryPath: profile.vendor, homePath: dirs(profile).home },
      },
    },
  });
}
