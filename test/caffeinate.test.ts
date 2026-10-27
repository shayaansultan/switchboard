import { describe, expect, test } from 'bun:test';
import { CaffeinateController, type SleepBlocker, type Timers } from '../src/caffeinate';
import type { BridgeReply, SystemBridge } from '../src/system-bridge';
import { describeCaffeinate } from '../src/shared/caffeinate';

// A bridge that answers like the real one: facts from `state`, and a
// lid-closed hold the helper can end on its own.
function fakeBridge(start: { helper?: string; lid?: boolean; sleepDisabled?: boolean; battery?: number } = {}) {
  let helper = start.helper ?? 'installed';
  let sleepDisabled = start.sleepDisabled ?? false;
  let held = false;
  let stop: string | null = null;
  let listener: (event: BridgeReply) => void = () => {};
  const asked: BridgeReply[] = [];
  const awake = (extra: BridgeReply = {}) => ({
    fans: [],
    controlling: false,
    awake: { held, stop, sleepDisabled },
    ...extra,
  });
  const bridge: SystemBridge = {
    async request(request) {
      asked.push(request);
      switch (request.op) {
        case 'state':
          return { fans: [], helper, lid: start.lid ?? true, sleepDisabled };
        case 'install':
          helper = helper === 'not-installed' ? 'needs-approval' : helper;
          return { helper };
        case 'open-login-items':
          return {};
        case 'awake-hold':
          if ((start.battery ?? 100) < 20) return awake({ error: 'battery-low' });
          held = true;
          sleepDisabled = true;
          stop = null;
          return awake();
        case 'awake-release':
          held = false;
          sleepDisabled = false;
          return awake();
        case 'sleep-clear':
          sleepDisabled = false;
          return awake();
        case 'status':
          return awake();
        default:
          return { error: 'invalid-request' };
      }
    },
    onEvent(next) {
      listener = next;
    },
    close() {},
  };
  return {
    bridge,
    asked: () => asked.map((r) => r.op),
    holdSeconds: () => asked.filter((r) => r.op === 'awake-hold').map((r) => r.seconds),
    approve: () => {
      helper = 'installed';
    },
    // The helper ends the hold on its own and the bridge says so.
    end: (reason: string) => {
      held = false;
      sleepDisabled = false;
      stop = reason;
      listener({ event: 'status' });
    },
  };
}

function fakeBlocker() {
  const calls: string[] = [];
  const blocker: SleepBlocker = {
    start: (screen) => calls.push(screen ? 'screen' : 'system'),
    stop: () => calls.push('stop'),
  };
  return { blocker, calls };
}

function fakeTimers() {
  let pending: { run: () => void; at: number } | null = null;
  const timers: Timers = {
    set(run, ms) {
      pending = { run, at: ms };
      return () => {
        pending = null;
      };
    },
  };
  return { timers, fire: () => pending?.run(), pending: () => pending };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Caffeinate', () => {
  test('a lid-open session needs only the power assertion and ends on time', async () => {
    const fake = fakeBridge();
    const { blocker, calls } = fakeBlocker();
    const clock = fakeTimers();
    const controller = new CaffeinateController(
      fake.bridge,
      blocker,
      () => {},
      () => 0,
      clock.timers,
    );
    await controller.start(60, { screen: true });
    expect(controller.snapshot()).toMatchObject({ active: true, endsAt: 3_600_000, screen: true, lid: false });
    expect(calls).toEqual(['stop', 'screen']);
    expect(fake.asked()).not.toContain('awake-hold');
    expect(clock.pending()?.at).toBe(3_600_000);
    clock.fire();
    await settle();
    expect(controller.snapshot()).toMatchObject({ active: false, stop: 'time-limit' });
    expect(calls.at(-1)).toBe('stop');
  });

  test('until stopped has no timer, and Decaf clears the reason', async () => {
    const clock = fakeTimers();
    const controller = new CaffeinateController(
      fakeBridge().bridge,
      fakeBlocker().blocker,
      () => {},
      () => 0,
      clock.timers,
    );
    await controller.start(0);
    expect(controller.snapshot()).toMatchObject({ active: true, endsAt: null, limit: null });
    expect(clock.pending()).toBeNull();
    await controller.stop();
    expect(controller.snapshot()).toMatchObject({ active: false, stop: null });
  });

  test('the lid option holds sleep off through the helper and releases it', async () => {
    const fake = fakeBridge();
    const controller = new CaffeinateController(
      fake.bridge,
      fakeBlocker().blocker,
      () => {},
      () => 0,
      fakeTimers().timers,
    );
    await controller.start(120, { lid: true });
    expect(controller.snapshot()).toMatchObject({ active: true, lid: true, sleepDisabledElsewhere: false });
    expect(fake.holdSeconds()).toEqual([7200]);
    await controller.extend(60);
    expect(fake.holdSeconds()).toEqual([7200, 10800]);
    expect(controller.snapshot()).toMatchObject({ endsAt: 10_800_000, limit: 180 });
    await controller.stop();
    expect(fake.asked()).toContain('awake-release');
  });

  test('the helper ending a lid-closed hold ends the session and says why', async () => {
    const fake = fakeBridge();
    const { blocker, calls } = fakeBlocker();
    const controller = new CaffeinateController(
      fake.bridge,
      blocker,
      () => {},
      () => 0,
      fakeTimers().timers,
    );
    await controller.start(0, { lid: true });
    fake.end('battery-low');
    await settle();
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ active: false, lid: false, stop: 'battery-low' });
    expect(calls.at(-1)).toBe('stop');
    await controller.dismiss();
    expect(controller.snapshot().stop).toBeNull();
  });

  test('a first lid-closed session waits for approval and starts once allowed', async () => {
    const fake = fakeBridge({ helper: 'not-installed' });
    const controller = new CaffeinateController(
      fake.bridge,
      fakeBlocker().blocker,
      () => {},
      () => 0,
      fakeTimers().timers,
    );
    await controller.start(60, { lid: true });
    expect(controller.snapshot()).toMatchObject({ active: false, queued: true, notice: 'needs-approval' });
    expect(fake.asked()).toContain('open-login-items');
    fake.approve();
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ active: true, lid: true, queued: false, notice: null });
  });

  test('a low battery refuses the lid option without starting', async () => {
    const controller = new CaffeinateController(
      fakeBridge({ battery: 10 }).bridge,
      fakeBlocker().blocker,
      () => {},
      () => 0,
      fakeTimers().timers,
    );
    await controller.start(60, { lid: true });
    expect(controller.snapshot()).toMatchObject({ active: false, notice: 'battery-low' });
  });

  test('the lid option is refused where it cannot work', async () => {
    for (const [setup, message] of [
      [{ lid: false }, 'This Mac has no lid.'],
      [{ helper: 'unsigned' }, 'Needs Switchboard installed with a signing certificate.'],
    ] as [{ lid?: boolean; helper?: string }, string][]) {
      const controller = new CaffeinateController(fakeBridge(setup).bridge, fakeBlocker().blocker, () => {});
      await expect(controller.start(60, { lid: true })).rejects.toThrow(message);
      expect(controller.snapshot().active).toBe(false);
    }
    const none = new CaffeinateController(null, fakeBlocker().blocker, () => {});
    await none.start(30);
    expect(none.snapshot()).toMatchObject({ active: true, lidSupport: 'no-bridge' });
  });

  test('sleep turned off outside Caffeinate is reported and can be cleared', async () => {
    const fake = fakeBridge({ sleepDisabled: true });
    const controller = new CaffeinateController(fake.bridge, fakeBlocker().blocker, () => {});
    await controller.refresh();
    expect(controller.snapshot().sleepDisabledElsewhere).toBe(true);
    await controller.clear();
    expect(fake.asked()).toContain('sleep-clear');
    expect(controller.snapshot().sleepDisabledElsewhere).toBe(false);
  });

  test('rejects lengths the CLI and window never send', async () => {
    const controller = new CaffeinateController(fakeBridge().bridge, fakeBlocker().blocker, () => {});
    for (const minutes of [-1, 1441, 1.5]) await expect(controller.start(minutes)).rejects.toThrow();
  });

  test('describes the state for the CLI', async () => {
    const controller = new CaffeinateController(
      fakeBridge().bridge,
      fakeBlocker().blocker,
      () => {},
      () => 0,
      fakeTimers().timers,
    );
    expect(describeCaffeinate(controller.snapshot())).toBe('Decaf: the Mac sleeps as usual.');
    await controller.start(90, { screen: true, lid: true });
    expect(describeCaffeinate(controller.snapshot(), 0)).toBe(
      'Caffeinated for 90 more min (screen on, lid closed too).',
    );
  });
});
