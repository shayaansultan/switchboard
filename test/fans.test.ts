import { describe, expect, test } from 'bun:test';
import { FanController, type BridgeReply, type FanBridge } from '../src/fans';
import { describeFans, isFanLevel, type FanState } from '../src/shared/fans';

const fan = (actual: number, manual = false) => ({ actual, minimum: 2317, maximum: 7826, target: actual, manual });

// A bridge that answers like the real one and records what it was asked.
function fakeBridge(start: { helper?: string; fans?: unknown[] } = {}) {
  let helper = start.helper ?? 'installed';
  let fans = start.fans ?? [fan(2317), fan(2502)];
  let listener: (event: BridgeReply) => void = () => {};
  const asked: string[] = [];
  let holding: { level: number; seconds: number } | null = null;
  let stop: string | null = null;
  const status = (extra: BridgeReply = {}) => ({
    fans,
    temperature: 48.2,
    controlling: holding !== null,
    level: holding?.level ?? null,
    endsIn: holding?.seconds || null,
    stop,
    ...extra,
  });
  const bridge: FanBridge = {
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
          holding = { level: Number(request.level), seconds: Number(request.seconds) };
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
    ] as const) {
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

  test('the first manual speed installs the helper and asks for approval', async () => {
    const fake = fakeBridge({ helper: 'not-installed' });
    const controller = new FanController(fake.bridge, () => {});
    await controller.set(60, 15);
    expect(ready(controller.snapshot())).toMatchObject({
      helper: 'needs-approval',
      notice: 'needs-approval',
      level: null,
    });
    expect(fake.asked).toContain('open-login-items');
    expect(fake.asked).not.toContain('set');
    fake.approve();
    await controller.set(60, 15);
    expect(ready(controller.snapshot())).toMatchObject({ helper: 'installed', notice: null, level: 60 });
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
    expect(describeFans(controller.snapshot(), 0)).toBe('Fans: 60% for 15 more min · 2,317 rpm, 2,502 rpm · CPU 48 °C');
    expect(describeFans({ status: 'unavailable', reason: 'no-fans' })).toBe('This Mac has no fans to control.');
  });
});
