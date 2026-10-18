// When the Mac tells a phone something happened. The hub compares each new
// overview with the one before and turns the changes worth a buzz into
// notes; push.ts sends each note to the phones that want its kind, and for
// a session outside the desktop apps, only to phones that asked for all
// sessions.
//
// Only changes count, never a state the first look found: starting the app
// does not replay everything that already needs you. A session that appears
// later already needing you, or errored, counts. A session that finishes
// counts only after it worked for a while, so a quick answer to a quick
// question stays quiet. Usage warns once per window, as it crosses
// LIMIT_PCT, until that window resets.

import type { Overview } from './hub';
import type { Note } from './push';
import { fullest } from '../shared/usage';

// A session has to work this long before its finishing is news.
export const LONG_RUN_MS = 5 * 60_000;
export const LIMIT_PCT = 90;

export interface Watch {
  // `${profileId}/${sessionId}` → its state and when it started working.
  sessions: Map<string, { state: string; workingSince: number | null }>;
  // Windows already warned about: `${profileId}/${label}/${resetsAt}`.
  warned: Set<string>;
  // Requests already announced (control.ts), by id.
  asked: Set<string>;
}

export const emptyWatch = (): Watch => ({ sessions: new Map(), warned: new Set(), asked: new Set() });

// A request waiting on the person that is not in any session file yet: a
// tool approval or a question held for the phone (control.ts).
export interface Asking {
  id: string;
  profileId: string;
  sessionId: string;
  title: string;
}

const route = (profileId: string, sessionId: string) =>
  `#/s/${encodeURIComponent(profileId)}/${encodeURIComponent(sessionId)}`;

// The notes this overview brings, and what to compare the next one with.
// `first` seeds the watch without any notes.
export function changes(
  watch: Watch,
  overview: Overview,
  asking: Asking[],
  now = Date.now(),
  first = false,
): { notes: Note[]; watch: Watch } {
  const notes: Note[] = [];
  const label = new Map(overview.profiles.map((p) => [p.id, p.label]));
  const next: Watch = { sessions: new Map(), warned: new Set(watch.warned), asked: new Set() };

  for (const s of overview.sessions) {
    const key = `${s.profileId}/${s.id}`;
    const before = watch.sessions.get(key);
    const workingSince = s.state === 'working' ? (before?.state === 'working' ? before.workingSince : now) : null;
    next.sessions.set(key, { state: s.state, workingSince });
    if (first || before?.state === s.state) continue;
    // A session first seen after startup counts only for what needs a look.
    if (!before && s.state !== 'needs-you' && s.state !== 'errored') continue;
    const who = label.get(s.profileId) ?? s.profileId;
    const base = { tag: key, url: route(s.profileId, s.id), origin: s.origin };
    if (s.state === 'needs-you')
      notes.push({ ...base, kind: 'needs', title: s.title, body: `${who} asks: ${s.needs ?? 'a question for you'}` });
    else if (s.state === 'errored')
      notes.push({ ...base, kind: 'errored', title: s.title, body: `${who} stopped with an error` });
    else if (
      s.state === 'finished' &&
      before?.state === 'working' &&
      before.workingSince !== null &&
      now - before.workingSince >= LONG_RUN_MS
    )
      notes.push({
        ...base,
        kind: 'finished',
        title: s.title,
        body: s.lastMessage?.role === 'assistant' ? `${who}: ${s.lastMessage.text}` : `${who} finished`,
      });
  }

  const origin = new Map(overview.sessions.map((s) => [`${s.profileId}/${s.id}`, s.origin]));
  for (const a of asking) {
    next.asked.add(a.id);
    if (first || watch.asked.has(a.id)) continue;
    const who = label.get(a.profileId) ?? a.profileId;
    const key = `${a.profileId}/${a.sessionId}`;
    notes.push({
      kind: 'needs',
      title: a.title,
      body: `${who} is waiting for you`,
      tag: key,
      url: route(a.profileId, a.sessionId),
      // A session not listed yet is new; the desktop apps are where requests come from.
      origin: origin.get(key) ?? 'desktop',
    });
  }

  for (const p of overview.profiles) {
    const w = fullest(p.windows);
    if (!w || w.pct === null || w.pct < LIMIT_PCT) continue;
    const key = `${p.id}/${w.label}/${w.resetsAt ?? ''}`;
    if (next.warned.has(key)) continue;
    next.warned.add(key);
    if (!first)
      notes.push({
        kind: 'limits',
        title: `${p.label} is running low`,
        body: `${Math.round(w.pct)}% of its ${w.label} window used`,
        tag: `limits/${p.id}`,
        url: '#/accounts',
      });
  }
  return { notes, watch: next };
}
