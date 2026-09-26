// Usage history as the app and the CLI use it: where its files live, one
// indexing pass at a time, and reports built from what has been recorded.
// The app records and indexes; the CLI reads what the app last wrote.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ROOT } from '../store';
import type { UsageReport } from '../types';
import { DAY_MS, emptyLedger, indexLogs, loadLedger, saveLedger, type Ledger, type LedgerProfile } from './ledger';
import { buildReport, sessionPaths } from './report';
import { WindowHistory, type LiveProfile } from './windows';

export const USAGE_DIR = path.join(ROOT, 'usage');
// A pass that found nothing new still records when it looked, but writes
// the ledger no more often than this.
const IDLE_SAVE_MS = 10 * 60_000;

export class UsageHistory {
  readonly windows: WindowHistory;
  private ledger: Ledger | null = null;
  private pass: Promise<boolean> | null = null;
  private lastPass = 0;
  private lastSave = 0;

  constructor(private readonly dir = USAGE_DIR) {
    this.windows = new WindowHistory(dir);
  }

  private get file(): string {
    return path.join(this.dir, 'ledger.json');
  }

  current(): Ledger {
    this.ledger ??= loadLedger(this.file) ?? emptyLedger();
    return this.ledger;
  }

  // Read what the profiles' logs gained. A pass already under way is joined,
  // and one finished less than `minGapMs` ago is not repeated.
  index(profiles: LedgerProfile[], minGapMs = 0): Promise<boolean> {
    if (this.pass) return this.pass;
    if (Date.now() - this.lastPass < minGapMs) return Promise.resolve(false);
    const ledger = this.current();
    this.pass = indexLogs(ledger, profiles)
      .then((changed) => {
        if (changed || Date.now() - this.lastSave >= IDLE_SAVE_MS) {
          saveLedger(this.file, ledger);
          this.lastSave = Date.now();
        }
        return changed;
      })
      .finally(() => {
        this.pass = null;
        this.lastPass = Date.now();
      });
    return this.pass;
  }

  report(live: LiveProfile[], days: number, now = Date.now()): UsageReport {
    // Enough window history for the previous period's limit hits and for the
    // live windows' own history.
    const since = Math.min(now - 2 * days * DAY_MS, now - 8 * DAY_MS);
    return buildReport({
      ledger: this.current(),
      records: this.windows.read(since, now),
      windowsSince: this.windows.firstRecordAt(),
      live,
      days,
      now,
    });
  }

  session(profile: string, id: string) {
    return sessionPaths(this.current(), profile, id);
  }

  // The CLI's view: the ledger as the app last saved it.
  static readOnly(dir = USAGE_DIR): UsageHistory | null {
    return fs.existsSync(path.join(dir, 'ledger.json')) ? new UsageHistory(dir) : null;
  }
}

export type { LedgerProfile } from './ledger';
export type { LiveProfile } from './windows';
