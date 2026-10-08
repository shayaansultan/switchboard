// A Claude Code mod that Switchboard passes to every Claude profile it
// launches (CLAUDE_CODE_PLUGIN_DIRS, see src/launch.ts). It fills the band
// above the prompt with the profile's colour, so which profile an app belongs
// to, and whether it has room for more work, can be spotted from across the
// screen. On the left: the profile's name and plan, then how full this
// session's context window is and what the session has cost. On the right:
// the 5-hour and 7-day rate limits, each as a bar of what is left, when it
// resets, and whether use so far would run it out before then.
//
// The limits come from `switchboard usage` every five minutes: Switchboard's
// cache, fetched live when that is over 15 minutes old, and never renewing the
// sign-in this session is using. Context and cost come from the session itself
// when it starts and after every turn; a compaction hides the context until
// the next turn. A narrow band drops
// detail in a fixed order (DROPS), then whole windows, a window with a pace
// warning last, and never the name. The Default profile is launched without
// the variables and draws nothing.

import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { BandSession, BandUsage, BandWindow } from '../types';

const REFRESH_MS = 5 * 60 * 1000;
const usage = atom({ plugin: 'switchboard-profile-band', key: 'usage' } as const, null);
const session = atom({ plugin: 'switchboard-profile-band', key: 'session' } as const, null);

const HOUR = 60 * 60 * 1000;
const WINDOW_MS: Record<string, number> = { '5h': 5 * HOUR, '7d': 7 * 24 * HOUR };
const BAR_CELLS = 10;

type Profile = { id: string | undefined; name: string; color: string; command: string | undefined };

// Text on the profile's colour: dark on a light colour, light on a dark one.
// `undefined` for anything but #rrggbb, which then colours the name instead.
export function labelColor(hex: string): string | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return undefined;
  const [r, g, b] = m.slice(1).map((c) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? '#1a1a1a' : '#ffffff';
}

// The profile's plan and its 5-hour and 7-day windows from `switchboard usage
// PROFILE` output; null when there are no numbers to show.
export function parseUsage(stdout: string): BandUsage | null {
  try {
    const row = JSON.parse(stdout).profiles?.[0]?.usage;
    if (!row || (row.status !== 'ok' && row.status !== 'stale')) return null;
    const windows: BandWindow[] = (row.windows ?? [])
      .filter((w: BandWindow) => w.label === '5h' || w.label === '7d')
      .map((w: BandWindow) => ({
        label: w.label,
        remaining: w.remaining,
        resetsAt: w.resetsAt ?? null,
        severity: w.severity,
      }));
    return { plan: row.plan ?? null, windows };
  } catch {
    return null;
  }
}

// "2h 5m", "40m", "3d": how long until a window resets.
export function until(resetsAt: string | null, now: number): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (Number.isNaN(at) || at <= now) return null;
  const minutes = Math.round((at - now) / 60000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.round(minutes / 1440)}d`;
}

// "Sat 02:00", or "16:20" without the day: a local time, for the 7-day reset,
// whose reset is days off and easier to plan around as a date than a count.
// Rounded to the minute: resets land a moment before the hour (01:59:59.9).
function clockTime(at: number, withDay: boolean, timeZone?: string): string {
  return new Date(Math.round(at / 60000) * 60000).toLocaleString('en-GB', {
    ...(withDay ? { weekday: 'short' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

export function resetsOn(resetsAt: string | null, now: number, timeZone?: string): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : NaN;
  if (Number.isNaN(at) || at <= now) return null;
  return clockTime(at, true, timeZone);
}

// Whether the window lasts to its reset at the rate it has been used so far:
// 'ok' when it does, the moment it would run out when it does not, null when
// there is too little of the window behind us to say (its first tenth) or no
// reset time, or nothing left, which the bar already says. The two answers are
// exact complements: a window runs out early precisely when less of it is left
// than of the time.
export function pace(w: BandWindow, now: number): 'ok' | { runsOutAt: number } | null {
  const windowMs = WINDOW_MS[w.label];
  const at = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!windowMs || Number.isNaN(at) || at <= now || w.remaining <= 0) return null;
  const timeLeft = at - now;
  const elapsed = windowMs - timeLeft;
  if (elapsed < windowMs / 10) return null;
  const used = 100 - w.remaining;
  if (used <= 0 || w.remaining * elapsed >= used * timeLeft) return 'ok';
  return { runsOutAt: now + (w.remaining * elapsed) / used };
}

// "███████░░░": what is left of a window, in tenths.
export function bar(remaining: number): string {
  const full = Math.max(0, Math.min(BAR_CELLS, Math.round(remaining / 10)));
  return '█'.repeat(full) + '░'.repeat(BAR_CELLS - full);
}

// What the band can say, before it is fitted to the width it has.
export type BandFacts = {
  name: string;
  plan: string | null;
  context: number | null;
  costUsd: number | null;
  limits: {
    label: string;
    remaining: number;
    // "resets in 1h 47m" or "resets Sat 02:00".
    resets: string | null;
    // "on track", "runs out Fri 14:00", or nothing to say.
    pace: { text: string; isWarning: boolean } | null;
    isLow: boolean;
  }[];
};

// What a narrow band gives up, first to last, before it drops whole windows.
const DROPS = ['cost', 'onTrack', 'reset7d', 'context', 'reset5h', 'bars', 'plan'] as const;
type Drop = (typeof DROPS)[number];

export type BandLayout = { detail: string; limits: { key: string; text: string; isBold: boolean }[] };

function layout(f: BandFacts, dropped: Set<Drop>, hidden: Set<string>): BandLayout {
  const detail = [
    !dropped.has('plan') && f.plan,
    !dropped.has('context') && f.context !== null && `context ${f.context}%`,
    // Less than a cent is not worth the room.
    !dropped.has('cost') && f.costUsd !== null && f.costUsd >= 0.005 && `$${f.costUsd.toFixed(2)}`,
  ].filter(Boolean);
  const limits = f.limits
    .filter((l) => !hidden.has(l.label))
    .map((l) => {
      const parts = [
        `${l.label} ${dropped.has('bars') ? '' : `${bar(l.remaining)} `}${l.remaining}%`,
        !dropped.has(`reset${l.label}` as Drop) && l.resets,
        l.pace && (l.pace.isWarning || !dropped.has('onTrack')) && l.pace.text,
      ].filter(Boolean);
      return { key: l.label, text: parts.join(' · '), isBold: l.isLow || !!l.pace?.isWarning };
    });
  return { detail: detail.length ? `  ${detail.join(' · ')}` : '', limits };
}

// The most of the band that fits in `columns` cells, the padding included.
// Windows go from the right, those with a pace warning after the rest.
export function fitBand(f: BandFacts, columns: number): BandLayout {
  const windows = [...f.limits]
    .reverse()
    .sort((a, b) => Number(!!a.pace?.isWarning) - Number(!!b.pace?.isWarning))
    .map((l) => l.label);
  const steps = DROPS.length + windows.length;
  for (let n = 0; ; n++) {
    const dropped = new Set(DROPS.slice(0, n));
    const shown = layout(f, dropped, new Set(windows.slice(0, Math.max(0, n - DROPS.length))));
    const width = 2 + f.name.length + shown.detail.length + shown.limits.reduce((w, l) => w + l.text.length + 4, 0);
    if (width <= columns || n === steps) return shown;
  }
}

export function bandFacts(
  p: { name: string },
  u: BandUsage | null,
  s: BandSession | null,
  now: number,
  timeZone?: string,
): BandFacts {
  return {
    name: p.name,
    plan: u?.plan ?? null,
    context: s?.context ?? null,
    costUsd: s?.costUsd ?? null,
    limits: (u?.windows ?? []).map((w) => {
      const is5h = w.label === '5h';
      const reset = is5h ? until(w.resetsAt, now) : resetsOn(w.resetsAt, now, timeZone);
      const paced = pace(w, now);
      return {
        label: w.label,
        remaining: w.remaining,
        resets: reset && `resets ${is5h ? 'in ' : ''}${reset}`,
        // The 5-hour window speaks up only when it is running out.
        pace:
          paced === 'ok'
            ? is5h
              ? null
              : { text: 'on track', isWarning: false }
            : paced && { text: `runs out ${clockTime(paced.runsOutAt, !is5h, timeZone)}`, isWarning: true },
        // Low as Switchboard's own window colours it: warned, or 70% used.
        isLow: w.severity === 'warning' || w.severity === 'critical' || w.remaining <= 30,
      };
    }),
  };
}

// The launch environment does not change while the session runs.
let profile: Promise<Profile | null> | undefined;

function loadProfile($: EngineInterface): Promise<Profile | null> {
  profile ??= (async () => {
    const name = await $.env.get('SWITCHBOARD_PROFILE_NAME');
    if (!name) return null;
    return {
      id: await $.env.get('SWITCHBOARD_PROFILE'),
      name,
      color: (await $.env.get('SWITCHBOARD_PROFILE_COLOR')) ?? '',
      command: await $.env.get('SWITCHBOARD_COMMAND'),
    };
  })();
  return profile;
}

async function readSession($: EngineInterface): Promise<void> {
  try {
    const s = await $.session.usage();
    await update($, session, () => ({ context: s.context.percent ?? null, costUsd: s.cost?.usd ?? null }));
  } catch {
    // The band keeps the last figures.
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    const p = await loadProfile($);
    if (!p) return started;
    void readSession($);
    const id = p.id;
    const command = p.command;
    if (!id || !command) return started;

    const refresh = async () => {
      try {
        const { exitCode, stdout } = await $.process.run([command, 'usage', id, '--max-age', '15m', '--no-renew'], {
          timeoutMs: 20000,
        });
        if (exitCode !== 0) return;
        const latest = parseUsage(stdout);
        if (latest) await update($, usage, () => latest);
      } catch {
        // No numbers this round; the band keeps the last ones.
      }
    };
    void refresh();
    $.clock.every(REFRESH_MS, () => void refresh());
    return started;
  });

  // The main conversation's, not a subagent's: the band shows this session.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e);
    if (!e.agentId && (await loadProfile($))) void readSession($);
    return done;
  });

  // The session reports the last response's fill until the next one, which a
  // compaction makes wrong: show none until the next turn reads it again.
  on('session.compact', async ($, e, next) => {
    const done = await next(e);
    if (!e.agentId) await update($, session, (s) => s && { ...s, context: null });
    return done;
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const p = await loadProfile($);
    if (!p) return next(e);

    const { Box, Text } = $.ui.resolve(e);
    const label = labelColor(p.color);
    if (!label) {
      return (
        <Text color={p.color || undefined} bold>
          {`● ${p.name}`}
        </Text>
      );
    }

    const u = await read($, usage);
    const s = await read($, session);
    const now = u?.windows.length ? await $.clock.now() : 0;
    const shown = fitBand(bandFacts(p, u, s, now), e.props.bodyColumns);

    return (
      <Box width="100%" backgroundColor={p.color} paddingX={1} flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={label} bold>
            {p.name}
          </Text>
          {shown.detail ? <Text color={label}>{shown.detail}</Text> : null}
        </Box>
        <Box flexDirection="row">
          {shown.limits.map((l, i) => (
            <Text key={l.key} color={label} bold={l.isBold}>
              {`${i ? '    ' : ''}${l.text}`}
            </Text>
          ))}
        </Box>
      </Box>
    );
  });
};
