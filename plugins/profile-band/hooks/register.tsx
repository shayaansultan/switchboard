// A Claude Code mod that Switchboard passes to every Claude profile it
// launches (CLAUDE_CODE_PLUGIN_DIRS, see src/launch.ts). It fills the band
// above the prompt with the profile's colour: its name and plan on the left,
// how much of its 5-hour and 7-day rate limits is left on the right, so which
// profile an app belongs to, and whether it has room for more work, can be
// spotted from across the screen. The limits come from `switchboard usage`
// every five minutes: Switchboard's cache, fetched live when that is over 15
// minutes old, and never renewing the sign-in this session is using. The
// Default profile is launched without the variables and draws nothing.

import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { BandUsage, BandWindow } from '../types';

const REFRESH_MS = 5 * 60 * 1000;
const usage = atom({ plugin: 'switchboard-profile-band', key: 'usage' } as const, null);

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

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    const p = await loadProfile($);
    const id = p?.id;
    const command = p?.command;
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
    const now = u?.windows.length ? await $.clock.now() : 0;
    const windows = (u?.windows ?? []).map((w) => {
      const left = `${w.label} ${w.remaining}% left`;
      const reset = w.label === '5h' ? until(w.resetsAt, now) : null;
      // Low as Switchboard's own window colours it: warned, or 70% used.
      const isLow = w.severity === 'warning' || w.severity === 'critical' || w.remaining <= 30;
      return { key: w.label, text: reset ? `${left} · resets in ${reset}` : left, isLow };
    });
    // Narrow windows drop the limits first, then the plan, never the name.
    const room = e.props.bodyColumns - 2 - p.name.length;
    const plan = u?.plan && room > u.plan.length + 2 ? u.plan : null;
    const right = room - (plan ? plan.length + 2 : 0);
    const shown = windows.filter((_, i) => windows.slice(0, i + 1).reduce((n, w) => n + w.text.length + 4, 0) <= right);

    return (
      <Box width="100%" backgroundColor={p.color} paddingX={1} flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={label} bold>
            {p.name}
          </Text>
          {plan ? <Text color={label}>{`  ${plan}`}</Text> : null}
        </Box>
        <Box flexDirection="row">
          {shown.map((w, i) => (
            <Text key={w.key} color={label} bold={w.isLow}>
              {`${i ? '    ' : ''}${w.text}`}
            </Text>
          ))}
        </Box>
      </Box>
    );
  });
};
