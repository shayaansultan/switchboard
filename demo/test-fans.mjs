// Exercises the shipped Fans popover with invented accounts and a simulated
// system helper. No test installs the helper or changes this Mac's fans.
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
  caffeinate: {
    active: false,
    endsAt: null,
    limit: null,
    screen: false,
    lid: false,
    lidSupport: 'available',
    helper: 'installed',
    sleepDisabledElsewhere: false,
    stop: null,
    notice: null,
    queued: false,
    busy: false,
  },
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
  limit: null,
  queued: false,
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
    const fan = (actual) => ({ actual, minimum: 2317, maximum: 7826, target: actual, manual: false });
    const noop = async () => {};
    window.__fansTest = { publish, calls, current: () => initial.fans };
    window.sb = {
      getState: async () => initial,
      onState: () => {},
      onCaffeinateState: () => {},
      refreshCaffeinate: noop,
      onFanState: (listener) => {
        fanListener = listener;
      },
      refreshFans: noop,
      setFans: async (level, minutes) => {
        calls.push(['set', level, minutes]);
        const fans = initial.fans;
        if (fans.helper !== 'installed') {
          publish({ ...fans, helper: 'needs-approval', notice: 'needs-approval', queued: true });
          return;
        }
        publish({
          ...fans,
          level,
          endsAt: minutes ? Date.now() + minutes * 60_000 : null,
          limit: minutes || null,
          fans: fans.fans.map((f) => ({ ...f, actual: rpm(level), target: rpm(level), manual: true })),
          stop: null,
          notice: null,
          queued: false,
        });
      },
      adjustFans: async (level) => {
        calls.push(['adjust', level]);
        publish({ ...initial.fans, level });
      },
      fanAction: async (action) => {
        calls.push([action]);
        const fans = initial.fans;
        if (action === 'system')
          publish({ ...fans, level: null, endsAt: null, limit: null, fans: [fan(2317), fan(2502)] });
        if (action === 'extend') publish({ ...fans, endsAt: fans.endsAt + 15 * 60_000, limit: fans.limit + 15 });
        if (action === 'cancel') publish({ ...fans, queued: false, notice: null });
        if (action === 'dismiss') publish({ ...fans, stop: null, notice: null });
      },
      refresh: noop,
      saveSettings: noop,
      measureSizes: async () => initial,
    };
    document.addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('div');
      label.textContent = 'UI demo · simulated system helper';
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

  const current = () => page.evaluate(() => window.__fansTest.current());
  const button = (name) => page.getByRole('button', { name, exact: true });
  const waitText = (text) =>
    page.waitForFunction((t) => document.querySelector('#fans-popover').textContent.includes(t), text);

  // A Mac with no fans, or a build that can't control them, shows nothing.
  assert.equal(await toggle.isVisible(), false);
  await publish(system);
  await toggle.waitFor({ state: 'visible' });
  const caffeinateBox = await page.locator('#caffeinate-toggle').boundingBox();
  const fansBox = await toggle.boundingBox();
  assert.ok(caffeinateBox.x < fansBox.x, 'Fans sits after Caffeinate');

  // Idle: who controls the fans, and a boost set-up that changes nothing yet.
  await toggle.click();
  await popover.waitFor({ state: 'visible' });
  assert.match(await text(), /CPU 71 °C/);
  assert.match(await text(), /macOS is controlling the fans/);
  assert.match(await text(), /Fan 1\s+2,317 rpm/);
  assert.match(await text(), /allow it once in Login Items/);
  assert.equal(await button('Set up and boost').isVisible(), true);
  assert.deepEqual(await calls(), []);
  await page.screenshot({ path: path.join(output, 'idle-first.png') });

  // The first boost waits for approval, and can be cancelled.
  await button('Set up and boost').click();
  await waitText('The boost starts once it’s allowed');
  assert.deepEqual((await calls()).at(-1), ['set', 75, 15]);
  await page.screenshot({ path: path.join(output, 'approval.png') });
  await button('Open Login Items').click();
  assert.deepEqual((await calls()).at(-1), ['login-items']);
  await button('Cancel').click();
  await waitText('macOS is controlling the fans');

  // Allowed: a timed boost is a warm card with a countdown.
  await publish({ ...(await current()), helper: 'installed', notice: null });
  await button('Boost for 15 min').click();
  await waitText('Boosting at 75%');
  assert.match(await text(), /15 min left/);
  assert.match(await toggle.innerText(), /Fans · 75% · 15m/);
  assert.match(await text(), /6,449 rpm/);
  await page.screenshot({ path: path.join(output, 'boosting.png') });

  // Speed applies on release without resetting the time; +15 adds time.
  await page.locator('#fans-level').fill('80');
  await page.waitForFunction(() => document.querySelector('#fans-toggle').textContent.includes('80%'));
  assert.deepEqual((await calls()).at(-1), ['adjust', 80]);
  await button('+15 min').click();
  await waitText('30 min left');
  await button('Stop boost').click();
  await waitText('macOS is controlling the fans');
  assert.deepEqual((await calls()).at(-1), ['system']);

  // Until I stop: no countdown and no +15.
  await page.getByRole('radio', { name: 'Until I stop' }).click();
  await button('Boost until I stop').click();
  await waitText('until you stop');
  assert.equal(await page.locator('#fans-extend').count(), 0);
  assert.deepEqual((await calls()).at(-1), ['set', 80, 0], 'The next boost keeps the last speed');
  await page.screenshot({ path: path.join(output, 'boosting-until.png') });
  await button('Stop boost').click();
  await waitText('macOS is controlling the fans');

  // Custom: a minutes field, and the button repeats the time back.
  await page.getByRole('radio', { name: 'Custom…' }).click();
  await page.locator('.duration-custom input').fill('45');
  await button('Boost for 45 min').click();
  await waitText('45 min left');
  assert.deepEqual((await calls()).at(-1), ['set', 80, 45]);

  // The helper ends a boost on its own, and the popover says why.
  await publish({ ...(await current()), level: null, endsAt: null, limit: null, stop: 'sleep' });
  await waitText('Boost ended because the Mac went to sleep.');
  await page.screenshot({ path: path.join(output, 'ended.png') });
  await button('Dismiss').click();
  await page.waitForFunction(() => !document.querySelector('#fans-popover').textContent.includes('went to sleep'));

  // Another app holding the fans: boosting is off until it lets go.
  await publish({ ...(await current()), notice: 'already-controlled' });
  await waitText('Another app is controlling the fans');
  assert.equal(await page.locator('#fans-boost').isDisabled(), true);
  assert.equal(await button('Check again').isVisible(), true);

  // A boost the fans refused offers a retry.
  await publish({ ...(await current()), notice: 'control-failed' });
  await waitText('macOS kept control');
  assert.equal(await button('Try again').isVisible(), true);

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(output, 'popover-dark.png') });
  await page.keyboard.press('Escape');
  assert.equal(await popover.isVisible(), false);
  await page.waitForFunction(() => document.querySelector('#fans-toggle').getAttribute('aria-expanded') === 'false');

  assert.deepEqual(errors, []);
  await context.close();
  console.log(`Fans checks passed. Screenshots and recording: ${output}`);
} finally {
  await browser.close();
  server.stop();
}
