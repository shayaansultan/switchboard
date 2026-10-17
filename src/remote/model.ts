// The one shape every session takes on its way to the phone, whichever app
// wrote it. The Claude and Codex readers (claude.ts, codex.ts) translate their
// own records into this, so the hub, the CLI and the phone app only ever learn
// one vocabulary: a session has a state and a summary, and its transcript is
// a list of entries.
//
// Entries are what a person reads, not what the model saw: prompts and
// replies, the tool calls between them gathered into one `steps` entry, and
// the things a session produced or asked for (a PR, an artifact, a question)
// as entries of their own. Anything a reader does not recognise is left out
// rather than guessed at.
//
// The schemas double as the API contract: the hub validates nothing it
// produces itself, but the phone and tests can parse against them.

import { z } from 'zod';

export const Vendor = z.enum(['claude', 'codex']);

// Where a session was started. `exec` is a headless run (claude -p, codex
// exec), usually a script or another agent.
export const Origin = z.enum(['desktop', 'cli', 'ide', 'exec', 'other']);
export type Origin = z.infer<typeof Origin>;

// What a session is doing now, as far as its files tell.
//   working   a turn is in progress and the file changed recently
//   needs-you the agent asked a question and nobody has answered
//   waiting   the turn ended but the agent scheduled itself to come back
//   finished  the last turn ended on its own
//   stopped   the person stopped the last turn
//   errored   the last turn ended on an API error
// Permission prompts never reach the files, so they cannot be told from a
// long command here; the in-app taps report those.
export const SessionState = z.enum(['working', 'needs-you', 'waiting', 'finished', 'stopped', 'errored']);
export type SessionState = z.infer<typeof SessionState>;

export const FileChange = z.object({
  path: z.string(),
  kind: z.enum(['add', 'modify', 'delete']),
  adds: z.number(),
  dels: z.number(),
  // Unified-diff lines (' ', '+', '-' prefixed), possibly cut short.
  lines: z.array(z.string()),
});
export type FileChange = z.infer<typeof FileChange>;

export const ToolCall = z.object({
  id: z.string(),
  // What ran: "Shell", "Read", "Edit", or a connector's tool name.
  name: z.string(),
  // The connector or service behind it ("Notion", "Linear"), when there is one.
  service: z.string().nullable(),
  // One line saying what it did: the command, the file, the query.
  detail: z.string(),
  output: z.string().nullable(),
  failed: z.boolean(),
  change: FileChange.nullable(),
  at: z.string().nullable(),
});
export type ToolCall = z.infer<typeof ToolCall>;

const at = z.string().nullable();

export const Entry = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    queued: z.boolean(),
    at,
  }),
  z.object({ kind: z.literal('steps'), calls: z.array(ToolCall) }),
  z.object({
    kind: z.literal('question'),
    questions: z.array(
      z.object({
        text: z.string(),
        options: z.array(z.object({ label: z.string(), hint: z.string().nullable() })),
        multi: z.boolean(),
      }),
    ),
    answers: z.array(z.string()).nullable(),
    at,
  }),
  z.object({ kind: z.literal('subagent'), title: z.string(), summary: z.string().nullable(), at }),
  z.object({ kind: z.literal('artifact'), url: z.string(), title: z.string(), at }),
  z.object({ kind: z.literal('widget'), title: z.string(), html: z.string(), at }),
  z.object({ kind: z.literal('pr'), url: z.string(), number: z.number(), repo: z.string(), at }),
  z.object({
    kind: z.literal('file'),
    path: z.string(),
    name: z.string(),
    image: z.boolean(),
    caption: z.string().nullable(),
    at,
  }),
  z.object({
    kind: z.literal('review'),
    verdict: z.string(),
    summary: z.string(),
    findings: z.array(z.object({ title: z.string(), body: z.string() })),
    at,
  }),
  z.object({ kind: z.literal('notice'), tone: z.enum(['info', 'error']), text: z.string(), at }),
]);
export type Entry = z.infer<typeof Entry>;
export type EntryOf<K extends Entry['kind']> = Extract<Entry, { kind: K }>;

export const Pr = z.object({ url: z.string(), number: z.number(), repo: z.string() });
export type Pr = z.infer<typeof Pr>;

export const SessionSummary = z.object({
  id: z.string(),
  profileId: z.string(),
  vendor: Vendor,
  title: z.string(),
  cwd: z.string().nullable(),
  branch: z.string().nullable(),
  origin: Origin,
  state: SessionState,
  updatedAt: z.string(),
  lastMessage: z.object({ role: z.enum(['user', 'assistant']), text: z.string() }).nullable(),
  // The agent's own task list, when it keeps one.
  plan: z.object({ done: z.number(), total: z.number(), current: z.string().nullable() }).nullable(),
  // What it asked, while state is needs-you.
  needs: z.string().nullable(),
  prs: z.array(Pr),
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummary>;

export const Transcript = z.object({
  session: SessionSummary,
  entries: z.array(Entry),
  // Byte position to pass back for the page before this one; null at the start.
  before: z.number().nullable(),
});
export type Transcript = z.infer<typeof Transcript>;
