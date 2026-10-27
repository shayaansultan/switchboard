// Exercises the shipped Caffeinate popover with invented accounts and a
// simulated bridge, then smoke-tests the real Electron/preload/IPC path. No
// test keeps this Mac awake, turns its sleep setting off, or installs the
// system helper.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright';
import * as fixture from './fixture.js';
import { PALETTE } from '../out/store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'docs', '.work', 'caffeinate');
await fs.mkdir(output, { recursive: true });

const decaf = {
  active: false,
  endsAt: null,
  limit: null,
  lid: false,
  lidSupport: 'available',
  helper: 'not-installed',
  sleepDisabledElsewhere: false,
  stop: null,
  notice: null,
  queued: false,
  busy: false,
};
const state = {
  palette: PALETTE,
  desktop: { helper: true, accessibility: 'off' },
  caffeinate: { ...decaf, lidSupport: 'no-bridge', helper: null },
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
    viewport: { width: 760, height: 760 },
    recordVideo: { dir: output, size: { width: 760, height: 760 } },
    deviceScaleFactor: 2,
  });
  await context.addInitScript((initial) => {
    let listener = () => {};
    const calls = [];
    const publish = (next) => {
      initial.caffeinate = next;
      listener(next);
    };
    const noop = async () => {};
    window.__caffeinateTest = { publish, calls, current: () => initial.caffeinate };
    window.sb = {
      getState: async () => initial,
      onState: () => {},
      onFanState: () => {},
      refreshFans: noop,
      onCaffeinateState: (next) => {
        listener = next;
      },
      refreshCaffeinate: noop,
      startCaffeinate: async (minutes, lid) => {
        calls.push(['start', minutes, lid]);
        const now = initial.caffeinate;
        if (lid && now.helper !== 'installed') {
          publish({ ...now, helper: 'needs-approval', queued: true, notice: 'needs-approval' });
          return;
        }
        publish({
          ...now,
          active: true,
          endsAt: minutes ? Date.now() + minutes * 60_000 : null,
          limit: minutes || null,
          lid,
          stop: null,
          notice: null,
        });
      },
      caffeinateAction: async (action) => {
        calls.push([action]);
        const now = initial.caffeinate;
        if (action === 'stop') publish({ ...now, active: false, endsAt: null, limit: null, lid: false });
        if (action === 'extend') publish({ ...now, endsAt: now.endsAt + 60 * 60_000, limit: now.limit + 60 });
        if (action === 'cancel') publish({ ...now, queued: false, notice: null });
        if (action === 'dismiss') publish({ ...now, stop: null, notice: null });
        if (action === 'clear') publish({ ...now, sleepDisabledElsewhere: false });
      },
      refresh: noop,
      saveSettings: noop,
      measureSizes: async () => initial,
    };
    document.addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('div');
      label.textContent = 'UI demo · simulated sleep';
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

  const toggle = page.locator('#caffeinate-toggle');
  const popover = page.locator('#caffeinate-popover');
  const publish = (next) => page.evaluate((s) => window.__caffeinateTest.publish(s), next);
  const current = () => page.evaluate(() => window.__caffeinateTest.current());
  const calls = () => page.evaluate(() => window.__caffeinateTest.calls.slice());
  const text = () => popover.innerText();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const waitText = (t) =>
    page.waitForFunction((x) => document.querySelector('#caffeinate-popover').textContent.includes(x), t);

  // Decaf, with no system bridge (a checkout run): the lid option says why it is off.
  await toggle.waitFor({ state: 'visible' });
  assert.match(await toggle.innerText(), /Decaf/);
  assert.ok((await toggle.boundingBox()).x < (await page.locator('#refresh').boundingBox()).x);
  await toggle.click();
  await popover.waitFor({ state: 'visible' });
  assert.match(await text(), /Decaf: the Mac sleeps as usual/);
  const lidTip = () => popover.locator('.pop-option .info-tip').getAttribute('aria-label');
  assert.match(await lidTip(), /This build has no system helper/);
  assert.doesNotMatch(await text(), /needs no password/);
  assert.equal(await page.getByRole('checkbox', { name: /lid closed/ }).isDisabled(), true);
  assert.equal(await button('Caffeinate for 1 hour').isVisible(), true);
  assert.deepEqual(await calls(), []);

  // A laptop with the helper not yet installed.
  await publish(decaf);
  await page.waitForFunction(() =>
    document.querySelector('.pop-option .info-tip')?.getAttribute('aria-label').includes('Asks once to allow a helper'),
  );
  await page.screenshot({ path: path.join(output, 'decaf.png') });

  // A timed lid-open session: green card, countdown, +1 hour, Decaf now.
  assert.equal(await page.getByRole('checkbox', { name: /screen/ }).count(), 0, 'The screen always stays on');
  await button('Caffeinate for 1 hour').click();
  await waitText('Caffeinated');
  assert.deepEqual((await calls()).at(-1), ['start', 60, false]);
  assert.match(await text(), /The Mac and its screen stay awake/);
  assert.match(await toggle.innerText(), /Caffeinated · 1h/);
  await page.screenshot({ path: path.join(output, 'caffeinated.png') });
  await button('+1 hour').click();
  await waitText('2 h left');
  await button('Decaf now').click();
  await waitText('Decaf: the Mac sleeps as usual');

  // Until I stop, and Custom minutes.
  await page.getByRole('radio', { name: 'Until I stop' }).click();
  await button('Caffeinate until I stop').click();
  await waitText('until you stop');
  assert.equal(await page.locator('#caffeinate-extend').count(), 0);
  await button('Decaf now').click();
  await page.getByRole('radio', { name: 'Custom…' }).click();
  await page.locator('.duration-custom input').fill('90');
  await button('Caffeinate for 90 min').click();
  await waitText('1 h 30 min left');
  await button('Decaf now').click();

  // The first lid-closed session waits for approval, then runs with a lid tag.
  await page.getByRole('radio', { name: '2 hours' }).click();
  await page.getByRole('checkbox', { name: /lid closed/ }).check();
  await button('Caffeinate for 2 hours').click();
  await waitText('It starts once it’s allowed');
  await page.screenshot({ path: path.join(output, 'approval.png') });
  await button('Open Login Items').click();
  assert.deepEqual((await calls()).at(-1), ['login-items']);
  await button('Cancel').click();
  await publish({ ...(await current()), helper: 'installed' });
  await button('Caffeinate for 2 hours').click();
  await waitText('even with the lid closed');
  assert.match(await toggle.innerText(), /· lid/);
  await page.screenshot({ path: path.join(output, 'lid.png') });

  // The helper ends it on its own, and the popover says why.
  await publish({ ...(await current()), active: false, lid: false, endsAt: null, limit: null, stop: 'battery-low' });
  await waitText('Ended because the battery dropped below 20% with the lid closed.');
  await button('Dismiss').click();

  // Sleep left off by an older Keep awake.
  await publish({ ...(await current()), sleepDisabledElsewhere: true });
  await waitText('Sleep is turned off system-wide outside Caffeinate');
  await button('Turn sleep on').click();
  assert.deepEqual((await calls()).at(-1), ['clear']);

  // A desktop Mac: no lid option, lid-open still works.
  await publish({ ...(await current()), lidSupport: 'no-lid' });
  await page.waitForFunction(() =>
    document.querySelector('.pop-option .info-tip')?.getAttribute('aria-label').includes('This Mac has no lid.'),
  );

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(output, 'dark.png') });
  await page.keyboard.press('Escape');
  assert.equal(await popover.isVisible(), false);
  await page.waitForFunction(
    () => document.querySelector('#caffeinate-toggle').getAttribute('aria-expanded') === 'false',
  );

  assert.deepEqual(errors, []);
  await context.close();
  console.log(`Caffeinate checks passed. Screenshots and recording: ${output}`);
} finally {
  await browser.close();
  server.stop();
}

// Launch the real main process and sandboxed preload with an isolated home.
// Only the actual read path and rejected IPC inputs are exercised here.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-caffeinate-smoke-'));
let app;
try {
  // HOME alone does not isolate Keychain. An empty profile store prevents
  // normal startup refresh from attempting any account identity/usage reads.
  await fs.mkdir(path.join(home, '.switchboard'));
  await fs.writeFile(
    path.join(home, '.switchboard', 'profiles.json'),
    JSON.stringify({ settings: fixture.settings, profiles: [] }),
    { mode: 0o600 },
  );
  app = await electron.launch({
    ...(process.argv.includes('--packaged')
      ? {
          executablePath: path.join(
            root,
            'dist',
            `mac-${process.arch}`,
            'Switchboard.app',
            'Contents',
            'MacOS',
            'Switchboard',
          ),
          args: [`--user-data-dir=${path.join(home, 'electron')}`],
        }
      : { args: [root, `--user-data-dir=${path.join(home, 'electron')}`] }),
    env: {
      HOME: home,
      PATH: process.env.PATH || '/usr/bin:/bin',
      TMPDIR: os.tmpdir(),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      // Drive the window without showing it, so a run never takes the screen
      // (src/main.ts). SWITCHBOARD_BACKGROUND=0 shows it, to watch a run.
      SWITCHBOARD_BACKGROUND: process.env.SWITCHBOARD_BACKGROUND ?? '1',
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.sb?.startCaffeinate === 'function');
  await page.evaluate(() => window.sb.refreshCaffeinate());
  const snapshot = await page.evaluate(() => window.sb.getState());
  assert.deepEqual(snapshot.profiles, [], 'Smoke test must not load any accounts');
  assert.equal(snapshot.caffeinate.active, false, 'A fresh start is Decaf');
  assert.equal(typeof snapshot.caffeinate.lidSupport, 'string', 'Real bridge facts must reach the renderer');
  const rejected = await page.evaluate(async () => {
    const tries = [
      () => window.sb.startCaffeinate(-1, false, false),
      () => window.sb.startCaffeinate(60, 'yes', false),
      () => window.sb.caffeinateAction('on; bad'),
    ];
    let refused = 0;
    for (const attempt of tries) {
      try {
        await attempt();
      } catch {
        refused += 1;
      }
    }
    return refused;
  });
  assert.equal(rejected, 3, 'Main process must reject invalid input');
  console.log(`Electron/preload/IPC checks passed. Lid option here: ${snapshot.caffeinate.lidSupport}`);
} finally {
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
}
