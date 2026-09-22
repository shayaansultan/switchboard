import { test, expect } from 'bun:test';
import { CliError, Output, classify, table, type Io } from '../src/cli/output';

const cases: [string, string, number][] = [
  ['no such profile', 'no-such-profile', 3],
  ['the default profile cannot be removed', 'default-profile', 4],
  ['the default profile is never written to', 'default-profile', 4],
  ['profiles are for different apps', 'vendor-mismatch', 4],
  ['source and target are the same profile', 'same-profile', 4],
  ['proxy routing is available for Codex desktop profiles', 'wrong-vendor', 4],
  ['/Applications/Claude.app is not installed', 'not-installed', 4],
  ['Quit this desktop profile before launching with a proxy bucket.', 'desktop-running', 4],
  ['This bucket has no enabled accounts. Add an account in Proxy buckets.', 'bucket-empty', 4],
  ['Bucket is stopped. Start it to refresh account usage.', 'bucket-stopped', 4],
  ['Bucket worker is unreachable', 'bucket-unreachable', 4],
  ['Profile x has a live proxy without its controller. Inspect /r before recovery.', 'bucket-unreachable', 4],
  ['Install the routing worker first: oc proxy-install', 'proxy-not-installed', 4],
  ['Proxy already installed: /x', 'proxy-installed', 4],
  ['Account is not in this bucket', 'no-such-account', 3],
  ['no terminal app found', 'no-terminal', 4],
  ['An unrelated or differently installed launcher exists at /x', 'shim-conflict', 4],
  ['Another process is editing /x. Retry in a moment.', 'store-locked', 4],
  ['something else entirely', 'failed', 1],
];

test.each(cases)('classify: %s → %s', (message, code, exit) => {
  const error = classify(new Error(message));
  expect(error.code).toBe(code);
  expect(error.exit).toBe(exit);
  expect(error.message).toBe(message);
});

test('a CliError passes through classify and renders as one JSON line on stderr', () => {
  const error = new CliError('desktop-running', 'Quit it first', 4, { hint: 'switchboard quit x' });
  expect(classify(error)).toBe(error);
  const err: string[] = [];
  const io: Io = { out: () => {}, err: (t) => err.push(t) };
  new Output(io, { json: false, human: false, yes: false, quiet: false }).fail(error);
  expect(err).toEqual(['{"error":"desktop-running","message":"Quit it first","hint":"switchboard quit x"}']);
  const human: string[] = [];
  new Output({ out: () => {}, err: (t) => human.push(t) }, { json: false, human: true, yes: false, quiet: false }).fail(
    error,
  );
  expect(human).toEqual(['error: Quit it first\nswitchboard quit x']);
});

test('result is JSON unless --human and a renderer are both present; narration honours --quiet', () => {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t) };
  new Output(io, { json: false, human: false, yes: false, quiet: false }).result({ a: 1 }, () => 'table');
  new Output(io, { json: false, human: true, yes: false, quiet: false }).result({ a: 1 }, () => 'table');
  new Output(io, { json: false, human: true, yes: false, quiet: false }).result({ a: 1 });
  expect(out).toEqual(['{\n  "a": 1\n}', 'table', '{\n  "a": 1\n}']);
  new Output(io, { json: false, human: false, yes: false, quiet: true }).narrate('hidden');
  new Output(io, { json: false, human: false, yes: false, quiet: false }).narrate('shown');
  expect(err).toEqual(['shown']);
});

test('table aligns columns and renders null as empty', () => {
  expect(
    table(
      [
        { id: 'a', n: 1 },
        { id: 'long-id', n: null },
      ],
      ['id', 'n'],
    ),
  ).toBe('id       n\na        1\nlong-id');
});
