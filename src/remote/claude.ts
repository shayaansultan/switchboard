// Claude sessions, as Claude Code writes them for the CLI and the desktop
// app's Code tab: one JSON-lines file per session under
// <home>/projects/<project>/<session id>.jsonl. Subagents write under
// <home>/projects/<project>/<session id>/, which this never lists.
//
// A session file interleaves the conversation (user and assistant records,
// tool calls as assistant blocks, their results as user blocks with a
// structured `toolUseResult` beside them) with bookkeeping records: titles,
// PR links, queued prompts, cost, compactions, API errors. This turns both
// into the shared model (model.ts).

import * as path from 'node:path';
import type { Entry, EntryOf, FileChange, Pr, SessionState, SessionSummary, ToolCall } from './model';
import { kindOf, mediaId } from './media';
import {
  arr,
  clip,
  cleanPrompt,
  diffCounts,
  head,
  listDir,
  mcpName,
  offsetOf,
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

export const STALE_MS = 10 * 60_000;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 512 * 1024;
export const PAGE_BYTES = 4 * 1024 * 1024;
const OUTPUT_LIMIT = 6000;
const TEXT_LIMIT = 40_000;

const ORIGINS: Record<string, SessionSummary['origin']> = {
  'claude-desktop': 'desktop',
  cli: 'cli',
  'sdk-cli': 'exec',
  'sdk-ts': 'exec',
  'sdk-py': 'exec',
  'claude-vscode': 'ide',
};

export function claudeFiles(home: string, since: number): FileInfo[] {
  const projects = path.join(home, 'projects');
  const files: FileInfo[] = [];
  for (const project of listDir(projects)) {
    const dir = path.join(projects, project);
    for (const name of listDir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const info = stat(path.join(dir, name));
      if (info && info.mtimeMs >= since) files.push(info);
    }
  }
  return files;
}

const isTurn = (r: Rec): boolean =>
  (r.type === 'user' || r.type === 'assistant') && r.isSidechain !== true && r.isMeta !== true;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  return arr(content)
    .map(obj)
    .filter((b) => b.type === 'text')
    .map((b) => str(b.text) ?? '')
    .join('\n');
}

function isToolResult(r: Rec): boolean {
  return arr(obj(r.message).content).some((b) => obj(b).type === 'tool_result');
}

function prompt(r: Rec): string {
  return isToolResult(r) ? '' : cleanPrompt(textOf(obj(r.message).content));
}

const INTERRUPTED = '[Request interrupted';

// ---- tool calls ----

function patchLines(hunks: unknown): string[] {
  const lines: string[] = [];
  for (const h of arr(hunks).map(obj)) {
    lines.push(
      `@@ -${num(h.oldStart) ?? 0},${num(h.oldLines) ?? 0} +${num(h.newStart) ?? 0},${num(h.newLines) ?? 0} @@`,
    );
    for (const l of arr(h.lines)) if (typeof l === 'string') lines.push(l);
  }
  return lines;
}

function change(name: string, input: Rec, result: Rec): FileChange | null {
  const file = str(input.file_path) ?? str(input.notebook_path) ?? str(result.filePath);
  if (!file) return null;
  if (name === 'Write' && !str(result.originalFile) && !arr(result.structuredPatch).length) {
    const body = (str(input.content) ?? '').split('\n');
    return { path: file, kind: 'add', adds: body.length, dels: 0, lines: body.slice(0, 400).map((l) => '+' + l) };
  }
  const lines = patchLines(result.structuredPatch);
  if (!lines.length) return null;
  return { path: file, kind: 'modify', ...diffCounts(lines), lines: lines.slice(0, 400) };
}

const SHORT_INPUT = [
  'command',
  'file_path',
  'notebook_path',
  'path',
  'pattern',
  'url',
  'query',
  'skill',
  'description',
  'reason',
  'to',
  'prompt',
];

function detail(input: Rec, fallback: string): string {
  for (const key of SHORT_INPUT) {
    const v = str(input[key]);
    if (v) return oneLine(v, 400);
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.length < 300);
  return typeof first === 'string' ? oneLine(first, 400) : fallback;
}

const NAMES: Record<string, string> = {
  Bash: 'Shell',
  MultiEdit: 'Edit',
  NotebookEdit: 'Edit',
  Grep: 'Search',
  Glob: 'Find files',
};

function outputOf(block: Rec, result: Rec): string | null {
  const out = str(result.stdout) ?? textOf(block.content);
  const err = str(result.stderr);
  const text = [out, err].filter((t) => t && t.trim()).join('\n');
  return text ? clip(text, OUTPUT_LIMIT) : null;
}

// Tools that become an entry of their own rather than a step.
const SPECIAL = new Set([
  'AskUserQuestion',
  'Agent',
  'Task',
  'Artifact',
  'SendUserFile',
  'mcp__visualize__show_widget',
]);
// Tools that only feed the summary.
const PLAN = new Set(['mcp__ccd_turn__update_plan', 'TodoWrite']);
// The desktop app's own turn plumbing (task list, wrap-up box): not work.
const PLUMBING = /^mcp__ccd_turn__/;

interface Pending {
  call?: ToolCall;
  entry?: Entry;
  name: string;
  input: Rec;
}

// Records into entries, in order. Consecutive tool calls share one `steps`
// entry; a prompt, a reply or a special entry closes it.
export function claudeEntries(records: Rec[], file = ''): Entry[] {
  const entries: Entry[] = [];
  const byId = new Map<string, Pending>();
  const frames = new Map<string, { url: string; title: string }>();
  for (const r of records)
    if (r.type === 'frame-link' && str(r.path) && str(r.frameUrl))
      frames.set(str(r.path)!, { url: str(r.frameUrl)!, title: str(r.title) ?? path.basename(str(r.path)!) });
  let steps: EntryOf<'steps'> | null = null;
  const push = (e: Entry) => {
    steps = null;
    entries.push(e);
  };
  const queue: string[] = [];
  // Claude records a session's PR again on later turns; show it once.
  const prsShown = new Set<string>();

  for (const r of records) {
    const at = str(r.timestamp);
    if (r.type === 'queue-operation') {
      const content = str(r.content);
      if (r.operation === 'enqueue' && content) queue.push(content);
      else if (r.operation === 'dequeue') queue.shift();
      else if (r.operation === 'remove') {
        const i = content ? queue.indexOf(content) : -1;
        queue.splice(i < 0 ? 0 : i, 1);
      }
      continue;
    }
    if (r.type === 'pr-link' && str(r.prUrl)) {
      if (prsShown.has(str(r.prUrl)!)) continue;
      prsShown.add(str(r.prUrl)!);
      push({ kind: 'pr', url: str(r.prUrl)!, number: num(r.prNumber) ?? 0, repo: str(r.prRepository) ?? '', at });
      continue;
    }
    if (r.type === 'system') {
      if (r.subtype === 'compact_boundary') push({ kind: 'notice', tone: 'info', text: 'Context compacted', at });
      else if (r.subtype === 'api_error')
        push({
          kind: 'notice',
          tone: 'error',
          text: oneLine(str(r.content) ?? str(obj(r.error).message) ?? 'API error', 300),
          at,
        });
      continue;
    }
    if (!isTurn(r)) continue;
    const content = obj(r.message).content;

    if (r.type === 'user') {
      const result = obj(r.toolUseResult);
      // Where this record's line starts, for media ids of images stored in it.
      const offset = offsetOf(r);
      const image = (b: number[]) => (file && offset !== undefined ? mediaId({ f: file, o: offset, b }) : null);
      const pasted: string[] = [];
      arr(content).forEach((raw, i) => {
        if (obj(raw).type !== 'image') return;
        const id = image([i]);
        if (id) pasted.push(id);
      });
      for (const [i, b] of arr(content).map(obj).entries()) {
        if (b.type !== 'tool_result') continue;
        const pending = byId.get(str(b.tool_use_id) ?? '');
        if (!pending) continue;
        if (pending.call) {
          for (const [j, inner] of arr(b.content).map(obj).entries()) {
            const id = inner.type === 'image' ? image([i, j]) : null;
            if (id) pending.call.images.push(id);
          }
          pending.call.output = outputOf(b, result);
          pending.call.failed = b.is_error === true || result.interrupted === true;
          pending.call.change = change(pending.name, pending.input, result);
        } else if (pending.entry?.kind === 'question') {
          const answers = Object.values(obj(result.answers)).filter((v): v is string => typeof v === 'string');
          pending.entry.answers = answers.length ? answers : [oneLine(textOf(b.content), 300)];
        } else if (pending.entry?.kind === 'subagent') {
          pending.entry.summary = clip(textOf(b.content), 600) || null;
        } else if (pending.entry?.kind === 'artifact' && !pending.entry.url) {
          pending.entry.url = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/.exec(textOf(b.content))?.[0] ?? '';
        }
      }
      const text = prompt(r);
      if (text.startsWith(INTERRUPTED)) push({ kind: 'notice', tone: 'info', text: 'Stopped by you', at });
      else if (text) push({ kind: 'message', role: 'user', text: clip(text, TEXT_LIMIT), queued: false, at });
      for (const id of pasted) push({ kind: 'image', from: 'you', mediaId: id, at });
      continue;
    }

    for (const b of arr(content).map(obj)) {
      if (b.type === 'text' && str(b.text)?.trim()) {
        push({ kind: 'message', role: 'assistant', text: clip(str(b.text)!, TEXT_LIMIT), queued: false, at });
        continue;
      }
      if (b.type !== 'tool_use') continue;
      const name = str(b.name) ?? 'tool';
      const input = obj(b.input);
      const id = str(b.id) ?? '';
      if (PLAN.has(name) || PLUMBING.test(name)) continue;
      if (SPECIAL.has(name)) {
        let entry: Entry | null = null;
        if (name === 'AskUserQuestion') {
          entry = {
            kind: 'question',
            questions: arr(input.questions)
              .map(obj)
              .map((q) => ({
                text: str(q.question) ?? '',
                options: arr(q.options)
                  .map(obj)
                  .map((o) => ({ label: str(o.label) ?? '', hint: str(o.description) })),
                multi: q.multiSelect === true,
              })),
            answers: null,
            at,
          };
        } else if (name === 'Agent' || name === 'Task') {
          entry = { kind: 'subagent', title: str(input.description) ?? 'Subagent', summary: null, at };
        } else if (name === 'Artifact') {
          const file = str(input.file_path);
          const frame = file ? frames.get(file) : undefined;
          entry = {
            kind: 'artifact',
            url: frame?.url ?? '',
            title: frame?.title ?? (file ? path.basename(file, path.extname(file)) : 'Artifact'),
            at,
          };
        } else if (name === 'mcp__visualize__show_widget') {
          entry = { kind: 'widget', title: str(input.title) ?? 'Visual', html: str(input.widget_code) ?? '', at };
        } else if (name === 'SendUserFile') {
          for (const f of arr(input.files).filter((x): x is string => typeof x === 'string'))
            push({
              kind: 'file',
              path: f,
              name: path.basename(f),
              type: kindOf(f),
              mediaId: mediaId({ p: f }),
              caption: str(input.caption),
              at,
            });
          continue;
        }
        if (entry) {
          push(entry);
          byId.set(id, { entry, name, input });
        }
        continue;
      }
      const mcp = mcpName(name);
      const call: ToolCall = {
        id,
        name: mcp ? mcp.name : (NAMES[name] ?? name),
        service: mcp?.service ?? null,
        detail: detail(input, mcp ? mcp.name : name),
        output: null,
        failed: false,
        change: null,
        images: [],
        at,
      };
      if (!steps) {
        steps = { kind: 'steps', calls: [] };
        entries.push(steps);
      }
      steps.calls.push(call);
      byId.set(id, { call, name, input });
    }
  }
  for (const text of queue)
    entries.push({ kind: 'message', role: 'user', text: clip(cleanPrompt(text), TEXT_LIMIT), queued: true, at: null });
  return entries.filter((e) => e.kind !== 'artifact' || e.url);
}

// ---- summary ----

function plan(records: Rec[]): SessionSummary['plan'] {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.type !== 'assistant') continue;
    const blocks = arr(obj(r.message).content).map(obj);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const b = blocks[j];
      if (b.type !== 'tool_use' || !PLAN.has(str(b.name) ?? '')) continue;
      const input = obj(b.input);
      const items = arr(input.items ?? input.todos).map(obj);
      if (!items.length) continue;
      const done = items.filter((t) => t.status === 'completed').length;
      const now = items.find((t) => t.status === 'in_progress');
      return { done, total: items.length, current: now ? (str(now.content) ?? str(now.activeForm)) : null };
    }
  }
  return null;
}

function stateOf(records: Rec[], info: FileInfo, now: number): { state: SessionState; needs: string | null } {
  const turns = records.filter((r) => isTurn(r) || (r.type === 'system' && r.subtype === 'api_error'));
  const answered = new Set<string>();
  for (const r of turns)
    if (r.type === 'user')
      for (const b of arr(obj(r.message).content).map(obj))
        if (b.type === 'tool_result') answered.add(str(b.tool_use_id) ?? '');
  for (let i = turns.length - 1; i >= 0; i--) {
    const r = turns[i];
    if (r.type !== 'assistant') continue;
    const ask = arr(obj(r.message).content)
      .map(obj)
      .find((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion' && !answered.has(str(b.id) ?? ''));
    if (ask)
      return {
        state: 'needs-you',
        needs: oneLine(str(obj(arr(obj(ask.input).questions)[0]).question) ?? 'A question for you', 200),
      };
    break;
  }
  const last = turns[turns.length - 1];
  if (!last) return { state: 'finished', needs: null };
  if (last.type === 'system') return { state: 'errored', needs: null };
  if (last.type === 'user' && prompt(last).startsWith(INTERRUPTED)) return { state: 'stopped', needs: null };
  const stop = last.type === 'assistant' ? str(obj(last.message).stop_reason) : null;
  const ended = stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens';
  if (!ended && now - info.mtimeMs < STALE_MS) return { state: 'working', needs: null };
  // A turn that scheduled its own return is waiting, not finished.
  for (let i = records.length - 1; i >= 0; i--) {
    const at = num(obj(records[i].toolUseResult).scheduledFor);
    if (at !== null) return { state: at > now ? 'waiting' : 'finished', needs: null };
  }
  return { state: 'finished', needs: null };
}

export function summarizeClaude(profileId: string, info: FileInfo, now = Date.now()): SessionSummary | null {
  const top = head(info, HEAD_BYTES);
  const end = info.size > HEAD_BYTES ? tail(info, TAIL_BYTES) : top;
  const first = top.find((r) => typeof r.sessionId === 'string');
  if (!first) return null;
  if (!top.some(isTurn) && !end.some(isTurn)) return null;
  const all = [...top, ...end];
  let title: string | null = null;
  for (const r of all) if (r.type === 'custom-title' && str(r.customTitle)) title = str(r.customTitle);
  if (!title) {
    const p = top
      .filter((r) => r.type === 'user' && isTurn(r))
      .find((r) => prompt(r) && !prompt(r).startsWith(INTERRUPTED));
    title = p ? oneLine(prompt(p), 80) : null;
  }
  const latest = [...end].reverse();
  const meta = latest.find((r) => typeof r.cwd === 'string') ?? top.find((r) => typeof r.cwd === 'string') ?? {};
  const model = str(obj(latest.find((r) => r.type === 'assistant' && str(obj(r.message).model))?.message).model);
  const cost = num(latest.find((r) => r.type === 'cost-state')?.totalCostUSD);
  const prs = new Map<string, Pr>();
  for (const r of all)
    if (r.type === 'pr-link' && str(r.prUrl))
      prs.set(str(r.prUrl)!, { url: str(r.prUrl)!, number: num(r.prNumber) ?? 0, repo: str(r.prRepository) ?? '' });
  const entries = claudeEntries(end, info.file);
  const lastMessage = [...entries].reverse().find((e): e is EntryOf<'message'> => e.kind === 'message' && !e.queued);
  const { state, needs } = stateOf(end, info, now);
  return {
    id: str(first.sessionId)!,
    profileId,
    vendor: 'claude',
    title: title || 'Untitled session',
    cwd: str(meta.cwd),
    branch: str(meta.gitBranch) || null,
    origin: ORIGINS[str(meta.entrypoint) ?? ''] ?? 'other',
    state,
    updatedAt: new Date(info.mtimeMs).toISOString(),
    lastMessage: lastMessage ? { role: lastMessage.role, text: oneLine(lastMessage.text, 280) } : null,
    plan: plan(end),
    needs,
    prs: [...prs.values()],
    model: model && model !== '<synthetic>' ? model : null,
    costUsd: cost,
  };
}

// A page of entries ending at byte `before` (the end of the file when null).
export function claudePage(info: FileInfo, before: number | null): { entries: Entry[]; before: number | null } {
  const { records, start } = window(info, before ?? info.size, PAGE_BYTES);
  return { entries: claudeEntries(records, info.file), before: start > 0 ? start : null };
}
