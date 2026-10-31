import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { emptyAgg } from '../src/history/ledger';
import {
  loadPrices,
  parseCatalogue,
  priceOf,
  pricesAsOf,
  refreshPrices,
  repriced,
  resetPrices,
  valueParts,
} from '../src/history/prices';

const file = path.join(sandboxHome, 'prices-test', 'prices.json');
afterEach(() => {
  resetPrices();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

// A slice of models.dev's catalogue: other providers are ignored.
const catalogue = {
  anthropic: { models: { 'claude-sonnet-9': { cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 } } } },
  openai: {
    models: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`gpt-9.${i}-sol`, { cost: { input: 2, output: 10, cache_read: 0.1 } }]),
    ),
  },
  elsewhere: { models: { 'claude-sonnet-9': { cost: { input: 99, output: 99 } } } },
};
const fetchOf = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test("today's models.dev prices value a model the bundled table never knew", async () => {
  expect(priceOf('claude-sonnet-9')).toBeNull();
  const now = Date.parse('2026-10-28T10:00:00Z');
  expect(await refreshPrices(file, fetchOf(catalogue), now)).toBe(true);
  expect(priceOf('claude-sonnet-9')).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
  // OpenAI's writes are free when models.dev gives no price for them.
  expect(priceOf('gpt-9.3-sol-high')?.cacheWrite).toBe(0);
  expect(pricesAsOf()).toBe('2026-10-28');
  // The bundled table still answers for what the list lacks.
  expect(priceOf('claude-opus-5-5')?.input).toBe(4);
  // Kept, so the CLI and the next start read it without fetching.
  resetPrices();
  expect(loadPrices(file, now + 3_600_000)).toBe(3_600_000);
  expect(priceOf('claude-sonnet-9')?.output).toBe(10);
});

test('the list is fetched at most once a day, and a failure keeps what was in use', async () => {
  const now = Date.parse('2026-10-28T10:00:00Z');
  await refreshPrices(file, fetchOf(catalogue), now);
  let fetched = 0;
  const counting = (async () => {
    fetched++;
    throw new Error('offline');
  }) as unknown as typeof fetch;
  expect(await refreshPrices(file, counting, now + 3_600_000)).toBe(false);
  expect(fetched).toBe(0);
  expect(await refreshPrices(file, counting, now + 25 * 3_600_000)).toBe(false);
  expect(fetched).toBe(1);
  expect(priceOf('claude-sonnet-9')).not.toBeNull();
  // A reply that is not a price list is not kept.
  expect(await refreshPrices(file, fetchOf({ anthropic: {} }), now + 26 * 3_600_000)).toBe(false);
  expect(Object.keys(parseCatalogue(null))).toEqual([]);
});

test('tokens recorded before their model had a price are valued once it has one', async () => {
  const a = { ...emptyAgg(), t: [1e6, 1e6, 0, 0] as [number, number, number, number], u: 2e6 };
  expect(repriced('claude-sonnet-9', a)).toBe(a);
  await refreshPrices(file, fetchOf(catalogue), Date.now());
  expect(repriced('claude-sonnet-9', a)).toMatchObject({ v: [2, 10, 0, 0], u: 0 });
  const priced = { ...emptyAgg(), v: [1, 0, 0, 0] as [number, number, number, number] };
  expect(repriced('claude-sonnet-9', priced)).toBe(priced);
});

test('a dated or effort-qualified id takes its base model price', () => {
  expect(priceOf('claude-haiku-4-5-20251001')).toBe(priceOf('claude-haiku-4-5'));
  expect(priceOf('gpt-5-2025-08-07')).toBe(priceOf('gpt-5'));
  expect(priceOf('gpt-5.3-codex-high')).toBe(priceOf('gpt-5.3-codex'));
  expect(priceOf('anthropic/claude-opus-5-5')).toBe(priceOf('claude-opus-5-5'));
});

test('a different or newer model never inherits a price', () => {
  expect(priceOf('gpt-5-mini')?.input).toBe(0.25);
  expect(priceOf('gpt-5.4-mini-2026-03-17')).toBe(priceOf('gpt-5.4-mini'));
  expect(priceOf('claude-opus-5-7')).toBeNull();
  expect(priceOf('gpt-5.7')).toBeNull();
  expect(priceOf('gpt-5-turbo')).toBeNull();
});

test('value by kind, with one-hour cache writes at twice the input price', () => {
  // claude-sonnet-5: $2 in, $10 out, $0.20 cache read, $2.50 five-minute write.
  const v = valueParts('claude-sonnet-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 2e6 }, 1e6);
  expect(v).toEqual([2, 10, 0.2, 2.5 + 4]);
  expect(valueParts('unknown-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
});

test("each tier of a model family has its own price, not the family's", () => {
  expect(priceOf('gpt-5.6-luna')?.input).toBe(0.2);
  expect(priceOf('gpt-5.6-terra')?.input).toBe(2);
  expect(priceOf('gpt-6-astra')?.output).toBe(50);
  expect(priceOf('gpt-6-nova')).toBeNull();
});
