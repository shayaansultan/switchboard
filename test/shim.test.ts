import { test, expect, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sandboxHome } from './setup';
import { installShim, launcherScript } from '../src/shim';
import { run } from './cli-helpers';

const bin = path.join(sandboxHome, '.local', 'bin');
beforeEach(() => fs.rmSync(bin, { recursive: true, force: true }));

test('installShim writes an executable, rewrites an identical one, and refuses a foreign one', () => {
  const script = launcherScript('Test launcher', ['/usr/bin/true']);
  const file = installShim('t', script);
  expect(file).toBe(path.join(bin, 't'));
  expect(fs.statSync(file).mode & 0o755).toBe(0o755);
  expect(installShim('t', script)).toBe(file);
  expect(() => installShim('t', launcherScript('Other', ['/usr/bin/false']))).toThrow(/differently installed/);
});

test('the oc shim content is unchanged by the shared writer', () => {
  expect(launcherScript('Switchboard OpenCode launcher', ['/r/node', '/c/out/opencode/cli.js'])).toBe(
    `#!/bin/sh\n# Switchboard OpenCode launcher\nexec '/r/node' '/c/out/opencode/cli.js' "$@"\n`,
  );
});

test('install-cli --dev refuses a source run, and the app shim needs the installed app', async () => {
  // Under bun test the entry is src/cli.ts, which must never be what a shim points at.
  const dev = await run('install-cli', '--dev');
  expect(dev.code).toBe(4);
  expect(dev.failure().error).toBe('source-run');
  expect(fs.existsSync(path.join(bin, 'switchboard'))).toBe(false);
});
