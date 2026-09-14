import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type AwakeValue = 'on' | 'off';
export type AwakeNotice = 'cancelled' | 'write-failed' | 'timed-out' | 'not-applied';
export type AwakeRefresh = 'observe' | 'recheck';

export type AwakeState =
  | { status: 'checking' }
  | { status: 'ready'; value: AwakeValue; notice: AwakeNotice | null }
  | { status: 'changing'; target: AwakeValue; lastKnown: AwakeValue | null }
  | { status: 'unavailable'; lastKnown: AwakeValue | null };

export type ReadResult = { ok: true; value: AwakeValue } | { ok: false };
export type WriteResult = { ok: true } | { ok: false; notice: Exclude<AwakeNotice, 'not-applied'> };

export interface AwakeSystem {
  read(): Promise<ReadResult>;
  write(value: AwakeValue): Promise<WriteResult>;
}

export function isAwakeValue(value: unknown): value is AwakeValue {
  return value === 'on' || value === 'off';
}

/** SleepDisabled is system-wide, not the per-power-source idle sleep timer. */
export function parseSleepDisabled(output: string): ReadResult {
  const sections = /^System-wide power settings:\s*\n([\s\S]*?)^Currently in use:\s*$/m.exec(output);
  if (!sections || !/^\s*sleep\s+\d+(?:\s|$)/m.test(output)) return { ok: false };

  const entries = sections[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^SleepDisabled\b/.test(line));
  // macOS omits SleepDisabled until it has first been set. Only interpret an
  // absent key as off after validating that this is complete `pmset -g` output.
  if (entries.length === 0) return { ok: true, value: 'off' };
  if (entries.length !== 1) return { ok: false };
  if (/^SleepDisabled\s+1$/.test(entries[0])) return { ok: true, value: 'on' };
  if (/^SleepDisabled\s+0$/.test(entries[0])) return { ok: true, value: 'off' };
  return { ok: false };
}

// Neither renderer input nor user-provided paths are interpolated into a shell.
// Authorization stays in macOS; Switchboard never receives the password.
const CHANGE_SCRIPT: Record<AwakeValue, string> = {
  on: 'do shell script "/usr/bin/pmset disablesleep 1" with administrator privileges',
  off: 'do shell script "/usr/bin/pmset disablesleep 0" with administrator privileges',
};

const execute = promisify(execFile);

export function classifyWriteError(error: unknown): WriteResult {
  if (typeof error === 'object' && error !== null) {
    if ('stderr' in error && typeof error.stderr === 'string' && /\(-128\)/.test(error.stderr)) {
      return { ok: false, notice: 'cancelled' };
    }
    if ('killed' in error && error.killed === true) return { ok: false, notice: 'timed-out' };
  }
  return { ok: false, notice: 'write-failed' };
}

export const macAwakeSystem: AwakeSystem = {
  async read() {
    try {
      const { stdout } = await execute('/usr/bin/pmset', ['-g'], { timeout: 5_000, maxBuffer: 64 * 1024 });
      return parseSleepDisabled(stdout);
    } catch {
      return { ok: false };
    }
  },

  async write(value) {
    try {
      await execute('/usr/bin/osascript', ['-e', CHANGE_SCRIPT[value]], { timeout: 120_000, maxBuffer: 64 * 1024 });
      return { ok: true };
    } catch (error) {
      return classifyWriteError(error);
    }
  },
};

/** The system is the source of truth. No saved toggle or quit-time rollback. */
export class AwakeController {
  private state: AwakeState = { status: 'checking' };
  private operation: Promise<void> | null = null;

  constructor(
    private readonly system: AwakeSystem,
    private readonly changed: (state: AwakeState) => void,
  ) {}

  snapshot(): AwakeState {
    return this.state;
  }

  private lastKnown(): AwakeValue | null {
    switch (this.state.status) {
      case 'checking':
        return null;
      case 'ready':
        return this.state.value;
      case 'changing':
      case 'unavailable':
        return this.state.lastKnown;
    }
  }

  private publish(state: AwakeState): void {
    if (
      state.status === 'ready' &&
      this.state.status === 'ready' &&
      state.value === this.state.value &&
      state.notice === this.state.notice
    )
      return;
    if (
      state.status === 'unavailable' &&
      this.state.status === 'unavailable' &&
      state.lastKnown === this.state.lastKnown
    )
      return;
    this.state = state;
    this.changed(state);
  }

  refresh(reason: AwakeRefresh = 'observe'): Promise<void> {
    // Polling cannot race a write/readback or overwrite its pending UI.
    // Explicit rechecks keep their notice-clearing intent even when a passive
    // observation is already in flight.
    if (this.operation && reason === 'recheck') return this.operation.then(() => this.refresh(reason));
    if (this.operation) return this.operation;
    this.operation = this.readState(reason).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private async readState(reason: AwakeRefresh): Promise<void> {
    const result = await this.system.read();
    const notice = reason === 'observe' && this.state.status === 'ready' ? this.state.notice : null;
    this.publish(
      result.ok
        ? { status: 'ready', value: result.value, notice }
        : { status: 'unavailable', lastKnown: this.lastKnown() },
    );
  }

  async set(value: AwakeValue): Promise<void> {
    // Double-clicks and concurrent tray/window actions share one authorization.
    if (this.state.status === 'changing') return this.operation ?? Promise.resolve();
    if (this.operation) await this.operation;
    if (this.operation) return this.operation;
    this.operation = this.change(value).finally(() => {
      this.operation = null;
    });
    return this.operation;
  }

  private async change(target: AwakeValue): Promise<void> {
    this.publish({ status: 'changing', target, lastKnown: this.lastKnown() });
    const before = await this.system.read();
    if (before.ok && before.value === target) {
      this.publish({ status: 'ready', value: target, notice: null });
      return;
    }

    const result = await this.system.write(target);
    // Even cancellation or a nonzero exit may accompany an external change.
    // Never infer system state from the command's exit code or the old value.
    const after = await this.system.read();
    if (!after.ok) {
      this.publish({ status: 'unavailable', lastKnown: before.ok ? before.value : this.lastKnown() });
      return;
    }

    const notice = !result.ok ? result.notice : after.value !== target ? 'not-applied' : null;
    this.publish({ status: 'ready', value: after.value, notice });
  }
}
