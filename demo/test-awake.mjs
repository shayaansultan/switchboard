// Exercises the shipped renderer with invented accounts and a simulated macOS
// boundary, then smoke-tests real Electron/preload/IPC with read-only pmset.
// No test authorizes or changes this Mac's sleep setting.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright';
import * as fixture from './fixture.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'docs', '.work', 'awake');
await fs.mkdir(output, { recursive: true });

const state = {
  awake: { status: 'ready', value: 'off', notice: null },
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
    const type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'text/html';
    return new Response(content ?? 'Not found', { status: content ? 200 : 404, headers: { 'Content-Type': type } });
  },
});

const browser = await chromium.launch({ channel: 'chrome' });
try {
  const context = await browser.newContext({
    viewport: { width: 760, height: 640 },
    recordVideo: { dir: output, size: { width: 760, height: 640 } },
    deviceScaleFactor: 2,
  });
  await context.addInitScript((initial) => {
    let awakeListener = () => {};
    let appListener = () => {};
    let outcome = 'success';
    let failNextRefresh = false;
    const publish = (awake) => {
      initial.awake = awake;
      awakeListener(awake);
    };
    const noop = async () => {};
    window.__awakeTest = {
      publish,
      staleSnapshot: () => appListener({ ...initial, awake: { status: 'checking' } }),
      outcome: (next) => {
        outcome = next;
      },
      failRefresh: () => {
        failNextRefresh = true;
      },
    };
    window.sb = {
      getState: async () => initial,
      onState: (listener) => {
        appListener = listener;
      },
      onAwakeState: (listener) => {
        awakeListener = listener;
      },
      refreshAwake: async (reason) => {
        if (failNextRefresh) {
          failNextRefresh = false;
          throw new Error('Simulated IPC interruption');
        }
        if (reason === 'recheck' && initial.awake.status === 'ready') publish({ ...initial.awake, notice: null });
      },
      setAwake: async (target) => {
        const previous = initial.awake.status === 'ready' ? initial.awake.value : 'off';
        publish({ status: 'changing', target, lastKnown: previous });
        // Visible delay represents macOS authorization, not a production timer.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        publish({
          status: 'ready',
          value: outcome === 'success' ? target : previous,
          notice: outcome === 'success' ? null : outcome,
        });
      },
      refresh: noop,
      addProfile: noop,
      removeProfile: noop,
      updateProfile: noop,
      bringOver: noop,
      saveSettings: noop,
      launch: noop,
      quit: noop,
      quitOthers: noop,
      login: noop,
      shell: noop,
      reveal: noop,
      copyCommand: noop,
      measureSizes: async () => initial,
    };
    document.addEventListener('DOMContentLoaded', () => {
      const label = document.createElement('div');
      label.textContent = 'UI demo · simulated macOS changes';
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
  await page.screenshot({ path: path.join(output, 'header-off.png') });

  const awake = page.locator('#awake-toggle');
  const change = page.locator('#awake-change');
  const status = page.locator('#awake-status');
  const open = () => awake.click();
  const waitStatus = (text) =>
    page.waitForFunction((expected) => document.querySelector('#awake-status').textContent.includes(expected), text);

  // Position, on/off transitions and keyboard dismissal.
  const awakeBox = await awake.boundingBox();
  const refreshBox = await page.locator('#refresh').boundingBox();
  assert.ok(awakeBox.x + awakeBox.width <= refreshBox.x, 'Awake control must precede Refresh');
  await open();
  await waitStatus('Off');
  await page.screenshot({ path: path.join(output, 'popover-off.png') });
  // Presentation holds make the recorded states readable; assertions above
  // and below still wait for the actual state transitions.
  await page.waitForTimeout(1_000);
  await change.click();
  await waitStatus('Waiting for macOS');
  assert.equal(await change.isDisabled(), true);
  await waitStatus('On ·');
  await page.waitForFunction(() => !document.querySelector('#awake-change').disabled);
  assert.match(await awake.innerText(), /Awake/);
  await page.evaluate(() => window.__awakeTest.staleSnapshot());
  assert.match(await status.innerText(), /^On/, 'A late application snapshot must not overwrite newer awake state');
  await page.screenshot({ path: path.join(output, 'popover-on.png') });
  await page.waitForTimeout(1_500);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#awake-popover').isVisible(), false);
  assert.equal(await awake.getAttribute('aria-expanded'), 'false');

  // An external on value is reflected without a local saved toggle.
  await page.evaluate(() => window.__awakeTest.publish({ status: 'ready', value: 'on', notice: null }));
  await open();
  assert.equal(await change.innerText(), 'Turn off');
  await change.click();
  await waitStatus('Off ·');
  await page.waitForFunction(() => !document.querySelector('#awake-change').disabled);

  // Reopening after a transient IPC error must clear that stale error even if
  // the system value is unchanged and therefore produces no state push.
  await awake.click();
  await page.evaluate(() => window.__awakeTest.failRefresh());
  await open();
  await page.waitForFunction(() => !document.querySelector('#awake-error').hidden);
  await awake.click();
  await open();
  await page.waitForFunction(() => document.querySelector('#awake-error').hidden, null, { timeout: 3000 });

  // Cancellation can be retried, and explicit Check again clears the notice.
  await page.evaluate(() => window.__awakeTest.outcome('cancelled'));
  await change.click();
  await page.waitForFunction(() => document.querySelector('#awake-notice').textContent.includes('cancelled'));
  assert.match(await status.innerText(), /^Off/);
  await page.waitForTimeout(1_000);
  await page.locator('#awake-retry').click();
  await page.waitForFunction(() => document.querySelector('#awake-notice').hidden);

  // Read failure is unknown, with an explicit off recovery action.
  await page.evaluate(() => window.__awakeTest.publish({ status: 'unavailable', lastKnown: 'on' }));
  assert.match(await status.innerText(), /Last checked: on/);
  assert.match(await awake.innerText(), /\?/);
  assert.equal(await change.innerText(), 'Turn off');
  await page.screenshot({ path: path.join(output, 'popover-unknown.png') });

  // Light/dark and the real window's minimum width must fit the popover.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 560, height: 420 });
  await page.evaluate(() => window.__awakeTest.publish({ status: 'ready', value: 'on', notice: null }));
  const popoverBox = await page.locator('#awake-popover').boundingBox();
  assert.ok(popoverBox.x >= 0 && popoverBox.x + popoverBox.width <= 560);
  assert.ok(popoverBox.y + popoverBox.height <= 420);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'dark-minimum.png') });
  assert.deepEqual(errors, []);
  await context.close();
  console.log(`Renderer checks passed. Recording: ${await page.video().path()}`);
} finally {
  await browser.close();
  server.stop();
}

// Launch the real main process and sandboxed preload with an isolated home.
// Only the actual read path and rejected IPC inputs are exercised here.
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switchboard-awake-smoke-'));
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
    },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => typeof window.sb?.setAwake === 'function');
  await page.evaluate(() => window.sb.refreshAwake());
  const snapshot = await page.evaluate(() => window.sb.getState());
  assert.deepEqual(snapshot.profiles, [], 'Smoke test must not load any accounts');
  assert.equal(snapshot.awake.status, 'ready', 'Real pmset read must reach the renderer');
  const rejected = await page.evaluate(async () => {
    try {
      await window.sb.setAwake('on; invalid');
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejected, true, 'Main process must reject invalid input before authorization');
  console.log(`Electron/preload/IPC checks passed. Actual sleep setting: ${snapshot.awake.value}`);
} finally {
  await app?.close();
  await fs.rm(home, { recursive: true, force: true });
}
