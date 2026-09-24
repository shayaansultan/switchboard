import { expect, test } from 'bun:test';
import { AppStates, QUIT_DEADLINE_MS, START_DEADLINE_MS } from '../src/app-state';

function clock() {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
const alive = (entries: Record<string, boolean>) => new Map(Object.entries(entries));

test('the process list alone decides when nothing was asked for', () => {
  const s = new AppStates();
  expect(s.observe(alive({ a: true, b: false }))).toBe(true);
  expect(s.get('a')).toBe('running');
  expect(s.get('b')).toBe('off');
  expect(s.observe(alive({ a: true, b: false }))).toBe(false);
  // Quit from outside Switchboard (Cmd+Q, a crash): the next look says so.
  expect(s.observe(alive({ a: false, b: false }))).toBe(true);
  expect(s.get('a')).toBe('off');
});

test('a quit shows as quitting until the process is gone', async () => {
  const c = clock();
  const s = new AppStates(c.now);
  s.observe(alive({ a: true }));
  s.expect('a', 'quitting');
  expect(s.get('a')).toBe('quitting');
  expect(s.busy).toBe(true);
  const done = s.settled('a');
  c.advance(1_500);
  s.observe(alive({ a: true }));
  expect(s.get('a')).toBe('quitting');
  c.advance(1_000);
  s.observe(alive({ a: false }));
  expect(s.get('a')).toBe('off');
  expect(s.busy).toBe(false);
  expect(await done).toEqual({ id: 'a', state: 'off' });
});

test('a quit the app ignores past the deadline is stalled, and clears when it finally exits', async () => {
  const c = clock();
  const s = new AppStates(c.now);
  s.observe(alive({ a: true }));
  s.expect('a', 'quitting');
  const done = s.settled('a');
  c.advance(QUIT_DEADLINE_MS);
  s.observe(alive({ a: true }));
  expect(s.get('a')).toBe('stalled');
  expect(s.busy).toBe(false);
  expect(await done).toEqual({ id: 'a', state: 'stalled' });
  // Stays stalled while alive, rather than drifting back to running.
  c.advance(60_000);
  s.observe(alive({ a: true }));
  expect(s.get('a')).toBe('stalled');
  s.observe(alive({ a: false }));
  expect(s.get('a')).toBe('off');
  s.observe(alive({ a: true }));
  expect(s.get('a')).toBe('running');
});

test('a launch shows as starting until the process appears', async () => {
  const c = clock();
  const s = new AppStates(c.now);
  s.observe(alive({ a: false }));
  s.expect('a', 'starting');
  const done = s.settled('a');
  s.observe(alive({ a: false }));
  expect(s.get('a')).toBe('starting');
  c.advance(800);
  s.observe(alive({ a: true }));
  expect(s.get('a')).toBe('running');
  expect(await done).toEqual({ id: 'a', state: 'running' });
});

test('a launch that never appears falls back to off and says so', async () => {
  const c = clock();
  const s = new AppStates(c.now);
  s.expect('a', 'starting');
  const done = s.settled('a');
  c.advance(START_DEADLINE_MS);
  s.observe(alive({ a: false }));
  expect(s.get('a')).toBe('off');
  expect(await done).toEqual({ id: 'a', state: 'off', failedToStart: true });
});

test('settled resolves at once when nothing is pending', async () => {
  const s = new AppStates();
  s.observe(alive({ a: true }));
  expect(await s.settled('a')).toEqual({ id: 'a', state: 'running' });
});

test('a removed profile drops its state and releases anyone waiting', async () => {
  const s = new AppStates();
  s.observe(alive({ a: true, b: true }));
  s.expect('a', 'quitting');
  const done = s.settled('a');
  expect(s.observe(alive({ b: true }))).toBe(true);
  expect(s.get('a')).toBe('off');
  expect(s.busy).toBe(false);
  expect(await done).toEqual({ id: 'a', state: 'off' });
});

test('a running app with no window open reads as background, and back when one opens', () => {
  const s = new AppStates();
  s.observe(alive({ a: true }), new Set(['a']));
  expect(s.get('a')).toBe('background');
  expect(s.observe(alive({ a: true }))).toBe(true);
  expect(s.get('a')).toBe('running');
});

test('with windows noticed, a launch waits for the window, not just the process', async () => {
  const c = clock();
  const s = new AppStates(c.now);
  s.expect('a', 'starting');
  const done = s.settled('a');
  s.observe(alive({ a: true }), new Set(['a']));
  expect(s.get('a')).toBe('starting');
  c.advance(700);
  s.observe(alive({ a: true }));
  expect(s.get('a')).toBe('running');
  expect(await done).toEqual({ id: 'a', state: 'running' });
});

test('a launch whose window never appears settles as background, not as a failure', async () => {
  const c = clock();
  const s = new AppStates(c.now);
  s.expect('a', 'starting');
  const done = s.settled('a');
  c.advance(START_DEADLINE_MS);
  s.observe(alive({ a: true }), new Set(['a']));
  expect(s.get('a')).toBe('background');
  expect(await done).toEqual({ id: 'a', state: 'background' });
});

test('quitting ignores windows: a windowless app being quit still reads as quitting', () => {
  const s = new AppStates();
  s.observe(alive({ a: true }), new Set(['a']));
  s.expect('a', 'quitting');
  s.observe(alive({ a: true }), new Set(['a']));
  expect(s.get('a')).toBe('quitting');
});
