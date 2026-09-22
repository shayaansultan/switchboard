import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as path from 'node:path';
import { run, resetStore } from './cli-helpers';
import { execEnv } from '../src/cli/exec';
import { runInherit } from '../src/child';
import * as store from '../src/store';
import { launcherScript } from '../src/shim';

beforeEach(resetStore);
afterEach(resetStore);

test('execEnv sets the home for an added profile and clears it for the Default', () => {
  const added = { id: 'claude-w', vendor: 'claude' as const, name: 'W', isDefault: false, color: '#000' };
  const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/elsewhere' };
  expect(execEnv(added, base)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: store.dirs(added).home });
  const fallback = { ...added, id: 'claude-default', isDefault: true };
  expect(execEnv(fallback, base)).toEqual({ PATH: '/bin' });
  expect(base.CLAUDE_CONFIG_DIR).toBe('/elsewhere');
});

test('runInherit resolves with the child exit status', async () => {
  expect(await runInherit('/bin/sh', ['-c', 'exit 7'])).toBe(7);
  expect(await runInherit('/bin/sh', ['-c', 'kill -TERM $$'])).toBe(143);
});

test('exec runs inside the profile and propagates the status; cli prefixes the vendor CLI', async () => {
  await run('add', 'codex', 'Job');
  const home = path.join(store.ROOT, 'codex', 'codex-job', 'home');
  const inside = await run('exec', 'codex-job', '--', '/bin/sh', '-c', `test "$CODEX_HOME" = '${home}' && exit 3`);
  expect(inside.code).toBe(3);
  expect((await run('exec', 'codex-job')).failure().error).toBe('usage');
  expect((await run('exec', 'codex-job', '--', '/no/such/binary')).failure().error).toBe('not-installed');
});

test('command and env print the shell forms', async () => {
  await run('add', 'claude', 'Work');
  const home = path.join(store.ROOT, 'claude', 'claude-work', 'home');
  expect((await run('command', 'claude-work', '--', '-p', 'hi')).json()).toEqual({
    command: `CLAUDE_CONFIG_DIR='${home}' claude -p hi`,
  });
  expect((await run('command', 'claude')).json()).toEqual({ command: 'claude' });
  expect((await run('env', 'claude-work')).out).toBe(`export CLAUDE_CONFIG_DIR='${home}'`);
  expect((await run('env', 'claude-work', '--fish')).out).toBe(`set -gx CLAUDE_CONFIG_DIR '${home}'`);
  expect((await run('env', 'claude')).out).toBe('unset CLAUDE_CONFIG_DIR');
  expect((await run('env', 'claude', '--fish')).out).toBe('set -e CLAUDE_CONFIG_DIR');
  expect((await run('env', 'claude-work', '--json')).json()).toEqual({ set: { CLAUDE_CONFIG_DIR: home }, unset: [] });
});

test('shell quoting survives a single quote in a path', () => {
  const script = launcherScript('t', ["/Users/o'brien/bin/x"], { A: "it's" });
  expect(script).toBe(`#!/bin/sh\n# t\nexport A='it'\\''s'\nexec '/Users/o'\\''brien/bin/x' "$@"\n`);
});
