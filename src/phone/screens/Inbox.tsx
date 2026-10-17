// The inbox: every profile's sessions in one list, sorted by what needs the
// person (a question waiting on them), then what is running, then the rest.
// A summary of what happened since the app was last put away comes first,
// and the profile chips narrow the list to one account.

import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { HubProfile, Overview } from '../../remote/hub';
import type { SessionSummary } from '../../remote/model';
import { ago } from '../../shared/time';
import {
  Dot,
  ORIGIN_LABEL,
  PageTitle,
  ProfileTag,
  PulseDot,
  SectionTitle,
  StateMark,
  plain,
  project,
  backgroundText,
} from '../components/bits';
import { Button } from '../components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { sessionHref, useNow, type Link } from '../data';
import { setPrefs, usePrefs } from '../prefs';
import { cn } from '@/lib/cn';

const EARLIER_SHOWN = 12;

function Meta({ s, profile }: { s: SessionSummary; profile?: HubProfile }) {
  return (
    <span className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
      {profile ? <ProfileTag profile={profile} /> : null}
      {project(s.cwd) ? <span>{project(s.cwd)}</span> : null}
      {s.origin !== 'desktop' ? <span>{ORIGIN_LABEL[s.origin]}</span> : null}
    </span>
  );
}

function NeedsCard({ s, profile, now }: { s: SessionSummary; profile?: HubProfile; now: number }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-warn bg-warn-bg p-3.5">
      <a href={sessionHref(s.profileId, s.id)} className="flex flex-col gap-1 text-inherit no-underline">
        <span className="flex justify-between gap-2">
          <span className="font-semibold">{s.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{ago(s.updatedAt, now)}</span>
        </span>
        <Meta s={s} profile={profile} />
        <span className="text-sm text-subtle">Asks: {s.needs}</span>
      </a>
      <Button asChild>
        <a href={sessionHref(s.profileId, s.id)}>Open</a>
      </Button>
    </div>
  );
}

function WorkingCard({ s, profile, now }: { s: SessionSummary; profile?: HubProfile; now: number }) {
  const progress = s.plan && s.plan.total ? Math.round((s.plan.done / s.plan.total) * 100) : null;
  return (
    <a
      href={sessionHref(s.profileId, s.id)}
      className="flex flex-col gap-1.5 rounded-2xl border border-border bg-card px-3.5 py-3 text-inherit no-underline"
    >
      <span className="flex items-center gap-2">
        {s.state === 'working' ? <PulseDot /> : <span aria-hidden className="size-2 shrink-0 rounded-full bg-track" />}
        <span className="min-w-0 flex-1 truncate font-semibold">{s.title}</span>
        <span className={cn('shrink-0 text-xs', s.state === 'working' ? 'text-run-text' : 'text-muted-foreground')}>
          {s.state === 'working' ? 'working' : 'waiting'}
        </span>
      </span>
      <Meta s={s} profile={profile} />
      {s.background ? <span className="text-xs text-run-text">{backgroundText(s.background)}</span> : null}
      {s.plan ? (
        <span className="flex items-center gap-2">
          <span className="h-1 flex-1 overflow-hidden rounded-full bg-track">
            <span className="block h-full bg-run" style={{ width: `${progress}%` }} />
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            Step {Math.min(s.plan.done + 1, s.plan.total)} of {s.plan.total}
          </span>
        </span>
      ) : null}
      {s.lastMessage ? (
        <span className="line-clamp-2 text-sm text-subtle">
          {s.lastMessage.role === 'user' ? <span className="text-muted-foreground">You: </span> : null}
          {plain(s.lastMessage.text)}
        </span>
      ) : null}
      <span className="sr-only">{ago(s.updatedAt, now)}</span>
    </a>
  );
}

function EarlierRow({ s, profile, now }: { s: SessionSummary; profile?: HubProfile; now: number }) {
  return (
    <a
      href={sessionHref(s.profileId, s.id)}
      className="flex items-start gap-2.5 border-b border-border px-0.5 py-3 text-inherit no-underline last:border-b-0"
    >
      <StateMark state={s.state} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex justify-between gap-2">
          <span className="truncate font-semibold">{s.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{ago(s.updatedAt, now)}</span>
        </span>
        <Meta s={s} profile={profile} />
        {s.lastMessage ? <span className="truncate text-[13px] text-subtle">{plain(s.lastMessage.text)}</span> : null}
        {s.prs.length ? (
          <span className="flex flex-wrap gap-1.5 pt-0.5 text-xs text-subtle">
            {s.prs.map((pr) => (
              <span key={pr.url} className="rounded-md bg-muted px-1.5 py-px">
                PR #{pr.number}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </a>
  );
}

function SinceYouLeft({
  sessions,
  since,
  onDismiss,
}: {
  sessions: SessionSummary[];
  since: number;
  onDismiss: () => void;
}) {
  const changed = sessions.filter((s) => Date.parse(s.updatedAt) > since);
  if (!changed.length) return null;
  const count = (states: SessionSummary['state'][]) => changed.filter((s) => states.includes(s.state)).length;
  const parts = [
    [count(['needs-you']), 'needs you', 'need you'],
    [count(['finished']), 'finished', 'finished'],
    [count(['stopped', 'errored']), 'stopped', 'stopped'],
    [count(['working', 'waiting']), 'still working', 'still working'],
  ] as const;
  const text = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return (
    <div className="flex items-start gap-2.5 rounded-2xl bg-muted px-3.5 py-3">
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="font-semibold">
          Since you left at {new Date(since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
        </span>
        <span className="text-sm text-subtle">{text.join(', ')}.</span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss summary"
        className="grid size-8 place-items-center text-muted-foreground"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}

export function Inbox({ overview, link }: { overview: Overview | undefined; link: Link }) {
  const now = useNow();
  const prefs = usePrefs();
  const [filter, setFilter] = useState('all');
  const [awayShown, setAwayShown] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const profiles = useMemo(() => new Map((overview?.profiles ?? []).map((p) => [p.id, p])), [overview]);

  if (!overview) {
    return (
      <main className="px-gutter pt-safe flex min-h-dvh items-center justify-center text-center text-muted-foreground">
        {link === 'retrying'
          ? "Can't reach your Mac. Check that Tailscale is on and Switchboard is running."
          : 'Connecting to your Mac…'}
      </main>
    );
  }

  const visible = overview.sessions.filter(
    (s) =>
      !prefs.hidden.includes(s.profileId) &&
      (prefs.inbox === 'all' || s.origin === 'desktop') &&
      (filter === 'all' || s.profileId === filter),
  );
  const needs = visible.filter((s) => s.state === 'needs-you');
  const working = visible.filter((s) => s.state === 'working' || s.state === 'waiting');
  const earlier = visible.filter((s) => s.state === 'finished' || s.state === 'stopped' || s.state === 'errored');
  const chips = overview.profiles.filter((p) => !prefs.hidden.includes(p.id));

  return (
    <main className="px-gutter pt-safe flex flex-col gap-5 pb-6">
      <header className="flex flex-col gap-0.5 pt-6">
        <PageTitle>{overview.host}</PageTitle>
        <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <span className={cn('size-[7px] rounded-full', link === 'live' ? 'bg-run' : 'bg-muted-foreground')} />
          {link === 'live' ? 'Live' : 'Reconnecting…'}
        </span>
      </header>

      {awayShown && prefs.lastSeen ? (
        <SinceYouLeft sessions={visible} since={prefs.lastSeen} onDismiss={() => setAwayShown(false)} />
      ) : null}

      <ToggleGroup
        type="single"
        value={filter}
        onValueChange={(v) => v && setFilter(v)}
        className="-mx-4 flex-nowrap overflow-x-auto px-4"
        aria-label="Profile"
      >
        <ToggleGroupItem value="all" className="shrink-0">
          All
        </ToggleGroupItem>
        {chips.map((p) => (
          <ToggleGroupItem key={p.id} value={p.id} className="shrink-0">
            <Dot color={p.color} />
            {p.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {needs.length ? (
        <section className="flex flex-col gap-2">
          <SectionTitle tone="warn">Needs you</SectionTitle>
          {needs.map((s) => (
            <NeedsCard key={s.profileId + s.id} s={s} profile={profiles.get(s.profileId)} now={now} />
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <SectionTitle>Working</SectionTitle>
        {working.length ? (
          working.map((s) => (
            <WorkingCard key={s.profileId + s.id} s={s} profile={profiles.get(s.profileId)} now={now} />
          ))
        ) : (
          <p className="m-0 text-sm text-muted-foreground">
            Nothing is running. Sessions show here while an agent works.
          </p>
        )}
      </section>

      <section className="flex flex-col">
        <SectionTitle>Earlier</SectionTitle>
        <div className="mt-1 flex flex-col">
          {(showAll ? earlier : earlier.slice(0, EARLIER_SHOWN)).map((s) => (
            <EarlierRow key={s.profileId + s.id} s={s} profile={profiles.get(s.profileId)} now={now} />
          ))}
        </div>
        {earlier.length > EARLIER_SHOWN ? (
          <Button variant="ghost" size="sm" className="self-start px-0" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show ${earlier.length - EARLIER_SHOWN} more`}
          </Button>
        ) : null}
        {prefs.inbox === 'desktop' && overview.sessions.some((s) => s.origin !== 'desktop') ? (
          <Button variant="ghost" size="sm" className="self-start px-0" onClick={() => setPrefs({ inbox: 'all' })}>
            Include terminal and script sessions
          </Button>
        ) : null}
      </section>
    </main>
  );
}
