// Built CLI -> real Electron -> shared controller, in a background empty store.
// Read-only macOS calls only: no authorization, settings pane, focus or real quit.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const execute = promisify(execFile);
const checkout = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-parity-'));
const root = path.join(home, 'store');
const env = {
  HOME: home,
  SWITCHBOARD_ROOT: root,
  PATH: process.env.PATH || '/usr/bin:/bin',
  TMPDIR: os.tmpdir(),
  SWITCHBOARD_BACKGROUND: '1',
  ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
};
let app;
async function cli(...args) {
  try {
    const { stdout } = await execute('node', [path.join(checkout, 'out/cli.js'), ...args], { env, timeout: 15000 });
    return { code: 0, result: JSON.parse(stdout) };
  } catch (error) {
    if (!error.stderr) throw error;
    return { code: error.code, failure: JSON.parse(error.stderr.trim().split('\n').at(-1)) };
  }
}
try {
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, 'profiles.json'),
    JSON.stringify({
      settings: { terminal: 'Terminal', pollMinutes: 5, usageMode: 'used', appearance: 'system', menuBar: 'icon' },
      profiles: [],
    }),
  );
  const absent = await cli('caffeinate', 'status');
  assert.equal(absent.code, 4);
  assert.equal(absent.failure.error, 'app-unavailable');
  // A blocked optional CLI socket must not prevent the desktop from starting.
  const obstruction = path.join(root, 'app-control.sock');
  await fs.writeFile(obstruction, 'preserve this file');
  app = await electron.launch({
    args: [checkout, `--user-data-dir=${path.join(home, 'electron')}`],
    env,
    timeout: 20000,
  });
  const degradedPage = await app.firstWindow({ timeout: 10000 });
  await degradedPage.waitForFunction(() => typeof window.sb?.getState === 'function', { timeout: 10000 });
  assert.deepEqual((await degradedPage.evaluate(() => window.sb.getState())).profiles, []);
  assert.equal((await cli('caffeinate', 'status')).failure.error, 'app-unavailable');
  assert.equal(await fs.readFile(obstruction, 'utf8'), 'preserve this file');
  await app.close();
  app = undefined;
  await fs.unlink(obstruction);
  console.log('Desktop starts with an obstructed control socket; obstruction preserved.');
  app = await electron.launch({
    args: [checkout, `--user-data-dir=${path.join(home, 'electron')}`],
    env,
    timeout: 20000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.sb?.getState === 'function', { timeout: 15000 });
  const snapshot = await page.evaluate(() => window.sb.getState());
  assert.deepEqual(snapshot.profiles, [], 'No account refreshes or Keychain reads');
  const caffeinate = await cli('caffeinate', 'status');
  assert.equal(caffeinate.code, 0);
  assert.equal(caffeinate.result.active, false);
  const fans = await cli('fans', 'status');
  assert.equal(fans.code, 0);
  assert.equal(typeof fans.result.status, 'string');
  const accessibility = await cli('accessibility', 'status');
  const actual = await app.evaluate(({ systemPreferences, app }) => ({
    trusted: systemPreferences.isTrustedAccessibilityClient(false),
    executable: process.execPath,
    name: app.getName(),
  }));
  assert.equal(accessibility.result.trusted, actual.trusted);
  assert.equal(accessibility.result.identity.executable, actual.executable);
  assert.equal(accessibility.result.identity.name, actual.name);
  const added = await cli('add', 'codex', 'CLI parity fixture');
  assert.equal(added.code, 0);
  // Immediate CLI requests must see the new profile even before the store watcher.
  const focused = await cli('focus', 'codex-cli-parity-fixture');
  assert.equal(focused.code, 4);
  assert.equal(focused.failure.error, 'desktop-not-running');
  const quit = await cli('quit', 'codex-cli-parity-fixture', '--force', '--yes');
  assert.equal(quit.code, 0);
  assert.equal(quit.result.quit, false);
  assert.equal(quit.result.stopped, true);
  const exported = await cli('export', 'codex-cli-parity-fixture', '--format', 't3');
  assert.deepEqual(exported.result, {
    providerInstances: {
      'codex-cli-parity-fixture': {
        driver: 'codex',
        displayName: 'CLI parity fixture',
        accentColor: '#d97757',
        enabled: true,
        config: { binaryPath: 'codex', homePath: path.join(root, 'codex', 'codex-cli-parity-fixture', 'home') },
      },
    },
  });
  const oc = async (...args) => {
    const { stdout } = await execute('node', [path.join(checkout, 'out/opencode/cli.js'), ...args], {
      env,
      timeout: 15000,
    });
    return JSON.parse(stdout);
  };
  await oc('create', 'Keep fixture');
  const preview = await oc('remove', 'keep-fixture', '--keep-bucket', '--dry-run');
  assert.equal(preview.stopsWorker, true);
  const originalKeys = await fs.readFile(path.join(root, 'opencode/keep-fixture/secrets.json'), 'utf8');
  const kept = await oc('remove', 'keep-fixture', '--keep-bucket', '--yes');
  assert.equal(await fs.readFile(path.join(root, 'buckets/keep-fixture/secrets.json'), 'utf8'), originalKeys);
  await oc('create', 'Delete fixture');
  const deleted = await oc('remove', 'delete-fixture', '--delete-bucket', '--yes');
  assert.equal(deleted.bucket, 'delete');
  assert.deepEqual(await oc('list'), []);
  console.log(
    JSON.stringify(
      {
        fixture: 'isolated background Electron; no signed-in profiles',
        caffeinate,
        fans,
        accessibility,
        focused,
        quit,
        exported,
        preview,
        kept,
        deleted,
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
}
