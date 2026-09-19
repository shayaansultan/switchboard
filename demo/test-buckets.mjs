// Real renderer, preload, main process, persisted assignments and shared worker.
// Uses invented profiles and an empty bucket. No user credentials or model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
try {
  app = await electron.launch(options);
  let page = await app.firstWindow();
  await page.getByLabel('Model connection for Work').waitFor();
  await page.locator('#tab-buckets').click();
  await page.getByRole('button', { name: '+ Bucket', exact: true }).click();
  await page.locator('#bucket-name').fill('Team');
  await page.getByRole('button', { name: 'Create bucket', exact: true }).click();
  await page.locator('[data-bucket="team"]').waitFor();
  await page.getByRole('button', { name: 'Add account ▾', exact: true }).click();
  assert.equal(await page.getByRole('menuitem', { name: 'Add Claude account', exact: true }).count(), 1);
  assert.equal(await page.getByRole('menuitem', { name: 'Add ChatGPT account', exact: true }).count(), 1);
  await page.keyboard.press('Escape');
  await page.locator('#tab-accounts').click();
  await page.getByLabel('Model connection for Work').selectOption('team');
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
  await page.screenshot({ path: path.join(output, 'light.png'), fullPage: true });
  await page.locator('#tab-accounts').click();
  await page.getByText('Usage from the Team bucket', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'light-accounts.png'), fullPage: true });
  const receipt = JSON.parse(
    await fs.readFile(path.join(home, '.switchboard', 'buckets', 'team', 'runtime', 'worker.json')),
  );
  process.kill(receipt.pid, 0);
  await page.evaluate(() => window.sb.saveSettings({ appearance: 'dark' }));
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => matchMedia('(prefers-color-scheme: dark)').matches);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 640));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'dark-minimum.png'), fullPage: true });
  await app.close();
  app = await electron.launch(options);
  page = await app.firstWindow();
  await page.getByLabel('Model connection for Work').waitFor();
  assert.equal(await page.getByLabel('Model connection for Work').inputValue(), 'team');
  await page.evaluate(() => window.sb.bucketAction('team', 'start'));
  const reused = JSON.parse(
    await fs.readFile(path.join(home, '.switchboard', 'buckets', 'team', 'runtime', 'worker.json')),
  );
  assert.equal(reused.instance, receipt.instance, 'Restart must reuse the same worker');
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
  assert.equal(await page.getByLabel('Model connection for Work').inputValue(), '');
  await page.evaluate(() => window.sb.bucketAction('team', 'stop'));
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(receipt.pid, 0);
    } catch {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.throws(() => process.kill(receipt.pid, 0));
  state = await page.evaluate(() => window.sb.getState());
  assert.equal(JSON.stringify(state).includes('managementKey'), false);
  assert.equal(JSON.stringify(state).includes('apiKey'), false);
  console.log('Bucket UI, IPC, assignment persistence, worker reuse, fail-closed launch and native reset passed.');
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
