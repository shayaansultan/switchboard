// The live stream's messages (api.ts `live`) and how the phone puts them back
// together (src/phone/data.ts). A phone often reaches the Mac through a
// Tailscale relay, where every byte costs time, and an overview with a
// hundred sessions runs to about 90 KB while one change usually touches one
// session. So the stream sends the whole overview once, then only what
// changed: sessions that are new or different, the keys of those that left,
// and any other part that moved. Both sides sort sessions the same way
// (`byRecent`), so the order never has to travel.
//
// Pure, with no Node imports: the phone bundles it too.

import type { Overview } from './hub';

type Session = Overview['sessions'][number];

export interface OverviewPatch {
  generatedAt: string;
  host?: string;
  profiles?: Overview['profiles'];
  // New or changed sessions, whole.
  sessions?: Session[];
  // `${profileId}/${id}` of sessions no longer listed.
  removed?: string[];
  pending?: Overview['pending'];
  reachable?: Overview['reachable'];
  failures?: Overview['failures'];
}

export type LiveMessage = { full: Overview } | { patch: OverviewPatch };

export const sessionKey = (s: { profileId: string; id: string }): string => `${s.profileId}/${s.id}`;

// Newest first, the way the hub lists sessions; ties by key, so the phone's
// order after a patch is the hub's exactly.
export const byRecent = (a: Session, b: Session): number =>
  b.updatedAt.localeCompare(a.updatedAt) || sessionKey(a).localeCompare(sessionKey(b));

const PARTS = ['profiles', 'pending', 'reachable', 'failures'] as const;

// What the stream last sent, to compare the next overview with.
export interface Sent {
  host: string;
  parts: Record<(typeof PARTS)[number], string>;
  sessions: Map<string, string>;
}

function remember(o: Overview): Sent {
  return {
    host: o.host,
    parts: {
      profiles: JSON.stringify(o.profiles),
      pending: JSON.stringify(o.pending),
      reachable: JSON.stringify(o.reachable),
      failures: JSON.stringify(o.failures),
    },
    sessions: new Map(o.sessions.map((s) => [sessionKey(s), JSON.stringify(s)])),
  };
}

// The message for `next`, or null when nothing a phone shows has changed.
export function diff(sent: Sent | null, next: Overview): { message: LiveMessage | null; sent: Sent } {
  const now = remember(next);
  if (!sent) return { message: { full: next }, sent: now };
  const patch: OverviewPatch = { generatedAt: next.generatedAt };
  let changed = false;
  if (now.host !== sent.host) {
    patch.host = next.host;
    changed = true;
  }
  for (const part of PARTS)
    if (now.parts[part] !== sent.parts[part]) {
      Object.assign(patch, { [part]: next[part] });
      changed = true;
    }
  const sessions = next.sessions.filter((s) => sent.sessions.get(sessionKey(s)) !== now.sessions.get(sessionKey(s)));
  if (sessions.length) {
    patch.sessions = sessions;
    changed = true;
  }
  const removed = [...sent.sessions.keys()].filter((k) => !now.sessions.has(k));
  if (removed.length) {
    patch.removed = removed;
    changed = true;
  }
  return changed ? { message: { patch }, sent: now } : { message: null, sent };
}

// The overview a message makes of the one the phone has.
export function apply(current: Overview | undefined, message: LiveMessage): Overview | undefined {
  if ('full' in message) return message.full;
  if (!current) return current;
  const { sessions, removed, ...rest } = message.patch;
  const gone = new Set(removed ?? []);
  const fresh = new Map((sessions ?? []).map((s) => [sessionKey(s), s]));
  const kept = current.sessions.filter((s) => !gone.has(sessionKey(s)) && !fresh.has(sessionKey(s)));
  return { ...current, ...rest, sessions: [...kept, ...fresh.values()].sort(byRecent) };
}
