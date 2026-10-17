// One transcript entry as the phone draws it (see src/remote/model.ts for
// what each kind holds). Prompts are bubbles, replies are formatted text, a
// run of tool calls folds into one "steps" row whose calls open to their
// command, output and diff, and what a session asked for or produced gets a
// card of its own. Widgets render static in a sealed frame: no scripts, no
// network, no access to the page.

import { ChevronDown, ChevronRight, ExternalLink, FileText, GitPullRequest, Image, Search } from 'lucide-react';
import { useState } from 'react';
import type { Entry, EntryOf, FileChange, ToolCall } from '../../remote/model';
import { cn } from '@/lib/cn';
import { usePrefs } from '../prefs';
import { Markdown } from './Markdown';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';

const LONG_REPLY = 1400;
const OUTPUT_LINES = 12;

export function DiffLines({ change, limit }: { change: FileChange; limit?: number }) {
  const lines = limit ? change.lines.slice(0, limit) : change.lines;
  return (
    <div className="overflow-x-auto font-mono text-[11.5px] leading-[1.6]">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            'px-3 whitespace-pre',
            l.startsWith('+')
              ? 'bg-add-bg text-add-text'
              : l.startsWith('-')
                ? 'bg-del-bg text-del-text'
                : l.startsWith('@@')
                  ? 'text-muted-foreground'
                  : 'text-subtle',
          )}
        >
          {l || ' '}
        </div>
      ))}
    </div>
  );
}

function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const lines = text.split('\n');
  const shown = all ? lines : lines.slice(0, OUTPUT_LINES);
  return (
    <div className="mt-1.5 overflow-hidden rounded-lg bg-code-bg">
      <pre className="m-0 max-h-[60vh] overflow-auto p-2.5 font-mono text-[11.5px] leading-[1.5] text-code-text">
        {shown.join('\n')}
      </pre>
      {lines.length > OUTPUT_LINES ? (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="w-full border-t border-white/10 py-1.5 text-xs text-code-text/80"
        >
          {all ? 'Show less' : `Show all ${lines.length} lines`}
        </button>
      ) : null}
    </div>
  );
}

function Call({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(call.failed);
  const more = !!(call.output || call.change);
  const head = (
    <span className="flex min-w-0 items-baseline gap-2 text-[12.5px]">
      <span className={cn('shrink-0 font-semibold', call.failed ? 'text-bad-text' : 'text-subtle')}>
        {call.service ? `${call.service} · ${call.name}` : call.name}
      </span>
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{call.detail}</span>
      {call.change ? (
        <span className="ml-auto shrink-0 text-xs">
          <span className="text-add-text">+{call.change.adds}</span>{' '}
          <span className="text-del-text">−{call.change.dels}</span>
        </span>
      ) : null}
    </span>
  );
  if (!more) return <div className="py-1">{head}</div>;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-1 py-1 text-left">
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-muted-foreground" aria-hidden />
        )}
        {head}
      </CollapsibleTrigger>
      <CollapsibleContent>
        {call.change ? (
          <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-card">
            <DiffLines change={call.change} limit={60} />
          </div>
        ) : null}
        {call.output ? <Output text={call.output} /> : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function summary(calls: ToolCall[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const key = (c.service ?? c.name).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`);
  return `${calls.length} ${calls.length === 1 ? 'step' : 'steps'} · ${parts.slice(0, 3).join(', ')}${parts.length > 3 ? ', …' : ''}`;
}

function Steps({ entry }: { entry: EntryOf<'steps'> }) {
  const prefs = usePrefs();
  const failed = entry.calls.some((c) => c.failed);
  const [open, setOpen] = useState(prefs.steps === 'open' || failed);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col">
      <CollapsibleTrigger className="flex min-h-8 items-center gap-1.5 text-left text-[13px] text-muted-foreground">
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        {summary(entry.calls)}
        {failed ? <span className="text-bad-text">· failed</span> : null}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col pl-5">
        {entry.calls.map((c) => (
          <Call key={c.id} call={c} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Reply({ text }: { text: string }) {
  const [all, setAll] = useState(text.length <= LONG_REPLY);
  return (
    <div className="flex max-w-full flex-col gap-2 self-start rounded-[16px_16px_16px_4px] border border-border bg-card px-3.5 py-3 text-[15px]">
      <div className={cn(!all && 'relative max-h-72 overflow-hidden')}>
        <Markdown text={text} />
        {!all ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card" />
        ) : null}
      </div>
      {text.length > LONG_REPLY ? (
        <button type="button" onClick={() => setAll(!all)} className="self-start text-[13px] font-semibold text-subtle">
          {all ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
}

function Card({ icon, title, sub, href }: { icon: React.ReactNode; title: string; sub: string; href?: string }) {
  const body = (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-subtle">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold">{title}</span>
        <span className="text-[12.5px] text-muted-foreground">{sub}</span>
      </span>
      {href ? <ExternalLink size={16} className="shrink-0 text-muted-foreground" aria-hidden /> : null}
    </>
  );
  const cls = 'flex items-center gap-3 rounded-2xl border border-border bg-card p-3 text-inherit no-underline';
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'message':
      if (entry.role === 'assistant') return <Reply text={entry.text} />;
      return entry.queued ? (
        <div className="flex max-w-[86%] flex-col gap-0.5 self-end rounded-[16px_16px_4px_16px] border-[1.5px] border-dashed border-input px-3 py-2 text-subtle">
          <span className="text-xs font-semibold text-muted-foreground">Queued</span>
          <span className="whitespace-pre-wrap">{entry.text}</span>
        </div>
      ) : (
        <div className="max-w-[86%] self-end rounded-[16px_16px_4px_16px] bg-primary px-3.5 py-2.5 whitespace-pre-wrap break-words text-primary-foreground">
          {entry.text}
        </div>
      );
    case 'steps':
      return <Steps entry={entry} />;
    case 'question':
      return (
        <div className="flex flex-col gap-2.5 rounded-2xl border border-warn bg-card p-3.5">
          <span className="text-[13px] font-semibold text-warn-text">{entry.answers ? 'Asked you' : 'Asks you'}</span>
          {entry.questions.map((q, i) => (
            <div key={i} className="flex flex-col gap-2">
              <span className="font-semibold">{q.text}</span>
              {q.options.map((o) => (
                <div key={o.label} className="flex flex-col rounded-xl border border-border px-3 py-2">
                  <span className="text-sm font-semibold">{o.label}</span>
                  {o.hint ? <span className="text-[12.5px] text-subtle">{o.hint}</span> : null}
                </div>
              ))}
            </div>
          ))}
          <span className="text-[13px] text-subtle">
            {entry.answers
              ? `You answered: ${entry.answers.join(', ')}`
              : 'Answer on your Mac for now. Answering from the phone comes next.'}
          </span>
        </div>
      );
    case 'subagent':
      return (
        <Card
          icon={<Search size={16} aria-hidden />}
          title={`Subagent · ${entry.title}`}
          sub={entry.summary ?? 'Working on its own'}
        />
      );
    case 'artifact':
      return (
        <Card
          icon={<FileText size={16} aria-hidden />}
          title={entry.title}
          sub="Artifact · opens in Claude"
          href={entry.url}
        />
      );
    case 'pr':
      return (
        <Card
          icon={<GitPullRequest size={16} aria-hidden />}
          title={`PR #${entry.number}`}
          sub={entry.repo}
          href={entry.url}
        />
      );
    case 'file':
      return (
        <Card
          icon={entry.image ? <Image size={16} aria-hidden /> : <FileText size={16} aria-hidden />}
          title={entry.name}
          sub={entry.caption ?? (entry.image ? 'Image on your Mac' : 'File on your Mac')}
        />
      );
    case 'widget':
      return (
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <iframe title={entry.title} sandbox="" srcDoc={entry.html} className="block h-64 w-full border-0 bg-white" />
          <div className="px-3 py-2 text-[12.5px] text-muted-foreground">{entry.title}</div>
        </div>
      );
    case 'review':
      return (
        <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3.5">
          <span className="font-semibold">Review: {entry.verdict}</span>
          {entry.summary ? <span className="text-sm text-subtle">{entry.summary}</span> : null}
          {entry.findings.map((f, i) => (
            <div key={i} className="flex flex-col border-t border-border pt-2">
              <span className="text-sm font-semibold">{f.title}</span>
              <span className="text-[13px] whitespace-pre-wrap text-subtle">{f.body}</span>
            </div>
          ))}
        </div>
      );
    case 'notice':
      return (
        <div
          className={cn(
            'flex items-center gap-2 text-xs',
            entry.tone === 'error' ? 'text-bad-text' : 'text-muted-foreground',
          )}
        >
          <span className="h-px flex-1 bg-border" />
          {entry.text}
          <span className="h-px flex-1 bg-border" />
        </div>
      );
  }
}
