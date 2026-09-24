import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { BACKGROUND_MS, BUSY_MS, DesktopWatch, VISIBLE_MS, nextCheckDelay } from '../src/desktop-watch';

const tick = () => new Promise((r) => setTimeout(r, 0));

test('the cadence is fast while waiting, slow when events cover it or nobody is looking', () => {
  expect(nextCheckDelay({ busy: true, events: true, visible: false })).toBe(BUSY_MS);
  expect(nextCheckDelay({ busy: false, events: true, visible: true })).toBe(BACKGROUND_MS);
  expect(nextCheckDelay({ busy: false, events: false, visible: true })).toBe(VISIBLE_MS);
  expect(nextCheckDelay({ busy: false, events: false, visible: false })).toBe(BACKGROUND_MS);
});

// A stand-in for the app-events helper: a process whose stdout we write to.
function fakeHelper() {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new PassThrough();
  Object.assign(proc, { stdout, kill: () => proc.emit('exit', 0) });
  return { proc, say: (o: object) => stdout.write(`${JSON.stringify(o)}\n`) };
}

test('a launch or quit of a tracked app triggers a check; other apps do not', async () => {
  let checks = 0;
  const helper = fakeHelper();
  const watch = new DesktopWatch({
    check: async () => void checks++,
    busy: () => false,
    tracks: (exe) => exe === '/Applications/Claude.app/Contents/MacOS/Claude',
    helper: '/fake/app-events',
    spawn: () => helper.proc,
  });
  watch.start();
  await tick();
  expect(checks).toBe(1);
  helper.say({ event: 'ready' });
  await tick();
  expect(watch.usingEvents).toBe(true);
  helper.say({ event: 'launch', pid: 1, exe: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit' });
  await tick();
  expect(checks).toBe(1);
  helper.say({ event: 'terminate', pid: 2, exe: '/Applications/Claude.app/Contents/MacOS/Claude' });
  await tick();
  expect(checks).toBe(2);
  watch.stop();
  expect(watch.usingEvents).toBe(false);
});

test('pokes during a check collapse into one more check', async () => {
  let checks = 0;
  let release: () => void = () => {};
  const watch = new DesktopWatch({
    check: () => {
      checks++;
      return new Promise<void>((r) => (release = r));
    },
    busy: () => false,
    tracks: () => true,
    helper: null,
  });
  watch.poke();
  watch.poke();
  watch.poke();
  expect(checks).toBe(1);
  release();
  await tick();
  expect(checks).toBe(2);
  release();
  await tick();
  expect(checks).toBe(2);
  watch.stop();
});

test('paused, it neither checks nor schedules', async () => {
  let checks = 0;
  const watch = new DesktopWatch({
    check: async () => void checks++,
    busy: () => true,
    tracks: () => true,
    helper: null,
  });
  watch.setPaused(true);
  watch.poke();
  await new Promise((r) => setTimeout(r, BUSY_MS * 2));
  expect(checks).toBe(0);
  watch.setPaused(false);
  await tick();
  expect(checks).toBe(1);
  watch.stop();
});

test('while a launch or quit is pending it keeps looking every 250 ms', async () => {
  let checks = 0;
  const watch = new DesktopWatch({
    check: async () => void checks++,
    busy: () => true,
    tracks: () => true,
    helper: null,
  });
  watch.poke();
  await new Promise((r) => setTimeout(r, BUSY_MS * 3 + 100));
  expect(checks).toBeGreaterThanOrEqual(3);
  watch.stop();
});
