// Every file a session changed, from the pages of it loaded so far, each
// with its additions and removals and, opened, its diff.

import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Overview } from '../../remote/hub';
import { DiffLines } from '../components/Entries';
import { sessionHref } from '../data';
import { changedFiles, useTranscript } from './Session';
import { cn } from '@/lib/cn';

const KIND: Record<string, string> = { add: 'Added', modify: 'Changed', delete: 'Deleted' };

export function Files({
  profileId,
  sessionId,
  overview,
}: {
  profileId: string;
  sessionId: string;
  overview: Overview | undefined;
}) {
  const query = useTranscript(profileId, sessionId);
  const pages = query.data?.pages ?? [];
  const files = useMemo(
    () =>
      changedFiles(
        pages
          .slice()
          .reverse()
          .flatMap((p) => p.entries),
      ),
    [pages],
  );
  const [open, setOpen] = useState<string | null>(null);
  const title =
    overview?.sessions.find((s) => s.profileId === profileId && s.id === sessionId)?.title ??
    pages[0]?.session.title ??
    'Session';
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);
  return (
    <main className="flex min-h-dvh flex-col">
      <header className="px-gutter pt-safe sticky top-0 z-10 flex flex-col gap-1.5 border-b border-border bg-background pb-3">
        <a
          href={sessionHref(profileId, sessionId)}
          className="inline-flex min-h-8 items-center gap-0.5 self-start text-muted-foreground no-underline"
        >
          <ChevronLeft size={18} aria-hidden />
          <span className="max-w-[70vw] truncate">{title}</span>
        </a>
        <h1 className="m-0 font-serif text-[26px] leading-[1.1] font-medium">
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </h1>
        <span className="text-[13px] text-subtle">
          <span className="font-semibold text-add-text">+{adds}</span>{' '}
          <span className="font-semibold text-del-text">−{dels}</span>
          {query.hasNextPage ? ' · in the part of the session loaded' : ''}
        </span>
      </header>
      <div className="px-gutter flex flex-col gap-2.5 py-3">
        {files.map((f) => {
          const isOpen = open === f.path;
          const name = f.path.split('/').pop() ?? f.path;
          const dir = f.path.slice(0, f.path.length - name.length).replace(/\/$/, '');
          return (
            <div key={f.path} className="overflow-hidden rounded-xl border border-border bg-card">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : f.path)}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
              >
                <span
                  className={cn(
                    'shrink-0 rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold',
                    f.kind === 'add' ? 'bg-run-bg text-run-text' : 'bg-muted text-subtle',
                  )}
                >
                  {KIND[f.kind]}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[13px]">{name}</span>
                  <span className="truncate text-xs text-muted-foreground">{dir}</span>
                </span>
                <span className="shrink-0 text-xs">
                  <span className="text-add-text">+{f.adds}</span> <span className="text-del-text">−{f.dels}</span>
                </span>
                {isOpen ? (
                  <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <ChevronRight size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                )}
              </button>
              {isOpen ? (
                <div className="border-t border-border">
                  <DiffLines change={f} />
                </div>
              ) : null}
            </div>
          );
        })}
        {!files.length && query.isSuccess ? (
          <p className="m-0 text-sm text-muted-foreground">No file changes in this session.</p>
        ) : null}
      </div>
    </main>
  );
}
