import { expect, test } from 'bun:test';
import { priceOf, valueParts } from '../src/history/prices';

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
