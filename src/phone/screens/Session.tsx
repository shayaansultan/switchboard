// One session: its header (who, where, what state, which model, what it
// cost), the agent's own task list, what it changed and produced, and the
// transcript, newest page first. Older pages load on request, so a session
// of hundreds of megabytes opens as fast as a short one.
//
// The transcript follows the session while you read it: when the overview
// says it changed, the newest page is read again. With older pages loaded
// it waits for you instead, so the page you are reading does not move.

import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDown, ChevronLeft, GitBranch } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Overview } from '../../remote/hub';
import type { Entry, FileChange } from '../../remote/model';
import { ago } from '../../shared/time';
import { backgroundText, PulseDot, ProfileTag, StateText, project } from '../components/bits';
import { EntryView, MadeFiles } from '../components/Entries';
import { Button } from '../components/ui/button';
import { sessionHref, useNow, useTRPC } from '../data';
import { cn } from '@/lib/cn';

export function useTranscript(profileId: string, sessionId: string) {
  const trpc = useTRPC();
  return useInfiniteQuery(
    trpc.session.infiniteQueryOptions(
      { profileId, sessionId },
      { getNextPageParam: (page) => page.before ?? undefined },
    ),
  );
}

// Every file a session changed, its edits summed, from the pages loaded.
export function changedFiles(entries: Entry[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const e of entries) {
    if (e.kind !== 'steps') continue;
    for (const c of e.calls) {
      if (!c.change) continue;
      const prev = byPath.get(c.change.path);
      byPath.set(
        c.change.path,
        prev
          ? {
              ...c.change,
              kind: prev.kind === 'add' ? 'add' : c.change.kind,
              adds: prev.adds + c.change.adds,
              dels: prev.dels + c.change.dels,
              lines: [...prev.lines, ...c.change.lines],
            }
          : c.change,
      );
    }
  }
  return [...byPath.values()];
}

// "claude-opus-5-5" as "Opus 5.5"; other ids as they are.
function modelName(id: string): string {
  const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

export function Session({
  profileId,
  sessionId,
  overview,
}: {
  profileId: string;
  sessionId: string;
  overview: Overview | undefined;
}) {
  const now = useNow();
  const query = useTranscript(profileId, sessionId);
  const pages = query.data?.pages ?? [];
  const entries = useMemo(
    () =>
      pages
        .slice()
        .reverse()
        .flatMap((p) => p.entries),
    [pages],
  );
  const summary = overview?.sessions.find((s) => s.profileId === profileId && s.id === sessionId) ?? pages[0]?.session;
  const profile = overview?.profiles.find((p) => p.id === profileId);
  const bottom = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [fresh, setFresh] = useState(false);
  const seen = useRef<string | undefined>(undefined);
  // Whether the reader was at the end before the last change: if so, stay there.
  const pinned = useRef(true);

  // Follow the session: re-read the newest page when it changes.
  useEffect(() => {
    if (!summary) return;
    if (seen.current && seen.current !== summary.updatedAt) {
      if (pages.length <= 1) void query.refetch();
      else setFresh(true);
    }
    seen.current = summary.updatedAt;
  }, [summary?.updatedAt]);

  // Open at the end, and stay at the end as entries arrive and render, unless
  // the reader has scrolled up.
  useLayoutEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView();
  }, [entries]);

  useEffect(() => {
    const el = bottom.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      setAtBottom(e.isIntersecting);
      pinned.current = e.isIntersecting;
    });
    io.observe(el);
    // Late layout (fonts, code blocks) can push the end down after the first
    // scroll; follow it while still pinned.
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollIntoView();
    });
    ro.observe(document.body);
    return () => {
      io.disconnect();
      ro.disconnect();
    };
  }, []);

  const files = changedFiles(entries);
  const artifacts = entries.filter((e) => e.kind === 'artifact').length;
  const subagents = entries.filter((e) => e.kind === 'subagent').length;
  const facts = [
    summary?.model ? modelName(summary.model) : null,
    summary?.costUsd != null ? `$${summary.costUsd.toFixed(2)}` : null,
    summary ? `updated ${ago(summary.updatedAt, now)}` : null,
  ].filter(Boolean);

  return (
    <main className="flex min-h-dvh flex-col">
      <header className="px-gutter pt-safe sticky top-0 z-10 flex flex-col gap-1.5 border-b border-border bg-background pb-2.5">
        <a href="#/" className="inline-flex min-h-8 items-center gap-0.5 self-start text-muted-foreground no-underline">
          <ChevronLeft size={18} aria-hidden />
          Sessions
        </a>
        <h1 className="m-0 font-serif text-[26px] leading-[1.1] font-medium text-balance">
          {summary?.title ?? 'Session'}
        </h1>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
          <ProfileTag profile={profile} withVendor />
          {summary && project(summary.cwd) ? <span>{project(summary.cwd)}</span> : null}
          {summary?.branch ? (
            <span className="inline-flex items-center gap-1">
              <GitBranch size={12} aria-hidden />
              {summary.branch}
            </span>
          ) : null}
          {summary ? <StateText state={summary.state} /> : null}
          {summary?.background ? <span className="text-run-text">{backgroundText(summary.background)}</span> : null}
        </div>
        {facts.length ? <div className="text-xs text-subtle tabular-nums">{facts.join(' · ')}</div> : null}
      </header>

      <div className="px-gutter flex flex-1 flex-col gap-3 py-3">
        {summary?.plan ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card px-3.5 py-3">
            <span className="text-[13px]">
              <b className="font-semibold">
                Step {Math.min(summary.plan.done + 1, summary.plan.total)} of {summary.plan.total}
              </b>
              {summary.plan.current ? ` · ${summary.plan.current}` : ''}
            </span>
            <span
              className="grid gap-1"
              style={{ gridTemplateColumns: `repeat(${summary.plan.total}, minmax(0, 1fr))` }}
            >
              {Array.from({ length: summary.plan.total }, (_, i) => (
                <span
                  key={i}
                  className={cn(
                    'h-1 rounded-full',
                    i < summary.plan!.done ? 'bg-fill' : i === summary.plan!.done ? 'bg-run' : 'bg-track',
                  )}
                />
              ))}
            </span>
          </div>
        ) : null}

        {files.length || summary?.prs.length || artifacts || subagents ? (
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4">
            {files.length ? (
              <a
                href={sessionHref(profileId, sessionId, true)}
                className="inline-flex h-[34px] shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[13px] text-foreground no-underline"
              >
                {files.length} {files.length === 1 ? 'file' : 'files'}{' '}
                <span className="text-add-text">+{files.reduce((n, f) => n + f.adds, 0)}</span>
                <span className="text-del-text">−{files.reduce((n, f) => n + f.dels, 0)}</span>
              </a>
            ) : null}
            {summary?.prs.map((pr) => (
              <a
                key={pr.url}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-[34px] shrink-0 items-center rounded-full border border-border bg-card px-3 text-[13px] text-foreground no-underline"
              >
                PR #{pr.number}
              </a>
            ))}
            {artifacts ? (
              <span className="inline-flex h-[34px] shrink-0 items-center rounded-full border border-border bg-card px-3 text-[13px]">
                {artifacts} {artifacts === 1 ? 'artifact' : 'artifacts'}
              </span>
            ) : null}
            {subagents ? (
              <span className="inline-flex h-[34px] shrink-0 items-center rounded-full border border-border bg-card px-3 text-[13px]">
                {subagents} {subagents === 1 ? 'subagent' : 'subagents'}
              </span>
            ) : null}
          </div>
        ) : null}

        <MadeFiles files={pages[0]?.files ?? []} />

        {query.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-center"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load earlier'}
          </Button>
        ) : null}
        {query.isPending ? <p className="m-0 text-sm text-muted-foreground">Loading…</p> : null}
        {query.isError ? (
          <p className="m-0 text-sm text-bad-text">Couldn't load this session. It may be older than a week.</p>
        ) : null}
        {query.isSuccess && !entries.length ? (
          <p className="m-0 text-sm text-muted-foreground">No messages yet.</p>
        ) : null}

        {entries.map((e, i) => (
          <EntryView key={i} entry={e} />
        ))}

        {summary?.state === 'working' ? (
          <div className="flex items-center gap-1.5 text-[13px] text-run-text">
            <PulseDot />
            Working
          </div>
        ) : null}
        <div ref={bottom} className="h-px" />
      </div>

      {fresh || !atBottom ? (
        <button
          type="button"
          onClick={() => {
            if (fresh) {
              setFresh(false);
              void query.refetch();
            }
            bottom.current?.scrollIntoView({ behavior: 'smooth' });
          }}
          className="fixed right-4 bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] inline-flex h-[34px] items-center gap-1 rounded-full bg-primary px-3 text-[13px] font-semibold text-primary-foreground shadow-md"
        >
          <ArrowDown size={14} aria-hidden />
          {fresh ? 'New activity' : 'Latest'}
        </button>
      ) : null}
    </main>
  );
}
