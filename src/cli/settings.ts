// The app's settings, read and written as the app reads them. The app applies
// side effects (polling cadence, login item, appearance) when it reloads.

import * as launch from '../launch';
import { save } from '../store';
import type { Settings } from '../types';
import type { Context } from './context';
import { required } from './context';
import { usageError } from './output';
import { mutateStore } from './resolve';

type Parser = (text: string) => Settings[keyof Settings];

const oneOf =
  <T extends string>(...options: T[]): ((text: string) => T) =>
  (text) => {
    if ((options as string[]).includes(text)) return text as T;
    throw usageError(`Value must be one of: ${options.join(', ')}`);
  };

const PARSERS: Record<keyof Settings, Parser> = {
  terminal: (text) => text,
  pollMinutes: (text) => {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1) throw usageError('pollMinutes must be a whole number of minutes, at least 1');
    return n;
  },
  usageMode: oneOf('used', 'remaining'),
  openAtLogin: (text) => {
    if (/^(true|on|yes|1)$/i.test(text)) return true;
    if (/^(false|off|no|0)$/i.test(text)) return false;
    throw usageError('openAtLogin must be true or false');
  },
  appearance: oneOf('system', 'light', 'dark'),
  menuBar: oneOf('icon', 'percent'),
  view: oneOf('cards', 'list'),
};

const isKey = (key: string): key is keyof Settings => key in PARSERS;

export function settingsCommand(rest: string[], ctx: Context): void {
  const [sub, key, value] = rest;
  if (sub === 'get') {
    if (key === undefined) {
      ctx.out.result(ctx.data.settings);
      return;
    }
    if (!isKey(key)) throw usageError(`Unknown setting ${key}; one of ${Object.keys(PARSERS).join(', ')}`);
    ctx.out.result({ key, value: ctx.data.settings[key] ?? null });
    return;
  }
  if (sub !== 'set') throw usageError('settings needs get or set');
  const name = required(key, 'Setting');
  if (!isKey(name)) throw usageError(`Unknown setting ${name}; one of ${Object.keys(PARSERS).join(', ')}`);
  const parsed = PARSERS[name](required(value, 'Value'));
  const settings = mutateStore((data) => {
    data.settings = { ...data.settings, [name]: parsed };
    save(data);
    return data.settings;
  });
  const warnings: string[] = [];
  if (name === 'terminal' && !launch.installedTerminals().some((t) => t.id === parsed)) {
    warnings.push(`${parsed} is not an installed terminal; Terminal.app will be used until it is`);
  }
  ctx.out.result({ settings, ...(warnings.length ? { warnings } : {}) });
}
