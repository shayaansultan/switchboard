// Exercise the built menu, the in-window reset dialog, preload and the main
// process. Vendor replies and credentials are simulated; no live reset is spent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-reset-ui-'));
let app;
try {
  await fs.mkdir(path.join(home, '.switchboard'));
  await fs.writeFile(
    path.join(home, '.switchboard', 'profiles.json'),
    JSON.stringify({
      settings: { view: 'list' },
      profiles: ['claude', 'codex'].map((vendor) => ({
        id: `${vendor}-default`,
        vendor,
        name: vendor === 'claude' ? 'Claude test' : 'Codex test',
        isDefault: true,
        ...(vendor === 'codex' ? { proxyBucket: 'test-pool' } : {}),
        color: '#10a37f',
      })),
    }),
  );
  const launcher = path.join(home, 'main.cjs');
  await fs.writeFile(
    launcher,
    `
    const root = ${JSON.stringify(root)};
    const usage = require(root + '/out/usage.js');
    usage.claudeToken = async () => ({ token: 'fake', expiresAt: null });
    usage.codexAuth = () => ({ token: 'fake', accountId: 'fake-account', email: 'test@example.com' });
    usage.identity = async () => ({ loggedIn: true, email: 'test@example.com', plan: 'Test' });
    const launch = require(root + '/out/launch.js');
    const run = launch.run;
    launch.run = (cmd, args, opts) => cmd === 'claude' && args[0] === '--version'
      ? Promise.resolve({ stdout: '2.1.285', stderr: '' }) : run(cmd, args, opts);
    global.resetTest = { answers: [], dialogs: [], posts: [], failWrite: false };
    global.fetch = async (url, options) => {
      const test = global.resetTest;
      if (options?.method === 'POST') {
        test.posts.push({ url, body: JSON.parse(options.body) });
        if (test.failWrite) throw new Error('Simulated connection failure');
        return Response.json(url.endsWith('/consume') ? { code: 'reset' } : { result: 'reset' });
      }
      if (url.endsWith('/profile')) return Response.json({ account: { email: 'test@example.com', uuid: '00000000-0000-4000-8000-000000000001' }, organization: { uuid: '00000000-0000-4000-8000-000000000002' } });
      if (url.includes('cedar_ember')) return Response.json({ cedar_ember: { eligible: true, next_grant_id: 'test-grant', grants: [{ id: 'test-grant', label: 'Full reset', resets_left: 1, usable_now: true, paused: false, ends_at: '2099-01-01T00:00:00Z', clears: ['five_hour', 'seven_day'] }] } });
      if (url.endsWith('/rate-limit-reset-credits')) return Response.json({ credits: [{ id: 'test-credit', title: 'Full reset', status: 'available', reset_type: 'codex_rate_limits', is_supported_by_plan: true, expires_at: '2099-01-01T00:00:00Z' }] });
      return Response.json({ limits: [{ label: '5h', percent: 20 }], rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } });
    };
    require('electron').dialog.showMessageBox = async (...args) => {
      const options = args.at(-1); global.resetTest.dialogs.push(options);
      return { response: global.resetTest.answers.shift() ?? options.cancelId ?? 0 };
    };
    const bucketStore = require(root + '/out/buckets/store.js');
    const bucket = bucketStore.create('Test pool');
    const proxy = require(root + '/out/buckets/proxy.js');
    const accounts = ['claude', 'codex'].map(provider => ({ name: provider + '.json', auth_index: provider + '-index', provider, email: provider + '@bucket.test', account_id: 'bucket-' + provider }));
    const status = { receipt: { profileId: bucket.id, instance: 'test-worker', proxyPort: 1, controlPort: 2, pid: 1, startedAt: new Date().toISOString() }, ready: true, supportsAccountRefresh: true, accounts: accounts.map(a => ({ ...a, status: 'fresh', windows: [], weight: 100 })) };
    global.resetTest.recovered = [];
    proxy.control = async (_, action, name) => { if (action === 'refresh-account') global.resetTest.recovered.push(name); return status; };
    proxy.accounts = async () => accounts;
    proxy.management = async (_, __, endpoint, method, body) => {
      if (endpoint === 'reset-quota') return { status: 'ok', auth_index: body.auth_index };
      if (endpoint !== 'api-call') throw new Error('Unexpected management operation');
      const response = await global.fetch(body.url, { method: body.method, body: body.data });
      return { status_code: response.status, body: await response.text() };
    };
    require(root + '/out/main.js');
  `,
  );
  app = await electron.launch({
    args: [launcher, `--user-data-dir=${path.join(home, 'electron')}`],
    env: {
      HOME: home,
      PATH: process.env.PATH,
      TMPDIR: os.tmpdir(),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    },
    timeout: 20000,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(async () => (await window.sb?.getState())?.profiles.every((p) => p.identity?.loggedIn));
  page.on('dialog', (dialog) => dialog.dismiss());
  // Exercise both delivery paths: the bundled renderer's copy button and the
  // compiled CLI must expose the canonical skill, not independent summaries.
  await page.locator('#tab-cli').click();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (text) => {
      window.copiedGuide = text;
    };
  });
  await page.getByRole('button', { name: 'Copy agent prompt', exact: true }).click();
  const guide = await fs.readFile(path.join(root, 'skills/switchboard/SKILL.md'), 'utf8');
  assert.equal(await page.evaluate(() => window.copiedGuide), guide);
  assert.equal(
    execFileSync(process.execPath, [path.join(root, 'out/cli.js'), 'guide'], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, HOME: home },
    }).trimEnd(),
    guide.trimEnd(),
  );
  await page.locator('#tab-profiles').click();
  const dialog = page.locator('#resets-dialog');
  const reset = () =>
    app.evaluate(() => {
      global.resetTest.dialogs = [];
      global.resetTest.posts = [];
      global.resetTest.recovered = [];
    });
  const open = async (menu, item) => {
    await page.getByRole('button', { name: menu }).click();
    await page.getByText(item, { exact: true }).click();
    await dialog.getByRole('radio').first().waitFor();
  };
  const posts = () => app.evaluate(() => global.resetTest.posts.length);
  for (const vendor of ['claude', 'codex']) {
    const menu = `More actions for ${vendor === 'claude' ? 'Claude test' : 'Codex test'}`;
    const item = vendor === 'codex' ? 'Native account resets…' : 'Usage resets…';
    // Closing the list spends nothing.
    await reset();
    await open(menu, item);
    assert.match(await dialog.textContent(), /test@example.com/);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await posts(), 0, 'Closing the list must not reach the vendor');
    // Reaching the confirmation and cancelling spends nothing.
    await open(menu, item);
    await dialog.getByRole('button', { name: 'Use reset…' }).click();
    await dialog.getByRole('heading', { name: 'Use this reset?' }).waitFor();
    assert.match(await dialog.textContent(), /can’t be undone/);
    assert.equal(
      await dialog.evaluate((d) => d.ownerDocument.activeElement?.textContent),
      'Cancel',
      'Confirmation focuses Cancel',
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await posts(), 0, 'Cancelling the confirmation must not reach the vendor');
    // Confirming spends exactly one.
    await open(menu, item);
    await dialog.getByRole('button', { name: 'Use reset…' }).click();
    await dialog.getByRole('button', { name: 'Use reset', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Reset confirmed' }).waitFor();
    assert.match(await dialog.textContent(), /confirmed the/);
    assert.equal(await posts(), 1, 'Only a confirmed reset may reach the vendor');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  await page.locator('#tab-buckets').click();
  for (const vendor of ['claude', 'codex']) {
    await reset();
    await open('More actions for ' + vendor + '@bucket.test', 'Usage resets…');
    await dialog.getByRole('button', { name: 'Use reset…' }).click();
    await dialog.getByRole('button', { name: 'Use reset', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Reset confirmed' }).waitFor();
    const result = await app.evaluate(() => global.resetTest);
    assert.equal(result.posts.length, 1);
    assert.deepEqual(result.recovered, [vendor + '.json']);
    assert.match(await dialog.textContent(), /proxy cooldown was cleared/);
    await dialog.getByRole('button', { name: 'Done' }).click();
    await dialog.waitFor({ state: 'hidden' });
  }
  assert.equal(
    await app.evaluate(() => global.resetTest.dialogs.length),
    0,
    'Resets never fall back to a native alert',
  );
  console.log(
    'PASS: native and bucket menus open the in-window reset dialog for both providers; closing or cancelling sends no writes; bucket redemption refreshes only the selected account.',
  );
} finally {
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
}
