import { describe, expect, test } from 'bun:test';
import {
  AwakeController,
  classifyWriteError,
  isAwakeValue,
  parseSleepDisabled,
  type AwakeState,
  type AwakeSystem,
  type AwakeValue,
  type ReadResult,
  type WriteResult,
} from '../src/awake';

function output(setting = ''): string {
  return `System-wide power settings:\n${setting}\nCurrently in use:\n sleep 1 (sleep prevented by Claude)\n displaysleep 10\n`;
}

describe('pmset readback', () => {
  test('reads the global setting rather than the idle sleep timer', () => {
    expect(parseSleepDisabled(output(' SleepDisabled\t1'))).toEqual({ ok: true, value: 'on' });
    expect(parseSleepDisabled(output(' SleepDisabled 0'))).toEqual({ ok: true, value: 'off' });
  });

  test('a never-set key is off only within a complete pmset response', () => {
    expect(parseSleepDisabled(output())).toEqual({ ok: true, value: 'off' });
    for (const invalid of [
      '',
      'permission denied',
      'sleep 0',
      'System-wide power settings:\n',
      'Currently in use:\n sleep 1',
    ]) {
      expect(parseSleepDisabled(invalid)).toEqual({ ok: false });
    }
  });

  test('malformed and duplicated keys are unknown', () => {
    for (const setting of [
      'SleepDisabled 2',
      'SleepDisabled',
      'SleepDisabled yes',
      'SleepDisabled 1 junk',
      'SleepDisabled 1\nSleepDisabled 0',
    ]) {
      expect(parseSleepDisabled(output(setting))).toEqual({ ok: false });
    }
  });

  test('runtime targets reject non-literals and shell text', () => {
    for (const value of [true, 1, null, {}, 'ON', 'on; touch /tmp/nope']) expect(isAwakeValue(value)).toBe(false);
    expect(isAwakeValue('on')).toBe(true);
    expect(isAwakeValue('off')).toBe(true);
  });

  test('authorization outcomes do not depend on localized English text', () => {
    expect(classifyWriteError({ stderr: 'Abgebrochen (-128)' })).toEqual({ ok: false, notice: 'cancelled' });
    expect(classifyWriteError({ killed: true })).toEqual({ ok: false, notice: 'timed-out' });
    expect(classifyWriteError(new Error('unknown'))).toEqual({ ok: false, notice: 'write-failed' });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakeSystem implements AwakeSystem {
  value: AwakeValue = 'off';
  readable = true;
  applyWrite = true;
  reads = 0;
  writes: AwakeValue[] = [];
  result: WriteResult = { ok: true };
  readGate: Promise<void> | null = null;
  writeGate: Promise<void> | null = null;

  async read(): Promise<ReadResult> {
    this.reads++;
    if (this.readGate) await this.readGate;
    return this.readable ? { ok: true, value: this.value } : { ok: false };
  }

  async write(value: AwakeValue): Promise<WriteResult> {
    this.writes.push(value);
    if (this.writeGate) await this.writeGate;
    if (this.applyWrite && this.result.ok) this.value = value;
    return this.result;
  }
}

function fixture() {
  const system = new FakeSystem();
  const states: AwakeState[] = [];
  const controller = new AwakeController(system, (state) => states.push(state));
  return { system, states, controller };
}

describe('keep-awake controller', () => {
  test('explicit recheck waits for an observation and still clears its notice', async () => {
    const { system, controller } = fixture();
    system.result = { ok: false, notice: 'cancelled' };
    await controller.set('on');
    const gate = deferred<void>();
    system.readGate = gate.promise;
    const observe = controller.refresh();
    const recheck = controller.refresh('recheck');
    gate.resolve();
    await Promise.all([observe, recheck]);
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'off', notice: null });
  });

  test('explicit recheck clears notices while passive reads preserve them', async () => {
    const { system, controller } = fixture();
    system.result = { ok: false, notice: 'cancelled' };
    await controller.set('on');
    await controller.refresh();
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'off', notice: 'cancelled' });
    await controller.refresh('recheck');
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'off', notice: null });
  });

  test('unchanged reads do not notify the UI again', async () => {
    const { controller, states } = fixture();
    await controller.refresh();
    await controller.refresh();
    expect(states).toHaveLength(1);
  });

  test('a fresh process detects an already enabled system and can turn it off', async () => {
    const { system, controller } = fixture();
    system.value = 'on';
    await controller.refresh();
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'on', notice: null });
    await controller.set('off');
    expect(system.writes).toEqual(['off']);
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'off', notice: null });
  });

  test('only reports on after readback, not when the write starts', async () => {
    const { system, controller } = fixture();
    const gate = deferred<void>();
    system.writeGate = gate.promise;
    const change = controller.set('on');
    expect(controller.snapshot().status).toBe('changing');
    gate.resolve();
    await change;
    expect(system.reads).toBe(2);
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'on', notice: null });
  });

  test.each(['cancelled', 'write-failed', 'timed-out'] as const)('reads back after %s', async (notice) => {
    const { system, controller } = fixture();
    system.result = { ok: false, notice };
    await controller.set('on');
    expect(system.reads).toBe(2);
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'off', notice });
  });

  test('an exit-successful write that did not apply is not shown as successful', async () => {
    const { system, controller } = fixture();
    system.applyWrite = false;
    await controller.set('on');
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'off', notice: 'not-applied' });
  });

  test('failed read is unknown and can recover on the next poll', async () => {
    const { system, controller } = fixture();
    system.value = 'on';
    await controller.refresh();
    system.readable = false;
    await controller.refresh();
    expect(controller.snapshot()).toEqual({ status: 'unavailable', lastKnown: 'on' });
    system.readable = true;
    system.value = 'off';
    await controller.refresh();
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'off', notice: null });
  });

  test('a recovery off command remains available while reads fail', async () => {
    const { system, controller } = fixture();
    system.value = 'on';
    system.readable = false;
    await controller.set('off');
    expect(system.value).toBe('off');
    expect(controller.snapshot()).toEqual({ status: 'unavailable', lastKnown: null });
  });

  test('does not authorize a redundant change', async () => {
    const { system, controller } = fixture();
    await controller.set('off');
    expect(system.writes).toEqual([]);
  });

  test('polling detects external changes without writing', async () => {
    const { system, controller } = fixture();
    await controller.refresh();
    system.value = 'on';
    await controller.refresh();
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'on', notice: null });
    expect(system.writes).toEqual([]);
  });

  test('double clicks, opposite requests and polls do not overlap authorization', async () => {
    const { system, controller } = fixture();
    const gate = deferred<void>();
    system.writeGate = gate.promise;
    const first = controller.set('on');
    const duplicate = controller.set('on');
    const opposite = controller.set('off');
    const poll = controller.refresh();
    gate.resolve();
    await Promise.all([first, duplicate, opposite, poll]);
    expect(system.writes).toEqual(['on']);
    expect(system.reads).toBe(2);
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'on', notice: null });
  });

  test('a write waits for an in-flight read without using its stale snapshot', async () => {
    const { system, controller } = fixture();
    const gate = deferred<void>();
    system.readGate = gate.promise;
    const read = controller.refresh();
    const first = controller.set('on');
    const second = controller.set('on');
    gate.resolve();
    await Promise.all([read, first, second]);
    expect(system.writes).toEqual(['on']);
    expect(controller.snapshot()).toEqual({ status: 'ready', value: 'on', notice: null });
  });
});
