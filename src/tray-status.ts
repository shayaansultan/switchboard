import type { AwakeState } from './awake';

export interface TrayText {
  title: string;
  tooltip: string;
}

// Usage and sleep state share one macOS status item. Compose once so a refresh
// from either feature cannot erase the other feature's title or tooltip.
export function composeTrayText(usage: TrayText, awake: AwakeState): TrayText {
  let badge = '';
  let description = '';

  switch (awake.status) {
    case 'checking':
      break;
    case 'ready':
      if (awake.value === 'on') {
        badge = ' ☀';
        description = ' · Keep awake is on';
      }
      break;
    case 'changing':
      badge = ' …';
      description = ' · Changing sleep setting';
      break;
    case 'unavailable':
      badge = ' !';
      description = ' · Sleep setting unavailable';
      break;
  }

  return { title: usage.title + badge, tooltip: usage.tooltip + description };
}
