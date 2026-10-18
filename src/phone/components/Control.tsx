// Acting on a session from the phone (src/remote/control.ts): a card for each
// request waiting on the person, an approval to allow or deny or questions to
// answer, and the reply box at the foot of a session.
//
// A reply needs the session's app to have been launched by Switchboard with
// phone access on; the hub says which sessions it can reach. A Claude
// approval reaches the phone only while nobody is at the Mac; a Codex one
// shows on both, and whichever answers first wins.

import { useMutation } from '@tanstack/react-query';
import { ArrowUp, ExternalLink, FileText, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Field, FieldValue, Pending } from '../../remote/control';
import type { EntryOf } from '../../remote/model';
import { Switch } from './ui/switch';
import { cn } from '@/lib/cn';
import { sessionHref, useTRPC } from '../data';
import { Button } from './ui/button';

function useDecide() {
  const trpc = useTRPC();
  return useMutation(trpc.decide.mutationOptions());
}

function Approval({ pending }: { pending: Pending }) {
  const decide = useDecide();
  return (
    <>
      {pending.detail ? (
        <pre className="m-0 max-h-40 overflow-auto rounded-lg bg-code-bg px-3 py-2 font-mono text-[12.5px] whitespace-pre-wrap break-all text-code-text">
          {pending.detail}
        </pre>
      ) : null}
      <span className="flex flex-wrap gap-2">
        {pending.choices.map((c, i) => (
          <Button
            key={c.value}
            size="sm"
            variant={i === 0 ? 'default' : 'outline'}
            disabled={decide.isPending || decide.isSuccess}
            onClick={() => decide.mutate({ id: pending.id, choice: c.value })}
          >
            {c.label}
          </Button>
        ))}
      </span>
      <Outcome decide={decide} />
    </>
  );
}

function Questions({ pending }: { pending: Pending }) {
  const decide = useDecide();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(
    pending.questions.map((q) => [q.id, typed[q.id]?.trim() ? [typed[q.id]!.trim()] : (picked[q.id] ?? [])]),
  );
  const ready = pending.questions.every((q) => answers[q.id]!.length > 0);
  const pick = (id: string, label: string, multi: boolean) =>
    setPicked((p) => {
      const now = p[id] ?? [];
      return { ...p, [id]: multi ? (now.includes(label) ? now.filter((l) => l !== label) : [...now, label]) : [label] };
    });
  return (
    <>
      {pending.questions.map((q) => (
        <div key={q.id} className="flex flex-col gap-2">
          <span className="font-semibold">{q.text}</span>
          {q.options.map((o) => {
            const on = (picked[q.id] ?? []).includes(o.label) && !typed[q.id]?.trim();
            return (
              <button
                key={o.label}
                type="button"
                aria-pressed={on}
                onClick={() => pick(q.id, o.label, q.multi)}
                className={cn(
                  'flex flex-col rounded-xl border px-3 py-2 text-left',
                  on ? 'border-primary bg-accent' : 'border-border',
                )}
              >
                <span className="text-sm font-semibold">{o.label}</span>
                {o.hint ? <span className="text-[12.5px] text-subtle">{o.hint}</span> : null}
              </button>
            );
          })}
          <input
            value={typed[q.id] ?? ''}
            onChange={(e) => setTyped((t) => ({ ...t, [q.id]: e.target.value }))}
            placeholder={q.options.length ? 'Or type an answer' : 'Your answer'}
            className="h-10 rounded-xl border border-border bg-background px-3"
          />
        </div>
      ))}
      <Button
        size="sm"
        className="self-start"
        disabled={!ready || decide.isPending || decide.isSuccess}
        onClick={() => decide.mutate({ id: pending.id, answers })}
      >
        Send answer
      </Button>
      <Outcome decide={decide} />
    </>
  );
}

function FieldInput({ field, value, set }: { field: Field; value: FieldValue | undefined; set(v: FieldValue): void }) {
  const box = 'h-10 rounded-xl border border-border bg-background px-3';
  if (field.type === 'boolean')
    return <Switch checked={value === true} onCheckedChange={set} aria-label={field.label} />;
  if (field.type === 'number')
    return (
      <input
        type="number"
        inputMode="decimal"
        className={box}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => e.target.value !== '' && set(Number(e.target.value))}
      />
    );
  if (field.type === 'choice' || field.type === 'multi') {
    const picked = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return (
      <span className="flex flex-wrap gap-2">
        {field.options.map((o) => {
          const on = picked.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() =>
                set(
                  field.type === 'multi' ? (on ? picked.filter((v) => v !== o.value) : [...picked, o.value]) : o.value,
                )
              }
              className={cn(
                'rounded-full border px-3 py-1.5 text-sm',
                on ? 'border-primary bg-accent' : 'border-border',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </span>
    );
  }
  return <input className={box} value={typeof value === 'string' ? value : ''} onChange={(e) => set(e.target.value)} />;
}

// A form or a link from an MCP server.
function Form({ pending }: { pending: Pending }) {
  const decide = useDecide();
  const [values, setValues] = useState<Record<string, FieldValue>>(() =>
    Object.fromEntries(pending.fields.flatMap((f) => (f.default !== null ? [[f.id, f.default]] : []))),
  );
  const filled = (f: Field) => {
    const v = values[f.id];
    return v !== undefined && v !== '' && !(Array.isArray(v) && !v.length);
  };
  const ready = pending.fields.every((f) => !f.required || filled(f));
  return (
    <>
      {pending.detail ? <span className="text-sm whitespace-pre-wrap">{pending.detail}</span> : null}
      {pending.url ? (
        <a
          href={pending.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 self-start text-sm font-semibold text-foreground"
        >
          <ExternalLink size={14} aria-hidden />
          {new URL(pending.url).host}
        </a>
      ) : null}
      {pending.fields.map((f) => (
        <label key={f.id} className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">
            {f.label}
            {f.required ? '' : <span className="font-normal text-muted-foreground"> (optional)</span>}
          </span>
          {f.hint ? <span className="text-[12.5px] text-subtle">{f.hint}</span> : null}
          <FieldInput field={f} value={values[f.id]} set={(v) => setValues((x) => ({ ...x, [f.id]: v }))} />
        </label>
      ))}
      <span className="flex flex-wrap gap-2">
        {pending.choices.map((c, i) => (
          <Button
            key={c.value}
            size="sm"
            variant={i === 0 ? 'default' : 'outline'}
            disabled={decide.isPending || decide.isSuccess || (i === 0 && !ready)}
            onClick={() =>
              decide.mutate({
                id: pending.id,
                choice: c.value,
                form: c.value === 'accept' && !pending.url ? values : undefined,
              })
            }
          >
            {c.label}
          </Button>
        ))}
      </span>
      <Outcome decide={decide} />
    </>
  );
}

function Outcome({ decide }: { decide: ReturnType<typeof useDecide> }) {
  if (decide.isSuccess) return <span className="text-[13px] text-run-text">Sent to your Mac</span>;
  if (decide.isError)
    return (
      <span className="text-[13px] text-bad-text">
        {decide.error.message === 'no-such-request' ? 'Already answered on the Mac' : "Couldn't send that"}
      </span>
    );
  return null;
}

// A request waiting on the person. `title` names the session it is in, for
// the inbox, where cards from several sessions sit together.
export function PendingCard({ pending, title }: { pending: Pending; title?: string }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-warn bg-card p-3.5">
      <span className="flex flex-col gap-0.5">
        {title ? (
          <a
            href={sessionHref(pending.profileId, pending.sessionId)}
            className="truncate text-[13px] text-muted-foreground no-underline"
          >
            {title}
          </a>
        ) : null}
        <span className="text-[13px] font-semibold text-warn-text">
          {pending.kind === 'approval' ? `Wants to ${pending.title.toLowerCase()}` : pending.title}
        </span>
      </span>
      {pending.kind === 'question' ? (
        <Questions pending={pending} />
      ) : pending.kind === 'form' ? (
        <Form pending={pending} />
      ) : (
        <Approval pending={pending} />
      )}
    </div>
  );
}

// The box Claude Desktop shows at the end of a turn. Its buttons are replies,
// so they work while the box is the session's latest word and the phone can
// reach the session; otherwise it is the record of what was asked.
export function NextStep({
  entry,
  profileId,
  sessionId,
  live,
}: {
  entry: EntryOf<'next'>;
  profileId: string;
  sessionId: string;
  live: boolean;
}) {
  const trpc = useTRPC();
  const reply = useMutation(trpc.reply.mutationOptions());
  const asking = !!entry.ask;
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-2xl border bg-card p-3.5',
        asking && live ? 'border-warn' : 'border-border',
      )}
    >
      {entry.recap ? <span className="text-sm text-subtle">{entry.recap}</span> : null}
      {entry.ask ? <span className="font-semibold">{entry.ask}</span> : null}
      {entry.replies.length && live ? (
        <span className="flex flex-wrap gap-2">
          {entry.replies.map((r, i) => (
            <Button
              key={r.label}
              size="sm"
              variant={i === 0 ? 'default' : 'outline'}
              disabled={reply.isPending || reply.isSuccess}
              onClick={() => reply.mutate({ profileId, sessionId, text: r.message })}
            >
              {r.label}
            </Button>
          ))}
        </span>
      ) : null}
      {reply.isSuccess ? <span className="text-[13px] text-run-text">Sent to your Mac</span> : null}
      {reply.isError ? <span className="text-[13px] text-bad-text">Couldn't send that</span> : null}
    </div>
  );
}

// A picture or file on its way into a reply: uploaded to the Mac as soon as
// it is picked (/api/upload), sent by id with the reply.
interface Attachment {
  key: string;
  name: string;
  image: string | null;
  id: string | null;
  failed: boolean;
}

async function upload(file: File): Promise<string> {
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) throw new Error(res.status === 413 ? 'too-large' : 'failed');
  return ((await res.json()) as { id: string }).id;
}

// The reply box, fixed to the foot of a session. While it has focus the
// keyboard covers the home indicator, so its safe-area padding goes.
export function Composer({
  profileId,
  sessionId,
  reachable,
  problem,
}: {
  profileId: string;
  sessionId: string;
  reachable: boolean;
  // Why the last reply did not go through, when the app said so.
  problem: string | null;
}) {
  const trpc = useTRPC();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Attachment[]>([]);
  const [typing, setTyping] = useState(false);
  // Blur comes before the tap that caused it lands; changing the padding at
  // once would move the buttons out from under the finger.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  // The box's height, for the session screen to keep its last lines clear.
  const box = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--composer', `${el.offsetHeight}px`);
    const ro = new ResizeObserver(set);
    ro.observe(el);
    set();
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--composer');
    };
  }, [reachable]);
  const reply = useMutation(
    trpc.reply.mutationOptions({
      onSuccess: () => {
        setText('');
        for (const f of files) if (f.image) URL.revokeObjectURL(f.image);
        setFiles([]);
      },
    }),
  );
  if (!reachable)
    return (
      <div
        ref={(el) => {
          box.current = el;
        }}
        className="px-gutter pb-safe fixed inset-x-0 bottom-0 border-t border-border bg-background py-2.5 text-center text-xs text-muted-foreground"
      >
        Not reachable right now. Replies reach sessions the app has running, in profiles opened from Switchboard while
        phone access is on.
      </div>
    );

  const add = (list: FileList | null) => {
    for (const file of Array.from(list ?? []).slice(0, 10 - files.length)) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const image = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setFiles((all) => [...all, { key, name: file.name, image, id: null, failed: false }]);
      upload(file).then(
        (id) => setFiles((all) => all.map((f) => (f.key === key ? { ...f, id } : f))),
        () => setFiles((all) => all.map((f) => (f.key === key ? { ...f, failed: true } : f))),
      );
    }
  };
  const uploading = files.some((f) => !f.id && !f.failed);
  const ready = files.filter((f) => f.id);
  const canSend = (text.trim() || ready.length) && !uploading && !reply.isPending;
  const send = () => {
    if (canSend) reply.mutate({ profileId, sessionId, text: text.trim(), files: ready.map((f) => f.id!) });
  };
  return (
    <form
      ref={(el) => {
        box.current = el;
      }}
      className={cn(
        'px-gutter fixed inset-x-0 bottom-0 flex flex-col gap-2 border-t border-border bg-background pt-2.5',
        typing ? 'pb-2' : 'pb-safe',
      )}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {files.length ? (
        <span className="-mx-4 flex gap-2 overflow-x-auto px-4">
          {files.map((f) => (
            <span
              key={f.key}
              className={cn(
                'relative flex h-14 shrink-0 items-center gap-2 overflow-hidden rounded-xl border bg-card',
                f.failed ? 'border-bad-text' : 'border-border',
                f.image ? 'w-14' : 'max-w-52 pr-8 pl-3',
              )}
            >
              {f.image ? (
                <img src={f.image} alt={f.name} className="size-full object-cover" />
              ) : (
                <>
                  <FileText size={16} className="shrink-0 text-subtle" aria-hidden />
                  <span className="truncate text-[13px]">{f.name}</span>
                </>
              )}
              {!f.id && !f.failed ? <span className="absolute inset-0 animate-pulse bg-background/50" /> : null}
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((all) => all.filter((x) => x.key !== f.key))}
                className="absolute top-0.5 right-0.5 grid size-5 place-items-center rounded-full bg-foreground/70 text-background"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </span>
      ) : null}
      <span className="flex items-end gap-2">
        <input
          ref={picker}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            add(e.target.files);
            e.target.value = '';
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="shrink-0 rounded-full"
          aria-label="Attach pictures or files"
          onClick={() => picker.current?.click()}
        >
          <Plus size={18} aria-hidden />
        </Button>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => {
            if (settle.current) clearTimeout(settle.current);
            setTyping(true);
          }}
          onBlur={() => {
            settle.current = setTimeout(() => setTyping(false), 300);
          }}
          rows={1}
          placeholder="Reply"
          aria-label="Reply"
          className="field-sizing-content max-h-[40dvh] min-h-11 min-w-0 flex-1 resize-none rounded-[22px] border border-border bg-card px-4 py-2.5"
        />
        <Button type="submit" size="icon" className="shrink-0 rounded-full" disabled={!canSend} aria-label="Send">
          <ArrowUp size={18} aria-hidden />
        </Button>
      </span>
      {problem && !reply.isPending ? (
        <span className="text-xs text-bad-text">Your last reply didn't go through: {problem}</span>
      ) : null}
      {reply.isError || files.some((f) => f.failed) ? (
        <span className="text-xs text-bad-text">
          {files.some((f) => f.failed)
            ? "A file couldn't be uploaded (25 MB at most). Remove it to send."
            : reply.error?.message === 'not-reachable'
              ? 'This session can no longer be reached.'
              : "Couldn't send that."}
        </span>
      ) : null}
    </form>
  );
}
