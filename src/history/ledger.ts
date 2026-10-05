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
// A profile that goes (or moves its home) keeps its facts: the logs they
// came from may be gone, so they could not be read again.
//
// The keys of lines and responses already counted are kept as long as a log
// that could hold them is, so a copy made months later is still known.
//
// The app writes the ledger; the CLI only reads it. Keys that come from the
// logs are looked up as own properties only (see `own`), so a session id
// such as "constructor" is just a name.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomic } from '../storage';
import type { SessionEntry, TokenCounts, Vendor } from '../types';
import { parseClaude, parseCodex, shortKey, type Call, type CodexContext, type Note, type Parsed } from './logs';
import { valueParts } from './prices';

export const DAY_MS = 86_400_000;
export const SLOT_MS = 5 * 60_000;
// The most one step of a session (a prompt or response to the next response)
// counts as work. Long builds and subagents run well past five minutes; a
// permission prompt left overnight should not count as a night's work.
const STEP_MS = 30 * 60_000;
const SESSION_DAYS = 90;
const FACT_DAYS = 400;
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
  // The time of the earliest line read from it, how far back a copy of its
  // lines could reach; null before any. Absent in a file read before this
  // was kept, which is then taken to reach back indefinitely.
  first?: number | null;
  // Where the file was last found. Codex moves a finished rollout to
  // archived_sessions, and its sessions' transcript moves with it.
  path?: string;
  codex?: CodexContext;
}

export interface ProfileLedger {
  vendor: Vendor;
  home: string;
  files: Record<string, FileState>;
  // Key of a line or response counted → the day (since the epoch) it
  // happened.
  seen: Record<string, number>;
  // `${day}\t${model}\t${folder}` → totals.
  facts: Record<string, Agg>;
  sessions: Record<string, SessionRecord>;
}

// Bumped when what is stored changes meaning, so an older ledger is read
// again from the logs rather than mixed with the new.
const VERSION = 3;

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

export const sumTokens = (t: TokenCounts): number => t.input + t.output + t.cacheRead + t.cacheWrite;
export const aggValue = (a: Agg): number => a.v[0] + a.v[1] + a.v[2] + a.v[3];
export const aggCounts = (a: Agg): TokenCounts => ({
  input: a.t[0],
  output: a.t[1],
  cacheRead: a.t[2],
  cacheWrite: a.t[3],
});
export const aggTokens = (a: Agg): number => sumTokens(aggCounts(a));

// A record's own entry for a key, never one inherited from Object.prototype.
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// A record's own entry for a key, made if missing. Defined rather than
// assigned, so even "__proto__" is an ordinary key.
function ownOrNew<T>(record: Record<string, T>, key: string, make: () => T): T {
  if (!Object.hasOwn(record, key))
    Object.defineProperty(record, key, { value: make(), enumerable: true, writable: true, configurable: true });
  return record[key];
}

// The local calendar day of a moment, as YYYY-MM-DD.
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function emptyLedger(now = Date.now()): Ledger {
  return { v: VERSION, since: new Date(now).toISOString(), indexedAt: null, profiles: {} };
}

// The ledger in a file, or null when there is none, it cannot be read, or it
// is from another version.
export function loadLedger(file: string): Ledger | null {
  try {
    const l = JSON.parse(fs.readFileSync(file, 'utf8')) as Ledger;
    return l && l.v === VERSION && l.profiles ? l : null;
  } catch {
    return null;
  }
}

// The ledger to carry on with: the file's, or an empty one. A file that is
// there but cannot be used is copied aside first, since what it holds may be
// older than any log left to rebuild it from.
export function openLedger(file: string, now = Date.now()): Ledger {
  const ledger = loadLedger(file);
  if (ledger) return ledger;
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, `${file}.unreadable-${now}`);
    } catch {
      /* best effort, as the store does */
    }
  }
  return emptyLedger(now);
}

export function saveLedger(file: string, ledger: Ledger): void {
  writeFileAtomic(file, JSON.stringify(ledger));
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

// `mine` says the file is the session's own transcript rather than one of
// its subagents'.
function session(pl: ProfileLedger, id: string, file: string, mine: boolean, at: number): SessionRecord {
  const s = ownOrNew(pl.sessions, id, (): SessionRecord => ({
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
  }));
  // A subagent's file is not the transcript to show.
  if (mine) s.file = file;
  s.start = Math.min(s.start, at);
  s.end = Math.max(s.end, at);
  return s;
}

// Where the session ran, the first time a line says; how it ran, from its
// earliest line.
function place(s: SessionRecord, at: number, cwd?: string, entry?: SessionEntry): void {
  if (cwd && !s.cwd) s.cwd = cwd;
  if (entry && at <= s.start) s.entry = entry;
}

function applyNote(pl: ProfileLedger, n: Note, file: string, mine: boolean): void {
  const s = session(pl, n.session, file, mine, n.at);
  place(s, n.at, n.cwd, n.entry);
  if (n.title && !s.title) s.title = n.title;
  if (n.prompts) {
    s.prompts += n.prompts;
    // A prompt is where work resumes: the wait for the answer counts.
    s.last = Math.max(s.last ?? 0, n.at);
  }
  for (const t of n.tools ?? []) s.tools[t] = ownOrNew(s.tools, t, () => 0) + 1;
  for (const f of n.files ?? []) {
    const rel = s.cwd && f.startsWith(s.cwd + path.sep) ? f.slice(s.cwd.length + 1) : f;
    if (!s.files.includes(rel) && s.files.length < MAX_FILES) s.files.push(rel);
  }
}

// One call into the session, its day's facts and its window slot.
function applyCall(pl: ProfileLedger, c: Call, file: string, mine: boolean): void {
  const s = session(pl, c.session, file, mine, c.at);
  place(s, c.at, c.cwd, c.entry);
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
  addAgg(ownOrNew(c.subagent ? s.sub : s.models, c.model, emptyAgg), agg);
  const slot = String(Math.floor(c.at / SLOT_MS));
  s.slots[slot] = (s.slots[slot] ?? 0) + aggValue(agg);
  const fact = `${dayOf(c.at)}\t${c.model}\t${s.cwd ?? ''}`;
  addAgg(ownOrNew(pl.facts, fact, emptyAgg), agg);
}

// Whether a key was met before, marking it met if not, with the day of the
// line or response it belongs to.
function seenBefore(pl: ProfileLedger, key: string, at: number): boolean {
  const k = shortKey(key);
  if (own(pl.seen, k) !== undefined) return true;
  pl.seen[k] = Math.floor(at / DAY_MS);
  return false;
}

// Returns the time of the earliest event, if any.
function apply(pl: ProfileLedger, parsed: Parsed, file: string, mine: boolean): number | undefined {
  // In the order they happened, a note before a call at the same moment, so
  // a session knows its folder before its calls are filed and agent time
  // follows the conversation.
  const events = [
    ...parsed.notes.map((n) => ({ at: n.at, note: n })),
    ...parsed.calls.map((c) => ({ at: c.at, call: c })),
  ].sort((a, b) => a.at - b.at);
  for (const e of events) {
    if ('note' in e) {
      if (!e.note.key || !seenBefore(pl, e.note.key, e.note.at)) applyNote(pl, e.note, file, mine);
      continue;
    }
    const c = e.call;
    if (!c.key || !seenBefore(pl, c.key, c.at)) applyCall(pl, c, file, mine);
  }
  return events[0]?.at;
}

// A copy is made from a log that is still there, so a key older than the
// earliest line of every log present (by a day's slack) cannot be met again.
// Keys are kept no longer than sessions, though: Codex never deletes its
// rollouts, and a key for every response of a year would make the ledger
// tens of megabytes. A session resumed after that is rare, and could not be
// opened from the Usage tab anyway.
function prune(pl: ProfileLedger, now: number, present: Set<string>): void {
  for (const [id, s] of Object.entries(pl.sessions)) if (s.end < now - SESSION_DAYS * DAY_MS) delete pl.sessions[id];
  let first = Infinity;
  for (const k of present) {
    const st = own(pl.files, k);
    if (st?.first === undefined && st?.offset) first = -Infinity;
    else if (typeof st?.first === 'number') first = Math.min(first, st.first);
  }
  const horizon = Math.max(
    Number.isFinite(first) ? Math.floor(first / DAY_MS) - 1 : -Infinity,
    Math.floor(now / DAY_MS) - SESSION_DAYS,
  );
  for (const [k, day] of Object.entries(pl.seen)) if (day < horizon) delete pl.seen[k];
  const oldest = dayOf(now - FACT_DAYS * DAY_MS);
  for (const k of Object.keys(pl.facts)) if (k.slice(0, 10) < oldest) delete pl.facts[k];
  for (const k of Object.keys(pl.files)) if (!present.has(k)) delete pl.files[k];
}

const pause = () => new Promise<void>((resolve) => setImmediate(resolve));

// Read what the profiles' logs gained since the last pass. Returns whether
// anything changed. A profile no longer listed keeps its facts, how far its
// logs were read and what they held, so its usage stays in the totals and,
// should it come back, nothing is counted twice; its sessions go, as nothing
// could open them. A profile whose home moved starts reading afresh but
// keeps its facts and the keys it has seen, so logs that moved with it are
// not counted again.
export async function indexLogs(ledger: Ledger, profiles: LedgerProfile[], now = Date.now()): Promise<boolean> {
  let changed = false;
  for (const [id, pl] of Object.entries(ledger.profiles)) {
    if (!profiles.some((p) => p.id === id) && Object.keys(pl.sessions).length) {
      pl.sessions = {};
      changed = true;
    }
  }
  for (const p of profiles) {
    let pl = own(ledger.profiles, p.id);
    if (!pl || pl.vendor !== p.vendor) {
      pl = ledger.profiles[p.id] = {
        vendor: p.vendor,
        home: p.home,
        files: {},
        seen: {},
        facts: pl?.facts ?? {},
        sessions: {},
      };
      changed = true;
    } else if (pl.home !== p.home) {
      Object.assign(pl, { home: p.home, files: {}, sessions: {} });
      changed = true;
    }
    const files = await logFiles(p);
    // Oldest file first: a resumed Claude session and a Codex subagent copy
    // earlier lines into a newer file, and the first file to hold a line or
    // a response is the one it is counted in.
    const found: { key: string; file: string; size: number; born: number }[] = [];
    for (const [key, file] of files) {
      try {
        const stat = await fs.promises.stat(file);
        found.push({ key, file, size: stat.size, born: stat.birthtimeMs || stat.mtimeMs });
      } catch {
        continue;
      }
    }
    found.sort((a, b) => a.born - b.born || a.file.localeCompare(b.file));
    for (const { key, file, size } of found) {
      let st = own(pl.files, key);
      // A file that shrank was rewritten: read it again from the start.
      if (!st || size < st.offset) {
        st = { offset: 0, first: null, codex: p.vendor === 'codex' ? {} : undefined };
        pl.files[key] = st;
      }
      if (st.path && st.path !== file) {
        for (const s of Object.values(pl.sessions)) if (s.file === st.path) s.file = file;
        changed = true;
      }
      st.path = file;
      // A file that cannot be read (removed since it was listed, or not ours
      // to read) is left where it stopped and tried again next pass; it must
      // not hold up the files and profiles after it.
      try {
        while (st.offset < size) {
          const { lines, consumed } = await readFrom(file, st.offset, size);
          if (!consumed) break;
          st.offset += consumed;
          const parsed = p.vendor === 'claude' ? parseClaude(lines) : parseCodex(lines, (st.codex ??= {}));
          const mine = p.vendor === 'claude' ? !file.includes(`${path.sep}subagents${path.sep}`) : !st.codex?.subagent;
          const at = apply(pl, parsed, file, mine);
          if (at !== undefined && (st.first == null || at < st.first)) st.first = at;
          changed = true;
          await pause();
        }
      } catch {
        continue;
      }
    }
    prune(pl, now, new Set(files.keys()));
  }
  ledger.indexedAt = new Date(now).toISOString();
  return changed;
}
