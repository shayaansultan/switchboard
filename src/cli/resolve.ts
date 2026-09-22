// Turning what a person or agent typed into a profile, a duration, or a
// confirmed intent, and running store mutations under the shared lock.

import { createInterface } from 'node:readline/promises';
import { load, slugify, withStoreLock, VENDOR_IDS, STORE_FILE } from '../store';
import type { Profile, Store, Vendor } from '../types';
import { CliError, notFound, ref, refused, usageError, type Flags } from './output';

export const isVendor = (value: string): value is Vendor => (VENDOR_IDS as string[]).includes(value);

export function parseVendor(value: string | undefined): Vendor {
  if (!value || !isVendor(value)) throw usageError(`Vendor must be one of: ${VENDOR_IDS.join(', ')}`);
  return value;
}

// A profile by id, by vendor alias (`claude` is that vendor's Default), by
// `vendor/name`, or by name alone when only one profile has it.
export function resolveProfile(data: Store, token: string): Profile {
  const byId = data.profiles.find((p) => p.id === token);
  if (byId) return byId;
  if (isVendor(token)) {
    const fallback = data.profiles.find((p) => p.vendor === token && p.isDefault);
    if (fallback) return fallback;
  }
  const slash = token.indexOf('/');
  const vendor = slash > 0 ? token.slice(0, slash) : null;
  const name = (slash > 0 ? token.slice(slash + 1) : token).toLowerCase();
  if (vendor !== null && !isVendor(vendor)) throw usageError(`Unknown vendor in "${token}"`);
  const matches = data.profiles.filter(
    (p) => (vendor === null || p.vendor === vendor) && (p.name.toLowerCase() === name || slugify(p.name) === name),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new CliError(
      'ambiguous-profile',
      `"${token}" matches ${matches.map((p) => p.id).join(' and ')}; use the id or vendor/name`,
      2,
      { candidates: matches.map(ref) },
    );
  }
  throw notFound('no-such-profile', `No profile matches "${token}"`, 'switchboard list');
}

// "15m", "2h", "30s", "1d", or a bare number of seconds, as milliseconds.
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(text.trim());
  if (!m) throw usageError(`Cannot read "${text}" as a duration; use 30s, 15m, 2h or 1d`);
  const units: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(m[1]) * (units[m[2] ?? 's'] ?? 1_000);
}

// Whether the person meant it. `--yes` says so; a terminal can be asked; an
// agent without a terminal must pass the flag.
export async function confirm(flags: Flags, question: string): Promise<void> {
  if (flags.yes) return;
  if (!process.stdin.isTTY) throw refused('confirmation-required', `${question} Pass --yes to confirm.`, '--yes');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`${question} [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) throw refused('confirmation-required', 'Cancelled.');
  } finally {
    prompt.close();
  }
}

// Read, change and save the store under its lock. Refuses to build on a
// store that load() had to reset: the person should look at the backup first.
export function mutateStore<T>(fn: (data: Store) => T): T {
  return withStoreLock(() => {
    const data = load();
    if (data.loadError) throw refused('store-recovered', data.loadError, `inspect ${STORE_FILE}.corrupt-*`);
    return fn(data);
  });
}
