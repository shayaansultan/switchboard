import { describe, expect, test } from 'bun:test';
import { FanController } from '../src/fans';
import type { BridgeReply, SystemBridge } from '../src/system-bridge';
import { describeFans, isFanLevel, type FanState, type FanUnavailable } from '../src/shared/fans';

const fan = (actual: number, manual = false) => ({ actual, minimum: 2317, maximum: 7826, target: actual, manual });

// A bridge that answers like the real one and records what it was asked.
function fakeBridge(start: { helper?: string; fans?: unknown[]; now?: () => number } = {}) {
  // Typed loosely so each case can pass only what it changes.
  let helper = start.helper ?? 'installed';
  let fans = start.fans ?? [fan(2317), fan(2502)];
  let listener: (event: BridgeReply) => void = () => {};
  const asked: string[] = [];
  const now = start.now ?? (() => 0);
  // `until` is in the controller's clock, so time left counts down like the helper's.
  let holding: { level: number; until: number | null } | null = null;
  let stop: string | null = null;
  const status = (extra: BridgeReply = {}) => ({
    fans,
    temperature: 48.2,
    controlling: holding !== null,
    level: holding?.level ?? null,
    endsIn: holding?.until != null ? Math.round((holding.until - now()) / 1000) : null,
    stop,
    ...extra,
  });
  const bridge: SystemBridge = {
    async request(request) {
      asked.push(String(request.op));
      switch (request.op) {
        case 'state':
          return { fans, temperature: 48.2, helper };
        case 'install':
          helper = helper === 'not-installed' ? 'needs-approval' : helper;
          return { helper };
        case 'open-login-items':
          return {};
        case 'set':
          if (fans.some((f) => (f as { manual: boolean }).manual) && !holding)
            return status({ error: 'already-controlled' });
          holding = {
            level: Number(request.level),
            until: Number(request.seconds) ? now() + Number(request.seconds) * 1000 : null,
          };
          stop = null;
          return status();
        case 'system':
          holding = null;
          return status();
        case 'status':
          return status();
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
    asked,
    approve: () => {
      helper = 'installed';
    },
    setFans: (next: unknown[]) => {
      fans = next;
    },
    // The helper ends the session on its own and the bridge says so.
    end: (reason: string) => {
      holding = null;
      stop = reason;
      listener({ event: 'status' });
    },
  };
}

const ready = (state: FanState) => {
  if (state.status !== 'ready') throw new Error(`expected ready, got ${state.status}`);
  return state;
};

describe('fan control', () => {
  test('reports why fan control is off', async () => {
    const none = new FanController(null, () => {});
    await none.refresh();
    expect(none.snapshot()).toEqual({ status: 'unavailable', reason: 'no-bridge' });
    for (const [setup, reason] of [
      [{ fans: [] }, 'no-fans'],
      [{ helper: 'unsigned' }, 'unsigned'],
      [{ helper: 'not-packaged' }, 'not-packaged'],
    ] as [{ helper?: string; fans?: unknown[] }, FanUnavailable][]) {
      const controller = new FanController(fakeBridge(setup).bridge, () => {});
      await controller.refresh();
      expect(controller.snapshot()).toEqual({ status: 'unavailable', reason });
    }
  });

  test('reads speeds without touching the helper', async () => {
    const fake = fakeBridge();
    const controller = new FanController(fake.bridge, () => {});
    await controller.refresh();
    expect(ready(controller.snapshot())).toMatchObject({ helper: 'installed', level: null, temperature: 48.2 });
    expect(fake.asked).toEqual(['state']);
  });

  test('a manual speed carries its time limit, and System clears it', async () => {
    const fake = fakeBridge();
    const controller = new FanController(
      fake.bridge,
      () => {},
      () => 1_000_000,
    );
    await controller.set(60, 15);
    expect(ready(controller.snapshot())).toMatchObject({ level: 60, endsAt: 1_000_000 + 15 * 60_000, busy: false });
    await controller.set(80, 0);
    expect(ready(controller.snapshot())).toMatchObject({ level: 80, endsAt: null });
    await controller.system();
    expect(ready(controller.snapshot())).toMatchObject({ level: null, endsAt: null, stop: null });
  });

  test('rejects speeds the helper would refuse', async () => {
    const controller = new FanController(fakeBridge().bridge, () => {});
    for (const [level, minutes] of [
      [33, 15],
      [-5, 15],
      [105, 15],
      [60, -1],
      [60, 1441],
      [60.5, 15],
    ])
      await expect(controller.set(level, minutes)).rejects.toThrow('Invalid fan speed');
    expect([0, 5, 100].every(isFanLevel)).toBe(true);
  });

  test('the first boost installs the helper, asks for approval, and starts once allowed', async () => {
    const fake = fakeBridge({ helper: 'not-installed' });
    const controller = new FanController(fake.bridge, () => {});
    await controller.set(60, 15);
    expect(ready(controller.snapshot())).toMatchObject({
      helper: 'needs-approval',
      notice: 'needs-approval',
      level: null,
    });
    expect(ready(controller.snapshot()).queued).toBe(true);
    expect(fake.asked).toContain('open-login-items');
    expect(fake.asked).not.toContain('set');
    fake.approve();
    await controller.refresh();
    expect(ready(controller.snapshot())).toMatchObject({ helper: 'installed', notice: null, level: 60, queued: false });
  });

  test('a waiting boost can be cancelled', async () => {
    const fake = fakeBridge({ helper: 'not-installed' });
    const controller = new FanController(fake.bridge, () => {});
    await controller.set(60, 15);
    await controller.cancel();
    fake.approve();
    await controller.refresh();
    expect(ready(controller.snapshot())).toMatchObject({ level: null, queued: false, notice: null });
  });

  test('changing speed keeps the time left, and +15 adds to it', async () => {
    let now = 0;
    const fake = fakeBridge({ now: () => now });
    const controller = new FanController(
      fake.bridge,
      () => {},
      () => now,
    );
    await controller.set(60, 15);
    now = 5 * 60_000;
    await controller.adjust(80);
    expect(ready(controller.snapshot())).toMatchObject({ level: 80, endsAt: now + 10 * 60_000, limit: 15 });
    await controller.extend();
    expect(ready(controller.snapshot())).toMatchObject({ level: 80, endsAt: now + 25 * 60_000, limit: 25 });
    await controller.set(80, 0);
    await controller.extend();
    expect(ready(controller.snapshot())).toMatchObject({ endsAt: null, limit: null });
  });

  test('a speed change or +15 queued behind Stop does not start a new boost', async () => {
    const fake = fakeBridge();
    const controller = new FanController(fake.bridge, () => {});
    await controller.set(60, 15);
    // Both clicked while Stop is still in flight.
    await Promise.all([controller.system(), controller.adjust(80), controller.extend()]);
    expect(ready(controller.snapshot())).toMatchObject({ level: null, endsAt: null });
    expect(fake.asked.filter((op) => op === 'set')).toHaveLength(1);
  });

  test('the helper ending a session is reported once, until dismissed', async () => {
    const fake = fakeBridge();
    const controller = new FanController(fake.bridge, () => {});
    await controller.set(70, 15);
    fake.end('sleep');
    await controller.refresh();
    expect(ready(controller.snapshot())).toMatchObject({ level: null, stop: 'sleep' });
    await controller.refresh();
    expect(ready(controller.snapshot()).stop).toBe('sleep');
    await controller.dismiss();
    expect(ready(controller.snapshot()).stop).toBeNull();
  });

  test('fans another app holds are left alone', async () => {
    const fake = fakeBridge({ fans: [fan(4000, true), fan(4000, true)] });
    const controller = new FanController(fake.bridge, () => {});
    await controller.refresh();
    expect(ready(controller.snapshot()).notice).toBe('already-controlled');
    await controller.set(60, 15);
    expect(ready(controller.snapshot())).toMatchObject({ level: null, notice: 'already-controlled' });
    fake.setFans([fan(2317), fan(2502)]);
    await controller.refresh();
    expect(ready(controller.snapshot()).notice).toBeNull();
  });

  test('describes the state for the CLI', async () => {
    const controller = new FanController(
      fakeBridge().bridge,
      () => {},
      () => 0,
    );
    await controller.set(60, 15);
    expect(describeFans(controller.snapshot(), 0)).toBe(
      'Fans: boosting at 60% for 15 more min · 2,317 rpm, 2,502 rpm · CPU 48 °C',
    );
    expect(describeFans({ status: 'unavailable', reason: 'no-fans' })).toBe('This Mac has no fans to control.');
  });
});
