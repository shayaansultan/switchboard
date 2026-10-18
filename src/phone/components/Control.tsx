// Acting on a session from the phone (src/remote/control.ts): a card for each
// request waiting on the person, an approval to allow or deny or questions to
// answer, and the reply box at the foot of a session.
//
// A reply needs the session's app to have been launched by Switchboard with
// phone access on; the hub says which sessions it can reach. A Claude
// approval reaches the phone only while nobody is at the Mac; a Codex one
// shows on both, and whichever answers first wins.

import { useMutation } from '@tanstack/react-query';
import { ArrowUp, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { Field, FieldValue, Pending } from '../../remote/control';
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

// The reply box, fixed to the foot of a session.
export function Composer({
  profileId,
  sessionId,
  reachable,
}: {
  profileId: string;
  sessionId: string;
  reachable: boolean;
}) {
  const trpc = useTRPC();
  const [text, setText] = useState('');
  const reply = useMutation(trpc.reply.mutationOptions({ onSuccess: () => setText('') }));
  if (!reachable)
    return (
      <div className="px-gutter pb-safe fixed inset-x-0 bottom-0 border-t border-border bg-background py-2.5 text-center text-xs text-muted-foreground">
        Not reachable right now. Replies reach sessions the app has running, in profiles opened from Switchboard while
        phone access is on.
      </div>
    );
  const send = () => {
    if (text.trim() && !reply.isPending) reply.mutate({ profileId, sessionId, text: text.trim() });
  };
  return (
    <form
      className="px-gutter pb-safe fixed inset-x-0 bottom-0 flex flex-col gap-1 border-t border-border bg-background pt-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <span className="flex items-end gap-2 pb-2.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={1}
          placeholder="Reply"
          aria-label="Reply"
          className="field-sizing-content max-h-40 min-h-11 flex-1 resize-none rounded-[22px] border border-border bg-card px-4 py-2.5"
        />
        <Button
          type="submit"
          size="icon"
          className="rounded-full"
          disabled={!text.trim() || reply.isPending}
          aria-label="Send"
        >
          <ArrowUp size={18} aria-hidden />
        </Button>
      </span>
      {reply.isError ? (
        <span className="-mt-1.5 pb-2 text-xs text-bad-text">
          {reply.error.message === 'not-reachable' ? 'This session can no longer be reached.' : "Couldn't send that."}
        </span>
      ) : null}
    </form>
  );
}
