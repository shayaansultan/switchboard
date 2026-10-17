// What this phone remembers about how to show things: per-device
// conveniences kept in localStorage, never data. Private mode or cleared
// storage just falls back to the defaults.

import { useEffect, useState } from 'react';

export interface Prefs {
  inbox: 'desktop' | 'all';
  steps: 'folded' | 'open';
  text: 'smaller' | 'default' | 'larger';
  hidden: string[];
  // When the app was last put away, for the "since you left" summary.
  lastSeen: number | null;
}

const KEY = 'switchboard.prefs';
const DEFAULTS: Prefs = { inbox: 'desktop', steps: 'folded', text: 'default', hidden: [], lastSeen: null };

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return DEFAULTS;
  }
}

function save(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Not stored; the choice lasts until the page closes.
  }
}

const listeners = new Set<(p: Prefs) => void>();
let current = load();

export function setPrefs(patch: Partial<Prefs>): void {
  current = { ...current, ...patch };
  save(current);
  for (const l of listeners) l(current);
}

export function usePrefs(): Prefs {
  const [p, setP] = useState(current);
  useEffect(() => {
    listeners.add(setP);
    return () => {
      listeners.delete(setP);
    };
  }, []);
  return p;
}

export const TEXT_SIZE: Record<Prefs['text'], string> = { smaller: '15px', default: '16px', larger: '18px' };
