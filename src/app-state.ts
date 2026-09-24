// What each profile's desktop app is doing, as the window and the tray show it.
//
// Two things decide it. The process list says what is true right now; a click
// on Launch or Quit says what should become true soon. The click is only a
// promise with a deadline: the next observation that confirms it clears it,
// and a deadline that passes turns it into an honest answer (off after a
// launch that never appeared, stalled after a quit the app ignored). Anything
// that happens outside Switchboard, a Cmd+Q, a crash, the CLI, simply shows
// up in the next observation.
//
// When closed windows are being noticed, the observation also says which
// running apps have no window open. Those read as background, and a launch
// counts as done only once its window is up, not merely its process.
//
// Pure and clock-injected so the transitions can be tested without processes.

import type { AppState } from './types';

export const START_DEADLINE_MS = 15_000;
export const QUIT_DEADLINE_MS = 10_000;

type Pending = { kind: 'starting' | 'quitting'; deadline: number } | { kind: 'stalled' };

// What changed for a profile that the person who asked should hear about.
export interface Settled {
  id: string;
  state: AppState;
  // Set when a launch passed its deadline without a process appearing.
  failedToStart?: boolean;
}

export class AppStates {
  private readonly pending = new Map<string, Pending>();
  private readonly current = new Map<string, AppState>();
  private readonly waiters = new Map<string, ((s: Settled) => void)[]>();

  constructor(private readonly now: () => number = Date.now) {}

  get(id: string): AppState {
    return this.current.get(id) ?? 'off';
  }

  // Whether any launch or quit is still waiting on the process list, which is
  // when the caller should look again soon rather than on its slow cadence.
  get busy(): boolean {
    for (const p of this.pending.values()) if (p.kind !== 'stalled') return true;
    return false;
  }

  // A launch or quit was just sent. Shows immediately; the next observations
  // confirm it or let it time out.
  expect(id: string, kind: 'starting' | 'quitting'): void {
    const ms = kind === 'starting' ? START_DEADLINE_MS : QUIT_DEADLINE_MS;
    this.pending.set(id, { kind, deadline: this.now() + ms });
    this.current.set(id, kind);
  }

  // Resolves once the profile leaves starting or quitting: running or off
  // after a launch, off or stalled after a quit.
  settled(id: string): Promise<Settled> {
    const p = this.pending.get(id);
    if (!p || p.kind === 'stalled') return Promise.resolve({ id, state: this.get(id) });
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(resolve);
      this.waiters.set(id, list);
    });
  }

  // Fold in which profiles have a process, and which of those are known to
  // have no window. Returns whether any state changed, so the caller only
  // redraws when there is something new to show.
  observe(alive: Map<string, boolean>, windowless: ReadonlySet<string> = new Set()): boolean {
    let changed = false;
    const now = this.now();
    for (const [id, isAlive] of alive) {
      const p = this.pending.get(id);
      let next: AppState;
      let failedToStart = false;
      const shown: AppState = windowless.has(id) ? 'background' : 'running';
      if (!p) next = isAlive ? shown : 'off';
      else if (p.kind === 'starting') {
        if (isAlive) next = shown === 'running' || now >= p.deadline ? shown : 'starting';
        else if (now < p.deadline) next = 'starting';
        else {
          next = 'off';
          failedToStart = true;
        }
      } else if (p.kind === 'quitting') {
        if (!isAlive) next = 'off';
        else if (now < p.deadline) next = 'quitting';
        else next = 'stalled';
      } else next = isAlive ? 'stalled' : 'off';

      if (next === 'stalled') this.pending.set(id, { kind: 'stalled' });
      else if (next !== 'starting' && next !== 'quitting') this.pending.delete(id);
      if (this.current.get(id) !== next) changed = true;
      this.current.set(id, next);

      if (next !== 'starting' && next !== 'quitting') {
        const list = this.waiters.get(id);
        if (list) {
          this.waiters.delete(id);
          for (const resolve of list) resolve({ id, state: next, ...(failedToStart ? { failedToStart } : {}) });
        }
      }
    }
    // A profile that no longer exists takes its promise with it.
    for (const id of this.current.keys()) {
      if (alive.has(id)) continue;
      this.current.delete(id);
      this.pending.delete(id);
      const list = this.waiters.get(id);
      this.waiters.delete(id);
      for (const resolve of list ?? []) resolve({ id, state: 'off' });
      changed = true;
    }
    return changed;
  }
}
