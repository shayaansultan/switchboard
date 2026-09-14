export type PauseReason = 'sleep' | 'lock';

export class PollingPause {
  private readonly reasons = new Set<PauseReason>();

  get paused(): boolean {
    return this.reasons.size > 0;
  }

  pause(reason: PauseReason): void {
    this.reasons.add(reason);
  }

  /** Refresh once when the final reason clears, not on every resume event. */
  resume(reason: PauseReason): boolean {
    const wasPaused = this.paused;
    this.reasons.delete(reason);
    return wasPaused && !this.paused;
  }
}
