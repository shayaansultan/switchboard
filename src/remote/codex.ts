// Codex threads, as the Codex engine writes them for the CLI, the IDE and the
// ChatGPT app: one rollout per thread under <home>/sessions/YYYY/MM/DD/, its
// first line a session_meta, then the turn's events. Codex also keeps an index
// in <home>/state_5.sqlite: every thread's rollout path, title, branch, model
// and origin, and which threads are subagents of which. The list comes from
// that index when it can be read and from the folders when it cannot.
//
// The index is read through node:sqlite, read-only, while the app writes it:
// a read may miss the last moment of a write, which is fine for display.
// Agents' messages to each other are encrypted in the rollout, so a subagent
// shows only its task name.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Entry, EntryOf, FileChange, SessionState, SessionSummary, ToolCall, Transcript } from './model';
import {
  arr,
  clip,
  cleanPrompt,
  diffCounts,
  head,
  listDir,
  num,
  obj,
  oneLine,
  stat,
  str,
  tail,
  window,
  type FileInfo,
  type Rec,
} from './jsonl';
import { PAGE_BYTES, STALE_MS } from './claude';
import { kindOf, mediaId } from './media';

const HEAD_BYTES = 64 * 1024;
// Codex puts its instructions ahead of the first prompt; they can pass 64 KB.
const LONG_HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 512 * 1024;
const OUTPUT_LIMIT = 6000;
const TEXT_LIMIT = 40_000;

const ORIGINS: Record<string, SessionSummary['origin']> = {
  'Codex Desktop': 'desktop',
  codex_cli_rs: 'cli',
  codex_vscode: 'ide',
  codex_exec: 'exec',
};

export interface CodexThread {
  id: string;
  info: FileInfo;
  title: string | null;
  branch: string | null;
  model: string | null;
  origin: SessionSummary['origin'] | null;
}

// Recent top-level threads, newest first.
export function codexThreads(home: string, since: number, limit: number): CodexThread[] {
  const threads = indexedThreads(home, since, limit) ?? scannedThreads(home, since);
  const names = threadNames(home);
  for (const t of threads) t.title ??= names.get(t.id) ?? null;
  return threads;
}

// Thread renames, one line each in session_index.jsonl, the latest winning.
// Older Codex builds keep names only here.
const nameCache = new Map<string, { mtimeMs: number; names: Map<string, string> }>();
function threadNames(home: string): Map<string, string> {
  const file = path.join(home, 'session_index.jsonl');
  const info = stat(file);
  if (!info) return new Map();
  const cached = nameCache.get(home);
  if (cached?.mtimeMs === info.mtimeMs) return cached.names;
  const names = new Map<string, string>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    try {
      const r = obj(JSON.parse(line));
      if (str(r.id) && str(r.thread_name)) names.set(str(r.id)!, str(r.thread_name)!);
    } catch {
      // A line being written.
    }
  }
  nameCache.set(home, { mtimeMs: info.mtimeMs, names });
  return names;
}

function indexedThreads(home: string, since: number, limit: number): CodexThread[] | null {
  const file = path.join(home, 'state_5.sqlite');
  if (!stat(file)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        `select id, rollout_path, name, title, git_branch, model, originator, source, updated_at_ms
           from threads
          where archived = 0 and updated_at_ms >= ?
            and id not in (select child_thread_id from thread_spawn_edges)
          order by updated_at_ms desc limit ?`,
      )
      .all(since, limit * 3) as Rec[];
    const threads: CodexThread[] = [];
    for (const r of rows) {
      const info = stat(str(r.rollout_path) ?? '');
      if (!info) continue;
      const source = str(r.source) ?? '';
      if (source.includes('subagent')) continue;
      threads.push({
        id: str(r.id)!,
        info,
        title: str(r.name) || null,
        branch: str(r.git_branch) || null,
        model: str(r.model) || null,
        origin: ORIGINS[str(r.originator) ?? ''] ?? (source === 'exec' ? 'exec' : source === 'vscode' ? 'ide' : null),
      });
    }
    return threads;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function scannedThreads(home: string, since: number): CodexThread[] {
  const threads: CodexThread[] = [];
  const now = Date.now();
  // A rollout stays in the folder of the day it started.
  for (let t = since - 24 * 3600_000; t <= now + 24 * 3600_000; t += 24 * 3600_000) {
    const d = new Date(t);
    const dir = path.join(
      home,
      'sessions',
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    for (const name of listDir(dir)) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const info = stat(path.join(dir, name));
      // The file name ends in the thread id; the summary confirms it from session_meta.
      const fromName = /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(name)?.[1];
      const id =
        fromName ??
        (info ? (str(obj(head(info, HEAD_BYTES).find((r) => r.type === 'session_meta')?.payload).id) ?? '') : '');
      if (info && info.mtimeMs >= since)
        threads.push({ id, info, title: null, branch: null, model: null, origin: null });
    }
  }
  return threads.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
}

// ---- records ----

function item(r: Rec): Rec | null {
  const p = obj(r.payload);
  return r.type === 'event_msg' && p.type === 'item_completed' ? obj(p.item) : null;
}

function textOf(it: Rec): string {
  return arr(it.content)
    .map(obj)
    .filter((b) => /^(input_|output_)?text$/i.test(str(b.type) ?? ''))
    .map((b) => str(b.text) ?? '')
    .join('\n');
}

function command(it: Rec): string {
  const c = it.command;
  if (Array.isArray(c)) {
    const parts = c.filter((x): x is string => typeof x === 'string');
    const shell = parts.length >= 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1]);
    return shell ? parts.slice(2).join(' ') : parts.join(' ');
  }
  return str(c) ?? '';
}

function fileChanges(it: Rec): FileChange[] {
  const changes = obj(it.changes);
  return Object.entries(changes).map(([file, raw]) => {
    const c = obj(raw);
    if (c.type === 'add') {
      const body = (str(c.content) ?? '').split('\n');
      return {
        path: file,
        kind: 'add' as const,
        adds: body.length,
        dels: 0,
        lines: body.slice(0, 400).map((l) => '+' + l),
      };
    }
    if (c.type === 'delete') return { path: file, kind: 'delete' as const, adds: 0, dels: 0, lines: [] };
    const lines = (str(c.unified_diff) ?? '').split('\n').filter((l) => l !== '');
    return { path: file, kind: 'modify' as const, ...diffCounts(lines), lines: lines.slice(0, 400) };
  });
}

function args(p: Rec): Rec {
  try {
    return obj(JSON.parse(str(p.arguments) ?? '{}'));
  } catch {
    return {};
  }
}

export function codexEntries(records: Rec[]): Entry[] {
  const entries: Entry[] = [];
  let steps: EntryOf<'steps'> | null = null;
  const push = (e: Entry) => {
    steps = null;
    entries.push(e);
  };
  const step = (call: ToolCall) => {
    if (!steps) {
      steps = { kind: 'steps', calls: [] };
      entries.push(steps);
    }
    steps.calls.push(call);
  };
  let openQuestion: EntryOf<'question'> | null = null;

  for (const r of records) {
    const at = str(r.timestamp);
    const p = obj(r.payload);
    if (r.type === 'compacted') {
      push({ kind: 'notice', tone: 'info', text: 'Context compacted', at });
      continue;
    }
    if (r.type === 'event_msg' && p.type === 'turn_aborted') {
      push({ kind: 'notice', tone: 'info', text: 'Stopped by you', at });
      continue;
    }
    if (r.type === 'response_item' && p.type === 'function_call') {
      const a = args(p);
      if (p.name === 'request_user_input_async') {
        openQuestion = {
          kind: 'question',
          questions: arr(a.questions)
            .map(obj)
            .map((q) => ({
              text: str(q.title) ?? str(q.question) ?? '',
              options: arr(q.options).map((o) =>
                typeof o === 'string'
                  ? { label: o, hint: null }
                  : { label: str(obj(o).label) ?? '', hint: str(obj(o).description) },
              ),
              multi: false,
            })),
          answers: null,
          at,
        };
        push(openQuestion);
      } else if (p.name === 'spawn_agent') {
        push({ kind: 'subagent', title: (str(a.task_name) ?? 'Subagent').replace(/_/g, ' '), summary: null, at });
      }
      continue;
    }
    const it = item(r);
    if (!it) continue;
    switch (it.type) {
      case 'UserMessage': {
        const text = cleanPrompt(textOf(it));
        if (!text) break;
        if (openQuestion && !openQuestion.answers) openQuestion.answers = [oneLine(text, 300)];
        openQuestion = null;
        push({ kind: 'message', role: 'user', text: clip(text, TEXT_LIMIT), queued: false, at });
        break;
      }
      case 'AgentMessage': {
        const text = textOf(it);
        if (text.trim()) push({ kind: 'message', role: 'assistant', text: clip(text, TEXT_LIMIT), queued: false, at });
        break;
      }
      case 'CommandExecution': {
        const exit = num(it.exit_code);
        const out = str(it.aggregated_output) ?? str(it.formatted_output) ?? '';
        step({
          id: str(it.id) ?? '',
          name: 'Shell',
          service: null,
          detail: oneLine(command(it), 400),
          output: out.trim() ? clip(out, OUTPUT_LIMIT) : null,
          failed: exit !== null && exit !== 0,
          change: null,
          images: [],
          at,
        });
        break;
      }
      case 'FileChange':
        for (const c of fileChanges(it))
          step({
            id: (str(it.id) ?? '') + c.path,
            name: 'Edit',
            service: null,
            detail: c.path,
            output: null,
            failed: it.status === 'failed',
            change: c,
            images: [],
            at,
          });
        break;
      case 'McpToolCall': {
        const result = obj(it.result);
        const out = arr(result.content)
          .map(obj)
          .map((b) => str(b.text) ?? '')
          .join('\n');
        const server = str(it.server) ?? 'Connector';
        step({
          id: str(it.id) ?? '',
          name: (str(it.tool) ?? 'call').replace(/[-_]+/g, ' '),
          service: server.replace(/[-_]+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()),
          detail: oneLine(JSON.stringify(it.arguments ?? {}), 300),
          output: out.trim() ? clip(out, OUTPUT_LIMIT) : null,
          failed: result.isError === true || it.status === 'failed',
          change: null,
          images: [],
          at,
        });
        break;
      }
      case 'Extension':
        if (it.kind === 'web.search')
          step({
            id: str(it.id) ?? '',
            name: 'Web search',
            service: null,
            detail: oneLine(str(it.query) ?? JSON.stringify(it.query ?? ''), 300),
            output: null,
            failed: false,
            change: null,
            images: [],
            at,
          });
        break;
      case 'ImageView': {
        const file = str(it.path);
        if (file)
          step({
            id: str(it.id) ?? file,
            name: 'View image',
            service: null,
            detail: file,
            output: null,
            failed: false,
            change: null,
            images: [mediaId({ p: file })],
            at,
          });
        break;
      }
      case 'ContextCompaction':
        push({ kind: 'notice', tone: 'info', text: 'Context compacted', at });
        break;
      case 'ExitedReviewMode': {
        const out = obj(it.review_output);
        push({
          kind: 'review',
          verdict: (str(out.overall_correctness) ?? 'Review').replace(/_/g, ' '),
          summary: str(out.overall_explanation) ?? '',
          findings: arr(out.findings)
            .map(obj)
            .map((f) => ({ title: str(f.title) ?? 'Finding', body: str(f.body) ?? str(f.description) ?? '' })),
          at,
        });
        break;
      }
    }
  }
  return entries;
}

// ---- summary ----

function stateOf(records: Rec[], info: FileInfo, now: number): { state: SessionState; needs: string | null } {
  let started = -1;
  let ended = -1;
  let aborted = -1;
  let asked = -1;
  let answered = -1;
  let question: string | null = null;
  records.forEach((r, i) => {
    const p = obj(r.payload);
    if (r.type === 'event_msg' && p.type === 'task_started') started = i;
    if (r.type === 'event_msg' && p.type === 'task_complete') ended = i;
    if (r.type === 'event_msg' && p.type === 'turn_aborted') aborted = ended = i;
    if (r.type === 'response_item' && p.type === 'function_call' && p.name === 'request_user_input_async') {
      asked = i;
      const q = obj(arr(args(p).questions)[0]);
      question = str(q.title) ?? str(q.question);
    }
    if (item(r)?.type === 'UserMessage') answered = i;
  });
  if (asked > answered) return { state: 'needs-you', needs: question ? oneLine(question, 200) : 'A question for you' };
  if (started > ended && now - info.mtimeMs < STALE_MS) return { state: 'working', needs: null };
  if (aborted >= 0 && aborted === ended) return { state: 'stopped', needs: null };
  return { state: 'finished', needs: null };
}

// `codex exec` records its prompt only as a model input, after the context
// Codex injects in the same role, each part of which opens with a tag or a heading.
function execPrompt(records: Rec[]): string | null {
  for (const r of records) {
    const p = obj(r.payload);
    if (r.type !== 'response_item' || p.type !== 'message' || p.role !== 'user') continue;
    for (const b of arr(p.content).map(obj)) {
      const text = cleanPrompt(str(b.text) ?? '');
      if (text && !/^(<|# )/.test(text)) return text;
    }
  }
  return null;
}

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

export function summarizeCodex(profileId: string, thread: CodexThread, now = Date.now()): SessionSummary | null {
  const { info } = thread;
  let top = head(info, HEAD_BYTES);
  if (!top.some((r) => r.type === 'session_meta') && info.size > HEAD_BYTES) top = head(info, LONG_HEAD_BYTES);
  const meta = obj(top.find((r) => r.type === 'session_meta')?.payload);
  if (obj(meta.source).subagent !== undefined || str(meta.parent_thread_id)) return null;
  const end = info.size > HEAD_BYTES ? tail(info, TAIL_BYTES) : top;
  const entries = codexEntries(end);
  const messages = entries.filter((e): e is EntryOf<'message'> => e.kind === 'message');
  if (!messages.length && !top.some((r) => item(r)?.type === 'UserMessage') && !execPrompt(top)) return null;

  let title = thread.title;
  if (!title) {
    const first = top.map(item).find((it) => it?.type === 'UserMessage' && cleanPrompt(textOf(it)));
    const text = first
      ? cleanPrompt(textOf(first))
      : (execPrompt(top) ?? execPrompt(info.size > HEAD_BYTES ? head(info, LONG_HEAD_BYTES) : top));
    title = text ? oneLine(text, 80) : null;
  }
  const context = [...end].reverse().find((r) => r.type === 'turn_context');
  const prs = new Map<string, { url: string; number: number; repo: string }>();
  for (const m of messages)
    if (m.role === 'assistant')
      for (const x of m.text.matchAll(PR_URL)) prs.set(x[0], { url: x[0], number: Number(x[2]), repo: x[1] });
  const last = messages[messages.length - 1];
  const { state, needs } = stateOf(end, info, now);
  return {
    id: str(meta.id) ?? thread.id,
    profileId,
    vendor: 'codex',
    title: title || 'Untitled thread',
    cwd: str(meta.cwd),
    branch: thread.branch ?? (str(obj(meta.git).branch) || null),
    origin: thread.origin ?? ORIGINS[str(meta.originator) ?? ''] ?? 'other',
    state,
    updatedAt: new Date(info.mtimeMs).toISOString(),
    lastMessage: last ? { role: last.role, text: oneLine(last.text, 280) } : null,
    plan: null,
    needs,
    prs: [...prs.values()],
    model: thread.model ?? str(obj(context?.payload).model),
    costUsd: null,
  };
}

export function codexPage(info: FileInfo, before: number | null): { entries: Entry[]; before: number | null } {
  const { records, start } = window(info, before ?? info.size, PAGE_BYTES);
  return { entries: codexEntries(records), before: start > 0 ? start : null };
}

// Files Codex made for a thread outside the conversation: its
// visualizations, under <home>/visualizations/YYYY/MM/DD/<thread id>/.
export function codexFiles(home: string, threadId: string): Transcript['files'] {
  const root = path.join(home, 'visualizations');
  const files: Transcript['files'] = [];
  for (const y of listDir(root))
    for (const m of listDir(path.join(root, y)))
      for (const d of listDir(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d, threadId);
        const walk = (at: string, depth: number) => {
          for (const name of listDir(at)) {
            const full = path.join(at, name);
            const info = stat(full);
            if (info)
              files.push({
                name: path.relative(dir, full),
                type: kindOf(name),
                mediaId: mediaId({ p: full }),
                size: info.size,
              });
            else if (depth < 2) walk(full, depth + 1);
          }
        };
        walk(dir, 0);
      }
  return files.slice(0, 50);
}
