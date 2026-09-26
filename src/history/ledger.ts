// The token ledger: what every profile's agent sessions have used, kept by
// Switchboard so it outlives the logs it comes from (Claude Code deletes its
// transcripts after 30 days by default). Each profile's logs live in its own
// home, so every figure here is already the right account's.
//
// Indexing is incremental. For each log file the ledger remembers how far it
// has read, and reads only what has been appended since, a few megabytes at a
// time with a pause between, so a first pass over years of transcripts does
// not stall the app. Totals are kept per day, model and folder ("facts"), and
// per session for the Sessions view; sessions are kept 90 days, facts 400.
//
// The app writes the ledger; the CLI only reads it.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionEntry, TokenCounts, Vendor } from '../types';
import { parseClaude, parseCodex, type Call, type CodexContext, type Note, type Parsed } from './logs';
import { valueParts } from './prices';

export const DAY_MS = 86_400_000;
export const SLOT_MS = 5 * 60_000;
// The most one step of a session (a prompt or response to the next response)
// counts as work. Long builds and subagents run well past five minutes; a
// permission prompt left overnight should not count as a night's work.
const STEP_MS = 30 * 60_000;
const SESSION_DAYS = 90;
const FACT_DAYS = 400;
const SEEN_DAYS = 45;
const CHUNK = 4 * 1024 * 1024;
const MAX_FILES = 200;

// Tokens and their value in the four kinds (input, output, cache read, cache
// write), the tokens of models without a price, agent time and call count.
export interface Agg {
  t: [number, number, number, number];
  v: [number, number, number, number];
  u: number;
  ms: number;
  n: number;
}

export interface SessionRecord {
  file: string;
  cwd: string | null;
  title: string | null;
  entry: SessionEntry;
  start: number;
  end: number;
  last: number | null;
  prompts: number;
  ms: number;
  models: Record<string, Agg>;
  sub: Record<string, Agg>;
  tools: Record<string, number>;
  files: string[];
  // Value per five-minute slot, to share a window out among its sessions.
  slots: Record<string, number>;
}

interface FileState {
  offset: number;
  codex?: CodexContext;
}

export interface ProfileLedger {
  vendor: Vendor;
  home: string;
  files: Record<string, FileState>;
  seen: Record<string, number>;
  // `${day}\t${model}\t${folder}` → totals.
  facts: Record<string, Agg>;
  sessions: Record<string, SessionRecord>;
}

// Bumped when what is stored changes meaning, so an older ledger is read
// again from the logs rather than mixed with the new.
const VERSION = 2;

export interface Ledger {
  v: typeof VERSION;
  since: string | null;
  indexedAt: string | null;
  profiles: Record<string, ProfileLedger>;
}

export interface LedgerProfile {
  id: string;
  vendor: Vendor;
  home: string;
}

export const emptyAgg = (): Agg => ({ t: [0, 0, 0, 0], v: [0, 0, 0, 0], u: 0, ms: 0, n: 0 });

export function addAgg(into: Agg, a: Agg): Agg {
  for (let i = 0; i < 4; i++) {
    into.t[i] += a.t[i];
    into.v[i] += a.v[i];
  }
  into.u += a.u;
  into.ms += a.ms;
  into.n += a.n;
  return into;
}

export const aggValue = (a: Agg): number => a.v[0] + a.v[1] + a.v[2] + a.v[3];
export const aggTokens = (a: Agg): number => a.t[0] + a.t[1] + a.t[2] + a.t[3];
export const aggCounts = (a: Agg): TokenCounts => ({
  input: a.t[0],
  output: a.t[1],
  cacheRead: a.t[2],
  cacheWrite: a.t[3],
});

// The local calendar day of a moment, as YYYY-MM-DD.
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function emptyLedger(now = Date.now()): Ledger {
  return { v: VERSION, since: new Date(now).toISOString(), indexedAt: null, profiles: {} };
}

export function loadLedger(file: string): Ledger | null {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
    return l && l.v === VERSION && l.profiles ? l : null;
  } catch {
    return null;
  }
}

export function saveLedger(file: string, ledger: Ledger): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(ledger), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

// The log files of a profile's home: Claude Code's transcripts (with
// subagents one level down) or Codex's rollouts. Codex moves old rollouts to
// archived_sessions, so its files are known by name, not path.
async function logFiles(p: LedgerProfile): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (dir: string, depth: number, match: (name: string) => boolean, byName: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) await walk(full, depth - 1, match, byName);
      else if (e.isFile() && match(e.name)) {
        const key = byName ? e.name : full;
        if (!found.has(key)) found.set(key, full);
      }
    }
  };
  if (p.vendor === 'claude') await walk(path.join(p.home, 'projects'), 3, (n) => n.endsWith('.jsonl'), false);
  else {
    const rollout = (n: string) => n.startsWith('rollout-') && n.endsWith('.jsonl');
    await walk(path.join(p.home, 'sessions'), 4, rollout, true);
    await walk(path.join(p.home, 'archived_sessions'), 1, rollout, true);
  }
  return found;
}

async function readFrom(file: string, start: number, end: number): Promise<{ lines: string[]; consumed: number }> {
  const handle = await fs.promises.open(file, 'r');
  try {
    const length = Math.min(end - start, CHUNK);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, start);
    const text = buf.subarray(0, bytesRead);
    // Stop at the last complete line; a line still being written is read
    // next time. A single line longer than the chunk is skipped whole.
    let cut = text.lastIndexOf(0x0a);
    if (cut < 0) return { lines: [], consumed: bytesRead === CHUNK ? bytesRead : 0 };
    cut += 1;
    return { lines: text.subarray(0, cut).toString('utf8').split('\n').filter(Boolean), consumed: cut };
  } finally {
    await handle.close();
  }
}

const shortKey = (key: string): string => crypto.createHash('sha1').update(key).digest('base64').slice(0, 12);

function session(pl: ProfileLedger, id: string, file: string, at: number): SessionRecord {
  let s = pl.sessions[id];
  if (!s) {
    s = pl.sessions[id] = {
      file,
      cwd: null,
      title: null,
      entry: 'cli',
      start: at,
      end: at,
      last: null,
      prompts: 0,
      ms: 0,
      models: {},
      sub: {},
      tools: {},
      files: [],
      slots: {},
    };
  }
  // A subagent's file is not the transcript to show.
  if (!file.includes(`${path.sep}subagents${path.sep}`)) s.file = file;
  s.start = Math.min(s.start, at);
  s.end = Math.max(s.end, at);
  return s;
}

function applyNote(pl: ProfileLedger, n: Note, file: string): void {
  const s = session(pl, n.session, file, n.at);
  if (n.cwd && !s.cwd) s.cwd = n.cwd;
  if (n.title && !s.title) s.title = n.title;
  // Where the session ran is where it started.
  if (n.entry && n.at <= s.start) s.entry = n.entry;
  if (n.prompts) {
    s.prompts += n.prompts;
    // A prompt is where work resumes: the wait for the answer counts.
    s.last = Math.max(s.last ?? 0, n.at);
  }
  for (const t of n.tools ?? []) s.tools[t] = (s.tools[t] ?? 0) + 1;
  for (const f of n.files ?? []) {
    const rel = s.cwd && f.startsWith(s.cwd + path.sep) ? f.slice(s.cwd.length + 1) : f;
    if (!s.files.includes(rel) && s.files.length < MAX_FILES) s.files.push(rel);
  }
}

// One call into the session, its day's facts and its window slot.
function applyCall(pl: ProfileLedger, c: Call, file: string): void {
  const s = session(pl, c.session, file, c.at);
  const agg = emptyAgg();
  agg.t = [c.tokens.input, c.tokens.output, c.tokens.cacheRead, c.tokens.cacheWrite];
  agg.n = 1;
  const value = valueParts(c.model, c.tokens, c.cacheWriteLong);
  if (value) agg.v = value;
  else agg.u = aggTokens(agg);
  if (!c.subagent) {
    // Time since the last response or prompt: the agent thinking, running
    // tools or waiting on a subagent. The time before a prompt is never
    // counted, since a prompt restarts the clock.
    agg.ms = Math.min(Math.max(c.at - (s.last ?? s.start), 0), STEP_MS);
    s.last = Math.max(s.last ?? 0, c.at);
    s.ms += agg.ms;
  }
  addAgg(((c.subagent ? s.sub : s.models)[c.model] ??= emptyAgg()), agg);
  const slot = String(Math.floor(c.at / SLOT_MS));
  s.slots[slot] = (s.slots[slot] ?? 0) + aggValue(agg);
  const fact = `${dayOf(c.at)}\t${c.model}\t${s.cwd ?? ''}`;
  addAgg((pl.facts[fact] ??= emptyAgg()), agg);
}

function apply(pl: ProfileLedger, parsed: Parsed, file: string, now: number): void {
  // In the order they happened, a note before a call at the same moment, so
  // a session knows its folder before its calls are filed and agent time
  // follows the conversation.
  const events = [
    ...parsed.notes.map((n) => ({ at: n.at, note: n })),
    ...parsed.calls.map((c) => ({ at: c.at, call: c })),
  ].sort((a, b) => a.at - b.at);
  for (const e of events) {
    if ('note' in e) {
      applyNote(pl, e.note, file);
      continue;
    }
    const c = e.call;
    if (c.key) {
      const k = shortKey(c.key);
      if (pl.seen[k]) continue;
      pl.seen[k] = Math.floor(now / DAY_MS);
    }
    applyCall(pl, c, file);
  }
}

function prune(pl: ProfileLedger, now: number, present: Set<string>): void {
  for (const [id, s] of Object.entries(pl.sessions)) if (s.end < now - SESSION_DAYS * DAY_MS) delete pl.sessions[id];
  const today = Math.floor(now / DAY_MS);
  for (const [k, day] of Object.entries(pl.seen)) if (day < today - SEEN_DAYS) delete pl.seen[k];
  const oldest = dayOf(now - FACT_DAYS * DAY_MS);
  for (const k of Object.keys(pl.facts)) if (k.slice(0, 10) < oldest) delete pl.facts[k];
  for (const k of Object.keys(pl.files)) if (!present.has(k)) delete pl.files[k];
}

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

// Read what the profiles' logs gained since the last pass. Returns whether
// anything changed. Profiles no longer listed are dropped.
export async function indexLogs(ledger: Ledger, profiles: LedgerProfile[], now = Date.now()): Promise<boolean> {
  let changed = false;
  for (const id of Object.keys(ledger.profiles)) {
    if (!profiles.some((p) => p.id === id)) {
      delete ledger.profiles[id];
      changed = true;
    }
  }
  for (const p of profiles) {
    let pl = ledger.profiles[p.id];
    if (!pl || pl.home !== p.home || pl.vendor !== p.vendor) {
      pl = ledger.profiles[p.id] = { vendor: p.vendor, home: p.home, files: {}, seen: {}, facts: {}, sessions: {} };
      changed = true;
    }
    const files = await logFiles(p);
    for (const [key, file] of files) {
      let size: number;
      try {
        size = (await fs.promises.stat(file)).size;
      } catch {
        continue;
      }
      let st = pl.files[key];
      // A file that shrank was rewritten: read it again from the start.
      if (!st || size < st.offset) st = pl.files[key] = { offset: 0, codex: p.vendor === 'codex' ? {} : undefined };
      while (st.offset < size) {
        const { lines, consumed } = await readFrom(file, st.offset, size);
        if (!consumed) break;
        st.offset += consumed;
        apply(pl, p.vendor === 'claude' ? parseClaude(lines) : parseCodex(lines, (st.codex ??= {})), file, now);
        changed = true;
        await pause();
      }
    }
    prune(pl, now, new Set(files.keys()));
  }
  ledger.indexedAt = new Date(now).toISOString();
  return changed;
}
