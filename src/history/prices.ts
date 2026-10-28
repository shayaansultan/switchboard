// What a model's tokens would cost at API list prices, which is how the
// Usage tab puts one number on work done under a flat-rate plan. The figure is
// an estimate by design: subscriptions do not bill per token.
//
// Prices are US dollars per million tokens, for direct API use without a
// regional surcharge, from models.dev. The app fetches its list once a day
// (refreshPrices) and keeps Anthropic's and OpenAI's part of it in
// ~/.switchboard/usage/prices.json, so a new model is priced without anyone
// editing this file; the table below, from 26 Sep 2026, is the fallback when
// that has never succeeded. Long-context tiers are ignored, so very long
// requests read low. A model neither knows is left unpriced, never guessed.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Agg } from './ledger';
import type { TokenCounts } from '../types';

export const PRICES_AS_OF = '2026-09-26';
const PRICE_URL = 'https://models.dev/api.json';
const REFRESH_MS = 24 * 3_600_000;

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  // A five-minute cache write. OpenAI does not charge for writes.
  cacheWrite: number;
}

const claude = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});
const openai = (input: number, output: number, cacheRead: number): Price => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});

const TABLE: Record<string, Price> = {
  'claude-fable-5-1': claude(10, 50, 0.25),
  'claude-fable-5': claude(10, 50, 1),
  'claude-opus-5-5': claude(4, 20, 0.2),
  'claude-opus-5': claude(5, 25, 0.5),
  'claude-opus-4-8': claude(5, 25, 0.5),
  'claude-opus-4-7': claude(5, 25, 0.5),
  'claude-opus-4-6': claude(5, 25, 0.5),
  'claude-opus-4-5': claude(5, 25, 0.5),
  'claude-opus-4-1': claude(15, 75, 1.5),
  'claude-sonnet-5': claude(2, 10, 0.2),
  'claude-sonnet-4-6': claude(3, 15, 0.3),
  'claude-sonnet-4-5': claude(3, 15, 0.3),
  'claude-sonnet-4': claude(3, 15, 0.3),
  'claude-haiku-4-5': claude(1, 5, 0.1),
  'gpt-6-astra': openai(10, 50, 1),
  'gpt-6-sol': openai(2, 10, 0.2),
  'gpt-6-luna': openai(0.1, 0.5, 0.01),
  'gpt-5.6-sol': openai(4, 20, 0.4),
  'gpt-5.6-terra': openai(2, 12, 0.2),
  'gpt-5.6-luna': openai(0.2, 1.2, 0.02),
  'gpt-5.6': openai(4, 20, 0.4),
  'gpt-5.5': openai(5, 30, 0.5),
  'gpt-5.4': openai(2.5, 15, 0.25),
  'gpt-5.4-mini': openai(0.75, 4.5, 0.075),
  'gpt-5.3-codex': openai(1.75, 14, 0.175),
  'gpt-5.3-codex-spark': openai(1.75, 14, 0.175),
  'gpt-5.2-codex': openai(1.75, 14, 0.175),
  'gpt-5.2': openai(1.75, 14, 0.175),
  'gpt-5.1-codex-mini': openai(0.25, 2, 0.025),
  'gpt-5.1-codex-max': openai(1.25, 10, 0.125),
  'gpt-5.1-codex': openai(1.25, 10, 0.125),
  'gpt-5.1': openai(1.25, 10, 0.125),
  'gpt-5-codex': openai(1.25, 10, 0.125),
  'gpt-5-mini': openai(0.25, 2, 0.025),
  'gpt-5-nano': openai(0.05, 0.4, 0.005),
  'gpt-5': openai(1.25, 10, 0.125),
};

// The fetched list, when there is one; it wins over the bundled table.
let live: { asOf: string; models: Record<string, Price> } | null = null;

export function pricesAsOf(): string {
  return live?.asOf ?? PRICES_AS_OF;
}

// models.dev's `cost` for one model, as this module's Price. A write price it
// leaves out is Anthropic's 1.25× input or OpenAI's nothing.
function fromCost(provider: string, c: unknown): Price | null {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const cost = (c ?? {}) as Record<string, unknown>;
  const input = n(cost.input);
  const output = n(cost.output);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cacheRead: n(cost.cache_read) ?? input,
    cacheWrite: n(cost.cache_write) ?? (provider === 'anthropic' ? input * 1.25 : 0),
  };
}

// Anthropic's and OpenAI's models from models.dev's whole catalogue.
export function parseCatalogue(json: unknown): Record<string, Price> {
  const out: Record<string, Price> = {};
  for (const provider of ['anthropic', 'openai']) {
    const models = (json as Record<string, { models?: Record<string, { cost?: unknown }> }>)?.[provider]?.models ?? {};
    for (const [id, m] of Object.entries(models)) {
      const p = fromCost(provider, m?.cost);
      if (p) out[id.toLowerCase()] = p;
    }
  }
  return out;
}

// Use the list kept at `file`, if there is a readable one. Returns its age in
// milliseconds, or null when there is none.
export function loadPrices(file: string, now = Date.now()): number | null {
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof kept?.asOf !== 'string' || !kept.models || typeof kept.models !== 'object') return null;
    live = { asOf: kept.asOf.slice(0, 10), models: kept.models };
    return now - Date.parse(kept.asOf);
  } catch {
    return null;
  }
}

// Fetch models.dev when the kept list is a day old or missing, keep its
// Anthropic and OpenAI prices, and use them. Never throws: a failure leaves
// whatever list was in use. True when the prices changed.
export async function refreshPrices(file: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<boolean> {
  const age = loadPrices(file, now);
  if (age !== null && age < REFRESH_MS) return false;
  try {
    const res = await fetchImpl(PRICE_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return false;
    const models = parseCatalogue(await res.json());
    if (Object.keys(models).length < 10) return false;
    const asOf = new Date(now).toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ asOf, source: PRICE_URL, models }));
    live = { asOf: asOf.slice(0, 10), models };
    return true;
  } catch {
    return false;
  }
}

// For tests: forget any fetched list.
export function resetPrices(): void {
  live = null;
}

// What may follow a known id and still be that model: a release date, in
// Anthropic's or OpenAI's form, or a reasoning effort. Anything else (a
// "-mini", a newer version) is a different model.
const SAME_MODEL = /^-(\d{8}|\d{4}-\d{2}-\d{2}|minimal|low|medium|high|xhigh|latest)$/;

// The table's entry for a model id as the logs write it. A dated or
// effort-qualified id ("claude-haiku-4-5-20251001", "gpt-5.3-codex-high")
// takes its base model's price; a different model ("gpt-5-mini" beside
// "gpt-5", a newer "claude-opus-5-7") does not inherit one.
export function priceOf(model: string): Price | null {
  const id = model.toLowerCase().replace(/^(anthropic|openai)[/.]/, '');
  for (const table of live ? [live.models, TABLE] : [TABLE]) {
    if (table[id]) return table[id];
    const base = Object.keys(table)
      .filter((key) => id.startsWith(key) && SAME_MODEL.test(id.slice(key.length)))
      .sort((a, b) => b.length - a.length)[0];
    if (base) return table[base];
  }
  return null;
}

// An aggregate recorded while its model had no price, valued now if it has
// one (its cache writes at the five-minute rate, since which were the hour's
// was not kept). Priced aggregates are returned as they are.
export function repriced(model: string, a: Agg): Agg {
  if (!a.u) return a;
  const parts = valueParts(model, { input: a.t[0], output: a.t[1], cacheRead: a.t[2], cacheWrite: a.t[3] });
  return parts ? { ...a, v: parts, u: 0 } : a;
}

// Dollars for one model's tokens by kind (input, output, cache read, cache
// write), or null when the model has no price. `cacheWriteLong` is the part
// of the cache writes kept for an hour, which Anthropic charges at twice the
// input price.
export function valueParts(model: string, t: TokenCounts, cacheWriteLong = 0): [number, number, number, number] | null {
  const p = priceOf(model);
  if (!p) return null;
  const short = Math.max(0, t.cacheWrite - cacheWriteLong);
  return [
    (t.input * p.input) / 1e6,
    (t.output * p.output) / 1e6,
    (t.cacheRead * p.cacheRead) / 1e6,
    (short * p.cacheWrite + cacheWriteLong * p.input * 2) / 1e6,
  ];
}
