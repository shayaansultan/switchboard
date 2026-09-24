// When to look at the process list for desktop apps, separate from the usage
// poll: a launch or quit is cheap to detect (one `ps`) and people notice when
// the window is late, while usage lookups are slow and rate limited.
//
// The fast path is the app-events helper (src/native/app-events.swift), which
// reports every app launch and quit as it happens. With it, a check runs the
// moment a Claude or ChatGPT process starts or stops, and the timer is only a
// safety net. Without it (a checkout built off macOS, or a helper that keeps
// dying), the timer does the work: every 2 s while the window is on screen,
// every 30 s when it is closed, minimised or covered, with a check the
// moment it is shown again. Either way a launch or quit
// Switchboard is waiting on is checked every 250 ms until it settles.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export const BUSY_MS = 250;
export const VISIBLE_MS = 2_000;
export const BACKGROUND_MS = 30_000;

export function nextCheckDelay(o: { busy: boolean; events: boolean; visible: boolean }): number {
  if (o.busy) return BUSY_MS;
  if (o.events) return BACKGROUND_MS;
  return o.visible ? VISIBLE_MS : BACKGROUND_MS;
}

export interface WatchOptions {
  // Reads the process list and folds it in.
  check: () => Promise<void>;
  // Whether a launch or quit is waiting to settle.
  busy: () => boolean;
  // Whether an executable path is one of the desktop apps we track.
  tracks: (exe: string) => boolean;
  // The compiled helper, or null to rely on the timer alone.
  helper: string | null;
  spawn?: (cmd: string) => ChildProcess;
}

// A helper that dies this many times without staying up a minute is left
// dead, and the timer carries on alone.
const MAX_QUICK_RESTARTS = 3;

export class DesktopWatch {
  private visible = false;
  private paused = false;
  private stopped = false;
  private events = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private child: ChildProcess | null = null;
  private quickRestarts = 0;

  constructor(private readonly o: WatchOptions) {}

  start(): void {
    this.stopped = false;
    this.startHelper();
    this.poke();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child?.kill();
    this.child = null;
  }

  // Look now, e.g. after a click or when the window gains focus. A poke during
  // a check queues exactly one more, so a burst of events costs two checks.
  poke(): void {
    if (this.stopped || this.paused) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.o
      .check()
      .catch(() => {})
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.poke();
        } else this.schedule();
      });
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) this.poke();
    else this.schedule();
  }

  // Asleep or locked: nobody is looking, and the process list will be read
  // again on wake.
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    } else this.poke();
  }

  get usingEvents(): boolean {
    return this.events;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || this.paused || this.running) return;
    const delay = nextCheckDelay({ busy: this.o.busy(), events: this.events, visible: this.visible });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.poke();
    }, delay);
    this.timer.unref?.();
  }

  private startHelper(): void {
    if (!this.o.helper || this.stopped) return;
    let child: ChildProcess;
    try {
      child = (this.o.spawn ?? defaultSpawn)(this.o.helper);
    } catch {
      return;
    }
    this.child = child;
    const startedAt = Date.now();
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        this.onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      this.events = false;
      this.schedule();
      if (this.stopped) return;
      this.quickRestarts = Date.now() - startedAt < 60_000 ? this.quickRestarts + 1 : 0;
      if (this.quickRestarts > MAX_QUICK_RESTARTS) return;
      setTimeout(() => this.startHelper(), 2_000).unref?.();
    };
    child.on('exit', gone);
    child.on('error', gone);
  }

  private onLine(line: string): void {
    let msg: { event?: string; exe?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === 'ready') {
      this.events = true;
      this.schedule();
    } else if ((msg.event === 'launch' || msg.event === 'terminate') && msg.exe && this.o.tracks(msg.exe)) {
      this.poke();
    }
  }
}

// stdin stays a pipe we never write to: the helper exits when it closes,
// which happens however Switchboard ends.
function defaultSpawn(cmd: string): ChildProcess {
  return nodeSpawn(cmd, [], { stdio: ['pipe', 'pipe', 'ignore'] });
}
