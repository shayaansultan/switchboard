import { expect, test } from 'bun:test';
import { composeTrayText } from '../src/tray-status';
import type { CaffeinateState } from '../src/shared/caffeinate';

const decaf: CaffeinateState = {
  active: false,
  endsAt: null,
  limit: null,
  screen: false,
  lid: false,
  lidSupport: 'available',
  helper: 'installed',
  sleepDisabledElsewhere: false,
  stop: null,
  notice: null,
  queued: false,
  busy: false,
};

test('usage and Caffeinate share the status item', () => {
  const usage = { title: ' 43%', tooltip: 'Work: 7d 43%' };
  expect(composeTrayText(usage, decaf)).toEqual(usage);
  expect(composeTrayText(usage, { ...decaf, active: true })).toEqual({
    title: ' 43% ☕',
    tooltip: 'Work: 7d 43% · Caffeinated',
  });
  expect(composeTrayText(usage, { ...decaf, active: true, lid: true }).tooltip).toBe(
    'Work: 7d 43% · Caffeinated, lid closed too',
  );
});

test('Caffeinate stays visible when no account has usage data', () => {
  expect(composeTrayText({ title: '', tooltip: 'Switchboard' }, { ...decaf, active: true })).toEqual({
    title: ' ☕',
    tooltip: 'Switchboard · Caffeinated',
  });
});
