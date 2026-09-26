// From the ledger and the window history to what the Usage tab and the
// `switchboard tokens` command show, for one range of days. Pure: the caller
// supplies the ledger, the window records, the live windows and the time.
//
// Folders become their names here, and session files are left behind; the
// report is what crosses to the renderer, so it carries no paths.

import * as path from 'node:path';
import type { TokenCounts, UsageBlock, UsageReport, UsageSession, UsageTotals } from '../types';
import {
  addAgg,
  aggCounts,
  aggTokens,
  aggValue,
  DAY_MS,
  dayOf,
  emptyAgg,
  SLOT_MS,
  type Agg,
  type Ledger,
  type SessionRecord,
} from './ledger';
import { PRICES_AS_OF } from './prices';
import {
  forecast,
  instances,
  tightest,
  waited,
  windowLength,
  type LiveProfile,
  type WindowInstance,
  type WindowRecord,
} from './windows';

export interface ReportInput {
  ledger: Ledger;
  records: WindowRecord[];
  live: LiveProfile[];
  days: number;
  now: number;
}

const HEAT_DAYS = 26 * 7;
const TOP = 8;
const MAX_BLOCKS = 60;

// Midnight, local time, `n` days before the day of `ms`.
function startOfDay(ms: number, back = 0): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - back);
  return d.getTime();
}

function factParts(key: string): { day: string; model: string; cwd: string } {
  const [day, model, cwd] = key.split('\t');
  return { day, model, cwd };
}

// Folder names for display: the last part of the path, with its parent
// added where two folders share a name.
function folderNames(paths: Iterable<string>): Map<string, string> {
  const all = [...new Set(paths)].filter(Boolean);
  const base = (p: string) => path.basename(p) || p;
  const count = new Map<string, number>();
  for (const p of all) count.set(base(p), (count.get(base(p)) ?? 0) + 1);
  return new Map(
    all.map((p) => [p, (count.get(base(p)) ?? 0) > 1 ? path.join(path.basename(path.dirname(p)), base(p)) : base(p)]),
  );
}

const overlaps = (s: SessionRecord, from: number, to: number) => s.end >= from && s.start < to;

function sessionTotals(s: SessionRecord): Agg {
  const a = emptyAgg();
  for (const m of Object.values(s.models)) addAgg(a, m);
  for (const m of Object.values(s.sub)) addAgg(a, m);
  return a;
}

function mainModel(models: Record<string, Agg>): string | null {
  let best: [string, Agg] | null = null;
  for (const e of Object.entries(models)) {
    if (!best || aggValue(e[1]) > aggValue(best[1]) || (!aggValue(best[1]) && aggTokens(e[1]) > aggTokens(best[1])))
      best = e;
  }
  return best ? best[0] : null;
}

const valueOrNull = (a: Agg): number | null => (aggValue(a) > 0 || a.u === 0 ? aggValue(a) : null);

function cacheHit(t: TokenCounts): number | null {
  const input = t.input + t.cacheRead + t.cacheWrite;
  return input ? Math.round((t.cacheRead / input) * 100) : null;
}

// The value of a session's calls in [from, to), counting the five-minute
// slots that overlap it: a window opens mid-slot, with its first response.
function slotValue(s: SessionRecord, from: number, to: number): number {
  let v = 0;
  for (const [slot, value] of Object.entries(s.slots)) {
    const at = Number(slot) * SLOT_MS;
    if (at + SLOT_MS > from && at < to) v += value;
  }
  return v;
}

function sessionView(id: string, profile: string, s: SessionRecord, names: Map<string, string>): UsageSession {
  const all = sessionTotals(s);
  const tokens = aggCounts(all);
  const sub = emptyAgg();
  for (const m of Object.values(s.sub)) addAgg(sub, m);
  return {
    id,
    profile,
    title: s.title ?? 'Untitled session',
    project: s.cwd ? (names.get(s.cwd) ?? path.basename(s.cwd)) : '',
    entry: s.entry,
    start: new Date(s.start).toISOString(),
    end: new Date(s.end).toISOString(),
    prompts: s.prompts,
    agentMs: s.ms,
    model: mainModel(s.models) ?? mainModel(s.sub),
    value: valueOrNull(all),
    tokens,
    cacheHit: cacheHit(tokens),
    tools: Object.entries(s.tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6),
    files: s.files.slice(0, 5),
    fileCount: s.files.length,
    subagents: sub.n ? { calls: sub.n, value: valueOrNull(sub), model: mainModel(s.sub) } : null,
    share: null,
  };
}

// The shortest window a profile has history for, preferring the plain one
// ("5h" over "Spark 5h"), is the one sessions are grouped by.
function groupingLabel(list: WindowInstance[]): string | null {
  let best: string | null = null;
  for (const i of list) {
    const len = windowLength(i.label) ?? Infinity;
    const cur = best ? (windowLength(best) ?? Infinity) : Infinity;
    if (!best || len < cur || (len === cur && i.label.length < best.length)) best = i.label;
  }
  return best;
}

export function buildReport({ ledger, records, live, days, now }: ReportInput): UsageReport {
  const since = startOfDay(now, days - 1);
  const until = now;
  const prevSince = since - days * DAY_MS;
  const fromDay = dayOf(since);
  const prevDay = dayOf(prevSince);

  let firstDay: string | null = null;
  const cwds: string[] = [];
  for (const pl of Object.values(ledger.profiles)) {
    for (const key of Object.keys(pl.facts)) {
      const f = factParts(key);
      if (!firstDay || f.day < firstDay) firstDay = f.day;
      cwds.push(f.cwd);
    }
    for (const s of Object.values(pl.sessions)) if (s.cwd) cwds.push(s.cwd);
  }
  const names = folderNames(cwds);
  const recordedSince = firstDay ?? (ledger.since ? dayOf(Date.parse(ledger.since)) : null);

  const insts = new Map(live.map((p) => [p.id, instances(records, p.id)]));

  const totals = (from: number, fromD: string, toD: string, to: number): UsageTotals => {
    const sum = emptyAgg();
    const folders = new Set<string>();
    let sessions = 0;
    for (const pl of Object.values(ledger.profiles)) {
      for (const [key, a] of Object.entries(pl.facts)) {
        const f = factParts(key);
        if (f.day < fromD || f.day > toD) continue;
        addAgg(sum, a);
        if (f.cwd) folders.add(f.cwd);
      }
      for (const s of Object.values(pl.sessions)) if (overlaps(s, from, to)) sessions++;
    }
    let limitHits = 0;
    let waitedMs = 0;
    for (const list of insts.values()) {
      for (const i of list) {
        if (i.hitAt === null || i.hitAt < from || i.hitAt >= to) continue;
        limitHits++;
        waitedMs += waited(i, now);
      }
    }
    return {
      value: aggValue(sum),
      tokens: aggCounts(sum),
      agentMs: sum.ms,
      sessions,
      projects: folders.size,
      limitHits,
      waitedMs,
      unpricedTokens: sum.u,
    };
  };

  const today = dayOf(now);
  const current = totals(since, fromDay, today, until);
  // Only a period recorded from its first day is worth comparing with.
  const hasPrevious = !!firstDay && firstDay <= prevDay;
  const previous = hasPrevious ? totals(prevSince, prevDay, dayOf(since - DAY_MS), since) : null;

  // Per day, per profile, and the breakdowns of the range.
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(dayOf(startOfDay(now, i)));
  const daily = dayList.map((day) => ({
    day,
    value: {} as Record<string, number>,
    tokens: {} as Record<string, number>,
  }));
  const dayIndex = new Map(dayList.map((d, i) => [d, i]));
  const heatDays: string[] = [];
  for (let i = HEAT_DAYS - 1; i >= 0; i--) heatDays.push(dayOf(startOfDay(now, i)));
  const heatMs = new Map<string, number>();
  const byProject = new Map<string, { a: Agg; profiles: Set<string>; sessions: number }>();
  const byModel = new Map<string, { a: Agg; sessions: number }>();
  const mix = emptyAgg();
  const accounts = new Map<string, Agg>();

  for (const [id, pl] of Object.entries(ledger.profiles)) {
    const acct = emptyAgg();
    for (const [key, a] of Object.entries(pl.facts)) {
      const f = factParts(key);
      heatMs.set(f.day, (heatMs.get(f.day) ?? 0) + a.ms);
      const di = dayIndex.get(f.day);
      if (di === undefined) continue;
      daily[di].value[id] = (daily[di].value[id] ?? 0) + aggValue(a);
      daily[di].tokens[id] = (daily[di].tokens[id] ?? 0) + aggTokens(a);
      addAgg(acct, a);
      addAgg(mix, a);
      if (f.cwd) {
        const p = byProject.get(f.cwd) ?? { a: emptyAgg(), profiles: new Set<string>(), sessions: 0 };
        addAgg(p.a, a);
        p.profiles.add(id);
        byProject.set(f.cwd, p);
      }
      const m = byModel.get(f.model) ?? { a: emptyAgg(), sessions: 0 };
      addAgg(m.a, a);
      byModel.set(f.model, m);
    }
    accounts.set(id, acct);
    for (const s of Object.values(pl.sessions)) {
      if (!overlaps(s, since, until)) continue;
      if (s.cwd && byProject.has(s.cwd)) (byProject.get(s.cwd) as { sessions: number }).sessions++;
      for (const model of new Set([...Object.keys(s.models), ...Object.keys(s.sub)])) {
        const m = byModel.get(model);
        if (m) m.sessions++;
      }
    }
  }

  const heat = heatDays.map((day) => ({
    day,
    agentMs: recordedSince && day >= recordedSince ? (heatMs.get(day) ?? 0) : null,
  }));

  const projects = [...byProject]
    .map(([cwd, p]) => ({
      name: names.get(cwd) ?? path.basename(cwd),
      profiles: [...p.profiles],
      value: aggValue(p.a),
      sessions: p.sessions,
      agentMs: p.a.ms,
    }))
    .sort((a, b) => b.value - a.value || b.agentMs - a.agentMs)
    .slice(0, TOP);

  const models = [...byModel]
    .map(([model, m]) => ({ model, value: valueOrNull(m.a), tokens: aggTokens(m.a), sessions: m.sessions }))
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1) || b.tokens - a.tokens);

  const kinds: (keyof TokenCounts)[] = ['input', 'output', 'cacheRead', 'cacheWrite'];

  return {
    days,
    generatedAt: new Date(now).toISOString(),
    recordedSince,
    indexedAt: ledger.indexedAt,
    pricesAsOf: PRICES_AS_OF,
    totals: current,
    previous,
    accounts: live.map((p) => {
      const a = accounts.get(p.id) ?? emptyAgg();
      return { profile: p.id, tightest: tightest(p.windows, now), value: aggValue(a), tokens: aggCounts(a) };
    }),
    forecast: forecast(records, live, now),
    daily,
    heat,
    projects,
    models,
    mix: kinds.map((kind, i) => ({ kind, tokens: mix.t[i], value: mix.v[i] })),
    cacheHit: live.map((p) => ({ profile: p.id, pct: cacheHit(aggCounts(accounts.get(p.id) ?? emptyAgg())) })),
    blocks: blocks(ledger, insts, names, since, until, now),
  };
}

// Each profile's sessions in the range, grouped by the window they started
// in, with each session's estimated share of that window; sessions no window
// history covers are grouped by day. Newest first.
function blocks(
  ledger: Ledger,
  insts: Map<string, WindowInstance[]>,
  names: Map<string, string>,
  since: number,
  until: number,
  now: number,
): UsageBlock[] {
  const out: UsageBlock[] = [];
  for (const [profile, pl] of Object.entries(ledger.profiles)) {
    const list = insts.get(profile) ?? [];
    const label = groupingLabel(list);
    const windows = list.filter((i) => i.label === label && i.end > since);
    const members = new Map<WindowInstance, [string, SessionRecord][]>();
    const byDay = new Map<string, [string, SessionRecord][]>();
    for (const entry of Object.entries(pl.sessions)) {
      const s = entry[1];
      if (!overlaps(s, since, until)) continue;
      // The window the session spent most of its time in; a window opens
      // with the first response, a little after the prompt that started it.
      let w: WindowInstance | undefined;
      let most = 0;
      for (const i of windows) {
        const overlap = Math.min(s.end, i.end) - Math.max(s.start, i.start);
        if (overlap >= 0 && (!w || overlap > most)) {
          w = i;
          most = overlap;
        }
      }
      if (w) members.set(w, [...(members.get(w) ?? []), entry]);
      else {
        const day = dayOf(s.start);
        byDay.set(day, [...(byDay.get(day) ?? []), entry]);
      }
    }
    for (const [w, entries] of members) {
      const inWindow = entries.map(([, s]) => slotValue(s, w.start, w.end));
      const total = inWindow.reduce((a, b) => a + b, 0);
      const sessions = entries.map(([id, s], i) => ({
        ...sessionView(id, profile, s, names),
        share: total > 0 ? Math.round((w.peak * inWindow[i]) / total) : null,
      }));
      out.push({
        profile,
        kind: 'window',
        label: w.label,
        start: new Date(w.start).toISOString(),
        end: new Date(w.end).toISOString(),
        peak: w.peak,
        hitAt: w.hitAt === null ? null : new Date(w.hitAt).toISOString(),
        waitedMs: waited(w, now),
        current: now >= w.start && now < w.end,
        value: total,
        points: w.points,
        sessions: sessions.sort((a, b) => b.start.localeCompare(a.start)),
      });
    }
    for (const [day, entries] of byDay) {
      const sessions = entries.map(([id, s]) => sessionView(id, profile, s, names));
      const start = new Date(`${day}T00:00:00`).getTime();
      out.push({
        profile,
        kind: 'day',
        label: day,
        start: new Date(start).toISOString(),
        end: new Date(start + DAY_MS).toISOString(),
        peak: null,
        hitAt: null,
        waitedMs: 0,
        current: false,
        value: sessions.reduce((a, s) => a + (s.value ?? 0), 0),
        points: [],
        sessions: sessions.sort((a, b) => b.start.localeCompare(a.start)),
      });
    }
  }
  return out.sort((a, b) => b.start.localeCompare(a.start)).slice(0, MAX_BLOCKS);
}

// A session's transcript and folder, for the main process to open. Never
// sent to the renderer.
export function sessionPaths(
  ledger: Ledger,
  profile: string,
  id: string,
): { file: string; cwd: string | null; vendor: SessionRecord['vendor'] } | null {
  const s = ledger.profiles[profile]?.sessions[id];
  return s ? { file: s.file, cwd: s.cwd, vendor: s.vendor } : null;
}
