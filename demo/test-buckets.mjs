// Real renderer, preload, main process, persisted assignments and shared worker.
// Uses invented profiles and an empty bucket. No user credentials or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-bucket-ui-'));
const output = path.join(root, 'docs', '.work', 'buckets');
await fs.mkdir(output, { recursive: true });
await fs.mkdir(path.join(home, '.switchboard'));
const settings = { terminal: 'Terminal', pollMinutes: 60, usageMode: 'used', appearance: 'light' };
const profiles = [
  { id: 'codex-work', vendor: 'codex', name: 'Work', color: '#ec4899', isDefault: false },
  { id: 'codex-personal', vendor: 'codex', name: 'Personal', color: '#10a37f', isDefault: false },
];
await fs.writeFile(path.join(home, '.switchboard', 'profiles.json'), JSON.stringify({ settings, profiles }));
const executablePath = process.argv.includes('--packaged')
  ? path.join(root, 'dist', `mac-${process.arch}`, 'Switchboard.app', 'Contents', 'MacOS', 'Switchboard')
  : undefined;
const options = {
  executablePath,
  args: [...(executablePath ? [] : [root]), `--user-data-dir=${path.join(home, 'electron')}`],
  env: {
    ...process.env,
    HOME: home,
    SWITCHBOARD_ROOT: path.join(home, '.switchboard'),
    SWITCHBOARD_PROXY_BINARY: path.join(os.homedir(), '.switchboard', 'bin', 'cliproxyapi-7.3.2', 'cli-proxy-api'),
  },
};
let app;
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for bucket state');
}
async function portClosed(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}
async function crashWorker(receipt) {
  // The detached worker and its proxy share a process group. This models a
  // reboot: neither can clean its receipt or lease before both disappear.
  process.kill(-receipt.pid, 'SIGKILL');
  await until(() => portClosed(receipt.controlPort));
  await until(() => portClosed(receipt.proxyPort));
}
try {
  app = await electron.launch(options);
  let page = await app.firstWindow();
  await page.getByRole('button', { name: 'More actions for Work' }).waitFor();
  await page.locator('#tab-buckets').click();
  await page.getByRole('button', { name: 'Proxy bucket', exact: true }).click();
  await page.locator('#bucket-name').fill('Team');
  await page.getByRole('button', { name: 'Create bucket', exact: true }).click();
  await page.locator('[data-bucket="team"]').waitFor();
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Add Claude account', exact: true }).count(), 1);
  assert.equal(await page.getByRole('menuitem', { name: 'Add ChatGPT account', exact: true }).count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('#tab-profiles').click();
  await page.getByRole('button', { name: 'More actions for Work' }).click();
  await page.getByRole('menuitem', { name: 'Connection' }).click();
  await page.getByRole('menuitemradio', { name: 'Team' }).click();
  await until(() =>
    page.evaluate(
      async () => (await window.sb.getState()).profiles.find((p) => p.id === 'codex-work').proxyBucket === 'team',
    ),
  );
  let state = await page.evaluate(() => window.sb.getState());
  assert.equal(state.profiles.find((p) => p.id === 'codex-personal').proxyBucket, undefined);
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.sb.setProxyBucket('codex-work', '../invalid');
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.locator('#tab-buckets').click();
  await page.getByRole('button', { name: 'Start bucket', exact: true }).click();
  await until(() => page.evaluate(async () => (await window.sb.getState()).buckets[0]?.status === 'running'));
  await page.screenshot({ path: path.join(output, 'light.png') });
  await page.locator('#tab-profiles').click();
  await page.getByText('Usage from the Team bucket', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'light-accounts.png') });
  const receipt = JSON.parse(
    await fs.readFile(path.join(home, '.switchboard', 'buckets', 'team', 'runtime', 'worker.json')),
  );
  process.kill(receipt.pid, 0);
  await page.evaluate(() => window.sb.saveSettings({ appearance: 'dark' }));
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 640));
  assert.equal(
    await page.evaluate(() =>
      [document.documentElement, document.getElementById('root')].every((el) => el.scrollWidth <= el.clientWidth),
    ),
    true,
  );
  await page.screenshot({ path: path.join(output, 'dark-minimum.png') });
  await app.close();
  app = await electron.launch(options);
  page = await app.firstWindow();
  await page.getByRole('button', { name: 'More actions for Work' }).waitFor();
  // The bucket list arrives a moment after the window; until then the menu
  // can only call the assignment unavailable.
  await until(() => page.evaluate(async () => (await window.sb.getState()).buckets?.some((b) => b.id === 'team')));
  await page.getByRole('button', { name: 'More actions for Work' }).click();
  await page.getByRole('menuitem', { name: 'Connection' }).click();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Team' }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.sb.bucketAction('team', 'start'));
  const reused = JSON.parse(
    await fs.readFile(path.join(home, '.switchboard', 'buckets', 'team', 'runtime', 'worker.json')),
  );
  assert.equal(reused.instance, receipt.instance, 'Restart must reuse the same worker');
  await crashWorker(reused);
  await page.evaluate(() => window.sb.bucketAction('team', 'start'));
  const restarted = JSON.parse(
    await fs.readFile(path.join(home, '.switchboard', 'buckets', 'team', 'runtime', 'worker.json')),
  );
  assert.notEqual(restarted.instance, reused.instance, 'Start must recover a dead worker');
  await app.close();
  await crashWorker(restarted);
  app = await electron.launch(options);
  page = await app.firstWindow();
  await until(() => page.evaluate(async () => (await window.sb.getState()).buckets[0]?.status === 'running'));
  const resumed = JSON.parse(
    await fs.readFile(path.join(home, '.switchboard', 'buckets', 'team', 'runtime', 'worker.json')),
  );
  assert.notEqual(resumed.instance, restarted.instance, 'App startup must resume an interrupted bucket');
  // Empty pools fail closed rather than launching the native desktop account.
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.sb.launch('codex-work');
        return false;
      } catch (error) {
        return error.message.includes('no enabled accounts');
      }
    }),
    true,
  );
  await page.evaluate(() => window.sb.setProxyBucket('codex-work', null));
  await page.getByRole('button', { name: 'More actions for Work' }).click();
  await page.getByRole('menuitem', { name: 'Connection' }).click();
  assert.equal(await page.getByRole('menuitemradio', { name: 'Native account' }).getAttribute('aria-checked'), 'true');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.sb.bucketAction('team', 'stop'));
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(resumed.pid, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.throws(() => process.kill(resumed.pid, 0));
  const runtime = path.join(home, '.switchboard', 'buckets', 'team', 'runtime');
  await fs.writeFile(path.join(runtime, 'worker.lock'), JSON.stringify({ pid: process.pid, instance: 'fixture' }));
  const failure = await page.evaluate(async () => {
    try {
      await window.sb.bucketAction('team', 'start');
      return '';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(failure, /worker lease without a receipt/);
  await until(() =>
    page.evaluate(async () =>
      (await window.sb.getState()).buckets[0]?.error?.includes('worker lease without a receipt'),
    ),
  );
  await fs.rm(path.join(runtime, 'worker.lock'));
  await app.close();
  app = await electron.launch(options);
  page = await app.firstWindow();
  await until(() => page.evaluate(async () => (await window.sb.getState()).buckets[0]?.status === 'stopped'));
  assert.equal(
    await fs.stat(path.join(runtime, 'worker.json')).then(
      () => true,
      () => false,
    ),
    false,
  );
  state = await page.evaluate(() => window.sb.getState());
  assert.equal(JSON.stringify(state).includes('managementKey'), false);
  assert.equal(JSON.stringify(state).includes('apiKey'), false);
  // Removal: an invented account is signed out through the proxy, then the
  // bucket goes, and the profile routed through it is moved back to native.
  const auth = path.join(home, '.switchboard', 'buckets', 'team', 'proxy', 'auth');
  const token = path.join(auth, 'codex-fixture-remove@example.test-pro.json');
  await fs.writeFile(
    token,
    JSON.stringify({ type: 'codex', email: 'remove@example.test', access_token: 'x', refresh_token: 'y' }),
  );
  await page.evaluate(() => window.sb.setProxyBucket('codex-work', 'team'));
  await page.locator('#tab-buckets').click();
  await page.evaluate(() => window.sb.bucketAction('team', 'start'));
  await page.getByRole('button', { name: 'More actions for remove@example.test' }).waitFor();
  const answer = (response) =>
    app.evaluate(({ dialog }, response) => {
      dialog.showMessageBox = async () => ({ response, checkboxChecked: false });
    }, response);
  // Cancel is checked through the IPC call itself, which resolves only once
  // the dialog has answered.
  await answer(1);
  assert.equal(
    await page.evaluate(() => window.sb.removeBucketAccount('team', 'codex-fixture-remove@example.test-pro.json')),
    false,
  );
  assert.equal(await fs.stat(token).then(() => true), true, 'Cancel must keep the account');
  await answer(0);
  await page.getByRole('button', { name: 'More actions for remove@example.test' }).click();
  await page.screenshot({ path: path.join(output, 'remove-account-menu.png') });
  await page.getByRole('menuitem', { name: 'Remove account…' }).click();
  await until(() => page.evaluate(async () => (await window.sb.getState()).buckets[0]?.accounts.length === 0));
  assert.equal(
    await fs.stat(token).then(
      () => true,
      () => false,
    ),
    false,
  );
  const live = JSON.parse(await fs.readFile(path.join(runtime, 'worker.json')));
  await answer(1);
  assert.equal(await page.evaluate(() => window.sb.removeBucket('team')), false);
  assert.equal((await page.evaluate(() => window.sb.getState())).buckets.length, 1, 'Cancel must keep the bucket');
  await answer(0);
  await page.getByRole('button', { name: 'More actions for Team' }).click();
  await page.screenshot({ path: path.join(output, 'remove-bucket-menu.png') });
  await page.getByRole('menuitem', { name: 'Remove bucket…' }).click();
  await page.getByText('No proxy buckets yet').waitFor();
  state = await page.evaluate(() => window.sb.getState());
  assert.equal(state.profiles.find((p) => p.id === 'codex-work').proxyBucket, undefined);
  assert.equal(
    await fs.stat(path.join(home, '.switchboard', 'buckets', 'team')).then(
      () => true,
      () => false,
    ),
    false,
  );
  await until(() => {
    try {
      process.kill(live.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  console.log(
    'Bucket UI, interrupted-worker recovery, startup resume, visible errors, normal Stop and removal passed.',
  );
} finally {
  if (app) {
    try {
      const page = await app.firstWindow();
      await page.evaluate(() => window.sb.bucketAction('team', 'stop'));
    } catch {}
    await app.close().catch(() => {});
  }
  await fs.rm(home, { recursive: true, force: true });
}
