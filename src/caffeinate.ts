// Caffeinate: keeping the Mac awake for a while, then letting it sleep as
// usual (Decaf). Two mechanisms, chosen per session:
//
// - Lid open (always): a macOS power assertion through Electron's
//   powerSaveBlocker that keeps the system and the display from idle sleep.
//   It needs no password and macOS drops it when Switchboard quits.
// - Lid closed (opt-in): only turning off macOS's SleepDisabled setting keeps
//   a closed laptop awake, and that needs root, so the system helper holds it
//   (src/native/system/). The helper turns sleep back on by itself when the
//   bridge disconnects or goes quiet, the time ends, the battery drops below
//   20%, or the Mac gets seriously hot, and this module learns why.
//
// The time limit for the lid-open part is a timer here; the helper keeps its
// own for the lid-closed part, so either one ending ends the session.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { ensureHelper, type BridgeReply, type SystemBridge } from './system-bridge';
import {
  CAFFEINATE_STOPS,
  DEFAULT_CAFFEINATE_MINUTES,
  LID_SUPPORT_TEXT,
  isCaffeinateMinutes,
  type CaffeinateNotice,
  type CaffeinateState,
  type CaffeinateStop,
  type LidSupport,
} from './shared/caffeinate';

/** The power assertion; Electron's powerSaveBlocker in the app. */
export interface SleepBlocker {
  start(): void;
  stop(): void;
}

export type Timers = {
  set(run: () => void, ms: number): () => void;
};

const realTimers: Timers = {
  set(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

const BridgeState = z.object({
  helper: z.enum(['installed', 'not-installed', 'needs-approval', 'not-packaged', 'unsigned', 'unknown']),
  lid: z.boolean().optional(),
  sleepDisabled: z.boolean().optional(),
});
const AwakeReply = z.object({
  awake: z.object({ held: z.boolean(), endsIn: z.number().nullish(), stop: z.string().nullish() }),
  error: z.string().nullish(),
});

const stopOf = (value: string | null | undefined): CaffeinateStop =>
  (CAFFEINATE_STOPS as readonly string[]).includes(value ?? '') ? (value as CaffeinateStop) : 'control-failed';

// Fixed text, never interpolated. Only for a SleepDisabled left over from
// before Caffeinate when the helper is not installed; macOS asks for the
// password and Switchboard never sees it.
const CLEAR_SCRIPT = 'do shell script "/usr/bin/pmset disablesleep 0" with administrator privileges';
const execute = promisify(execFile);

export type CaffeinateOptions = { lid?: boolean };

export class CaffeinateController {
  private state: CaffeinateState = {
    active: false,
    endsAt: null,
    limit: null,
    lid: false,
    lidSupport: 'no-bridge',
    helper: null,
    sleepDisabledElsewhere: false,
    stop: null,
    notice: null,
    queued: false,
    busy: false,
  };
  private queue: Promise<unknown> = Promise.resolve();
  private cancelTimer: (() => void) | null = null;
  private waiting: { minutes: number } | null = null;

  constructor(
    private readonly bridge: SystemBridge | null,
    private readonly blocker: SleepBlocker,
    private readonly changed: (state: CaffeinateState) => void,
    private readonly now: () => number = Date.now,
    private readonly timers: Timers = realTimers,
  ) {
    bridge?.onEvent((event) => {
      // The helper may have ended the lid-closed hold on its own.
      if ((event.event === 'status' || event.event === 'helper-lost') && this.state.lid)
        void this.run(() => this.checkHold());
    });
  }

  snapshot(): CaffeinateState {
    return this.state;
  }

  private patch(change: Partial<CaffeinateState>): void {
    const next = { ...this.state, ...change };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.changed(next);
  }

  /** One operation at a time, so a refresh never lands mid-start. */
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
    return this.run(() => this.readFacts());
  }

  private async readFacts(): Promise<void> {
    const reply = BridgeState.safeParse(await this.ask({ op: 'state' }));
    let lidSupport: LidSupport = 'no-bridge';
    let helper: CaffeinateState['helper'] = null;
    let sleepDisabled = false;
    if (reply.success) {
      const facts = reply.data;
      sleepDisabled = facts.sleepDisabled ?? false;
      if (facts.helper === 'unsigned' || facts.helper === 'not-packaged') lidSupport = facts.helper;
      else if (!facts.lid) lidSupport = 'no-lid';
      else lidSupport = 'available';
      if (facts.helper === 'installed' || facts.helper === 'not-installed' || facts.helper === 'needs-approval')
        helper = facts.helper;
    }
    const ownHold = this.state.active && this.state.lid;
    this.patch({
      lidSupport,
      helper,
      sleepDisabledElsewhere: sleepDisabled && !ownHold,
      notice: helper === 'installed' && this.state.notice === 'needs-approval' ? null : this.state.notice,
    });
    if (this.waiting && helper === 'installed') {
      const { minutes } = this.waiting;
      this.waiting = null;
      this.patch({ queued: false });
      await this.begin(minutes, { lid: true });
    }
  }

  /** Keeps the Mac awake for `minutes` (0: until stopped). */
  start(minutes: number = DEFAULT_CAFFEINATE_MINUTES, options: CaffeinateOptions = {}): Promise<void> {
    if (!isCaffeinateMinutes(minutes)) return Promise.reject(new Error('Invalid Caffeinate length'));
    return this.run(async () => {
      await this.readFacts();
      await this.begin(minutes, options);
    });
  }

  private async begin(minutes: number, { lid = false }: CaffeinateOptions): Promise<void> {
    if (lid && this.state.lidSupport !== 'available')
      throw new Error(LID_SUPPORT_TEXT[this.state.lidSupport as Exclude<LidSupport, 'available'>]);
    this.patch({ busy: true, notice: null });
    try {
      if (lid) {
        if (this.state.helper !== 'installed') {
          const outcome = this.bridge ? await ensureHelper(this.bridge) : 'failed';
          if (outcome !== 'installed') {
            if (outcome === 'needs-approval') this.waiting = { minutes };
            this.patch({
              helper: outcome === 'needs-approval' ? 'needs-approval' : this.state.helper,
              queued: outcome === 'needs-approval',
              notice: outcome === 'needs-approval' ? 'needs-approval' : 'install-failed',
            });
            return;
          }
          this.patch({ helper: 'installed' });
        }
        if (!(await this.hold(minutes))) return;
      } else if (this.state.active && this.state.lid) {
        await this.ask({ op: 'awake-release' });
      }
      this.blocker.stop();
      this.blocker.start();
      this.patch({
        active: true,
        endsAt: minutes ? this.now() + minutes * 60_000 : null,
        limit: minutes || null,
        lid,
        stop: null,
        sleepDisabledElsewhere: false,
      });
      this.schedule();
    } finally {
      this.patch({ busy: false });
    }
  }

  /** Asks the helper to hold sleep off; false (with a notice) if it would not. */
  private async hold(minutes: number): Promise<boolean> {
    const reply = AwakeReply.safeParse(await this.ask({ op: 'awake-hold', seconds: minutes * 60 }));
    if (reply.success && reply.data.awake.held && !reply.data.error) return true;
    const error = reply.success ? reply.data.error : null;
    const notice: CaffeinateNotice =
      error === 'battery-low' ? 'battery-low' : reply.success ? 'lid-failed' : 'helper-unavailable';
    this.patch({ notice });
    return false;
  }

  private schedule(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    const { endsAt } = this.state;
    if (endsAt === null) return;
    this.cancelTimer = this.timers.set(() => void this.run(() => this.end('time-limit')), endsAt - this.now());
  }

  private async end(reason: CaffeinateStop | null): Promise<void> {
    if (!this.state.active) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.blocker.stop();
    if (this.state.lid) await this.ask({ op: 'awake-release' });
    this.patch({ active: false, endsAt: null, limit: null, lid: false, stop: reason });
  }

  private async checkHold(): Promise<void> {
    if (!this.state.active || !this.state.lid) return;
    const reply = AwakeReply.safeParse(await this.ask({ op: 'status' }));
    if (reply.success && reply.data.awake.held) return;
    await this.end(reply.success ? stopOf(reply.data.awake.stop) : 'helper-stopped');
  }

  /** Decaf: lets the Mac sleep as usual again. */
  stop(): Promise<void> {
    return this.run(() => this.end(null));
  }

  /** Adds `minutes` to a timed session. */
  extend(minutes = DEFAULT_CAFFEINATE_MINUTES): Promise<void> {
    return this.run(async () => {
      const { active, endsAt, lid, limit } = this.state;
      if (!active || endsAt === null) return;
      const next = Math.min(endsAt + minutes * 60_000, this.now() + 1440 * 60_000);
      const left = Math.ceil((next - this.now()) / 60_000);
      if (lid && !(await this.hold(left))) return;
      this.patch({ endsAt: next, limit: Math.max(limit ?? 0, left) });
      this.schedule();
    });
  }

  dismiss(): Promise<void> {
    return this.run(async () => this.patch({ stop: null, notice: null }));
  }

  /** Drops a lid-closed session that was waiting for the helper. */
  cancel(): Promise<void> {
    return this.run(async () => {
      this.waiting = null;
      this.patch({ queued: false, notice: null });
    });
  }

  /** Turns back on a system sleep that something other than Caffeinate turned off. */
  clear(): Promise<void> {
    return this.run(async () => {
      this.patch({ busy: true, notice: null });
      try {
        if (this.state.helper === 'installed') {
          const reply = await this.ask({ op: 'sleep-clear' });
          if (!reply || reply.error) this.patch({ notice: 'clear-failed' });
        } else {
          await execute('/usr/bin/osascript', ['-e', CLEAR_SCRIPT], { timeout: 120_000 }).catch(() =>
            this.patch({ notice: 'clear-failed' }),
          );
        }
        await this.readFacts();
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
