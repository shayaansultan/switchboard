// Reading the logs Claude Code and Codex already write for themselves, one
// line at a time, into model calls and facts about their sessions. Nothing
// here touches the disk; ledger.ts feeds it the new lines of each file.
//
// Claude Code writes one JSON object per line under
// <CLAUDE_CONFIG_DIR>/projects/<project>/<session>.jsonl, and subagents under
// <session>/subagents/. A response is written once per content block, each
// copy carrying the same usage, so calls are keyed by message and request id
// for the ledger to count once. Every line names its session and folder.
//
// Codex writes <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, a header
// line naming the session and then events. Newer builds record each
// response's usage (`token_usage_record`, keyed by response id); older ones
// only emit running totals (`token_count`), which are counted as the rise
// since the last total. A subagent's rollout opens by replaying its parent's
// history, which is skipped until the subagent's own turn starts.

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
}

// Something learned about a session at a moment: where it ran, what it was
// asked, what tools it used and which files it edited.
export interface Note {
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

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

export function parseClaude(lines: string[]): Parsed {
  const out: Parsed = { calls: [], notes: [] };
  for (const line of lines) {
    // Most lines are tool results and attachments; skip them unparsed.
    if (!line.includes('"assistant"') && !line.includes('"user"')) continue;
    const d = json(line);
    if (!d || typeof d.sessionId !== 'string') continue;
    const at = time(d.timestamp);
    if (at === null) continue;
    const note: Note = { session: d.sessionId, at, entry: claudeEntry(d.entrypoint) };
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
        });
      }
    } else if (d.type === 'user' && !d.isMeta && !d.isSidechain) {
      const text = promptText(m.content);
      if (text !== null) {
        note.prompts = 1;
        note.title = titleFrom(text);
      }
    }
    out.notes.push(note);
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

export function parseCodex(lines: string[], ctx: CodexContext): Parsed {
  const out: Parsed = { calls: [], notes: [] };
  for (const line of lines) {
    const d = json(line);
    if (!d || typeof d.type !== 'string') continue;
    const at = time(d.timestamp);
    const p = d.payload ?? {};
    if (d.type === 'session_meta') {
      const meta = p.meta ?? p;
      const root = meta.session_id ?? meta.id;
      if (typeof root !== 'string') continue;
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
        out.notes.push({ session, at, prompts: 1, title: titleFrom(p.message), cwd: ctx.cwd, entry: ctx.entry });
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
      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
        const name = typeof p.name === 'string' ? p.name : 'shell';
        const files = typeof p.input === 'string' ? [...p.input.matchAll(PATCH_FILE)].map((m) => m[1].trim()) : [];
        out.notes.push({ session, at, tools: [name], files: files.length ? files : undefined });
      }
    }
  }
  return out;
}
