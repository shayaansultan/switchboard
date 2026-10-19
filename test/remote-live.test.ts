// The live stream sends the overview once, then only what changed
// (src/remote/live.ts). These pin that the phone, applying each message to
// what it has, always ends with exactly the hub's overview.

import { test, expect } from 'bun:test';
import type { Overview } from '../src/remote/hub';
import { apply, diff, type LiveMessage, type Sent } from '../src/remote/live';
import type { SessionSummary } from '../src/remote/model';

const session = (id: string, updatedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  profileId: 'claude-work',
  vendor: 'claude',
  title: id,
  cwd: null,
  branch: null,
  origin: 'desktop',
  state: 'working',
  updatedAt,
  lastMessage: null,
  plan: null,
  needs: null,
  background: 0,
  prs: [],
  model: null,
  costUsd: null,
  ...extra,
});

const overview = (sessions: SessionSummary[], extra: Partial<Overview> = {}): Overview => ({
  host: 'Mac',
  generatedAt: new Date().toISOString(),
  profiles: [],
  sessions,
  pending: [],
  reachable: [],
  failures: {},
  ...extra,
});

test("each overview, rebuilt from messages, is the hub's, and an unchanged one sends nothing", () => {
  const steps = [
    overview([session('a', '2026-10-19T01:00:00Z'), session('b', '2026-10-19T00:00:00Z')]),
    // b updates and moves to the top; a is unchanged.
    overview([session('b', '2026-10-19T02:00:00Z', { state: 'finished' }), session('a', '2026-10-19T01:00:00Z')]),
    // c arrives, a leaves, and the session can now be replied to.
    overview([session('c', '2026-10-19T03:00:00Z'), session('b', '2026-10-19T02:00:00Z', { state: 'finished' })], {
      reachable: ['claude-work/c'],
    }),
  ];
  let sent: Sent | null = null;
  let phone: Overview | undefined;
  const messages: LiveMessage[] = [];
  for (const o of steps) {
    const d = diff(sent, o);
    sent = d.sent;
    if (d.message) {
      messages.push(d.message);
      phone = apply(phone, d.message);
    }
    expect({ ...phone, generatedAt: '' }).toEqual({ ...o, generatedAt: '' });
  }
  expect(messages[1]).toEqual({ patch: { generatedAt: steps[1].generatedAt, sessions: [steps[1].sessions[0]] } });
  expect(messages[2]).toMatchObject({
    patch: { sessions: [{ id: 'c' }], removed: ['claude-work/a'], reachable: ['claude-work/c'] },
  });
  // Nothing new: no message at all.
  expect(diff(sent, { ...steps[2], generatedAt: 'later' }).message).toBeNull();
});

test('a patch is far smaller than the overview it updates', () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    session(`s${i}`, `2026-10-19T00:${String(i % 60).padStart(2, '0')}:00Z`, {
      lastMessage: { role: 'assistant', text: 'x'.repeat(300) },
    }),
  );
  const first = diff(null, overview(many));
  const changed = many.map((s, i) => (i === 7 ? { ...s, state: 'finished' as const } : s));
  const second = diff(first.sent, overview(changed));
  expect(JSON.stringify(second.message).length * 50).toBeLessThan(JSON.stringify(first.message).length);
});
