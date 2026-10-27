// Fan control's vocabulary, shared by the main process (src/fans.ts), the
// CLI and the window: the state the window renders, the limits a speed must
// meet, and the words for why control ended. No Node imports, so the
// renderer can bundle it.

export const FAN_STOPS = [
  'app-closed',
  'heartbeat-lost',
  'time-limit',
  'sleep',
  'system-took-over',
  'thermal-pressure',
  'helper-stopped',
  'recovery',
  'control-failed',
] as const;
export type FanStop = (typeof FAN_STOPS)[number];
export type FanHelper = 'installed' | 'not-installed' | 'needs-approval';
export type FanNotice =
  | 'already-controlled'
  | 'control-failed'
  | 'install-failed'
  | 'remove-failed'
  | 'helper-unavailable'
  | 'needs-approval';
/** Why fan control is off on this Mac or build. */
export type FanUnavailable = 'no-fans' | 'unsigned' | 'not-packaged' | 'no-bridge';

export interface FanView {
  actual: number;
  minimum: number;
  maximum: number;
  target: number;
  manual: boolean;
}

export type FanState =
  | { status: 'checking' }
  | { status: 'unavailable'; reason: FanUnavailable }
  | {
      status: 'ready';
      helper: FanHelper;
      fans: FanView[];
      /** Hottest CPU sensor in °C, when one can be read. */
      temperature: number | null;
      /** The held level, or null while macOS controls the fans. */
      level: number | null;
      /** When the held level ends, in ms since the epoch; null for no limit. */
      endsAt: number | null;
      /** Why the last manual session ended, until dismissed or replaced. */
      stop: FanStop | null;
      notice: FanNotice | null;
      busy: boolean;
    };

/** Time limits offered for a manual speed, in minutes; 0 holds until System. */
export const FAN_MINUTES = [15, 30, 60, 0] as const;
export const DEFAULT_FAN_MINUTES = 15;

export function isFanLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100 && value % 5 === 0;
}

export function isFanMinutes(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1440;
}

/** Why the last manual session ended, as the window and CLI say it. */
export const STOP_TEXT: Record<FanStop, string> = {
  'app-closed': 'Switchboard closed',
  'heartbeat-lost': 'Switchboard stopped responding',
  'time-limit': 'the time limit ended',
  sleep: 'the Mac went to sleep',
  'system-took-over': 'macOS took the fans back',
  'thermal-pressure': 'the Mac reported serious thermal pressure',
  'helper-stopped': 'the fan helper was stopped, as at restart or shutdown',
  recovery: 'the fan helper restarted',
  'control-failed': 'the fans did not take the requested speed',
};

export const NOTICE_TEXT: Record<FanNotice, string> = {
  'already-controlled': 'Another app is controlling the fans. Quit it or set it back to automatic, then try again.',
  'control-failed': 'The fans did not take that speed, so they are back on System.',
  'install-failed': 'macOS did not install the fan helper.',
  'remove-failed': 'macOS did not remove the fan helper.',
  'helper-unavailable': 'Could not reach the fan helper.',
  'needs-approval':
    'Allow Switchboard in System Settings › General › Login Items & Extensions, under Allow in the Background, then try again.',
};

export const UNAVAILABLE_TEXT: Record<FanUnavailable, string> = {
  'no-fans': 'This Mac has no fans to control.',
  unsigned:
    'Fan control needs Switchboard signed with a certificate: reinstall with SWITCHBOARD_SIGN_IDENTITY set (see the README).',
  'not-packaged': 'Fan control needs the installed app; a checkout run can only read fan speeds.',
  'no-bridge': 'This build of Switchboard has no fan bridge.',
};

/** One or two lines for `switchboard fans --human`. */
export function describeFans(state: FanState, now = Date.now()): string {
  if (state.status === 'checking') return 'Checking the fans…';
  if (state.status === 'unavailable') return UNAVAILABLE_TEXT[state.reason];
  const speeds = state.fans.map((fan) => `${fan.actual.toLocaleString('en-US')} rpm`).join(', ');
  const heat = state.temperature === null ? '' : ` · CPU ${Math.round(state.temperature)} °C`;
  let mode = 'System';
  if (state.level !== null) {
    const left =
      state.endsAt === null ? 'until System' : `for ${Math.max(1, Math.ceil((state.endsAt - now) / 60_000))} more min`;
    mode = `${state.level}% ${left}`;
  }
  const lines = [`Fans: ${mode} · ${speeds}${heat}`];
  if (state.helper !== 'installed') lines.push(`Fan helper: ${state.helper.replace('-', ' ')}`);
  if (state.stop) lines.push(`Back on System because ${STOP_TEXT[state.stop]}.`);
  if (state.notice) lines.push(NOTICE_TEXT[state.notice]);
  return lines.join('\n');
}
