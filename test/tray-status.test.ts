import { expect, test } from 'bun:test';
import { composeTrayText } from '../src/tray-status';

test('usage and awake indicators coexist in the shared status item', () => {
  const usage = { title: ' 43%', tooltip: 'Work: 7d 43%' };

  expect(composeTrayText(usage, { status: 'ready', value: 'on', notice: null })).toEqual({
    title: ' 43% ☀',
    tooltip: 'Work: 7d 43% · Keep awake is on',
  });
  expect(composeTrayText(usage, { status: 'ready', value: 'off', notice: null })).toEqual(usage);
  expect(composeTrayText(usage, { status: 'unavailable', lastKnown: 'on' })).toEqual({
    title: ' 43% !',
    tooltip: 'Work: 7d 43% · Sleep setting unavailable',
  });
  expect(composeTrayText(usage, { status: 'changing', target: 'on', lastKnown: 'off' }).title).toBe(' 43% …');
});

test('awake status remains visible when no account has usage data', () => {
  expect(
    composeTrayText({ title: '', tooltip: 'Switchboard' }, { status: 'ready', value: 'on', notice: null }),
  ).toEqual({
    title: ' ☀',
    tooltip: 'Switchboard · Keep awake is on',
  });
});
