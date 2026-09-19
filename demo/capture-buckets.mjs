// Records the shipped renderer with clearly labeled, invented account data.
// No local accounts, credentials, desktop apps or external services are touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { PALETTE } from '../out/store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'docs', '.work', 'bucket-pr-demo');
await fs.mkdir(output, { recursive: true });
const reset = new Date(Date.now() + 3 * 86400000).toISOString();
const profiles = ['Work', 'Personal'].map((name, index) => ({
  id: `codex-${name.toLowerCase()}`,
  vendor: 'codex',
  name,
  isDefault: false,
  color: PALETTE[index + 1],
  running: false,
  identity: { loggedIn: true, email: `Demo account ${index + 1}`, plan: 'Pro' },
  usage: { windows: [{ label: '7d', pct: index ? 18 : 48, resetsAt: reset }] },
  dirs: { home: `~/.switchboard/codex/${name.toLowerCase()}/home`, isDefault: false },
  cli: `CODEX_HOME='~/.switchboard/codex/${name.toLowerCase()}/home' codex`,
}));
const state = {
  palette: PALETTE,
  awake: { status: 'ready', value: 'off', notice: null },
  settings: { terminal: 'Terminal', pollMinutes: 5, usageMode: 'used', appearance: 'light' },
  terminals: [{ id: 'Terminal', label: 'Terminal' }],
  setupItems: { claude: [], codex: [] },
  vendors: { claude: { label: 'Claude', installed: true }, codex: { label: 'Codex', installed: true } },
  profiles,
  buckets: [
    {
      id: 'team',
      name: 'Team',
      status: 'running',
      accounts: [
        {
          name: 'demo-chatgpt',
          email: 'Demo ChatGPT account',
          provider: 'codex',
          status: 'fresh',
          weight: 52,
          windows: [{ label: '7d', pct: 48, resetsAt: reset }],
        },
        {
          name: 'demo-claude',
          email: 'Demo Claude account',
          provider: 'claude',
          status: 'fresh',
          weight: 74,
          windows: [
            { label: '5h', pct: 12, resetsAt: reset },
            { label: '7d', pct: 26, resetsAt: reset },
          ],
        },
      ],
    },
  ],
};
const files = new Map(
  await Promise.all(
    ['index.html', 'style.css', 'renderer.js', 'awake.js'].map(async (name) => [
      `/${name}`,
      await fs.readFile(path.join(root, 'out', 'renderer', name)),
    ]),
  ),
);
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const name = new URL(request.url).pathname;
    const content = files.get(name === '/' ? '/index.html' : name);
    return new Response(content ?? 'Not found', {
      status: content ? 200 : 404,
      headers: {
        'Content-Type': name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html',
      },
    });
  },
});
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const context = await browser.newContext({
    viewport: { width: 920, height: 800 },
    recordVideo: { dir: output, size: { width: 920, height: 800 } },
    deviceScaleFactor: 2,
  });
  await context.addInitScript((initial) => {
    let listener = () => {};
    const publish = () => listener(structuredClone(initial));
    const noop = async () => {};
    const windows = new Map(initial.buckets[0].accounts.map((account) => [account.name, account.windows]));
    window.sb = {
      getState: async () => initial,
      onState: (fn) => {
        listener = fn;
      },
      onAwakeState: () => {},
      refreshAwake: noop,
      setAwake: noop,
      measureSizes: async () => initial,
      refresh: async () => initial,
      setProxyBucket: async (id, bucket) => {
        initial.profiles.find((p) => p.id === id).proxyBucket = bucket ?? undefined;
        publish();
      },
      createBucket: noop,
      bucketAction: noop,
      setBucketAccount: async (_id, name, enabled) => {
        const account = initial.buckets[0].accounts.find((a) => a.name === name);
        account.status = enabled ? 'fresh' : 'disabled';
        account.windows = enabled ? windows.get(name) : [];
        publish();
      },
      addProfile: noop,
      removeProfile: noop,
      updateProfile: noop,
      moveProfile: noop,
      bringOver: noop,
      saveSettings: noop,
      launch: noop,
      quit: noop,
      quitOthers: noop,
      login: noop,
      shell: noop,
      reveal: noop,
      copyCommand: noop,
    };
    document.addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('div');
      label.textContent = 'Demo data · simulated accounts';
      label.style.cssText =
        'position:fixed;bottom:10px;right:10px;z-index:20;padding:5px 9px;border-radius:4px;background:#1d1d1b;color:#fff;font:12px system-ui;pointer-events:none';
      document.body.append(label);
    });
  }, state);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.getByLabel('Model connection for Work').waitFor();
  await page.waitForTimeout(1500);
  await page.getByLabel('Model connection for Work').selectOption('team');
  await page.getByLabel('Model connection for Work').blur();
  await page.getByText('Selected bucket → Team', { exact: true }).waitFor();
  await page.getByLabel('Model connection for Work').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(output, 'proxy-assigned.png') });
  await page.locator('#proxy-buckets > summary').scrollIntoViewIfNeeded();
  await page.locator('#proxy-buckets > summary').click();
  await page.locator('[data-bucket="team"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Add account ▾', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add Claude account' }).waitFor();
  await page.waitForTimeout(2000);
  await page.keyboard.press('Escape');
  await page.getByText('Manage accounts', { exact: true }).click();
  await page.getByRole('button', { name: 'Disable', exact: true }).last().click();
  await page.getByRole('button', { name: 'Enable', exact: true }).waitFor();
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.waitForTimeout(1200);
  await page.locator('#proxy-buckets > summary').click();
  await page.getByLabel('Model connection for Work').selectOption('');
  await page.getByLabel('Model connection for Work').blur();
  await page.waitForTimeout(1600);
  assert.deepEqual(errors, []);
  await context.close();
  const video = await page.video().path();
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    video,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-y',
    path.join(output, 'proxy-buckets.mp4'),
  ]);
  console.log(`Demo captured: ${path.join(output, 'proxy-buckets.mp4')}`);
} finally {
  await browser.close();
  server.stop();
}
