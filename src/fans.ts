// Fan control: holding the Mac's fans at a chosen speed for a short boost,
// then handing them back to macOS. The work happens in two native pieces
// (src/native/fans/): a root fan helper that writes the SMC, and a fan bridge
// this process runs as a child and talks to in JSON lines. This module owns
// the bridge child and the state the window, tray and CLI read.
//
// The helper, not this process, decides when control ends: it hands the fans
// back when the bridge disconnects or stops sending heartbeats, when the time
// limit runs out, on sleep, on serious thermal pressure, when macOS takes the
// fans back, and at restart. This module only learns why, and reports it.
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import { z } from 'zod';
import {
  DEFAULT_FAN_MINUTES,
  FAN_STOPS,
  isFanLevel,
  isFanMinutes,
  type FanNotice,
  type FanState,
  type FanStop,
  type FanView,
} from './shared/fans';

const Fan = z.object({
  actual: z.number(),
  minimum: z.number(),
  maximum: z.number(),
  target: z.number(),
  manual: z.boolean(),
});
const Readings = z.object({ fans: z.array(Fan), temperature: z.number().optional() });
const BridgeState = Readings.extend({
  helper: z.enum(['installed', 'not-installed', 'needs-approval', 'not-packaged', 'unsigned', 'unknown']),
});
const HelperStatus = Readings.extend({
  controlling: z.boolean(),
  level: z.number().nullish(),
  endsIn: z.number().nullish(),
  stop: z.string().nullish(),
  error: z.string().nullish(),
  detail: z.string().nullish(),
});
const Failure = z.object({ error: z.string() });

export type BridgeReply = Record<string, unknown>;

/** The fan bridge as this module sees it; tests pass a fake. */
export interface FanBridge {
  request(request: Record<string, unknown>): Promise<BridgeReply>;
  onEvent(listener: (event: BridgeReply) => void): void;
  close(): void;
}

const round = (fan: z.infer<typeof Fan>): FanView => ({
  actual: Math.round(fan.actual),
  minimum: Math.round(fan.minimum),
  maximum: Math.round(fan.maximum),
  target: Math.round(fan.target),
  manual: fan.manual,
});

const stopOf = (value: string | null | undefined): FanStop | null =>
  (FAN_STOPS as readonly string[]).includes(value ?? '') ? (value as FanStop) : null;

function noticeOf(error: string): FanNotice {
  switch (error) {
    case 'already-controlled':
    case 'install-failed':
    case 'remove-failed':
      return error;
    case 'helper-unavailable':
    case 'helper-timeout':
    case 'unsigned':
      return 'helper-unavailable';
    default:
      return 'control-failed';
  }
}

type Ready = Extract<FanState, { status: 'ready' }>;

export class FanController {
  private state: FanState = { status: 'checking' };
  private queue: Promise<unknown> = Promise.resolve();
  /** A boost asked for before the helper was allowed; it starts once it is. */
  private queued: { level: number; minutes: number } | null = null;

  constructor(
    private readonly bridge: FanBridge | null,
    private readonly changed: (state: FanState) => void,
    private readonly now: () => number = Date.now,
  ) {
    bridge?.onEvent((event) => {
      // The helper ended a session on its own, or the connection to it
      // dropped; ask it what happened.
      if (event.event === 'status' || event.event === 'helper-lost') void this.run(() => this.readStatus());
    });
  }

  snapshot(): FanState {
    return this.state;
  }

  private publish(state: FanState): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.changed(state);
  }

  private ready(): Ready | null {
    return this.state.status === 'ready' ? this.state : null;
  }

  private patch(change: Partial<Ready>): void {
    const ready = this.ready();
    if (ready) this.publish({ ...ready, ...change });
  }

  /** Operations run one at a time, so a poll never lands between a write and its readback. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }

  private async ask(request: Record<string, unknown>): Promise<BridgeReply | null> {
    if (!this.bridge) return null;
    try {
      return await this.bridge.request(request);
    } catch {
      return null;
    }
  }

  refresh(): Promise<void> {
    return this.run(() => this.readState());
  }

  private async readState(): Promise<void> {
    if (!this.bridge) return this.publish({ status: 'unavailable', reason: 'no-bridge' });
    const reply = BridgeState.safeParse(await this.ask({ op: 'state' }));
    if (!reply.success) return this.publish({ status: 'unavailable', reason: 'no-bridge' });
    const { helper, fans, temperature } = reply.data;
    if (fans.length === 0) return this.publish({ status: 'unavailable', reason: 'no-fans' });
    if (helper === 'unsigned' || helper === 'not-packaged')
      return this.publish({ status: 'unavailable', reason: helper });
    const previous = this.ready();
    const next: Ready = {
      status: 'ready',
      helper: helper === 'unknown' ? (previous?.helper ?? 'not-installed') : helper,
      fans: fans.map(round),
      temperature: temperature ?? null,
      level: previous?.level ?? null,
      endsAt: previous?.endsAt ?? null,
      limit: previous?.limit ?? null,
      queued: this.queued !== null,
      stop: previous?.stop ?? null,
      notice: previous?.notice ?? null,
      busy: previous?.busy ?? false,
    };
    // Fans in manual mode that we are not holding: another app has them.
    const foreign = next.level === null && next.fans.some((fan) => fan.manual);
    if (foreign) next.notice = 'already-controlled';
    else if (next.notice === 'already-controlled') next.notice = null;
    if (next.helper === 'installed' && next.notice === 'needs-approval') next.notice = null;
    this.publish(next);
    if (next.level !== null) await this.readStatus();
    else if (this.queued && next.helper === 'installed') {
      const { level, minutes } = this.queued;
      this.queued = null;
      this.patch({ queued: false });
      await this.boost(level, minutes);
    }
  }

  private applyStatus(raw: BridgeReply | null): boolean {
    const status = HelperStatus.safeParse(raw);
    if (!status.success) {
      const failure = Failure.safeParse(raw);
      this.patch({ notice: noticeOf(failure.success ? failure.data.error : 'helper-unavailable') });
      return false;
    }
    const { controlling, level, endsIn, stop, error, fans, temperature } = status.data;
    const ready = this.ready();
    if (!ready) return false;
    this.publish({
      ...ready,
      helper: 'installed',
      fans: fans.length ? fans.map(round) : ready.fans,
      temperature: temperature ?? ready.temperature,
      level: controlling ? (level ?? null) : null,
      endsAt: controlling && typeof endsIn === 'number' ? this.now() + endsIn * 1000 : null,
      limit: controlling ? ready.limit : null,
      stop: controlling ? null : (stopOf(stop) ?? ready.stop),
      notice: error ? noticeOf(error) : null,
    });
    return !error;
  }

  private async readStatus(): Promise<void> {
    if (this.ready()?.helper !== 'installed') return;
    this.applyStatus(await this.ask({ op: 'status' }));
  }

  /** Boosts every fan to `level` (0–100, steps of 5) for `minutes` (0: until stopped). */
  set(level: number, minutes: number = DEFAULT_FAN_MINUTES): Promise<void> {
    if (!isFanLevel(level) || !isFanMinutes(minutes)) return Promise.reject(new Error('Invalid fan speed'));
    return this.run(async () => {
      await this.readState();
      await this.boost(level, minutes);
    });
  }

  private async boost(level: number, minutes: number): Promise<void> {
    const ready = this.ready();
    if (!ready) return;
    this.patch({ busy: true, notice: null });
    try {
      if (ready.helper !== 'installed' && !(await this.installHelper())) {
        // Remembered, so allowing the helper in Login Items starts it.
        this.queued = { level, minutes };
        this.patch({ queued: true });
        return;
      }
      const ok = this.applyStatus(await this.ask({ op: 'set', level, seconds: minutes * 60 }));
      if (ok) this.patch({ limit: minutes || null });
    } finally {
      this.patch({ busy: false });
    }
  }

  /** Minutes left in the current boost; 0 for one that runs until stopped. */
  private remaining(ready: Ready): number {
    return ready.endsAt === null ? 0 : Math.max(1, Math.ceil((ready.endsAt - this.now()) / 60_000));
  }

  /** Changes the speed of the current boost without touching its time. */
  adjust(level: number): Promise<void> {
    const ready = this.ready();
    if (!ready || ready.level === null) return Promise.resolve();
    const left = this.remaining(ready);
    return this.set(level, left).then(() => {
      if (ready.limit !== null) this.patch({ limit: Math.max(ready.limit, left) });
    });
  }

  /** Adds `minutes` to a timed boost. */
  extend(minutes = DEFAULT_FAN_MINUTES): Promise<void> {
    const ready = this.ready();
    if (!ready || ready.level === null || ready.endsAt === null) return Promise.resolve();
    const total = Math.min(1440, this.remaining(ready) + minutes);
    return this.set(ready.level, total);
  }

  /** Drops a boost that was waiting for the helper to be allowed. */
  cancel(): Promise<void> {
    return this.run(async () => {
      this.queued = null;
      this.patch({ queued: false, notice: null });
    });
  }

  /** Hands the fans back to macOS. */
  system(): Promise<void> {
    return this.run(async () => {
      const ready = this.ready();
      if (!ready || ready.helper !== 'installed') return;
      this.patch({ busy: true });
      try {
        if (this.applyStatus(await this.ask({ op: 'system' }))) this.patch({ stop: null });
      } finally {
        this.patch({ busy: false });
      }
    });
  }

  /** Clears the reason the last session ended, once it has been read. */
  dismiss(): Promise<void> {
    return this.run(async () => this.patch({ stop: null, notice: null }));
  }

  install(): Promise<void> {
    return this.run(async () => {
      await this.readState();
      if (!this.ready()) return;
      this.patch({ busy: true, notice: null });
      try {
        await this.installHelper();
      } finally {
        this.patch({ busy: false });
      }
    });
  }

  /** True once the helper is installed and enabled. */
  private async installHelper(): Promise<boolean> {
    const reply = await this.ask({ op: 'install' });
    await this.readState();
    const helper = this.ready()?.helper;
    if (helper === 'installed') return true;
    if (helper === 'needs-approval') {
      // macOS only enables a new helper after the user allows it in Login
      // Items; take them there and say so.
      await this.ask({ op: 'open-login-items' });
      this.patch({ notice: 'needs-approval' });
    } else {
      const failure = Failure.safeParse(reply);
      this.patch({ notice: failure.success ? noticeOf(failure.data.error) : 'install-failed' });
    }
    return false;
  }

  remove(): Promise<void> {
    return this.run(async () => {
      const ready = this.ready();
      if (!ready) return;
      this.patch({ busy: true, notice: null });
      try {
        if (ready.level !== null) this.applyStatus(await this.ask({ op: 'system' }));
        const reply = await this.ask({ op: 'remove' });
        if (Failure.safeParse(reply).success) this.patch({ notice: 'remove-failed' });
        await this.readState();
      } finally {
        this.patch({ busy: false });
      }
    });
  }

  openLoginItems(): Promise<void> {
    return this.run(async () => {
      await this.ask({ op: 'open-login-items' });
    });
  }
}

/**
 * Runs the fan bridge as a child process. It is started on first use and
 * again after it exits; closing stdin ends it, and the helper then hands the
 * fans back.
 */
export function spawnFanBridge(executable: string, timeout = 25_000): FanBridge | null {
  if (process.platform !== 'darwin' || !fs.existsSync(executable)) return null;
  let child: ChildProcess | null = null;
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (reply: BridgeReply) => void; reject: (error: Error) => void }>();
  const listeners: ((event: BridgeReply) => void)[] = [];

  const fail = (error: Error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  const start = (): ChildProcess => {
    if (child && child.exitCode === null && !child.killed) return child;
    buffer = '';
    const next = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    next.stdout?.setEncoding('utf8');
    next.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: BridgeReply;
        try {
          message = JSON.parse(line) as BridgeReply;
        } catch {
          continue;
        }
        const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined;
        if (waiting) {
          pending.delete(message.id as number);
          waiting.resolve(message);
        } else if (typeof message.event === 'string') {
          for (const listener of listeners) listener(message);
        }
      }
    });
    next.on('exit', () => {
      if (child === next) child = null;
      fail(new Error('The fan bridge exited'));
    });
    next.on('error', (error) => fail(error));
    next.stdin?.on('error', () => {});
    child = next;
    return next;
  };

  return {
    request(request) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('The fan bridge did not reply'));
        }, timeout);
        pending.set(id, {
          resolve: (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        start().stdin?.write(JSON.stringify({ ...request, id }) + '\n');
      });
    },
    onEvent(listener) {
      listeners.push(listener);
    },
    close() {
      child?.stdin?.end();
      child = null;
    },
  };
}
