// Accounts: how much of each profile's rate limits is left. Rings across the
// top for the fullest window of each, then each profile with all its
// windows, their reset times and whether they will last until then.

import type { Overview } from '../../remote/hub';
import { fullest } from '../../shared/usage';
import { APP_STATE, Dot, PageTitle, Ring, UsageBar, VENDOR } from '../components/bits';
import { useNow } from '../data';
import { cn } from '@/lib/cn';

export function Accounts({ overview }: { overview: Overview | undefined }) {
  const now = useNow();
  const profiles = overview?.profiles ?? [];
  return (
    <main className="px-gutter pt-safe flex flex-col gap-4 pb-6">
      <header className="pt-6">
        <PageTitle>Accounts</PageTitle>
      </header>
      <div className="grid grid-cols-3 gap-2">
        {profiles.map((p) => {
          const w = fullest(p.windows);
          return (
            <div
              key={p.id}
              className="flex flex-col items-center gap-1 rounded-2xl border border-border bg-card px-1.5 py-2.5"
            >
              {w && w.pct !== null ? (
                <Ring pct={w.pct} label={`${100 - Math.round(w.pct)} percent of ${p.name}'s ${w.label} window left`} />
              ) : (
                <span className="grid size-[58px] place-items-center text-xs text-muted-foreground">No data</span>
              )}
              <span className="flex max-w-full items-center gap-1.5 truncate text-[13px] font-semibold">
                <Dot color={p.color} />
                {p.name}
              </span>
              <span className="text-[11px] text-muted-foreground">{w ? `${w.label} left` : VENDOR[p.vendor]}</span>
            </div>
          );
        })}
      </div>
      {profiles.map((p) => {
        const running = p.app === 'running' || p.app === 'background';
        const working = overview?.sessions.filter((s) => s.profileId === p.id && s.state === 'working').length ?? 0;
        const needs = overview?.sessions.filter((s) => s.profileId === p.id && s.state === 'needs-you').length ?? 0;
        return (
          <section key={p.id} className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3.5">
            <div className="flex items-center gap-2.5">
              <span className="size-3 shrink-0 rounded" style={{ background: p.color }} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-semibold">
                  {p.name}{' '}
                  <span className="text-sm font-normal text-muted-foreground">
                    {VENDOR[p.vendor]}
                    {p.plan ? ` · ${p.plan}` : ''}
                  </span>
                </span>
                <span className="truncate text-[13px] text-muted-foreground">{p.email ?? 'Not signed in'}</span>
              </span>
              <span
                className={cn(
                  'rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap',
                  running ? 'bg-run-bg text-run-text' : 'bg-muted text-muted-foreground',
                )}
              >
                {APP_STATE[p.app ?? 'off'] ?? 'Off'}
              </span>
            </div>
            {p.windows.map((w) => (
              <UsageBar key={w.label} w={w} now={now} />
            ))}
            {!p.windows.length ? <p className="m-0 text-[13px] text-muted-foreground">No usage numbers yet.</p> : null}
            <span className="text-[13px] text-subtle">
              {[needs ? `${needs} needs you` : null, working ? `${working} working` : null]
                .filter(Boolean)
                .join(' · ') || 'Nothing running'}
            </span>
          </section>
        );
      })}
    </main>
  );
}
