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
const upstream = http.createServer((req, res) => {
  assert.equal(req.headers.authorization, 'Bearer ui-fixture-secret');
  res.setHeader('Content-Type', 'application/json');
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
  console.log(
    'API form, authenticated discovery, accounting display, mutable labels, refresh and unchanged profile routing passed',
  );
} finally {
  clearTimeout(deadline);
  await app?.close();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(home, { recursive: true, force: true });
}
