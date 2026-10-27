// Caffeinate's vocabulary, shared by the main process (src/caffeinate.ts),
// the CLI and the window: the state the window renders, the lengths offered,
// and the words for why a session ended. No Node imports, so the renderer can
// bundle it.

export const CAFFEINATE_STOPS = [
  'time-limit',
  'app-closed',
  'heartbeat-lost',
  'thermal-pressure',
  'battery-low',
  'helper-stopped',
  'recovery',
  'sleep',
  'control-failed',
] as const;
export type CaffeinateStop = (typeof CAFFEINATE_STOPS)[number];

export type CaffeinateNotice =
  | 'needs-approval'
  | 'helper-unavailable'
  | 'install-failed'
  | 'battery-low'
  | 'lid-failed'
  | 'clear-failed';

/** Whether "Also with the lid closed" can be offered, and if not, why. */
export type LidSupport = 'available' | 'no-lid' | 'unsigned' | 'not-packaged' | 'no-bridge';

export interface CaffeinateState {
  active: boolean;
  /** When the session ends, in ms since the epoch; null for until stopped. */
  endsAt: number | null;
  /** The session's whole length in minutes, for the countdown bar. */
  limit: number | null;
  /** The Mac stays awake with the lid closed too (the system helper's hold). */
  lid: boolean;
  lidSupport: LidSupport;
  /** The system helper, when this build can use one. */
  helper: 'installed' | 'not-installed' | 'needs-approval' | null;
  /** macOS's sleep is off, but not by this session: an old Keep awake or pmset. */
  sleepDisabledElsewhere: boolean;
  /** Why the last session ended, until dismissed or replaced. */
  stop: CaffeinateStop | null;
  notice: CaffeinateNotice | null;
  /** A lid-closed session is waiting for the helper to be allowed. */
  queued: boolean;
  busy: boolean;
}

/** Lengths offered beside Until I stop and Custom, in minutes. */
export const CAFFEINATE_MINUTES = [60, 120, 240];
export const DEFAULT_CAFFEINATE_MINUTES = 60;

export function isCaffeinateMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1440;
}

/** Why the last session ended ("Ended because …"). */
export const CAFFEINATE_STOP_TEXT: Record<CaffeinateStop, string> = {
  'time-limit': 'the time was up',
  'app-closed': 'Switchboard closed',
  'heartbeat-lost': 'Switchboard stopped responding',
  'thermal-pressure': 'the Mac got seriously hot with the lid closed',
  'battery-low': 'the battery dropped below 20% with the lid closed',
  'helper-stopped': 'the system helper was stopped, as at restart or shutdown',
  recovery: 'the system helper restarted',
  sleep: 'the Mac was put to sleep',
  'control-failed': 'macOS did not keep sleep off',
};

export const CAFFEINATE_NOTICE_TEXT: Record<CaffeinateNotice, string> = {
  'needs-approval':
    'Turn on Switchboard under Allow in the Background in System Settings › General › Login Items & Extensions. It starts once it’s allowed.',
  'helper-unavailable': 'Could not reach the system helper, so the lid-closed option is off.',
  'install-failed': 'macOS did not install the system helper.',
  'battery-low':
    'The battery is below 20%, so the Mac can’t stay awake with the lid closed. Plug in, or leave the lid open.',
  'lid-failed': 'macOS did not turn sleep off for the closed lid.',
  'clear-failed': 'macOS did not turn sleep back on.',
};

export const LID_SUPPORT_TEXT: Record<Exclude<LidSupport, 'available'>, string> = {
  'no-lid': 'This Mac has no lid.',
  unsigned: 'Needs Switchboard installed with a signing certificate.',
  'not-packaged': 'Needs the installed app.',
  'no-bridge': 'This build has no system helper.',
};

/** One or two lines for `switchboard caffeinate --human`. */
export function describeCaffeinate(state: CaffeinateState, now = Date.now()): string {
  const lines: string[] = [];
  if (!state.active) lines.push('Decaf: the Mac sleeps as usual.');
  else {
    const left =
      state.endsAt === null ? 'until stopped' : `for ${Math.max(1, Math.ceil((state.endsAt - now) / 60_000))} more min`;
    lines.push(`Caffeinated ${left}${state.lid ? ' (lid closed too)' : ''}.`);
  }
  if (state.sleepDisabledElsewhere)
    lines.push('Sleep is turned off system-wide outside Caffeinate (pmset disablesleep).');
  if (state.queued) lines.push('A lid-closed session is waiting for the system helper to be allowed.');
  if (state.stop) lines.push(`Ended because ${CAFFEINATE_STOP_TEXT[state.stop]}.`);
  if (state.notice) lines.push(CAFFEINATE_NOTICE_TEXT[state.notice]);
  return lines.join('\n');
}
