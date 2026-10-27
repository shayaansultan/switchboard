// The window, the menu bar, the phone and the Claude profile band all say how
// full a window is and whether it will last. The band runs inside Claude's
// engine with its own copy of the pace arithmetic; this holds the copy to the
// app's, so the two never tell the same person different things.

import { test, expect } from 'bun:test';
import { pace as bandPace } from '../plugins/profile-band/hooks/limits';
import { pace, pointsAhead, severity, fullest } from '../src/shared/usage';
import { ago, resetsIn } from '../src/shared/time';

test("the profile band's pace agrees with the app's for every window it shows", () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  for (const label of ['5h', '7d', '7d Opus', 'Weekly']) {
    const span = label === '5h' ? 5 * 3600_000 : 7 * 24 * 3600_000;
    for (let remaining = 0; remaining <= 100; remaining += 5)
      for (let f = 0; f <= 1.05; f += 0.05) {
        const resetsAt = new Date(now + span * f).toISOString();
        expect(bandPace({ label, remaining, resetsAt, severity: null }, now)).toEqual(
          pace(label, remaining, resetsAt, now),
        );
      }
  }
});

test('points ahead of an even burn agree with whether the window lasts', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const span = 5 * 3600_000;
  // Halfway through, 60% used: 10 ahead, and it runs out before the reset.
  const half = new Date(now + span / 2).toISOString();
  expect(pointsAhead('Spark 5h', 40, half, now)).toBe(10);
  expect(pace('Spark 5h', 40, half, now)).toEqual({ runsOutAt: now + (40 * span) / 2 / 60 });
  for (let remaining = 5; remaining <= 100; remaining += 5)
    for (let f = 0.05; f <= 0.9; f += 0.05) {
      const resetsAt = new Date(now + span * f).toISOString();
      const ahead = pointsAhead('5h', remaining, resetsAt, now);
      const lasts = pace('5h', remaining, resetsAt, now);
      expect(ahead === null).toBe(lasts === null);
      if (ahead !== null && ahead > 0) expect(lasts).not.toBe('ok');
    }
});

test('a window turns amber at 70% used and coral at 90%, or when the vendor says so first', () => {
  expect([0, 69, 70, 89, 90].map((pct) => severity({ pct }))).toEqual(['ok', 'ok', 'warn', 'warn', 'bad']);
  expect(severity({ pct: 10, severity: 'critical' })).toBe('bad');
  expect(
    fullest([
      { label: '5h', pct: 40, resetsAt: null },
      { label: '7d', pct: 75, resetsAt: null },
      { label: 'x', pct: null, resetsAt: null },
    ])?.label,
  ).toBe('7d');
});

test('time reads the same in every surface', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const at = (min: number) => new Date(now + min * 60000).toISOString();
  expect([
    resetsIn(at(40), now),
    resetsIn(at(120), now),
    resetsIn(at(125), now),
    resetsIn(at(-1), now),
    resetsIn(null, now),
  ]).toEqual(['resets in 40m', 'resets in 2h', 'resets in 2h 5m', 'resets now', '']);
  expect([ago(at(0), now), ago(at(-5), now), ago(at(-125), now), ago(at(-60 * 72), now)]).toEqual([
    'just now',
    '5m ago',
    '2h ago',
    '3d ago',
  ]);
});
