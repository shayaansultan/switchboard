// Phone access, end to end in the real app: the main process starts the hub
// from the phoneAccess setting, the Settings dialog pairs a phone, and the
// paired phone reads a session the Codex profile's files describe. Runs with
// an isolated HOME and one non-default Codex profile, whose sign-in is a
// file, so nothing touches this Mac's keychain or real profiles.
//
// The profile's ChatGPT is a stand-in process named like the app, with the
// profile's folder and no phone hook, as an app opened from the Dock looks:
// the window and the phone offer to relaunch it (src/remote/reach.ts). Nothing
// here presses the relaunch itself, which would quit the stand-in.
//
// Leaves screenshots of the Settings section and the phone app in
// docs/.work/phone/.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright';
import * as fixture from './fixture.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, 'docs', '.work', 'phone');
await fs.mkdir(output, { recursive: true });

const port = 47000 + Math.floor(Math.random() * 900);
// Under /tmp rather than macOS's long per-user temp folder: the control
// socket inside it must fit the 104-byte limit on a Unix socket's path.
const home = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'sb-phone-'));
const codexHome = path.join(home, '.switchboard', 'codex', 'codex-demo', 'home');
await fs.mkdir(path.join(home, '.switchboard'), { recursive: true });
await fs.writeFile(
  path.join(home, '.switchboard', 'profiles.json'),
  JSON.stringify({
    settings: { ...fixture.settings, phoneAccess: true, phonePort: port },
    profiles: [{ id: 'codex-demo', vendor: 'codex', name: 'Demo', isDefault: false, color: '#3b82f6' }],
  }),
  { mode: 0o600 },
);

// A thread mid-turn, written as the desktop app writes one.
const now = new Date();
const day = path.join(
  codexHome,
  'sessions',
  String(now.getFullYear()),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
);
await fs.mkdir(day, { recursive: true });
const records = [
  { type: 'session_meta', payload: { id: 'thread-1', cwd: '/Users/demo/Developer/shop', originator: 'Codex Desktop' } },
  { type: 'event_msg', payload: { type: 'task_started' } },
  {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: { type: 'UserMessage', content: [{ type: 'text', text: 'Add a dark mode toggle to the settings page' }] },
    },
  },
  {
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['bun', 'test'], exit_code: 0 } },
  },
  {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        content: [{ type: 'Text', text: 'Tests pass. Wiring the toggle into the header next.' }],
      },
    },
  },
];
await fs.writeFile(
  path.join(day, 'rollout-2026-10-18T01-00-00-thread-1.jsonl'),
  records.map((r) => JSON.stringify(r)).join('\n') + '\n',
);
await fs.writeFile(
  path.join(codexHome, 'session_index.jsonl'),
  JSON.stringify({ id: 'thread-1', thread_name: 'Dark mode toggle' }) + '\n',
);

// A POST to the control socket, as the Codex tap makes one.
function post(socket, route, body, timeout) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { socketPath: socket, path: route, method: 'POST', timeout, headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(JSON.parse(text || '{}')));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}

async function assertCount(locator, n) {
  for (let i = 0; i < 100 && (await locator.count()) !== n; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await locator.count(), n);
}

// Not a system binary: macOS hides the environment of its own, and the hook
// is read from the environment.
const standIn = spawn(
  process.execPath,
  [
    '-e',
    'setTimeout(() => {}, 600000)',
    `--user-data-dir=${path.join(home, '.switchboard', 'codex', 'codex-demo', 'desktop')}`,
  ],
  { argv0: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', env: { HOME: home }, stdio: 'ignore' },
);

const base = `http://127.0.0.1:${port}`;
async function waitForHub() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the hub never answered');
}

let app;
try {
  app = await electron.launch({
    args: [root, `--user-data-dir=${path.join(home, 'electron')}`],
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
  await waitForHub();

  // Pair from the window, as a person would.
  await page.locator('#tab-phone').click();
  await page.locator('#pair-phone').click();
  const code = await page.locator('.pair-code').textContent();
  assert.match(code ?? '', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  await page.locator('.phone-tab').screenshot({ path: path.join(output, 'phone-tab.png') });

  // The stand-in shows as an app the phone can only watch.
  await page.locator('.phone-reach li').filter({ hasText: 'Demo' }).waitFor({ timeout: 15000 });
  // Default Claude from the Dock: the switch writes the two entries into this
  // home's ~/.claude/settings.json, and takes them out again.
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  await fs.mkdir(path.dirname(claudeSettings), { recursive: true });
  await fs.writeFile(claudeSettings, JSON.stringify({ theme: 'dark' }));
  await page.locator('.phone-default-claude .switch').click();
  await page.locator('input[name=phoneDefaultClaude]:checked').waitFor({ state: 'attached' });
  const linked = JSON.parse(await fs.readFile(claudeSettings, 'utf8'));
  assert.equal(linked.theme, 'dark');
  assert.match(linked.env.CLAUDE_CODE_PLUGIN_DIRS, /switchboard-remote$/);
  assert.equal(linked.env.SWITCHBOARD_CONTROL_SOCKET, path.join(home, '.switchboard', 'remote', 'control.sock'));
  await page.locator('.phone-main').screenshot({ path: path.join(output, 'phone-tab-reach.png') });
  await page.locator('.phone-default-claude .switch').click();
  await page.locator('input[name=phoneDefaultClaude]:not(:checked)').waitFor({ state: 'attached' });
  assert.deepEqual(JSON.parse(await fs.readFile(claudeSettings, 'utf8')), { theme: 'dark' });

  // The phone pairs itself from the link, and keeps the hub's cookie.
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const phone = await context.newPage();
    await phone.goto(`http://localhost:${port}/#pair=${code}`);
    await phone.locator('#name').fill('Test phone');
    await phone.getByRole('button', { name: 'Pair' }).click();
    await phone.getByText('Dark mode toggle').first().waitFor();
    const [cookie] = await context.cookies();
    assert.equal(cookie?.name, 'sb_device');
    assert.equal(cookie.httpOnly, true);
    assert.equal(await phone.evaluate(() => document.cookie), '');
    await phone.screenshot({ path: path.join(output, 'phone-home.png') });

    // The same data through the API, as the paired phone.
    const api = (route, input) =>
      context.request
        .get(
          `http://localhost:${port}/api/trpc/${route}` +
            (input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''),
        )
        .then((r) => r.json())
        .then((r) => r.result.data);
    const overview = await api('overview');
    assert.deepEqual(
      overview.sessions.map((s) => [s.profileId, s.title, s.state]),
      [['codex-demo', 'Dark mode toggle', 'working']],
    );
    const transcript = await api('session', { profileId: 'codex-demo', sessionId: 'thread-1' });
    assert.deepEqual(
      transcript.entries.map((e) => e.kind),
      ['message', 'steps', 'message'],
    );

    await phone
      .getByRole('link', { name: /Dark mode toggle/ })
      .first()
      .click();
    await phone.getByRole('heading', { name: 'Dark mode toggle' }).waitFor();
    await phone.getByText('Tests pass. Wiring the toggle into the header next.').waitFor();
    // Tool steps fold into one row that opens to the command.
    await phone.getByRole('button', { name: /1 step · 1 shell/ }).click();
    await phone.getByText('bun test').waitFor();
    // Accounts and Settings.
    await phone.goto(`http://localhost:${port}/#/accounts`);
    await phone.getByRole('heading', { name: 'Accounts' }).waitFor();
    await phone.screenshot({ path: path.join(output, 'phone-accounts.png') });
    await phone.goto(`http://localhost:${port}/#/settings`);
    await phone.getByRole('heading', { name: 'Settings' }).waitFor();
    await phone.getByText('Test phone').waitFor();
    await phone.screenshot({ path: path.join(output, 'phone-settings.png') });

    // Notifications. This browser has no push service, so a subscription is
    // stood in on both sides, the Mac's record of it and the browser's own,
    // with the permission it would need.
    const endpoint = 'https://push.example.com/demo';
    await context.request.post(`http://localhost:${port}/api/trpc/push.subscribe`, {
      data: { subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } },
    });
    // Headless Chromium also answers "denied" for notifications.
    await phone.addInitScript((endpoint) => {
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
      PushManager.prototype.getSubscription = async () => ({
        endpoint,
        unsubscribe: async () => true,
        toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
      });
    }, endpoint);
    await phone.reload();
    const allSessions = phone.getByRole('switch', { name: 'All sessions' });
    await allSessions.waitFor();
    // Desktop sessions only until the phone asks for more.
    assert.equal((await api('push.state')).prefs.allSessions, false);
    assert.equal(await allSessions.getAttribute('aria-checked'), 'false');
    await allSessions.click();
    for (let i = 0; i < 50 && !(await api('push.state')).prefs.allSessions; i++) await phone.waitForTimeout(100);
    assert.equal((await api('push.state')).prefs.allSessions, true);
    // Only the section: the rest of Settings names this Mac.
    await phone
      .locator('section', { has: phone.getByRole('switch', { name: 'All sessions' }) })
      .screenshot({ path: path.join(output, 'phone-notifications.png') });
    await phone.goto(`http://localhost:${port}/#/s/codex-demo/thread-1`);
    await phone.getByText('Tests pass. Wiring the toggle into the header next.').waitFor();
    await phone.screenshot({ path: path.join(output, 'phone-session.png') });
    // The app is running without the hook: the reply box offers a relaunch,
    // and asks before it quits anything.
    await phone.getByText('ChatGPT was opened outside Switchboard, so the phone can only watch it.').waitFor();
    await phone.screenshot({ path: path.join(output, 'phone-watch-only.png') });
    await phone.getByRole('button', { name: 'Relaunch ChatGPT for phone control' }).click();
    await phone.getByText('Quit ChatGPT and open it again? Anything it is running now stops.').waitFor();
    await phone.screenshot({ path: path.join(output, 'phone-relaunch.png') });
    await phone.getByRole('button', { name: 'Cancel' }).click();

    // Pictures into a reply. A stand-in for the Codex app's tap polls the
    // control socket, so the session is reachable, and collects the reply.
    const socket = path.join(home, '.switchboard', 'remote', 'control.sock');
    await fs.access(socket);
    const received = [];
    let tapping = true;
    const tap = (async () => {
      while (tapping) {
        const out = await post(socket, '/codex/poll', { profileId: 'codex-demo' }, 5000).catch(() => null);
        if (!out) await new Promise((r) => setTimeout(r, 200));
        received.push(...(out?.commands ?? []));
      }
    })();
    const reply = phone.getByRole('textbox', { name: 'Reply' });
    await reply.waitFor({ timeout: 15000 });
    const thumbs = phone.locator('form img[alt^="Pasted "]');
    // A screenshot pasted into the reply box: named, not "image.png".
    await reply.evaluate((el) => {
      const data = new DataTransfer();
      const png = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
        (c) => c.charCodeAt(0),
      );
      data.items.add(new File([png], 'image.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await thumbs.first().waitFor();
    // The attach menu's Paste reads a picture straight from the clipboard.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` });
    await phone.evaluate(async () => {
      const png = await (await fetch('icons/icon-192.png')).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    });
    await phone.getByRole('button', { name: 'Attach pictures or files' }).click();
    await phone.getByRole('menuitem', { name: 'Paste from clipboard' }).waitFor();
    await phone.screenshot({ path: path.join(output, 'phone-attach-menu.png') });
    await phone.getByRole('menuitem', { name: 'Paste from clipboard' }).click();
    await assertCount(thumbs, 2);
    // A file dropped on the reply box, as on an iPad.
    await reply.evaluate((el) => {
      const data = new DataTransfer();
      data.items.add(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await phone.getByText('notes.txt').waitFor();
    await reply.fill('Here are the screenshots');
    await phone.locator('form .animate-pulse').first().waitFor({ state: 'detached' });
    await phone.screenshot({ path: path.join(output, 'phone-pasted.png') });
    await phone.getByRole('button', { name: 'Send' }).click();
    for (let i = 0; i < 100 && !received.length; i++) await phone.waitForTimeout(50);
    tapping = false;
    await tap;
    assert.equal(received[0]?.type, 'prompt');
    assert.equal(received[0].images.length, 2);
    assert.match(received[0].text, /Here are the screenshots/);
    assert.match(received[0].text, /notes\.txt/);
  } finally {
    await browser.close();
  }

  // The window lists the phone it just paired.
  // The Phone tab lists it, and drops the used code.
  await page.locator('.phones li').filter({ hasText: 'Test phone' }).waitFor();
  await page.locator('.pair-code').waitFor({ state: 'detached' });
  console.log(`phone access: ok (port ${port}); screenshots in ${path.relative(root, output)}`);
} finally {
  await app?.close();
  standIn.kill();
  await fs.rm(home, { recursive: true, force: true });
}

// Quitting the app takes the hub down with it.
await assert.rejects(fetch(`${base}/api/health`));
