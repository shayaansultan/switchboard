// What every command receives, and the small argument helpers they share.

import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import type { Store } from '../types';
import { usageError, type Flags, type Output } from './output';

export interface Context {
  data: Store;
  out: Output;
  flags: Flags;
}

// Node's parseArgs, positionals allowed, with its errors reported as usage errors.
export function parse<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    throw usageError((error as Error).message.replace(/\.?\s*To specify a positional argument.*$/s, ''));
  }
}

export function required(value: string | undefined, label: string): string {
  if (!value?.trim()) throw usageError(`${label} is required`);
  return value;
}

// Split `[...own args, '--', ...passthrough]`.
export function splitPassthrough(rest: string[]): { own: string[]; passthrough: string[] | null } {
  const at = rest.indexOf('--');
  return at < 0 ? { own: rest, passthrough: null } : { own: rest.slice(0, at), passthrough: rest.slice(at + 1) };
}
