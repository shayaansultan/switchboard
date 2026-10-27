import type { CaffeinateState } from './shared/caffeinate';

export interface TrayText {
  title: string;
  tooltip: string;
}

// Usage and Caffeinate share one macOS status item. Compose once so a refresh
// from either feature cannot erase the other feature's title or tooltip.
export function composeTrayText(usage: TrayText, caffeinate: CaffeinateState): TrayText {
  if (!caffeinate.active) return usage;
  const lid = caffeinate.lid ? ', lid closed too' : '';
  return { title: `${usage.title} ☕`, tooltip: `${usage.tooltip} · Caffeinated${lid}` };
}
