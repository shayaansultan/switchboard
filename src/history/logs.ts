// Reading the logs Claude Code and Codex already write for themselves, one
// line at a time, into model calls and facts about their sessions. Nothing
// here touches the disk; ledger.ts feeds it the new lines of each file.
//
// Claude Code writes one JSON object per line under
// <CLAUDE_CONFIG_DIR>/projects/<project>/<session>.jsonl, and subagents under
// <session>/subagents/. A response is written once per content block, each
// copy carrying the same usage, so calls are keyed by message and request id
// for the ledger to count once. A resumed session's file opens with a copy of
// the earlier conversation under the new session id; every line keeps its
// uuid, so notes are keyed by it and a copy is not counted again. Every line
// names its session and folder, and a call carries the folder itself, so a
// response line only becomes a note when it used tools: that keeps the
// ledger's record of lines seen to prompts, tool calls and responses.
//
// Codex writes <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, a header
// line naming the session and then events. A prompt is a user message
// (some builds also emit it as an event). A subagent's rollout names
// itself first and then carries its parent's header in the history it
// replays; only the first header is the file's own. Newer builds record each
// response's usage (`token_usage_record`, keyed by response id); older ones
// only emit running totals (`token_count`), which are counted as the rise
// since the last total. A subagent's rollout opens by replaying its parent's
// history, which is skipped until the subagent's own turn starts.

import * as crypto from 'node:crypto';
import type { SessionEntry, TokenCounts } from '../types';

export interface Call {
  // Identifies a response across files, so a copy is counted once; null when
  // the log offers nothing stable.
  key: string | null;
  at: number;
  session: string;
  model: string;
  tokens: TokenCounts;
  // The part of cacheWrite kept for an hour, priced higher.
  cacheWriteLong: number;
  subagent: boolean;
  // Where and how the session ran, when the line says.
  cwd?: string;
  entry?: SessionEntry;
}

// Something learned about a session at a moment: where it ran, what it was
// asked, what tools it used and which files it edited.
export interface Note {
  // The line's own id, so a copy of it is applied once; null when the log
  // offers nothing stable.
  key?: string;
  session: string;
  at: number;
  cwd?: string;
  title?: string;
  entry?: SessionEntry;
  prompts?: number;
  tools?: string[];
  files?: string[];
}

export interface Parsed {
  calls: Call[];
  notes: Note[];
}

// What a Codex rollout's earlier lines established, kept between reads.
export interface CodexContext {
  session?: string;
  cwd?: string;
  model?: string;
  entry?: SessionEntry;
  subagent?: boolean;
  replaying?: boolean;
  // Whether this file records per-response usage, which then wins over
  // the running totals.
  records?: boolean;
  total?: number;
  last?: TokenCounts;
  // The last prompt counted, by a hash of its text, so a build that records
  // a prompt both as an event and as a message counts it once. Only the hash
  // is kept: this context is saved in the ledger.
  prompt?: { hash: string; at: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// A short, stable key for a longer one, for the ledger to store.
export const shortKey = (key: string): string => crypto.createHash('sha1').update(key).digest('base64').slice(0, 12);

// An id the ledger can file things under. `__proto__` would name the
// object's prototype rather than a key of its own.
const usableId = (x: unknown): x is string => typeof x === 'string' && x !== '' && x !== '__proto__';

function json(line: string): Json | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);

function time(x: unknown): number | null {
  const t = typeof x === 'string' ? Date.parse(x) : NaN;
  return Number.isNaN(t) ? null : t;
}

// A prompt as a session title: its first line of plain text, without the
// tags slash commands and reminders wrap around it.
export function titleFrom(text: string): string | undefined {
  const plain = text
    .replace(/<([a-z-]+)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!plain || plain.startsWith('[Request interrupted') || plain.startsWith('Caveat:')) return undefined;
  return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain;
}

function claudeEntry(entrypoint: unknown): SessionEntry {
  const e = String(entrypoint ?? 'cli').toLowerCase();
  if (e === 'cli') return 'cli';
  if (e.includes('desktop')) return 'desktop';
  if (e.includes('sdk')) return 'sdk';
  return 'other';
}

function promptText(content: Json): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some((b) => b?.type === 'tool_result')) return null;
  const text = content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? ''));
  return text.length ? text.join('\n') : null;
}

// Claude Code gives a tool result's line a top-level `toolUseResult`. Inside
// a prompt's text the same word would have its quotes escaped, so a prompt
// never matches.
const TOOL_RESULT = '"toolUseResult":';

export function parseClaude(lines: string[]): Parsed {
  const out: Parsed = { calls: [], notes: [] };
  for (const line of lines) {
    // Most lines are tool results, attachments and snapshots, the largest by
    // far; skip them unparsed.
    if ((!line.includes('"assistant"') && !line.includes('"user"')) || line.includes(TOOL_RESULT)) continue;
    const d = json(line);
    if (!d || !usableId(d.sessionId)) continue;
    const at = time(d.timestamp);
    if (at === null) continue;
    const note: Note = { session: d.sessionId, at, entry: claudeEntry(d.entrypoint) };
    if (typeof d.uuid === 'string') note.key = `line:${d.uuid}`;
    if (typeof d.cwd === 'string') note.cwd = d.cwd;
    const m = d.message ?? {};
    if (d.type === 'assistant') {
      const tools: string[] = [];
      const files: string[] = [];
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
        tools.push(block.name);
        const file = block.input?.file_path ?? block.input?.notebook_path;
        if (EDIT_TOOLS.has(block.name) && typeof file === 'string') files.push(file);
      }
      if (tools.length) note.tools = tools;
      if (files.length) note.files = files;
      // Only a line that used tools says something its call does not.
      if (tools.length) out.notes.push(note);
      const u = m.usage;
      if (u && typeof m.model === 'string' && m.model !== '<synthetic>' && !d.isApiErrorMessage) {
        const cacheWrite =
          num(u.cache_creation_input_tokens) ||
          num(u.cache_creation?.ephemeral_5m_input_tokens) + num(u.cache_creation?.ephemeral_1h_input_tokens);
        out.calls.push({
          key: typeof m.id === 'string' ? `${m.id}:${d.requestId ?? ''}` : null,
          at,
          session: d.sessionId,
          model: m.model,
          tokens: {
            input: num(u.input_tokens),
            output: num(u.output_tokens),
            cacheRead: num(u.cache_read_input_tokens),
            cacheWrite,
          },
          cacheWriteLong: Math.min(cacheWrite, num(u.cache_creation?.ephemeral_1h_input_tokens)),
          subagent: !!d.isSidechain,
          cwd: note.cwd,
          entry: note.entry,
        });
      }
    } else if (d.type === 'user') {
      const text = d.isMeta || d.isSidechain ? null : promptText(m.content);
      // A tool result or reminder says nothing the response around it does
      // not, and an interruption is the person stopping work, not asking.
      if (text === null || text.trimStart().startsWith('[Request interrupted')) continue;
      note.prompts = 1;
      note.title = titleFrom(text);
      out.notes.push(note);
    }
  }
  return out;
}

function codexEntry(originator: unknown, source: unknown): SessionEntry {
  const o = `${String(originator ?? '')} ${typeof source === 'string' ? source : ''}`.toLowerCase();
  if (/desktop|app/.test(o)) return 'desktop';
  if (/exec|sdk/.test(o)) return 'sdk';
  if (/vscode|ide|jetbrains|cursor/.test(o)) return 'other';
  return 'cli';
}

function codexTokens(u: Json): TokenCounts {
  const cached = num(u?.cached_input_tokens);
  return {
    input: Math.max(0, num(u?.input_tokens) - cached),
    output: num(u?.output_tokens),
    cacheRead: cached,
    cacheWrite: num(u?.cache_write_input_tokens),
  };
}

function minus(a: TokenCounts, b: TokenCounts): TokenCounts | null {
  const d = {
    input: a.input - b.input,
    output: a.output - b.output,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: a.cacheWrite - b.cacheWrite,
  };
  return Object.values(d).every((v) => v >= 0) ? d : null;
}

const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

// What the person typed in a Codex user message: its text parts, less the
// context Codex adds as user messages (AGENTS.md, the environment, plugin
// lists), which comes wrapped in tags. An IDE puts its context (open tabs,
// mentioned files) first and the request after a heading.
const IDE_REQUEST = '## My request for Codex:';
function codexPrompt(content: Json): string | null {
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b) => b?.type === 'input_text' && typeof b.text === 'string')
    .map((b) => {
      const t = b.text as string;
      const at = t.indexOf(IDE_REQUEST);
      return (at >= 0 ? t.slice(at + IDE_REQUEST.length) : t).trim();
    })
    .filter((t) => t && !t.startsWith('<') && !t.startsWith('# AGENTS.md instructions'));
  return text.length ? text.join('\n') : null;
}

export function parseCodex(lines: string[], ctx: CodexContext): Parsed {
  const out: Parsed = { calls: [], notes: [] };
  for (const line of lines) {
    const d = json(line);
    if (!d || typeof d.type !== 'string') continue;
    const at = time(d.timestamp);
    const p = d.payload ?? {};
    if (d.type === 'session_meta') {
      // The parent's header in a subagent's replayed history is not this file's.
      if (ctx.session) continue;
      const meta = p.meta ?? p;
      const root = meta.session_id ?? meta.id;
      if (!usableId(root)) continue;
      ctx.session = root;
      ctx.subagent =
        (typeof meta.id === 'string' && meta.id !== root) ||
        (typeof meta.source === 'object' && meta.source !== null && 'subagent' in meta.source);
      ctx.replaying = ctx.subagent;
      ctx.entry = codexEntry(meta.originator, meta.source);
      if (typeof meta.cwd === 'string') ctx.cwd = meta.cwd;
      if (at !== null) out.notes.push({ session: root, at, cwd: ctx.cwd, entry: ctx.entry });
      continue;
    }
    if (!ctx.session || at === null) continue;
    const session = ctx.session;
    // A subagent's prompts come from the agent that started it, not a person.
    const prompt = (text: string) => {
      if (ctx.subagent) return;
      const hash = shortKey(text);
      if (ctx.prompt?.hash === hash && Math.abs(at - ctx.prompt.at) < 5000) return;
      ctx.prompt = { hash, at };
      out.notes.push({ session, at, prompts: 1, title: titleFrom(text), cwd: ctx.cwd, entry: ctx.entry });
    };
    if (d.type === 'turn_context') {
      if (typeof p.model === 'string') ctx.model = p.model;
      if (typeof p.cwd === 'string') ctx.cwd = p.cwd;
    } else if (d.type === 'inter_agent_communication_metadata') {
      if (p.trigger_turn) ctx.replaying = false;
    } else if (d.type === 'token_usage_record') {
      ctx.records = true;
      if (!ctx.model) continue;
      out.calls.push({
        key: typeof p.response_id === 'string' ? `response:${p.response_id}` : null,
        at,
        session,
        model: ctx.model,
        tokens: codexTokens(p.usage),
        cacheWriteLong: 0,
        subagent: !!ctx.subagent,
      });
    } else if (d.type === 'event_msg') {
      if (p.type === 'task_started') ctx.replaying = false;
      else if (p.type === 'user_message' && typeof p.message === 'string' && !ctx.replaying) {
        prompt(p.message.trim());
      } else if (p.type === 'token_count' && p.info && !ctx.records && !ctx.replaying && ctx.model) {
        const total = num(p.info.total_token_usage?.total_tokens);
        if (total && ctx.total !== undefined && total <= ctx.total) continue;
        const now = codexTokens(p.info.total_token_usage);
        const delta = (ctx.last && minus(now, ctx.last)) || codexTokens(p.info.last_token_usage);
        ctx.total = total || ctx.total;
        ctx.last = now;
        out.calls.push({
          key: null,
          at,
          session,
          model: ctx.model,
          tokens: delta,
          cacheWriteLong: 0,
          subagent: !!ctx.subagent,
        });
      }
    } else if (d.type === 'response_item' && !ctx.replaying) {
      const kind = p.type;
      if (kind === 'message' && p.role === 'user') {
        const text = codexPrompt(p.content);
        if (text !== null) prompt(text);
      }
      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
        const name = typeof p.name === 'string' ? p.name : 'shell';
        const files = typeof p.input === 'string' ? [...p.input.matchAll(PATCH_FILE)].map((m) => m[1].trim()) : [];
        out.notes.push({ session, at, tools: [name], files: files.length ? files : undefined });
      }
    }
  }
  return out;
}
