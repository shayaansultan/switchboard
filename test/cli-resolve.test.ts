import { test, expect } from 'bun:test';
import { CliError } from '../src/cli/output';
import { parseDuration, resolveProfile } from '../src/cli/resolve';
import type { Store } from '../src/types';

const profile = (id: string, vendor: 'claude' | 'codex', name: string, isDefault = false) => ({
  id,
  vendor,
  name,
  isDefault,
  color: '#000',
});

const data: Store = {
  settings: { terminal: 'Terminal', pollMinutes: 5, usageMode: 'used' },
  profiles: [
    profile('claude-default', 'claude', 'Default', true),
    profile('codex-default', 'codex', 'Default', true),
    profile('claude-work', 'claude', 'Work'),
    profile('codex-work', 'codex', 'Work'),
    profile('claude-side-project', 'claude', 'Side Project'),
  ],
};

const failure = (token: string): CliError => {
  try {
    resolveProfile(data, token);
  } catch (error) {
    return error as CliError;
  }
  throw new Error(`expected ${token} to fail`);
};

test('a profile resolves by id, vendor alias, vendor/name, slug, or unique name', () => {
  expect(resolveProfile(data, 'claude-work').id).toBe('claude-work');
  expect(resolveProfile(data, 'claude').id).toBe('claude-default');
  expect(resolveProfile(data, 'codex').id).toBe('codex-default');
  expect(resolveProfile(data, 'codex/work').id).toBe('codex-work');
  expect(resolveProfile(data, 'codex/WORK').id).toBe('codex-work');
  expect(resolveProfile(data, 'claude/default').id).toBe('claude-default');
  expect(resolveProfile(data, 'side-project').id).toBe('claude-side-project');
  expect(resolveProfile(data, 'Side Project').id).toBe('claude-side-project');
});

test('an ambiguous name is a usage error listing the candidates', () => {
  const error = failure('work');
  expect(error.code).toBe('ambiguous-profile');
  expect(error.exit).toBe(2);
  expect(error.extra.candidates?.map((c) => c.id)).toEqual(['claude-work', 'codex-work']);
});

test('an unknown profile or vendor is reported as such', () => {
  expect(failure('nothing')).toMatchObject({ code: 'no-such-profile', exit: 3 });
  expect(failure('gemini/work')).toMatchObject({ code: 'usage', exit: 2 });
});

test('durations accept s, m, h, d and bare seconds', () => {
  expect(parseDuration('30s')).toBe(30_000);
  expect(parseDuration('15m')).toBe(900_000);
  expect(parseDuration('2h')).toBe(7_200_000);
  expect(parseDuration('1d')).toBe(86_400_000);
  expect(parseDuration('90')).toBe(90_000);
  expect(parseDuration('0')).toBe(0);
  expect(() => parseDuration('soon')).toThrow(CliError);
});
