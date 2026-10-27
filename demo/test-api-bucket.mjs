// Real Electron form/IPC/readback using only a loopback API and isolated state.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-api-ui-'));
const output = path.join(root, 'docs/.work/api-bucket');
await fs.mkdir(output, { recursive: true });
const credential = path.join(home, 'fixture.env');
await fs.writeFile(credential, 'export FIXTURE_KEY=ui-fixture-secret', { mode: 0o600 });
let responseStatus = 200;
let emptyAccounting = false;
const upstream = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer ui-fixture-secret');
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = responseStatus;
  if (responseStatus !== 200) return res.end(JSON.stringify({ error: 'fixture failure' }));
  if (emptyAccounting && !req.url.endsWith('/models')) return res.end(JSON.stringify({ daily_limit: null }));
  res.end(
    JSON.stringify(
      req.url.endsWith('/models')
        ? {
            data: [
              { id: 'model:exact', context_length: 32768, soclaas: { capabilities: ['chat'] } },
              { id: 'x-test-1' },
            ],
          }
        : {
            policy: { requests_per_minute_limit: 17, daily_microdollar_allowance: 12000000 },
            usage: { current_day_spend: 0 },
          },
    ),
  );
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${upstream.address().port}`;
let app;
const deadline = setTimeout(() => {
  console.error('UI test deadline exceeded');
  process.exit(1);
}, 90000);
try {
  app = await electron.launch({
    recordVideo: { dir: output, size: { width: 900, height: 760 } },
    args: [root, `--user-data-dir=${path.join(home, 'electron')}`],
    env: {
      ...process.env,
      HOME: home,
      SWITCHBOARD_ROOT: path.join(home, '.switchboard'),
      // Drive the window without showing it, so a run never takes the screen
      // (src/main.ts). SWITCHBOARD_BACKGROUND=0 shows it, to watch a run.
      SWITCHBOARD_BACKGROUND: process.env.SWITCHBOARD_BACKGROUND ?? '1',
      SWITCHBOARD_PROXY_BINARY: path.join(os.homedir(), '.switchboard/bin/cliproxyapi-7.3.2/cli-proxy-api'),
    },
  });
  const page = await app.firstWindow();
  await page.locator('#tab-buckets').click();
  await page.getByRole('button', { name: 'Proxy bucket', exact: true }).click();
  await page.locator('#bucket-name').fill('API fixture');
  await page.getByRole('checkbox', { name: 'API upstream', exact: true }).check();
  await page.locator('[name=baseUrl]').fill(base + '/v1');
  await page.locator('[name=credentialFile]').fill(credential);
  await page.locator('[name=credentialVariable]').fill('FIXTURE_KEY');
  await page.locator('[name=budgetUrl]').fill(base + '/budget');
  await page.locator('[name=defaultModel]').fill('model:exact');
  await page.getByRole('button', { name: 'Create bucket', exact: true }).click();
  const panel = page.locator('[data-bucket="api-fixture"]');
  await panel.waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Add account', exact: true }).count(), 0);
  assert.match(await panel.innerText(), /Discovery: ok/);
  assert.match(await panel.innerText(), /not subscription headroom or cash credits/);
  await panel.locator('summary').click();
  assert.match(await panel.innerText(), /x-test-1.*experimental.*mutable/);
  assert.ok(!(await page.content()).includes('ui-fixture-secret'));
  await panel.getByRole('button', { name: 'Refresh bucket', exact: true }).click();
  await page.mouse.move(5, 5);
  await page.screenshot({ path: path.join(output, 'api-bucket.png') });
  const state = await page.evaluate(() => window.sb.getState());
  const bucket = state.buckets.find((b) => b.id === 'api-fixture');
  assert.equal(bucket.upstream.credential.file, credential);
  assert.equal(bucket.api.accounting.values['policy.requests_per_minute_limit'], 17);
  assert.equal(bucket.accounts.length, 0);
  assert.ok(state.profiles.every((p) => !p.proxyBucket));
  const id = await page.evaluate(async () => {
    const added = await window.sb.addProfile({ vendor: 'codex', name: 'API profile' });
    await window.sb.setProxyBucket(added.profile.id, 'api-fixture');
    return added.profile.id;
  });
  emptyAccounting = true;
  await page.evaluate(() => window.sb.bucketAction('api-fixture', 'refresh'));
  await page.locator('#tab-profiles').click();
  const card = page.locator('.card').filter({ has: page.getByText('API profile', { exact: true }) });
  await card.getByText('API key · API fixture bucket', { exact: true }).waitFor();
  assert.equal(await card.getByText('CLI not signed in for this profile').count(), 0);
  assert.equal(await card.getByText('Sign in CLI', { exact: true }).count(), 0);
  assert.equal(await card.locator('.track').count(), 0);
  assert.match(await card.innerText(), /Quota enforcement unknown/);
  assert.match(await card.innerText(), /No accounting limits reported/);
  await card.screenshot({ path: path.join(output, 'api-profile.png') });
  responseStatus = 401;
  await page.evaluate(() => window.sb.bucketAction('api-fixture', 'refresh'));
  await card.getByText('API authentication failed · check the credential', { exact: true }).waitFor();
  assert.equal(await card.getByText('Sign in CLI', { exact: true }).count(), 0);
  const finalState = await page.evaluate(() => window.sb.getState());
  assert.equal(finalState.profiles.find((p) => p.id === id).proxyBucket, 'api-fixture');
  console.log(
    'API profile credential status, unknown limits, no OAuth warnings, auth failure; API form, authenticated discovery, accounting display, mutable labels, refresh and unchanged profile routing passed',
  );
} finally {
  clearTimeout(deadline);
  await app?.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}
