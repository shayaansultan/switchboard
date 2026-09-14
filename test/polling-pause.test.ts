import { expect, test } from 'bun:test';
import { PollingPause } from '../src/polling-pause';

test('waking while locked keeps polling paused until unlock', () => {
  const state = new PollingPause();
  state.pause('lock');
  state.pause('sleep');
  expect(state.resume('sleep')).toBe(false);
  expect(state.paused).toBe(true);
  expect(state.resume('lock')).toBe(true);
  expect(state.paused).toBe(false);
  expect(state.resume('lock')).toBe(false);
});

test('unlocking before wake also waits for the last pause reason', () => {
  const state = new PollingPause();
  state.pause('sleep');
  state.pause('lock');
  expect(state.resume('lock')).toBe(false);
  expect(state.resume('sleep')).toBe(true);
});
