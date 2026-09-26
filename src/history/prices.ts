// What a model's tokens would cost at API list prices, which is how the
// Usage tab puts one number on work done under a flat-rate plan. The figure is
// an estimate by design: subscriptions do not bill per token, and the table
// below is a dated snapshot rather than a live price list.
//
// Prices are US dollars per million tokens, for direct API use without a
// regional surcharge, taken from models.dev (as bundled by ccusage) on
// 24 Sep 2026. Long-context tiers are ignored, so very long requests read low.
// A model the table does not know is left unpriced rather than guessed.

import type { TokenCounts } from '../types';

export const PRICES_AS_OF = '2026-09-24';

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
  'gpt-5-codex': openai(1.25, 10, 0.125),
  'gpt-5-mini': openai(0.25, 2, 0.025),
  'gpt-5-nano': openai(0.05, 0.4, 0.005),
  'gpt-5': openai(1.25, 10, 0.125),
};

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
  if (TABLE[id]) return TABLE[id];
  const base = Object.keys(TABLE).find((key) => id.startsWith(key) && SAME_MODEL.test(id.slice(key.length)));
  return base ? TABLE[base] : null;
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
