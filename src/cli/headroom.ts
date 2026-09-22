// Which profile to run the next job on: the one with the most quota left.
// Pure over a usage report, so it is the same answer whether the numbers
// came from the cache or a live fetch.

import type { ProfileRef } from './output';
import type { UsageEntry, UsageStatus } from './usage';

export interface Candidate extends ProfileRef {
  headroom: number;
  window: string;
  resetsAt: string | null;
  stale: boolean;
}

export type ExclusionReason = UsageStatus | 'no-window' | 'below-min';

export interface Ranking {
  profile: Candidate | null;
  candidates: Candidate[];
  excluded: (ProfileRef & { reason: ExclusionReason })[];
}

export interface RankOptions {
  // Judge by this window's label alone instead of the tightest window.
  window?: string;
  minHeadroom?: number;
}

const strip = ({ id, vendor, name, isDefault }: UsageEntry): ProfileRef => ({ id, vendor, name, isDefault });

// Sort by headroom, then by the binding window resetting soonest, then by
// the order the entries came in (store order).
function better(a: Candidate, b: Candidate): number {
  if (a.headroom !== b.headroom) return b.headroom - a.headroom;
  const ra = a.resetsAt ? Date.parse(a.resetsAt) : Infinity;
  const rb = b.resetsAt ? Date.parse(b.resetsAt) : Infinity;
  return ra - rb;
}

export function rank(entries: UsageEntry[], options: RankOptions = {}): Ranking {
  const candidates: Candidate[] = [];
  const excluded: Ranking['excluded'] = [];
  for (const entry of entries) {
    const { status } = entry.usage;
    if (status !== 'ok' && status !== 'stale') {
      excluded.push({ ...strip(entry), reason: status });
      continue;
    }
    const wanted = options.window?.toLowerCase();
    const windows = entry.usage.windows.filter(
      (w) => w.remaining !== null && (!wanted || w.label.toLowerCase() === wanted),
    );
    if (!windows.length) {
      excluded.push({ ...strip(entry), reason: 'no-window' });
      continue;
    }
    const binding = windows.reduce((tightest, w) => (w.remaining! < tightest.remaining! ? w : tightest));
    if (options.minHeadroom !== undefined && binding.remaining! < options.minHeadroom) {
      excluded.push({ ...strip(entry), reason: 'below-min' });
      continue;
    }
    candidates.push({
      ...strip(entry),
      headroom: binding.remaining!,
      window: binding.label,
      resetsAt: binding.resetsAt,
      stale: status === 'stale',
    });
  }
  candidates.sort(better);
  return { profile: candidates[0] ?? null, candidates, excluded };
}
