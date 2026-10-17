// The small pieces every screen shares: a profile's colour dot, a session's
// state, a usage bar and ring, section headings and the tab bar. Labels are
// sentence case; colour comes only from the tokens and a profile's own.

import { Gauge, List, Settings } from 'lucide-react';
import type * as React from 'react';
import type { HubProfile } from '../../remote/hub';
import type { SessionSummary } from '../../remote/model';
import { resetsIn, clock, dayAndTime } from '../../shared/time';
import { pace, severity } from '../../shared/usage';
import { cn } from '@/lib/cn';
import type { Route } from '../data';

export const VENDOR = { claude: 'Claude', codex: 'Codex' } as const;

export const APP_STATE: Record<string, string> = {
  running: 'Running',
  background: 'No window',
  starting: 'Starting…',
  quitting: 'Quitting…',
  stalled: "Won't quit",
  off: 'Off',
};

export const STATE_LABEL: Record<SessionSummary['state'], string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  waiting: 'Waiting',
  finished: 'Finished',
  stopped: 'Stopped',
  errored: 'Stopped on an error',
};

export const ORIGIN_LABEL: Record<SessionSummary['origin'], string> = {
  desktop: 'Desktop',
  cli: 'Terminal',
  ide: 'Editor',
  exec: 'Script',
  other: 'Other',
};

// A message as one plain line for a preview: markdown marks dropped.
export const plain = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

export const project = (cwd: string | null): string | null =>
  cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : null;

export function Dot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-[3px]', className)}
      style={{ background: color }}
    />
  );
}

export function ProfileTag({ profile, withVendor = false }: { profile: HubProfile | undefined; withVendor?: boolean }) {
  if (!profile) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Dot color={profile.color} />
      {profile.name}
      {withVendor ? ` · ${VENDOR[profile.vendor]}` : ''}
    </span>
  );
}

const STATE_TEXT: Record<SessionSummary['state'], string> = {
  working: 'text-run-text',
  'needs-you': 'text-warn-text',
  waiting: 'text-subtle',
  finished: 'text-muted-foreground',
  stopped: 'text-muted-foreground',
  errored: 'text-bad-text',
};

export function StateText({ state, className }: { state: SessionSummary['state']; className?: string }) {
  return <span className={cn('font-semibold', STATE_TEXT[state], className)}>{STATE_LABEL[state]}</span>;
}

// The round mark at the start of an earlier session's row.
export function StateMark({ state }: { state: SessionSummary['state'] }) {
  const mark = state === 'errored' ? '!' : state === 'stopped' ? '■' : state === 'waiting' ? '…' : '✓';
  const tone =
    state === 'errored'
      ? 'bg-danger-bg text-bad-text'
      : state === 'finished'
        ? 'bg-run-bg text-run-text'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      aria-label={STATE_LABEL[state]}
      className={cn('mt-0.5 grid size-[22px] shrink-0 place-items-center rounded-full text-xs font-bold', tone)}
    >
      {mark}
    </span>
  );
}

export function PulseDot() {
  return <span aria-hidden className="animate-pulse-dot inline-block size-2 shrink-0 rounded-full bg-run" />;
}

const FILL: Record<string, string> = { ok: 'bg-fill', warn: 'bg-warn', bad: 'bg-bad' };

// "on track" or "runs out Fri 14:00" for a window, or nothing to say.
export function paceText(w: HubProfile['windows'][number], now: number): string | null {
  if (w.pct === null) return null;
  const p = pace(w.label, 100 - w.pct, w.resetsAt, now);
  if (!p) return null;
  if (p === 'ok') return 'on track';
  return `runs out ${w.label === '5h' ? clock(new Date(p.runsOutAt).toISOString()) : dayAndTime(p.runsOutAt)}`;
}

export function UsageBar({ w, now }: { w: HubProfile['windows'][number]; now: number }) {
  if (w.pct === null) return null;
  const s = severity(w);
  const paced = paceText(w, now);
  return (
    <div className="flex flex-col gap-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-track">
        <div className={cn('h-full', FILL[s])} style={{ width: `${Math.min(100, w.pct)}%` }} />
      </div>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>
          {w.label} · {Math.round(w.pct)}% used{paced ? ` · ${paced}` : ''}
        </span>
        <span>{resetsIn(w.resetsAt, now)}</span>
      </div>
    </div>
  );
}

export function Ring({ pct, label, size = 58 }: { pct: number; label: string; size?: number }) {
  const left = Math.max(0, 100 - pct);
  const s = severity({ pct });
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" role="img" aria-label={label}>
      <circle cx="18" cy="18" r="15" fill="none" stroke="var(--track)" strokeWidth="4" />
      <circle
        cx="18"
        cy="18"
        r="15"
        fill="none"
        stroke={s === 'ok' ? 'var(--fill)' : s === 'warn' ? 'var(--warn)' : 'var(--bad)'}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${((left / 100) * 94.25).toFixed(1)} 94.25`}
        transform="rotate(-90 18 18)"
      />
      <text
        x="18"
        y="21.5"
        textAnchor="middle"
        fontSize="9.5"
        fontWeight="700"
        fill="var(--text)"
        fontFamily="Figtree, sans-serif"
      >
        {Math.round(left)}%
      </text>
    </svg>
  );
}

export function SectionTitle({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <h2 className={cn('m-0 text-sm font-semibold', tone === 'warn' ? 'text-warn-text' : 'text-muted-foreground')}>
      {children}
    </h2>
  );
}

export function PageTitle({ children }: { children: React.ReactNode }) {
  return <h1 className="m-0 font-serif text-[32px] leading-[1.05] font-medium text-balance">{children}</h1>;
}

const TABS = [
  { route: 'inbox', href: '#/', label: 'Sessions', Icon: List },
  { route: 'accounts', href: '#/accounts', label: 'Accounts', Icon: Gauge },
  { route: 'settings', href: '#/settings', label: 'Settings', Icon: Settings },
] as const;

export function TabBar({ route, needs }: { route: Route['name']; needs: number }) {
  return (
    <nav className="pb-safe sticky bottom-0 z-10 flex shrink-0 border-t border-border bg-background px-2 pt-1.5">
      {TABS.map(({ route: r, href, label, Icon }) => (
        <a
          key={r}
          href={href}
          aria-current={route === r ? 'page' : undefined}
          className={cn(
            'relative flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold no-underline',
            route === r ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          <Icon size={22} strokeWidth={1.8} aria-hidden />
          {label}
          {r === 'inbox' && needs > 0 && route !== 'inbox' ? (
            <span className="absolute top-1 ml-6 grid h-4 min-w-4 place-items-center rounded-full bg-warn px-1 text-[10px] font-bold text-foreground">
              {needs}
            </span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}
