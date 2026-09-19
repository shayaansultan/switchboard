// Pure usage parsing shared by the desktop account reader and bucket workers.
// Importing this module never initializes a desktop profile store or launcher.
import type { UsageWindow } from './types';
// Undocumented endpoint payloads; normalize only fields used in the UI.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
export function parseClaudeUsage(j: Json): UsageWindow[] {
  const windows: UsageWindow[] = [];
  if (Array.isArray(j.limits) && j.limits.length) {
    for (const l of j.limits) {
      if (l.percent == null) continue;
      const scope = l.scope || {};
      const scopeName = (scope.model && scope.model.display_name) || scope.surface || null;
      const label =
        l.kind === 'session'
          ? '5h'
          : l.kind === 'weekly_all'
            ? '7d'
            : `${l.group === 'session' ? '5h' : '7d'} ${scopeName || l.kind}`;
      windows.push({ label, pct: pct(l.percent), resetsAt: isoOrNull(l.resets_at), severity: l.severity || null });
    }
  } else {
    for (const [key, label] of [
      ['five_hour', '5h'],
      ['seven_day', '7d'],
      ['seven_day_opus', '7d Opus'],
      ['seven_day_sonnet', '7d Sonnet'],
    ]) {
      const window = j[key];
      if (window?.utilization != null)
        windows.push({ label, pct: pct(window.utilization), resetsAt: isoOrNull(window.resets_at) });
    }
  }
  return windows;
}
function pct(x: unknown): number | null {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}
function isoOrNull(x: unknown): string | null {
  if (!x) return null;
  if (typeof x === 'number') return new Date(x < 1e12 ? x * 1000 : x).toISOString();
  const t = Date.parse(String(x));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
export function parseCodexUsage(j: Json, now: number = Date.now()): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const windowLabel = (w: Json): string => {
    const secs = w.limit_window_seconds || (w.limit_window_minutes || 0) * 60;
    if (!secs) return 'window';
    return secs >= 86400 ? `${Math.round(secs / 86400)}d` : `${Math.round(secs / 3600)}h`;
  };
  const push = (w: Json, prefix = '') => {
    if (!w || w.used_percent == null) return;
    const resetsAt =
      w.reset_at != null
        ? isoOrNull(w.reset_at)
        : w.resets_at != null
          ? isoOrNull(w.resets_at)
          : w.reset_after_seconds != null
            ? new Date(now + w.reset_after_seconds * 1000).toISOString()
            : null;
    windows.push({ label: (prefix + windowLabel(w)).trim(), pct: pct(w.used_percent), resetsAt });
  };
  const rl = j.rate_limit || {};
  push(rl.primary_window);
  push(rl.secondary_window);
  for (const extra of j.additional_rate_limits || []) {
    const name = String(extra.limit_name || '')
      .replace(/^GPT-/, '')
      .replace(/-?Codex-?/i, '-')
      .replace(/^-|-$/g, '');
    push(extra.rate_limit && extra.rate_limit.primary_window, name ? `${name} ` : '');
    push(extra.rate_limit && extra.rate_limit.secondary_window, name ? `${name} ` : '');
  }
  return windows;
}
