// What each profile's agents are doing, read from the session files the
// desktop apps and CLIs already write. Nothing here talks to an app: Claude
// keeps one JSON-lines file per session under <home>/projects/<project>/, and
// Codex one rollout file per thread under <home>/sessions/YYYY/MM/DD/, so a
// reader that only looks at files sees every session, however it was started.
//
// Files can run to many megabytes, so a summary reads only the head (where
// the working folder and origin are) and the tail (where the latest turn is),
// and the result is kept per file until its size or modification time
// changes. A session counts as working while its latest turn has not ended
// and the file changed recently; an agent that died mid-turn stops looking
// busy after STALE_MS.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Vendor } from '../types';

export type SessionState = 'working' | 'idle';
// Where a session was started. `desktop` is the vendor's desktop app; `exec`
// is a headless run (claude -p through the SDK, codex exec), usually a script.
export type SessionOrigin = 'desktop' | 'cli' | 'ide' | 'exec' | 'other';

export interface SessionSummary {
  id: string;
  profileId: string;
  vendor: Vendor;
  title: string;
  cwd: string | null;
  origin: SessionOrigin;
  state: SessionState;
  updatedAt: string;
  lastMessage: { role: 'user' | 'assistant'; text: string } | null;
}

export type TranscriptEntry =
  | { kind: 'user' | 'assistant'; text: string; at: string | null }
  | { kind: 'tool'; name: string; detail: string; at: string | null; failed?: boolean };

export interface Transcript {
  session: SessionSummary;
  entries: TranscriptEntry[];
}

export interface ProfileHome {
  id: string;
  vendor: Vendor;
  home: string;
}

// How far back a session still counts as recent, and how many a profile lists.
export const RECENT_MS = 7 * 24 * 3600_000;
export const PER_PROFILE = 25;
// A turn with no write for this long is not reported as working.
export const STALE_MS = 10 * 60_000;
const HEAD_BYTES = 64 * 1024;
// Codex injects its instructions ahead of the first prompt; they can pass 64 KB.
const LONG_HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 384 * 1024;
const TRANSCRIPT_BYTES = 1024 * 1024;
const TEXT_LIMIT = 4000;
const PREVIEW_LIMIT = 280;

interface FileInfo {
  file: string;
  mtimeMs: number;
  size: number;
}

// ---- reading files in slices ----

function readSlice(file: string, start: number, length: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const n = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// Parsed JSON lines from the first `bytes` of a file, dropping a cut last line.
function headLines(info: FileInfo, bytes = HEAD_BYTES): unknown[] {
  const text = readSlice(info.file, 0, Math.min(bytes, info.size));
  const lines = text.split('\n');
  if (info.size > bytes) lines.pop();
  return parseLines(lines);
}

// Parsed JSON lines from the last `bytes` of a file, dropping a cut first line.
function tailLines(info: FileInfo, bytes = TAIL_BYTES): unknown[] {
  const start = Math.max(0, info.size - bytes);
  const lines = readSlice(info.file, start, info.size - start).split('\n');
  if (start > 0) lines.shift();
  return parseLines(lines);
}

function parseLines(lines: string[]): unknown[] {
  const out: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line being written right now, or one this reader does not know.
    }
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function clip(text: string, limit = TEXT_LIMIT): string {
  const t = text.trim();
  return t.length > limit ? t.slice(0, limit - 1).trimEnd() + '…' : t;
}

function oneLine(text: string, limit = PREVIEW_LIMIT): string {
  return clip(text.replace(/\s+/g, ' '), limit);
}

// Text the person typed, without what the app or a hook attached to it.
export function cleanPrompt(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, '')
    .trim();
}

function stat(file: string): FileInfo | null {
  try {
    const s = fs.statSync(file);
    return s.isFile() ? { file, mtimeMs: s.mtimeMs, size: s.size } : null;
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---- Claude ----
// One file per session: projects/<project>/<session id>.jsonl. Subagents
// write under projects/<project>/<session id>/, which this never descends.

function claudeFiles(home: string, since: number): FileInfo[] {
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

function claudeText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => obj(b))
    .filter((b) => b.type === 'text')
    .map((b) => str(b.text) ?? '')
    .join('\n');
}

const CLAUDE_ORIGINS: Record<string, SessionOrigin> = {
  'claude-desktop': 'desktop',
  cli: 'cli',
  'sdk-cli': 'exec',
  'sdk-ts': 'exec',
  'sdk-py': 'exec',
  'claude-vscode': 'ide',
};

// A record is part of the visible conversation: not a subagent's, not meta.
function claudeTurnRecord(r: Record<string, unknown>): boolean {
  return (r.type === 'user' || r.type === 'assistant') && r.isSidechain !== true && r.isMeta !== true;
}

function claudePrompt(r: Record<string, unknown>): string {
  const content = obj(r.message).content;
  // A tool result is the user role's other job; it is not a prompt.
  if (Array.isArray(content) && content.some((b) => obj(b).type === 'tool_result')) return '';
  return cleanPrompt(claudeText(content));
}

export function summarizeClaude(profile: ProfileHome, info: FileInfo, now = Date.now()): SessionSummary | null {
  const head = headLines(info).map(obj);
  const tail = info.size > HEAD_BYTES ? tailLines(info).map(obj) : head;
  const first = head.find((r) => typeof r.sessionId === 'string');
  if (!first) return null;
  const turns = tail.filter(claudeTurnRecord);
  if (!turns.length && !head.some(claudeTurnRecord)) return null;

  const meta = [...head, ...tail].find((r) => typeof r.cwd === 'string') ?? {};
  let title: string | null = null;
  for (const r of tail) if (r.type === 'custom-title' && str(r.customTitle)) title = str(r.customTitle);
  if (!title) for (const r of head) if (r.type === 'custom-title' && str(r.customTitle)) title = str(r.customTitle);
  if (!title) {
    const prompt = head.filter(claudeTurnRecord).find((r) => r.type === 'user' && claudePrompt(r));
    title = prompt ? oneLine(claudePrompt(prompt), 80) : null;
  }

  let lastMessage: SessionSummary['lastMessage'] = null;
  for (let i = turns.length - 1; i >= 0 && !lastMessage; i--) {
    const r = turns[i];
    const text = r.type === 'user' ? claudePrompt(r) : cleanPrompt(claudeText(obj(r.message).content));
    if (text) lastMessage = { role: r.type as 'user' | 'assistant', text: oneLine(text) };
  }

  // The turn has ended when the last record is the assistant stopping on its
  // own; a tool call, a tool result or a new prompt means it is still going.
  // A turn the person stopped ends on a user record Claude writes itself.
  const last = turns[turns.length - 1];
  const stop = last && last.type === 'assistant' ? str(obj(last.message).stop_reason) : null;
  const interrupted = !!last && last.type === 'user' && claudePrompt(last).startsWith('[Request interrupted');
  const ended = !last || interrupted || stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens';
  const fresh = now - info.mtimeMs < STALE_MS;

  return {
    id: str(first.sessionId)!,
    profileId: profile.id,
    vendor: 'claude',
    title: title || 'Untitled session',
    cwd: str(meta.cwd),
    origin: CLAUDE_ORIGINS[str(meta.entrypoint) ?? ''] ?? 'other',
    state: !ended && fresh ? 'working' : 'idle',
    updatedAt: new Date(info.mtimeMs).toISOString(),
    lastMessage,
  };
}

function claudeToolDetail(name: string, input: Record<string, unknown>): string {
  const pick = str(input.command) ?? str(input.file_path) ?? str(input.path) ?? str(input.pattern) ?? str(input.url);
  if (pick) return oneLine(pick, 400);
  const description = str(input.description) ?? str(input.prompt);
  return description ? oneLine(description, 200) : name;
}

export function claudeTranscript(info: FileInfo): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const failed = new Set<string>();
  const records = tailLines(info, TRANSCRIPT_BYTES).map(obj).filter(claudeTurnRecord);
  for (const r of records) {
    const content = obj(r.message).content;
    if (r.type !== 'user' || !Array.isArray(content)) continue;
    for (const b of content.map(obj))
      if (b.type === 'tool_result' && b.is_error === true && str(b.tool_use_id)) failed.add(str(b.tool_use_id)!);
  }
  for (const r of records) {
    const at = str(r.timestamp);
    const content = obj(r.message).content;
    if (r.type === 'user') {
      const text = claudePrompt(r);
      if (text) entries.push({ kind: 'user', text: clip(text), at });
      continue;
    }
    for (const b of Array.isArray(content) ? content.map(obj) : []) {
      if (b.type === 'text' && str(b.text)?.trim()) entries.push({ kind: 'assistant', text: clip(str(b.text)!), at });
      else if (b.type === 'tool_use') {
        // mcp__<server>__<tool> reads better as its tool alone.
        const name = (str(b.name) ?? 'tool').replace(/^mcp__.+__/, '');
        const entry: TranscriptEntry = { kind: 'tool', name, detail: claudeToolDetail(name, obj(b.input)), at };
        if (str(b.id) && failed.has(str(b.id)!)) entry.failed = true;
        entries.push(entry);
      }
    }
  }
  return entries;
}

// ---- Codex ----
// One rollout per thread: sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, the
// first line a session_meta. Thread names live in session_index.jsonl, one
// line per rename, the latest winning.

function codexFiles(home: string, since: number, now: number): FileInfo[] {
  const files: FileInfo[] = [];
  // A rollout stays in the folder of the day it started, so look back one
  // extra day for threads that began before the window and are still active.
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
      if (info && info.mtimeMs >= since) files.push(info);
    }
  }
  return files;
}

const CODEX_ORIGINS: Record<string, SessionOrigin> = {
  'Codex Desktop': 'desktop',
  codex_cli_rs: 'cli',
  codex_vscode: 'ide',
  codex_exec: 'exec',
};

function codexItem(r: Record<string, unknown>): Record<string, unknown> | null {
  if (r.type !== 'event_msg') return null;
  const p = obj(r.payload);
  return p.type === 'item_completed' ? obj(p.item) : null;
}

function codexText(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) return '';
  return content
    .map(obj)
    .filter((b) => /^text$/i.test(str(b.type) ?? ''))
    .map((b) => str(b.text) ?? '')
    .join('\n');
}

// `codex exec` records its prompt only as a model input, after the context
// Codex injects in the same role (AGENTS.md, environment, permissions), each
// of which opens with a tag or a heading.
function codexExecPrompt(head: Record<string, unknown>[]): string | null {
  for (const r of head) {
    const p = obj(r.payload);
    if (r.type !== 'response_item' || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) continue;
    for (const b of p.content.map(obj)) {
      const text = cleanPrompt(str(b.text) ?? '');
      if (text && !/^(<|# )/.test(text)) return oneLine(text, 80);
    }
  }
  return null;
}

export function summarizeCodex(
  profile: ProfileHome,
  info: FileInfo,
  names: Map<string, string>,
  now = Date.now(),
): SessionSummary | null {
  // session_meta carries the base instructions and can outgrow a small head.
  let head = headLines(info).map(obj);
  if (!head.some((r) => r.type === 'session_meta') && info.size > HEAD_BYTES)
    head = headLines(info, LONG_HEAD_BYTES).map(obj);
  const meta = obj(head.find((r) => r.type === 'session_meta')?.payload);
  const id = str(meta.id) ?? str(meta.session_id);
  if (!id) return null;
  // A subagent's thread belongs to its parent's conversation.
  if (obj(meta.source).subagent !== undefined || str(meta.parent_thread_id)) return null;
  const tail = info.size > HEAD_BYTES ? tailLines(info).map(obj) : head;

  let started = -1;
  let completed = -1;
  let lastMessage: SessionSummary['lastMessage'] = null;
  tail.forEach((r, i) => {
    const p = obj(r.payload);
    if (r.type === 'event_msg' && p.type === 'task_started') started = i;
    if (r.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) completed = i;
    const item = codexItem(r);
    if (item && (item.type === 'UserMessage' || item.type === 'AgentMessage')) {
      const text = item.type === 'UserMessage' ? cleanPrompt(codexText(item)) : codexText(item);
      if (text) lastMessage = { role: item.type === 'UserMessage' ? 'user' : 'assistant', text: oneLine(text) };
    }
  });
  if (!lastMessage && started < 0) {
    // Nothing in the tail: a thread opened and never used, or one whose
    // latest turn is all tool output. Only the former is skipped.
    if (!head.some((r) => codexItem(r)?.type === 'UserMessage')) return null;
  }

  let title = names.get(id) ?? null;
  if (!title) {
    const prompt = head.map(codexItem).find((item) => item?.type === 'UserMessage' && cleanPrompt(codexText(item)));
    title = prompt
      ? oneLine(cleanPrompt(codexText(prompt)), 80)
      : codexExecPrompt(info.size > HEAD_BYTES ? headLines(info, LONG_HEAD_BYTES).map(obj) : head);
  }
  const fresh = now - info.mtimeMs < STALE_MS;
  return {
    id,
    profileId: profile.id,
    vendor: 'codex',
    title: title || 'Untitled thread',
    cwd: str(meta.cwd),
    origin: CODEX_ORIGINS[str(meta.originator) ?? ''] ?? 'other',
    state: started > completed && fresh ? 'working' : 'idle',
    updatedAt: new Date(info.mtimeMs).toISOString(),
    lastMessage,
  };
}

export function codexTranscript(info: FileInfo): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const r of tailLines(info, TRANSCRIPT_BYTES).map(obj)) {
    const item = codexItem(r);
    if (!item) continue;
    const at = str(r.timestamp);
    switch (item.type) {
      case 'UserMessage': {
        const text = cleanPrompt(codexText(item));
        if (text) entries.push({ kind: 'user', text: clip(text), at });
        break;
      }
      case 'AgentMessage': {
        const text = codexText(item);
        if (text.trim()) entries.push({ kind: 'assistant', text: clip(text), at });
        break;
      }
      case 'CommandExecution': {
        const command = Array.isArray(item.command) ? item.command.join(' ') : (str(item.command) ?? '');
        const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
        entries.push({ kind: 'tool', name: 'Shell', detail: oneLine(command, 400), at, failed: !!exit });
        break;
      }
      case 'FileChange': {
        const changes = obj(item.changes);
        const paths = Array.isArray(item.changes)
          ? item.changes.map((c) => str(obj(c).path) ?? '').filter(Boolean)
          : Object.keys(changes);
        entries.push({ kind: 'tool', name: 'Edit', detail: oneLine(paths.join(', ') || 'files', 400), at });
        break;
      }
      case 'McpToolCall':
        entries.push({
          kind: 'tool',
          name: str(item.server) ?? 'MCP',
          detail: str(item.tool) ?? 'call',
          at,
          failed: str(item.status) === 'failed',
        });
        break;
    }
  }
  return entries;
}

// ---- per profile, cached ----

interface Cached {
  mtimeMs: number;
  size: number;
  summary: SessionSummary | null;
}

export class SessionReader {
  private summaries = new Map<string, Cached>();
  private names = new Map<string, { mtimeMs: number; names: Map<string, string> }>();
  // Where each session's file is, as of the last listing.
  private files = new Map<string, FileInfo>();

  list(profiles: ProfileHome[], now = Date.now()): SessionSummary[] {
    const all: SessionSummary[] = [];
    const seen = new Set<string>();
    for (const profile of profiles) {
      const since = now - RECENT_MS;
      const files =
        profile.vendor === 'claude' ? claudeFiles(profile.home, since) : codexFiles(profile.home, since, now);
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const names = profile.vendor === 'codex' ? this.codexNames(profile.home) : new Map<string, string>();
      let count = 0;
      for (const info of files) {
        if (count >= PER_PROFILE) break;
        seen.add(info.file);
        let cached = this.summaries.get(info.file);
        if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
          let summary: SessionSummary | null = null;
          try {
            summary =
              profile.vendor === 'claude'
                ? summarizeClaude(profile, info, now)
                : summarizeCodex(profile, info, names, now);
          } catch {
            summary = null;
          }
          cached = { mtimeMs: info.mtimeMs, size: info.size, summary };
          this.summaries.set(info.file, cached);
        } else if (cached.summary) {
          // The file has not changed, but time has: a stale turn stops working.
          if (cached.summary.state === 'working' && now - info.mtimeMs >= STALE_MS)
            cached.summary = { ...cached.summary, state: 'idle' };
          if (profile.vendor === 'codex') {
            const name = names.get(cached.summary.id);
            if (name && name !== cached.summary.title) cached.summary = { ...cached.summary, title: name };
          }
        }
        if (!cached.summary) continue;
        this.files.set(`${profile.id}/${cached.summary.id}`, info);
        all.push(cached.summary);
        count++;
      }
    }
    for (const file of this.summaries.keys()) if (!seen.has(file)) this.summaries.delete(file);
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  transcript(profiles: ProfileHome[], profileId: string, sessionId: string, now = Date.now()): Transcript | null {
    const key = `${profileId}/${sessionId}`;
    if (!this.files.has(key))
      this.list(
        profiles.filter((p) => p.id === profileId),
        now,
      );
    const known = this.files.get(key);
    const info = known && stat(known.file);
    const profile = profiles.find((p) => p.id === profileId);
    if (!info || !profile) return null;
    const names = profile.vendor === 'codex' ? this.codexNames(profile.home) : new Map<string, string>();
    const session =
      profile.vendor === 'claude' ? summarizeClaude(profile, info, now) : summarizeCodex(profile, info, names, now);
    if (!session) return null;
    const entries = profile.vendor === 'claude' ? claudeTranscript(info) : codexTranscript(info);
    return { session, entries };
  }

  private codexNames(home: string): Map<string, string> {
    const file = path.join(home, 'session_index.jsonl');
    const info = stat(file);
    if (!info) return new Map();
    const cached = this.names.get(home);
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.names;
    const names = new Map<string, string>();
    for (const r of parseLines(fs.readFileSync(file, 'utf8').split('\n')).map(obj)) {
      const id = str(r.id);
      const name = str(r.thread_name);
      if (id && name) names.set(id, name);
    }
    this.names.set(home, { mtimeMs: info.mtimeMs, names });
    return names;
  }
}
