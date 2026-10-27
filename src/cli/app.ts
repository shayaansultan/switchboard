// Commands that need the running app's identity or controller, plus a pure
// provider export. Export never writes another application's configuration.
import { requestApp, AppCommand } from '../app-control';
import { dirs } from '../store';
import type { Context } from './context';
import { parse, required } from './context';
import { resolveProfile } from './resolve';
import { refused, usageError } from './output';
import { DEFAULT_FAN_MINUTES, describeFans, isFanLevel, isFanMinutes, type FanState } from '../shared/fans';
import {
  DEFAULT_CAFFEINATE_MINUTES,
  describeCaffeinate,
  isCaffeinateMinutes,
  type CaffeinateState,
} from '../shared/caffeinate';

export async function appCommand(command: 'accessibility' | 'focus', rest: string[], ctx: Context): Promise<void> {
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
  if (profile.id.length > 64)
    throw refused(
      't3-provider-id-too-long',
      'This profile ID exceeds T3’s 64-character provider-key limit.',
      'Configure this profile in T3 manually using a shorter unique provider key and the home path from switchboard show.',
    );
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

const FAN_ACTIONS = ['status', 'set', 'extend', 'system', 'cancel', 'dismiss', 'install', 'remove'] as const;

// Fan control runs in the app, which owns the bridge to the root helper.
export async function fansCommand(rest: string[], ctx: Context): Promise<void> {
  const { values, positionals } = parse(rest, { minutes: { type: 'string' } });
  const [action, level, extra] = positionals;
  const known = (FAN_ACTIONS as readonly string[]).includes(action ?? '');
  if (!known || extra !== undefined || (action === 'set') !== (level !== undefined))
    throw usageError(
      'Use: switchboard fans status|system|cancel|dismiss|install|remove, fans set LEVEL [--minutes N], or fans extend [--minutes N]',
    );
  if (values.minutes !== undefined && action !== 'set' && action !== 'extend')
    throw usageError('--minutes only applies to fans set and fans extend');
  let command: AppCommand;
  if (action === 'set') {
    const speed = Number(level);
    const minutes = values.minutes === undefined ? DEFAULT_FAN_MINUTES : Number(values.minutes);
    if (!isFanLevel(speed)) throw usageError('LEVEL is a percentage from 0 to 100 in steps of 5');
    if (!isFanMinutes(minutes)) throw usageError('--minutes is a whole number from 0 (until System) to 1440');
    command = { command: 'fans', action: 'set', level: speed, minutes };
  } else if (action === 'extend') {
    const minutes = values.minutes === undefined ? DEFAULT_FAN_MINUTES : Number(values.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440)
      throw usageError('--minutes is a whole number from 1 to 1440');
    command = { command: 'fans', action: 'extend', minutes };
  } else {
    command = { command: 'fans', action: action as Exclude<(typeof FAN_ACTIONS)[number], 'set' | 'extend'> };
  }
  const state = (await requestApp(command)) as FanState;
  ctx.out.result(state, () => describeFans(state));
}

const CAFFEINATE_ACTIONS = ['status', 'start', 'extend', 'stop', 'dismiss', 'cancel', 'clear'] as const;

// Caffeinate runs in the app: it owns the power assertion, and the bridge to
// the system helper for the lid-closed option.
export async function caffeinateCommand(rest: string[], ctx: Context): Promise<void> {
  const { values, positionals } = parse(rest, {
    minutes: { type: 'string' },
    lid: { type: 'boolean' },
  });
  const [action, extra] = positionals;
  if (!(CAFFEINATE_ACTIONS as readonly string[]).includes(action ?? '') || extra !== undefined)
    throw usageError(
      'Use: switchboard caffeinate status|stop|dismiss|cancel|clear, caffeinate start [--minutes N] [--lid], or caffeinate extend [--minutes N]',
    );
  const timed = action === 'start' || action === 'extend';
  if (values.minutes !== undefined && !timed) throw usageError('--minutes only applies to start and extend');
  if (values.lid && action !== 'start') throw usageError('--lid only applies to start');
  const minutes = values.minutes === undefined ? DEFAULT_CAFFEINATE_MINUTES : Number(values.minutes);
  if (timed && (!isCaffeinateMinutes(minutes) || (action === 'extend' && minutes === 0)))
    throw usageError('--minutes is a whole number from 0 (until stopped) to 1440; extend needs at least 1');
  let command: AppCommand;
  if (action === 'start') command = { command: 'caffeinate', action, minutes, lid: !!values.lid };
  else if (action === 'extend') command = { command: 'caffeinate', action, minutes };
  else
    command = {
      command: 'caffeinate',
      action: action as Exclude<(typeof CAFFEINATE_ACTIONS)[number], 'start' | 'extend'>,
    };
  const state = (await requestApp(command)) as CaffeinateState;
  ctx.out.result(state, () => describeCaffeinate(state));
}
