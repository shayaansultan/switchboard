// Exercises the shipped Fans popover with invented accounts and a simulated
// fan helper. No test installs the helper or changes this Mac's fans.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import * as fixture from './fixture.js';
import { PALETTE } from '../out/store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'docs', '.work', 'fans');
await fs.mkdir(output, { recursive: true });

const fan = (actual) => ({ actual, minimum: 2317, maximum: 7826, target: actual, manual: false });
const state = {
  palette: PALETTE,
  desktop: { helper: true, accessibility: 'off' },
  awake: { status: 'ready', value: 'off', notice: null },
  fans: { status: 'unavailable', reason: 'no-fans' },
  settings: fixture.settings,
  terminals: fixture.terminals,
  vendors: fixture.vendors,
  setupItems: { claude: [], codex: [] },
  profiles: fixture.profiles.map((profile) => ({
    ...profile,
    dirs: { home: '~/.switchboard/example', isDefault: profile.isDefault },
    cli: profile.vendor,
  })),
};
const system = {
  status: 'ready',
  helper: 'not-installed',
  fans: [fan(2317), fan(2502)],
  temperature: 71.4,
  level: null,
  endsAt: null,
  stop: null,
  notice: null,
  busy: false,
};

const files = new Map(
  await Promise.all(
    ['index.html', 'style.css', 'main.js'].map(async (name) => [
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
    const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html';
    return new Response(content ?? 'Not found', { status: content ? 200 : 404, headers: { 'Content-Type': type } });
  },
});

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const context = await browser.newContext({
    viewport: { width: 760, height: 720 },
    recordVideo: { dir: output, size: { width: 760, height: 720 } },
    deviceScaleFactor: 2,
  });
  await context.addInitScript((initial) => {
    let fanListener = () => {};
    const calls = [];
    const publish = (fans) => {
      initial.fans = fans;
      fanListener(fans);
    };
    const rpm = (level) => Math.round(2317 + (7826 - 2317) * (level / 100));
    const noop = async () => {};
    window.__fansTest = { publish, calls, current: () => initial.fans };
    window.sb = {
      getState: async () => initial,
      onState: () => {},
      onAwakeState: () => {},
      refreshAwake: noop,
      setAwake: noop,
      onFanState: (listener) => {
        fanListener = listener;
      },
      refreshFans: noop,
      setFans: async (level, minutes) => {
        calls.push(['set', level, minutes]);
        const fans = initial.fans;
        if (fans.helper !== 'installed') {
          publish({ ...fans, helper: 'needs-approval', notice: 'needs-approval' });
          return;
        }
        publish({
          ...fans,
          level,
          endsAt: minutes ? Date.now() + minutes * 60_000 : null,
          fans: fans.fans.map((f) => ({ ...f, actual: rpm(level), target: rpm(level), manual: true })),
          stop: null,
          notice: null,
        });
      },
      fanAction: async (action) => {
        calls.push([action]);
        const fans = initial.fans;
        if (action === 'system')
          publish({
            ...fans,
            level: null,
            endsAt: null,
            fans: [
              { ...fans.fans[0], actual: 2317, manual: false },
              { ...fans.fans[1], actual: 2502, manual: false },
            ],
          });
        if (action === 'dismiss') publish({ ...fans, stop: null, notice: null });
      },
      refresh: noop,
      saveSettings: noop,
      measureSizes: async () => initial,
    };
    document.addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('div');
      label.textContent = 'UI demo · simulated fan helper';
      label.style.cssText =
        'position:fixed;bottom:8px;right:8px;z-index:20;padding:4px 8px;border-radius:4px;background:#1d1d1b;color:#fff;font:11px system-ui;pointer-events:none';
      document.body.append(label);
    });
  }, state);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.waitForSelector('.card');

  const toggle = page.locator('#fans-toggle');
  const popover = page.locator('#fans-popover');
  const publish = (fans) => page.evaluate((next) => window.__fansTest.publish(next), fans);
  const calls = () => page.evaluate(() => window.__fansTest.calls.slice());
  const text = () => popover.innerText();

  // A Mac with no fans, or a build that can't control them, shows nothing.
  assert.equal(await toggle.isVisible(), false);
  await publish(system);
  await toggle.waitFor({ state: 'visible' });
  const awakeBox = await page.locator('#awake-toggle').boundingBox();
  const fansBox = await toggle.boundingBox();
  assert.ok(awakeBox.x < fansBox.x, 'Fans sits after Keep awake');

  // System: speeds and temperature, nothing held.
  await toggle.click();
  await popover.waitFor({ state: 'visible' });
  assert.match(await text(), /CPU 71 °C/);
  assert.match(await text(), /macOS is choosing fan speeds/);
  assert.match(await text(), /Fan 1\s+2,317 rpm/);
  assert.match(await text(), /allow it once in Login Items/);
  assert.equal(await page.getByRole('radio', { name: 'System' }).getAttribute('aria-checked'), 'true');
  await page.screenshot({ path: path.join(output, 'popover-system.png') });

  // The first Manual installs the helper and sends the user to Login Items.
  await page.getByRole('radio', { name: 'Manual' }).click();
  await page.waitForFunction(() => document.querySelector('#fans-notice')?.textContent.includes('Login Items'));
  assert.equal(await page.getByRole('button', { name: 'Open Login Items' }).isVisible(), true);
  await page.screenshot({ path: path.join(output, 'popover-approval.png') });
  await page.getByRole('button', { name: 'Open Login Items' }).click();
  assert.deepEqual((await calls()).at(-1), ['login-items']);

  // Approved: Manual holds the slider's speed for the default 15 minutes.
  await publish({ ...(await page.evaluate(() => window.__fansTest.current())), helper: 'installed', notice: null });
  await page.getByRole('radio', { name: 'Manual' }).click();
  await page.waitForFunction(() => document.querySelector('#fans-toggle').textContent.includes('60%'));
  assert.match(await text(), /Held at 60%\. Back to System in 15 min\./);
  assert.match(await text(), /5,622 rpm/);
  assert.deepEqual((await calls()).at(-1), ['set', 60, 15]);
  await page.screenshot({ path: path.join(output, 'popover-manual.png') });

  // Moving the slider re-applies on release; a new limit re-applies too.
  await page.locator('#fans-level').fill('80');
  await page.waitForFunction(() => document.querySelector('#fans-toggle').textContent.includes('80%'));
  assert.deepEqual((await calls()).at(-1), ['set', 80, 15]);
  await page.locator('#fans-minutes').selectOption('0');
  await page.waitForFunction(() =>
    document.querySelector('#fans-popover').textContent.includes('until you choose System'),
  );
  assert.deepEqual((await calls()).at(-1), ['set', 80, 0]);

  // The helper hands the fans back on its own and the popover says why.
  await publish({
    ...(await page.evaluate(() => window.__fansTest.current())),
    level: null,
    endsAt: null,
    stop: 'sleep',
  });
  await page.waitForFunction(() => document.querySelector('#fans-popover').textContent.includes('went to sleep'));
  assert.equal(await page.getByRole('radio', { name: 'System' }).getAttribute('aria-checked'), 'true');
  assert.doesNotMatch(await toggle.innerText(), /%/);
  await page.screenshot({ path: path.join(output, 'popover-stopped.png') });
  await page.getByRole('button', { name: 'Dismiss' }).click();
  await page.waitForFunction(() => !document.querySelector('#fans-popover').textContent.includes('went to sleep'));

  // Choosing System while held hands the fans back.
  await page.getByRole('radio', { name: 'Manual' }).click();
  await page.waitForFunction(() => document.querySelector('#fans-toggle').textContent.includes('%'));
  await page.getByRole('radio', { name: 'System' }).click();
  await page.waitForFunction(() => !document.querySelector('#fans-toggle').textContent.includes('%'));
  assert.deepEqual((await calls()).at(-1), ['system']);

  // Another app holding the fans.
  await publish({ ...(await page.evaluate(() => window.__fansTest.current())), notice: 'already-controlled' });
  assert.match(await text(), /Another app is controlling the fans/);

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(output, 'popover-dark.png') });
  await page.keyboard.press('Escape');
  assert.equal(await popover.isVisible(), false);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');

  assert.deepEqual(errors, []);
  await context.close();
  console.log(`Fans checks passed. Screenshots and recording: ${output}`);
} finally {
  await browser.close();
  server.stop();
}
