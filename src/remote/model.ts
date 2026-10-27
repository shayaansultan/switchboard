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
//   working   a turn is in progress and the file changed recently, or
//             work the session started in the background is still running
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
  // Pictures the tool returned (a screenshot), as media ids for /api/media/.
  images: z.array(z.string()),
  at: z.string().nullable(),
  // Set when a transcript page carries only the start of a long output
  // (api.ts): the whole call comes from the page at this cursor.
  cut: z.object({ cursor: z.number().nullable() }).optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

const at = z.string().nullable();

// What a file is, for how the phone shows it: inline, in a sandboxed page, or
// as a download. See media.ts.
export const MediaKind = z.enum(['image', 'html', 'pdf', 'text', 'other']);

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
  z.object({
    kind: z.literal('subagent'),
    title: z.string(),
    summary: z.string().nullable(),
    // For one started in the background, how it is going.
    status: z.enum(['running', 'done', 'stopped', 'failed']).nullable(),
    at,
  }),
  // Something that arrived in the conversation without being typed: a
  // background task finishing, or a message from a subagent or another session.
  z.object({
    kind: z.literal('event'),
    source: z.enum(['task', 'peer']),
    title: z.string(),
    status: z.string().nullable(),
    body: z.string().nullable(),
    at,
  }),
  z.object({ kind: z.literal('artifact'), url: z.string(), title: z.string(), at }),
  z.object({ kind: z.literal('widget'), title: z.string(), html: z.string(), at }),
  z.object({ kind: z.literal('pr'), url: z.string(), number: z.number(), repo: z.string(), at }),
  z.object({
    // A file the agent sent you or looked at, servable by its media id.
    kind: z.literal('file'),
    path: z.string(),
    name: z.string(),
    type: MediaKind,
    mediaId: z.string(),
    caption: z.string().nullable(),
    at,
  }),
  // A picture in the conversation itself: one you pasted, or one the agent
  // attached to its reply.
  z.object({ kind: z.literal('image'), from: z.enum(['you', 'agent']), mediaId: z.string(), at }),
  z.object({
    kind: z.literal('review'),
    verdict: z.string(),
    summary: z.string(),
    findings: z.array(z.object({ title: z.string(), body: z.string() })),
    at,
  }),
  z.object({ kind: z.literal('notice'), tone: z.enum(['info', 'error']), text: z.string(), at }),
  // The box Claude Desktop shows at the end of a turn: what is now true, and
  // a question with buttons whose answers are replies (mcp__ccd_turn__wrap_up).
  z.object({
    kind: z.literal('next'),
    recap: z.string(),
    ask: z.string().nullable(),
    // Each button's reply; app actions (commit, open a PR) are left out.
    replies: z.array(z.object({ label: z.string(), message: z.string() })),
    at,
  }),
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
  // Background agents, commands and monitors still running.
  background: z.number(),
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
  // Files the session made outside the conversation (Codex visualizations).
  files: z.array(z.object({ name: z.string(), type: MediaKind, mediaId: z.string(), size: z.number() })),
});
export type Transcript = z.infer<typeof Transcript>;
